// ui.js — the Mirage application controller. Owns the machine, the render loop,
// timer pacing, and the bridge between the JS shell and guest execution. DOM
// wiring (drag-drop, URL params, HUD) lives in main.js; this stays focused on
// orchestration so it could also be driven headlessly.

import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installDOS, DOS_PLAYER_MEM } from './dos.js';
import { VFS } from './vfs.js';
import { unzip, deice } from './zip.js';
import { Video } from './video.js';
import { Keyboard } from './keyboard.js';
import { installMouse } from './mouse.js';
import { Shell } from './shell.js';
import { SAMPLES } from './samples.js';

const TICK_MS = 1000 / 18.2065;     // PC timer period
// Real host CPU time the run loop may spend per animation frame. This used to be a flat 12 ms,
// which was tuned when the loop ALSO had a virtual-cycle budget that normally made it exit long
// before that — measured on tube, it used 2.4 ms of each 16.7 ms frame, leaving ~14 ms for the
// canvas draw and the browser's own compositing.
//
// Uncapped, the loop spends its whole allowance every frame (12.8 ms measured), leaving under 4 ms.
// Miss the vsync deadline and rAF halves to 30 Hz, so the intro is DISPLAYED half as often even
// though the guest is doing 10x the work — which is exactly how "it doesn't look as fast as before"
// gets produced by making something faster. So the budget adapts: back off when frames are actually
// being dropped, creep back up when they are not.
const FRAME_BUDGET_MAX = 12, FRAME_BUDGET_MIN = 4;
const FRAME_DROP_MS = 20;           // a frame gap this long means we missed a display refresh
// Emulated CPU speed: guest cycles (~retired instructions) per second of wall-clock, or null to run
// as fast as the host manages. NULL IS THE DEFAULT — the engine sustains ~220 M cycles/s, and the
// 8 MHz cap this used to impose was a ~27x slowdown applied to everything, which is what made
// raw-speed-bound intros (tube, memories) crawl.
//
// The cap existed to stop code paced by neither the timer nor the retrace — the Commander Keen
// Vorticons menus and story scroll — from flying past. Note that DOSBox does NOT run these titles
// flat out: its default cycles=auto means 3000 cycles/ms in real mode (max only in protected mode),
// so Keen is playable on archive.org precisely BECAUSE it is throttled to ~3 M instr/s, and this
// default is ~24x that. See docs/notes/compat-log.md for the measured table (demos/cpuspeed.asm) — period
// games will want ?mhz=3, and the knob stays reachable for them (or new Mirage(c, {vcpuHz})).
// The 0x3DA retrace is anchored to wall-clock in bios.js, so vsync-paced code still sees a true
// 70 Hz with no cap in place.
const VCPU_HZ = null;

export class Mirage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.machine = new Machine(opts.memSize ? { memSize: opts.memSize } : DOS_PLAYER_MEM);
    this.machine.timerAuto = false;   // browser paces the PIT to wall-clock (18.2 Hz) in _loop() below
    this.machine.vcpuHz = opts.vcpuHz ?? VCPU_HZ;   // emulated CPU speed cap; null = unthrottled
    this.machine.wallClockMs = () => performance.now();   // anchors the 0x3DA beam to real 70 Hz
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
    this._lastLoop = 0;
    this._frameBudget = FRAME_BUDGET_MAX;   // adapts to what the browser can actually display
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
    // run them. A games manifest entry keeps its subdir (e.g. "ALLEYCAT/CAT.EXE") so each game's
    // files land together. That layout is the SHELL's catalogue view, not the guest's: launching a
    // program narrows C:\ to the program's own directory for as long as it runs, so a title sees
    // the drive it shipped expecting — see VFS.mountAt() and Shell.launch(). Skipped when unserved.
    for (const [dir, prefix] of [['demos', '\\'], ['intros', '\\INTROS\\']]) {
      try {
        const manifest = await (await fetch(dir + '/manifest.json')).json();
        for (const f of manifest) this.vfs.addFile(prefix + f, new Uint8Array(await (await fetch(dir + '/' + f)).arrayBuffer()));
      } catch { /* not served — skip */ }
    }
    await this._indexGames();
    this.shell = new Shell(this.machine);
    // Mount a title the first time a command mentions it (or while standing in its directory).
    this.shell.beforeCommand = (line) => {
      const title = this._gameFor(line);
      return title ? this.ensureGame(title) : null;
    };
    this.shell.boot();
    this.keyboard.attach(window);
    this._attachMouse();
    this._lastTick = this._lastLoop = performance.now();
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
  // ---- games: indexed at boot, fetched on demand ----------------------------
  // demos/ and intros/ are a few hundred KB and are mounted eagerly. games/ is not: 2081 files and
  // 147 MB at the time of writing, growing with every title staged, and it was all downloaded
  // SEQUENTIALLY before the boot indicator came down. Only the manifest is read now — enough to
  // create C:\GAMES\<TITLE> so DIR lists what is available — and a title's files arrive the first
  // time a command touches it. Nothing else changes: by the time a command runs, its files are in.

  async _indexGames() {
    this._games = new Map();                      // TITLE -> { files, loaded, pending }
    let manifest;
    try { manifest = await (await fetch('games/manifest.json')).json(); }
    catch { return; }                             // not served — skip, as before
    for (const f of manifest) {
      const title = String(f).split('/')[0].toUpperCase();
      if (!title || title === String(f).toUpperCase()) continue;   // loose file, not a game dir
      if (!this._games.has(title)) this._games.set(title, { files: [], loaded: false, pending: null });
      this._games.get(title).files.push(f);
    }
    this._mkdirp('\\GAMES');
    for (const title of this._games.keys()) this._mkdirp('\\GAMES\\' + title);
  }

  _mkdirp(path) {
    let cur = '';
    for (const seg of path.split('\\').filter(Boolean)) {
      cur += '\\' + seg;
      if (!this.vfs.exists(cur)) this.vfs.mkdir(cur);
    }
  }

  /** Fetch one title's files into the VFS, once. Null when there is nothing to wait for. */
  ensureGame(title) {
    const g = this._games && this._games.get(String(title).toUpperCase());
    if (!g || g.loaded) return null;
    if (!g.pending) {
      g.pending = Promise.all(g.files.map(async (f) => {
        try {
          const bytes = new Uint8Array(await (await fetch('games/' + f)).arrayBuffer());
          this.vfs.addFile('\\GAMES\\' + f.replace(/\//g, '\\'), bytes);
        } catch { /* one missing file is the title's problem, not the shell's */ }
      })).then(() => { g.loaded = true; });
    }
    return g.pending;
  }

  /** The title a command line refers to, directly or via the current directory. */
  _gameFor(line) {
    const m = (this.vfs.cwdString() + ' ' + line).toUpperCase().replace(/\//g, '\\').match(/GAMES\\([^\\ ]+)/);
    return m ? m[1] : null;
  }

  mountFile(name, bytes) { this.vfs.addFile('\\' + VFS.dosName(name), bytes); }
  /** Unpack a ZIP archive into C:\GAMES\<NAME>\, NAME from the archive's file name (8.3). A single
   *  top-level folder inside the archive is dropped, so the program sits at the root of what the
   *  shell narrows C:\ to when it runs. Returns NAME. */
  async mountZip(fileName, zipBytes) {
    const files = await deice(await unzip(zipBytes));   // id's shareware: the installer's pieces, joined
    const name = VFS.dosName(fileName.replace(/\.zip$/i, '')).replace(/\..*$/, '');
    const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
    const strip = tops.size === 1 && !tops.has('') ? [...tops][0].length + 1 : 0;
    this._mkdirp('\\GAMES\\' + name);
    for (const f of files) {
      const rel = f.path.slice(strip).split('/').filter(Boolean).map((seg) => VFS.dosName(seg)).join('\\');
      if (rel) this.vfs.addFile('\\GAMES\\' + name + '\\' + rel, f.bytes);
    }
    return name;
  }
  runCommand(line) {                                  // inject a command as if typed
    if (this.shell.state !== 'input') return;
    this.shell.print(line + '\r\n');
    this.shell.dispatch(line);        // may mount a game's files first (?run=GAMES\X\Y.EXE)
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
    // The ratio is against pitBase, NOT a hardcoded 0x10000: pitBase is the machine's speed and it
    // moved to 182584 when that was calibrated to the reference (docs/notes/timing.md §7). Dividing by the
    // old constant made an unreprogrammed guest tick 2.79x too SLOWLY in the browser — and no
    // headless gate can see it, because none of them run this loop.
    // The 3 ms floor is this path's own rate cap, ~333 Hz, independent of the headless pitBase>>4.
    const tickMs = Math.max(3, TICK_MS * (this.machine.pitReload / (this.machine.pitBase || 0x10000)));
    if (now - this._lastTick > 250) this._lastTick = now;   // drop a big backlog (e.g. after the tab was hidden)

    if (this.shell.state === 'running') {
      if (this._brk) { this._brk = false; this.dos.programDone = true; this.machine.cpu.halted = true; this.shell.print('^C'); }
      const t0 = performance.now();
      // Virtual CPU clock: run at most vcpuHz cycles of guest time per wall-clock second (the
      // budget for this frame is proportional to the real time elapsed since the last one, clamped
      // so a hidden/backlogged tab doesn't sprint to catch up). Raw-CPU-speed-bound code is thus
      // paced to a period-appropriate rate; timer-paced games are unaffected (their animation is
      // gated by the wall-clock INT 8 below). The host-time budget still caps real CPU time.
      const gap = now - this._lastLoop;         // how long since the last displayed frame
      let dt = gap; if (dt > 50 || dt < 0) dt = 50;
      this._lastLoop = now;
      // Yield host time back to the compositor when we are visibly costing it frames, and take it
      // back when we are not. Without this the loop starves rendering and the guest is displayed at
      // half rate — see FRAME_BUDGET_MAX.
      if (gap > FRAME_DROP_MS && gap < 200) this._frameBudget = Math.max(FRAME_BUDGET_MIN, this._frameBudget - 1);
      else if (gap > 0) this._frameBudget = Math.min(FRAME_BUDGET_MAX, this._frameBudget + 0.25);
      const cap = this.machine.vcpuHz;          // null (the default) = no virtual-clock throttle:
      const cycleBudget = cap                   // the frame is then bounded by FRAME_BUDGET_MS alone
        ? Math.max(1, (cap * dt / 1000) | 0) : Infinity;
      const cyc0 = this.machine.cpu.cycles;
      let w = t0;
      while (w - t0 < this._frameBudget) {
        // Deliver AT MOST ONE timer tick per iteration, so the runSlice below services its ISR
        // (runs it to IRET) before the next tick fires. Firing several INT 8 back-to-back would
        // pile un-serviced interrupt frames on the guest stack (realInt only pushes a frame; the
        // ISR runs later) — at a fast rate the CPU can't keep up and the stack underflows → hang.
        if (w - this._lastTick >= tickMs) { this.machine.tickTimer(); this._lastTick += tickMs; }
        this.machine.pumpKeyboard();                      // stage a queued hw scancode + fire IRQ1
        const slice = Math.min(20000, cycleBudget - (this.machine.cpu.cycles - cyc0));
        if (slice <= 0) break;                            // spent this frame's virtual-cycle budget
        // (unthrottled: cycleBudget is Infinity, so the loop runs until the host budget is up)
        this.machine.runSlice(slice);
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
