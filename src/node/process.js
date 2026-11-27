// process.js — the HLE node's process, its event loop and its console: process (argv, env, exit, the
// standard streams), timers, immediates and nextTick, the loop that waits in the kernel (poll, nanosleep)
// for what it watches, and the guest's own clock and randomness behind Date, performance and
// Math.random. A part of the HLE node (src/node/kernel.js).
export function process(N) {
  const { scope, alloc, sys, str, u32, view, bridge } = N;
  const G = N.global;
  const VERSION = 'v26.13.1';

  // ---- the guest's clock and randomness, in place of the host's ----------------------------------
  const RealDate = G.Date;
  const realNow = () => Math.floor(N.clock(0));
  const DateShim = function Date(...a) {
    if (!new.target) return new RealDate(realNow()).toString();
    return Reflect.construct(RealDate, a.length ? a : [realNow()], new.target);
  };
  Object.defineProperties(DateShim, { prototype: { value: RealDate.prototype }, length: { value: 7 } });
  DateShim.now = realNow; DateShim.parse = RealDate.parse; DateShim.UTC = RealDate.UTC;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: DateShim, writable: true, configurable: true });
  G.Date = DateShim;
  // Math.random: xorshift128+, seeded from the kernel's getrandom (seeded itself in a reproducible run).
  const seed = N.randomBytes(16), sv = new DataView(seed.buffer);
  let s0 = sv.getBigUint64(0, true) | 1n, s1 = sv.getBigUint64(8, true);
  Math.random = function random() {
    let x = s0; const y = s1; s0 = y;
    x ^= (x << 23n) & 0xffffffffffffffffn; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x;
    return Number(((s0 + s1) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
  };
  const mono = () => N.clock(1);
  const t0 = mono(), origin = realNow();
  const performance = { now: () => mono() - t0, timeOrigin: origin, mark() {}, measure() {}, getEntries: () => [], getEntriesByName: () => [], getEntriesByType: () => [], clearMarks() {}, clearMeasures() {}, toJSON() { return { timeOrigin: origin }; }, eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }), timerify: (f) => f };
  Object.defineProperty(performance, Symbol.toStringTag, { value: 'Performance' });
  N.performance = performance;

  // ---- nextTick, immediates, timers ---------------------------------------------------------------
  const ticks = [];
  const nextTick = (fn, ...args) => { if (typeof fn !== 'function') throw N.invalidArg('callback', 'of type function', fn); ticks.push([fn, args]); };
  N.nextTick = nextTick;
  const invoke = (fn, self, args) => { try { fn.apply(self, args); } catch (e) { uncaught(e); } };
  const runTicks = () => { while (ticks.length) { const [fn, args] = ticks.shift(); invoke(fn, undefined, args); } };
  const hostTick = () => new Promise((resolve) => bridge.tick(resolve));
  /** Every nextTick and every microtask, until neither is left (as Node runs them after a callback). */
  const settle = async () => { do { runTicks(); await hostTick(); } while (ticks.length); };

  let timerSeq = 0;
  const timers = new Set();
  class Timeout {
    constructor(fn, ms, args, repeat) {
      ms = Number(ms); if (!(ms >= 1 && ms <= 2147483647)) ms = 1;
      Object.assign(this, { _idleTimeout: ms, _onTimeout: fn, _timerArgs: args, _repeat: repeat ? ms : null, _destroyed: false });
      Object.defineProperty(this, '_id', { value: ++timerSeq, writable: true });
      Object.defineProperty(this, '_ref', { value: true, writable: true });
      Object.defineProperty(this, '_at', { value: mono() + ms, writable: true });
      timers.add(this);
    }
    ref() { this._ref = true; return this; }
    unref() { this._ref = false; return this; }
    hasRef() { return this._ref; }
    refresh() { this._at = mono() + this._idleTimeout; if (!this._destroyed) timers.add(this); return this; }
    close() { clearTimeout(this); return this; }
    [Symbol.toPrimitive]() { return this._id; }
    [Symbol.dispose]() { clearTimeout(this); }
  }
  const byId = (t) => (typeof t === 'object' && t !== null ? t : [...timers].find((x) => x._id === Number(t)));
  const setTimeout = (fn, ms, ...args) => { if (typeof fn !== 'function') throw N.invalidArg('callback', 'of type function', fn); return new Timeout(fn, ms, args, false); };
  const setInterval = (fn, ms, ...args) => { if (typeof fn !== 'function') throw N.invalidArg('callback', 'of type function', fn); return new Timeout(fn, ms, args, true); };
  const clearTimeout = (t) => { const x = t == null ? null : byId(t); if (x instanceof Timeout) { x._destroyed = true; timers.delete(x); } else if (x && x._immediate) clearImmediate(x); };
  const immediates = [];
  class Immediate {
    constructor(fn, args) { this._onImmediate = fn; this._argv = args; this._destroyed = false; Object.defineProperty(this, '_ref', { value: true, writable: true }); Object.defineProperty(this, '_immediate', { value: true }); }
    ref() { this._ref = true; return this; } unref() { this._ref = false; return this; } hasRef() { return this._ref; }
    [Symbol.dispose]() { clearImmediate(this); }
  }
  const setImmediate = (fn, ...args) => { if (typeof fn !== 'function') throw N.invalidArg('callback', 'of type function', fn); const i = new Immediate(fn, args); immediates.push(i); return i; };
  const clearImmediate = (i) => { if (i && i._immediate) { i._destroyed = true; const k = immediates.indexOf(i); if (k >= 0) immediates.splice(k, 1); } };
  const queueMicrotask = (fn) => { if (typeof fn !== 'function') throw N.invalidArg('callback', 'of type function', fn); Promise.resolve().then(() => { try { fn(); } catch (e) { uncaught(e); } }); };
  N.timers = { setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout, setImmediate, clearImmediate, Timeout, Immediate };

  // ---- what the loop waits for in the kernel: descriptors, as poll(2) sees them ------------------
  // A watcher: { fd, ready(revents), ref }. Something else keeping the loop alive: N.refs (a count).
  const watchers = new Set();
  N.watch = (w) => { watchers.add(w); return () => watchers.delete(w); };
  N.refs = 0;
  const alive = () => immediates.some((i) => i._ref) || [...timers].some((t) => t._ref) || [...watchers].some((w) => w.ref !== false) || N.refs > 0 || ticks.length > 0;
  const nextDeadline = () => { let at = Infinity; for (const t of timers) if (t._ref || true) at = Math.min(at, t._at); return at; };
  // With children (src/node/child.js: N.kids, N.reap), the wait is MIRAGE's WAIT -- poll, which a child's
  // end interrupts -- and the children that ended are seen after it.
  N.kids = 0; N.reap = null;
  const wait = (ms) => {                                                   // poll the watched descriptors, ms at most (-1: no end)
    const list = [...watchers];
    if (!list.length && !N.kids) {
      if (ms > 0) scope(() => { const ts = alloc(8), d = view(), o = ts - N.BASE; d.setUint32(o, Math.floor(ms / 1000), true); d.setUint32(o + 4, Math.round((ms % 1000) * 1e6) % 1e9, true); sys(162, ts, 0); });
      return [];
    }
    return scope(() => {
      const pf = alloc(8 * list.length), d = view(), o = pf - N.BASE;
      list.forEach((w, i) => { d.setInt32(o + i * 8, w.fd, true); d.setInt16(o + i * 8 + 4, w.events || 1, true); d.setInt16(o + i * 8 + 6, 0, true); });
      const r = sys(N.kids ? 0x10001 : 168, pf, list.length, ms < 0 ? -1 : Math.ceil(ms));
      if (r <= 0) return [];
      const out = [];
      list.forEach((w, i) => { const rev = d.getInt16(o + i * 8 + 6, true); if (rev) out.push([w, rev]); });
      return out;
    });
  };
  const runTimers = async () => {
    const now = mono();
    const due = [...timers].filter((t) => t._at <= now).sort((a, b) => a._at - b._at || a._id - b._id);
    for (const t of due) {
      if (t._destroyed || !timers.has(t)) continue;
      if (t._repeat) t._at = Math.max(t._at + t._repeat, mono()); else { timers.delete(t); t._destroyed = true; }
      invoke(t._onTimeout, t, t._timerArgs);
      await settle();
    }
  };
  const runImmediates = async () => {
    const batch = immediates.splice(0, immediates.length);
    for (const i of batch) { if (i._destroyed) continue; i._destroyed = true; invoke(i._onImmediate, i, i._argv); await settle(); }
  };
  /** The loop: timers, what the kernel says is ready, immediates -- until nothing keeps it alive. */
  N.loop = async () => {
    await settle();
    for (;;) {
      await runTimers();
      if (!alive()) {
        proc.emit('beforeExit', proc.exitCode ?? 0); await settle();
        if (!alive()) break;
      }
      const deadline = nextDeadline();
      const ms = immediates.length || ticks.length ? 0 : deadline === Infinity ? -1 : Math.max(0, deadline - mono());
      for (const [w, rev] of wait(ms)) { if (watchers.has(w)) { try { w.ready(rev); } catch (e) { uncaught(e); } await settle(); } }
      if (N.kids && N.reap) { N.reap(); await settle(); }
      await runImmediates();
    }
    const unsettled = N.unsettled && N.unsettled();                      // a main module's top-level await that never settled
    if (unsettled) { stderrWrite(unsettled); exit(13); }
    exit(proc.exitCode ?? 0);
  };

  // ---- errors nobody caught --------------------------------------------------------------------
  let dying = false;
  const uncaught = (e, fromPromise) => {
    if (dying) return;
    if (proc.listenerCount('uncaughtException') > 0) {
      try { proc.emit('uncaughtException', e, fromPromise ? 'unhandledRejection' : 'uncaughtException'); return; } catch (e2) { e = e2; dying = true; report(e2); exit(7); }
    }
    dying = true;
    report(e, fromPromise);
    exit(1);
  };
  N.uncaught = uncaught;
  const report = (e, fromPromise) => {
    let text = '';
    const where = e instanceof Error ? N.throwSite(e) : null;
    if (where) text += where + '\n';
    if (fromPromise && !(e instanceof Error)) {
      const r = N.inspect(e);
      text += `[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${r}".] {\n  code: 'ERR_UNHANDLED_REJECTION'\n}\n`;
    } else if (e instanceof Error) text += N.inspect(e) + '\n';
    else text += `Uncaught ${N.inspect(e)}\n`;
    text += `\nNode.js ${VERSION}\n`;
    stderrWrite(text);
  };
  bridge.onRejection((reason) => {
    if (proc.listenerCount('unhandledRejection') > 0) { try { proc.emit('unhandledRejection', reason); } catch (e) { uncaught(e); } return; }
    uncaught(reason, true);
  });

  // ---- the process --------------------------------------------------------------------------------
  const write = (fd, s) => { const b = typeof s === 'string' ? N.utf8Encode(s) : s; let at = 0; while (at < b.length) { const n = N.fsio.writeSync(fd, b, at, b.length - at, null); if (n <= 0) break; at += n; } };
  const stderrWrite = (s) => { try { write(2, s); } catch { /* nowhere to say it */ } };
  const exit = (code) => {
    code = code === undefined ? (proc.exitCode ?? 0) : code;
    if (!proc._exiting) { proc._exiting = true; proc.exitCode = code; try { proc.emit('exit', code); } catch (e) { stderrWrite(String(e && e.stack || e) + '\n'); } code = proc.exitCode ?? code; }
    bridge.exit(Number(code) & 0xff);
  };
  const isatty = (fd) => scope(() => sys(54, fd, 0x5401, alloc(64)) >= 0);   // TCGETS
  const winsize = (fd) => scope(() => { const ws = alloc(8); if (sys(54, fd, 0x5413, ws) < 0) return null; const d = view(), o = ws - N.BASE; return [d.getUint16(o + 2, true), d.getUint16(o, true)]; });

  const proc = new N.EventEmitter();
  Object.defineProperty(proc, Symbol.toStringTag, { value: 'process', configurable: true });
  const env = {};
  for (const e of bridge.envp) { const i = e.indexOf('='); if (i > 0 && !(e.slice(0, i) in env)) env[e.slice(0, i)] = e.slice(i + 1); }
  proc.env = new Proxy(env, {
    set(t, k, v) { t[k] = String(v); return true; },
    defineProperty(t, k, d) { t[k] = String(d.value); return true; },
  });
  proc.argv = [];                                                          // the main module sets them
  proc.argv0 = 'node';
  proc.execArgv = [];
  proc.execPath = bridge.exe || '/usr/bin/node';
  proc.title = 'node';
  proc.version = VERSION;
  proc.versions = { node: VERSION.slice(1), acorn: '8.15.0', ada: '3.2.4', ares: '1.34.5', brotli: '1.1.0', modules: '141', napi: '10', uv: '1.51.0', v8: '14.1.146.11-node.14', zlib: '1.3.1', mirage: 'hle' };
  proc.arch = 'ia32';
  proc.platform = 'linux';
  proc.release = { name: 'node', lts: undefined };
  proc.config = { variables: {} };
  proc.features = { inspector: false, debug: false, uv: true, ipv6: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false, cached_builtins: true, require_module: true, typescript: false };
  proc.pid = sys(20); proc.ppid = sys(64);
  proc.exitCode = undefined;
  proc.cwd = () => scope(() => { const va = alloc(4096), r = sys(183, va, 4096); if (r < 0) throw N.uvError(r, 'uv_cwd'); return N.cstr(va); });
  proc.chdir = (d) => { N.checkString(d, 'directory'); scope(() => { const r = sys(12, str(d)); if (r < 0) { const e = N.uvError(r, 'chdir', proc.cwd(), d); e.message = `${e.code}: ${N.ERRORS[-r][1]}, chdir ${proc.cwd()} -> '${d}'`; throw e; } }); };
  proc.exit = (code) => { if (code !== undefined) proc.exitCode = code; exit(code); };
  proc.reallyExit = (code) => bridge.exit(code & 0xff);
  proc.abort = () => { sys(37, proc.pid, 6); bridge.exit(134); };
  proc.kill = (pid, sig = 'SIGTERM') => { const n = typeof sig === 'number' ? sig : N.signals[sig]; if (n === undefined) throw N.nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${sig}`); const r = sys(37, pid, n); if (r < 0) throw N.uvError(r, 'kill'); return true; };
  proc.umask = (m) => { if (m === undefined) { const o = sys(60, 0o22); sys(60, o); return o; } return sys(60, typeof m === 'string' ? parseInt(m, 8) : m); };
  proc.getuid = () => sys(199); proc.getgid = () => sys(200); proc.geteuid = () => sys(201); proc.getegid = () => sys(202);
  proc.getgroups = () => scope(() => { const va = alloc(256), n = sys(205, 64, va); const out = []; for (let i = 0; i < n; i++) out.push(u32(va + i * 4)); return out; });
  proc.uptime = () => (mono() - t0) / 1000;
  proc.hrtime = (prev) => { const ns = N.clockNs(1); let s = Number(ns / 1000000000n), n = Number(ns % 1000000000n); if (prev) { s -= prev[0]; n -= prev[1]; if (n < 0) { s--; n += 1e9; } } return [s, n]; };
  proc.hrtime.bigint = () => N.clockNs(1);
  proc.memoryUsage = () => ({ rss: 50e6, heapTotal: 20e6, heapUsed: 10e6, external: 1e6, arrayBuffers: 1e5 });
  proc.memoryUsage.rss = () => 50e6;
  proc.resourceUsage = () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 50000 });
  proc.cpuUsage = () => ({ user: Math.round((mono() - t0) * 1000), system: 0 });
  proc.nextTick = nextTick;
  proc.emitWarning = (w, type = 'Warning', code) => {
    if (typeof type === 'object' && type) { code = type.code; type = type.type || 'Warning'; }
    const msg = w instanceof Error ? w.message : String(w), name = w instanceof Error ? w.name : type;
    if (env.NODE_NO_WARNINGS === '1' || proc.noDeprecation && name === 'DeprecationWarning') return;
    nextTick(() => { proc.emit('warning', w instanceof Error ? w : Object.assign(new Error(msg), { name })); stderrWrite(`(node:${proc.pid}) ${code ? `[${code}] ` : ''}${name}: ${msg}\n${proc._warned ? '' : '(Use `node --trace-warnings ...` to show where the warning was created)\n'}`); proc._warned = true; });
  };
  proc.binding = () => { throw new Error('No such module'); };
  proc.setUncaughtExceptionCaptureCallback = () => {}; proc.hasUncaughtExceptionCaptureCallback = () => false;
  proc.report = { getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }) };
  proc.allowedNodeEnvironmentFlags = new Set();
  proc.constrainedMemory = () => 0; proc.availableMemory = () => 1 << 30;
  proc.getActiveResourcesInfo = () => [...[...timers].map(() => 'Timeout'), ...immediates.map(() => 'Immediate')];
  proc.loadEnvFile = () => { throw N.nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'process.loadEnvFile is not available in MIRAGE yet'); };

  // stdout and stderr: written at once, in order (a write(2) each), as Node writes to files and pipes.
  const output = (fd) => {
    const W = N.stream.Writable;
    const s = new W({ decodeStrings: false, write(chunk, enc, cb) { try { write(fd, typeof chunk === 'string' ? N.Buffer.from(chunk, enc) : chunk); cb(); } catch (e) { cb(e); } } });
    s.write = function (chunk, enc, cb) {
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw N.invalidArg('chunk', 'of type string or an instance of Buffer, TypedArray, or DataView', chunk);
      try { write(fd, typeof chunk === 'string' ? N.Buffer.from(chunk, enc || 'utf8') : chunk); if (cb) nextTick(cb, null); }
      catch (e) { if (e.code === 'EPIPE' || e.code === 'EAGAIN') { if (cb) nextTick(cb, e); nextTick(() => s.emit('error', e)); } else throw e; }
      return true;
    };
    s.end = function (chunk, enc, cb) { if (typeof chunk === 'function') { cb = chunk; chunk = undefined; } if (chunk !== undefined && chunk !== null) s.write(chunk, enc); if (cb) nextTick(cb); return s; };
    s.destroy = function () { return s; };
    s.fd = fd; s._type = isatty(fd) ? 'tty' : 'fs'; s.isTTY = s._type === 'tty' ? true : undefined;
    if (s.isTTY) {
      const ws = winsize(fd) || [80, 24]; s.columns = ws[0]; s.rows = ws[1];
      s.getWindowSize = () => [s.columns, s.rows]; s.hasColors = () => false; s.getColorDepth = () => 1;
      s.cursorTo = (x, y, cb) => { s.write(y === undefined || typeof y === 'function' ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`); if (typeof (cb || y) === 'function') (cb || y)(); return true; };
      s.moveCursor = (dx, dy) => { let o = ''; if (dx) o += dx > 0 ? `\x1b[${dx}C` : `\x1b[${-dx}D`; if (dy) o += dy > 0 ? `\x1b[${dy}B` : `\x1b[${-dy}A`; if (o) s.write(o); return true; };
      s.clearLine = (dir = 0) => { s.write(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K'); return true; };
      s.clearScreenDown = () => { s.write('\x1b[0J'); return true; };
    }
    return s;
  };
  let stdout, stderr, stdin;
  Object.defineProperty(proc, 'stdout', { get: () => (stdout ||= output(1)), configurable: true, enumerable: true });
  Object.defineProperty(proc, 'stderr', { get: () => (stderr ||= output(2)), configurable: true, enumerable: true });
  // stdin: read when asked for (flowing, read()), each chunk a read(2) of what the kernel has.
  Object.defineProperty(proc, 'stdin', {
    configurable: true, enumerable: true,
    get: () => {
      if (stdin) return stdin;
      let stop = null;
      stdin = new N.stream.Readable({
        highWaterMark: 65536,
        read() {
          if (stop) return;
          stop = N.watch({ fd: 0, events: 1, ready: () => {
            stop(); stop = null;
            const b = N.Buffer.allocUnsafe(65536);
            let n;
            try { n = N.fsio.readSync(0, b, 0, 65536, null); } catch (e) { if (e.code === 'EAGAIN') { stdin._read(); return; } stdin.destroy(e); return; }
            stdin.push(n ? b.subarray(0, n) : null);
          } });
        },
        destroy(err, cb) { if (stop) { stop(); stop = null; } cb(err); },
      });
      stdin._autoDestroy = false;
      stdin.fd = 0;
      stdin.isTTY = isatty(0) ? true : undefined;
      const pause = stdin.pause.bind(stdin);
      stdin.pause = () => { pause(); if (stop) { stop(); stop = null; } return stdin; };
      stdin.setRawMode = (raw) => {
        scope(() => {
          const t = alloc(60); if (sys(54, 0, 0x5401, t) < 0) return;
          const d = view(), o = t - N.BASE; let lflag = d.getUint32(o + 12, true);
          lflag = raw ? lflag & ~(0x2 | 0x8 | 0x1) : lflag | 0x2 | 0x8 | 0x1;      // ICANON ECHO ISIG
          d.setUint32(o + 12, lflag, true); sys(54, 0, 0x5402, t);              // TCSETS
        });
        stdin.isRaw = !!raw; return stdin;
      };
      stdin.isRaw = false;
      stdin.ref = () => stdin; stdin.unref = () => stdin;
      return stdin;
    },
  });
  proc.openStdin = () => { proc.stdin.resume(); return proc.stdin; };
  proc.channel = undefined; proc.connected = false;
  proc.mainModule = undefined;
  N.process = proc;
  N.exit = exit;
  N.write = write;

  // Node ignores SIGPIPE (libuv does): a write to a pipe nobody reads answers EPIPE.
  scope(() => { const act = alloc(20), d = view(), o = act - N.BASE; for (let i = 0; i < 20; i += 4) d.setUint32(o + i, 0, true); d.setUint32(o, 1, true); sys(174, 13, act, 0, 8); });

  N.signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16,
    SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31 };

  // ---- the console -------------------------------------------------------------------------------
  const makeConsole = (out, err, opts = {}) => {
    let indent = '';
    const counts = new Map(), times = new Map();
    const say = (stream, text) => { const s = indent ? text.split('\n').map((l) => indent + l).join('\n') : text; (typeof stream === 'function' ? stream() : stream).write(s + '\n'); };
    const fmt = (args) => N.formatWithOptions(opts.inspectOptions || {}, ...args);
    const o = () => out, e = () => err;
    const formatTime = (ms) => {
      let hours = 0, minutes = 0, seconds = 0;
      if (ms >= 1000) { if (ms >= 60000) { if (ms >= 3600000) { hours = Math.floor(ms / 3600000); ms %= 3600000; } minutes = Math.floor(ms / 60000); ms %= 60000; } seconds = ms / 1000; }
      if (hours !== 0 || minutes !== 0) { const [s, m] = seconds.toFixed(3).split('.'); const res = hours !== 0 ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes; return `${res}:${s.padStart(2, '0')}.${m} (${hours !== 0 ? 'h:m' : ''}m:ss.mmm)`; }
      if (seconds !== 0) return `${seconds.toFixed(3)}s`;
      return `${Number(ms.toFixed(3))}ms`;
    };
    const c = {
      log: (...a) => say(o(), fmt(a)), info: (...a) => say(o(), fmt(a)), debug: (...a) => say(o(), fmt(a)),
      error: (...a) => say(e(), fmt(a)), warn: (...a) => say(e(), fmt(a)),
      dir: (v, options) => say(o(), N.inspect(v, { customInspect: false, ...(opts.inspectOptions || {}), ...options })),
      dirxml: (...a) => say(o(), fmt(a)),
      trace: (...a) => { const t = new Error(fmt(a)); t.name = 'Trace'; say(e(), String(t.stack).split('\n').filter((l, i) => i === 0 || !/node:internal|mirage-node/.test(l)).join('\n')); },
      assert: (cond, ...a) => { if (!cond) { if (a.length && typeof a[0] === 'string') a[0] = `Assertion failed: ${a[0]}`; else a.unshift('Assertion failed'); say(e(), fmt(a)); } },
      count: (label = 'default') => { label = `${label}`; const n = (counts.get(label) || 0) + 1; counts.set(label, n); say(o(), `${label}: ${n}`); },
      countReset: (label = 'default') => { if (!counts.has(`${label}`)) { proc.emitWarning(`Count for '${label}' does not exist`); return; } counts.delete(`${label}`); },
      time: (label = 'default') => { label = `${label}`; if (times.has(label)) { proc.emitWarning(`Label '${label}' already exists for console.time()`); return; } times.set(label, performance.now()); },
      timeEnd: (label = 'default') => { label = `${label}`; if (!times.has(label)) { proc.emitWarning(`No such label '${label}' for console.timeEnd()`); return; } say(o(), `${label}: ${formatTime(performance.now() - times.get(label))}`); times.delete(label); },
      timeLog: (label = 'default', ...a) => { label = `${label}`; if (!times.has(label)) { proc.emitWarning(`No such label '${label}' for console.timeLog()`); return; } say(o(), `${label}: ${formatTime(performance.now() - times.get(label))}${a.length ? ' ' + fmt(a) : ''}`); },
      group: (...a) => { if (a.length) say(o(), fmt(a)); indent += '  '; },
      groupEnd: () => { indent = indent.slice(0, -2); },
      table: (data, props) => { if (data === null || typeof data !== 'object') return c.log(data); say(o(), N.table(data, props)); },
      clear: () => {}, profile: () => {}, profileEnd: () => {}, timeStamp: () => {}, context: () => c,
    };
    c.groupCollapsed = c.group;
    return c;
  };
  const console = makeConsole(() => proc.stdout, () => proc.stderr);
  console.Console = function Console(out, err, ignoreErrors) {
    if (out && typeof out.write !== 'function' && out.stdout) { const o = out; return makeConsole(o.stdout, o.stderr || o.stdout, o); }
    return makeConsole(out, err || out);
  };
  N.console = console;

  // console.table, as Node draws it (lib/internal/cli_table.js).
  N.table = (data, props) => {
    const keyKey = Array.isArray(data) || data instanceof Map ? '(index)' : '(index)';
    const rows = [], cols = [], hasPrim = { v: false };
    const fmtCell = (v) => (typeof v === 'string' ? N.inspect(v) : N.inspect(v, { depth: 1, breakLength: Infinity, compact: true }));
    const entries = data instanceof Map ? [...data].map(([k, v], i) => [i, v, k]) : data instanceof Set ? [...data].map((v, i) => [i, v]) : Object.entries(data);
    const iterHeader = data instanceof Map ? '(iteration index)' : data instanceof Set ? '(iteration index)' : keyKey;
    for (const [k, v, mapKey] of entries) {
      const row = { [iterHeader]: String(k) };
      if (data instanceof Map) row.Key = fmtCell(mapKey);
      if (v !== null && typeof v === 'object') {
        for (const c of props || Object.keys(v)) { if (!cols.includes(c)) cols.push(c); if (c in v) row[c] = fmtCell(v[c]); }
      } else { hasPrim.v = true; row.Values = fmtCell(v); }
      rows.push(row);
    }
    const header = [iterHeader, ...(data instanceof Map ? ['Key'] : []), ...cols, ...(hasPrim.v ? ['Values'] : [])];
    const width = header.map((h) => Math.max(h.length, ...rows.map((r) => (r[h] ?? '').length)) + 2);
    const center = (s, w) => ' ' + s + ' '.repeat(w - s.length - 1);   // left-aligned, as Node 23 and later draw it
    const line = (l, m, r) => l + width.map((w) => '─'.repeat(w)).join(m) + r;
    const out = [line('┌', '┬', '┐'), '│' + header.map((h, i) => center(h, width[i])).join('│') + '│', line('├', '┼', '┤')];
    for (const r of rows) out.push('│' + header.map((h, i) => center(r[h] ?? '', width[i])).join('│') + '│');
    out.push(line('└', '┴', '┘'));
    return out.join('\n');
  };

  // ---- the globals a Node program finds -----------------------------------------------------------
  Object.assign(G, { process: proc, console, setTimeout, setInterval, clearTimeout, clearInterval: clearTimeout, setImmediate, clearImmediate, queueMicrotask, performance });
  G.global = G;
}
