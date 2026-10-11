// bootpc.js — the bare-PC page (boot.html): boot a floppy or hard-disk IMAGE the way a BIOS does,
// with no HLE DOS underneath. The DOS player (dos.html + ui.js) runs programs on our DOS; this one
// runs whole systems (Linux, the BSDs, MS-DOS, Windows 9x) off their own disks or CDs, like the headless
// tools/v86/*.mjs do. Minimal on purpose: pick an image, a CPU profile and RAM, boot, watch.
//
// URL parameters (so a boot can be bookmarked):
//   ?img=boot/v86/bl3-5.img   image to boot (a served path)   ?cpu=386|586|pentium|686|pentiumpro   ?mem=64 (MiB)
//   ?clock=realtime|turbo   ?pci=1 (QEMU -M pc's bus)   ?com1=1 (a 16550A and a console under the screen)
//
// Two clocks. REAL TIME (the default, as v86 and dos.html do it): the PIT fires on the wall clock at
// the rate the guest programmed, and the CPU runs as fast as the host allows in between, so a game
// paced by the timer (Keen, Alley Cat) plays at its speed. TURBO: the PIT runs off cpu.cycles, as
// the headless tools do, so a long boot is not held to real time — an idle HLT skips straight to the
// next tick — but the guest's clock then races (Linux booting reads x100).

import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installMouse } from './mouse.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { bootSector, bootCD } from './boot.js';
import { installAudio } from './audio.js';
import { AudioOut } from './audio-out.js';
import { installFullscreen } from './fullscreen.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen'), status = $('status'), pick = $('image'), fileIn = $('file');
installFullscreen($('stage'), $('fullscreen'));
const cpuSel = $('cpu'), memSel = $('mem'), clockSel = $('clock'), bootBtn = $('boot'), pauseBtn = $('pause');
const mouseHint = $('mousehint'), pciBox = $('pci'), comBox = $('com1'), serialPane = $('serial'), serialOut = $('serialOut'), serialIn = $('serialIn');
const TICK_MS = 1000 / 18.2065;
const FLOPPIES = [163840, 184320, 327680, 368640, 737280, 1228800, 1474560, 2949120];
const FRAME_MS = 12;

let session = null;                    // { mc, video, keyboard, raf, paused, name, t0 }

// ---- the image list: the examples, then whatever the static server lists under boot/ -----------
// GitHub Pages lists no directory, so the redistributable examples come from examples/manifest.json.
async function listImages() {
  const out = [];
  try {
    const m = await (await fetch('examples/manifest.json')).json();
    for (const e of m) if (e.kind === 'boot') out.push(e.file);
  } catch { /* no manifest */ }
  for (const dir of ['boot/', 'boot/v86/', 'boot/iso/']) {
    try {
      const html = await (await fetch(dir)).text();
      for (const m of html.matchAll(/href="([^"?#]+\.(?:img|ima|dsk|vfd|iso))"/gi)) out.push(dir + decodeURIComponent(m[1]));
    } catch { /* not served */ }
  }
  // An image named in the URL is offered even if no listing knows it.
  const wanted = new URLSearchParams(location.search).get('img');
  if (wanted && !out.includes(wanted)) out.unshift(wanted);
  pick.innerHTML = '<option value="">— choose an image —</option>' +
    out.map((p) => `<option value="${p}">${p}</option>`).join('');
}

// ---- disk geometry: a hard disk's comes from its partition table, like bootshot.mjs -------------
function attach(mc, bytes) {
  if (bytes.length <= 2949120) {
    if (!FLOPPIES.includes(bytes.length)) { const p = new Uint8Array(1474560); p.set(bytes.subarray(0, 1474560)); bytes = p; }
    mc.disk.attach(0, bytes);
    return { bytes, drive: 0x00 };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset), e = 0x1be;
  const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true), sh = bytes[e + 1], ss = bytes[e + 2] & 63;
  const eh = bytes[e + 5], es = bytes[e + 6] & 63, ec = bytes[e + 7] | ((bytes[e + 6] & 0xc0) << 2);
  const ok = (bytes[e] === 0 || bytes[e] === 0x80) && bytes[e + 4] && n && ec;
  const spt = ok && sh ? (lba - (ss - 1)) / sh : 63;
  const heads = ok ? Math.round(((lba + n - 1 - (es - 1)) / spt - eh) / ec) : 16;
  const g = Number.isInteger(spt) && spt > 0 && heads > 0 && heads <= 255 ? { spt, heads } : { spt: 63, heads: 16 };
  mc.disk.attach(0x80, bytes, { cyl: Math.floor(bytes.length / (g.heads * g.spt * 512)), heads: g.heads, spt: g.spt, type: 3 });
  return { bytes, drive: 0x80 };
}

async function loadFonts(mc) {
  for (const [prop, file] of [['font', 'vga-rom-8x16.bin'], ['font8x8', 'vga-rom-8x8.bin'], ['font8x14', 'vga-rom-8x14.bin']]) {
    try { mc[prop] = new Uint8Array(await (await fetch('assets/' + file)).arrayBuffer()); } catch { /* optional */ }
  }
}

// ---- boot ------------------------------------------------------------------------------------
async function boot(name, raw) {
  stop();
  const memSize = Number(memSel.value) << 20;
  const mc = new Machine({ memSize, cpu: cpuSel.value });
  // A bare PC: no EMS (see tools/harness.mjs). PCI = QEMU's -M pc rather than -M isapc; COM1 = a
  // 16550A whose transmit side fills the console under the screen (src/pci.js, src/uart.js).
  installBIOS(mc, { ems: false, pci: pciBox.checked, serial: comBox.checked });
  serialOut.textContent = '';
  serialPane.style.display = mc.serial ? 'block' : 'none';
  if (mc.serial) {
    let pending = '';
    mc.serial.onTx = (b) => { if (b !== 0x0d) pending += String.fromCharCode(b); };
    // Flushed from the drawing loop, not per byte: a kernel's console prints thousands of characters.
    mc.serialFlush = () => {
      if (!pending) return;
      serialOut.textContent = (serialOut.textContent + pending).slice(-20000); pending = '';
      serialOut.scrollTop = serialOut.scrollHeight;
    };
  }
  installMouse(mc);
  await loadFonts(mc);
  const turbo = clockSel.value === 'turbo';
  // Sound only in real time: in turbo the machine's clock is cpu.cycles, far ahead of the listener's.
  installAudio(mc);
  audioOut.machine = mc;
  audioOut.setMuted(turbo || !soundBox.checked);
  mc.timerAuto = turbo;                     // turbo: guest time = cpu.cycles, as headless
  if (!turbo) mc.wallClockMs = () => performance.now();   // anchors the 0x3DA retrace to real 70 Hz
  // In real time the CMOS clock is the host's, as on a real PC: Windows 95 otherwise came up on
  // 1 January 1990 (the engine's fixed epoch, kept for reproducible runs — src/rtc.js).
  if (!turbo && mc.rtc) mc.rtc.useHostClock();
  const video = new Video(mc, canvas);
  video.font = mc.font;
  let fault = null;
  mc.onError = (e) => { fault = e; console.error(e); };
  // An ISO boots the El Torito way, from the ATAPI drive; anything else is a floppy or a hard disk.
  try {
    if (/\.iso$/i.test(name)) bootCD(mc, raw);
    else { const { bytes, drive } = attach(mc, raw); bootSector(mc, bytes, { drive }); }
  } catch (e) { status.textContent = String(e.message || e); return; }
  const keyboard = new Keyboard(mc);
  keyboard.attach(window);
  session = { mc, video, keyboard, raf: 0, paused: false, name, fault: () => fault, host0: performance.now(), turbo, lastTick: performance.now() };
  window.mirage = session;                  // for the console
  pauseBtn.disabled = false; pauseBtn.textContent = 'Pause';
  canvas.focus();
  loop();
}

function stop() {
  if (!session) return;
  cancelAnimationFrame(session.raf);
  session.stopped = true;                   // ends its MessageChannel chain
  session.keyboard.detach(window);
  if (document.pointerLockElement) document.exitPointerLock();
  session = null;
}

// The CPU does not run off requestAnimationFrame: a browser throttles that to ~1 Hz in a hidden or
// background view, and the guest crawled at 0.3x real time there. It runs in FRAME_MS chunks chained
// through a MessageChannel (a macrotask, so input events and painting get in between), and rAF only
// draws what is there.
const tick = new MessageChannel();
let gen = 0;
tick.port1.onmessage = (e) => {
  const s = session; if (!s || s.stopped || e.data !== s.gen) return;   // a stopped session's chain ends here
  const mc = s.mc;
  if (!s.paused && !s.fault()) {
    const t0 = performance.now();
    let w = t0;
    while (w - t0 < FRAME_MS && !s.fault()) {
      if (!s.turbo) {
        // At the guest's programmed rate (pitReload against pitBase, as ui.js), AT MOST ONE tick per
        // pass so its ISR runs before the next fires; a backlog (a hidden tab) is dropped, not replayed.
        const tickMs = Math.max(3, TICK_MS * (mc.pitReload / (mc.pitBase || 0x10000)));
        if (w - s.lastTick > 250) s.lastTick = w;
        if (w - s.lastTick >= tickMs) { mc.tickTimer(); s.lastTick += tickMs; }
      }
      mc.pumpKeyboard();
      mc.runSlice(20000);
      if (!s.turbo && mc.cpu.halted) break;   // HLT waits for the next tick: give the time back
      w = performance.now();
    }
  }
  if (s.paused || s.fault()) setTimeout(() => tick.port2.postMessage(s.gen), 50);
  else if (!s.turbo && mc.cpu.halted) setTimeout(() => tick.port2.postMessage(s.gen), 1);
  else tick.port2.postMessage(s.gen);
};
function loop() {
  const s = session; if (!s) return;
  if (!s.started) { s.started = true; s.gen = ++gen; tick.port2.postMessage(s.gen); }
  s.raf = requestAnimationFrame(loop);
  s.video.render();
  audioOut.pump();
  if (s.mc.serialFlush) s.mc.serialFlush();
  showStatus(s);
}

const h = (v, n = 4) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
function showStatus(s) {
  const c = s.mc.cpu, sec = 18.2065 * s.mc.pitBase;
  const now = performance.now(), guest = c.cycles / sec, host = (now - s.host0) / 1000;
  if (!s.rateT || now - s.rateT > 1000) { s.mips = s.rateT ? (c.cycles - s.rateC) / (now - s.rateT) / 1000 : 0; s.rateT = now; s.rateC = c.cycles; }
  const mode = (c.flags & 0x20000) ? 'V86' : (c.cr0 & 1) ? ((c.cr0 >>> 31) ? 'PM+paging' : 'PM') : 'real';
  const f = s.fault();
  status.textContent = `${s.name} · ${f ? 'FAULT: ' + String(f.message || f).slice(0, 160) : s.paused ? 'paused' : 'running'} · ` +
    (s.turbo ? `guest ${guest.toFixed(1)} s (x${host > 0 ? (guest / host).toFixed(2) : '–'} real time) · ` : `${host.toFixed(0)} s · `) +
    `CPU ${s.mips.toFixed(1)} M instr/s · ${mode} ${h(c.seg[1])}:${h(c.eip, (c.cr0 & 1) ? 8 : 4)} · ` +
    `video mode ${h(s.mc.mem.u8[0x449], 2)}h`;          // physically: a paging OS may unmap page 0
}

// ---- mouse: relative motion, with or without pointer lock (a PS/2 or INT 33h guest both read it) -----
// The guest's driver (Windows' through INT 15h C2xx, a DOS driver through the 8042) only ever sees
// relative motion, so the host cursor is not needed: over the screen, movement and buttons go to the
// guest. A click also asks for pointer lock, which hides the host cursor and frees the motion from the
// edges of the canvas; when the browser refuses it (some embedded views do), the mouse still works.
// It used to forward nothing until the lock was granted, and a refused lock left the mouse dead with
// no message: Windows 95 and 98 were unusable that way.
const btn = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);
const locked = () => document.pointerLockElement === canvas;
canvas.addEventListener('click', () => {
  if (!session || locked() || !canvas.requestPointerLock) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* refused: unlocked mode */ }
});
canvas.addEventListener('mousemove', (e) => { if (session) session.mc.mouseMoveRel(e.movementX | 0, e.movementY | 0); });
canvas.addEventListener('mousedown', (e) => { if (session) session.mc.mouseButton(btn(e.button), true); });
window.addEventListener('mouseup', (e) => { if (session) session.mc.mouseButton(btn(e.button), false); });
document.addEventListener('pointerlockchange', () => { mouseHint.textContent = locked() ? 'mouse captured — Esc releases it' : ''; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- controls ----------------------------------------------------------------------------------
async function bootSelected() {
  const f = fileIn.files && fileIn.files[0];
  if (f) { status.textContent = `reading ${f.name}…`; return boot(f.name, new Uint8Array(await f.arrayBuffer())); }
  if (!pick.value) { status.textContent = 'choose an image first'; return; }
  status.textContent = `fetching ${pick.value}…`;
  const url = new URL(location.href);
  url.searchParams.set('img', pick.value); url.searchParams.set('cpu', cpuSel.value); url.searchParams.set('mem', memSel.value); url.searchParams.set('clock', clockSel.value);
  url.searchParams.set('pci', pciBox.checked ? '1' : '0'); url.searchParams.set('com1', comBox.checked ? '1' : '0');
  history.replaceState(null, '', url);
  // A .gz image (the FreeDOS disk of the home page: 64 MB, 25 MB compressed) is inflated here.
  const res = await fetch(pick.value);
  const body = /\.gz$/i.test(pick.value) ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return boot(pick.value.split('/').pop().replace(/\.gz$/i, ''), bytes);
}
const tryBoot = () => bootSelected().catch((e) => { console.error(e); status.textContent = 'boot failed: ' + (e.message || e); });
// One output for every session (a page gets few AudioContexts), started by the Boot click — the
// user gesture a browser wants before it plays anything.
const audioOut = new AudioOut({ audio: null });
const soundBox = $('sound');
soundBox.addEventListener('change', () => { audioOut.setMuted(!soundBox.checked || clockSel.value === 'turbo'); if (soundBox.checked) audioOut.start(); });
bootBtn.addEventListener('click', () => { bootBtn.blur(); if (soundBox.checked) audioOut.start(); tryBoot(); });
pick.addEventListener('change', () => { fileIn.value = ''; });
fileIn.addEventListener('change', () => { pick.value = ''; });
pauseBtn.addEventListener('click', () => {
  pauseBtn.blur();
  if (!session) return;
  session.paused = !session.paused; pauseBtn.textContent = session.paused ? 'Resume' : 'Pause';
});
for (const el of [pick, cpuSel, memSel, clockSel, pciBox, comBox, serialIn]) el.addEventListener('keydown', (e) => e.stopPropagation());
serialIn.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !session || !session.mc.serial) return;
  session.mc.serial.receive(serialIn.value + '\r'); serialIn.value = '';
});

const q = new URLSearchParams(location.search);
if (q.get('cpu')) cpuSel.value = q.get('cpu');
if (q.get('mem')) memSel.value = q.get('mem');
if (q.get('clock')) clockSel.value = q.get('clock');
if (q.get('pci')) pciBox.checked = q.get('pci') === '1';
if (q.get('com1')) comBox.checked = q.get('com1') === '1';
listImages().then(() => { if (q.get('img')) { pick.value = q.get('img'); tryBoot(); } });
