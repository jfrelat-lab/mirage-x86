// modules.js — the rest of Node's built-in modules (util, os, assert, url, readline, timers, string_decoder,
// module, child_process...), the globals they bring, and require: CommonJS from the guest's own files,
// node_modules and package.json as Node resolves them. A part of the HLE node (src/node/kernel.js).
export function modules(N) {
  const G = N.global, path = N.path, fs = N.fs;

  // ---- util ---------------------------------------------------------------------------------------
  const tag = (v) => Object.prototype.toString.call(v).slice(8, -1);
  const types = {
    isDate: (v) => tag(v) === 'Date', isRegExp: (v) => tag(v) === 'RegExp', isMap: (v) => tag(v) === 'Map', isSet: (v) => tag(v) === 'Set',
    isWeakMap: (v) => tag(v) === 'WeakMap', isWeakSet: (v) => tag(v) === 'WeakSet', isPromise: (v) => tag(v) === 'Promise', isNativeError: (v) => v instanceof Error,
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView), isUint8Array: (v) => tag(v) === 'Uint8Array', isArrayBuffer: (v) => tag(v) === 'ArrayBuffer',
    isAnyArrayBuffer: (v) => tag(v) === 'ArrayBuffer' || tag(v) === 'SharedArrayBuffer', isSharedArrayBuffer: (v) => tag(v) === 'SharedArrayBuffer', isDataView: (v) => tag(v) === 'DataView',
    isArrayBufferView: (v) => ArrayBuffer.isView(v), isAsyncFunction: (v) => tag(v) === 'AsyncFunction' || tag(v) === 'AsyncGeneratorFunction', isGeneratorFunction: (v) => /GeneratorFunction$/.test(tag(v)),
    isGeneratorObject: (v) => tag(v) === 'Generator', isBoxedPrimitive: (v) => v !== null && typeof v === 'object' && ['Number', 'String', 'Boolean', 'BigInt', 'Symbol'].includes(tag(v)),
    isNumberObject: (v) => typeof v === 'object' && tag(v) === 'Number', isStringObject: (v) => typeof v === 'object' && tag(v) === 'String', isBooleanObject: (v) => typeof v === 'object' && tag(v) === 'Boolean',
    isSymbolObject: (v) => typeof v === 'object' && tag(v) === 'Symbol', isBigIntObject: (v) => typeof v === 'object' && tag(v) === 'BigInt', isProxy: () => false, isExternal: () => false,
    isModuleNamespaceObject: (v) => tag(v) === 'Module', isMapIterator: (v) => tag(v) === 'Map Iterator', isSetIterator: (v) => tag(v) === 'Set Iterator', isArgumentsObject: (v) => tag(v) === 'Arguments',
    isKeyObject: () => false, isCryptoKey: () => false, isFloat32Array: (v) => tag(v) === 'Float32Array', isFloat64Array: (v) => tag(v) === 'Float64Array', isInt8Array: (v) => tag(v) === 'Int8Array',
    isInt16Array: (v) => tag(v) === 'Int16Array', isInt32Array: (v) => tag(v) === 'Int32Array', isUint16Array: (v) => tag(v) === 'Uint16Array', isUint32Array: (v) => tag(v) === 'Uint32Array',
    isUint8ClampedArray: (v) => tag(v) === 'Uint8ClampedArray', isBigInt64Array: (v) => tag(v) === 'BigInt64Array', isBigUint64Array: (v) => tag(v) === 'BigUint64Array',
  };
  const deepEqual = (a, b, strict, memo = new Map()) => {
    if (strict ? Object.is(a, b) : a == b || (Number.isNaN(a) && Number.isNaN(b))) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (tag(a) !== tag(b)) return false;
    if (memo.get(a) === b) return true;
    memo.set(a, b);
    if (a instanceof Date) { if (a.getTime() !== b.getTime()) return false; }
    else if (a instanceof RegExp) { if (String(a) !== String(b) || a.lastIndex !== b.lastIndex) return false; }
    else if (types.isBoxedPrimitive(a)) { if (!Object.is(a.valueOf(), b.valueOf())) return false; }
    else if (a instanceof Error) { if (a.message !== b.message || a.name !== b.name) return false; }
    if (ArrayBuffer.isView(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && (strict || a[i] != b[i])) return false; }
    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) { if (!b.has(k)) { let found = false; for (const [k2, v2] of b) if (deepEqual(k, k2, strict, memo) && deepEqual(v, v2, strict, memo)) { found = true; break; } if (!found) return false; } else if (!deepEqual(v, b.get(k), strict, memo)) return false; }
    }
    if (a instanceof Set) {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) { let found = false; for (const v2 of b) if (deepEqual(v, v2, strict, memo)) { found = true; break; } if (!found) return false; }
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k)) return false; if (!deepEqual(a[k], b[k], strict, memo)) return false; }
    if (strict) {
      const sa = Object.getOwnPropertySymbols(a).filter((s) => Object.prototype.propertyIsEnumerable.call(a, s)), sb = Object.getOwnPropertySymbols(b).filter((s) => Object.prototype.propertyIsEnumerable.call(b, s));
      if (sa.length !== sb.length) return false;
      for (const s of sa) if (!deepEqual(a[s], b[s], strict, memo)) return false;
    }
    return true;
  };
  const kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');
  const promisify = (f) => {
    if (typeof f !== 'function') throw N.invalidArg('original', 'of type function', f);
    if (f[kCustomPromisify]) return f[kCustomPromisify];
    const p = function (...args) { return new Promise((resolve, reject) => { f.call(this, ...args, (err, ...values) => (err ? reject(err) : resolve(values.length > 1 && f.__multi ? values : values[0]))); }); };
    Object.setPrototypeOf(p, Object.getPrototypeOf(f));
    Object.defineProperty(p, kCustomPromisify, { value: p });
    return Object.defineProperties(p, Object.getOwnPropertyDescriptors(f));
  };
  promisify.custom = kCustomPromisify;
  const deprecated = new Set();
  const util = {
    inspect: N.inspect, format: N.format, formatWithOptions: N.formatWithOptions, types, promisify,
    isDeepStrictEqual: (a, b) => deepEqual(a, b, true),
    inherits: (ctor, superCtor) => { Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true }); Object.setPrototypeOf(ctor.prototype, superCtor.prototype); },
    deprecate: (fn, msg, code) => { const w = function (...a) { if (!deprecated.has(code || msg)) { deprecated.add(code || msg); N.process.emitWarning(msg, 'DeprecationWarning', code); } return new.target ? Reflect.construct(fn, a, new.target) : fn.apply(this, a); }; Object.setPrototypeOf(w, fn); return w; },
    callbackify: (f) => function (...a) { const cb = a.pop(); f.apply(this, a).then((v) => N.nextTick(cb, null, v), (e) => N.nextTick(cb, e)); },
    debuglog: () => { const f = () => {}; f.enabled = false; return f; },
    inspectSymbol: N.inspect.custom, TextEncoder: G.TextEncoder || N.TextEncoder, TextDecoder: G.TextDecoder || N.TextDecoder,
    isArray: Array.isArray, isBoolean: (v) => typeof v === 'boolean', isNull: (v) => v === null, isNullOrUndefined: (v) => v == null, isNumber: (v) => typeof v === 'number',
    isString: (v) => typeof v === 'string', isSymbol: (v) => typeof v === 'symbol', isUndefined: (v) => v === undefined, isRegExp: types.isRegExp, isObject: (v) => v !== null && typeof v === 'object',
    isDate: types.isDate, isError: (v) => v instanceof Error, isFunction: (v) => typeof v === 'function', isPrimitive: (v) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
    stripVTControlCharacters: (s) => s.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g, ''),
    styleText: (fmt, text) => text, toUSVString: (s) => String(s).toWellFormed(), getSystemErrorName: (n) => (N.ERRORS[-n] || ['Unknown system error ' + n])[0],
    getSystemErrorMap: () => new Map(Object.entries(N.ERRORS).map(([n, v]) => [-n, v])), aborted: () => new Promise(() => {}),
    parseArgs: (cfg = {}) => parseArgs(cfg),
  };
  // util.parseArgs, as Node's: options long and short, booleans and strings, positionals, strict.
  const parseArgs = ({ args = N.process.argv.slice(2), options = {}, strict = true, allowPositionals = !strict, tokens: wantTokens = false, allowNegative = false } = {}) => {
    const values = { __proto__: null }, positionals = [], tokens = [];
    const shortOf = {}; for (const [name, o] of Object.entries(options)) if (o.short) shortOf[o.short] = name;
    const unknown = (raw) => N.nodeError(TypeError, 'ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${raw}'${allowPositionals ? '' : ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"" + raw + "\""}`);
    const store = (name, value, raw) => {
      const o = options[name];
      if (!o) { if (strict) throw unknown(raw); values[name] = value === undefined ? true : value; return; }
      if (o.type === 'string' && value === undefined && strict) throw N.nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${o.short ? `-${o.short}, ` : ''}--${name} <value>' argument missing`);
      if (o.type === 'boolean' && value !== undefined && strict) throw N.nodeError(TypeError, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '${o.short ? `-${o.short}, ` : ''}--${name}' does not take an argument`);
      const v = o.type === 'boolean' ? (value === undefined ? true : value) : value;
      if (o.multiple) (values[name] ||= []).push(v); else values[name] = v;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('='), name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (allowNegative && name.startsWith('no-') && options[name.slice(3)]?.type === 'boolean') { values[name.slice(3)] = false; continue; }
        let value = eq > 0 ? a.slice(eq + 1) : undefined;
        if (value === undefined && options[name]?.type === 'string' && i + 1 < args.length) value = args[++i];
        store(name, value, a); tokens.push({ kind: 'option', name, rawName: eq > 0 ? a.slice(0, eq) : a, index: i, value, inlineValue: eq > 0 });
      } else if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const s = a[j], name = shortOf[s] ?? s;
          if (options[name]?.type === 'string') { const value = j + 1 < a.length ? a.slice(j + 1) : args[++i]; store(name, value, `-${s}`); break; }
          store(name, undefined, `-${s}`);
        }
      } else {
        if (!allowPositionals) throw N.nodeError(TypeError, 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Unexpected argument '${a}'. This command does not take positional arguments`);
        positionals.push(a);
      }
    }
    for (const [name, o] of Object.entries(options)) if (values[name] === undefined && o.default !== undefined) values[name] = o.default;
    return wantTokens ? { values, positionals, tokens } : { values, positionals };
  };
  N.util = util;

  // ---- os -----------------------------------------------------------------------------------------
  const uname = () => N.scope(() => { const va = N.alloc(390); N.sys(122, va); const f = (i) => N.cstr(va + i * 65); return { sysname: f(0), nodename: f(1), release: f(2), version: f(3), machine: f(4) }; });
  const os = {
    EOL: '\n', devNull: '/dev/null', platform: () => 'linux', type: () => uname().sysname, release: () => uname().release, version: () => uname().version, machine: () => uname().machine, arch: () => 'ia32',
    hostname: () => uname().nodename, homedir: () => N.process.env.HOME || '/root', tmpdir: () => { const t = N.process.env.TMPDIR || N.process.env.TMP || N.process.env.TEMP || '/tmp'; return t.length > 1 && t.endsWith('/') ? t.slice(0, -1) : t; },
    endianness: () => 'LE', uptime: () => N.scope(() => { const va = N.alloc(64); N.sys(116, va); return N.u32(va); }),
    totalmem: () => N.scope(() => { const va = N.alloc(64); N.sys(116, va); return N.u32(va + 16) * (N.u32(va + 52) || 1); }),
    freemem: () => N.scope(() => { const va = N.alloc(64); N.sys(116, va); return N.u32(va + 20) * (N.u32(va + 52) || 1); }),
    availableParallelism: () => 1, cpus: () => [{ model: 'MIRAGE x86', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    loadavg: () => [0, 0, 0], networkInterfaces: () => ({}), getPriority: () => 0, setPriority: () => {},
    userInfo: () => { const uid = N.process.getuid(), gid = N.process.getgid(); let username = String(uid), homedir = os.homedir(), shell = null; try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const r = l.split(':'); if (+r[2] === uid) { username = r[0]; homedir = r[5]; shell = r[6] || null; break; } } } catch { /* none */ } return { uid, gid, username, homedir, shell }; },
    constants: { signals: N.signals, errno: Object.fromEntries(Object.entries(N.ERRORS).map(([n, [c]]) => [c, +n])), priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }, UV_UDP_REUSEADDR: 4, dlopen: {} },
  };

  // ---- assert -------------------------------------------------------------------------------------
  class AssertionError extends Error {
    constructor(o) {
      super(o.message ?? `${N.inspect(o.actual)} ${o.operator} ${N.inspect(o.expected)}`);
      this.generatedMessage = !o.message; this.code = 'ERR_ASSERTION'; this.actual = o.actual; this.expected = o.expected; this.operator = o.operator;
    }
    get name() { return 'AssertionError'; }
  }
  const fail = (actual, expected, message, operator, generated) => {
    if (message instanceof Error) throw message;
    const e = new AssertionError({ actual, expected, operator, message: message ?? generated });
    e.generatedMessage = message === undefined;
    throw e;
  };
  const diffMsg = (head, a, b) => `${head}\n\n${N.inspect(a)}\n\nshould equal\n\n${N.inspect(b)}`;
  const matches = (err, expected) => {
    if (expected === undefined) return true;
    if (typeof expected === 'function') { if (expected.prototype !== undefined && err instanceof expected) return true; if (Error.isPrototypeOf(expected) || expected === Error) return false; return expected(err) === true; }
    if (expected instanceof RegExp) return expected.test(String(err));
    if (typeof expected === 'object') return Object.keys(expected).every((k) => (expected[k] instanceof RegExp && typeof err[k] === 'string' ? expected[k].test(err[k]) : deepEqual(err[k], expected[k], true)));
    return false;
  };
  const assert = (v, msg) => { if (!v) fail(v, true, msg, '==', 'The expression evaluated to a falsy value:\n\n  assert(' + N.inspect(v) + ')\n'); };
  Object.assign(assert, {
    ok: (v, msg) => { if (!v) fail(v, true, msg, '==', 'The expression evaluated to a falsy value:\n\n  assert.ok(' + N.inspect(v) + ')\n'); },
    equal: (a, b, msg) => { if (!(a == b || (Number.isNaN(a) && Number.isNaN(b)))) fail(a, b, msg, '==', `${N.inspect(a)} == ${N.inspect(b)}`); },
    notEqual: (a, b, msg) => { if (a == b) fail(a, b, msg, '!=', `${N.inspect(a)} != ${N.inspect(b)}`); },
    strictEqual: (a, b, msg) => { if (!Object.is(a, b)) fail(a, b, msg, 'strictEqual', typeof a === 'object' || typeof b === 'object' ? diffMsg('Expected values to be strictly equal:', a, b) : `Expected values to be strictly equal:\n\n${N.inspect(a)} !== ${N.inspect(b)}\n`); },
    notStrictEqual: (a, b, msg) => { if (Object.is(a, b)) fail(a, b, msg, 'notStrictEqual', `Expected "actual" to be strictly unequal to: ${N.inspect(b)}`); },
    deepEqual: (a, b, msg) => { if (!deepEqual(a, b, false)) fail(a, b, msg, 'deepEqual', diffMsg('Expected values to be loosely deep-equal:', a, b)); },
    deepStrictEqual: (a, b, msg) => { if (!deepEqual(a, b, true)) fail(a, b, msg, 'deepStrictEqual', diffMsg('Expected values to be strictly deep-equal:', a, b)); },
    notDeepEqual: (a, b, msg) => { if (deepEqual(a, b, false)) fail(a, b, msg, 'notDeepEqual', `Expected "actual" not to be loosely deep-equal to: ${N.inspect(b)}`); },
    notDeepStrictEqual: (a, b, msg) => { if (deepEqual(a, b, true)) fail(a, b, msg, 'notDeepStrictEqual', `Expected "actual" not to be strictly deep-equal to: ${N.inspect(b)}`); },
    fail: (msg = 'Failed') => fail(undefined, undefined, msg, 'fail'),
    throws: (fn, expected, msg) => {
      if (typeof expected === 'string') { msg = expected; expected = undefined; }
      try { fn(); } catch (e) { if (!matches(e, expected)) { if (typeof expected === 'function' && !Error.isPrototypeOf(expected) && expected !== Error) throw e; throw e; } return; }
      fail(undefined, expected, msg, 'throws', `Missing expected exception${expected && expected.name ? ` (${expected.name})` : ''}${msg ? `: ${msg}` : '.'}`);
    },
    doesNotThrow: (fn, msg) => { try { fn(); } catch (e) { fail(e, undefined, typeof msg === 'string' ? msg : undefined, 'doesNotThrow', `Got unwanted exception.\nActual message: "${e && e.message}"`); } },
    rejects: async (p, expected, msg) => {
      try { await (typeof p === 'function' ? p() : p); } catch (e) { if (!matches(e, expected)) throw e; return; }
      fail(undefined, expected, msg, 'rejects', 'Missing expected rejection.');
    },
    doesNotReject: async (p, msg) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { fail(e, undefined, msg, 'doesNotReject', `Got unwanted rejection.\nActual message: "${e && e.message}"`); } },
    match: (s, re, msg) => { if (!re.test(s)) fail(s, re, msg, 'match', `The input did not match the regular expression ${re}. Input:\n\n${N.inspect(s)}\n`); },
    doesNotMatch: (s, re, msg) => { if (re.test(s)) fail(s, re, msg, 'doesNotMatch', `The input was expected to not match the regular expression ${re}. Input:\n\n${N.inspect(s)}\n`); },
    ifError: (e) => { if (e !== null && e !== undefined) throw e; },
    AssertionError,
  });
  assert.strict = Object.assign((v, m) => assert.ok(v, m), assert, { equal: assert.strictEqual, deepEqual: assert.deepStrictEqual, notEqual: assert.notStrictEqual, notDeepEqual: assert.notDeepStrictEqual });
  assert.strict.strict = assert.strict;

  // ---- url (WHATWG URL where the realm has none) ------------------------------------------------
  if (typeof G.URL !== 'function') {
    class URLSearchParams {
      constructor(init = '') {
        this._list = [];
        if (typeof init === 'string') { for (const part of init.replace(/^\?/, '').split('&')) if (part) { const i = part.indexOf('='); const dec = (s) => decodeURIComponent(s.replace(/\+/g, ' ')); this._list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]); } }
        else if (init && typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this._list.push([String(k), String(v)]);
        else if (init && typeof init === 'object') for (const k of Object.keys(init)) this._list.push([k, String(init[k])]);
      }
      append(k, v) { this._list.push([String(k), String(v)]); this._update(); }
      delete(k) { this._list = this._list.filter(([x]) => x !== k); this._update(); }
      get(k) { const e = this._list.find(([x]) => x === k); return e ? e[1] : null; }
      getAll(k) { return this._list.filter(([x]) => x === k).map(([, v]) => v); }
      has(k) { return this._list.some(([x]) => x === k); }
      set(k, v) { const i = this._list.findIndex(([x]) => x === k); if (i < 0) this._list.push([k, String(v)]); else { this._list[i][1] = String(v); this._list = this._list.filter(([x], j) => x !== k || j === i); } this._update(); }
      sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._update(); }
      get size() { return this._list.length; }
      forEach(f, t) { for (const [k, v] of this._list) f.call(t, v, k, this); }
      keys() { return this._list.map(([k]) => k)[Symbol.iterator](); } values() { return this._list.map(([, v]) => v)[Symbol.iterator](); } entries() { return this._list.map((e) => e.slice())[Symbol.iterator](); }
      [Symbol.iterator]() { return this.entries(); }
      toString() { const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); return this._list.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&'); }
      _update() { if (this._url) { const s = this.toString(); this._url._search = s ? '?' + s : ''; } }
    }
    const SPECIAL = { 'ftp:': '21', 'file:': '', 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };
    const parse = (input, base) => {
      input = String(input).trim();
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(input);
      let protocol, rest;
      if (m) { protocol = m[1].toLowerCase() + ':'; rest = m[2]; }
      else {
        if (!base) return null;
        const b = base instanceof URL ? base : new URL(base);
        protocol = b.protocol;
        if (input.startsWith('//')) rest = input;
        else {
          const r = { protocol, username: b.username, password: b.password, hostname: b.hostname, port: b.port, pathname: b.pathname, search: b.search, hash: '' };
          const hi = input.indexOf('#'); if (hi >= 0) { r.hash = input.slice(hi); input = input.slice(0, hi); }
          const qi = input.indexOf('?'); if (qi >= 0) { r.search = input.slice(qi); input = input.slice(0, qi); } else if (input !== '') r.search = '';
          if (input.startsWith('/')) r.pathname = input; else if (input !== '') r.pathname = b.pathname.replace(/[^/]*$/, '') + input;
          r.pathname = dots(r.pathname);
          if (r.search === '?') r.search = '';
          return r;
        }
      }
      const special = protocol in SPECIAL;
      const r = { protocol, username: '', password: '', hostname: '', port: '', pathname: '', search: '', hash: '' };
      const hi = rest.indexOf('#'); if (hi >= 0) { r.hash = rest.slice(hi); rest = rest.slice(0, hi); }
      const qi = rest.indexOf('?'); if (qi >= 0) { r.search = rest.slice(qi); rest = rest.slice(0, qi); }
      if (special) rest = rest.replace(/\\/g, '/');
      if (protocol === 'file:' && rest.startsWith('//')) { const si = rest.indexOf('/', 2); r.hostname = si < 0 ? rest.slice(2) : rest.slice(2, si); r.pathname = si < 0 ? '/' : rest.slice(si); rest = null; }
      if (rest === null) { /* file: done */ } else if (rest.startsWith('//') || (special && protocol !== 'file:')) {
        rest = rest.replace(/^\/*/, '');
        const si = rest.indexOf('/'); let auth = si < 0 ? rest : rest.slice(0, si); r.pathname = si < 0 ? (special ? '/' : '') : rest.slice(si);
        const at = auth.lastIndexOf('@'); if (at >= 0) { const cred = auth.slice(0, at); auth = auth.slice(at + 1); const ci = cred.indexOf(':'); r.username = ci < 0 ? cred : cred.slice(0, ci); r.password = ci < 0 ? '' : cred.slice(ci + 1); }
        const pm = /^(.*?)(?::(\d*))?$/.exec(auth); r.hostname = special ? pm[1].toLowerCase() : pm[1]; r.port = pm[2] || '';
        if (r.port === SPECIAL[protocol]) r.port = '';
      } else r.pathname = rest;
      if (special) r.pathname = dots(r.pathname || '/');
      r.pathname = r.pathname.replace(/[ "<>`{}|^]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      if (r.search === '?') r.search = '';
      if (r.hash === '#') r.hash = '';
      return r;
    };
    const dots = (p) => { const out = []; const parts = p.split('/'); for (let i = 0; i < parts.length; i++) { const s = parts[i]; if (s === '..') { if (out.length > 1) out.pop(); if (i === parts.length - 1) out.push(''); } else if (s === '.') { if (i === parts.length - 1) out.push(''); } else out.push(s); } return out.join('/') || '/'; };
    class URL {
      constructor(input, base) { const r = parse(input, base); if (!r) { const e = N.nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid URL'); e.input = String(input); throw e; } Object.assign(this, { _protocol: r.protocol, _username: r.username, _password: r.password, _hostname: r.hostname, _port: r.port, _pathname: r.pathname, _search: r.search, _hash: r.hash }); }
      static canParse(i, b) { try { new URL(i, b); return true; } catch { return false; } }
      static parse(i, b) { try { return new URL(i, b); } catch { return null; } }
      get protocol() { return this._protocol; } set protocol(v) { this._protocol = String(v).replace(/:?$/, ':'); }
      get username() { return this._username; } set username(v) { this._username = v; }
      get password() { return this._password; } set password(v) { this._password = v; }
      get hostname() { return this._hostname; } set hostname(v) { this._hostname = v; }
      get port() { return this._port; } set port(v) { this._port = String(v) === SPECIAL[this._protocol] ? '' : String(v); }
      get host() { return this._hostname + (this._port ? ':' + this._port : ''); } set host(v) { const [h, p] = String(v).split(':'); this._hostname = h; this._port = p || ''; }
      get origin() { return this._protocol in SPECIAL && this._protocol !== 'file:' ? `${this._protocol}//${this.host}` : 'null'; }
      get pathname() { return this._pathname; } set pathname(v) { this._pathname = String(v).startsWith('/') ? String(v) : '/' + v; }
      get search() { return this._search; } set search(v) { v = String(v); this._search = v === '' || v === '?' ? '' : v.startsWith('?') ? v : '?' + v; this._sp = null; }
      get searchParams() { if (!this._sp) { this._sp = new URLSearchParams(this._search); this._sp._url = this; } return this._sp; }
      get hash() { return this._hash; } set hash(v) { v = String(v); this._hash = v === '' || v === '#' ? '' : v.startsWith('#') ? v : '#' + v; }
      get href() { const auth = this._username || this._password ? `${this._username}${this._password ? ':' + this._password : ''}@` : ''; const slashes = this._protocol in SPECIAL || this._hostname ? '//' : ''; return `${this._protocol}${slashes}${auth}${this.host}${this._pathname}${this._search}${this._hash}`; }
      set href(v) { Object.assign(this, new URL(v)); }
      toString() { return this.href; } toJSON() { return this.href; }
      [N.inspect.custom]() { return `URL {\n  href: '${this.href}',\n  origin: '${this.origin}',\n  protocol: '${this.protocol}',\n  username: '${this.username}',\n  password: '${this.password}',\n  host: '${this.host}',\n  hostname: '${this.hostname}',\n  port: '${this.port}',\n  pathname: '${this.pathname}',\n  search: '${this.search}',\n  searchParams: URLSearchParams {${this.searchParams.size ? ' ' + [...this.searchParams].map(([k, v]) => `'${k}' => '${v}'`).join(', ') + ' ' : ''}},\n  hash: '${this.hash}'\n}`; }
    }
    G.URL = URL; G.URLSearchParams = URLSearchParams;
  }
  N.fileURLToPath = (u) => {
    if (typeof u === 'string') u = new G.URL(u);
    if (u.protocol !== 'file:') throw N.nodeError(TypeError, 'ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
    return decodeURIComponent(u.pathname);
  };
  const pathToFileURL = (p) => { let r = path.resolve(p); if (p.endsWith('/') && !r.endsWith('/')) r += '/'; return new G.URL('file://' + encodeURI(r).replace(/[?#]/g, encodeURIComponent)); };
  const url = { URL: G.URL, URLSearchParams: G.URLSearchParams, fileURLToPath: N.fileURLToPath, pathToFileURL, domainToASCII: (d) => d.toLowerCase(), domainToUnicode: (d) => d,
    parse: (s, qs) => { const u = new G.URL(s, 'http://_'); const rel = !/^[a-z][a-z0-9+.-]*:/i.test(s); return { protocol: rel ? null : u.protocol, slashes: rel ? null : true, auth: u.username ? u.username + (u.password ? ':' + u.password : '') : null, host: rel ? null : u.host, port: u.port || null, hostname: rel ? null : u.hostname, hash: u.hash || null, search: u.search || null, query: qs ? Object.fromEntries(u.searchParams) : (u.search.slice(1) || null), pathname: u.pathname, path: u.pathname + u.search, href: rel ? s : u.href }; },
    format: (u) => (typeof u === 'string' ? u : u instanceof G.URL ? u.href : `${u.protocol ? u.protocol + '//' : ''}${u.host || u.hostname || ''}${u.pathname || ''}${u.search || ''}${u.hash || ''}`),
    resolve: (from, to) => new G.URL(to, new G.URL(from, 'resolve://')).href.replace(/^resolve:\/\//, '') };
  const querystring = {
    parse: (s, sep = '&', eq = '=') => { const o = Object.create(null); for (const part of String(s).split(sep)) { if (!part) continue; const i = part.indexOf(eq); const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' ')), v = i < 0 ? '' : decodeURIComponent(part.slice(i + eq.length).replace(/\+/g, ' ')); if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; } return o; },
    stringify: (o, sep = '&', eq = '=') => Object.entries(o || {}).flatMap(([k, v]) => [].concat(v).map((x) => `${querystring.escape(k)}${eq}${querystring.escape(typeof x === 'object' ? '' : String(x))}`)).join(sep),
    escape: (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()), unescape: (s) => decodeURIComponent(s),
  };
  querystring.decode = querystring.parse; querystring.encode = querystring.stringify;

  // ---- readline -----------------------------------------------------------------------------------
  class Interface extends N.EventEmitter {
    constructor(input, output, completer, terminal) {
      super();
      if (input && input.input) ({ input, output, completer, terminal } = input);
      const opts = arguments[0] && arguments[0].input ? arguments[0] : {};
      this.input = input; this.output = output; this.terminal = !!terminal; this.line = ''; this.closed = false; this.history = [];
      this._prompt = opts.prompt ?? '> '; this._pending = ''; this._questions = []; this._paused = false;
      this._crlfDelay = opts.crlfDelay ?? 100;
      this._onData = (chunk) => this._feed(typeof chunk === 'string' ? chunk : this._decoder.write(chunk));
      this._onEnd = () => { if (this._pending.length) { const l = this._pending; this._pending = ''; this._line(l); } this.close(); };
      this._decoder = new N.StringDecoder('utf8');
      input.on('data', this._onData); input.on('end', this._onEnd);
      if (typeof input.resume === 'function') input.resume();
    }
    _feed(s) {
      this._pending += s;
      let i;
      while (!this.closed && (i = this._pending.search(/\r\n|\n|\r/)) >= 0) {
        const m = /\r\n|\n|\r/.exec(this._pending.slice(i))[0], l = this._pending.slice(0, i);
        this._pending = this._pending.slice(i + m.length);
        this._line(l);
      }
    }
    _line(l) {
      if (this._questions.length) { const cb = this._questions.shift(); cb(l); return; }
      this.emit('line', l);
    }
    setPrompt(p) { this._prompt = p; }
    getPrompt() { return this._prompt; }
    prompt() { if (this.closed) throw N.nodeError(Error, 'ERR_USE_AFTER_CLOSE', 'readline was closed'); if (this.output) this.output.write(this._prompt); if (this._paused) this.resume(); }
    question(q, opts, cb) {
      if (typeof opts === 'function') cb = opts;
      if (this.closed) throw N.nodeError(Error, 'ERR_USE_AFTER_CLOSE', 'readline was closed');
      if (this.output) this.output.write(q);
      this._questions.push(cb);
    }
    write(d) { if (this.closed) throw N.nodeError(Error, 'ERR_USE_AFTER_CLOSE', 'readline was closed'); if (typeof d === 'string') this._feed(d); }
    pause() { if (!this._paused) { this._paused = true; this.input.pause(); this.emit('pause'); } return this; }
    resume() { if (this._paused) { this._paused = false; this.input.resume(); this.emit('resume'); } return this; }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.input.removeListener('data', this._onData); this.input.removeListener('end', this._onEnd);
      if (typeof this.input.pause === 'function') this.input.pause();
      this.emit('close');
    }
    getCursorPos() { return { rows: 0, cols: this.line.length }; }
    [Symbol.asyncIterator]() {
      const queue = [], waiting = [];
      let done = false;
      this.on('line', (l) => { if (waiting.length) waiting.shift()({ value: l, done: false }); else queue.push(l); });
      this.on('close', () => { done = true; while (waiting.length) waiting.shift()({ value: undefined, done: true }); });
      return { next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiting.push(r))),
        return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); }, [Symbol.asyncIterator]() { return this; } };
    }
    [Symbol.dispose]() { this.close(); }
  }
  const readline = {
    Interface, createInterface: (...a) => new Interface(...a),
    clearLine: (s, dir, cb) => { s.write(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K'); if (cb) N.nextTick(cb); return true; },
    clearScreenDown: (s, cb) => { s.write('\x1b[0J'); if (cb) N.nextTick(cb); return true; },
    cursorTo: (s, x, y, cb) => { if (typeof y === 'function') { cb = y; y = undefined; } s.write(y === undefined ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`); if (cb) N.nextTick(cb); return true; },
    moveCursor: (s, dx, dy, cb) => { let o = ''; if (dx) o += dx > 0 ? `\x1b[${dx}C` : `\x1b[${-dx}D`; if (dy) o += dy > 0 ? `\x1b[${dy}B` : `\x1b[${-dy}A`; if (o) s.write(o); if (cb) N.nextTick(cb); return true; },
    emitKeypressEvents: () => {},
  };
  readline.promises = { Interface, createInterface: (...a) => { const rl = new Interface(...a); const q = rl.question.bind(rl); rl.question = (query, opts) => new Promise((resolve) => q(query, opts, resolve)); return rl; } };

  // ---- the remaining modules -----------------------------------------------------------------------
  const notYet = (mod) => new Proxy({}, { get: (t, k) => (k === '__esModule' || typeof k === 'symbol' ? undefined : () => { throw N.nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `${mod}.${String(k)} is not available in MIRAGE yet`); }) });
  const timersPromises = {
    setTimeout: (ms, v) => new Promise((r) => N.timers.setTimeout(r, ms, v)),
    setImmediate: (v) => new Promise((r) => N.timers.setImmediate(r, v)),
    setInterval: async function* (ms, v) { for (;;) { await new Promise((r) => N.timers.setTimeout(r, ms)); yield v; } },
    scheduler: { wait: (ms) => new Promise((r) => N.timers.setTimeout(r, ms)), yield: () => new Promise((r) => N.timers.setImmediate(r)) },
  };
  const builtins = {
    assert, 'assert/strict': assert.strict, buffer: N.bufferModule, child_process: N.childProcess || notYet('child_process'), console: N.console, constants: { ...os.constants.errno, ...N.signals, ...fs.constants },
    crypto: N.cryptoModule, events: N.EventEmitter, fs, 'fs/promises': fs.promises, module: null, os, path, 'path/posix': path, 'path/win32': path, process: N.process, querystring,
    readline, 'readline/promises': readline.promises, stream: N.stream, 'stream/promises': N.stream.promises, string_decoder: { StringDecoder: N.StringDecoder },
    timers: { ...N.timers, promises: timersPromises }, 'timers/promises': timersPromises, tty: { isatty: (fd) => N.scope(() => N.sys(54, fd, 0x5401, N.alloc(64)) >= 0), ReadStream: N.stream.Readable, WriteStream: N.stream.Writable },
    url, util, 'util/types': types, v8: { getHeapStatistics: () => ({ total_heap_size: 20e6, used_heap_size: 10e6, heap_size_limit: 2 ** 31 }), serialize: (v) => N.Buffer.from(JSON.stringify(v)), deserialize: (b) => JSON.parse(b.toString()) },
    vm: { runInThisContext: (code) => (0, eval)(code), runInNewContext: (code, ctx = {}) => Function(...Object.keys(ctx), `return eval(${JSON.stringify(String(code))})`)(...Object.values(ctx)), Script: class Script { constructor(c) { this.code = c; } runInThisContext() { return (0, eval)(this.code); } }, isContext: () => false, createContext: (o = {}) => o },
    worker_threads: { isMainThread: true, parentPort: null, workerData: null, threadId: 0, Worker: class Worker { constructor() { throw N.nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'worker_threads is not available in MIRAGE yet'); } } },
    zlib: notYet('zlib'), http: notYet('http'), https: notYet('https'), net: notYet('net'), dgram: notYet('dgram'), dns: notYet('dns'), tls: notYet('tls'), http2: notYet('http2'),
    cluster: { isPrimary: true, isMaster: true, isWorker: false }, perf_hooks: { performance: N.performance, PerformanceObserver: class {} }, async_hooks: { AsyncLocalStorage: class AsyncLocalStorage { run(s, f, ...a) { this._s = s; try { return f(...a); } finally { this._s = undefined; } } getStore() { return this._s; } enterWith(s) { this._s = s; } }, createHook: () => ({ enable() { return this; }, disable() { return this; } }), executionAsyncId: () => 1, triggerAsyncId: () => 0, AsyncResource: class AsyncResource { runInAsyncScope(f, t, ...a) { return f.apply(t, a); } } },
    diagnostics_channel: { channel: () => ({ hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {} }), hasSubscribers: () => false, subscribe() {}, unsubscribe() {} },
    punycode: { toASCII: (s) => s, toUnicode: (s) => s }, inspector: notYet('inspector'), repl: notYet('repl'), sea: { isSea: () => false }, test: notYet('test'), wasi: notYet('wasi'), trace_events: notYet('trace_events'), domain: notYet('domain'),
  };
  const schemeOnly = new Set(['sea', 'test', 'test/reporters', 'sqlite']);

  // ---- require: CommonJS, resolved as Node resolves it -------------------------------------------
  const isFile = (p) => { const s = N.fsio.statAt(p, 0, 'stat', { throwIfNoEntry: false }); return !!s && s.isFile(); };
  const isDir = (p) => { const s = N.fsio.statAt(p, 0, 'stat', { throwIfNoEntry: false }); return !!s && s.isDirectory(); };
  const EXTS = ['.js', '.json', '.node', '.cjs', '.mjs'];
  const readPkg = (dir) => { const p = dir + '/package.json'; if (!isFile(p)) return null; try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { e.path = p; e.message = `Error parsing ${p}: ${e.message}`; throw e; } };
  const asFile = (p) => { if (isFile(p)) return p; for (const e of ['.js', '.json', '.node']) if (isFile(p + e)) return p + e; return null; };
  const asDir = (p) => {
    const pkg = readPkg(p);
    if (pkg && typeof pkg.main === 'string' && pkg.main) { const m = path.resolve(p, pkg.main); const r = asFile(m) || asIndex(m); if (r) return r; }
    return asIndex(p);
  };
  const asIndex = (p) => { for (const e of ['.js', '.json', '.node']) if (isFile(p + '/index' + e)) return p + '/index' + e; return null; };
  const conditions = ['require', 'node', 'default', 'module-sync'];
  const pickExport = (target, conds = conditions) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) { for (const t of target) { const r = pickExport(t, conds); if (r) return r; } return null; }
    if (target && typeof target === 'object') for (const [k, v] of Object.entries(target)) if (conds.includes(k)) { const r = pickExport(v, conds); if (r) return r; }
    return null;
  };
  const viaExports = (dir, pkg, sub, conds = conditions) => {
    let ex = pkg.exports;
    if (typeof ex === 'string' || Array.isArray(ex) || (ex && Object.keys(ex).every((k) => !k.startsWith('.')))) ex = { '.': ex };
    if (ex[sub] !== undefined) { const t = pickExport(ex[sub], conds); return t ? path.resolve(dir, t) : null; }
    for (const [k, v] of Object.entries(ex)) {
      const star = k.indexOf('*');
      if (star >= 0 && sub.startsWith(k.slice(0, star)) && sub.endsWith(k.slice(star + 1))) { const t = pickExport(v, conds); if (t) return path.resolve(dir, t.replaceAll('*', sub.slice(star, sub.length - (k.length - star - 1)))); }
    }
    return undefined;
  };
  const notFound = (request, parent) => {
    const stack = []; for (let m = parent; m; m = m.parent) if (m.filename) stack.push(m.filename);
    const e = new Error(`Cannot find module '${request}'${stack.length ? `\nRequire stack:\n- ${stack.join('\n- ')}` : ''}`);
    e.code = 'MODULE_NOT_FOUND'; e.requireStack = stack; return e;
  };
  const resolveFilename = (request, parent) => {
    if (request.startsWith('node:')) { const n = request.slice(5); if (n in builtins || schemeOnly.has(n)) return request; const e = N.nodeError(Error, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${request}`); throw e; }
    if (request in builtins && !schemeOnly.has(request)) return request;
    const base = parent && parent.filename ? path.dirname(parent.filename) : N.process.cwd();
    if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/') || request === '.' || request === '..') {
      const p = path.resolve(base, request);
      const r = (request.endsWith('/') ? null : asFile(p)) || (isDir(p) ? asDir(p) : null);
      if (r) return fs.realpathSync(r);
      throw notFound(request, parent);
    }
    if (request.startsWith('#')) {                                         // package imports
      for (let d = base; ; d = path.dirname(d)) {
        const pkg = readPkg(d);
        if (pkg && pkg.imports && pkg.imports[request]) { const t = pickExport(pkg.imports[request]); if (t) return resolveFilename(t.startsWith('.') ? path.resolve(d, t) : t, parent); }
        if (pkg || d === '/') break;
      }
      throw notFound(request, parent);
    }
    const parts = request.split('/'), name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], sub = '.' + request.slice(name.length);
    const dirs = [];
    for (let d = base; ; d = path.dirname(d)) { if (path.basename(d) !== 'node_modules') dirs.push((d === '/' ? '' : d) + '/node_modules'); if (d === '/') break; }
    const home = N.process.env.HOME; if (home) dirs.push(home + '/.node_modules', home + '/.node_libraries');
    for (const p of (N.process.env.NODE_PATH || '').split(':').filter(Boolean)) dirs.push(p);
    for (const d of dirs) {
      const pdir = d + '/' + name, pkg = isDir(pdir) ? readPkg(pdir) : null;
      if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
        const r = viaExports(pdir, pkg, sub);
        if (r === undefined) { const e = N.nodeError(Error, 'ERR_PACKAGE_PATH_NOT_EXPORTED', sub === '.' ? `No "exports" main defined in ${pdir}/package.json` : `Package subpath '${sub}' is not defined by "exports" in ${pdir}/package.json`); throw e; }
        if (r && isFile(r)) return fs.realpathSync(r);
        continue;
      }
      const p = d + '/' + request;
      const r = asFile(p) || (isDir(p) ? asDir(p) : null);
      if (r) return fs.realpathSync(r);
    }
    throw notFound(request, parent);
  };

  function Module(id = '', parent) {
    this.id = id; this.path = path.dirname(id); this.exports = {}; this.filename = null; this.loaded = false; this.children = []; this.paths = [];
    Object.defineProperty(this, 'parent', { value: parent, writable: true, enumerable: false });
    if (parent && parent.children) parent.children.push(this);
  }
  Module._cache = Object.create(null);
  Module.builtinModules = Object.keys(builtins).filter((k) => k !== 'module');
  Module.isBuiltin = (s) => { const n = String(s).replace(/^node:/, ''); return n in builtins && (!schemeOnly.has(n) || String(s).startsWith('node:')); };
  Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
  Module.wrap = (s) => Module.wrapper[0] + s + Module.wrapper[1];
  Module._extensions = Object.create(null);
  Module._resolveFilename = (req, parent) => resolveFilename(req, parent);
  Module.createRequire = (f) => { const file = typeof f === 'string' ? (f.startsWith('file:') ? N.fileURLToPath(f) : f) : N.fileURLToPath(f); const m = new Module(file); m.filename = file; m.paths = []; return makeRequire(m); };
  Module.syncBuiltinESMExports = () => {}; Module.register = () => {}; Module.enableCompileCache = () => ({ status: 0 }); Module.findPackageJSON = () => undefined;
  Module.Module = Module;
  builtins.module = Module;

  const stripShebang = (src) => (src.startsWith('#!') ? '//' + src.slice(2) : src);
  const stripBOM = (src) => (src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);
  // A .js file is an ES module in a package of "type": "module", or, in one of no type, when it does not
  // compile as CommonJS and has a module's syntax (Node's detection); require() then evaluates its graph
  // (src/node/esm.js).
  Module._extensions['.js'] = (m, filename) => {
    const src = stripBOM(fs.readFileSync(filename, 'utf8'));
    const type = filename.endsWith('.cjs') ? 'commonjs' : filename.endsWith('.mjs') ? 'module' : typeOfPackage(filename);
    if (type === 'module') { m.exports = N.esm.requireESM(filename, m.parent); return; }
    try { m._compile(src, filename); } catch (e) {
      if (type === undefined && m._compiling && e instanceof SyntaxError && N.esm.isModuleSyntax(src)) { m._compiling = false; m.exports = N.esm.requireESM(filename, m.parent); return; }
      throw e;
    }
  };
  Module._extensions['.cjs'] = Module._extensions['.js'];
  Module._extensions['.mjs'] = (m, filename) => { m.exports = N.esm.requireESM(filename, m.parent); };
  Module._extensions['.json'] = (m, filename) => { const src = stripBOM(fs.readFileSync(filename, 'utf8')); try { m.exports = JSON.parse(src); } catch (e) { e.message = filename + ': ' + e.message; throw e; } };
  Module._extensions['.node'] = (m, filename) => { const e = new Error(`${filename}: native addons cannot run in MIRAGE's node`); e.code = 'ERR_DLOPEN_FAILED'; throw e; };
  const typeOfPackage = (file) => { for (let d = path.dirname(file); ; d = path.dirname(d)) { const p = readPkg(d); if (p) return p.type; if (d === '/') return undefined; } };
  // import() in CommonJS: the ES loader's (src/node/esm.js), relative to this file.
  Module.prototype._compile = function (content, filename) {
    const src = stripShebang(content), dyn = N.esm.cjsDynamic(src);
    this._compiling = true;
    const fn = N.bridge.compile(dyn ?? src, filename, ['exports', 'require', 'module', '__filename', '__dirname', '__mI']);
    this._compiling = false;
    const req = makeRequire(this);
    return fn.call(this.exports, this.exports, req, this, filename, path.dirname(filename), (s, o) => N.esm.dynamicImport(s, filename, o));
  };
  Module.prototype.require = function (id) { return load(id, this, false); };
  Module.prototype.load = function (filename) {
    this.filename = filename;
    const ext = Object.keys(Module._extensions).filter((e) => filename.endsWith(e)).sort((a, b) => b.length - a.length)[0] || '.js';
    Module._extensions[ext](this, filename);
    this.loaded = true;
  };
  const makeRequire = (m) => {
    const require = (id) => {
      if (typeof id !== 'string') throw N.invalidArg('id', 'of type string', id);
      if (id === '') throw N.nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'id' must be a non-empty string. Received ''");
      return load(id, m, false);
    };
    require.resolve = (req, opts) => { const r = resolveFilename(req, opts && opts.paths ? { filename: opts.paths[0] + '/x' } : m); return r.startsWith('node:') && !req.startsWith('node:') ? req : r; };
    require.resolve.paths = (req) => (req in builtins ? null : []);
    require.main = N.mainModule; require.cache = Module._cache; require.extensions = Module._extensions;
    return require;
  };
  const load = (request, parent, isMain) => {
    const filename = resolveFilename(request, parent);
    if (filename.startsWith('node:') || filename in builtins) return builtins[filename.replace(/^node:/, '')];
    const cached = Module._cache[filename];
    if (cached) return cached.exports;
    const m = new Module(filename, parent);
    if (isMain) { m.id = '.'; N.mainModule = m; N.process.mainModule = m; }
    Module._cache[filename] = m;
    let ok = false;
    try { m.load(filename); ok = true; } finally { if (!ok) delete Module._cache[filename]; }
    return m.exports;
  };
  // The main module: an ES module (.mjs, a package of "type": "module", a module's syntax in a .js of no
  // type) is the ES loader's to run, the rest CommonJS. -e's code likewise.
  N.runMain = (file) => {
    const filename = resolveFilename(path.resolve(file), null), ext = path.extname(filename);
    const type = ext === '.mjs' ? 'module' : ext === '.js' || ext === '' ? typeOfPackage(filename) : 'commonjs';
    if (type === 'module' || (type === undefined && N.esm.isModuleSyntax(stripBOM(fs.readFileSync(filename, 'utf8'))))) { N.esm.runMain(filename); return; }
    load(path.resolve(file), null, true);
  };
  N.evalScript = (src, name = '[eval]') => {
    if (N.esm.isModuleSyntax(src)) { N.esm.runMain(path.join(N.process.cwd(), name + '1'), src); return undefined; }
    const m = new Module(name); m.filename = path.join(N.process.cwd(), name); m.paths = [];
    const req = makeRequire(m);
    G.require = req; G.module = m; G.exports = m.exports; G.__filename = name; G.__dirname = '.';
    const dyn = N.esm.cjsDynamic(src);
    return N.bridge.compile(`return eval(${JSON.stringify(dyn ?? src)})`, name, ['__mI'])((s, o) => N.esm.dynamicImport(s, m.filename, o));
  };
  N.builtins = builtins;
  N.Module = Module;
  N.pathToFileURL = pathToFileURL;
  N.cjs = { isFile, isDir, readPkg, pickExport, viaExports, typeOfPackage, resolveFilename, schemeOnly, cache: Module._cache, load: (file, parent, isMain) => load(file, parent, isMain) };
  /** Where an error was thrown, as Node prints it above an uncaught one: the file and line, the line, a caret. */
  N.throwSite = (e) => {
    const m = /\n\s+at (?:.*?\()?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?/.exec(String(e.stack || ''));   // an ES module's frame is its URL
    if (!m) return null;
    try { const line = fs.readFileSync(m[1].startsWith('file:') ? N.fileURLToPath(m[1]) : m[1], 'utf8').split('\n')[m[2] - 1]; if (line === undefined) return null; return `${m[1]}:${m[2]}\n${line}\n${' '.repeat(Math.max(0, m[3] - 1))}^\n`; } catch { return null; }
  };

  // ---- the globals the built-in modules bring ---------------------------------------------------
  G.Buffer = N.Buffer;
  if (typeof G.TextEncoder !== 'function') { G.TextEncoder = N.TextEncoder; G.TextDecoder = N.TextDecoder; }
  if (typeof G.atob !== 'function') { G.atob = N.bufferModule.atob; G.btoa = N.bufferModule.btoa; }
  if (typeof G.structuredClone !== 'function') {
    G.structuredClone = (v) => {
      const seen = new Map();
      const clone = (x) => {
        if (x === null || typeof x !== 'object') { if (typeof x === 'function' || typeof x === 'symbol') { const e = new Error(`${String(x)} could not be cloned.`); e.name = 'DataCloneError'; throw e; } return x; }
        if (seen.has(x)) return seen.get(x);
        let out;
        if (x instanceof Date) out = new Date(x.getTime());
        else if (x instanceof RegExp) out = new RegExp(x.source, x.flags);
        else if (x instanceof Map) { out = new Map(); seen.set(x, out); for (const [k, val] of x) out.set(clone(k), clone(val)); return out; }
        else if (x instanceof Set) { out = new Set(); seen.set(x, out); for (const val of x) out.add(clone(val)); return out; }
        else if (ArrayBuffer.isView(x)) out = new (Object.getPrototypeOf(Object.getPrototypeOf(x)) === Uint8Array.prototype ? Uint8Array : x.constructor)(x);
        else if (x instanceof ArrayBuffer) out = x.slice(0);
        else if (x instanceof Error) { out = new (globalThis[x.name] || Error)(x.message); seen.set(x, out); if (x.stack) out.stack = x.stack; if ('cause' in x) out.cause = clone(x.cause); return out; }
        else if (Array.isArray(x)) { out = []; seen.set(x, out); for (let i = 0; i < x.length; i++) out[i] = clone(x[i]); return out; }
        else { out = {}; seen.set(x, out); for (const k of Object.keys(x)) out[k] = clone(x[k]); return out; }
        seen.set(x, out); return out;
      };
      return clone(v);
    };
  }
  if (typeof G.EventTarget !== 'function') {
    class Event { constructor(type, opts = {}) { this.type = type; this.bubbles = !!opts.bubbles; this.cancelable = !!opts.cancelable; this.defaultPrevented = false; this.timeStamp = N.performance.now(); } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } stopPropagation() {} stopImmediatePropagation() { this._stop = true; } }
    class EventTarget {
      constructor() { Object.defineProperty(this, '_l', { value: new Map() }); }
      addEventListener(t, f, o) { if (!f) return; if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push({ f, once: !!(o && o.once) }); }
      removeEventListener(t, f) { const l = this._l.get(t); if (l) this._l.set(t, l.filter((x) => x.f !== f)); }
      dispatchEvent(e) { Object.defineProperty(e, 'target', { value: this, configurable: true }); Object.defineProperty(e, 'currentTarget', { value: this, configurable: true }); for (const x of (this._l.get(e.type) || []).slice()) { if (x.once) this.removeEventListener(e.type, x.f); typeof x.f === 'function' ? x.f.call(this, e) : x.f.handleEvent(e); if (e._stop) break; } const h = this['on' + e.type]; if (typeof h === 'function') h.call(this, e); return !e.defaultPrevented; }
    }
    class CustomEvent extends Event { constructor(t, o = {}) { super(t, o); this.detail = o.detail ?? null; } }
    class AbortSignal extends EventTarget {
      constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
      throwIfAborted() { if (this.aborted) throw this.reason; }
      static abort(r) { const c = new AbortController(); c.abort(r); return c.signal; }
      static timeout(ms) { const c = new AbortController(); N.timers.setTimeout(() => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; e.code = 23; c.abort(e); }, ms).unref(); return c.signal; }
      static any(list) { const c = new AbortController(); for (const s of list) { if (s.aborted) { c.abort(s.reason); break; } s.addEventListener('abort', () => c.abort(s.reason), { once: true }); } return c.signal; }
    }
    class AbortController {
      constructor() { this.signal = new AbortSignal(); }
      abort(reason) { const s = this.signal; if (s.aborted) return; s.aborted = true; if (reason === undefined) { reason = new Error('This operation was aborted'); reason.name = 'AbortError'; reason.code = 20; } s.reason = reason; s.dispatchEvent(new Event('abort')); }
    }
    Object.assign(G, { Event, EventTarget, CustomEvent, AbortSignal, AbortController });
  }
  if (typeof G.crypto !== 'object') G.crypto = N.webcrypto;
  if (typeof G.navigator !== 'object') G.navigator = { hardwareConcurrency: 1, language: 'en-US', languages: ['en-US'], platform: 'linux', userAgent: `Node.js/${N.process.version.slice(1, 3)}` };
}
