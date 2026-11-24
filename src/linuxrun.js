// linuxrun.js — an OASIS Linux image in the browser: MIRAGE-LINUX on a canvas, its keys from the page.
//
// The image's manifest and file tree come from the OASIS server (tools/oasis.mjs): /oasis-fs/{lstat,
// list,read}?p=<path>[&img=<name>]. MIRAGE-LINUX's file system asks synchronously, as a disk would
// answer, so the requests are synchronous too (XMLHttpRequest on the page's own thread). Used by
// linux.html (one image) and machines.html (the Linux machine).
import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installLinux, vramFor } from './linux.js';
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
 * `onStatus(text)` a line a second (speed) and the end. `moment`: a kept moment's bytes (keep's), which the
 * machine goes on from in place of the entry's start -- its processes, files, console and clock as kept.
 * Returns { mc, lx, keep, resumed, stop }.
 */
export async function startLinux({ canvas, img, host, user, moment = null, onOutput = () => {}, onStatus = () => {} }) {
  const m = img.machine || {};
  // world "win32": the entry is a PE .exe, run by MIRAGE-WIN32 (src/win32) on the same machinery; its
  // RAM is what its image reserves, which a Crinkler intro touches much of.
  const win32 = img.world === 'win32';
  const exe = win32 ? host.read((img.entry || {}).run) : null;
  if (win32 && !exe) throw new Error(`${(img.entry || {}).run}: not in the image`);
  const win32Mod = win32 ? await import('./win32/index.js') : null;
  const ram = win32 ? win32Mod.win32Memory(exe, m.mem || 0) : (m.mem || 64) << 20;
  // A Cirrus has its 32 MiB aperture above the RAM, as on a PCI bus (src/bios.js): the address space
  // twice the RAM (a power of two).
  const mc = new Machine({ memSize: m.vga === 'cirrus' ? Math.max(ram * 2, 64 << 20) : ram, ramSize: ram, cpu: m.cpu || '686' });
  installBIOS(mc, { ...(m.vga ? { vga: m.vga } : {}), ...(vramFor(m.fb) ? { vram: vramFor(m.fb) } : {}) });   // a large framebuffer: more card (vramFor)   // `machine.vga: "cirrus"`: a CL-GD5446 (src/cirrus.js)
  for (const [prop, file] of [['font', 'vga-rom-8x16.bin'], ['font8x8', 'vga-rom-8x8.bin'], ['font8x14', 'vga-rom-8x14.bin']]) {
    try { mc[prop] = new Uint8Array(await (await fetch('assets/' + file)).arrayBuffer()); } catch { /* optional */ }
  }
  const lx = installLinux(mc, { realTime: true, onOutput: (fd, b) => onOutput(new TextDecoder().decode(b)) });
  // Sound: /dev/dsp (src/linux.js) plays on the program's clock, which is the wall clock here; the
  // mixer takes the same one. The output starts with the first click or key, as a browser requires.
  mc.wallOffset = 0; mc.wallClockMs = () => performance.now() + mc.wallOffset;   // a kept moment goes on from its own time (src/snapshot.js)
  installAudio(mc);
  const audio = new AudioOut(mc);
  const wake = () => { audio.start(); window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake); };
  window.addEventListener('keydown', wake); window.addEventListener('pointerdown', wake);
  lx.host = host;
  // machine.hle: libraries made in JavaScript in /usr/lib — ["sdl12", "gl", "glu", "asound"], the GL ones
  // PRISM's (src/hle/prism-gl.js) — for the Linux OpenGL intros of 2003-2010.
  let hle = null, w32in = null, w32wm = null, w32loaded = null;
  if (win32) {
    const [{ prismLibraries }, { win32Apis }] = await Promise.all([import('./hle/prism-gl.js'), import('./win32/api.js')]);
    const { WIN32_GL_EXTENSIONS } = await import('./win32/api.js');
    hle = await prismLibraries(lx, mc.mem, ['gl', 'glu'], { extensions: WIN32_GL_EXTENSIONS });
    const [glLib, gluLib] = hle.libs;
    // machine.fonts: the TrueType fonts it selects (D3DXCreateText), the visitor's or free ones (src/win32/fonts.js)
    // Without any, DejaVu Sans as Arial, where the font mapper ends: a dialog's text, a button's, a message box's.
    const fonts = await (await import('./win32/fonts.js')).pageFonts(m.fonts || ['Arial'], (t) => onOutput(t + '\n'), !!m.fonts);
    // The files beside the program, and in the directories below it, on its own disk (by their path
    // there): WinQuake's id1/pak0.pak, Abuse's art/ and levels/. The program's own file among them, as on
    // Windows: Half-Life's launcher reads itself to validate ("Could not validate Half-Life" without it).
    // entry.root: the image's folder that is C:'s root, the program in a folder of it with its path there
    // (Unreal Tournament's C:\System\UnrealTournament.exe, which reads ..\Help and ..\Maps); else the
    // program's own folder, the program at C:'s root.
    const root = img.entry.root ? img.entry.root.replace(/\/+$/, '') || '/' : null;
    const files = {}, dir = root || img.entry.run.replace(/\/[^/]*$/, '') || '/';
    (function walk(d, rel) { for (const n of host.list(d)) { const p = `${d === '/' ? '' : d}/${n}`, st = host.lstat(p); if (st && st.type === 'dir') walk(p, rel + n + '/'); else if (st && st.type === 'file') files[rel + n] = host.read(p); } })(dir, '');
    // entry.env: the program's environment (SDL's hints); machine.codepage: the system's code page, 932 for a
    // Japanese Windows (Cave Story's Shift-JIS text).
    // The visitor's language (machine.lang, else the browser's, when the code page can write it): the
    // language a program's resources are taken in -- Flash Player 8's menus in French for a French browser.
    const { langIdOf } = await import('./win32/api.js'), lang = m.lang ? Number(m.lang) : langIdOf(globalThis.navigator && navigator.language, m.codepage);
    const apis = win32Apis({ gl: glLib.fns, glu: gluLib.fns, fonts, files, env: img.entry.env || {}, codepage: m.codepage, desk: m.desktop, lang });
    w32in = apis.input; w32wm = apis.wm;
    w32loaded = win32Mod.loadPE(lx, mc.mem, mc.cpu, new Uint8Array(exe), { path: 'C:\\' + (root ? img.entry.run.slice(root === '/' ? 1 : root.length + 1).split('/').join('\\') : img.entry.run.split('/').pop()), args: (img.entry.args || []).join(' '), apis, backend: hle.backend });
  } else if (m.hle) {
    const [{ installHLE }, { prismLibraries }] = await Promise.all([import('./hle/index.js'), import('./hle/prism-gl.js')]);
    hle = await prismLibraries(lx, mc.mem, m.hle);
    for (const f of installHLE(lx, mc.mem, mc.cpu, hle.libs, hle.backend)) { lx.addFile(f.path, f.bytes); for (const l of f.links) lx.addFile(l, f.bytes); }
  }
  lx.epoch = Math.floor(Date.now() / 1000);
  const e = img.entry || {};
  lx.chdir(e.cwd || '/');
  if (e.console) {
    lx.consoleStdio();
    lx.console = new VtConsole(mc.mem.u8, mc.vga);                       // the tty's text on the VGA screen
    lx.console.clear(); lx.console.row = 0; lx.console.col = 0; lx.console.syncCursor();
  }
  // entry.user (a Docker image's User): its own ids and name, its HOME from /etc/passwd unless the image sets one;
  // else the visitor's name, on uid 0.
  const as = e.user && !win32 ? lx.runAs(e.user) : null, home = (e.env && e.env.HOME) || (as ? as.home : '/root');
  const env = ['PATH=/usr/local/bin:/usr/bin:/bin', `HOME=${home}`, 'LANG=C', ...Object.entries(e.env || {}).filter(([k]) => k !== 'HOME').map(([k, v]) => `${k}=${v}`)];
  if (as) env.push(`USER=${as.name}`, `LOGNAME=${as.name}`);
  else if (user) { const u = lx.setUser(user); env.push(`USER=${u}`, `LOGNAME=${u}`); }   // the visitor's name, on uid 0
  if (m.fb) { const [w, h] = String(m.fb).split('x').map(Number); lx.setFb(w, h); }   // machine.fb: /dev/fb0's size, "1024x768"
  if (m.hz) lx.hz = m.hz;                                                    // machine.hz: a 1997 kernel's timeouts, in clock ticks
  if (!win32) {
    const image = lx.readFile(e.run);
    if (!image) throw new Error(`${e.run}: not in the image`);
    lx.load(image, [e.run, ...(e.args || [])], env);
  }

  // A kept moment: the machine built as for a start (the same image, the same objects), then the kept
  // state written into it (src/snapshot.js). A Windows program's or an HLE library's state is not kept yet.
  const snap = await import('./snapshot.js');
  let resumed = null;
  if (moment) {
    if (win32 || hle) throw new Error('a kept moment of a Windows program or of HLE libraries cannot be taken back yet');
    try { const { snap: kept, meta } = await snap.unpackSnapshot(moment); snap.loadMachine(mc, kept); resumed = meta; }
    catch (err) { audio.close(); window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake); throw err; }
  }
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
  // A Windows program gets its keys as window messages (src/win32/api.js input): each make or break
  // code, E0-prefixed ones as extended keys.
  let e0 = false;
  const toWin32 = (codes) => { for (const c of codes) { if (c === 0xe0) { e0 = true; continue; } w32in.key(!(c & 0x80), c & 0x7f, e0); e0 = false; } };
  // A program on MIRAGE's libSDL (machine.hle "sdl12": Tux Racer) gets its keys and its mouse as SDL
  // events, once it has a window -- the scancodes as SDLK keys (src/hle/sdl12.js) -- not on the console.
  const sdlIn = hle && m.hle && m.hle.includes('sdl12') && hle.backend.events ? hle.backend : null;
  const toSdl = (codes) => { for (const c of codes) { if (c === 0xe0) { e0 = true; continue; } sdlIn.events.push({ type: c & 0x80 ? 'keyup' : 'keydown', scancode: c & 0x7f, e0 }); e0 = false; } };
  const keyboard = new Keyboard({ keyQueue: w32in || sdlIn ? { length: 0, shift() {}, push() {} } : typed,
    pushScancodes: (a) => { if (w32in) toWin32(a); else if (sdlIn) toSdl(a); else if (lx.tty.kbMode !== 1) lx.keyScancodes(a); } });
  keyboard.attach(window);
  // The mouse: a click on the screen captures it (pointer lock, Esc releases it), and its moves and
  // buttons go to /dev/mouse as a Microsoft serial mouse's packets — SVGAlib's mouse, Quake's aim.
  let buttons = 0;
  const btn = (b) => (b === 0 ? 1 : b === 2 ? 2 : 0);
  // A Windows program's mouse (src/win32/wm.js) is free until the program captures it: free, it is
  // the point of the screen under the visitor's pointer -- the window's frame drags and closes, the
  // client area gets the program's messages -- and a game that hides and clips the cursor to aim
  // gets the pointer locked on a click, its moves relative, until it lets go.
  const locked = () => document.pointerLockElement === canvas;
  const screenPoint = (ev) => {                                       // the canvas is letterboxed (object-fit: contain)
    const r = canvas.getBoundingClientRect(), k = Math.min(r.width / canvas.width, r.height / canvas.height) || 1;
    return [Math.floor((ev.clientX - r.left - (r.width - canvas.width * k) / 2) / k), Math.floor((ev.clientY - r.top - (r.height - canvas.height * k) / 2) / k)];
  };
  const wbtn = (ev) => [0, 2, 1][ev.button] ?? 0;
  const sdlButton = (ev) => [1, 2, 3][ev.button] ?? 1;                   // SDL_BUTTON_LEFT, MIDDLE, RIGHT
  const onDown = (ev) => {
    if (sdlIn) { const [X, Y] = screenPoint(ev); sdlIn.events.push({ type: 'mousedown', button: sdlButton(ev), x: X, y: Y }); ev.preventDefault(); return; }
    if (w32in && !locked()) {
      if (w32in.captures()) { canvas.requestPointerLock && canvas.requestPointerLock(); return; }
      w32in.mouseAt(...screenPoint(ev)); w32in.mouseButton(wbtn(ev), true); ev.preventDefault(); return;
    }
    if (!locked()) { canvas.requestPointerLock && canvas.requestPointerLock(); return; }
    buttons |= btn(ev.button); if (w32in) w32in.mouseButton(wbtn(ev), true); else lx.mouseInput(0, 0, buttons); ev.preventDefault();
  };
  const onUp = (ev) => {
    if (sdlIn) { const [X, Y] = screenPoint(ev); sdlIn.events.push({ type: 'mouseup', button: sdlButton(ev), x: X, y: Y }); return; }
    if (w32in && !locked()) { w32in.mouseAt(...screenPoint(ev)); w32in.mouseButton(wbtn(ev), false); return; }
    if (!locked()) return;
    buttons &= ~btn(ev.button); if (w32in) w32in.mouseButton(wbtn(ev), false); else lx.mouseInput(0, 0, buttons);
  };
  const onMove = (ev) => {
    if (sdlIn) { if (ev.target === canvas) { const [X, Y] = screenPoint(ev); sdlIn.events.push({ type: 'mousemove', x: X, y: Y }); } return; }
    if (w32in && !locked()) { if (ev.target === canvas || ev.buttons) w32in.mouseAt(...screenPoint(ev)); return; }
    if (locked() && (ev.movementX || ev.movementY)) { if (w32in) w32in.mouseMove(ev.movementX, ev.movementY); else lx.mouseInput(ev.movementX, ev.movementY, buttons); }
  };
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mouseup', onUp); window.addEventListener('mousemove', onMove);
  // Windows draws its own cursor on the screen (src/win32/wm.js): the page's is hidden over it.
  if (w32in) { canvas.style.cursor = 'none'; canvas.addEventListener('mouseleave', () => w32in.leave()); }
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // The CPU runs in ~12 ms chunks chained through a MessageChannel; requestAnimationFrame only draws.
  const tick = new MessageChannel();
  let fault = null, stopped = false, paused = false;
  mc.onError = (err) => { fault = err; console.error(err); };
  /*
   * What the status line says: the frames the PROGRAM presents each second (SwapBuffers, Direct3D's
   * Present, an SDL GL swap, a Windows window's GDI copy) -- not the page's own refreshes, which only
   * follow the monitor (144 on a 144 Hz screen while Elevated presented 60) -- and the most it could
   * present: those frames over the share of the second the host spent running the machine and
   * drawing. A program that paces itself waits, and its wait is not counted, so 60 frames for 400 ms
   * of work read "max ~150". The GPU's own time (WebGL draws asynchronously) is not in it.
   */
  let presents = 0, busy = 0;
  if (hle && hle.backend && hle.backend.swap) { const swap = hle.backend.swap.bind(hle.backend); hle.backend.swap = (...a) => { presents++; return swap(...a); }; }
  const programFrames = () => presents + (w32wm && w32wm.presented ? w32wm.presented() : 0);
  tick.port1.onmessage = () => {
    if (stopped) return;
    const t0 = performance.now();
    let waiting = false;
    while (!paused && !lx.done && !fault && performance.now() - t0 < 12) {
      mc.runSlice(20000);
      if (mc.blocked && !lx.ttyIn.length) { waiting = true; break; }     // a read waits for a key: give the time back
    }
    busy += performance.now() - t0;
    if (lx.done) onStatus(`exited with status ${lx.status}` + (lx.signal ? ` (signal ${lx.signal})` : ''));
    else if (fault) onStatus(String(fault.message || fault).split('\n')[0]);
    else if (paused) setTimeout(() => tick.port2.postMessage(0), 50);
    else if (waiting) {
      // Every process waits: until its first deadline when that is near -- a game's SDL_Delay(1) each frame
      // (Tux Racer's loop) waited 10 ms and halved its frame rate -- else 10 ms at a time (input may come).
      const due = lx.firstWake() * 1000 - performance.now();
      if (due <= 0.5) tick.port2.postMessage(0); else setTimeout(() => tick.port2.postMessage(0), Math.min(10, due));
    } else tick.port2.postMessage(0);
  };
  tick.port2.postMessage(0);
  let last = performance.now(), c0 = 0, raf = 0, f0 = 0;
  // A display gamma the program set (fxMesa's, from Glide's SST_GAMMA): an SVG gamma filter on the
  // canvas, the picture's channels raised to 1/gamma as the Voodoo's DAC table did.
  let gammaShown = 1;
  const showGamma = (g) => {
    if (g === gammaShown) return;
    gammaShown = g;
    let f = document.getElementById('mirage-gamma');
    if (!f) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
      svg.innerHTML = '<filter id="mirage-gamma" color-interpolation-filters="sRGB"><feComponentTransfer>' +
        '<feFuncR type="gamma"/><feFuncG type="gamma"/><feFuncB type="gamma"/></feComponentTransfer></filter>';
      document.body.appendChild(svg); f = svg.querySelector('filter');
    }
    for (const fn of f.querySelectorAll('feFuncR, feFuncG, feFuncB')) fn.setAttribute('exponent', String(1 / g));
    canvas.style.filter = g === 1 ? '' : 'url(#mirage-gamma)';
  };
  let deskVersion = -1;
  const draw = () => {
    if (stopped) return;
    const d0 = performance.now();
    const glFrame = hle && hle.frame(), cr = glFrame && w32wm && w32wm.clientRect();
    if (w32in && locked() && !w32in.captures()) document.exitPointerLock();   // the program let the mouse go
    if (cr) {                                                            // a framed Windows window: the screen, WebGL's picture in its client area
      // The desktop converted again only when the window manager changed it (or the canvas is not its size).
      const v = w32wm.version ? w32wm.version() : -1;
      if (v < 0 || v !== deskVersion || canvas.width !== cr.screen.w || canvas.height !== cr.screen.h) { video.render(); deskVersion = v; }
      canvas.getContext('2d').drawImage(glFrame, cr.x, cr.y, cr.w, cr.h);
    } else if (glFrame) {                                                // an SDL OpenGL window: PRISM's picture
      if (hle.gamma) showGamma(hle.gamma());
      if (canvas.width !== glFrame.width || canvas.height !== glFrame.height) { canvas.width = glFrame.width; canvas.height = glFrame.height; }
      canvas.getContext('2d').drawImage(glFrame, 0, 0);
    } else video.render();
    audio.pump();
    const now = performance.now();
    busy += now - d0;
    if (now - last > 1000 && !lx.done && !fault) {
      const sec = (now - last) / 1000, f = programFrames(), fps = (f - f0) / sec, share = busy / (now - last);
      const shown = f > 0 ? `${Math.round(fps)} fps · max ≈ ${share > 0.95 ? Math.round(fps) : Math.round(fps / Math.max(share, 0.01))} · ` : '';
      onStatus(paused ? 'paused' : `${shown}${((mc.cpu.cycles - c0) / (now - last) / 1000).toFixed(1)} M instructions/s`);
      last = now; c0 = mc.cpu.cycles; f0 = f; busy = 0;
    }
    raf = requestAnimationFrame(draw);
  };
  draw();
  return {
    mc, lx, audio, hle, resumed,
    /** This moment as bytes to keep (src/snapshot.js packSnapshot), `meta` with it. */
    async keep(meta = {}) {
      if (win32 || hle) throw new Error('a Windows program or HLE libraries cannot be kept yet');
      return snap.packSnapshot(snap.saveMachine(mc), { ...meta, kept: Date.now(), cycles: mc.cpu.cycles });
    },
    w32: w32in ? { input: w32in, wm: w32wm } : null,                   // a Windows program's input, for tests that drive the page
    /** A Windows program's icon once it has ended, for the desktop the page shows then (src/machines.js). */
    programIcon: () => (w32wm && w32loaded ? w32wm.icon(w32loaded.x) : null),
    pause(on) { paused = on; },
    stop() {
      stopped = true; cancelAnimationFrame(raf); canvas.style.filter = ''; keyboard.detach(window); window.removeEventListener('mouseup', onUp); window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake); audio.close();
      mc.rec.reset();                                                    // its compiled blocks go now: alive, they slowed the next machine's
    },
  };
}
