// chrome-perf.mjs — how a page of MIRAGE actually runs in Chrome: the real ui.js loop, the real audio
// worklet, the real compositor. Headless Chrome, driven over the DevTools protocol (no dependency:
// Node's own WebSocket), against a page the local server serves.
//
//   node tools/chrome-perf.mjs "<url>" [seconds=40] [profileFrom=20] [profileSecs=10]
//   e.g. node tools/chrome-perf.mjs "http://localhost:8762/dos.html?zip=examples/games/doom19s.zip&run=DOOM&add=examples/games/doom/DEFAULT.CFG"
//   KEYS="6:Enter,9:ArrowLeft" presses those keys at those seconds (Wolf3D's sign-on, Unreal's menu);
//   SHOT=<file.png> takes a screenshot at the end.
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
for (let i = 0; i < 100; i++) { await sleep(200); if (await evaluate('!!(window.mirage && window.mirage.machine)')) break; }
// Count animation frames and the main thread's busy time, from inside the page.
await evaluate(`(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f);
  window.__long = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: false }); } catch {} })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });

const sample = () => evaluate(`(() => { const m = window.mirage.machine; return { cyc: m.cpu.cycles, frames: window.__frames, long: window.__long,
  cps: m.cyclesPerSecond, pit: m.pitReload, base: m.pitBase, ticks: m.ticks || 0, audio: !!(window.mirage.audioOut && window.mirage.audioOut.ctx && window.mirage.audioOut.ctx.state),
  ctx: window.mirage.audioOut && window.mirage.audioOut.ctx ? window.mirage.audioOut.ctx.state : 'none', t: performance.now(), stats: window.mirage.stats() }; })()`);
let prev = await sample(), profiling = false;
console.log(' s   Minstr/s  frames  longtask%  PIT Hz  audio');
const KEYS = (process.env.KEYS || '').split(',').filter(Boolean).map((k) => { const [t, key] = k.split(':'); return { t: Number(t), key }; });
const CODES = { Enter: [13, 'Enter'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], Space: [32, ' '], Escape: [27, 'Escape'] };
const press = async (key) => { const [vk, k] = CODES[key] || [key.toUpperCase().charCodeAt(0), key];
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: vk, key: k, code: key.length === 1 ? 'Key' + key.toUpperCase() : key }); };
for (let s = 1; s <= SECS; s++) {
  for (const k of KEYS) if (k.t === s) await press(k.key);
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
