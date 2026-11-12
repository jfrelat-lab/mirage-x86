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
  const fileBlock = (x, rec) => { const p = malloc(x, 32); x.write(p, new Uint8Array(32)); st.crtFiles.push(rec); x.w32(p, 0x46494c45); x.w32(p + 4, st.crtFiles.length - 1); rec.ptr = p; return p; };
  const fileOf = (x, F) => (F && x.r32(F) === 0x46494c45 ? st.crtFiles[x.r32(F + 4)] : null);
  const stdFile = (x, i) => (st.crtStd ||= [0, 1, 2].map((k) => fileBlock(x, { cons: k })))[i];
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
    return o.f.bytes ? o.f.bytes[o.pos++] : (o.pos++, 0);
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
    fopen: ['pp', (x, name, mode) => { const h = open(x, x.str(name), x.str(mode)); return h ? fileBlock(x, { h }) : 0; }, cd],
    fclose: ['p', (x, F) => { const r = fileOf(x, F); if (!r) return -1; if (r.cons === undefined) free(x, F); return 0; }, cd],
    fread: ['puup', (x, buf, size, n, F) => {
      const r = fileOf(x, F); if (!r || r.cons !== undefined || !size || !n) return 0;
      let at = buf, want = size * n;
      if (r.back !== undefined) { x.w8(at++, r.back); r.back = undefined; want--; }
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
    _lseek: ['iii', (x, fd, off, how) => { const o = fdH(fd) && st.files[fdH(fd) - 0x4000]; if (!o) return -1; o.pos = Math.max(0, (how === 1 ? o.pos : how === 2 ? o.f.size : 0) + off); return o.pos; }, cd],
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
     * (a send), the next step taken from its result -- an insertion sort, element by element, and a
     * binary search. SDL 2 imports them.
     */
    qsort: ['puup', (x, base, n, w, cmp) => {
      const at = (k) => base + k * w, tmp = x.win.heapAlloc(Math.max(1, w));
      const insert = (i, j) => {                                       // a[i] goes down past a[j] while it compares less
        if (i >= n) { x.win.heapFree(tmp); return 0; }
        if (j < 0) return insert(i + 1, i);
        return send(x, [{ fn: cmp, args: [at(j), at(j + 1)] }], (r) => {
          if ((r | 0) <= 0) return insert(i + 1, i);
          x.write(tmp, x.bytes(at(j), w)); x.write(at(j), x.bytes(at(j + 1), w)); x.write(at(j + 1), x.bytes(tmp, w));
          return insert(i, j - 1);
        }, null);
      };
      return n > 1 ? insert(1, 0) : 0;
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
    // C++ exceptions: one thrown stops the program, named; a frame's handler is never reached otherwise.
    _CxxThrowException: ['pp', (x) => { x.win.say('C++ exception thrown'); x.lx.exitProcess(0xe06d7363); return 0; }],
    __CxxFrameHandler3: ['pppp', () => 1, cd],                      // ExceptionContinueSearch
    _except_handler4_common: ['pppppp', () => 1, cd],
    _local_unwind4: ['ppu', () => 0, cd],
    __telemetry_main_invoke_trigger: ['p', () => 0, cd], __telemetry_main_return_trigger: ['p', () => 0, cd],
    __vcrt_InitializeCriticalSectionEx: ['puu', () => 1, cd],
  };
  // Every set's functions are ucrtbase's: a name any program imports from any set answers the same.
  const ucrtbase = { ...runtime, ...heapFns, ...math, ...stdio, ...str, ...convert, ...timeFns, ...utility, ...env, ...fs, ...locale, ...vc };
  const tables = UCRT_SETS.map((s) => ({ dll: `api-ms-win-crt-${s}-l1-1-0.dll`, fns: ucrtbase }));
  return [...tables, { dll: 'ucrtbase.dll', fns: ucrtbase }, { dll: 'vcruntime140.dll', fns: vc }];
}

const wstr = (x, p, n = -1) => { if (!p) return ''; let s = ''; for (let i = 0; n < 0 || i < n; i++) { const c = x.r16(p + 2 * i); if (n < 0 && !c) break; s += String.fromCharCode(c); } return s; };
const wbytes = (s) => { const b = new Uint8Array(2 * s.length + 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xff; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
