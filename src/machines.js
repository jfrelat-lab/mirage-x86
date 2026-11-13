// machines.js — machines.html: MIRAGE's machines, and each one's programs.
//
//   machines.html?m=dos[&run=<id>]     the DOS player's engine, its shell listing the titles
//   machines.html?m=pc[&run=<id>]      a bare PC: a BIOS boot menu of the boot images
//   machines.html?m=linux[&run=<img>]  MIRAGE-LINUX: the OASIS Linux images (from `oasis serve`, or built in the page)
//   machines.html?m=win32[&run=<img>]  MIRAGE-WIN32: the OASIS Win32 images, on the same page as Linux's (src/win32)
//
// A machine is one engine for the page's lifetime; choosing another machine, or a program while one
// runs, loads the page again with that choice — a machine is switched off and on, not reused.
// DOS and PC titles come from examples/manifest.json (the home page's examples); Linux images from
// the OASIS server's /oasis-images.json (tools/oasis.mjs serve).
import { Mirage } from './ui.js';
import { fetchWhole } from './fetch-whole.js';
import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installMouse } from './mouse.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { bootSector, attachImage } from './boot.js';
import { installAudio } from './audio.js';
import { AudioOut } from './audio-out.js';
import { installFullscreen } from './fullscreen.js';
import { canRecord, startRecording, saveRecording } from './recorder.js';
import { startLinux, oasisHost } from './linuxrun.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen'), over = $('over'), status = $('status'), hint = $('hint');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);

const MACHINES = [
  { id: 'dos', name: 'DOS', sub: 'built-in DOS · no image', spec: '586 · 16 MB · VGA · SB16 · XMS · EMS · DPMI' },
  { id: 'linux', name: 'Linux', sub: 'system calls in JS · no kernel', spec: 'i686 · 64 MB · tty1 · VGA · ELF and a.out' },
  { id: 'pc', name: 'PC', sub: 'bare metal · BIOS', spec: 'BIOS · VGA/VBE · floppy · IDE · CD-ROM' },
  { id: 'win32', name: 'Windows', sub: 'Win32 API in JS · no Windows', spec: 'i686 · PE · user32 · gdi32 · opengl32 on WebGL2' },
];
const mid = MACHINES.some((m) => m.id === params.get('m')) ? params.get('m') : 'dos';
const machine = MACHINES.find((m) => m.id === mid);
const go = (q) => { location.search = new URLSearchParams(q).toString(); };

// ---- the frame: rail, title strip, shelf ----------------------------------------------------------
$('rail').innerHTML = MACHINES.map((m) => `<a class="machine" href="?m=${m.id}"${m.id === mid ? ' aria-current="page"' : ''}>
  <span class="mname"><span class="dot"></span>${esc(m.name)}</span><span class="msub">${esc(m.sub)}</span></a>`).join('');
$('vmName').textContent = machine.name;
$('vmSpec').textContent = machine.spec;
document.title = `MIRAGE — ${machine.name}`;
installFullscreen($('stage'), $('fullscreen'));
const setState = (text, cls = 'on') => { const p = $('vmState'); p.textContent = text; p.className = 'pill ' + cls; };
// The log under the screen (machines.html #log): a line per step, kept to its last 400.
const logEl = $('log'), logBtn = $('logBtn');
let logAsked = null;                                     // the visitor's own choice wins over showLog()
const setLog = (open) => { logEl.hidden = !open; logBtn.setAttribute('aria-pressed', String(open)); if (open) logEl.scrollTop = logEl.scrollHeight; };
logBtn.addEventListener('click', () => { logAsked = logEl.hidden; setLog(logAsked); });
const showLog = () => { if (logAsked === null) setLog(true); };
let logPartial = '';
const log = (text, { stamp = true } = {}) => {
  const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const row = document.createElement('div');
    if (stamp) { const t = document.createElement('span'); t.className = 't'; t.textContent = new Date().toTimeString().slice(0, 8) + ' '; row.append(t); }
    row.append(line);
    logEl.append(row);
  }
  while (logEl.childElementCount > 400) logEl.firstElementChild.remove();
  if (atEnd) logEl.scrollTop = logEl.scrollHeight;
};
/** A program's output, which comes in pieces: whole lines go to the log, escapes and returns dropped. */
const logOutput = (t) => {
  logPartial += t.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '');
  const lines = logPartial.split('\n'); logPartial = lines.pop();
  if (logPartial.length > 300) { lines.push(logPartial); logPartial = ''; }
  if (lines.length) log(lines.join('\n'), { stamp: false });
};

function shelf(title, items, current) {
  $('shelfTitle').textContent = title;
  $('shelf').innerHTML = items.map((x, i) => `<button class="card" data-i="${i}" data-id="${esc(x.id || '')}"${x.id === current ? ' aria-selected="true"' : ''}>
    ${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : '<span class="noimg">no picture</span>'}
    <span><span class="t">${esc(x.title)}</span><span class="s">${esc([x.year, x.author].filter(Boolean).join(' · '))}</span>
    <span class="s">${esc(x.note || '')}</span></span></button>`).join('') || '<span style="color:var(--dim)">nothing here yet</span>';
  for (const el of $('shelf').querySelectorAll('.card')) el.onclick = () => items[+el.dataset.i].open();
}

let session = null;   // { pause(on), audio }
$('pause').onclick = () => {
  if (!session) return;
  session.paused = !session.paused; session.pause(session.paused);
  $('pause').textContent = session.paused ? 'Resume' : 'Pause';
  setState(session.paused ? 'paused' : 'running', session.paused ? '' : 'on');
};
let soundOn = params.get('mute') !== '1';
const syncSound = () => { $('sound').setAttribute('aria-pressed', String(soundOn)); if (session && session.audio) { session.audio.setMuted(!soundOn); if (soundOn) session.audio.start(); } };
$('sound').onclick = () => { soundOn = !soundOn; syncSound(); };
// Record: the screen and its sound, in real time, to a file the visitor keeps (src/recorder.js).
let recording = null;
if (canRecord()) $('recBtn').hidden = false;
$('recBtn').onclick = async () => {
  const b = $('recBtn');
  if (!recording) {
    recording = startRecording(canvas, session && soundOn ? session.audio : null);
    b.setAttribute('aria-pressed', 'true'); b.textContent = '● Stop';
    return;
  }
  const r = recording; recording = null;
  b.setAttribute('aria-pressed', 'false'); b.textContent = 'Record';
  saveRecording(await r.stop(), params.get('run') || $('vmName').textContent);
};
// Audio may start only after a gesture: the first key or click starts it.
for (const ev of ['keydown', 'pointerdown']) window.addEventListener(ev, () => { if (session && session.audio && soundOn) session.audio.start(); }, { once: true, capture: true });

async function examples() {
  try { return await (await fetch('examples/manifest.json')).json(); } catch { return []; }
}

// ---- DOS ------------------------------------------------------------------------------------------
async function dos() {
  const list = (await examples()).filter((e) => e.kind === 'zip' || e.kind === 'dos');
  let last = performance.now(), c0 = 0;
  const app = new Mirage(canvas, {
    onFrame: () => {
      const now = performance.now();
      if (now - last < 1000) return;
      const st = app.stats();
      status.textContent = `${((app.machine.cpu.cycles - c0) / (now - last) / 1000).toFixed(1)} M instructions/s · ${st.running ? 'running' : 'at the prompt'}`;
      setState(app.paused ? 'paused' : st.running ? 'running' : 'ready', app.paused ? '' : 'on');
      last = now; c0 = app.machine.cpu.cycles;
    },
  });
  await app.boot();
  window.mirage = app;
  session = { audio: app.audioOut, pause: (on) => { app.paused = on; } };
  syncSound();
  // Every title is a directory of C:\GAMES at once, fetched when first used, and a command of its own.
  for (const e of list) if (e.kind === 'zip') app.registerTitle({ name: e.run, zip: e.file, adds: e.add || [], run: e.run, args: e.args });
  const start = async (e) => {
    if (app.shell.state !== 'input') { go({ m: 'dos', run: e.id }); return; }   // something runs: start afresh
    if (e.kind === 'dos') {
      const name = e.file.split('/').pop().toUpperCase();
      app.mountFile(name, new Uint8Array(await (await fetch(e.file)).arrayBuffer()));
      app.runCommand(name.replace(/\.[^.]+$/, ''));
    } else app.runCommand(e.run);
    canvas.focus();
    for (const c of $('shelf').querySelectorAll('.card')) c.setAttribute('aria-selected', String(list[+c.dataset.i] === e));
  };
  shelf('C:\\GAMES — or type a name at the prompt', list.map((e) => ({ ...e, thumb: `examples/thumbs/${e.id}.png`,
    note: e.kind === 'zip' ? e.run : e.file.split('/').pop().toUpperCase(), open: () => start(e) })), params.get('run'));
  hint.textContent = 'Type a title (CDOGS, DOOM, KEEN1…) at C:\\> — DIR, CD, CLS work as in DOS';
  const wanted = list.find((e) => e.id === params.get('run'));
  if (wanted) start(wanted); else app.runCommand('DIR GAMES');
  canvas.focus();
}

// ---- PC -----------------------------------------------------------------------------------------
const TICK_MS = 1000 / 18.2065;
async function pc() {
  const list = (await examples()).filter((e) => e.kind === 'boot');
  const boot = async (e) => {
    if (session) { go({ m: 'pc', run: e.id }); return; }
    over.hidden = true;
    status.textContent = `loading ${e.file.split('/').pop()}…`;
    log(`loading ${e.file}`);
    const res = await fetchWhole(e.file);   // in parts on a static host (src/fetch-whole.js)
    const body = /\.gz$/i.test(e.file) ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
    const raw = new Uint8Array(await new Response(body).arrayBuffer());
    const mc = new Machine({ memSize: (e.mem || 4) << 20, cpu: String(e.cpu || 386) });
    installBIOS(mc, { ems: false });
    installMouse(mc);
    for (const [prop, file] of [['font', 'vga-rom-8x16.bin'], ['font8x8', 'vga-rom-8x8.bin'], ['font8x14', 'vga-rom-8x14.bin']]) {
      try { mc[prop] = new Uint8Array(await (await fetch('assets/' + file)).arrayBuffer()); } catch { /* optional */ }
    }
    installAudio(mc);
    const audio = new AudioOut(mc);
    mc.timerAuto = false;
    mc.wallClockMs = () => performance.now();
    if (mc.rtc) mc.rtc.useHostClock();
    const video = new Video(mc, canvas); video.font = mc.font;
    let fault = null; mc.onError = (err) => { fault = err; console.error(err); };
    const { bytes, drive } = attachImage(mc, raw);
    bootSector(mc, bytes, { drive });
    new Keyboard(mc).attach(window);
    let paused = false, lastTick = performance.now(), last = performance.now(), c0 = 0;
    session = { audio, pause: (on) => { paused = on; } };
    syncSound();
    window.mirage = { mc };
    // As boot.html: the CPU in 12 ms chunks chained through a MessageChannel, the timer at the guest's
    // programmed rate against the wall clock, requestAnimationFrame only to draw.
    const tick = new MessageChannel();
    tick.port1.onmessage = () => {
      const t0 = performance.now();
      let w = t0;
      while (!paused && !fault && w - t0 < 12) {
        const tickMs = Math.max(0.8, TICK_MS * (mc.pitReload / (mc.pitBase || 0x10000)));
        if (w - lastTick > 250) lastTick = w;
        if (w - lastTick >= tickMs) { mc.tickTimer(); lastTick += tickMs; }
        mc.pumpKeyboard();
        mc.runSlice(20000);
        if (mc.cpu.halted) break;
        w = performance.now();
      }
      if (fault) { status.textContent = String(fault.message || fault).split('\n')[0]; setState('stopped', 'err'); return; }
      if (paused || mc.cpu.halted) setTimeout(() => tick.port2.postMessage(0), paused ? 50 : 1); else tick.port2.postMessage(0);
    };
    tick.port2.postMessage(0);
    (function draw() {
      video.render(); audio.pump();
      const now = performance.now();
      if (now - last > 1000 && !fault) { status.textContent = `${((mc.cpu.cycles - c0) / (now - last) / 1000).toFixed(1)} M instructions/s · ${e.title}`; last = now; c0 = mc.cpu.cycles; }
      requestAnimationFrame(draw);
    })();
    setState('running');
    canvas.focus();
  };
  shelf('Boot images', list.map((e) => ({ ...e, thumb: `examples/thumbs/${e.id}.png`, note: e.file.split('/').pop(), open: () => boot(e) })), params.get('run'));
  const wanted = list.find((e) => e.id === params.get('run'));
  if (wanted) { boot(wanted); return; }
  // The machine's own chooser: a BIOS boot menu.
  setState('BIOS', '');
  let sel = 0;
  const kind = (e) => (/\.gz$|freedos/i.test(e.file) ? 'Hard disk' : 'Floppy A:');
  const draw = () => {
    over.className = 'over bios'; over.hidden = false;
    over.innerHTML = `<h1>MIRAGE BIOS — Boot Menu</h1><ul>${list.map((e, i) =>
      `<li data-i="${i}" class="${i === sel ? 'sel' : ''}"><span class="kind">${kind(e)}</span><span>${esc(e.title)}${e.year ? ' (' + e.year + ')' : ''}</span></li>`).join('')}</ul>
      <div class="hint">↑ ↓ to choose, Enter to boot — or click</div>`;
    for (const li of over.querySelectorAll('li')) li.onclick = () => boot(list[+li.dataset.i]);
  };
  const onKey = (ev) => {
    if (!over.hidden && !session) {
      if (ev.key === 'ArrowDown') { sel = (sel + 1) % list.length; draw(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { sel = (sel + list.length - 1) % list.length; draw(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { window.removeEventListener('keydown', onKey); boot(list[sel]); ev.preventDefault(); }
    }
  };
  window.addEventListener('keydown', onKey);
  draw();
  status.textContent = 'choose an image to boot';
}

// ---- Linux ----------------------------------------------------------------------------------------
// The user's name in a Linux image: the visitor's choice (kept in this browser only, sent nowhere),
// else the OASIS server's (on a computer: its login), else the image's, else "player".
const USER_KEY = 'mirage.linux.user';
const savedUser = () => { try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; } };
const linuxUser = (img) => savedUser() || (img && (img.hostUser || img.user)) || 'player';
// `world`: 'linux', or 'win32' — MIRAGE-WIN32's images, run the same way (src/linuxrun.js loads a PE),
// without what is Linux's own: the examples' intros, the user's name, a program of one's own.
async function linux(world = 'linux') {
  const isLinux = world === 'linux';
  const shelfTitle = isLinux ? 'Linux intros and OASIS images' : 'Windows programs (OASIS images)';
  const userBtn = $('userBtn');
  userBtn.hidden = !isLinux;
  const showUser = () => { userBtn.textContent = `User: ${savedUser() || 'player'}`; };
  showUser();
  userBtn.addEventListener('click', () => {
    const n = prompt('Your name inside the Linux machine (letters, digits, - and _). It stays in this browser.', savedUser() || 'player');
    if (n === null) return;
    const clean = n.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z_]+/, '').slice(0, 31);
    try { if (clean) localStorage.setItem(USER_KEY, clean); else localStorage.removeItem(USER_KEY); } catch { /* storage refused */ }
    showUser();
    log(`user set to ${clean || 'player'}: it applies from the next start`);
  });
  // A program of the visitor's own, dropped on the screen or opened: an i386 Linux binary run alone at
  // /w/<name>, as tools/linux/run.mjs runs one, on a framebuffer of the size chosen beside the button
  // (the sizecoding intros of the 2020s draw for one size). Nothing leaves the browser.
  const fbSel = $('fbSel'), openBtn = $('openBtn'), openFile = $('openFile'), stage = $('stage');
  // On Windows the same list is the desktop's size: a game's 640x480 window fills more of the screen on
  // an 800x600 desktop than on 1024x768. A change starts the program again on the new desktop.
  const fbKey = isLinux ? 'mirage.linux.fb' : 'mirage.win32.desktop';
  // Windows' screen is its desktop until the program's first picture (the canvas is empty while the layers
  // come and the program starts): the classic blue, not a black screen of another size.
  if (!isLinux) canvas.style.background = '#3a6ea5';
  fbSel.hidden = false; openBtn.hidden = !isLinux;
  if (!isLinux) fbSel.title = 'The Windows desktop\'s size: a change starts the program again';
  try { const f = localStorage.getItem(fbKey); if (f && [...fbSel.options].some((o) => o.value === f)) fbSel.value = f; } catch { /* storage refused */ }
  fbSel.onchange = () => {
    try { localStorage.setItem(fbKey, fbSel.value); } catch { /* storage refused */ }
    if (!isLinux && new URLSearchParams(location.search).get('run')) location.reload();
  };
  const runBytes = async (title, fileName, bytes, fb, from, id = null) => {
    if (window.mirage && window.mirage.stop) window.mirage.stop();
    session = null;
    const { Tree } = await import('./oasis-layers.js');
    const name = fileName.replace(/[^\w.+-]/g, '_') || 'program';
    const tree = new Tree(); tree.mkdir('/tmp'); tree.mkdir('/w'); tree.file('/w/' + name, bytes, 0o755);
    const img = { title, machine: { cpu: '686', mem: 64, fb }, entry: { run: '/w/' + name, cwd: '/w' } };
    over.hidden = true; showLog();
    for (const el of $('shelf').querySelectorAll('.card')) el.setAttribute('aria-selected', String(el.dataset.id === id));
    log(`${title}: ${bytes.length} bytes ${from}, /dev/fb0 at ${fb}x32`);
    status.textContent = `starting ${title}…`;
    await start({ title }, img, tree.host());
  };
  const runFile = async (file) => runBytes(file.name, file.name, new Uint8Array(await file.arrayBuffer()), fbSel.value, 'from this computer');
  // The Linux intros of examples/manifest.json (kind "linux"): small binaries kept here with their
  // licence, run as a dropped program is, on the framebuffer size each was made for.
  const intros = isLinux ? (await examples()).filter((e) => e.kind === 'linux') : [];
  // An intro kept here has `file`; one whose authors state no licence has `url` (their archive, fetched
  // through the oasis-fetch relay and kept in this browser's Cache Storage) and `member` (the binary in it).
  const runIntro = async (e) => {
    let bytes;
    try {
      if (e.url) {
        status.textContent = `${e.title}: fetching ${e.url.split('/').pop()} from its authors' site…`; showLog();
        const [{ webIO }, { archiveMember }] = await Promise.all([import('./oasis-web.js'), import('./archive-member.js')]);
        const archive = await webIO({ onProgress: (t) => log(t) }).fetchBytes(e.url);
        bytes = await archiveMember(archive, e.url, e.member);
        log(`${e.member}: ${bytes.length} bytes, from ${e.url}`);
      } else bytes = new Uint8Array(await (await fetch(e.file)).arrayBuffer());
    } catch (err) { status.textContent = `${e.title}: ${err.message}`; log(String(err.message || err)); return; }
    if (e.fb) fbSel.value = e.fb;
    replace({ m: 'linux', prog: e.id });
    await runBytes(e.title, (e.member || e.file).split('/').pop(), bytes, e.fb || fbSel.value, `(${e.license}, ${e.author})`, e.id);
  };
  const introItems = intros.map((e) => ({ id: e.id, title: e.title, year: e.year, author: e.author, thumb: `examples/thumbs/${e.id}.png`,
    note: `${e.tag || 'Linux intro'} · ${e.fb || ''}`, open: () => runIntro(e) }));
  const wantedIntro = intros.find((e) => e.id === params.get('prog'));
  openBtn.onclick = () => openFile.click();
  openFile.onchange = () => { if (openFile.files[0]) runFile(openFile.files[0]); openFile.value = ''; };
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dropping'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dropping'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dropping'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) runFile(f); });
  // Another program from the shelf replaces the running one in place: the page and the shelf's
  // scroll stay, the log starts afresh; the address names the new one, so a reload starts it again.
  const replace = (q) => {
    if (window.mirage && window.mirage.stop) window.mirage.stop();
    session = null;
    logEl.replaceChildren(); logPartial = '';                          // the log is the new program's
    history.replaceState(null, '', '?' + new URLSearchParams(q).toString());
  };
  let images = [];
  // Images meant for a window; the terminal ones (a shell) run with `oasis run` in a terminal.
  try { images = (await (await fetch('/oasis-images.json')).json()).filter((m) => m.world === world && m.output === 'window'); } catch { images = null; }
  over.className = 'over term'; over.hidden = false;
  // Start an image on the canvas from its manifest and a file tree: the OASIS server's (/oasis-fs) or
  // one this page built itself from the layers (src/oasis-layers.js, through the oasis-fetch relay).
  // A Windows program that ended well (status 0): the desktop, its icon on it, as Windows leaves it -- a
  // click on the icon starts it again, on a new machine (`again`). Ended otherwise, its last picture stays
  // with the message, which says what went wrong.
  const desktop = (m, s, again) => {
    const ic = s.programIcon && s.programIcon();
    let src = '';
    if (ic) {
      const c = document.createElement('canvas'); c.width = ic.w; c.height = ic.h;
      const g = c.getContext('2d'), d = g.createImageData(ic.w, ic.h);
      for (let i = 0; i < ic.w * ic.h; i++) { const p = ic.px[i]; d.data.set([(p >> 16) & 255, (p >> 8) & 255, p & 255, ic.mask && ic.mask[i] ? 0 : 255], 4 * i); }
      g.putImageData(d, 0, 0); src = c.toDataURL();
    }
    over.className = 'over desk'; over.hidden = false;
    over.innerHTML = `<button type="button" class="deskicon" title="Start it again">${src ? `<img src="${src}" alt="">` : '<i></i>'}<span>${esc(m.title.split(' — ')[0])}</span></button>`;
    const b = over.querySelector('button');
    b.onclick = () => { over.hidden = true; again(); };
    b.focus();
  };
  const start = async (m, img, host, again = null) => {
    let lastLine = '', s = null;
    try {
      const user = isLinux ? linuxUser(img) : null;              // a Linux account; Win32 has none
      if (!isLinux) img = { ...img, machine: { ...img.machine, desktop: fbSel.value } };
      if (user) log(`user: ${user}`);
      s = await startLinux({ canvas, img, host, user,
        onOutput: (t) => { logOutput(t); lastLine = (lastLine + t.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '')).split('\n').filter(Boolean).pop() || lastLine; hint.textContent = lastLine.slice(-120); },
        onStatus: (t) => {
          status.textContent = t;
          if (/^exited/.test(t)) { setState('exited', ''); log(t); if (!isLinux && again && /^exited with status 0$/.test(t) && s) desktop(m, s, again); }
        } });
      session = { pause: s.pause, audio: s.audio };
      syncSound();                                                    // chosen from the list: the click came before
      window.mirage = s;
      setState('running');
      canvas.focus();
      preparing(img.prepare);
    } catch (e) { status.textContent = String(e.message || e); setState('failed', 'err'); }
  };
  // "prepare": { "seconds", "note" } in a manifest: what the program computes before its first frame,
  // shown over the black screen with a bar on the page's clock, then taken away.
  const preparing = (p) => {
    const box = document.getElementById('prep');
    clearInterval(preparing.timer); box.hidden = true;
    if (!p || !p.seconds) return;
    box.querySelector('b').textContent = `Preparing — about ${p.seconds < 90 ? `${p.seconds} seconds` : `${Math.round(p.seconds / 60 * 2) / 2} minutes`}`;
    box.querySelector('span').textContent = p.note || 'the program computes before its first frame';
    const bar = box.querySelector('em'), t0 = performance.now();
    box.hidden = false; bar.style.width = '0';
    preparing.timer = setInterval(() => {
      const f = (performance.now() - t0) / 1000 / p.seconds;
      bar.style.width = `${Math.min(100, f * 100)}%`;
      if (f >= 1.15) { clearInterval(preparing.timer); box.hidden = true; }
    }, 500);
  };
  if (!images) {
    // A static host: the images are listed (oasis/index.json) and their manifests are beside the page
    // (oasis/images/); the page builds an image's tree itself, its archives fetched through the
    // oasis-fetch relay (Debian's and idgames' servers send no CORS headers) and kept in the browser.
    // An image made from a Docker export needs the docker command: the OASIS server, on a computer.
    let listed = [];
    try { listed = (await (await fetch('oasis/index.json')).json()).filter((m) => m.world === world && m.output === 'window'); } catch { /* none */ }
    const needs = (m, why) => {
      over.className = 'over needs'; over.hidden = false;
      over.innerHTML = `<div class="panel">${m && m.thumb ? `<img src="${esc(m.thumb)}" alt="">` : ''}
        <h2>${esc(m ? m.title : 'Linux programs, from OASIS images')}</h2>
        ${m ? `<p>${esc(why)}</p>` : `<p>The Linux machine answers Linux's system calls in JavaScript — there is no kernel — and takes its programs from
        OASIS images, which bring their files from where their authors published them: Debian's archive, idgames. Choose an image:
        this page fetches its layers once, keeps them in your browser, and starts it.</p>`}
        <p class="dim">On a computer, every image, Docker ones included: <code>node tools/oasis.mjs serve --open</code></p>
        <p><a href="oasis.html${m ? '#' + esc(m.name) : ''}">See ${m ? 'this image\'s' : 'each image\'s'} recipe →</a></p></div>`;
      for (const el of $('shelf').querySelectorAll('.card')) el.setAttribute('aria-selected', String(!!m && items[+el.dataset.i].id === m.name));
    };
    const runHere = async (m) => {
      replace({ m: world, run: m.name });
      for (const el of $('shelf').querySelectorAll('.card')) el.setAttribute('aria-selected', String(items[+el.dataset.i].id === m.name));
      let img;
      try { img = { ...(await (await fetch(`oasis/images/${m.name}.json`)).json()), name: m.name }; } catch { return needs(m, 'Its manifest could not be read.'); }
      if ((img.layers || []).some((l) => l.docker)) return needs(m, 'This image is made from a Docker image\'s export, which takes the docker command: it runs from the OASIS server on a computer.');
      over.hidden = true; setState('building', ''); showLog();
      log(`${m.name}: ${(img.layers || []).length} layers`);
      const [{ buildTree }, { webIO }] = await Promise.all([import('./oasis-layers.js'), import('./oasis-web.js')]);
      const t0 = performance.now();
      // A build's line comes back each second with its time: the log takes each new step once.
      let logged = '';
      const io = webIO({ onProgress: (t) => { status.textContent = `${m.title}: ${t}…`; const step = t.replace(/^building \(\d+ s\)/, 'building'); if (step !== logged) log(logged = step); } });
      io.onOutput = (t) => { logOutput(t); const l = t.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, '').split('\n').filter(Boolean).pop(); if (l) hint.textContent = l.slice(-120); };
      let tree;
      try { tree = await buildTree(img, io); } catch (e) { log(String(e.message || e)); setState('failed', 'err'); return needs(m, String(e.message || e)); }
      log(`the tree is built (${tree.nodes.size} paths, ${((performance.now() - t0) / 1000).toFixed(1)} s); starting ${img.entry && img.entry.run}`);
      status.textContent = `starting ${m.title}…`;
      await start(m, img, tree.host(), () => runHere(m));
    };
    const items = [...introItems, ...listed.map((m) => ({ id: m.name, title: m.title, year: m.year, author: m.author, thumb: m.thumb, note: m.name, open: () => runHere(m) }))];
    shelf(shelfTitle, items, params.get('prog') || params.get('run'));
    const wanted = listed.find((m) => m.name === params.get('run'));
    if (wantedIntro) runIntro(wantedIntro);
    else if (wanted) runHere(wanted); else { needs(null); setState('choose', ''); status.textContent = 'choose an intro or an image — or drop a Linux program on the screen'; }
    return;
  }
  const run = async (m) => {
    replace({ m: world, run: m.name });
    for (const el of $('shelf').querySelectorAll('.card')) el.setAttribute('aria-selected', String(el.dataset.id === m.name));
    over.hidden = true;
    status.textContent = `starting ${m.title}… (the first run fetches the image's layers)`;
    const img = await (await fetch(`/oasis-image.json?img=${encodeURIComponent(m.name)}`)).json();
    await start(m, img, oasisHost(m.name), () => run(m));
  };
  const items = [...introItems, ...images.map((m) => ({ id: m.name, title: m.title, year: m.year, author: m.author, thumb: m.thumb, note: m.name, open: () => run(m) }))];
  shelf(shelfTitle, items, params.get('prog') || params.get('run') || 'linux/mirage');
  // The machine boots into a real shell: bash on tty1 of the image that has one (linux/mirage),
  // typed at as a console is; the shelf starts any image instead.
  if (wantedIntro) { runIntro(wantedIntro); return; }
  const wanted = images.find((m) => m.name === params.get('run')) || images.find((m) => m.name === 'linux/mirage') || images[0];   // linux/mirage: Linux's shell
  if (wanted) run(wanted);
}

({ dos, pc, linux, win32: () => linux('win32') })[mid]().catch((e) => { status.textContent = String(e.message || e); setState('failed', 'err'); console.error(e); });
