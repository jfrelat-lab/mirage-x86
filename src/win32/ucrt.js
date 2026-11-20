// ucrt.js — the Universal C Runtime of Windows 10, which every program built with Visual C++ 2015 and
// later imports by its api-ms-win-crt-*-l1-1-0.dll names (an "API set": the same functions, in
// ucrtbase.dll), with vcruntime140.dll beside it: the compiler's own helpers (memcpy, the exception
// machinery). Made here in JavaScript, cdecl, as msvcrt.dll is in api.js.
//
// Files are the program's disk (api.js: C:, the program's directory) through the same handles kernel32
// gives (st.files), a FILE a block of the heap the runtime names; stdout and stderr are the process's.
// A FILE is never read through its fields by these programs (the runtime's own code reads them, and the
// runtime is here), so its 32 bytes only carry an index.

const cd = { cdecl: true };

/** The API-set names a program imports, each one a part of ucrtbase.dll. */
export const UCRT_SETS = ['conio', 'convert', 'environment', 'filesystem', 'heap', 'locale', 'math', 'multibyte', 'private', 'process', 'runtime', 'stdio', 'string', 'time', 'utility'];

/** C's printf, from `fmt` and the arguments at `ap` (cdecl's varargs: 4 bytes each, 8 for a double or a 64-bit integer). */
export function cprintf(x, fmt, ap, wide = false) {
  let out = '';
  const rd = (n) => { const v = n === 8 ? x.r32(ap) + x.r32(ap + 4) * 4294967296 : x.r32(ap); ap += n; return v; };
  const rdI64 = (signed) => { const lo = BigInt(x.r32(ap)), hi = BigInt(x.r32(ap + 4)); ap += 8; const v = (hi << 32n) | lo; return signed ? BigInt.asIntN(64, v) : v; };
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== '%') { out += fmt[i]; continue; }
    const m = /^([-+ 0#]*)(\*|\d*)(?:\.(\*|\d*))?(hh|h|ll|l|L|I64|I32|I|z|j|t|w)?([diouxXcsSpeEfFgGaAn%])/.exec(fmt.slice(i + 1));
    if (!m) { out += '%'; continue; }
    i += m[0].length;
    let [, flags, width, prec, len, c] = m;
    if (width === '*') { width = String(rd(4) | 0); if (+width < 0) { flags += '-'; width = String(-width); } }
    if (prec === '*') { const p = rd(4) | 0; prec = p < 0 ? undefined : String(p); }
    const p = prec === undefined || prec === '' ? (prec === '' ? 0 : undefined) : +prec;
    const big = len === 'll' || len === 'I64' || len === 'j';
    let v, num = false, neg = false;
    if (c === '%') v = '%';
    else if (c === 'n') { x.w32(rd(4), out.length); continue; }
    else if (c === 'c') v = String.fromCharCode(rd(4) & (len === 'l' || len === 'w' || wide ? 0xffff : 0xff));
    else if (c === 's' || c === 'S') {
      const q = rd(4), w = (c === 'S') !== wide || len === 'l' || len === 'w';
      if (!q) v = '(null)';
      else if (w) { v = ''; for (let k = 0; p === undefined || k < p; k++) { const ch = x.r16(q + 2 * k); if (!ch) break; v += String.fromCharCode(ch); } }
      else v = x.str(q, p === undefined ? 1 << 20 : p);
    } else if ('eEfFgGaA'.includes(c)) {
      const d = x.f64(ap); ap += 8; num = true;
      neg = d < 0 || Object.is(d, -0); const a = Math.abs(d), pr = p === undefined ? 6 : p;
      if (!Number.isFinite(a)) v = Number.isNaN(a) ? 'nan' : 'inf';
      else if (c === 'f' || c === 'F') v = a.toFixed(Math.min(pr, 100));
      else if (c === 'e' || c === 'E') v = expo(a, pr);
      else if (c === 'a' || c === 'A') v = a.toString(16);
      else {
        const P = pr === 0 ? 1 : pr, e = a === 0 ? 0 : Math.floor(Math.log10(a));
        let t = e < -4 || e >= P ? expo(a, P - 1) : a.toFixed(Math.max(0, P - 1 - e));
        if (!flags.includes('#')) t = t.includes('e') ? t.replace(/\.?0+e/, 'e') : t.includes('.') ? t.replace(/\.?0+$/, '') : t;
        v = t;
      }
      if (c === 'E' || c === 'G' || c === 'F' || c === 'A') v = v.toUpperCase();
    } else {
      num = true;
      let n;
      if (c === 'p') { n = BigInt(rd(4)); v = n.toString(16).toUpperCase().padStart(8, '0'); }
      else {
        const signed = c === 'd' || c === 'i';
        if (big) n = rdI64(signed);
        else { const r = rd(4); n = BigInt(signed ? (len === 'hh' ? (r << 24) >> 24 : len === 'h' ? (r << 16) >> 16 : r | 0) : len === 'hh' ? r & 0xff : len === 'h' ? r & 0xffff : r >>> 0); }
        neg = n < 0n; if (neg) n = -n;
        v = c === 'o' ? n.toString(8) : c === 'x' ? n.toString(16) : c === 'X' ? n.toString(16).toUpperCase() : n.toString();
        if (p !== undefined) v = p === 0 && n === 0n ? '' : v.padStart(p, '0');
        if (flags.includes('#') && n !== 0n) v = (c === 'x' ? '0x' : c === 'X' ? '0X' : c === 'o' ? '0' : '') + v;
      }
    }
    if (num) { const sign = neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''; if (sign) v = sign + v; }
    if (width && v.length < +width) {
      if (flags.includes('-')) v = v.padEnd(+width);
      else if (flags.includes('0') && num && (p === undefined || !'diouxX'.includes(c))) { const s = /^[-+ ]/.test(v) ? v[0] : ''; v = s + v.slice(s.length).padStart(+width - s.length, '0'); }
      else v = v.padStart(+width);
    }
    out += v;
  }
  return out;
}
const expo = (a, pr) => { const [m, e] = a.toExponential(Math.min(pr, 100)).split('e'); const n = +e; return `${m}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`; };

/** C's scanf over the string `s`, storing through the pointers at `ap`; the fields assigned, or -1 at once at the end. */
export function cscanf(x, s, fmt, ap) {
  let at = 0, n = 0;
  const ptr = () => { const p = x.r32(ap); ap += 4; return p; };
  for (let i = 0; i < fmt.length; i++) {
    const f = fmt[i];
    if (/\s/.test(f)) { while (at < s.length && /\s/.test(s[at])) at++; continue; }
    if (f !== '%') { if (s[at] !== f) return n; at++; continue; }
    const m = /^(\*)?(\d*)(hh|h|ll|l|L|I64)?([diouxXcsfeEgGn%]|\[\^?\]?[^\]]*\])/.exec(fmt.slice(i + 1));
    if (!m) return n;
    i += m[0].length;
    const [, skip, width, len, c] = m, w = width ? +width : Infinity;
    if (c === '%') { if (s[at] !== '%') return n; at++; continue; }
    if (c === 'n') { if (!skip) x.w32(ptr(), at); continue; }
    if (c !== 'c' && c[0] !== '[') while (at < s.length && /\s/.test(s[at])) at++;
    if (at >= s.length) return n || -1;
    let t;
    if (c === 'c') { t = s.slice(at, at + (width ? w : 1)); at += t.length; if (!skip) x.write(ptr(), Uint8Array.from(t, (ch) => ch.charCodeAt(0))); }
    else if (c === 's' || c[0] === '[') {
      const set = c[0] === '[' ? new RegExp('^' + c + '+') : /^\S+/;
      const mm = set.exec(s.slice(at)); if (!mm) return n;
      t = mm[0].slice(0, w); at += t.length;
      if (!skip) x.write(ptr(), Uint8Array.from(t + '\0', (ch) => ch.charCodeAt(0) & 0xff));
    } else {
      const re = 'feEgG'.includes(c) ? /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/ : c === 'x' || c === 'X' ? /^[-+]?(0[xX])?[0-9a-fA-F]+/ : c === 'o' ? /^[-+]?[0-7]+/ : c === 'i' ? /^[-+]?(0[xX][0-9a-fA-F]+|0[0-7]*|\d+)/ : /^[-+]?\d+/;
      const mm = re.exec(s.slice(at, w === Infinity ? undefined : at + w)); if (!mm) return n;
      t = mm[0]; at += t.length;
      if (skip) continue;
      const p = ptr();
      if ('feEgG'.includes(c)) { const v = parseFloat(t); if (len === 'l' || len === 'L') { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); x.write(p, new Uint8Array(b.buffer)); } else { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); x.w32(p, b.getUint32(0, true)); } }
      else {
        const v = c === 'x' || c === 'X' ? parseInt(t, 16) : c === 'o' ? parseInt(t, 8) : c === 'i' ? (/^[-+]?0[xX]/.test(t) ? parseInt(t, 16) : /^[-+]?0\d/.test(t) ? parseInt(t, 8) : parseInt(t, 10)) : parseInt(t, 10);
        if (len === 'hh') x.w8(p, v); else if (len === 'h') x.w16(p, v); else if (len === 'll' || len === 'I64') { x.w32(p, v >>> 0); x.w32(p + 4, Math.floor(v / 4294967296)); } else x.w32(p, v >>> 0);
      }
    }
    if (!skip) n++;
  }
  return n;
}

/**
 * The runtime's tables: { 'api-ms-win-crt-*.dll': fns, 'ucrtbase.dll': fns, 'vcruntime140.dll': fns }.
 * `st`: api.js's state (the disk, the open files); `send`: calls into the program (its initializers,
 * its atexit functions); `kernel32`: the table whose file functions open the disk.
 */
export function ucrtApis({ st, send }) {
  /*
   * Visual C++'s exceptions (x86). `throw` is _CxxThrowException(object, ThrowInfo): RaiseException of
   * E06D7363h, non-continuable, its parameters 19930520h, the object and the ThrowInfo (whose catchable
   * types name the classes the object is). Each function with a try or a destructor to run registers a
   * frame at fs:[0] whose handler is `mov eax, FuncInfo ; jmp __CxxFrameHandler`: its states' unwind map
   * (to state, action), its try blocks (states low-high, their catches: adjectives, type, where the object
   * goes from EBP, the catch block). The registration node is EBP-0Ch, its state at +8, the frame's ESP
   * at -4. A handler that matches unwinds the frames above it (their destructors), its own frame down to
   * the try's low state, puts the object where the catch wants it, sets the state past the try, calls the
   * catch block with the frame's EBP, and goes on at the address it returns, the frame's ESP -- never
   * back to the dispatcher. AWT throws so when its toolkit has ended, and catches; the throw ended Java.
   */
  const cxxThrow = (x, obj, ti) => {
    if (!obj && !ti && st.cxxCurrent) ({ obj, ti } = st.cxxCurrent);  // throw; -- the one being caught, again
    const a = x.win.heapAlloc(12); x.w32(a, 0x19930520); x.w32(a + 4, obj); x.w32(a + 8, ti);
    return st.seh.raise(x, 0xe06d7363, 1, 3, a);
  };
  const cxxFrameHandler = (x, fi, rec, rn, ctx) => {
    const c = x.cpu, ebp0 = c.reg[5], ebp = (rn + 12) >>> 0;
    const back = (v) => { c.reg[5] = ebp0; return v; };
    if (((x.r32(fi) >>> 0) & ~3) !== 0x19930520) return 1;               // not a FuncInfo: ExceptionContinueSearch
    const maxState = x.r32(fi + 4) | 0, umap = x.r32(fi + 8), nTry = x.r32(fi + 12), tmap = x.r32(fi + 16);
    const state = () => x.r32(rn + 8) | 0;
    // The frame's unwind actions (destructors) from its state down to `to`, each with the frame's EBP.
    const unwindTo = (to, k) => {
      const s = state(); if (s <= to || s >= maxState) return k();
      const act = x.r32(umap + 8 * s + 4); x.w32(rn + 8, x.r32(umap + 8 * s));
      if (!act) return unwindTo(to, k);
      c.reg[5] = ebp; return send(x, [{ fn: act, args: [] }], () => unwindTo(to, k), null);
    };
    if (x.r32(rec + 4) & 6) return unwindTo(-1, () => back(1));          // EXCEPTION_UNWINDING: its destructors
    if ((x.r32(rec) >>> 0) !== 0xe06d7363 || !nTry) return 1;
    const obj = x.r32(rec + 24), ti = x.r32(rec + 28), cta = ti && x.r32(ti + 12);
    const types = cta ? Array.from({ length: x.r32(cta) }, (_, i) => x.r32(cta + 4 + 4 * i)) : [];
    const name = (td) => (td ? x.str(td + 8, 256) : '');
    const s = state();
    for (let i = 0; i < nTry; i++) {
      const tb = tmap + 20 * i, lo = x.r32(tb) | 0, hi = x.r32(tb + 4) | 0;
      if (s < lo || s > hi) continue;
      for (let j = 0, n = x.r32(tb + 12), hs = x.r32(tb + 16); j < n; j++) {
        const h = hs + 16 * j, ht = x.r32(h + 4), hn = name(ht);
        const ct = hn ? types.find((t) => name(x.r32(t + 4)) === hn) : (types[0] || 0);   // catch (...) takes any
        if (hn && !ct) continue;
        // The frames above, unwound (fs:[0] back to this one), then this one down to the try's state.
        const teb = st.seh.fs(x);
        x.w32(rec + 4, x.r32(rec + 4) | 2);
        const above = (k) => {
          const f = x.r32(teb); if (f === rn || f === 0xffffffff || !f) return k();
          x.w32(teb, x.r32(f));
          return send(x, [{ fn: x.r32(f + 4), args: [rec, f, ctx, 0] }], () => above(k), null);
        };
        return above(() => unwindTo(lo, () => {
          x.w32(rec + 4, x.r32(rec + 4) & ~2);
          const disp = x.r32(h + 8) | 0;
          if (disp && obj && ct) {
            const dest = (ebp + disp) >>> 0, at = (obj + (x.r32(ct + 8) | 0)) >>> 0;
            if (x.r32(h) & 8) x.w32(dest, at);                                // by reference
            else x.write(dest, x.bytes(at, Math.max(4, x.r32(ct + 20)) >>> 0));   // by value: its bytes (no copy constructor)
          }
          st.cxxCurrent = { obj, ti };
          x.w32(rn + 8, hi + 1);
          c.reg[5] = ebp;
          return send(x, [{ fn: x.r32(h + 12), args: [] }], (cont) => {       // the catch block: where to go on
            c.reg[4] = x.r32(rn - 4); c.reg[5] = ebp; c.eip = cont >>> 0; st.resumed = true;
            return cont;
          }, null);
        }));
      }
    }
    return 1;
  };
  // The handler's FuncInfo comes in EAX: pushed as its first argument, under the return address.
  const CXXFH = { cdecl: true, x86: (at, stub) => { const rel = stub - (at + 8); return Uint8Array.of(0x59, 0x50, 0x51, 0xe9, rel & 255, (rel >>> 8) & 255, (rel >>> 16) & 255, (rel >>> 24) & 255); } };
  const heap = (x) => x.win;
  const malloc = (x, n) => heap(x).heapAlloc(Math.max(1, n >>> 0));
  const free = (x, p) => { if (p) heap(x).heapFree(p); };
  const realloc = (x, p, n) => {
    if (!p) return malloc(x, n);
    if (!n) { free(x, p); return 0; }
    const old = heap(x).heapSize(p) >>> 0, q = malloc(x, n);
    x.write(q, x.bytes(p, Math.min(old, n))); free(x, p); return q;
  };
  const putStr = (x, s) => { const p = malloc(x, s.length + 1); x.write(p, Uint8Array.from(s + '\0', (c) => c.charCodeAt(0) & 0xff)); return p; };
  const setStr = (x, p, s) => x.write(p, Uint8Array.from(s + '\0', (c) => c.charCodeAt(0) & 0xff));
  const D = (f) => (x, ...a) => ({ st0: f(...a) });                // a double (or a float) returned on the x87 stack
  // _libm_sse2_*_precise: Visual C++'s /arch:SSE2 math, the argument and the result in XMM0 (and XMM1 for a
  // second argument), not on the stack.
  const SSE = (f) => (x) => { const d = x.cpu.xmm.d; d[0] = f(d[0], d[2]); return 0; };
  const errnoP = (x) => (st.errnoP ||= malloc(x, 16));

  // ---- files: FILE blocks over kernel32's handles --------------------------------------------------
  st.crtFiles = st.crtFiles || [];                                   // FILE index -> { h, eof, err, back, cons }
  // A FILE laid out as msvcrt's (_ptr, _cnt, _base, _flag, _file, _charbuf, _bufsiz, _tmpfname): Visual C++ 6
  // inlines feof as a read of _flag's _IOEOF (10h) and getc as _cnt's countdown -- so _cnt stays 0 (each read
  // through the runtime) and _flag follows the end of file and the errors (_IOERR 20h); the runtime's own
  // mark and index are in _bufsiz and _tmpfname. With the index in _cnt and no _flag, Winamp read its
  // playlist with fgets until feof, for ever.
  const fileBlock = (x, rec, at = 0) => {
    const p = at || malloc(x, 32); x.write(p, new Uint8Array(32)); st.crtFiles.push(rec);
    x.w32(p + 24, 0x46494c45); x.w32(p + 28, st.crtFiles.length - 1); x.w32(p + 16, 2 + st.crtFiles.length); rec.ptr = p;
    let eof = !!rec.eof, err = !!rec.err;
    const flag = () => x.w32(p + 12, (eof ? 0x10 : 0) | (err ? 0x20 : 0) | 1);
    Object.defineProperty(rec, 'eof', { get: () => eof, set: (v) => { eof = !!v; flag(); }, configurable: true });
    Object.defineProperty(rec, 'err', { get: () => err, set: (v) => { err = !!v; flag(); }, configurable: true });
    flag(); return p;
  };
  const fileOf = (x, F) => (F && x.r32(F + 24) === 0x46494c45 ? st.crtFiles[x.r32(F + 28)] : null);
  // stdin, stdout, stderr: three FILEs one after the other, msvcrt's _iob (&_iob[1] is stdout).
  const stdFile = (x, i) => (st.crtStd ||= (() => { const base = malloc(x, 96); return [0, 1, 2].map((k) => fileBlock(x, { cons: k }, base + 32 * k)); })())[i];
  const open = (x, name, mode) => {
    const f0 = st.diskFile(name), rel = st.relPath(name), plus = mode.includes('+');
    let f = f0;
    if (mode[0] === 'r') { if (!f) return null; }
    else if (mode[0] === 'w' || !f) { if (mode[0] !== 'w' && mode[0] !== 'a') return null; f = { bytes: new Uint8Array(0), size: 0 }; st.disk.set(rel, f); }
    if (mode[0] === 'w' && f0) { f0.size = 0; f = f0; }
    st.files.push({ f, pos: mode[0] === 'a' ? f.size : 0, append: mode[0] === 'a', write: mode[0] !== 'r' || plus, read: mode[0] === 'r' || plus });
    return 0x4000 + st.files.length - 1;
  };
  const hRead = (x, h, buf, n) => {
    const o = st.files[h - 0x4000]; if (!o) return -1;
    const k = Math.max(0, Math.min(n, o.f.size - o.pos));
    x.write(buf, o.f.bytes ? o.f.bytes.subarray(o.pos, o.pos + k) : new Uint8Array(k)); o.pos += k; return k;
  };
  const hWrite = (x, h, bytes) => {
    const o = st.files[h - 0x4000]; if (!o || !o.f.bytes) return -1;
    if (o.append) o.pos = o.f.size;
    const f = o.f, end = o.pos + bytes.length;
    if (end > f.bytes.length) { const b = new Uint8Array(Math.max(end, f.bytes.length * 2)); b.set(f.bytes); f.bytes = b; }
    f.bytes.set(bytes, o.pos); o.pos = end; f.size = Math.max(f.size, end); return bytes.length;
  };
  const out = (x, rec, bytes) => {
    if (rec.cons !== undefined) { if (rec.cons && x.lx.onOutput) x.lx.onOutput(rec.cons, bytes); return bytes.length; }
    return hWrite(x, rec.h, bytes);
  };
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const fgetc = (x, F) => {
    const r = fileOf(x, F); if (!r || r.cons !== undefined) { if (r) r.eof = true; return -1; }
    if (r.back !== undefined) { const c = r.back; r.back = undefined; return c; }
    const o = st.files[r.h - 0x4000]; if (!o || o.pos >= o.f.size) { r.eof = true; return -1; }
    const c = o.f.bytes ? o.f.bytes[o.pos++] : (o.pos++, 0);
    // Text mode (opened without 'b'): CR LF read as LF -- Winamp 2's playlist lines, else ending "\r".
    if (c === 13 && r.text && o.pos < o.f.size && o.f.bytes[o.pos] === 10) { o.pos++; return 10; }
    return c;
  };
  // fds (_open, _read): the same handles, numbered from 3.
  st.crtFds = st.crtFds || [];
  const fdH = (fd) => st.crtFds[fd - 3];

  // ---- onexit tables: what atexit and the program's static destructors put there ----------------------
  st.onexit = st.onexit || new Map();
  const atexit = st.atexitFns = st.atexitFns || [];

  // ---- argv and the environment ------------------------------------------------------------------------
  const args = (x) => {
    if (st.crtArgv) return st.crtArgv;
    const words = [x.win.path, ...(x.win.args ? x.win.args.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, '')) : [])];
    const argv = malloc(x, 4 * (words.length + 1));
    words.forEach((w, i) => x.w32(argv + 4 * i, putStr(x, w))); x.w32(argv + 4 * words.length, 0);
    const pargc = malloc(x, 4), pargv = malloc(x, 4), env = malloc(x, 8), penv = malloc(x, 4);
    x.w32(pargc, words.length); x.w32(pargv, argv); x.w32(env, putStr(x, 'PATH=C:\\WINDOWS\\system32')); x.w32(env + 4, 0); x.w32(penv, env);
    return (st.crtArgv = { pargc, pargv, penv, env });
  };

  const ctype = { alpha: /[A-Za-z]/, digit: /[0-9]/, xdigit: /[0-9A-Fa-f]/, space: /[ \t\n\v\f\r]/, upper: /[A-Z]/, lower: /[a-z]/,
    punct: /[!-/:-@[-`{-~]/, alnum: /[A-Za-z0-9]/, print: /[ -~]/, graph: /[!-~]/, cntrl: /[\x00-\x1f\x7f]/ };
  const is = (re) => ['i', (x, c) => (c >= 0 && c < 128 && re.test(String.fromCharCode(c)) ? 1 : 0), cd];
  const cmpI = (a, b, n = Infinity) => { a = a.slice(0, n).toLowerCase(); b = b.slice(0, n).toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const strtol = (x, p, end, base, unsigned) => {
    const s = x.str(p, 256), m = /^\s*([-+]?)(0[xX](?=[0-9a-fA-F]))?([0-9a-zA-Z]*)/.exec(s);
    let b = base || (m[2] ? 16 : /^0\d/.test(m[3]) ? 8 : 10), digits = '', i = 0;
    if (base === 16 && m[2]) b = 16;
    for (; i < m[3].length && parseInt(m[3][i], 36) < b; i++) digits += m[3][i];
    const v = digits ? parseInt(digits, b) * (m[1] === '-' ? -1 : 1) : 0;
    if (end) x.w32(end, digits ? p + m[0].length - (m[3].length - i) : p);
    return unsigned ? v >>> 0 : Math.max(-2147483648, Math.min(2147483647, v)) | 0;
  };
  const strtod = (x, p, end) => {
    const s = x.str(p, 256), m = /^\s*[-+]?(inf(inity)?|nan|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/i.exec(s);
    if (end) x.w32(end, m ? p + m[0].length : p);
    return m ? parseFloat(m[0].replace(/inf(inity)?/i, 'Infinity')) : 0;
  };
  const time = (x) => Math.floor(x.lx.epoch + x.lx.mono());
  // struct tm for a time, in UTC (MIRAGE's time zone): sec, min, hour, mday, mon, year-1900, wday, yday, isdst.
  const tmOf = (x, t) => {
    const d = new Date(t * 1000), p = st.tmBuf ||= malloc(x, 36), y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear() - 1900, d.getUTCDay(), Math.floor((d - y0) / 86400000), 0].forEach((v, i) => x.w32(p + 4 * i, v));
    return p;
  };

  const runtime = {
    _initterm: ['pp', (x, a, b) => { const fns = []; for (let p = a; p < b; p += 4) { const f = x.r32(p); if (f) fns.push({ fn: f, args: [] }); } return send(x, fns, () => 0, null); }, cd],
    // The C initializers (each returns 0, or a code that stops the program -- none does here).
    _initterm_e: ['pp', (x, a, b) => { const fns = []; for (let p = a; p < b; p += 4) { const f = x.r32(p); if (f) fns.push({ fn: f, args: [] }); } return send(x, fns, () => 0, null); }, cd],
    _initialize_onexit_table: ['p', (x, t) => { x.write(t, new Uint8Array(12)); st.onexit.set(t, []); return 0; }, cd],
    _register_onexit_function: ['pp', (x, t, f) => { if (!st.onexit.has(t)) st.onexit.set(t, []); st.onexit.get(t).push(f); return 0; }, cd],
    _execute_onexit_table: ['p', (x, t) => { const l = (st.onexit.get(t) || []).reverse(); st.onexit.set(t, []); return send(x, l.map((fn) => ({ fn, args: [] })), () => 0, null); }, cd],
    _crt_atexit: ['p', (x, f) => { atexit.push(f); return 0; }, cd],
    _register_thread_local_exe_atexit_callback: ['p', () => 0, cd],
    _configure_narrow_argv: ['i', () => 0, cd], _configure_wide_argv: ['i', () => 0, cd],
    _initialize_narrow_environment: ['', () => 0, cd], _initialize_wide_environment: ['', () => 0, cd],
    __p___argc: ['', (x) => args(x).pargc, cd], __p___argv: ['', (x) => args(x).pargv, cd],
    _get_initial_narrow_environment: ['', (x) => args(x).env, cd],
    _set_app_type: ['i', () => 0, cd], __setusermatherr: ['p', () => 0, cd], _set_new_mode: ['i', () => 0, cd],
    _seh_filter_exe: ['up', () => 0, cd], _seh_filter_dll: ['up', () => 0, cd],              // EXCEPTION_CONTINUE_SEARCH
    _controlfp_s: ['puu', (x, p, v, mask) => { if (p) x.w32(p, 0x0009001f); return 0; }, cd],
    _configthreadlocale: ['i', () => 2, cd],
    // The end: atexit's functions are not run (nothing here keeps anything a program would flush there).
    exit: ['i', (x, c) => { x.lx.exitProcess(c >>> 0); return 0; }, cd],
    _exit: ['i', (x, c) => { x.lx.exitProcess(c >>> 0); return 0; }, cd],
    _cexit: ['', () => 0, cd], _c_exit: ['', () => 0, cd],
    terminate: ['', (x) => { x.win.say('terminate()'); x.lx.exitProcess(3); return 0; }, cd],
    abort: ['', (x) => { x.win.say('abort()'); x.lx.exitProcess(3); return 0; }, cd],
    signal: ['ip', () => 0, cd],                                     // SIG_DFL before
    system: ['p', () => -1, cd],
    _errno: ['', (x) => errnoP(x), cd],
    _invalid_parameter_noinfo: ['', () => 0, cd], _invalid_parameter_noinfo_noreturn: ['', (x) => { x.win.say('invalid parameter'); x.lx.exitProcess(0xc000000d); return 0; }, cd],
    _beginthreadex: ['puppup', (x, sa, stack, fn, arg, flags, pid) => { const tid = x.win.createThread(fn, arg); if (pid) x.w32(pid, tid); return 0x2000 + tid; }, cd],
    _endthreadex: ['u', (x, c) => { x.lx.exitThread(c); return 0; }, cd],
  };
  const heapFns = {
    malloc: ['u', malloc, cd], free: ['p', free, cd], realloc: ['pu', realloc, cd], _msize: ['p', (x, p) => heap(x).heapSize(p), cd],
    calloc: ['uu', (x, n, k) => { const s = (n * k) >>> 0, p = malloc(x, s); x.write(p, new Uint8Array(s)); return p; }, cd],
    _callnewh: ['u', () => 0, cd], _set_new_handler: ['p', () => 0, cd],
    _aligned_malloc: ['uu', (x, n, a) => { const p = malloc(x, n + a + 4), q = (p + 4 + a - 1) & ~(a - 1); x.w32(q - 4, p); return q >>> 0; }, cd],
    _aligned_free: ['p', (x, q) => { if (q) free(x, x.r32(q - 4)); return 0; }, cd],
  };
  const math = {
    floor: ['d', D(Math.floor), cd], ceil: ['d', D(Math.ceil), cd], trunc: ['d', D(Math.trunc), cd], round: ['d', D((v) => Math.sign(v) * Math.round(Math.abs(v))), cd],
    truncf: ['f', D(Math.trunc), cd], roundf: ['f', D((v) => Math.fround(Math.sign(v) * Math.round(Math.abs(v)))), cd],
    copysign: ['dd', D((a, b) => Math.abs(a) * (b < 0 || Object.is(b, -0) ? -1 : 1)), cd], copysignf: ['ff', D((a, b) => Math.abs(a) * (b < 0 || Object.is(b, -0) ? -1 : 1)), cd],
    scalbn: ['di', D((a, n) => a * 2 ** n), cd], scalbnf: ['fi', D((a, n) => Math.fround(a * 2 ** n)), cd],
    lround: ['d', (x, v) => Math.sign(v) * Math.round(Math.abs(v)) | 0, cd], lroundf: ['f', (x, v) => Math.sign(v) * Math.round(Math.abs(v)) | 0, cd],
    sqrt: ['d', D(Math.sqrt), cd], sin: ['d', D(Math.sin), cd], cos: ['d', D(Math.cos), cd], tan: ['d', D(Math.tan), cd], atan: ['d', D(Math.atan), cd],
    atan2: ['dd', D(Math.atan2), cd], pow: ['dd', D(Math.pow), cd], exp: ['d', D(Math.exp), cd], log: ['d', D(Math.log), cd], log10: ['d', D(Math.log10), cd],
    fabs: ['d', D(Math.abs), cd], fmod: ['dd', D((a, b) => a % b), cd], asin: ['d', D(Math.asin), cd], acos: ['d', D(Math.acos), cd],
    sqrtf: ['f', D(Math.sqrt), cd], sinf: ['f', D(Math.sin), cd], cosf: ['f', D(Math.cos), cd], powf: ['ff', D(Math.pow), cd], fmodf: ['ff', D((a, b) => a % b), cd],
    _CIatan2: ['', (x) => { const b = x.fpop(), a = x.fpop(); return { st0: Math.atan2(a, b) }; }, cd],
    _CIfmod: ['', (x) => { const b = x.fpop(), a = x.fpop(); return { st0: a % b }; }, cd],
    _CIpow: ['', (x) => { const b = x.fpop(), a = x.fpop(); return { st0: Math.pow(a, b) }; }, cd],
    _CIsqrt: ['', (x) => ({ st0: Math.sqrt(x.fpop()) }), cd], _CIsin: ['', (x) => ({ st0: Math.sin(x.fpop()) }), cd], _CIcos: ['', (x) => ({ st0: Math.cos(x.fpop()) }), cd],
    _libm_sse2_sqrt_precise: ['', SSE(Math.sqrt), cd], _libm_sse2_sin_precise: ['', SSE(Math.sin), cd], _libm_sse2_cos_precise: ['', SSE(Math.cos), cd],
    _libm_sse2_tan_precise: ['', SSE(Math.tan), cd], _libm_sse2_atan_precise: ['', SSE(Math.atan), cd], _libm_sse2_asin_precise: ['', SSE(Math.asin), cd],
    _libm_sse2_acos_precise: ['', SSE(Math.acos), cd], _libm_sse2_exp_precise: ['', SSE(Math.exp), cd], _libm_sse2_log_precise: ['', SSE(Math.log), cd],
    _libm_sse2_log10_precise: ['', SSE(Math.log10), cd], _libm_sse2_pow_precise: ['', SSE(Math.pow), cd],
    _fdtest: ['p', () => -1, cd], _dtest: ['p', (x, p) => { const v = x.f64(p); return Number.isNaN(v) ? 2 : !Number.isFinite(v) ? 1 : v === 0 ? 0 : -1; }, cd],
  };
  const stdio = {
    __acrt_iob_func: ['u', (x, i) => stdFile(x, i), cd],
    __p__commode: ['', (x) => (st.commode ||= malloc(x, 4)), cd], _set_fmode: ['i', () => 0, cd],
    // __stdio_common_vsprintf(options (64 bits), buffer, count, format, locale, va_list): C99's
    // snprintf with _CRT_INTERNAL_PRINTF_STANDARD_SNPRINTF_BEHAVIOR (2) -- the length it wanted -- else
    // -1 when it did not fit; a NULL buffer asks only for the length.
    __stdio_common_vsprintf: ['uupuppp', (x, lo, hi, buf, n, fmt, loc, ap) => {
      const s = cprintf(x, x.str(fmt), ap);
      if (!buf) return s.length;
      if (s.length < n) { setStr(x, buf, s); return s.length; }
      if (n) setStr(x, buf, s.slice(0, n - 1));
      return lo & 2 ? s.length : -1;
    }, cd],
    __stdio_common_vsprintf_s: ['uupuppp', (x, lo, hi, buf, n, fmt, loc, ap) => { const s = cprintf(x, x.str(fmt), ap); if (s.length >= n) { if (n) x.w8(buf, 0); return -1; } setStr(x, buf, s); return s.length; }, cd],
    __stdio_common_vsnprintf_s: ['uupuuppp', (x, lo, hi, buf, n, max, fmt, loc, ap) => { const s = cprintf(x, x.str(fmt), ap), k = Math.min(s.length, n - 1, max >>> 0); setStr(x, buf, s.slice(0, k)); return k < s.length ? -1 : k; }, cd],
    __stdio_common_vfprintf: ['uupppp', (x, lo, hi, F, fmt, loc, ap) => { const r = fileOf(x, F), s = cprintf(x, x.str(fmt), ap); if (r) out(x, r, enc(s)); return s.length; }, cd],
    __stdio_common_vsscanf: ['uupuppp', (x, lo, hi, buf, n, fmt, loc, ap) => cscanf(x, x.str(buf, n === 0xffffffff ? 1 << 20 : n), x.str(fmt), ap), cd],
    fopen: ['pp', (x, name, mode) => { const m = x.str(mode), h = open(x, x.str(name), m); return h ? fileBlock(x, { h, text: !m.includes('b') }) : 0; }, cd],
    fclose: ['p', (x, F) => { const r = fileOf(x, F); if (!r) return -1; if (r.cons === undefined) free(x, F); return 0; }, cd],
    fread: ['puup', (x, buf, size, n, F) => {
      const r = fileOf(x, F); if (!r || r.cons !== undefined || !size || !n) return 0;
      let at = buf, want = size * n;
      if (r.back !== undefined) { x.w8(at++, r.back); r.back = undefined; want--; }
      const o = st.files[r.h - 0x4000];
      if (r.text && o && o.f.bytes) {                                  // text mode: CR LF as LF
        const b = o.f.bytes, end = o.f.size, outb = [];
        while (outb.length < want && o.pos < end) { const c = b[o.pos++]; if (c === 13 && o.pos < end && b[o.pos] === 10) continue; outb.push(c); }
        x.write(at, Uint8Array.from(outb)); const got = (at - buf) + outb.length;
        if (got < size * n) r.eof = true;
        return Math.floor(got / size);
      }
      const k = hRead(x, r.h, at, want), got = (at - buf) + Math.max(0, k);
      if (got < size * n) r.eof = true;
      return Math.floor(got / size);
    }, cd],
    fwrite: ['puup', (x, buf, size, n, F) => { const r = fileOf(x, F); if (!r || !size) return 0; const k = out(x, r, x.bytes(buf, size * n)); return k < 0 ? 0 : Math.floor(k / size); }, cd],
    fputc: ['ip', (x, c, F) => { const r = fileOf(x, F); if (r) out(x, r, Uint8Array.of(c & 0xff)); return c & 0xff; }, cd],
    fputs: ['pp', (x, s, F) => { const r = fileOf(x, F); if (r) out(x, r, x.bytes(s, x.str(s).length)); return 0; }, cd],
    puts: ['p', (x, s) => { out(x, fileOf(x, stdFile(x, 1)), enc(x.str(s) + '\n')); return 0; }, cd],
    getc: ['p', fgetc, cd], fgetc: ['p', fgetc, cd],
    ungetc: ['ip', (x, c, F) => { const r = fileOf(x, F); if (!r || c < 0) return -1; r.back = c & 0xff; r.eof = false; return c & 0xff; }, cd],
    fgets: ['pip', (x, buf, n, F) => {
      let s = '';
      while (s.length < n - 1) { const c = fgetc(x, F); if (c < 0) break; s += String.fromCharCode(c); if (c === 10) break; }
      if (!s) return 0; setStr(x, buf, s); return buf;
    }, cd],
    feof: ['p', (x, F) => (fileOf(x, F)?.eof ? 1 : 0), cd], ferror: ['p', (x, F) => (fileOf(x, F)?.err ? 1 : 0), cd],
    clearerr: ['p', (x, F) => { const r = fileOf(x, F); if (r) r.eof = r.err = false; return 0; }, cd],
    fflush: ['p', () => 0, cd], setvbuf: ['ppiu', () => 0, cd],
    ftell: ['p', (x, F) => { const r = fileOf(x, F), o = r && st.files[r.h - 0x4000]; return o ? o.pos - (r.back !== undefined ? 1 : 0) : -1; }, cd],
    fseek: ['pii', (x, F, off, how) => {
      const r = fileOf(x, F), o = r && st.files[r.h - 0x4000]; if (!o) return -1;
      o.pos = Math.max(0, (how === 1 ? o.pos - (r.back !== undefined ? 1 : 0) : how === 2 ? o.f.size : 0) + off); r.back = undefined; r.eof = false; return 0;
    }, cd],
    _fseeki64: ['piii', (x, F, lo, hi, how) => stdio.fseek[1](x, F, lo, how), cd],
    _ftelli64: ['p', (x, F) => ({ eax: stdio.ftell[1](x, F), edx: 0 }), cd],
    rewind: ['p', (x, F) => { stdio.fseek[1](x, F, 0, 0); return 0; }, cd],
    _fileno: ['p', (x, F) => { const r = fileOf(x, F); return r ? (r.cons ?? (st.crtFds.push(r.h), st.crtFds.length + 2)) : -1; }, cd],
    // fds over the same disk: _open(name, flags): O_WRONLY 1, O_RDWR 2, O_APPEND 8, O_CREAT 100h, O_TRUNC 200h.
    _open: ['pii', (x, name, fl) => {
      const mode = fl & 0x200 ? 'w' : fl & 8 ? 'a' : fl & 0x100 && !st.diskFile(x.str(name)) ? 'w' : fl & 3 ? 'r+' : 'r';
      const h = open(x, x.str(name), mode); if (!h) { x.w32(errnoP(x), 2); return -1; }
      st.crtFds.push(h); return st.crtFds.length + 2;
    }, cd],
    _read: ['ipu', (x, fd, buf, n) => (fdH(fd) ? hRead(x, fdH(fd), buf, n) : -1), cd],
    _write: ['ipu', (x, fd, buf, n) => (fd === 1 || fd === 2 ? (x.lx.onOutput && x.lx.onOutput(fd, x.bytes(buf, n)), n) : fdH(fd) ? hWrite(x, fdH(fd), x.bytes(buf, n)) : -1), cd],
    // _setmode(fd, mode): text or binary; the previous mode back (text). The Java VM sets its standard streams binary.
    _setmode: ['ii', () => 0x4000, cd],
    _getpid: ['', () => 0x100, cd],
    // _open_osfhandle(handle, flags): a descriptor for a handle (the Java VM wraps its files' handles so), in _fileno's table.
    _open_osfhandle: ['pi', (x, h) => { st.crtFds.push(h >>> 0); return st.crtFds.length + 2; }, cd],
    towupper: ['u', (x, c) => String.fromCharCode(c & 0xffff).toUpperCase().charCodeAt(0), cd], towlower: ['u', (x, c) => String.fromCharCode(c & 0xffff).toLowerCase().charCodeAt(0), cd],
    _isnan: ['d', (x, v) => (Number.isNaN(v) ? 1 : 0), cd], _finite: ['d', (x, v) => (Number.isFinite(v) ? 1 : 0), cd],                                   // GetCurrentProcessId's
    _lseek: ['iii', (x, fd, off, how) => { const o = fdH(fd) && st.files[fdH(fd) - 0x4000]; if (!o) return -1; o.pos = Math.max(0, (how === 1 ? o.pos : how === 2 ? o.f.size : 0) + off); return o.pos; }, cd],
    // _lseeki64(fd, offset as two dwords, origin): the new position in EDX:EAX (files here stay below 4 GB).
    _lseeki64: ['iuii', (x, fd, lo, hi, how) => { const o = fdH(fd) && st.files[fdH(fd) - 0x4000]; if (!o) return { eax: 0xffffffff, edx: 0xffffffff };
      o.pos = Math.max(0, (how === 1 ? o.pos : how === 2 ? o.f.size : 0) + (hi | 0) * 4294967296 + (lo >>> 0)); return { eax: o.pos >>> 0, edx: Math.floor(o.pos / 4294967296) }; }, cd],
    _close: ['i', (x, fd) => (fdH(fd) ? 0 : -1), cd],
    _getcwd: ['pi', (x, buf, n) => { const s = 'C:\\'; if (!buf) return putStr(x, s); if (n <= s.length) return 0; setStr(x, buf, s); return buf; }, cd],
    remove: ['p', (x, p) => { const f = st.diskFile(x.str(p)), k = f && [...st.disk].find(([, v]) => v === f)?.[0]; return k ? (st.disk.delete(k), 0) : -1; }, cd],
  };
  const str = {
    strlen: ['p', (x, p) => x.str(p).length, cd], strcmp: ['pp', (x, a, b) => cmp(x.str(a), x.str(b)), cd],
    strncmp: ['ppu', (x, a, b, n) => cmp(x.str(a, n), x.str(b, n)), cd],
    _stricmp: ['pp', (x, a, b) => cmpI(x.str(a), x.str(b)), cd], _strnicmp: ['ppu', (x, a, b, n) => cmpI(x.str(a, n), x.str(b, n)), cd],
    _wcsicmp: ['pp', (x, a, b) => cmpI(wstr(x, a), wstr(x, b)), cd], _wcsnicmp: ['ppu', (x, a, b, n) => cmpI(wstr(x, a, -1), wstr(x, b, -1), n), cd],
    wcsncmp: ['ppu', (x, a, b, n) => cmp(wstr(x, a).slice(0, n), wstr(x, b).slice(0, n)), cd], wcscmp: ['pp', (x, a, b) => cmp(wstr(x, a), wstr(x, b)), cd],
    wcslen: ['p', (x, p) => wstr(x, p).length, cd],
    strcpy: ['pp', (x, d, s) => { setStr(x, d, x.str(s)); return d; }, cd],
    strcat: ['pp', (x, d, s) => { setStr(x, d + x.str(d).length, x.str(s)); return d; }, cd],
    strncpy: ['ppu', (x, d, s, n) => { const t = x.str(s, n); const b = new Uint8Array(n); b.set(enc(t)); x.write(d, b); return d; }, cd],
    strncat: ['ppu', (x, d, s, n) => { setStr(x, d + x.str(d).length, x.str(s, n)); return d; }, cd],
    _strdup: ['p', (x, s) => (s ? putStr(x, x.str(s)) : 0), cd],
    strtok: ['pp', (x, s, delim) => {
      const ds = x.str(delim); let p = s || st.strtokNext || 0; if (!p) return 0;
      while (x.r8(p) && ds.includes(String.fromCharCode(x.r8(p)))) p++;
      if (!x.r8(p)) { st.strtokNext = 0; return 0; }
      let q = p; while (x.r8(q) && !ds.includes(String.fromCharCode(x.r8(q)))) q++;
      if (x.r8(q)) { x.w8(q, 0); st.strtokNext = q + 1; } else st.strtokNext = 0;
      return p;
    }, cd],
    _strrev: ['p', (x, p) => { setStr(x, p, [...x.str(p)].reverse().join('')); return p; }, cd],
    _strupr: ['p', (x, p) => { setStr(x, p, x.str(p).toUpperCase()); return p; }, cd], _strlwr: ['p', (x, p) => { setStr(x, p, x.str(p).toLowerCase()); return p; }, cd],
    toupper: ['i', (x, c) => (c >= 97 && c <= 122 ? c - 32 : c), cd], tolower: ['i', (x, c) => (c >= 65 && c <= 90 ? c + 32 : c), cd],
    isalpha: is(ctype.alpha), isdigit: is(ctype.digit), isxdigit: is(ctype.xdigit), isspace: is(ctype.space), isupper: is(ctype.upper),
    islower: is(ctype.lower), ispunct: is(ctype.punct), isalnum: is(ctype.alnum), isprint: is(ctype.print), isgraph: is(ctype.graph), iscntrl: is(ctype.cntrl),
    strspn: ['pp', (x, s, a) => { const t = x.str(s), c = x.str(a); let i = 0; while (i < t.length && c.includes(t[i])) i++; return i; }, cd],
    strcspn: ['pp', (x, s, a) => { const t = x.str(s), c = x.str(a); let i = 0; while (i < t.length && !c.includes(t[i])) i++; return i; }, cd],
    strpbrk: ['pp', (x, s, a) => { const t = x.str(s), c = x.str(a); for (let i = 0; i < t.length; i++) if (c.includes(t[i])) return s + i; return 0; }, cd],
    memcmp: ['ppu', (x, a, b, n) => { const p = x.bytes(a, n), q = x.bytes(b, n); for (let i = 0; i < n; i++) if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1; return 0; }, cd],
  };
  const convert = {
    atoi: ['p', (x, p) => strtol(x, p, 0, 10, false), cd], atol: ['p', (x, p) => strtol(x, p, 0, 10, false), cd],
    strtol: ['ppi', (x, p, e, b) => strtol(x, p, e, b, false), cd], strtoul: ['ppi', (x, p, e, b) => strtol(x, p, e, b, true), cd],
    strtoll: ['ppi', (x, p, e, b) => { const v = strtol(x, p, e, b, false); return { eax: v >>> 0, edx: v < 0 ? -1 : 0 }; }, cd],
    strtoull: ['ppi', (x, p, e, b) => ({ eax: strtol(x, p, e, b, true), edx: 0 }), cd],
    atof: ['p', (x, p) => ({ st0: strtod(x, p, 0) }), cd], strtod: ['pp', (x, p, e) => ({ st0: strtod(x, p, e) }), cd],
    strtof: ['pp', (x, p, e) => ({ st0: Math.fround(strtod(x, p, e)) }), cd],
    _itoa: ['ipi', (x, v, buf, r) => { setStr(x, buf, (r === 10 ? v | 0 : v >>> 0).toString(r)); return buf; }, cd],
    _ltoa: ['ipi', (x, v, buf, r) => { setStr(x, buf, (r === 10 ? v | 0 : v >>> 0).toString(r)); return buf; }, cd],
    _ultoa: ['upi', (x, v, buf, r) => { setStr(x, buf, (v >>> 0).toString(r)); return buf; }, cd],
    wcstombs: ['ppu', (x, d, s, n) => { const t = wstr(x, s); if (!d) return t.length; const k = Math.min(t.length, n); x.write(d, enc(t.slice(0, k) + (k < n ? '\0' : ''))); return k; }, cd],
    mbstowcs: ['ppu', (x, d, s, n) => { const t = x.str(s); if (!d) return t.length; const k = Math.min(t.length, n); x.write(d, wbytes(t.slice(0, k)).subarray(0, 2 * k + (k < n ? 2 : 0))); return k; }, cd],
  };
  const timeFns = {
    _time64: ['p', (x, p) => { const t = time(x); if (p) { x.w32(p, t); x.w32(p + 4, 0); } return { eax: t, edx: 0 }; }, cd],
    _time32: ['p', (x, p) => { const t = time(x); if (p) x.w32(p, t); return t; }, cd],
    _localtime64: ['p', (x, p) => tmOf(x, x.r32(p)), cd], _gmtime64: ['p', (x, p) => tmOf(x, x.r32(p)), cd],
    _localtime32: ['p', (x, p) => tmOf(x, x.r32(p)), cd],
    clock: ['', (x) => Math.floor(x.lx.mono() * 1000), cd],
    // strftime: the conversions a game asks for its file names and logs.
    strftime: ['pupp', (x, buf, n, fmt, tm) => {
      const v = Array.from({ length: 9 }, (_, i) => x.r32(tm + 4 * i) | 0), z = (k, w = 2) => String(k).padStart(w, '0');
      const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const s = x.str(fmt).replace(/%([a-zA-Z%])/g, (_, c) => ({ Y: v[5] + 1900, y: z(v[5] % 100), m: z(v[4] + 1), d: z(v[3]), H: z(v[2]), M: z(v[1]), S: z(v[0]),
        a: D[v[6]], b: M[v[4]], j: z(v[7] + 1, 3), p: v[2] < 12 ? 'AM' : 'PM', I: z(v[2] % 12 || 12), '%': '%', c: `${D[v[6]]} ${M[v[4]]} ${z(v[3])} ${z(v[2])}:${z(v[1])}:${z(v[0])} ${v[5] + 1900}` })[c] ?? '');
      if (s.length >= n) return 0; setStr(x, buf, s); return s.length;
    }, cd],
  };
  const utility = {
    abs: ['i', (x, v) => Math.abs(v | 0), cd], labs: ['i', (x, v) => Math.abs(v | 0), cd],
    rand: ['', () => { st.crtSeed = (Math.imul(st.crtSeed ?? 1, 214013) + 2531011) >>> 0; return (st.crtSeed >>> 16) & 0x7fff; }, cd],
    srand: ['u', (x, s) => { st.crtSeed = s >>> 0; return 0; }, cd],
    /*
     * qsort and bsearch with the program's comparison function: each comparison a call into the program
     * (a send), the next step taken from its result -- a merge sort and a binary search. SDL 2 imports
     * them. The sort orders indices while the elements stay where they are (what the comparisons read),
     * then writes the array once: n log n calls, where an insertion sort made up to n*n/2 and copied
     * each swap -- Warcraft III sorts some 430 lists a second.
     */
    qsort: ['puup', (x, base, n, w, cmp) => {
      if (n < 2) return 0;
      let src = Array.from({ length: n }, (_, k) => k), dst = new Array(n), width = 1, lo = 0, i = 0, j = 0, k = 0;
      const at = (k) => (base + k * w) >>> 0;
      const step = () => {
        for (;;) {
          if (width >= n) {                                              // sorted: the elements in src's order
            const all = x.bytes(base, n * w), out = new Uint8Array(n * w);
            for (let q = 0; q < n; q++) out.set(all.subarray(src[q] * w, src[q] * w + w), q * w);
            x.write(base, out); return 0;
          }
          const mid = Math.min(lo + width, n), hi = Math.min(lo + 2 * width, n);
          if (i < mid && j < hi) return send(x, [{ fn: cmp, args: [at(src[i]), at(src[j])] }], (r) => {
            dst[k++] = (r | 0) <= 0 ? src[i++] : src[j++]; return step();
          }, null);
          while (i < mid) dst[k++] = src[i++];
          while (j < hi) dst[k++] = src[j++];
          lo = hi;
          if (lo >= n) { [src, dst] = [dst, src]; width *= 2; lo = 0; }
          i = lo; j = Math.min(lo + width, n); k = lo;
        }
      };
      i = 0; j = Math.min(width, n); k = 0;
      return step();
    }, cd],
    bsearch: ['ppuup', (x, key, base, n, w, cmp) => {
      const look = (lo, hi) => {
        if (lo >= hi) return 0;
        const mid = (lo + hi) >>> 1, p = base + mid * w;
        return send(x, [{ fn: cmp, args: [key, p] }], (r) => ((r | 0) === 0 ? p : (r | 0) < 0 ? look(lo, mid) : look(mid + 1, hi)), null);
      };
      return look(0, n);
    }, cd],
  };
  const env = {
    getenv: ['p', (x, p) => (x.str(p).toUpperCase() === 'PATH' ? x.r32(args(x).env) + 5 : 0), cd],
    _putenv: ['p', () => 0, cd],
  };
  const fs = {
    _mkdir: ['p', () => 0, cd], _chdir: ['p', (x, p) => (st.diskDir(x.str(p)) ? 0 : -1), cd],
    _unlink: ['p', (x, p) => stdio.remove[1](x, p), cd],
    _access: ['pi', (x, p) => (st.diskFile(x.str(p)) || st.diskDir(x.str(p)) ? 0 : -1), cd],
    _waccess: ['pi', (x, p) => (st.diskFile(wstr(x, p)) || st.diskDir(wstr(x, p)) ? 0 : -1), cd],
  };
  const locale = {
    setlocale: ['ip', (x) => (st.cLocale ||= putStr(x, 'C')), cd],
    localeconv: ['', (x) => { if (!st.lconv) { st.lconv = malloc(x, 96); x.write(st.lconv, new Uint8Array(96)); x.w32(st.lconv, putStr(x, '.')); x.w32(st.lconv + 4, putStr(x, '')); x.w32(st.lconv + 8, putStr(x, '')); } return st.lconv; }, cd],
    ___lc_codepage_func: ['', () => 1252, cd], ___mb_cur_max_func: ['', () => 1, cd],
  };
  // ---- vcruntime140: the compiler's helpers ----------------------------------------------------------
  const vc = {
    memcpy: ['ppu', (x, d, s, n) => { x.write(d, x.bytes(s, n)); return d; }, cd],
    memmove: ['ppu', (x, d, s, n) => { x.write(d, x.bytes(s, n)); return d; }, cd],
    memset: ['piu', (x, d, c, n) => { x.write(d, new Uint8Array(n).fill(c & 0xff)); return d; }, cd],
    memchr: ['piu', (x, p, c, n) => { const b = x.bytes(p, n), i = b.indexOf(c & 0xff); return i < 0 ? 0 : p + i; }, cd],
    strchr: ['pi', (x, p, c) => { const s = x.str(p), i = (c & 0xff) ? s.indexOf(String.fromCharCode(c & 0xff)) : s.length; return i < 0 ? 0 : p + i; }, cd],
    strrchr: ['pi', (x, p, c) => { const s = x.str(p), i = (c & 0xff) ? s.lastIndexOf(String.fromCharCode(c & 0xff)) : s.length; return i < 0 ? 0 : p + i; }, cd],
    strstr: ['pp', (x, p, q) => { const i = x.str(p).indexOf(x.str(q)); return i < 0 ? 0 : p + i; }, cd],
    wcsstr: ['pp', (x, p, q) => { const i = wstr(x, p).indexOf(wstr(x, q)); return i < 0 ? 0 : p + 2 * i; }, cd],
    wcschr: ['pi', (x, p, c) => { const i = wstr(x, p).indexOf(String.fromCharCode(c & 0xffff)); return i < 0 ? 0 : p + 2 * i; }, cd],
    wcsrchr: ['pi', (x, p, c) => { const i = wstr(x, p).lastIndexOf(String.fromCharCode(c & 0xffff)); return i < 0 ? 0 : p + 2 * i; }, cd],
    _purecall: ['', (x) => { x.win.say('pure virtual function call'); x.lx.exitProcess(3); return 0; }, cd],
    __std_terminate: ['', (x) => { x.win.say('std::terminate'); x.lx.exitProcess(3); return 0; }, cd],
    __std_type_info_destroy_list: ['p', () => 0, cd],
    __current_exception: ['', (x) => (st.curExc ||= (() => { const p = malloc(x, 4); x.w32(p, 0); return p; })()), cd],
    __current_exception_context: ['', (x) => (st.curExcCtx ||= (() => { const p = malloc(x, 4); x.w32(p, 0); return p; })()), cd],
    __std_exception_copy: ['pp', (x, from, to) => { const w = x.r32(from); x.w32(to, w ? putStr(x, x.str(w)) : 0); x.w8(to + 4, 1); return 0; }, cd],
    __std_exception_destroy: ['p', (x, p) => { if (x.r8(p + 4)) free(x, x.r32(p)); x.w32(p, 0); x.w8(p + 4, 0); return 0; }, cd],
    // C++ exceptions, as Visual C++ makes them (cxxThrow, cxxFrameHandler above).
    _CxxThrowException: ['pp', (x, obj, ti) => cxxThrow(x, obj, ti)],
    __CxxFrameHandler3: ['ppppp', (x, fi, rec, rn, ctx) => cxxFrameHandler(x, fi, rec, rn, ctx), CXXFH],
    _except_handler4_common: ['pppppp', () => 1, cd],
    _local_unwind4: ['ppu', () => 0, cd],
    __telemetry_main_invoke_trigger: ['p', () => 0, cd], __telemetry_main_return_trigger: ['p', () => 0, cd],
    __vcrt_InitializeCriticalSectionEx: ['puu', () => 1, cd],
  };
  // ---- msvcrt.dll's own names: what Visual C++ 6 programs import (Winamp 2 and its plugins), its varargs
  // printf and scanf (the arguments on the stack after the fixed ones: esp + 4 is the first), its old wide
  // swprintf with no count, its character-class table (_pctype, a variable), _stat's 36 bytes.
  const W = (x, p, s) => { for (let i = 0; i < s.length; i++) x.w16(p + 2 * i, s.charCodeAt(i)); x.w16(p + 2 * s.length, 0); };
  const va = (x, k) => (x.cpu.reg[4] >>> 0) + 4 + 4 * k;            // the k-th 4-byte argument's address
  const clock = (x) => new Date((x.lx.now ? x.lx.now() : Math.floor(Date.now() / 1000)) * 1000), two = (v) => String(v).padStart(2, '0');
  const dateText = (x) => { const d = clock(x); return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/${two(d.getUTCFullYear() % 100)}`; };
  const timeText = (x) => { const d = clock(x); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
  const wn = (x, p, n, s) => { const k = Math.min(s.length, n); for (let i = 0; i < k; i++) x.w16(p + 2 * i, s.charCodeAt(i)); if (s.length < n) x.w16(p + 2 * s.length, 0); return s.length < n ? s.length : -1; };
  const ctypeTable = (x) => st.pctype ||= (() => {
    const t = malloc(x, 2 * 257); x.w16(t, 0);
    for (let c = 0; c < 256; c++) {
      const ch = String.fromCharCode(c);
      let f = (/[A-Z]/.test(ch) ? 0x101 : 0) | (/[a-z]/.test(ch) ? 0x102 : 0) | (/[0-9]/.test(ch) ? 4 : 0) | (/[ \t\n\v\f\r]/.test(ch) ? 8 : 0);
      if (c < 32 || c === 127) f |= 0x20;                             // _CONTROL
      if (c === 32 || c === 9) f |= 0x40;                             // _BLANK
      if (/[0-9A-Fa-f]/.test(ch)) f |= 0x80;                          // _HEX
      if (c > 32 && c < 127 && !/[A-Za-z0-9]/.test(ch)) f |= 0x10;   // _PUNCT
      x.w16(t + 2 + 2 * c, f);
    }
    return t + 2;                                                     // _pctype[-1] is EOF's
  })();
  const statOf = (x, name, buf) => {
    const f = st.diskFile(name), dir = !f && st.diskDir && st.diskDir(name);
    if (!f && !dir) { x.w32(errnoP(x), 2); return -1; }
    x.write(buf, new Uint8Array(36)); x.w16(buf + 6, dir ? 0x41ff : 0x81b6); x.w16(buf + 8, 1);
    x.w32(buf + 20, dir ? 0 : f.size); for (const o of [24, 28, 32]) x.w32(buf + o, 946684800);   // 2000-01-01
    return 0;
  };
  // struct _stati64 (48 bytes): _stat's fields with the size a 64-bit integer at 24 and the times after it.
  const stat64 = (x, f, dir, buf) => {
    x.write(buf, new Uint8Array(48)); x.w16(buf + 6, dir ? 0x41ff : 0x81b6); x.w16(buf + 8, 1);
    x.w32(buf + 24, dir ? 0 : f.size); for (const o of [32, 36, 40]) x.w32(buf + o, 946684800);
    return 0;
  };
  const stat64Of = (x, name, buf) => { const f = st.diskFile(name), dir = !f && st.diskDir && st.diskDir(name); if (!f && !dir) { x.w32(errnoP(x), 2); return -1; } return stat64(x, f, dir, buf); };
  const splitPath = (p) => { const m = /^([A-Za-z]:)?((?:.*[\\/])?)([^\\/]*?)(\.[^.\\/]*)?$/.exec(p) || []; return [m[1] || '', m[2] || '', m[3] || '', m[4] || '']; };
  const classic = {
    printf: ['p', (x, fmt) => { const s = cprintf(x, x.str(fmt), va(x, 1)); out(x, fileOf(x, stdFile(x, 1)), enc(s)); return s.length; }, cd],
    vfprintf: ['ppp', (x, F, fmt, ap) => { const r = fileOf(x, F), s = cprintf(x, x.str(fmt), ap); if (r) out(x, r, enc(s)); return s.length; }, cd],
    _iob: ['', (x) => stdFile(x, 0), { data: true }],                   // the three standard FILEs (MinGW-w64's stdout is &_iob[1])
    // _ismbblead: a Shift-JIS lead byte on a code page 932 system; none on 1252's.
    _ismbblead: ['u', (x, c) => (st.acp === 932 && ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) ? 4 : 0), cd],
    _amsg_exit: ['i', (x, n) => { x.win.say(`_amsg_exit(${n}): the C runtime's fatal error`); x.lx.exitProcess(255); return 0; }, cd],
    fprintf: ['pp', (x, F, fmt) => { const r = fileOf(x, F), s = cprintf(x, x.str(fmt), va(x, 2)); if (r) out(x, r, enc(s)); return s.length; }, cd],
    sscanf: ['pp', (x, buf, fmt) => cscanf(x, x.str(buf), x.str(fmt), va(x, 2)), cd],
    _vsnprintf: ['pupp', (x, buf, n, fmt, ap) => { const s = cprintf(x, x.str(fmt), ap); setStr(x, buf, s.slice(0, n)); return s.length > n ? -1 : s.length; }, cd],
    // _beginthread(start, stack, arg): a thread, its handle (-1 when none could be made).
    _beginthread: ['pup', (x, fn, stack, arg) => 0x2000 + x.win.createThread(fn, arg), cd],
    _snprintf: ['pup', (x, buf, n, fmt) => { const s = cprintf(x, x.str(fmt), va(x, 3)); setStr(x, buf, s.slice(0, n)); if (s.length >= n) { if (s.length > n) return -1; } return s.length; }, cd],
    swprintf: ['pp', (x, buf, fmt) => { const s = cprintf(x, wstr(x, fmt), va(x, 2), true); W(x, buf, s); return s.length; }, cd],
    vswprintf: ['ppp', (x, buf, fmt, ap) => { const s = cprintf(x, wstr(x, fmt), ap, true); W(x, buf, s); return s.length; }, cd],
    // _vsnwprintf / _snwprintf: at most n characters; the terminator only when it fits, -1 when the text did not.
    // Unreal Tournament's C runtime: the date and time as text (MM/DD/YY, HH:MM:SS, the clock's), wide twins,
    // mktime (a struct tm taken as UTC, as localtime gives it) and difftime; no keyboard at the console.
    _strdate: ['p', (x, p) => { setStr(x, p, dateText(x)); return p; }, cd], _strtime: ['p', (x, p) => { setStr(x, p, timeText(x)); return p; }, cd],
    _wstrdate: ['p', (x, p) => { W(x, p, dateText(x)); return p; }, cd], _wstrtime: ['p', (x, p) => { W(x, p, timeText(x)); return p; }, cd],
    mktime: ['p', (x, tm) => { const f = (i) => x.r32(tm + 4 * i) | 0; return (Date.UTC(1900 + f(5), f(4), f(3), f(2), f(1), f(0)) / 1000) | 0; }, cd],
    difftime: ['ii', (x, a, b) => ({ st0: a - b }), cd],
    wcstoul: ['ppi', (x, p, end, base) => { const s = wstr(x, p), m = /^\s*[-+]?(0x)?[0-9a-fA-F]*/.exec(s), v = parseInt(m[0], base || 10); if (end) x.w32(end, p + 2 * m[0].length); return Number.isNaN(v) ? 0 : v >>> 0; }, cd],
    _wcsupr: ['p', (x, p) => { W(x, p, wstr(x, p).toUpperCase()); return p; }, cd], _wcslwr: ['p', (x, p) => { W(x, p, wstr(x, p).toLowerCase()); return p; }, cd],
    _wstat: ['pp', (x, name, buf) => statOf(x, wstr(x, name), buf), cd],
    wprintf: ['p', (x, fmt) => { const s = cprintf(x, wstr(x, fmt), va(x, 1), true); out(x, fileOf(x, stdFile(x, 1)), enc(s)); return s.length; }, cd],
    getchar: ['', () => -1, cd], _getch: ['', () => 0x0d, cd], _kbhit: ['', () => 0, cd], _heapchk: ['', () => -2, cd],   // EOF; Enter; none; _HEAPOK
    _vsnwprintf: ['pupp', (x, buf, n, fmt, ap) => wn(x, buf, n, cprintf(x, wstr(x, fmt), ap, true)), cd],
    _snwprintf: ['pup', (x, buf, n, fmt) => wn(x, buf, n, cprintf(x, wstr(x, fmt), va(x, 3), true)), cd],
    _fsopen: ['ppi', (x, name, mode) => { const m = x.str(mode), h = open(x, x.str(name), m); return h ? fileBlock(x, { h, text: !m.includes('b') }) : 0; }, cd],
    _wfsopen: ['ppi', (x, name, mode) => { const h = open(x, wstr(x, name), wstr(x, mode)); return h ? fileBlock(x, { h }) : 0; }, cd],
    _fdopen: ['ip', (x, fd) => (fd >= 0x4000 ? fileBlock(x, { h: fd }) : 0), cd],
    _stat: ['pp', (x, name, buf) => statOf(x, x.str(name), buf), cd],
    // The 64-bit forms (the Java VM's): by name, by wide name, by descriptor (an open file of the disk's).
    _stati64: ['pp', (x, name, buf) => stat64Of(x, x.str(name), buf), cd], _wstati64: ['pp', (x, name, buf) => stat64Of(x, wstr(x, name), buf), cd],
    _fstati64: ['ip', (x, fd, buf) => { const o = fdH(fd) && st.files[fdH(fd) - 0x4000]; if (!o) { x.w32(errnoP(x), 9); return -1; } return stat64(x, o.f, false, buf); }, cd],
    _splitpath: ['ppppp', (x, path, d, dir, fname, ext) => { const parts = splitPath(x.str(path)); [d, dir, fname, ext].forEach((p, i) => { if (p) setStr(x, p, parts[i]); }); return 0; }, cd],
    _makepath: ['ppppp', (x, buf, d, dir, fname, ext) => {
      let dirs = dir ? x.str(dir) : ''; if (dirs && !/[\\/]$/.test(dirs)) dirs += '\\';
      let e = ext ? x.str(ext) : ''; if (e && e[0] !== '.') e = '.' + e;
      setStr(x, buf, (d ? x.str(d) : '') + dirs + (fname ? x.str(fname) : '') + e); return 0;
    }, cd],
    _strcmpi: ['pp', (x, a, b) => { const s = x.str(a).toLowerCase(), t = x.str(b).toLowerCase(); return s < t ? -1 : s > t ? 1 : 0; }, cd],
    _mbsstr: ['pp', (x, a, b) => { const i = x.str(a).indexOf(x.str(b)); return i < 0 ? 0 : a + i; }, cd],
    _isctype: ['ii', (x, c, mask) => (c >= -1 && c < 256 ? x.r16(ctypeTable(x) + 2 * c) & mask : 0), cd],
    _pctype: ['', (x) => { const v = malloc(x, 4); x.w32(v, ctypeTable(x)); return x.r32(v); }, { data: true }],
    __mb_cur_max: ['', () => 1, { data: true }],
    _atoi64: ['p', (x, p) => { const m = /^\s*[-+]?\d+/.exec(x.str(p)); const v = BigInt.asUintN(64, BigInt(m ? m[0].trim() : 0)); return { eax: Number(v & 0xffffffffn), edx: Number(v >> 32n) }; }, cd],
    _i64toa: ['uuip', (x, lo, hi, buf, r) => { const v = BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo >>> 0)); setStr(x, buf, (r === 10 ? v : BigInt.asUintN(64, v)).toString(r)); return buf; }, cd],
    _itow: ['ipi', (x, v, buf, r) => { W(x, buf, (r === 10 ? v | 0 : v >>> 0).toString(r)); return buf; }, cd],
    _ltow: ['ipi', (x, v, buf, r) => { W(x, buf, (r === 10 ? v | 0 : v >>> 0).toString(r)); return buf; }, cd],
    _wtoi: ['p', (x, p) => parseInt(wstr(x, p), 10) | 0, cd],
    _wcsdup: ['p', (x, p) => { const s = wstr(x, p), q = malloc(x, 2 * s.length + 2); W(x, q, s); return q; }, cd],
    wcscpy: ['pp', (x, d, s0) => { W(x, d, wstr(x, s0)); return d; }, cd],
    wcsncpy: ['ppu', (x, d, s0, n) => { const s = wstr(x, s0).slice(0, n); for (let i = 0; i < n; i++) x.w16(d + 2 * i, i < s.length ? s.charCodeAt(i) : 0); return d; }, cd],
    wcscat: ['pp', (x, d, s0) => { W(x, d, wstr(x, d) + wstr(x, s0)); return d; }, cd],
    wcspbrk: ['pp', (x, p, set) => { const s = wstr(x, p), c = wstr(x, set); for (let i = 0; i < s.length; i++) if (c.includes(s[i])) return p + 2 * i; return 0; }, cd],
    wcstol: ['ppi', (x, p, end, base) => { const s = wstr(x, p), m = /^\s*[-+]?(0x)?[0-9a-fA-F]*/.exec(s), v = parseInt(m[0], base || 10); if (end) x.w32(end, p + 2 * m[0].length); return Number.isNaN(v) ? 0 : v | 0; }, cd],
    iswalnum: ['i', (x, c) => (/[\p{L}\p{N}]/u.test(String.fromCharCode(c & 0xffff)) ? 1 : 0), cd],
    iswdigit: ['i', (x, c) => (c >= 48 && c <= 57 ? 1 : 0), cd],
    iswctype: ['ii', (x, c, mask) => (c < 256 ? x.r16(ctypeTable(x) + 2 * c) & mask : (mask & 0x103) && /\p{L}/u.test(String.fromCharCode(c)) ? mask & 0x103 : 0), cd],
    frexp: ['dp', (x, v, e) => { if (!v || !Number.isFinite(v)) { x.w32(e, 0); return { st0: v }; } let k = Math.ceil(Math.log2(Math.abs(v))); let m = v / 2 ** k; if (Math.abs(m) >= 1) { m /= 2; k++; } x.w32(e, k); return { st0: m }; }, cd],
    ldexp: ['di', (x, v, e) => ({ st0: v * 2 ** e }), cd],
    tanh: ['d', (x, v) => ({ st0: Math.tanh(v) }), cd],
    // C++: a type_info's destructor (nothing to free here), terminate (the program stops), and the frames'
    // handler of Visual C++ 6's exceptions (one thrown stops the program first: _CxxThrowException).
    '??1type_info@@UAE@XZ': ['', () => 0],
    // type_info::raw_name (thiscall, `this` in ECX): its decorated name, kept after its vtable and its
    // undecorated name's pointer -- Warcraft III's installer compares classes so.
    '?raw_name@type_info@@QBEPBDXZ': ['', (x) => ((x.cpu.reg[1] >>> 0) + 8) >>> 0],
    '?terminate@@YAXXZ': ['', (x) => { x.win.say('terminate()'); x.lx.exitProcess(3); return 0; }, cd],
    __CxxFrameHandler: ['ppppp', (x, fi, rec, rn, ctx) => cxxFrameHandler(x, fi, rec, rn, ctx), CXXFH],
  };
  // Every set's functions are ucrtbase's: a name any program imports from any set answers the same.
  const ucrtbase = { ...runtime, ...heapFns, ...math, ...stdio, ...str, ...convert, ...timeFns, ...utility, ...env, ...fs, ...locale, ...vc };
  // msvcrt.dll's names beyond ucrtbase's (api.js gives msvcrt.dll and crtdll.dll every table's functions).
  const tables = UCRT_SETS.map((s) => ({ dll: `api-ms-win-crt-${s}-l1-1-0.dll`, fns: ucrtbase }));
  return [...tables, { dll: 'ucrtbase.dll', fns: ucrtbase }, { dll: 'vcruntime140.dll', fns: vc }, { dll: 'msvcrt-classic', fns: classic }];
}

const wstr = (x, p, n = -1) => { if (!p) return ''; let s = ''; for (let i = 0; n < 0 || i < n; i++) { const c = x.r16(p + 2 * i); if (n < 0 && !c) break; s += String.fromCharCode(c); } return s; };
const wbytes = (s) => { const b = new Uint8Array(2 * s.length + 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xff; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
