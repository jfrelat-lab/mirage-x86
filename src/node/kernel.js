// kernel.js — the HLE node's way to the kernel: i386 system calls through the bridge, strings in UTF-8,
// errors as Node makes them (libuv's codes and messages).
//
// Every file of src/node but host.js and worker.js is one function `part(N)` that runs in the guest's
// realm (src/node/worker.js evaluates its source there): it may use nothing of its module, only N, the
// namespace the parts share, and what the realm has (the language's own objects).
//
// The bridge (N.bridge, src/node/worker.js): sys(top, n, a..f) makes system call n; its pointers are into
// a buffer of the process's address space (base, size bytes), which the kernel's side copies from the
// bridge's own (buf) up to `top` before the call and back after.
export function kernel(N) {
  const b = N.bridge, BASE = b.base, SIZE = b.size, buf = b.buf;
  let top = 0;
  /** A call's room: alloc(n) is an address in the process; scope(f) frees what f took. */
  const alloc = (n) => { const at = top; top = (top + n + 7) & ~7; if (top > SIZE) throw new RangeError('node: the system call buffer is full'); return BASE + at; };
  const scope = (f) => { const mark = top; try { return f(); } finally { top = mark; } };
  const sys = (n, a = 0, c = 0, d = 0, e = 0, f = 0, g = 0) => b.sys(top, n, a, c, d, e, f, g);
  const put = (va, bytes) => { buf.set(bytes, va - BASE); };
  const get = (va, n) => buf.slice(va - BASE, va - BASE + n);
  const view = () => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (va) => view().getUint32(va - BASE, true);
  const i32 = (va) => view().getInt32(va - BASE, true);
  const setU32 = (va, v) => view().setUint32(va - BASE, v >>> 0, true);

  // UTF-8, as WHATWG's encoder and decoder (a lone surrogate, a bad sequence: U+FFFD, maximal subparts).
  const utf8Encode = (s) => {
    const out = new Uint8Array(s.length * 3); let o = 0;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd; }
      else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) out[o++] = c;
      else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 63); }
      else if (c < 0x10000) { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
      else { out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 63); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
    }
    return out.slice(0, o);
  };
  const utf8Decode = (u, start = 0, end = u.length) => {
    let s = '', chunk = [];
    const flush = () => { s += String.fromCharCode.apply(null, chunk); chunk = []; };
    const push = (c) => { if (c > 0xffff) { c -= 0x10000; chunk.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); } else chunk.push(c); if (chunk.length > 8000) flush(); };
    for (let i = start; i < end;) {
      const c = u[i];
      if (c < 0x80) { push(c); i++; continue; }
      let need, cp, lo = 0x80, hi = 0xbf;
      if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 31; }
      else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 15; if (c === 0xe0) lo = 0xa0; if (c === 0xed) hi = 0x9f; }
      else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 7; if (c === 0xf0) lo = 0x90; if (c === 0xf4) hi = 0x8f; }
      else { push(0xfffd); i++; continue; }
      let j = i + 1, ok = true;
      for (let k = 0; k < need; k++, j++) {
        const x = u[j];
        if (j >= end || x < lo || x > hi) { ok = false; break; }
        cp = (cp << 6) | (x & 63); lo = 0x80; hi = 0xbf;
      }
      push(ok ? cp : 0xfffd); i = j;
    }
    flush();
    return s;
  };
  const str = (s) => { const e = utf8Encode(String(s)), va = alloc(e.length + 1); put(va, e); buf[va - BASE + e.length] = 0; return va; };
  const cstr = (va) => { const o = va - BASE; let e = o; while (buf[e]) e++; return utf8Decode(buf, o, e); };

  // libuv's names and messages for Linux's errnos.
  const ERRORS = {
    1: ['EPERM', 'operation not permitted'], 2: ['ENOENT', 'no such file or directory'], 3: ['ESRCH', 'no such process'],
    4: ['EINTR', 'interrupted system call'], 5: ['EIO', 'i/o error'], 6: ['ENXIO', 'no such device or address'],
    7: ['E2BIG', 'argument list too long'], 9: ['EBADF', 'bad file descriptor'], 10: ['ECHILD', 'no child processes'], 11: ['EAGAIN', 'resource temporarily unavailable'],
    12: ['ENOMEM', 'not enough memory'], 13: ['EACCES', 'permission denied'], 14: ['EFAULT', 'bad address in system call argument'],
    16: ['EBUSY', 'resource busy or locked'], 17: ['EEXIST', 'file already exists'], 18: ['EXDEV', 'cross-device link not permitted'],
    19: ['ENODEV', 'no such device'], 20: ['ENOTDIR', 'not a directory'], 21: ['EISDIR', 'illegal operation on a directory'],
    22: ['EINVAL', 'invalid argument'], 23: ['ENFILE', 'file table overflow'], 24: ['EMFILE', 'too many open files'],
    25: ['ENOTTY', 'inappropriate ioctl for device'], 27: ['EFBIG', 'file too large'], 28: ['ENOSPC', 'no space left on device'],
    29: ['ESPIPE', 'invalid seek'], 30: ['EROFS', 'read-only file system'], 31: ['EMLINK', 'too many links'], 32: ['EPIPE', 'broken pipe'],
    34: ['ERANGE', 'result too large'], 36: ['ENAMETOOLONG', 'name too long'], 38: ['ENOSYS', 'function not implemented'],
    39: ['ENOTEMPTY', 'directory not empty'], 40: ['ELOOP', 'too many symbolic links encountered'],
  };
  const NAMES = {}; for (const [n, [name]] of Object.entries(ERRORS)) NAMES[name] = -n;
  /** A system call's failure as Node throws it: "ENOENT: no such file or directory, open 'x'". */
  const uvError = (r, syscall, path, dest) => {
    const [code, msg] = ERRORS[-r] || ['UNKNOWN', 'unknown error'];
    const e = new Error(`${code}: ${msg}, ${syscall}${path !== undefined ? ` '${path}'` : ''}${dest !== undefined ? ` -> '${dest}'` : ''}`);
    e.errno = r; e.code = code; e.syscall = syscall;
    if (path !== undefined) e.path = path;
    if (dest !== undefined) e.dest = dest;
    return e;
  };
  /** A Node error with its code: "TypeError [ERR_X]: ..." as Node names them. */
  const nodeError = (Ctor, code, msg) => {
    const e = new Ctor(msg);
    Object.defineProperty(e, 'code', { value: code, enumerable: true, writable: true, configurable: true });
    const name = e.name; e.name = `${name} [${code}]`; void e.stack; e.name = name;   // the stack says the code, as Node's does
    return e;
  };
  const typeName = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : typeof v === 'function' ? `function ${v.name}` : typeof v === 'object' ? (v.constructor && v.constructor.name ? `an instance of ${v.constructor.name}` : N.inspect ? N.inspect(v, { depth: -1 }) : 'an object') : `type ${typeof v} (${typeof v === 'string' ? `'${v.length > 25 ? v.slice(0, 25) + '...' : v}'` : String(v)})`);
  const invalidArg = (name, what, v) => nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${what}. Received ${typeName(v)}`);
  const checkString = (v, name) => { if (typeof v !== 'string') throw invalidArg(name, 'of type string', v); };

  // The clocks: the guest's (clock_gettime), in milliseconds.
  const clock = (id) => scope(() => { const ts = alloc(8); sys(265, id, ts); return u32(ts) * 1000 + u32(ts + 4) / 1e6; });
  const clockNs = (id) => scope(() => { const ts = alloc(8); sys(265, id, ts); return BigInt(u32(ts)) * 1000000000n + BigInt(u32(ts + 4)); });

  Object.assign(N, { alloc, scope, sys, put, get, view, u32, i32, setU32, str, cstr, utf8Encode, utf8Decode, uvError, nodeError, invalidArg, checkString, typeName, ERRORS, ERRNO: NAMES, clock, clockNs, BASE, SIZE, buf });
}
