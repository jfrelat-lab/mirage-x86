// machines.js — machines.html: MIRAGE's machines, and each one's programs.
//
//   machines.html?m=dos[&run=<id>]     the DOS player's engine, its shell listing the titles
//   machines.html?m=pc[&run=<id>]      a bare PC: a BIOS boot menu of the boot images
//   machines.html?m=linux[&run=<img>]  MIRAGE-LINUX: the OASIS Linux images (needs `oasis serve`)
//
// A machine is one engine for the page's lifetime; choosing another machine, or a program while one
// runs, loads the page again with that choice — a machine is switched off and on, not reused.
// DOS and PC titles come from examples/manifest.json (the home page's examples); Linux images from
// the OASIS server's /oasis-images.json (tools/oasis.mjs serve).
import { Mirage } from './ui.js';
import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installMouse } from './mouse.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { bootSector, attachImage } from './boot.js';
import { installAudio } from './audio.js';
import { AudioOut } from './audio-out.js';
import { installFullscreen } from './fullscreen.js';
import { startLinux, oasisHost } from './linuxrun.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen'), over = $('over'), status = $('status'), hint = $('hint');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);

const MACHINES = [
  { id: 'dos', name: 'DOS', sub: 'built-in DOS · no image', spec: '586 · 16 MB · VGA · SB16 · XMS · EMS · DPMI' },
  { id: 'linux', name: 'Linux', sub: 'system calls in JS · no kernel', spec: 'i686 · 64 MB · tty1 · VGA · ELF and a.out' },
  { id: 'pc', name: 'PC', sub: 'bare metal · BIOS', spec: 'BIOS · VGA/VBE · floppy · IDE · CD-ROM' },
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

function shelf(title, items, current) {
  $('shelfTitle').textContent = title;
  $('shelf').innerHTML = items.map((x, i) => `<button class="card" data-i="${i}"${x.id === current ? ' aria-selected="true"' : ''}>
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
    const res = await fetch(e.file);
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
async function linux() {
  let images = [];
  // Images meant for a window; the terminal ones (a shell) run with `oasis run` in a terminal.
  try { images = (await (await fetch('/oasis-images.json')).json()).filter((m) => m.world === 'linux' && m.output === 'window'); } catch { images = null; }
  over.className = 'over term'; over.hidden = false;
  if (!images) {
    setState('no images', 'err');
    over.innerHTML = `<span class="b">$ ls /oasis/images/linux</span>\nls: cannot access '/oasis/images/linux': No such file or directory\n\n<div class="note">The Linux machine reads its programs from OASIS images, which bring their file trees from their original archives (Debian's, idgames…). Start the page from OASIS:\n\n<span class="g">node tools/oasis.mjs serve --open</span>\n\n— or one image in a window of its own: <span class="g">node tools/oasis.mjs run linux/doom-1994</span>. See docs/OASIS.md.</div>`;
    shelf('OASIS Linux images', [], null);
    status.textContent = 'served without OASIS';
    return;
  }
  const run = async (m) => {
    if (session) { go({ m: 'linux', run: m.name }); return; }
    over.hidden = true;
    status.textContent = `starting ${m.title}… (the first run fetches the image's layers)`;
    const img = await (await fetch(`/oasis-image.json?img=${encodeURIComponent(m.name)}`)).json();
    let lastLine = '';
    try {
      const s = await startLinux({ canvas, img, host: oasisHost(m.name),
        onOutput: (t) => { lastLine = (lastLine + t).split('\n').filter(Boolean).pop() || lastLine; hint.textContent = lastLine.slice(-120); },
        onStatus: (t) => { status.textContent = t; if (/^exited/.test(t)) setState('exited', ''); } });
      session = { pause: s.pause, audio: null };
      window.mirage = s;
      setState('running');
      canvas.focus();
    } catch (e) { status.textContent = String(e.message || e); setState('failed', 'err'); }
  };
  const items = images.map((m) => ({ id: m.name, title: m.title, year: m.year, author: m.author, thumb: m.thumb, note: m.name, open: () => run(m) }));
  shelf('OASIS Linux images', items, params.get('run'));
  const wanted = images.find((m) => m.name === params.get('run'));
  if (wanted) { run(wanted); return; }
  setState('login', '');
  over.innerHTML = `<span class="g">mirage login:</span> root\nLinux mirage 2.6.32 i686 — MIRAGE-LINUX: no kernel, the system calls in JavaScript\n\n<span class="b">root@mirage:~# ls -l /oasis/images/linux</span>\n` +
    images.map((m, i) => `-rwxr-xr-x 1 root root ${String(m.year || '').padStart(6)}  <a data-i="${i}">${esc(m.name.split('/').pop())}</a>   <span class="y">${esc(m.title)}</span>`).join('\n') +
    `\n\n<span class="b">root@mirage:~#</span> <span style="color:#aaa">click a name to run it</span>`;
  for (const a of over.querySelectorAll('a')) a.onclick = () => run(images[+a.dataset.i]);
  status.textContent = `${images.length} image(s)`;
}

({ dos, pc, linux })[mid]().catch((e) => { status.textContent = String(e.message || e); setState('failed', 'err'); console.error(e); });
