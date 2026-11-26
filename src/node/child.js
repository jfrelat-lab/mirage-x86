// child.js — child_process: spawn, exec, execFile and their Sync forms, a ChildProcess's events and pipes.
// A child is the kernel's to make (MIRAGE's SPAWN, src/node/host.js: fork, its descriptors, its directory,
// execve -- as posix_spawn, which is what libuv does); it is another MIRAGE-LINUX process, x86 or WASI or
// another HLE node. Its pipes are pipe(2)'s, watched by the loop; its end is seen by wait4 after the loop's
// WAIT, which a child's end interrupts (libuv learns it from SIGCHLD).
export function child(N) {
  const { sys, scope, alloc, str, view, uvError, nodeError, invalidArg } = N;
  const SPAWN = 0x10000;
  const proc = N.process, Buffer = N.Buffer, EventEmitter = N.EventEmitter;
  const SIGNAME = {}; for (const [k, v] of Object.entries(N.signals)) if (!(v in SIGNAME) && k !== 'SIGIOT') SIGNAME[v] = k;
  const sigNum = (sig) => {
    if (typeof sig === 'number') { if (sig === 0 || SIGNAME[sig]) return sig; throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${sig}`); }
    if (typeof sig === 'string' && N.signals[sig] !== undefined) return N.signals[sig];
    throw nodeError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${sig}`);
  };
  const close = (fd) => sys(6, fd);
  const errno = (r, syscall) => {                                       // libuv's ErrnoException: "spawn x ENOENT"
    const [code] = N.ERRORS[-r] || ['UNKNOWN'];
    const e = new Error(`${syscall} ${code}`); e.errno = r; e.code = code; e.syscall = syscall; return e;
  };

  // ---- the arguments, as Node normalizes them ------------------------------------------------------
  const normalize = (file, args, options) => {
    if (typeof file !== 'string') throw invalidArg('file', 'of type string', file);
    if (file.length === 0) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'file' cannot be empty. Received ''");
    if (Array.isArray(args)) args = args.slice();
    else if (args == null) args = [];
    else if (typeof args !== 'object') throw invalidArg('args', 'an instance of Array', args);
    else { options = args; args = []; }
    if (options === undefined) options = {};
    else if (options === null || typeof options !== 'object') throw invalidArg('options', 'of type object', options);
    options = { ...options };
    for (const a of args) if (typeof a !== 'string') throw invalidArg('args', 'an instance of Array', args);
    if (options.shell) {
      const command = [file, ...args].join(' ');
      file = typeof options.shell === 'string' ? options.shell : '/bin/sh';
      args = ['-c', command];
    }
    const argv0 = typeof options.argv0 === 'string' ? options.argv0 : file;
    const env = options.env || proc.env, envPairs = [];
    for (const k of Object.keys(env)) if (env[k] !== undefined) envPairs.push(`${k}=${env[k]}`);
    return { file, args: [argv0, ...args], cwd: options.cwd == null ? null : String(options.cwd instanceof URL ? N.fileURLToPath(options.cwd) : options.cwd), envPairs, env, options };
  };
  /** The file to exec: as given with a '/', else the first of PATH's that is a file (execvp). */
  const which = (file, env) => {
    if (file.includes('/')) return file;
    for (const dir of String(env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
      const p = (dir || '.') + '/' + file, s = N.fsio.statAt(p, 0, 'stat', { throwIfNoEntry: false });
      if (s && s.isFile()) return p;
    }
    return file;
  };
  /** Each of stdio's entries: ['pipe'], ['fd', n] or ['ignore'] -- Node's getValidStdio. */
  const stdioOf = (stdio) => {
    if (stdio == null) stdio = 'pipe';
    if (typeof stdio === 'string') {
      if (stdio === 'pipe' || stdio === 'overlapped' || stdio === 'ignore') stdio = [stdio, stdio, stdio];
      else if (stdio === 'inherit') stdio = [0, 1, 2];
      else throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'stdio' is invalid. Received '${stdio}'`);
    } else if (!Array.isArray(stdio)) throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'stdio' is invalid. Received ${N.inspect(stdio)}`);
    const out = [];
    for (let i = 0; i < Math.max(3, stdio.length); i++) {
      let s = stdio[i];
      if (s == null) s = i < 3 ? 'pipe' : 'ignore';
      if (s === 'pipe' || s === 'overlapped') out.push(['pipe']);
      else if (s === 'ignore') out.push(['ignore']);
      else if (s === 'inherit') out.push(['fd', i]);
      else if (typeof s === 'number') out.push(['fd', s]);
      else if (s && typeof s === 'object' && typeof s.fd === 'number') out.push(['fd', s.fd]);
      else if (s === 'ipc') throw nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'child_process IPC is not available in MIRAGE yet');
      else throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'stdio' is invalid. Received ${N.inspect(s)}`);
    }
    return out;
  };
  /**
   * The child made: { pid } or { error: -errno }, and its stdio -- per entry the parent's end of a pipe
   * (`fd`, `readable` for the parent) or nothing.
   */
  const make = (n, stdio) => {
    const ends = [], map = [], drop = [];
    for (let i = 0; i < stdio.length; i++) {
      const [kind, fd] = stdio[i];
      if (kind === 'pipe') {
        const [r, w] = scope(() => { const p = alloc(8); const e = sys(42, p); if (e < 0) throw uvError(e, 'pipe'); return [N.i32(p), N.i32(p + 4)]; });
        if (i === 0) { map.push(r); drop.push(r); ends.push({ fd: w, readable: false }); } else { map.push(w); drop.push(w); ends.push({ fd: r, readable: true }); }
      } else if (kind === 'ignore') {
        const d = scope(() => sys(5, str('/dev/null'), 2, 0));
        map.push(d); drop.push(d); ends.push(null);
      } else { map.push(fd); ends.push(null); }
    }
    const path = which(n.file, n.env);
    const r = scope(() => {
      const ptrs = (list) => { const a = alloc(4 * (list.length + 1)); const p = list.map((s) => str(s)); p.forEach((v, i) => N.setU32(a + 4 * i, v)); N.setU32(a + 4 * list.length, 0); return a; };
      const pp = str(path), av = ptrs(n.args), ev = ptrs(n.envPairs), cw = n.cwd === null ? 0 : str(n.cwd);
      const m = alloc(4 * map.length); map.forEach((v, i) => view().setInt32(m - N.BASE + 4 * i, v, true));
      return sys(SPAWN, pp, av, ev, cw, m, map.length);
    });
    for (const d of drop) close(d);
    if (r < 0) { for (const e of ends) if (e) close(e.fd); return { error: r, ends: ends.map(() => null) }; }
    return { pid: r, ends };
  };
  const statusOf = (st) => ((st & 0x7f) === 0 ? { code: (st >> 8) & 0xff, signal: null } : { code: null, signal: SIGNAME[st & 0x7f] || null });

  // ---- a pipe's end, as a stream -------------------------------------------------------------------
  const reader = (fd) => {
    let stop = null, closed = false;
    const shut = () => { if (stop) { stop(); stop = null; } if (!closed) { closed = true; close(fd); } };
    const s = new N.stream.Readable({
      highWaterMark: 65536,
      read() {
        if (stop || closed) return;
        stop = N.watch({ fd, events: 1, ready: () => {
          stop(); stop = null;
          const b = Buffer.allocUnsafe(65536);
          let n;
          try { n = N.fsio.readSync(fd, b, 0, 65536, null); } catch (e) { if (e.code === 'EAGAIN') { s._read(); return; } s.destroy(e); return; }
          if (n) s.push(Buffer.from(b.subarray(0, n))); else { shut(); s.push(null); }
        } });
      },
      destroy(err, cb) { shut(); cb(err); },
    });
    s.fd = fd; s.ref = () => s; s.unref = () => s;
    return s;
  };
  const writer = (fd) => {
    let closed = false;
    const shut = () => { if (!closed) { closed = true; close(fd); } };
    const s = new N.stream.Writable({
      write(chunk, enc, cb) {
        const b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
        try { for (let at = 0; at < b.length;) { const n = N.fsio.writeSync(fd, b, at, b.length - at, null); if (n <= 0) break; at += n; } } catch (e) { cb(e); return; }
        cb();
      },
      final(cb) { shut(); cb(); },
      destroy(err, cb) { shut(); cb(err); },
    });
    s.fd = fd; s.ref = () => s; s.unref = () => s;
    return s;
  };

  // ---- ChildProcess ---------------------------------------------------------------------------------
  const kids = new Map();
  class ChildProcess extends EventEmitter {
    constructor() {
      super();
      this._closesNeeded = 1; this._closesGot = 0; this.connected = false; this.signalCode = null; this.exitCode = null;
      this.killed = false; this.spawnfile = null; this._handle = null;
    }
    spawn(options) {
      const n = normalize(options.file, options.args ? options.args.slice(1) : [], { ...options, argv0: options.args ? options.args[0] : undefined });
      return this._spawn(n, stdioOf(options.stdio));
    }
    _spawn(n, stdio) {
      this.spawnfile = n.file; this.spawnargs = n.args;
      const made = make(n, stdio);
      this._handle = made.error ? null : { pid: made.pid, ref: true };
      this.stdio = made.ends.map((e) => (e ? (e.readable ? reader(e.fd) : writer(e.fd)) : null));
      this.stdin = this.stdio[0] || null; this.stdout = this.stdio[1] || null; this.stderr = this.stdio[2] || null;
      for (let i = 1; i < this.stdio.length; i++) if (this.stdio[i]) { this._closesNeeded++; this.stdio[i].on('close', () => this._maybeClose()); }
      if (made.error) {
        for (const s of this.stdio) if (s) s.destroy();
        N.nextTick(() => this._onexit(made.error, null));
        return made.error;
      }
      this.pid = made.pid;
      kids.set(made.pid, this); N.kids++; N.refs++;
      N.nextTick(() => this.emit('spawn'));
      return 0;
    }
    _onexit(code, signal) {
      if (signal) this.signalCode = signal; else this.exitCode = code;
      if (this.stdin) this.stdin.destroy();
      if (this._handle) { kids.delete(this._handle.pid); N.kids--; if (this._handle.ref) N.refs--; this._handle = null; }
      if (code < 0) {
        const e = errno(code, this.spawnfile ? 'spawn ' + this.spawnfile : 'spawn');
        if (this.spawnfile) e.path = this.spawnfile;
        e.spawnargs = this.spawnargs.slice(1);
        this.emit('error', e);
      } else this.emit('exit', this.exitCode, this.signalCode);
      N.nextTick(() => { for (let i = 1; i < (this.stdio || []).length; i++) { const st = this.stdio[i]; if (st && st.readable && st._r.flowing === null) st.resume(); } });   // flushStdio: what nobody reads, drained
      this._maybeClose();
    }
    _maybeClose() { if (++this._closesGot === this._closesNeeded) this.emit('close', this.exitCode, this.signalCode); }
    kill(sig) {
      const n = sig === 0 ? 0 : sigNum(sig === undefined ? 'SIGTERM' : sig);
      if (!this._handle) return false;
      const r = sys(37, this._handle.pid, n);
      if (r === 0) { this.killed = true; return true; }
      if (r !== -3) this.emit('error', errno(r, 'kill'));
      return false;
    }
    ref() { if (this._handle && !this._handle.ref) { this._handle.ref = true; N.refs++; } }
    unref() { if (this._handle && this._handle.ref) { this._handle.ref = false; N.refs--; } }
  }
  N.reap = () => {
    for (;;) {
      const [pid, st] = scope(() => { const p = alloc(4); const r = sys(114, -1, p, 1, 0); return [r, r > 0 ? N.i32(p) : 0]; });
      if (pid <= 0) return;
      const c = kids.get(pid); if (!c) continue;
      const { code, signal } = statusOf(st);
      try { c._onexit(code, signal); } catch (e) { N.uncaught(e); }
    }
  };

  const spawn = (file, args, options) => {
    const n = normalize(file, args, options), c = new ChildProcess();
    c._spawn(n, stdioOf(n.options.stdio));
    return c;
  };

  // ---- spawnSync: the child run to its end, its pipes read as they fill ----------------------------
  const spawnSync = (file, args, options) => {
    const n = normalize(file, args, options), o = n.options;
    const stdio = stdioOf(o.stdio);
    if (o.input !== undefined) stdio[0] = ['pipe'];
    const made = make(n, stdio);
    if (made.error) {
      const e = errno(made.error, 'spawnSync ' + n.file); e.path = n.file; e.spawnargs = n.args.slice(1);
      return { error: e, status: null, signal: null, output: null, pid: 0, stdout: null, stderr: null };
    }
    const ends = made.ends, chunks = ends.map(() => []);
    if (ends[0]) {
      if (o.input !== undefined && o.input !== null) {
        const b = typeof o.input === 'string' ? Buffer.from(o.input, o.encoding && o.encoding !== 'buffer' ? o.encoding : 'utf8') : Buffer.from(o.input.buffer ? new Uint8Array(o.input.buffer, o.input.byteOffset, o.input.byteLength) : o.input);
        try { for (let at = 0; at < b.length;) { const k = N.fsio.writeSync(ends[0].fd, b, at, b.length - at, null); if (k <= 0) break; at += k; } } catch { /* the child closed it: EPIPE */ }
      }
      close(ends[0].fd);
    }
    let open = ends.map((e, i) => (e && i > 0 ? e.fd : -1)).filter((fd) => fd >= 0);
    const start = N.clock(1), timeout = o.timeout > 0 ? o.timeout : 0;
    let timedOut = false;
    const b = Buffer.allocUnsafe(65536);
    while (open.length) {
      const left = timeout ? Math.max(0, timeout - (N.clock(1) - start)) : -1;
      if (timeout && left === 0) { timedOut = true; break; }
      const ready = scope(() => {
        const pf = alloc(8 * open.length), d = view(), at = pf - N.BASE;
        open.forEach((fd, i) => { d.setInt32(at + 8 * i, fd, true); d.setInt16(at + 8 * i + 4, 1, true); d.setInt16(at + 8 * i + 6, 0, true); });
        const r = sys(168, pf, open.length, left < 0 ? -1 : Math.ceil(left));
        return r > 0 ? open.filter((fd, i) => d.getInt16(at + 8 * i + 6, true) !== 0) : [];
      });
      for (const fd of ready) {
        const i = ends.findIndex((e) => e && e.fd === fd);
        let k = 0; try { k = N.fsio.readSync(fd, b, 0, 65536, null); } catch { k = 0; }
        if (k > 0) chunks[i].push(Buffer.from(b.subarray(0, k))); else { close(fd); open = open.filter((x) => x !== fd); }
      }
    }
    if (timedOut) { sys(37, made.pid, sigNum(o.killSignal || 'SIGTERM')); for (const fd of open) close(fd); }
    const st = scope(() => { const p = alloc(4); sys(114, made.pid, p, 0, 0); return N.i32(p); });
    const { code, signal } = statusOf(st);
    let output = ends.map((e, i) => (e && i > 0 ? Buffer.concat(chunks[i]) : null));
    if (o.encoding && o.encoding !== 'buffer') output = output.map((x) => (x ? x.toString(o.encoding) : x));
    const res = { status: code, signal, output, pid: made.pid, stdout: output[1], stderr: output[2] };
    if (timedOut) { const e = errno(-110, 'spawnSync ' + n.file); e.path = n.file; e.spawnargs = n.args.slice(1); res.error = e; }
    return res;
  };
  const syncError = (ret, args, cmd) => {
    if (ret.error) return Object.assign(ret.error, ret);
    if (ret.status !== 0) {
      let msg = 'Command failed: ' + (cmd || args.join(' '));
      if (ret.stderr && ret.stderr.length > 0) msg += `\n${ret.stderr.toString()}`;
      return Object.assign(new Error(msg), ret);
    }
    return null;
  };
  const execOptions = (command, options) => ({ ...(options || {}), shell: typeof options?.shell === 'string' ? options.shell : true });
  const execSync = (command, options) => {
    const o = execOptions(command, options), inherit = !o.stdio;
    const ret = spawnSync(command, o);
    if (inherit && ret.stderr) proc.stderr.write(ret.stderr);
    const e = syncError(ret, undefined, command); if (e) throw e;
    return ret.stdout;
  };
  const execFileSync = (file, args, options) => {
    if (!Array.isArray(args)) { options = args; args = []; }
    const n = normalize(file, args, options), inherit = !(options && options.stdio);
    const ret = spawnSync(file, args, options);
    if (inherit && ret.stderr) proc.stderr.write(ret.stderr);
    const e = syncError(ret, n.args, undefined); if (e) throw e;
    return ret.stdout;
  };

  // ---- execFile and exec: the output gathered, a callback at the end -------------------------------
  const execFile = (file, args, options, callback) => {
    if (typeof args === 'function') { callback = args; args = []; options = {}; }
    else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    options = { encoding: 'utf8', timeout: 0, maxBuffer: 1024 * 1024, killSignal: 'SIGTERM', ...(options || {}) };
    const c = spawn(file, args, options);
    const encoding = options.encoding && options.encoding !== 'buffer' ? options.encoding : null;
    const out = [], err = [];
    let exited = false, ex = null, killed = false, timer = null;
    if (c.stdout) { if (encoding) c.stdout.setEncoding(encoding); c.stdout.on('data', (d) => out.push(d)); }
    if (c.stderr) { if (encoding) c.stderr.setEncoding(encoding); c.stderr.on('data', (d) => err.push(d)); }
    const join = (list) => (encoding ? list.join('') : Buffer.concat(list));
    const exithandler = (code, signal) => {
      if (exited) return; exited = true;
      if (timer) N.timers.clearTimeout(timer);
      if (!callback) return;
      const stdout = join(out), stderr = join(err);
      if (!ex && code === 0 && signal === null) { callback(null, stdout, stderr); return; }
      let cmd = file;
      if (args.length) cmd += ` ${args.join(' ')}`;
      if (!ex) ex = Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code: code < 0 ? (N.ERRORS[-code] || ['UNKNOWN'])[0] : code, killed: c.killed || killed, signal });
      ex.cmd = cmd;
      callback(ex, stdout, stderr);
    };
    if (options.timeout > 0) timer = N.timers.setTimeout(() => { killed = true; try { c.kill(options.killSignal); } catch (e) { ex = e; exithandler(); } }, options.timeout);
    c.on('close', exithandler);
    c.on('error', (e) => { ex = e; if (c.stdout) c.stdout.destroy(); if (c.stderr) c.stderr.destroy(); exithandler(); });
    return c;
  };
  const exec = (command, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    return execFile(command, execOptions(command, options), callback);
  };
  const promised = (f) => (...a) => {
    let c;
    const p = new Promise((res, rej) => { c = f(...a, (e, stdout, stderr) => { if (e) { e.stdout = stdout; e.stderr = stderr; rej(e); } else res({ stdout, stderr }); }); });
    p.child = c;
    return p;
  };
  const kCustom = Symbol.for('nodejs.util.promisify.custom');
  Object.defineProperty(exec, kCustom, { value: promised(exec), enumerable: false });
  Object.defineProperty(execFile, kCustom, { value: promised(execFile), enumerable: false });
  const fork = () => { throw nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'child_process.fork is not available in MIRAGE yet'); };

  N.childProcess = { ChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, _forkChild: fork };
}
