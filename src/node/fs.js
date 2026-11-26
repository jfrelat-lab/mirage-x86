// fs.js — Node's `fs` on MIRAGE-LINUX's system calls: the synchronous functions made of them, the
// callback and promise forms made of those (answered on the next turn of the loop), streams. A part of
// the HLE node (src/node/kernel.js).
export function fs(N) {
  const { alloc, scope, sys, str, put, get, view, uvError, Buffer } = N;
  const AT_FDCWD = -100, AT_SYMLINK_NOFOLLOW = 0x100, AT_REMOVEDIR = 0x200;
  const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, NOCTTY: 0x100, TRUNC: 0x200, APPEND: 0x400, NONBLOCK: 0x800, DSYNC: 0x1000, SYNC: 0x101000, DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000, LARGEFILE: 0x8000, NOATIME: 0x40000 };
  const constants = {
    UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2,
    UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7, EXTENSIONLESS_FORMAT_JAVASCRIPT: 0, EXTENSIONLESS_FORMAT_WASM: 1,
    S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
    O_CREAT: O.CREAT, O_EXCL: O.EXCL, UV_FS_O_FILEMAP: 0, O_NOCTTY: O.NOCTTY, O_TRUNC: O.TRUNC, O_APPEND: O.APPEND, O_DIRECTORY: O.DIRECTORY, O_NOATIME: O.NOATIME,
    O_NOFOLLOW: O.NOFOLLOW, O_SYNC: O.SYNC, O_DSYNC: O.DSYNC, O_DIRECT: 0x4000, O_NONBLOCK: O.NONBLOCK,
    S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100, S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10, S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4,
  };
  const FLAGS = { r: O.RDONLY, rs: O.RDONLY | O.SYNC, sr: O.RDONLY | O.SYNC, 'r+': O.RDWR, 'rs+': O.RDWR | O.SYNC, 'sr+': O.RDWR | O.SYNC,
    w: O.TRUNC | O.CREAT | O.WRONLY, wx: O.TRUNC | O.CREAT | O.WRONLY | O.EXCL, xw: O.TRUNC | O.CREAT | O.WRONLY | O.EXCL,
    'w+': O.TRUNC | O.CREAT | O.RDWR, 'wx+': O.TRUNC | O.CREAT | O.RDWR | O.EXCL, 'xw+': O.TRUNC | O.CREAT | O.RDWR | O.EXCL,
    a: O.APPEND | O.CREAT | O.WRONLY, ax: O.APPEND | O.CREAT | O.WRONLY | O.EXCL, xa: O.APPEND | O.CREAT | O.WRONLY | O.EXCL, as: O.APPEND | O.CREAT | O.WRONLY | O.SYNC, sa: O.APPEND | O.CREAT | O.WRONLY | O.SYNC,
    'a+': O.APPEND | O.CREAT | O.RDWR, 'ax+': O.APPEND | O.CREAT | O.RDWR | O.EXCL, 'xa+': O.APPEND | O.CREAT | O.RDWR | O.EXCL, 'as+': O.APPEND | O.CREAT | O.RDWR | O.SYNC, 'sa+': O.APPEND | O.CREAT | O.RDWR | O.SYNC };
  const flagsOf = (f, dflt) => {
    if (f === undefined || f === null) return FLAGS[dflt];
    if (typeof f === 'number') return f;
    const v = FLAGS[f];
    if (v === undefined) throw N.nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument 'flags' is invalid. Received ${N.inspect(f)}`);
    return v;
  };
  const pathOf = (p, name = 'path') => {
    if (typeof p === 'string') { if (p.includes('\0')) throw N.nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', `The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received ${N.inspect(p)}`); return p; }
    if (p instanceof Uint8Array) return N.utf8Decode(p);
    if (p && typeof p === 'object' && p.href !== undefined && p.protocol === 'file:') return N.fileURLToPath(p);
    throw N.invalidArg(name, 'of type string or an instance of Buffer or URL', p);
  };
  const modeOf = (m, dflt) => (m === undefined || m === null ? dflt : typeof m === 'string' ? parseInt(m, 8) : m);
  const ok = (r, syscall, path, dest) => { if (r < 0) throw uvError(r, syscall, path, dest); return r; };
  const optsOf = (o, dflt = {}) => (o === undefined || o === null ? dflt : typeof o === 'string' ? { ...dflt, encoding: o } : o);

  // ---- stat ---------------------------------------------------------------------------------------
  class StatsBase {
    isDirectory() { return (this.mode & 0o170000) === 0o040000; }
    isFile() { return (this.mode & 0o170000) === 0o100000; }
    isBlockDevice() { return (this.mode & 0o170000) === 0o060000; }
    isCharacterDevice() { return (this.mode & 0o170000) === 0o020000; }
    isSymbolicLink() { return (this.mode & 0o170000) === 0o120000; }
    isFIFO() { return (this.mode & 0o170000) === 0o010000; }
    isSocket() { return (this.mode & 0o170000) === 0o140000; }
  }
  class Stats extends StatsBase {}
  class BigIntStats extends StatsBase {
    isDirectory() { return (this.mode & 0o170000n) === 0o040000n; }
    isFile() { return (this.mode & 0o170000n) === 0o100000n; }
    isSymbolicLink() { return (this.mode & 0o170000n) === 0o120000n; }
    isCharacterDevice() { return (this.mode & 0o170000n) === 0o020000n; }
    isBlockDevice() { return (this.mode & 0o170000n) === 0o060000n; }
    isFIFO() { return (this.mode & 0o170000n) === 0o010000n; }
    isSocket() { return (this.mode & 0o170000n) === 0o140000n; }
  }
  const statOf = (va, bigint) => {
    const d = view(), o = va - N.BASE, u = (k) => d.getUint32(o + k, true);
    const t = (k) => u(k) * 1000 + Math.floor(u(k + 4) / 1e6) + (u(k + 4) % 1e6) / 1e6;
    const raw = { dev: Number(d.getBigUint64(o, true)), mode: u(16), nlink: u(20), uid: u(24), gid: u(28), rdev: Number(d.getBigUint64(o + 32, true)), blksize: u(52),
      ino: Number(d.getBigUint64(o + 88, true)), size: Number(d.getBigInt64(o + 44, true)), blocks: Number(d.getBigUint64(o + 56, true)) };
    const ns = (k) => BigInt(u(k)) * 1000000000n + BigInt(u(k + 4));
    if (bigint) {
      const s = new BigIntStats();
      for (const [k, v] of Object.entries(raw)) s[k] = BigInt(v);
      s.atimeMs = ns(64) / 1000000n; s.mtimeMs = ns(72) / 1000000n; s.ctimeMs = ns(80) / 1000000n; s.birthtimeMs = ns(80) / 1000000n;
      s.atimeNs = ns(64); s.mtimeNs = ns(72); s.ctimeNs = ns(80); s.birthtimeNs = ns(80);
      s.atime = new Date(Number(s.atimeMs)); s.mtime = new Date(Number(s.mtimeMs)); s.ctime = new Date(Number(s.ctimeMs)); s.birthtime = new Date(Number(s.birthtimeMs));
      return s;
    }
    const s = new Stats();
    Object.assign(s, raw);
    s.atimeMs = t(64); s.mtimeMs = t(72); s.ctimeMs = t(80); s.birthtimeMs = t(80);
    s.atime = new Date(s.atimeMs); s.mtime = new Date(s.mtimeMs); s.ctime = new Date(s.ctimeMs); s.birthtime = new Date(s.birthtimeMs);
    return s;
  };
  const statAt = (p, flags, syscall, opts = {}) => scope(() => {
    const st = alloc(96), r = sys(300, AT_FDCWD, str(p), st, flags);
    if (r < 0) { if (opts.throwIfNoEntry === false && (r === -2 || r === -20)) return undefined; throw uvError(r, syscall, p); }
    return statOf(st, opts.bigint);
  });
  const statSync = (p, opts) => statAt(pathOf(p), 0, 'stat', opts);
  const lstatSync = (p, opts) => statAt(pathOf(p), AT_SYMLINK_NOFOLLOW, 'lstat', opts);
  const fstatSync = (fd, opts = {}) => scope(() => { const st = alloc(96); ok(sys(197, fd, st), 'fstat'); return statOf(st, opts.bigint); });

  // ---- files --------------------------------------------------------------------------------------
  const openSync = (p, flags, mode) => { p = pathOf(p); return scope(() => ok(sys(295, AT_FDCWD, str(p), flagsOf(flags, 'r') | O.LARGEFILE | O.CLOEXEC, modeOf(mode, 0o666)), 'open', p)); };
  const closeSync = (fd) => { ok(sys(6, fd), 'close'); };
  const CHUNK = 256 * 1024;
  /** read(2) into `b` at `off`, `len` bytes, at `pos` (pread) or the descriptor's offset. */
  const readSync = (fd, b, off, len, pos) => {
    if (off !== null && typeof off === 'object' && !ArrayBuffer.isView(off)) { ({ offset: off = 0, length: len = b.byteLength - off, position: pos = null } = off); }
    if (off === undefined) off = 0;
    if (len === undefined) len = b.byteLength - off;
    let total = 0;
    while (total < len) {
      const n = Math.min(CHUNK, len - total);
      const r = scope(() => {
        const va = alloc(n);
        const at = pos === null || pos === undefined || pos === -1 ? null : Number(pos) + total;
        const r = at === null ? sys(3, fd, va, n) : sys(180, fd, va, n, at >>> 0, Math.floor(at / 2 ** 32));
        if (r > 0) b.set(get(va, r), off + total);
        return r;
      });
      ok(r, 'read');
      total += r;
      if (r < n) break;
      if (pos === null || pos === undefined) { if (total >= len) break; }
      break;                                                             // one read, as read(2): what is there
    }
    return total;
  };
  const writeSync = (fd, b, off, len, pos) => {
    let bytes;
    if (typeof b === 'string') { const enc = typeof len === 'string' ? len : 'utf8'; bytes = Buffer.from(b, enc); pos = typeof off === 'number' ? off : null; off = 0; len = bytes.length; }
    else { bytes = b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength); if (off !== null && typeof off === 'object') ({ offset: off = 0, length: len = bytes.length - off, position: pos = null } = off); off = off || 0; if (len === undefined) len = bytes.length - off; }
    let total = 0;
    while (total < len) {
      const n = Math.min(CHUNK, len - total);
      const r = scope(() => {
        const va = alloc(n); put(va, bytes.subarray(off + total, off + total + n));
        const at = pos === null || pos === undefined ? null : Number(pos) + total;
        return at === null ? sys(4, fd, va, n) : sys(181, fd, va, n, at >>> 0, Math.floor(at / 2 ** 32));
      });
      ok(r, 'write');
      total += r;
      if (r === 0) break;
    }
    return total;
  };
  const readAll = (fd) => {
    const parts = []; let size = 0;
    for (;;) {
      const b = Buffer.allocUnsafe(CHUNK), n = readSync(fd, b, 0, CHUNK, null);
      if (n === 0) break;
      parts.push(n === CHUNK ? b : b.subarray(0, n)); size += n;
    }
    return Buffer.concat(parts, size);
  };
  const isFd = (v) => typeof v === 'number';
  const readFileSync = (p, opts) => {
    opts = optsOf(opts, { flag: 'r' });
    const fd = isFd(p) ? p : openSync(p, opts.flag || 'r');
    let data;
    try {
      if (!isFd(p)) { const st = fstatSync(fd); if (st.isDirectory()) throw uvError(-21, 'read'); }
      data = readAll(fd);
    } finally { if (!isFd(p)) closeSync(fd); }
    return opts.encoding ? data.toString(opts.encoding) : data;
  };
  const toBytes = (data, enc) => (typeof data === 'string' ? Buffer.from(data, enc || 'utf8') : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : (() => { throw N.invalidArg('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data); })());
  const writeFileSync = (p, data, opts) => {
    opts = optsOf(opts, { flag: 'w', mode: 0o666 });
    const bytes = toBytes(data, opts.encoding);
    const fd = isFd(p) ? p : openSync(p, opts.flag || 'w', opts.mode);
    try { writeSync(fd, bytes, 0, bytes.length, null); } finally { if (!isFd(p)) closeSync(fd); }
  };
  const appendFileSync = (p, data, opts) => { opts = optsOf(opts, { flag: 'a', mode: 0o666 }); writeFileSync(p, data, { ...opts, flag: opts.flag || 'a' }); };
  const existsSync = (p) => { try { p = pathOf(p); } catch { return false; } return scope(() => sys(307, AT_FDCWD, str(p), 0) >= 0); };
  const accessSync = (p, mode = 0) => { p = pathOf(p); scope(() => ok(sys(307, AT_FDCWD, str(p), mode), 'access', p)); };

  // ---- directories --------------------------------------------------------------------------------
  class Dirent {
    constructor(name, type, parentPath) { this.name = name; this.parentPath = parentPath; this[kType] = type; }
    isDirectory() { return this[kType] === 4; } isFile() { return this[kType] === 8; } isSymbolicLink() { return this[kType] === 10; }
    isFIFO() { return this[kType] === 1; } isSocket() { return this[kType] === 12; } isCharacterDevice() { return this[kType] === 2; } isBlockDevice() { return this[kType] === 6; }
    get path() { return this.parentPath; }
  }
  const kType = Symbol('type');
  const listDir = (p, syscall = 'scandir') => {
    const fd = scope(() => ok(sys(295, AT_FDCWD, str(p), O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0), syscall, p));
    const out = [];
    try {
      for (;;) {
        const n = scope(() => {
          const va = alloc(32768), r = sys(220, fd, va, 32768);
          if (r <= 0) return r;
          const b = get(va, r), d = new DataView(b.buffer);
          for (let o = 0; o < r;) {
            const rl = d.getUint16(o + 16, true); let e = o + 19; while (b[e]) e++;
            const name = N.utf8Decode(b, o + 19, e);
            if (name !== '.' && name !== '..') out.push([name, b[o + 18]]);
            o += rl;
          }
          return r;
        });
        ok(n, syscall, p);
        if (n === 0) break;
      }
    } finally { sys(6, fd); }
    return out;
  };
  const typeOf = (dir, name, t) => {
    if (t !== 0) return t;
    const s = statAt(dir + '/' + name, AT_SYMLINK_NOFOLLOW, 'lstat', { throwIfNoEntry: false });
    return !s ? 0 : s.isDirectory() ? 4 : s.isSymbolicLink() ? 10 : s.isFile() ? 8 : 0;
  };
  const readdirSync = (p, opts) => {
    opts = optsOf(opts); p = pathOf(p);
    const result = [];
    const walk = (dir, rel) => {
      for (const [name, t0] of listDir(dir)) {
        const t = typeOf(dir, name, t0), relName = rel ? rel + '/' + name : name;
        if (opts.withFileTypes) result.push(new Dirent(name, t, dir));
        else result.push(opts.encoding === 'buffer' ? Buffer.from(relName) : relName);
        if (opts.recursive && t === 4) walk(dir + '/' + name, relName);
      }
    };
    walk(p, '');
    return result;
  };
  const mkdirSync = (p, opts) => {
    p = pathOf(p);
    const o = typeof opts === 'object' && opts !== null ? opts : { mode: opts };
    const mode = modeOf(o.mode, 0o777);
    if (!o.recursive) { scope(() => ok(sys(296, AT_FDCWD, str(p), mode), 'mkdir', p)); return undefined; }
    const abs = N.path.resolve(p);
    let first;
    const make = (dir) => {
      const r = scope(() => sys(296, AT_FDCWD, str(dir), mode));
      if (r === 0) { if (first === undefined) first = dir; return; }
      if (r === -17) { const s = statAt(dir, 0, 'stat', { throwIfNoEntry: false }); if (s && s.isDirectory()) return; throw uvError(r === -17 && s ? -17 : r, 'mkdir', p); }
      if (r === -2) { const up = N.path.dirname(dir); if (up === dir) throw uvError(r, 'mkdir', p); make(up); const r2 = scope(() => sys(296, AT_FDCWD, str(dir), mode)); if (r2 === 0) { if (first === undefined) first = dir; return; } if (r2 !== -17) throw uvError(r2, 'mkdir', p); return; }
      throw uvError(r, 'mkdir', p);
    };
    make(abs);
    return first;
  };
  const rmdirSync = (p, opts) => { p = pathOf(p); if (opts && opts.recursive) return rmSync(p, { recursive: true, force: false }); scope(() => ok(sys(301, AT_FDCWD, str(p), AT_REMOVEDIR), 'rmdir', p)); };
  const unlinkSync = (p) => { p = pathOf(p); scope(() => ok(sys(301, AT_FDCWD, str(p), 0), 'unlink', p)); };
  const rmSync = (p, opts = {}) => {
    p = pathOf(p);
    const s = statAt(p, AT_SYMLINK_NOFOLLOW, 'lstat', { throwIfNoEntry: false });
    if (!s) { if (opts.force) return; throw uvError(-2, 'stat', p); }
    if (s.isDirectory()) {
      if (!opts.recursive) { const e = N.nodeError(Error, 'ERR_FS_EISDIR', `Path is a directory: rm returned EISDIR (is a directory) ${p}`); e.errno = 21; e.syscall = 'rm'; e.path = p; throw e; }
      for (const [name] of listDir(p, 'rm')) rmSync(p + '/' + name, opts);
      scope(() => ok(sys(301, AT_FDCWD, str(p), AT_REMOVEDIR), 'rmdir', p));
    } else scope(() => ok(sys(301, AT_FDCWD, str(p), 0), 'unlink', p));
  };
  const renameSync = (a, b) => { a = pathOf(a, 'oldPath'); b = pathOf(b, 'newPath'); scope(() => ok(sys(302, AT_FDCWD, str(a), AT_FDCWD, str(b)), 'rename', a, b)); };
  const linkSync = (a, b) => { a = pathOf(a, 'existingPath'); b = pathOf(b, 'newPath'); scope(() => ok(sys(303, AT_FDCWD, str(a), AT_FDCWD, str(b), 0), 'link', a, b)); };
  const symlinkSync = (target, p) => { target = pathOf(target, 'target'); p = pathOf(p); scope(() => ok(sys(304, str(target), AT_FDCWD, str(p)), 'symlink', target, p)); };
  const readlinkSync = (p, opts) => {
    p = pathOf(p); opts = optsOf(opts);
    const s = scope(() => { const va = alloc(4096), r = ok(sys(305, AT_FDCWD, str(p), va, 4096), 'readlink', p); return Buffer.from(get(va, r)); });
    return opts.encoding === 'buffer' ? s : s.toString(opts.encoding || 'utf8');
  };
  const realpathSync = (p, opts) => {
    p = pathOf(p); opts = optsOf(opts);
    let parts = N.path.resolve(p).split('/').filter(Boolean), done = '', hops = 0;
    while (parts.length) {
      const next = done + '/' + parts.shift();
      const s = statAt(next, AT_SYMLINK_NOFOLLOW, 'lstat', { throwIfNoEntry: false });
      if (!s) throw uvError(-2, 'lstat', next);
      if (s.isSymbolicLink()) {
        if (++hops > 40) throw uvError(-40, 'stat', p);
        const t = readlinkSync(next);
        const r = t.startsWith('/') ? t : (done || '/') + '/' + t;
        parts = [...N.path.resolve(r).split('/').filter(Boolean), ...parts]; done = '';
      } else done = next;
    }
    const r = done || '/';
    return opts.encoding === 'buffer' ? Buffer.from(r) : r;
  };
  realpathSync.native = realpathSync;
  const copyFileSync = (a, b, mode = 0) => {
    a = pathOf(a, 'src'); b = pathOf(b, 'dest');
    const data = readFileSync(a), st = statSync(a);
    const fd = openSync(b, mode & 1 ? 'wx' : 'w', st.mode & 0o7777);
    try { writeSync(fd, data, 0, data.length, null); } finally { closeSync(fd); }
  };
  const cpSync = (a, b, opts = {}) => {
    a = pathOf(a, 'src'); b = pathOf(b, 'dest');
    const s = lstatSync(a);
    if (s.isDirectory()) {
      if (!opts.recursive) { const e = N.nodeError(Error, 'ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${a}`); throw e; }
      mkdirSync(b, { recursive: true });
      for (const name of readdirSync(a)) cpSync(a + '/' + name, b + '/' + name, opts);
    } else if (s.isSymbolicLink()) symlinkSync(readlinkSync(a), b);
    else { if (opts.errorOnExist && existsSync(b) && opts.force === false) throw uvError(-17, 'cp', b); if (opts.force === false && existsSync(b)) return; copyFileSync(a, b); }
  };
  const truncateSync = (p, len = 0) => { const fd = isFd(p) ? p : openSync(p, 'r+'); try { ftruncateSync(fd, len); } finally { if (!isFd(p)) closeSync(fd); } };
  const ftruncateSync = (fd, len = 0) => { ok(sys(194, fd, len >>> 0, Math.floor(len / 2 ** 32)), 'ftruncate'); };
  const chmodSync = (p, mode) => { p = pathOf(p); scope(() => ok(sys(306, AT_FDCWD, str(p), modeOf(mode)), 'chmod', p)); };
  const fchmodSync = (fd, mode) => { ok(sys(94, fd, modeOf(mode)), 'fchmod'); };
  const chownSync = (p, uid, gid) => { p = pathOf(p); scope(() => ok(sys(212, str(p), uid, gid), 'chown', p)); };
  const toTimespec = (va, t) => {
    const secs = typeof t === 'number' ? t : t instanceof Date ? t.getTime() / 1000 : Number(t);
    const d = view(), o = va - N.BASE; d.setUint32(o, Math.floor(secs) >>> 0, true); d.setUint32(o + 4, Math.round((secs - Math.floor(secs)) * 1e9) >>> 0, true);
  };
  const utimesAt = (fd, p, atime, mtime, flags, syscall) => scope(() => { const ts = alloc(16); toTimespec(ts, atime); toTimespec(ts + 8, mtime); ok(sys(320, fd, p === null ? 0 : str(p), ts, flags), syscall, p ?? undefined); });
  const utimesSync = (p, a, m) => utimesAt(AT_FDCWD, pathOf(p), a, m, 0, 'utime');
  const lutimesSync = (p, a, m) => utimesAt(AT_FDCWD, pathOf(p), a, m, AT_SYMLINK_NOFOLLOW, 'lutime');
  const futimesSync = (fd, a, m) => utimesAt(fd, null, a, m, 0, 'futime');
  const fsyncSync = (fd) => { ok(sys(118, fd), 'fsync'); };
  const mkdtempSync = (prefix, opts) => {
    prefix = pathOf(prefix, 'prefix');
    const C = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let tries = 0; tries < 100; tries++) {
      const rnd = N.randomBytes(6); let s = ''; for (const b of rnd) s += C[b % C.length];
      const p = prefix + s, r = scope(() => sys(296, AT_FDCWD, str(p), 0o700));
      if (r === 0) return opts === 'buffer' || (opts && opts.encoding === 'buffer') ? Buffer.from(p) : p;
      if (r !== -17) throw uvError(r, 'mkdtemp', prefix + 'XXXXXX');
    }
    throw uvError(-17, 'mkdtemp', prefix + 'XXXXXX');
  };
  const opendirSync = (p) => {
    p = pathOf(p);
    const entries = listDir(p, 'opendir').map(([name, t]) => new Dirent(name, typeOf(p, name, t), p));
    let i = 0;
    return { path: p, readSync: () => (i < entries.length ? entries[i++] : null), read(cb) { const v = this.readSync(); if (cb) N.nextTick(cb, null, v); else return Promise.resolve(v); }, closeSync() {}, close(cb) { if (cb) N.nextTick(cb, null); else return Promise.resolve(); },
      async *[Symbol.asyncIterator]() { while (i < entries.length) yield entries[i++]; }, *[Symbol.iterator]() { while (i < entries.length) yield entries[i++]; } };
  };
  const statfsSync = () => ({ type: 0xef53, bsize: 4096, blocks: 1 << 20, bfree: 1 << 19, bavail: 1 << 19, files: 1 << 20, ffree: 1 << 19 });
  const globSync = () => { throw N.nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The fs.globSync() method is not implemented in MIRAGE yet'); };

  const sync = { openSync, closeSync, readSync, writeSync, readFileSync, writeFileSync, appendFileSync, existsSync, accessSync, statSync, lstatSync, fstatSync,
    readdirSync, mkdirSync, rmdirSync, rmSync, unlinkSync, renameSync, linkSync, symlinkSync, readlinkSync, realpathSync, copyFileSync, cpSync, truncateSync,
    ftruncateSync, chmodSync, fchmodSync, lchmodSync: chmodSync, chownSync, lchownSync: chownSync, fchownSync: () => {}, utimesSync, lutimesSync, futimesSync, fsyncSync, fdatasyncSync: fsyncSync,
    mkdtempSync, opendirSync, statfsSync, globSync };

  // ---- callbacks and promises: the same work, answered on the loop's next turn --------------------
  // (an immediate: where Node's thread pool answers, after the microtasks of the code that asked)
  const done = (f) => N.timers.setImmediate(f);
  const fsmod = { constants, Stats, Dirent, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, ...sync };
  const promises = { constants };
  for (const [name, f] of Object.entries(sync)) {
    const base = name.slice(0, -4);
    if (base === 'exists') {
      fsmod.exists = (p, cb) => { const v = existsSync(p); done(() => cb(v)); };
      continue;
    }
    fsmod[base] = function (...args) {
      const cb = args.pop();
      if (typeof cb !== 'function') throw N.invalidArg('cb', 'of type function', cb);
      let r, err = null;
      try { r = f(...args); } catch (e) { err = e; }
      if (base === 'read' || base === 'write') done(() => (err ? cb(err) : cb(null, r, args[1])));
      else done(() => (err ? cb(err) : cb(null, r)));
    };
    if (!['open', 'close', 'read', 'write', 'fstat', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync', 'fdatasync', 'opendir'].includes(base)) {
      promises[base] = (...args) => new Promise((resolve, reject) => done(() => { try { resolve(f(...args)); } catch (e) { reject(e); } }));
    }
  }
  fsmod.realpath.native = fsmod.realpath;
  // fs/promises' FileHandle, for open
  class FileHandle extends N.EventEmitter {
    constructor(fd) { super(); this.fd = fd; }
    async readFile(o) { return readFileSync(this.fd, o); }
    async writeFile(d, o) { return writeFileSync(this.fd, d, o); }
    async appendFile(d, o) { return writeFileSync(this.fd, d, o); }
    async read(b, off, len, pos) { if (b === undefined || (b && !ArrayBuffer.isView(b))) { const o = b || {}; b = o.buffer || Buffer.alloc(16384); off = o.offset || 0; len = o.length ?? b.byteLength - off; pos = o.position ?? null; } return { bytesRead: readSync(this.fd, b, off, len, pos), buffer: b }; }
    async write(b, off, len, pos) { const n = writeSync(this.fd, b, off, len, pos); return { bytesWritten: n, buffer: b }; }
    async stat(o) { return fstatSync(this.fd, o); }
    async truncate(l) { return ftruncateSync(this.fd, l); }
    async sync() { return fsyncSync(this.fd); }
    async close() { if (this.fd >= 0) { closeSync(this.fd); this.fd = -1; } }
    async *readLines() { const text = readFileSync(this.fd, 'utf8'); const lines = text.split(/\r?\n/); if (lines.at(-1) === '') lines.pop(); yield* lines; }
    [Symbol.asyncDispose]() { return this.close(); }
  }
  promises.open = (p, flags, mode) => new Promise((resolve, reject) => { try { resolve(new FileHandle(openSync(p, flags, mode))); } catch (e) { reject(e); } });
  promises.opendir = async (p) => opendirSync(p);
  promises.watch = (filename, options = {}) => {          // an async iterator of { eventType, filename }
    const queue = [], waiting = [];
    const w = fsmod.watch(filename, { ...optsOf(options), signal: undefined }, (eventType, name) => {
      const ev = { eventType, filename: name };
      if (waiting.length) waiting.shift()({ value: ev, done: false }); else queue.push(ev);
    });
    let ended = false;
    const end = () => { if (ended) return; ended = true; w.close(); while (waiting.length) waiting.shift()({ value: undefined, done: true }); };
    const sig = optsOf(options).signal;
    let abortErr = null;
    if (sig) { const ab = () => { abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: sig.reason }); const ws = waiting.splice(0); end(); for (const r of ws) r(Promise.reject(abortErr)); }; if (sig.aborted) ab(); else sig.addEventListener('abort', ab, { once: true }); }
    return {
      next() { if (abortErr) return Promise.reject(abortErr); if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise((r) => waiting.push(r)); },
      return() { end(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  fsmod.promises = promises;
  fsmod.FileHandle = FileHandle;

  // ---- streams ------------------------------------------------------------------------------------
  fsmod.createReadStream = (p, opts) => {
    opts = optsOf(opts);
    const { Readable } = N.stream;
    let fd = opts.fd ?? null, pos = opts.start ?? null;
    const end = opts.end ?? Infinity, hwm = opts.highWaterMark ?? 65536;
    const r = new Readable({
      highWaterMark: hwm, encoding: opts.encoding,
      read() {
        done(() => { try {
          if (fd === null) { fd = openSync(p, opts.flags || 'r', opts.mode); this.emit('open', fd); this.emit('ready'); }
          const want = Math.min(hwm, end === Infinity ? hwm : end - (pos ?? 0) + 1);
          if (want <= 0) { this.push(null); return; }
          const b = Buffer.allocUnsafe(want), n = readSync(fd, b, 0, want, pos);
          if (pos !== null) pos += n;
          r.bytesRead += n;
          this.push(n ? b.subarray(0, n) : null);
        } catch (e) { this.destroy(e); } });
      },
      destroy(err, cb) { if (fd !== null && opts.autoClose !== false) { try { closeSync(fd); } catch { /* closed */ } fd = null; } cb(err); },
    });
    r.path = typeof p === 'string' ? p : undefined; r.bytesRead = 0; r.close = (cb) => r.destroy(null, cb);
    return r;
  };
  fsmod.createWriteStream = (p, opts) => {
    opts = optsOf(opts);
    const { Writable } = N.stream;
    let fd = opts.fd ?? null, pos = opts.start ?? null;
    const w = new Writable({
      decodeStrings: true, defaultEncoding: opts.encoding || 'utf8',
      write(chunk, enc, cb) {
        done(() => { try {
          if (fd === null) { fd = openSync(p, opts.flags || 'w', opts.mode); w.emit('open', fd); w.emit('ready'); }
          const n = writeSync(fd, chunk, 0, chunk.length, pos);
          if (pos !== null) pos += n;
          w.bytesWritten += n; cb();
        } catch (e) { cb(e); } });
      },
      final(cb) { try { if (fd === null) { fd = openSync(p, opts.flags || 'w', opts.mode); w.emit('open', fd); } } catch (e) { cb(e); return; } cb(); },
      destroy(err, cb) { if (fd !== null && opts.autoClose !== false) { try { closeSync(fd); } catch { /* closed */ } fd = null; } cb(err); },
    });
    w.path = typeof p === 'string' ? p : undefined; w.bytesWritten = 0; w.close = (cb) => { w.end(); if (cb) w.once('close', cb); };
    w.on('finish', () => w.destroy());
    return w;
  };

  // ---- watching: by polling stat on the guest's clock, as libuv's fs_poll does for watchFile -------
  // (MIRAGE-LINUX has no inotify: fs.watch polls too, every 100 ms, a directory's entries and their stats)
  const sameStat = (a, b) => a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.mode === b.mode && a.ino === b.ino && a.dev === b.dev && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
  const zeroStat = (bigint) => {               // a file that is not there: every field 0, every date the epoch (Node's)
    const z = bigint ? new BigIntStats() : new Stats(), v = bigint ? 0n : 0;
    for (const k of ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) z[k] = v;
    if (bigint) for (const k of ['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) z[k] = 0n;
    for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) z[k] = new Date(0);
    return z;
  };
  const statOrNone = (p, bigint) => { try { return statAt(p, 0, 'stat', { bigint }); } catch { return null; } };
  class StatWatcher extends N.EventEmitter {
    constructor(bigint) { super(); this._bigint = bigint; this._timer = null; }
    // As libuv's fs_poll: the first stat only kept (or, the file not there, said with both stats zeroed);
    // then a change said with the last stats seen, which a file gone and back keeps as its `prev`.
    start(p, persistent, interval) {
      let last = null, state = 0;                                          // state: 0 not polled, 1 there, -1 not there
      const poll = () => {
        const cur = statOrNone(p, this._bigint);
        if (!cur) { if (state !== -1) { state = -1; this.emit('change', zeroStat(this._bigint), last || zeroStat(this._bigint)); } return; }
        if (state === -1 || (state === 1 && !sameStat(cur, last))) this.emit('change', cur, last || zeroStat(this._bigint));
        state = 1; last = cur;
      };
      this._first = N.timers.setImmediate(poll);                         // the first stat on the loop's next turn, as libuv's answers
      this._timer = N.timers.setInterval(poll, interval);
      if (!persistent) { this._first.unref(); this._timer.unref(); }
    }
    stop() { if (this._timer) { N.timers.clearImmediate(this._first); N.timers.clearInterval(this._timer); this._timer = null; N.nextTick(() => this.emit('stop')); } }
    ref() { if (this._timer) this._timer.ref(); return this; }
    unref() { if (this._timer) this._timer.unref(); return this; }
  }
  const statWatchers = new Map();
  fsmod.watchFile = (filename, options, listener) => {
    const p = N.path.resolve(pathOf(filename));
    if (typeof options === 'function') { listener = options; options = {}; }
    options = { interval: 5007, persistent: true, ...options };
    if (typeof listener !== 'function') throw N.invalidArg('listener', 'of type function', listener);
    let w = statWatchers.get(p);
    if (!w) { w = new StatWatcher(!!options.bigint); w.start(p, options.persistent, options.interval); statWatchers.set(p, w); }
    w.on('change', listener);
    return w;
  };
  fsmod.unwatchFile = (filename, listener) => {
    const p = N.path.resolve(pathOf(filename)), w = statWatchers.get(p);
    if (!w) return;
    if (typeof listener === 'function') w.removeListener('change', listener); else w.removeAllListeners('change');
    if (w.listenerCount('change') === 0) { w.stop(); statWatchers.delete(p); }
  };
  // fs.watch: a file -> 'change' (its stat moved) or 'rename' (gone, or back); a directory -> the same for
  // each entry (recursive: the whole tree), by its name relative to the directory.
  const snapshot = (p, recursive) => {
    const st = statOrNone(p), out = new Map();
    if (!st) return { st, out };
    if (!st.isDirectory()) return { st, out };
    const walk = (dir, rel) => {
      let names; try { names = listDir(dir); } catch { return; }
      for (const [name] of names) {
        const full = dir + '/' + name, r = rel ? rel + '/' + name : name, s = statOrNone(full);
        if (!s) continue;
        out.set(r, s);
        if (recursive && s.isDirectory()) walk(full, r);
      }
    };
    walk(p, '');
    return { st, out };
  };
  class FSWatcher extends N.EventEmitter {
    constructor() { super(); this._timer = null; }
    close() { if (this._timer) { N.timers.clearInterval(this._timer); this._timer = null; N.nextTick(() => this.emit('close')); } }
    ref() { if (this._timer) this._timer.ref(); return this; }
    unref() { if (this._timer) this._timer.unref(); return this; }
    [Symbol.dispose]() { this.close(); }
  }
  fsmod.watch = (filename, options, listener) => {
    const given = pathOf(filename), p = N.path.resolve(given);
    if (typeof options === 'function') { listener = options; options = {}; }
    options = optsOf(options, { persistent: true });
    const first = statAt(given, 0, 'watch');                                   // ENOENT ... watch 'x', as Node throws it
    const w = new FSWatcher(), base = N.path.basename(p), enc = (n) => (options.encoding === 'buffer' ? Buffer.from(n) : n);
    if (listener) w.on('change', listener);
    const dir = first.isDirectory();
    let was = snapshot(p, options.recursive);
    w._timer = N.timers.setInterval(() => {
      const now = snapshot(p, options.recursive);
      if (!dir) {
        if (!now.st !== !was.st) w.emit('change', 'rename', enc(base));
        else if (now.st && !sameStat(now.st, was.st)) w.emit('change', 'change', enc(base));
      } else {
        for (const [n, s] of now.out) { const o = was.out.get(n); if (!o || o.ino !== s.ino) w.emit('change', 'rename', enc(n)); else if (!s.isDirectory() && !sameStat(o, s)) w.emit('change', 'change', enc(n)); }
        for (const n of was.out.keys()) if (!now.out.has(n)) w.emit('change', 'rename', enc(n));
      }
      was = now;
    }, 100);
    if (!options.persistent) w._timer.unref();
    if (options.signal) { if (options.signal.aborted) w.close(); else options.signal.addEventListener('abort', () => w.close(), { once: true }); }
    return w;
  };
  fsmod.StatWatcher = StatWatcher; fsmod.FSWatcher = FSWatcher;
  N.fs = fsmod;
  N.fsio = { readSync, writeSync, fstatSync, statAt, readAll };
}
