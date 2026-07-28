// ui.js — the Mirage application controller. Owns the machine, the render loop,
// timer pacing, and the bridge between the JS shell and guest execution. DOM
// wiring (drag-drop, URL params, HUD) lives in main.js; this stays focused on
// orchestration so it could also be driven headlessly.

import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installDOS } from './dos.js';
import { VFS } from './vfs.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { installMouse } from './mouse.js';
import { Shell } from './shell.js';
import { SAMPLES } from './samples.js';

const TICK_MS = 1000 / 18.2065;     // PC timer period
const FRAME_BUDGET_MS = 12;         // CPU time per animation frame

export class Mirage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.machine = new Machine({ memSize: opts.memSize || 16 * 1024 * 1024 });
    this.machine.timerAuto = false;   // browser paces the PIT to wall-clock (18.2 Hz) in _loop() below
    this.bios = installBIOS(this.machine);
    this.vfs = new VFS();
    this.dos = installDOS(this.machine, this.vfs);
    this.video = new Video(this.machine, canvas);
    this.keyboard = new Keyboard(this.machine);
    installMouse(this.machine);                     // INT 33h; fed by canvas events in boot()
    this.shell = null;
    this.onFrame = opts.onFrame || null;
    this._raf = 0;
    this._lastTick = 0;
    this._brk = false;

    this.machine.onError = (e) => this._onError(e);
    this.keyboard.onBreak = () => { if (this.shell && this.shell.state === 'running') this._brk = true; };
    this.bios.onModeChange = () => { /* video picks up the mode each frame */ };
  }

  async boot() {
    await this.video.loadFont(this.opts.fontUrl || 'assets/vga-rom-8x16.bin');
    for (const sample of SAMPLES) this.vfs.addFile('\\' + sample.name, sample.make());
    this.vfs.addFile('\\README.TXT', Uint8Array.from(
      [...'MIRAGE — a pure-JavaScript MS-DOS machine.\r\nTry: BARS, PLASMA, BANNER, HELLO, DIR.\r\n'].map(c => c.charCodeAt(0))));
    // Mount the bundles listed in each dir's manifest.json (if served): the committed nasm
    // demos at the root of C:, plus any local (gitignored) third-party intros under C:\INTROS
    // and multi-file games under C:\GAMES\<game>\ so you can `CD INTROS`/`CD GAMES\<game>` and
    // run them. A games manifest entry keeps its subdir (e.g. "ALLEYCAT/CAT.EXE") so each
    // game's files land together and its relative data-file opens resolve. Skipped when unserved.
    for (const [dir, prefix] of [['demos', '\\'], ['intros', '\\INTROS\\'], ['games', '\\GAMES\\']]) {
      try {
        const manifest = await (await fetch(dir + '/manifest.json')).json();
        for (const f of manifest) this.vfs.addFile(prefix + f, new Uint8Array(await (await fetch(dir + '/' + f)).arrayBuffer()));
      } catch { /* not served — skip */ }
    }
    this.shell = new Shell(this.machine);
    this.shell.boot();
    this.keyboard.attach(window);
    this._attachMouse();
    this._lastTick = performance.now();
    this._loop();
    return this;
  }

  // Feed browser mouse events into the INT 33h driver: relative motion (movementX/Y)
  // becomes mickeys — what camera demos like Mars poll each frame via AX=000B. In a
  // graphics mode a click grabs the pointer so motion keeps flowing past the window
  // edge (best-effort; a plain move over the canvas works too, and Esc releases it).
  _attachMouse() {
    const c = this.canvas, m = this.machine;
    const mapBtn = (b) => (b === 2 ? 1 : b === 1 ? 2 : 0);   // DOM L/M/R (0/1/2) -> driver bit L/R/M
    c.addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) m.mouseMoveRel(e.movementX | 0, e.movementY | 0); });
    c.addEventListener('mousedown', (e) => { m.mouseButton(mapBtn(e.button), true); if (m.mem.r8(0x449) === 0x13 && c.requestPointerLock) { try { c.requestPointerLock(); } catch { } } e.preventDefault(); });
    window.addEventListener('mouseup', (e) => m.mouseButton(mapBtn(e.button), false));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- public API used by main.js ----
  mountFile(name, bytes) { this.vfs.addFile('\\' + VFS.dosName(name), bytes); }
  runCommand(line) {                                  // inject a command as if typed
    if (this.shell.state !== 'input') return;
    this.shell.print(line + '\r\n');
    this.shell.submit(line);
  }
  setProfiling(on) { this.machine.rec.profiling = on; }
  stats() {
    const c = this.machine.cpu, r = this.machine.rec;
    return {
      mode: this.machine.mem.r8(0x449),
      running: this.shell && this.shell.state === 'running',
      blocked: this.machine.blocked,
      compiles: r.stats.compiles, exec: r.stats.exec,
      cs: c.seg[1], ip: c.eip & 0xffff,
      ax: c.ax, bx: c.bx, cx: c.cx, dx: c.dx, si: c.si, di: c.di, bp: c.bp, sp: c.sp,
      ds: c.seg[3], es: c.seg[0], ss: c.seg[2], flags: c.flags & 0xffff,
    };
  }

  // ---- main loop ----
  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();

    // The timer interrupt is paced at the guest's programmed PIT rate (default 18.2 Hz; games such
    // as Dune/Cosmo reprogram counter 0 to 200–1000 Hz — machine.pitReload tracks it, capped).
    const tickMs = Math.max(3, TICK_MS * (this.machine.pitReload / 0x10000));
    if (now - this._lastTick > 250) this._lastTick = now;   // drop a big backlog (e.g. after the tab was hidden)

    if (this.shell.state === 'running') {
      if (this._brk) { this._brk = false; this.dos.programDone = true; this.machine.cpu.halted = true; this.shell.print('^C'); }
      const t0 = performance.now();
      let w = t0;
      while (w - t0 < FRAME_BUDGET_MS) {
        // Deliver AT MOST ONE timer tick per iteration, so the runSlice below services its ISR
        // (runs it to IRET) before the next tick fires. Firing several INT 8 back-to-back would
        // pile un-serviced interrupt frames on the guest stack (realInt only pushes a frame; the
        // ISR runs later) — at a fast rate the CPU can't keep up and the stack underflows → hang.
        if (w - this._lastTick >= tickMs) { this.machine.tickTimer(); this._lastTick += tickMs; }
        this.machine.pumpKeyboard();                      // stage a queued hw scancode + fire IRQ1
        this.machine.runSlice(20000);
        if (this.machine.blocked) break;                 // waiting on input
        if (this.dos.programDone) { this.shell.state = 'input'; this.shell.programReturned(); break; }
        if (this.machine.cpu.halted) break;
        w = performance.now();
      }
    } else {
      // at the prompt: keep the BDA clock advancing (bounded — no guest ISR here), then pump the shell
      let ticks = 0;
      while (now - this._lastTick >= tickMs && ticks < 4) { this.machine.tickTimer(); this._lastTick += tickMs; ticks++; }
      this.shell.pump();
    }

    this.video.render();
    if (this.onFrame) this.onFrame(this);
  }

  _onError(e) {
    console.error(e);
    if (this.shell) { this.shell.print('\r\n[CPU fault] ' + (e.message || e) + '\r\n'); this.dos.programDone = true; this.shell.state = 'input'; this.shell.prompt(); }
    this.machine.cpu.halted = true;
  }

  stop() { cancelAnimationFrame(this._raf); this.keyboard.detach(window); }
}
