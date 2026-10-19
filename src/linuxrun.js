// linuxrun.js — an OASIS Linux image in the browser: MIRAGE-LINUX on a canvas, its keys from the page.
//
// The image's manifest and file tree come from the OASIS server (tools/oasis.mjs): /oasis-fs/{lstat,
// list,read}?p=<path>[&img=<name>]. MIRAGE-LINUX's file system asks synchronously, as a disk would
// answer, so the requests are synchronous too (XMLHttpRequest on the page's own thread). Used by
// linux.html (one image) and machines.html (the Linux machine).
import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installLinux } from './linux.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { VtConsole } from './vtconsole.js';
import { installAudio } from './audio.js';
import { AudioOut } from './audio-out.js';

/** A synchronous view of the image's tree, as lx.host wants it. */
export function oasisHost(imgName) {
  const q = (p) => `p=${encodeURIComponent(p)}` + (imgName ? `&img=${encodeURIComponent(imgName)}` : '');
  const sync = (op, p, binary) => {
    const x = new XMLHttpRequest();
    x.open('GET', `/oasis-fs/${op}?${q(p)}`, false);
    if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
    x.send();
    if (x.status !== 200) return null;
    if (!binary) return JSON.parse(x.responseText);
    const s = x.responseText, b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  };
  return { lstat: (p) => sync('lstat', p), list: (p) => sync('list', p) || [], read: (p) => sync('read', p, true) };
}

/**
 * Start an image's entry on `canvas`. `onOutput(text)` gets what it writes to its console or stdout,
 * `onStatus(text)` a line a second (speed) and the end. Returns { mc, lx, stop }.
 */
export async function startLinux({ canvas, img, host, user, onOutput = () => {}, onStatus = () => {} }) {
  const m = img.machine || {};
  const mc = new Machine({ memSize: (m.mem || 64) << 20, cpu: m.cpu || '686' });
  installBIOS(mc, m.vga ? { vga: m.vga } : {});   // `machine.vga: "cirrus"`: a CL-GD5446 (src/cirrus.js)
  for (const [prop, file] of [['font', 'vga-rom-8x16.bin'], ['font8x8', 'vga-rom-8x8.bin'], ['font8x14', 'vga-rom-8x14.bin']]) {
    try { mc[prop] = new Uint8Array(await (await fetch('assets/' + file)).arrayBuffer()); } catch { /* optional */ }
  }
  const lx = installLinux(mc, { realTime: true, onOutput: (fd, b) => onOutput(new TextDecoder().decode(b)) });
  // Sound: /dev/dsp (src/linux.js) plays on the program's clock, which is the wall clock here; the
  // mixer takes the same one. The output starts with the first click or key, as a browser requires.
  mc.wallClockMs = () => performance.now();
  installAudio(mc);
  const audio = new AudioOut(mc);
  const wake = () => { audio.start(); window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake); };
  window.addEventListener('keydown', wake); window.addEventListener('pointerdown', wake);
  lx.host = host;
  lx.epoch = Math.floor(Date.now() / 1000);
  const e = img.entry || {};
  lx.chdir(e.cwd || '/');
  if (e.console) {
    lx.consoleStdio();
    lx.console = new VtConsole(mc.mem.u8, mc.vga);                       // the tty's text on the VGA screen
    lx.console.clear(); lx.console.row = 0; lx.console.col = 0; lx.console.syncCursor();
  }
  const env = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root', 'LANG=C', ...Object.entries(e.env || {}).map(([k, v]) => `${k}=${v}`)];
  if (user) { const u = lx.setUser(user); env.push(`USER=${u}`, `LOGNAME=${u}`); }   // the visitor's name, on uid 0
  if (m.hz) lx.hz = m.hz;                                                    // machine.hz: a 1997 kernel's timeouts, in clock ticks
  const image = lx.readFile(e.run);
  if (!image) throw new Error(`${e.run}: not in the image`);
  lx.load(image, [e.run, ...(e.args || [])], env);

  const video = new Video(mc, canvas); video.font = mc.font;
  // The page's keys reach the console two ways (src/keyboard.js gives both). In K_XLATE — a shell,
  // anything that reads characters — the CHARACTER the host's own layout produced goes to the line
  // discipline, so an AZERTY keyboard types what is printed on its keys; the cursor and editing keys
  // become the console's escape sequences. In K_RAW and K_MEDIUMRAW — SVGAlib, DOOM — the PC
  // keyboard's scancodes go, by physical position, as the kernel would deliver them.
  const SEQ = { 0x48: '\x1b[A', 0x50: '\x1b[B', 0x4d: '\x1b[C', 0x4b: '\x1b[D', 0x47: '\x1b[1~', 0x4f: '\x1b[4~',
    0x52: '\x1b[2~', 0x53: '\x1b[3~', 0x49: '\x1b[5~', 0x51: '\x1b[6~' };
  const typed = {
    length: 0, shift() {},
    push({ scan, ascii }) {
      if (lx.tty.kbMode !== 1) return;
      const bytes = ascii ? [ascii === 8 ? 0x7f : ascii] : [...(SEQ[scan] || '')].map((c) => c.charCodeAt(0));
      if (!bytes.length) return;
      lx.ttyInput(bytes);
      mc.blocked = false;                                                 // a read waiting for a key runs again
    },
  };
  const keyboard = new Keyboard({ keyQueue: typed, pushScancodes: (a) => { if (lx.tty.kbMode !== 1) lx.keyScancodes(a); } });
  keyboard.attach(window);
  // The mouse: a click on the screen captures it (pointer lock, Esc releases it), and its moves and
  // buttons go to /dev/mouse as a Microsoft serial mouse's packets — SVGAlib's mouse, Quake's aim.
  let buttons = 0;
  const btn = (b) => (b === 0 ? 1 : b === 2 ? 2 : 0);
  const onDown = (ev) => {
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock && canvas.requestPointerLock(); return; }
    buttons |= btn(ev.button); lx.mouseInput(0, 0, buttons); ev.preventDefault();
  };
  const onUp = (ev) => { if (document.pointerLockElement !== canvas) return; buttons &= ~btn(ev.button); lx.mouseInput(0, 0, buttons); };
  const onMove = (ev) => { if (document.pointerLockElement === canvas && (ev.movementX || ev.movementY)) lx.mouseInput(ev.movementX, ev.movementY, buttons); };
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onUp); window.addEventListener('mousemove', onMove);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // The CPU runs in ~12 ms chunks chained through a MessageChannel; requestAnimationFrame only draws.
  const tick = new MessageChannel();
  let fault = null, stopped = false, paused = false;
  mc.onError = (err) => { fault = err; console.error(err); };
  tick.port1.onmessage = () => {
    if (stopped) return;
    const t0 = performance.now();
    let waiting = false;
    while (!paused && !lx.done && !fault && performance.now() - t0 < 12) {
      mc.runSlice(20000);
      if (mc.blocked && !lx.ttyIn.length) { waiting = true; break; }     // a read waits for a key: give the time back
    }
    if (lx.done) onStatus(`exited with status ${lx.status}` + (lx.signal ? ` (signal ${lx.signal})` : ''));
    else if (fault) onStatus(String(fault.message || fault).split('\n')[0]);
    else if (paused || waiting) setTimeout(() => tick.port2.postMessage(0), paused ? 50 : 10);
    else tick.port2.postMessage(0);
  };
  tick.port2.postMessage(0);
  let frames = 0, last = performance.now(), c0 = 0, raf = 0;
  const draw = () => {
    if (stopped) return;
    video.render(); frames++;
    audio.pump();
    const now = performance.now();
    if (now - last > 1000 && !lx.done && !fault) {
      onStatus(paused ? 'paused' : `${((mc.cpu.cycles - c0) / (now - last) / 1000).toFixed(1)} M instructions/s · ${frames} fps`);
      frames = 0; last = now; c0 = mc.cpu.cycles;
    }
    raf = requestAnimationFrame(draw);
  };
  draw();
  return {
    mc, lx, audio,
    pause(on) { paused = on; },
    stop() { stopped = true; cancelAnimationFrame(raf); keyboard.detach(window); window.removeEventListener('mouseup', onUp); window.removeEventListener('mousemove', onMove); },
  };
}
