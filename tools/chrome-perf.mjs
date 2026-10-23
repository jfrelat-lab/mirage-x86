// chrome-perf.mjs — how a page of MIRAGE actually runs in Chrome: the real ui.js loop, the real audio
// worklet, the real compositor. Headless Chrome, driven over the DevTools protocol (no dependency:
// Node's own WebSocket), against a page the local server serves.
//
//   node tools/chrome-perf.mjs "<url>" [seconds=40] [profileFrom=20] [profileSecs=10]
//   e.g. node tools/chrome-perf.mjs "http://localhost:8762/dos.html?zip=examples/games/doom19s.zip&run=DOOM&add=examples/games/doom/DEFAULT.CFG"
//   KEYS="6:Enter,9:ArrowLeft" presses those keys at those seconds (Wolf3D's sign-on, Unreal's menu);
//   SHOT=<file.png> takes a screenshot at the end; SHOTS=20,40 SHOTPREFIX=/tmp/x one at each of those seconds.
//   KEYS items are separated by '|' when one holds a comma; "12:type=cd \\games\\liquiwar\n" types text.
//   Works on dos.html (window.mirage is the app) and boot.html (window.mirage is the session).
//
// Why: a tab driven by automation in the app's own browser pane is hidden, and a hidden tab gets no
// requestAnimationFrame — the loop that runs the machine stops. Headless Chrome paints. A click at
// the start is the user gesture the page waits for before it starts the sound.
// Each second: guest instructions executed (M/s), animation frames, the share of the main thread the
// page's code took, and the guest's own clock (PIT ticks delivered). Then the top of a JS profile.
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const [url, secsArg, profFromArg, profSecsArg] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/chrome-perf.mjs <url> [seconds] [profileFrom] [profileSecs]'); process.exit(2); }
const SECS = Number(secsArg) || 40, PROF_FROM = Number(profFromArg ?? 20), PROF_SECS = Number(profSecsArg) || 10;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9300 + Math.floor(Math.random() * 600);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'chperf-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
{ stdio: 'ignore' });
const kill = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', kill);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) { console.error('Chrome did not come up'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : r; };

await send('Page.enable'); await send('Runtime.enable'); await send('Profiler.enable');
await send('Page.navigate', { url });
const tLoad = Date.now();
for (let i = 0; i < (process.env.NOWAIT ? 0 : 450); i++) {   // NOWAIT=1: a page that starts nothing by itself (a program given with FILES)
  await sleep(200);
  if (await evaluate('!!(window.mirage && (window.mirage.machine || window.mirage.mc))')) break;
  if (process.env.VERBOSE && i % 25 === 0) console.log('waiting:', JSON.stringify(await evaluate("location.href + ' / ' + document.title + ' / ' + ((document.getElementById('status') || {}).textContent)")));
}
console.log(`page ready after ${((Date.now() - tLoad) / 1000).toFixed(1)} s` + (await evaluate("document.getElementById('status') ? ' — ' + document.getElementById('status').textContent : ''")));
// Count animation frames and the main thread's busy time, from inside the page.
await evaluate(`(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  window.__long = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch {} })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });

const sample = () => evaluate(`(() => { const m = (window.mirage && (window.mirage.machine || window.mirage.mc)) || { cpu: { cycles: 0 } }; return { cyc: m.cpu.cycles, frames: window.__frames, long: window.__long,
  cps: m.cyclesPerSecond, pit: m.pitReload, base: m.pitBase, ticks: m.ticks || 0, audio: !!(window.mirage && window.mirage.audioOut && window.mirage.audioOut.ctx && window.mirage.audioOut.ctx.state),
  ctx: window.mirage && window.mirage.audioOut && window.mirage.audioOut.ctx ? window.mirage.audioOut.ctx.state : 'none', t: performance.now() }; })()`);
let prev = await sample(), profiling = false;
console.log(' s   Minstr/s  frames  longtask%  PIT Hz  audio');
const KEYS = (process.env.KEYS || '').split((process.env.KEYS || '').includes('|') ? '|' : ',').filter(Boolean).map((k) => { const i = k.indexOf(':'); return { t: Number(k.slice(0, i)), key: k.slice(i + 1) }; });
const CODES = { Enter: [13, 'Enter'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], Space: [32, ' '], Escape: [27, 'Escape'], ControlLeft: [17, 'Control'] };
const press = async (key) => { const [vk, k] = CODES[key] || [key.toUpperCase().charCodeAt(0), key];
  // Held ~100 ms, as a hand does: a game that polls a key-state table once a frame (C-Dogs) never
  // sees a press whose release came in the same frame.
  for (const type of ['rawKeyDown', 'keyUp']) { await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: vk, key: k, code: key.length === 1 ? 'Key' + key.toUpperCase() : key }); if (type !== 'keyUp') await sleep(100); } };
const CHAR = (c) => /[a-z]/i.test(c) ? [c.toUpperCase().charCodeAt(0), c, 'Key' + c.toUpperCase()]
  : /[0-9]/.test(c) ? [c.charCodeAt(0), c, 'Digit' + c] : c === ' ' ? [32, ' ', 'Space'] : c === '\\' ? [220, '\\', 'Backslash']
  : c === '.' ? [190, '.', 'Period'] : c === '-' ? [189, '-', 'Minus'] : c === '/' ? [191, '/', 'Slash'] : c === ';' ? [186, ';', 'Semicolon'] : c === '\n' ? [13, 'Enter', 'Enter'] : null;
const typeText = async (text) => {
  for (const c of text.replace(/\\n/g, '\n')) { const k = CHAR(c); if (!k) continue;
    for (const type of ['keyDown', 'keyUp']) { await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: k[0], key: k[1], code: k[2], text: type === 'keyDown' && k[1].length === 1 ? k[1] : undefined }); if (type === 'keyDown') await sleep(60); }
    await sleep(30); } };
const SHOTS = (process.env.SHOTS || '').split(',').filter(Boolean).map(Number);
// CLICKS="70:400,300|74:420,360" clicks at those page coordinates at those seconds (a menu on X's
// desktop); STATUS=1 prints the page's status line each second (an OASIS image's build).
// "t:x,y>x2,y2" presses at x,y, moves to x2,y2 and releases there (twm's menus: held, chosen on release);
// SHOTPREFIX-<t>-held.png shows the screen with the button down.
const CLICKS = (process.env.CLICKS || '').split('|').filter(Boolean).map((c) => { const [t, xy] = c.split(':'); const [a, b] = xy.split('>'); const [x, y] = a.split(',').map(Number); const to = b ? b.split(',').map(Number) : null; return { t: Number(t), x, y, to }; });
const drag = async (c) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 }); await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('fs')).writeFileSync(`${process.env.SHOTPREFIX || '/tmp/shot'}-${c.t}-held.png`, Buffer.from(r.result.data, 'base64'));
  for (let i = 1; i <= 10; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + (c.to[0] - c.x) * i / 10, y: c.y + (c.to[1] - c.y) * i / 10, button: 'left', buttons: 1 }); await sleep(60); }
  await sleep(300); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.to[0], y: c.to[1], button: 'left', buttons: 0, clickCount: 1 }); };
const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); if (type === 'mousePressed') await sleep(150); } };
for (let s = 1; s <= SECS; s++) {
  // EVALS="10:<js>|12:<js>" evaluates that JavaScript in the page at those seconds (input a headless
  // browser cannot give, such as a locked pointer's motion: window.mirage.lx.mouseInput(dx, dy, buttons)).
  for (const e of (process.env.EVALS || '').split('|').filter(Boolean)) { const i = e.indexOf(':'); if (Number(e.slice(0, i)) === s) await evaluate(e.slice(i + 1)); }
  // FILES="3:#openFile:/path/PROG" gives that file to the page's <input type=file> at that second, as a
  // visitor choosing it would (DOM.setFileInputFiles), then fires its change.
  for (const f of (process.env.FILES || '').split('|').filter(Boolean)) { const i1 = f.indexOf(':'), i2 = f.indexOf(':', i1 + 1), t = f.slice(0, i1), sel = f.slice(i1 + 1, i2), path = f.slice(i2 + 1); if (Number(t) !== s) continue;
    const doc = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: sel });
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path] }); }
  for (const c of CLICKS) if (c.t === s) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await sleep(200); if (c.to) await drag(c); else await click(c.x, c.y); }
  if (process.env.STATUS) console.log('status', s, JSON.stringify(await evaluate("(document.getElementById('status') || {}).textContent")));
  for (const k of KEYS) if (k.t === s) { if (k.key.startsWith('type=')) await typeText(k.key.slice(5)); else await press(k.key); }
  // PROBE=<s>: from that second, count port reads/writes and sample CS:IP and the mode for 5 s.
  if (Number(process.env.PROBE) === s) await evaluate(`(() => { const m = window.mirage.machine || window.mirage.mc, c = m.cpu; window.__io = new Map(); window.__ip = new Map();
    const r0 = c.ioRead, w0 = c.ioWrite; c.ioRead = (p, z) => { const k = 'r' + p.toString(16); window.__io.set(k, (window.__io.get(k) || 0) + 1); return r0(p, z); };
    c.ioWrite = (p, z, v) => { const k = 'w' + p.toString(16); window.__io.set(k, (window.__io.get(k) || 0) + 1); return w0(p, z, v); };
    window.__pg = 0; window.__cr3 = 0; window.__c0 = m.rec.stats.compiles; const pg0 = c.onPagingChange, cr30 = c.onCR3; c.onPagingChange = () => { window.__pg++; return pg0(); }; c.onCR3 = () => { window.__cr3++; return cr30(); };
    window.__rv = { ok: 0, frames: 0, bytes: 0, nosnap: 0, miss: 0 }; const rec = m.rec, rv0 = rec._revalidate.bind(rec);
    rec._revalidate = (blk, lin) => { const fo = blk.ph0 === -1 || (rec._frame(blk.linStart) === blk.ph0 && rec._frame(blk.linEnd - 1) === blk.ph1); const r = rv0(blk, lin);
      if (r) window.__rv.ok++; else if (!fo) window.__rv.frames++; else if (blk.snap === null) window.__rv.nosnap++; else window.__rv.bytes++; return r; };
    window.__resets = 0; window.__rstack = ''; const rs0 = rec.reset.bind(rec); rec.reset = () => { window.__resets++; if (!window.__rstack) window.__rstack = String(new Error().stack).slice(0, 600); return rs0(); };
    const cp0 = rec._compile.bind(rec); rec._compile = (lin, ip0) => { window.__rv.miss++; return cp0(lin, ip0); };
    window.__ticks = 0; const t0 = m.tickTimer.bind(m); m.tickTimer = (...a) => { window.__ticks++; return t0(...a); };
    window.__ipT = setInterval(() => { const k = ((c.cr0 & 1) ? 'PM ' : 'RM ') + c.seg[1].toString(16) + ':' + (c.eip >>> 0).toString(16) + (c.halted ? ' HLT' : ''); window.__ip.set(k, (window.__ip.get(k) || 0) + 1); }, 3); })()`);
  if (Number(process.env.PROBE) + 5 === s) console.log('PROBE', await evaluate(`JSON.stringify({ io: [...window.__io].sort((a, b) => b[1] - a[1]).slice(0, 12), ip: [...window.__ip].sort((a, b) => b[1] - a[1]).slice(0, 10), resets: window.__resets, rstack: window.__rstack, rv: window.__rv, banks: (window.mirage.machine || window.mirage.mc).rec.banks.map(b => !!b), pagingChanges: window.__pg, cr3: window.__cr3, compiles: (window.mirage.machine || window.mirage.mc).rec.stats.compiles - window.__c0, ticks: window.__ticks, IF: !!((window.mirage.machine || window.mirage.mc).cpu.flags & 0x200), mask: (window.mirage.machine || window.mirage.mc).irqPendingMask, hw: (window.mirage.machine || window.mirage.mc).hwIrqPending, pit: (window.mirage.machine || window.mirage.mc).pitReload, pic: JSON.stringify((window.mirage.machine || window.mirage.mc).pic) .slice(0, 400) })`));
  if (SHOTS.includes(s)) { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('fs')).writeFileSync(`${process.env.SHOTPREFIX || '/tmp/shot'}-${s}s.png`, Buffer.from(r.result.data, 'base64')); }
  if (s === PROF_FROM + 1 && PROF_SECS > 0) { await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start'); profiling = true; }
  await sleep(1000);
  const cur = await sample(), dt = (cur.t - prev.t) / 1000;
  const hz = cur.pit ? (18.2065 * cur.base / cur.pit) : 0;
  console.log(`${String(s).padStart(2)}  ${((cur.cyc - prev.cyc) / dt / 1e6).toFixed(1).padStart(8)}  ${String(Math.round((cur.frames - prev.frames) / dt)).padStart(6)}  ${(100 * (cur.long - prev.long) / (dt * 1000)).toFixed(0).padStart(8)}%  ${hz.toFixed(0).padStart(6)}  ${cur.ctx}`);
  prev = cur;
  if (profiling && s === PROF_FROM + PROF_SECS) {
    const { result } = await send('Profiler.stop'); profiling = false;
    const p = result.profile, self = new Map(), byId = new Map(p.nodes.map((n) => [n.id, n]));
    let tot = 0;
    p.samples.forEach((sid, i) => { const n = byId.get(sid), d = p.timeDeltas[i] || 0, f = n.callFrame;
      const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + d); tot += d; });
    console.log(`-- JS profile, seconds ${PROF_FROM + 1}-${PROF_FROM + PROF_SECS}, self time --`);
    for (const [k, d] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${(100 * d / tot).toFixed(1).padStart(5)}%  ${k}`);
  }
}
// SHOT=<file.png>: the page as Chrome shows it at the end.
if (process.env.SHOT) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('fs')).writeFileSync(process.env.SHOT, Buffer.from(r.result.data, 'base64'));
  console.log('screenshot ->', process.env.SHOT);
}
ws.close(); kill(); process.exit(0);
