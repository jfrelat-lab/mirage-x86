// wasi.js — WASI preview 1 (wasi_snapshot_preview1) on MIRAGE-LINUX's system calls.
//
// A WebAssembly program built for WASI (wasm32-wasi, wasm32-wasip1) runs as a process of the Linux
// machine (src/linux.js): its pid, its descriptors, its directory and its files are the kernel's, the
// same ones its x86 parent, its pipes and its terminal have. Each WASI function is answered as wasi-libc
// answers it on Linux: by i386 system calls, here made straight to the kernel's table (`k.sys`). Their
// pointers are into a buffer of the process's own address space (`k.va`, `k.size` bytes): what a call
// reads is copied there from the program's linear memory first, what it writes copied back after.
//
// The descriptors are the kernel's numbers as they are: 0-2 what the process was given, 3 and 4 the
// two directories WASI programs are given ("preopens"): 3 is "/", the root, and 4 is ".", the working
// directory. Rights are not kept: every descriptor may do what its open file may.
//
// The program runs to its end inside one call of its process (k.run). A call that would wait (input
// not there yet) answers EAGAIN: a WASI program here reads what is already written.

const ERRNO = {                          // Linux errno -> WASI errno
  1: 63, 2: 44, 3: 71, 4: 27, 5: 29, 6: 60, 7: 1, 8: 45, 9: 8, 10: 12, 11: 6, 12: 48, 13: 2, 14: 21, 16: 10, 17: 20,
  18: 75, 19: 43, 20: 54, 21: 31, 22: 28, 23: 41, 24: 33, 25: 59, 26: 74, 27: 22, 28: 51, 29: 70, 30: 69, 31: 34,
  32: 64, 33: 18, 34: 68, 35: 16, 36: 37, 37: 46, 38: 52, 39: 55, 40: 32, 75: 61, 88: 57, 95: 58, 104: 15, 107: 53,
  110: 73, 111: 14,
};
const E = { BADF: 8, INVAL: 28, NOSYS: 52, NOTSUP: 58, FAULT: 21, AGAIN: 6, NOTDIR: 54, NAMETOOLONG: 37 };
const wasiErr = (r) => (r >= 0 ? 0 : ERRNO[-r] ?? 29);   // EIO when there is no counterpart

// File types: WASI's from a Linux mode, and from a d_type.
const typeOfMode = (m) => ({ 0o040000: 3, 0o100000: 4, 0o120000: 7, 0o020000: 2, 0o060000: 1, 0o140000: 6 })[m & 0o170000] ?? 0;
const typeOfDtype = (t) => ({ 4: 3, 8: 4, 10: 7, 2: 2, 6: 1, 12: 6 })[t] ?? 0;
const ALL_RIGHTS = 0x1fffffffn;

/** The exit of the program: proc_exit, as a throw through its frames. */
export class WasiExit { constructor(code) { this.code = code; } }

/**
 * A WASI program's imports, on a kernel `k`:
 *   k.sys(n, a, b, c, d, e, f)  an i386 system call: its result, a negative errno, or k.BLOCK
 *   k.va, k.size                the buffer of the process's address space the calls' pointers go to
 *   k.put(off, bytes), k.get(off, len)   its bytes, from the kernel's side
 *   argv, envp                  the program's arguments and environment
 * Returns { imports, bind(instance) }.
 */
export function wasiImports(k, argv, envp) {
  let mem = null;                                    // the program's linear memory, once instantiated
  const u8 = () => new Uint8Array(mem.buffer);
  const dv = () => new DataView(mem.buffer);
  const enc = new TextEncoder();
  const B = k.va, SIZE = k.size;
  const sys = (...a) => { const r = k.sys(...a); return r === k.BLOCK ? -11 : r; };   // EAGAIN: no waiting here
  // The buffer as a stack of what one call needs, from its start.
  let top = 0;
  const alloc = (n) => { const at = top; top = (top + n + 7) & ~7; if (top > SIZE) throw new RangeError('wasi: buffer'); return B + at; };
  const putBytes = (bytes) => { const va = alloc(bytes.length); k.put(va - B, bytes); return va; };
  const putStr = (s) => putBytes(enc.encode(s + '\0'));
  const getBytes = (va, n) => k.get(va - B, n);
  const call = (f) => (...a) => {
    top = 0;
    try { return f(...a); } catch (e) { if (e instanceof WasiExit) throw e; if (e instanceof RangeError && /^wasi:|offset|bounds/.test(e.message)) return E.FAULT; throw e; }
  };
  const path = (ptr, len) => {
    if (len > 4095) throw E.NAMETOOLONG;
    let s = ''; const b = u8().subarray(ptr, ptr + len);
    for (const c of b) { if (!c) return null; s += String.fromCharCode(c); }  // bytes as the kernel takes them
    return s;
  };
  const pathCall = (f) => call((...a) => { try { return f(...a); } catch (e) { if (typeof e === 'number') return e; throw e; } });
  const pathArg = (ptr, len) => { const p = path(ptr, len); if (p === null) throw E.INVAL; return putStr(p); };

  // iovecs: { buf u32, len u32 } * n
  const iovs = (ptr, n) => { const d = dv(), out = []; for (let i = 0; i < n; i++) out.push([d.getUint32(ptr + i * 8, true), d.getUint32(ptr + i * 8 + 4, true)]); return out; };
  const gather = (ptr, n) => {
    const list = iovs(ptr, n); let total = 0;
    for (const [, l] of list) total += l;
    const b = new Uint8Array(Math.min(total, SIZE - 64)); let at = 0;
    for (const [p, l] of list) { const t = Math.min(l, b.length - at); b.set(u8().subarray(p, p + t), at); at += t; if (at === b.length) break; }
    return b;
  };
  const scatter = (ptr, n, bytes) => {
    let at = 0;
    for (const [p, l] of iovs(ptr, n)) { const t = Math.min(l, bytes.length - at); u8().set(bytes.subarray(at, at + t), p); at += t; if (at === bytes.length) break; }
  };
  const readInto = (iovPtr, n, read) => {          // one read of the buffers' length, scattered
    let want = 0; for (const [, l] of iovs(iovPtr, n)) want += l;
    want = Math.min(want, SIZE - 64);
    const va = alloc(want), r = read(va, want);
    if (r > 0) scatter(iovPtr, n, getBytes(va, r));
    return r;
  };
  const u64 = (v) => BigInt.asUintN(64, BigInt(v));
  const split64 = (v) => { v = BigInt.asUintN(64, v); return [Number(v & 0xffffffffn), Number(v >> 32n)]; };

  // struct stat64 (i386) -> filestat
  const stat64 = (va) => {
    const s = new DataView(getBytes(va, 96).buffer), lo = (o) => s.getUint32(o, true);
    const ns = (o) => BigInt(lo(o)) * 1000000000n + BigInt(lo(o + 4));
    return { dev: s.getBigUint64(0, true), ino: s.getBigUint64(88, true), type: typeOfMode(lo(16)), nlink: BigInt(lo(20)),
      size: s.getBigUint64(44, true), atim: ns(64), mtim: ns(72), ctim: ns(80) };
  };
  const putFilestat = (ptr, st) => {
    const d = dv();
    d.setBigUint64(ptr, st.dev, true); d.setBigUint64(ptr + 8, st.ino, true); d.setUint8(ptr + 16, st.type);
    d.setBigUint64(ptr + 24, st.nlink, true); d.setBigUint64(ptr + 32, st.size, true);
    d.setBigUint64(ptr + 40, st.atim, true); d.setBigUint64(ptr + 48, st.mtim, true); d.setBigUint64(ptr + 56, st.ctim, true);
  };
  // timespec pairs for utimensat: a time, UTIME_NOW, or UTIME_OMIT (fstflags: ATIM 1, ATIM_NOW 2, MTIM 4, MTIM_NOW 8)
  const times = (atim, mtim, fl) => {
    const b = new DataView(new ArrayBuffer(16));
    const one = (o, t, set, now) => {
      if (now) { b.setUint32(o + 4, 0x3fffffff, true); return; }                           // UTIME_NOW
      if (!set) { b.setUint32(o + 4, 0x3ffffffe, true); return; }                          // UTIME_OMIT
      b.setUint32(o, Number(t / 1000000000n), true); b.setUint32(o + 4, Number(t % 1000000000n), true);
    };
    one(0, atim, fl & 1, fl & 2); one(8, mtim, fl & 4, fl & 8);
    return putBytes(new Uint8Array(b.buffer));
  };

  // The preopened directories, by descriptor.
  const preopens = new Map([[3, '/'], [4, '.']]);
  // fd_readdir's cookies are entry indexes: the directory read again from its start for each call.
  const entries = (fd) => {
    if (sys(140, fd, 0, 0, alloc(8), 0) < 0) return null;              // _llseek to the start
    const out = [], buf = alloc(32768);
    for (;;) {
      const n = sys(220, fd, buf, 32768);
      if (n < 0) return out.length ? out : n;
      if (!n) return out;
      const b = getBytes(buf, n), d = new DataView(b.buffer);
      for (let o = 0; o < n;) {
        const rl = d.getUint16(o + 16, true); let e = o + 19; while (b[e]) e++;
        out.push({ ino: d.getBigUint64(o, true), type: typeOfDtype(b[o + 18]), name: b.slice(o + 19, e) });
        o += rl;
      }
    }
  };

  const W = {
    args_sizes_get: call((argc, size) => { const d = dv(); d.setUint32(argc, argv.length, true); d.setUint32(size, argv.reduce((n, a) => n + enc.encode(a).length + 1, 0), true); return 0; }),
    args_get: call((ptrs, buf) => { strings(argv, ptrs, buf); return 0; }),
    environ_sizes_get: call((n, size) => { const d = dv(); d.setUint32(n, envp.length, true); d.setUint32(size, envp.reduce((t, a) => t + enc.encode(a).length + 1, 0), true); return 0; }),
    environ_get: call((ptrs, buf) => { strings(envp, ptrs, buf); return 0; }),

    clock_res_get: call((id, out) => { const ts = alloc(8), r = sys(266, id, ts); if (r < 0) return wasiErr(r); dv().setBigUint64(out, timespec(ts), true); return 0; }),
    clock_time_get: call((id, precision, out) => { const ts = alloc(8), r = sys(265, id, ts); if (r < 0) return wasiErr(r); dv().setBigUint64(out, timespec(ts), true); return 0; }),

    fd_write: call((fd, iov, n, nw) => { const b = gather(iov, n), r = sys(4, fd, putBytes(b), b.length); if (r < 0) return wasiErr(r); dv().setUint32(nw, r, true); return 0; }),
    fd_read: call((fd, iov, n, nr) => { const r = readInto(iov, n, (va, len) => sys(3, fd, va, len)); if (r < 0) return wasiErr(r); dv().setUint32(nr, r, true); return 0; }),
    fd_pwrite: call((fd, iov, n, off, nw) => { const b = gather(iov, n), [lo, hi] = split64(off), r = sys(181, fd, putBytes(b), b.length, lo, hi); if (r < 0) return wasiErr(r); dv().setUint32(nw, r, true); return 0; }),
    fd_pread: call((fd, iov, n, off, nr) => { const [lo, hi] = split64(off), r = readInto(iov, n, (va, len) => sys(180, fd, va, len, lo, hi)); if (r < 0) return wasiErr(r); dv().setUint32(nr, r, true); return 0; }),
    fd_seek: call((fd, off, whence, out) => {
      if (whence > 2) return E.INVAL;
      const [lo, hi] = split64(off), res = alloc(8), r = sys(140, fd, hi, lo, res, whence);   // _llseek: whence as Linux's
      if (r < 0) return wasiErr(r);
      dv().setBigUint64(out, new DataView(getBytes(res, 8).buffer).getBigUint64(0, true), true); return 0;
    }),
    fd_tell: call((fd, out) => W.fd_seek(fd, 0n, 1, out)),
    fd_close: call((fd) => { const r = sys(6, fd); if (r >= 0) preopens.delete(fd); return wasiErr(r); }),
    fd_sync: call((fd) => wasiErr(sys(118, fd))),
    fd_datasync: call((fd) => wasiErr(sys(148, fd))),
    fd_advise: call(() => 0),
    fd_allocate: call((fd, off, len) => {
      const st = alloc(96), r = sys(197, fd, st); if (r < 0) return wasiErr(r);
      const want = BigInt.asUintN(64, off + len);
      if (want <= stat64(st).size) return 0;
      const [lo, hi] = split64(want); return wasiErr(sys(194, fd, lo, hi));
    }),
    fd_fdstat_get: call((fd, out) => {
      const st = alloc(96), r = sys(197, fd, st); if (r < 0) return wasiErr(r);
      const fl = sys(221, fd, 3, 0);                                    // F_GETFL
      const d = dv(); d.setUint8(out, stat64(st).type);
      d.setUint16(out + 2, (fl & 0x400 ? 1 : 0) | (fl & 0x800 ? 4 : 0) | (fl & 0x101000 ? 16 : 0), true);   // APPEND NONBLOCK SYNC
      d.setBigUint64(out + 8, ALL_RIGHTS, true); d.setBigUint64(out + 16, ALL_RIGHTS, true); return 0;
    }),
    fd_fdstat_set_flags: call((fd, flags) => wasiErr(sys(221, fd, 4, (flags & 1 ? 0x400 : 0) | (flags & 4 ? 0x800 : 0)))),   // F_SETFL
    fd_fdstat_set_rights: call(() => 0),
    fd_filestat_get: call((fd, out) => { const st = alloc(96), r = sys(197, fd, st); if (r < 0) return wasiErr(r); putFilestat(out, stat64(st)); return 0; }),
    fd_filestat_set_size: call((fd, size) => { const [lo, hi] = split64(size); return wasiErr(sys(194, fd, lo, hi)); }),
    fd_filestat_set_times: call((fd, atim, mtim, fl) => wasiErr(sys(320, fd, 0, times(atim, mtim, fl), 0))),
    fd_prestat_get: call((fd, out) => {
      const name = preopens.get(fd); if (name === undefined) return E.BADF;
      const d = dv(); d.setUint8(out, 0); d.setUint32(out + 4, enc.encode(name).length, true); return 0;
    }),
    fd_prestat_dir_name: call((fd, p, len) => {
      const name = preopens.get(fd); if (name === undefined) return E.BADF;
      const b = enc.encode(name); if (len < b.length) return E.INVAL; u8().set(b, p); return 0;
    }),
    fd_renumber: call((from, to) => { let r = sys(63, from, to); if (r < 0) return wasiErr(r); if (from !== to) { sys(6, from); if (preopens.has(from)) { preopens.set(to, preopens.get(from)); preopens.delete(from); } else preopens.delete(to); } return 0; }),
    fd_readdir: call((fd, buf, len, cookie, used) => {
      const list = entries(fd); if (typeof list === 'number') return wasiErr(list); if (!list) return E.BADF;
      const d = dv(); let at = 0;
      for (let i = Number(cookie); i < list.length && at < len; i++) {
        const e = list[i], h = new DataView(new ArrayBuffer(24));
        h.setBigUint64(0, BigInt(i + 1), true); h.setBigUint64(8, e.ino, true); h.setUint32(16, e.name.length, true); h.setUint8(20, e.type);
        const rec = new Uint8Array(24 + e.name.length); rec.set(new Uint8Array(h.buffer)); rec.set(e.name, 24);
        const t = Math.min(rec.length, len - at); u8().set(rec.subarray(0, t), buf + at); at += t;   // the last one cut if it does not fit
      }
      d.setUint32(used, at, true); return 0;
    }),

    path_open: pathCall((dirfd, dirflags, p, plen, oflags, rights, inheriting, fdflags, out) => {
      // Written to if it may be (FD_DATASYNC, FD_WRITE, FD_ALLOCATE, FD_FILESTAT_SET_SIZE: what wasi-libc
      // adds for O_WRONLY), read if it may be (FD_READ, FD_READDIR) -- as uvwasi decides.
      const wr = (rights & 0x400141n) !== 0n, rd = (rights & 0x4002n) !== 0n || !wr;
      let flags = (oflags & 2 ? 0 : wr ? (rd ? 2 : 1) : 0) | 0x8000;                                     // O_LARGEFILE
      if (oflags & 1) flags |= 0x40; if (oflags & 2) flags |= 0x10000; if (oflags & 4) flags |= 0x80; if (oflags & 8) flags |= 0x200;   // CREAT DIRECTORY EXCL TRUNC
      if (fdflags & 1) flags |= 0x400; if (fdflags & 4) flags |= 0x800;                                  // APPEND NONBLOCK
      if (!(dirflags & 1)) flags |= 0x20000;                                                             // O_NOFOLLOW
      const r = sys(295, dirfd, pathArg(p, plen), flags, 0o666);
      if (r < 0) return wasiErr(r);
      dv().setUint32(out, r, true); return 0;
    }),
    path_create_directory: pathCall((dirfd, p, len) => wasiErr(sys(296, dirfd, pathArg(p, len), 0o777))),
    path_remove_directory: pathCall((dirfd, p, len) => wasiErr(sys(301, dirfd, pathArg(p, len), 0x200))),
    path_unlink_file: pathCall((dirfd, p, len) => wasiErr(sys(301, dirfd, pathArg(p, len), 0))),
    path_rename: pathCall((da, pa, la, db, pb, lb) => wasiErr(sys(302, da, pathArg(pa, la), db, pathArg(pb, lb)))),
    path_link: pathCall((da, fl, pa, la, db, pb, lb) => wasiErr(sys(303, da, pathArg(pa, la), db, pathArg(pb, lb), fl & 1 ? 0x400 : 0))),
    path_symlink: pathCall((pa, la, dirfd, pb, lb) => wasiErr(sys(304, pathArg(pa, la), dirfd, pathArg(pb, lb)))),
    path_readlink: pathCall((dirfd, p, len, buf, blen, used) => {
      const at = alloc(Math.max(blen, 1)), r = sys(305, dirfd, pathArg(p, len), at, blen);
      if (r < 0) return wasiErr(r);
      u8().set(getBytes(at, r), buf); dv().setUint32(used, r, true); return 0;
    }),
    path_filestat_get: pathCall((dirfd, fl, p, len, out) => {
      const st = alloc(96), r = sys(300, dirfd, pathArg(p, len), st, fl & 1 ? 0 : 0x100);   // AT_SYMLINK_NOFOLLOW unless asked to follow
      if (r < 0) return wasiErr(r); putFilestat(out, stat64(st)); return 0;
    }),
    path_filestat_set_times: pathCall((dirfd, fl, p, len, atim, mtim, tf) => wasiErr(sys(320, dirfd, pathArg(p, len), times(atim, mtim, tf), fl & 1 ? 0 : 0x100))),

    poll_oneoff: call((inp, outp, n, nev) => {
      // Subscriptions of 48 bytes: userdata, tag (0 clock, 1 fd_read, 2 fd_write), then the clock's
      // id, timeout, precision and flags (bit 0: an absolute time) or the descriptor.
      const d = dv(), subs = [];
      for (let i = 0; i < n; i++) {
        const s = inp + i * 48, tag = d.getUint8(s + 8);
        subs.push(tag === 0
          ? { ud: d.getBigUint64(s, true), tag, id: d.getUint32(s + 16, true), t: d.getBigUint64(s + 24, true), abs: d.getUint16(s + 40, true) & 1 }
          : { ud: d.getBigUint64(s, true), tag, fd: d.getUint32(s + 16, true) });
      }
      const now = (id) => { const ts = alloc(8); sys(265, id, ts); return timespec(ts); };
      // The nearest deadline, in nanoseconds from now.
      let wait = null;
      for (const s of subs) if (s.tag === 0) { const left = s.abs ? s.t - now(s.id) : s.t; const l = left < 0n ? 0n : left; if (wait === null || l < wait) wait = l; }
      const fdSubs = subs.filter((s) => s.tag !== 0), events = [];
      if (fdSubs.length) {
        const pf = alloc(8 * fdSubs.length), b = new DataView(new ArrayBuffer(8 * fdSubs.length));
        fdSubs.forEach((s, i) => { b.setInt32(i * 8, s.fd, true); b.setInt16(i * 8 + 4, s.tag === 1 ? 1 : 4, true); });   // POLLIN, POLLOUT
        k.put(pf - B, new Uint8Array(b.buffer));
        const r = sys(168, pf, fdSubs.length, 0);
        const got = new DataView(getBytes(pf, 8 * fdSubs.length).buffer);
        fdSubs.forEach((s, i) => {
          const rev = got.getInt16(i * 8 + 6, true);
          if (r < 0) events.push({ ud: s.ud, err: wasiErr(r), type: s.tag });
          else if (rev & 0x20) events.push({ ud: s.ud, err: E.BADF, type: s.tag });                         // POLLNVAL
          else if (rev) events.push({ ud: s.ud, err: 0, type: s.tag, hup: (rev & 0x10) !== 0, nbytes: 0n }); // POLLHUP
        });
      }
      if (!events.length && wait !== null) {
        if (wait > 0n) {                                                // nanosleep: the guest's clock goes there
          const ts = new DataView(new ArrayBuffer(8)); ts.setUint32(0, Number(wait / 1000000000n), true); ts.setUint32(4, Number(wait % 1000000000n), true);
          const req = putBytes(new Uint8Array(ts.buffer));
          k.sleep ? k.sleep(Number(wait) / 1e9) : sys(162, req, 0);
        }
        for (const s of subs) if (s.tag === 0) { const left = s.abs ? s.t - now(s.id) : s.t - wait; if (left <= 0n) events.push({ ud: s.ud, err: 0, type: 0 }); }
        if (!events.length) for (const s of subs) if (s.tag === 0) { events.push({ ud: s.ud, err: 0, type: 0 }); break; }
      }
      events.forEach((e, i) => {
        const o = outp + i * 32;
        d.setBigUint64(o, e.ud, true); d.setUint16(o + 8, e.err, true); d.setUint8(o + 10, e.type);
        d.setBigUint64(o + 16, e.nbytes ?? 0n, true); d.setUint16(o + 24, e.hup ? 1 : 0, true);
      });
      d.setUint32(nev, events.length, true); return 0;
    }),
    proc_exit: (code) => { throw new WasiExit(code >>> 0); },
    proc_raise: call((sig) => wasiErr(sys(37, sys(20), sig))),
    sched_yield: call(() => 0),
    random_get: call((buf, len) => {
      for (let at = 0; at < len;) {
        const n = Math.min(len - at, SIZE - 64), va = alloc(n), r = sys(355, va, n, 0);
        if (r < 0) return wasiErr(r);
        u8().set(getBytes(va, r), buf + at); at += r; top = 0;
      }
      return 0;
    }),
    sock_accept: () => E.NOTSUP, sock_recv: () => E.NOTSUP, sock_send: () => E.NOTSUP, sock_shutdown: () => E.NOTSUP,
  };
  function strings(list, ptrs, buf) {
    const d = dv();
    list.forEach((s, i) => { const b = enc.encode(s + '\0'); d.setUint32(ptrs + i * 4, buf, true); u8().set(b, buf); buf += b.length; });
  }
  function timespec(va) { const t = new DataView(getBytes(va, 8).buffer); return BigInt(t.getUint32(0, true)) * 1000000000n + BigInt(t.getUint32(4, true)); }

  return {
    imports: { wasi_snapshot_preview1: W },
    bind(instance) { mem = instance.exports.memory; },
  };
}

/** Is it a WebAssembly module? Its magic, \0asm, and version 1. */
export const isWasm = (b) => b && b.length >= 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d && b[4] === 1;
