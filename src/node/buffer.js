// buffer.js — Node's Buffer: a Uint8Array with its encodings (utf8, latin1, ascii, hex, base64,
// base64url, utf16le), reads and writes of numbers, and the TextEncoder, TextDecoder, atob and btoa a
// realm of the language alone lacks. A part of the HLE node (src/node/kernel.js).
export function buffer(N) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64REV = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) { B64REV[B64.charCodeAt(i)] = i; B64REV[B64URL.charCodeAt(i)] = i; }
  const norm = (enc) => {
    if (enc === undefined || enc === null) return 'utf8';
    const e = String(enc).toLowerCase();
    switch (e) {
      case 'utf8': case 'utf-8': return 'utf8';
      case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': return 'utf16le';
      case 'latin1': case 'binary': return 'latin1';
      case 'base64': case 'base64url': case 'hex': case 'ascii': return e;
      default: return undefined;
    }
  };
  const unknownEncoding = (enc) => N.nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${enc}`);
  const encode = (s, enc) => {
    switch (enc) {
      case 'utf8': return N.utf8Encode(s);
      case 'latin1': case 'ascii': { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
      case 'utf16le': { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c; b[i * 2 + 1] = c >> 8; } return b; }
      case 'hex': {
        const n = s.length >>> 1, b = new Uint8Array(n); let i = 0;
        for (; i < n; i++) { const h = parseInt(s.substr(i * 2, 2), 16); if (Number.isNaN(h) || !/^[0-9a-fA-F]{2}$/.test(s.substr(i * 2, 2))) break; b[i] = h; }
        return b.subarray(0, i);
      }
      case 'base64': case 'base64url': {
        const out = new Uint8Array(Math.ceil(s.length * 3 / 4)); let o = 0, acc = 0, bits = 0;
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c === 61) break;                                             // =
          const v = c < 256 ? B64REV[c] : -1;
          if (v < 0) continue;
          acc = (acc << 6) | v; bits += 6;
          if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
        }
        return out.subarray(0, o);
      }
      default: throw unknownEncoding(enc);
    }
  };
  const decode = (u, enc, start, end) => {
    switch (enc) {
      case 'utf8': return N.utf8Decode(u, start, end);
      case 'latin1': { let s = ''; for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, Math.min(end, i + 8192))); return s; }
      case 'ascii': { let s = ''; for (let i = start; i < end; i++) s += String.fromCharCode(u[i] & 0x7f); return s; }
      case 'utf16le': { let s = ''; for (let i = start; i + 1 < end; i += 2) s += String.fromCharCode(u[i] | (u[i + 1] << 8)); return s; }
      case 'hex': { let s = ''; for (let i = start; i < end; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
      case 'base64': case 'base64url': {
        const T = enc === 'base64' ? B64 : B64URL; let s = '', i = start;
        for (; i + 2 < end; i += 3) { const n = (u[i] << 16) | (u[i + 1] << 8) | u[i + 2]; s += T[n >> 18] + T[(n >> 12) & 63] + T[(n >> 6) & 63] + T[n & 63]; }
        if (end - i === 1) { const n = u[i] << 16; s += T[n >> 18] + T[(n >> 12) & 63] + (enc === 'base64' ? '==' : ''); }
        else if (end - i === 2) { const n = (u[i] << 16) | (u[i + 1] << 8); s += T[n >> 18] + T[(n >> 12) & 63] + T[(n >> 6) & 63] + (enc === 'base64' ? '=' : ''); }
        return s;
      }
      default: throw unknownEncoding(enc);
    }
  };
  const byteLength = (s, enc) => {
    switch (norm(enc)) {
      case 'utf8': return N.utf8Encode(s).length;
      case 'utf16le': return s.length * 2;
      case 'hex': return s.length >>> 1;
      case 'base64': case 'base64url': { let n = s.length; while (n > 0 && s.charCodeAt(n - 1) === 61) n--; return (n * 3) >>> 2; }
      default: return s.length;
    }
  };

  class Buffer extends Uint8Array {
    static from(v, enc, len) {
      if (typeof v === 'string') { const e = norm(enc); if (!e) throw unknownEncoding(enc); return fromBytes(encode(v, e)); }
      if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
        const off = enc === undefined ? 0 : +enc, n = len === undefined ? v.byteLength - off : +len;
        return new Buffer(v, off, n);
      }
      if (ArrayBuffer.isView(v)) { const b = Buffer.allocUnsafe(v.length); for (let i = 0; i < v.length; i++) b[i] = v[i]; return b; }
      if (v && typeof v === 'object') {
        if (typeof v.valueOf === 'function') { const p = v.valueOf(); if (p !== v && (typeof p === 'string' || typeof p === 'object')) return Buffer.from(p, enc, len); }
        if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
        if (typeof v.length === 'number' || Array.isArray(v)) { const b = Buffer.allocUnsafe(v.length >>> 0); for (let i = 0; i < b.length; i++) b[i] = v[i]; return b; }
        if (typeof v[Symbol.toPrimitive] === 'function') return Buffer.from(v[Symbol.toPrimitive]('string'), enc, len);
      }
      throw N.invalidArg('first', 'of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object', v);
    }
    static alloc(n, fill, enc) { const b = new Buffer(checkSize(n)); if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, enc); return b; }
    static allocUnsafe(n) { return new Buffer(checkSize(n)); }
    static allocUnsafeSlow(n) { return new Buffer(checkSize(n)); }
    static isBuffer(b) { return b instanceof Buffer; }
    static isEncoding(e) { return typeof e === 'string' && e.length !== 0 && norm(e) !== undefined; }
    static byteLength(s, enc) {
      if (typeof s !== 'string') { if (ArrayBuffer.isView(s) || s instanceof ArrayBuffer) return s.byteLength; throw N.invalidArg('string', 'of type string or an instance of Buffer or ArrayBuffer', s); }
      return byteLength(s, enc);
    }
    static concat(list, total) {
      if (!Array.isArray(list)) throw N.invalidArg('list', 'an instance of Array', list);
      if (total === undefined) { total = 0; for (const b of list) total += b.length; }
      const out = Buffer.allocUnsafe(total); let at = 0;
      for (const b of list) { if (!(b instanceof Uint8Array)) throw N.invalidArg('list[0]', 'an instance of Buffer or Uint8Array', b); const t = Math.min(b.length, total - at); out.set(t === b.length ? b : b.subarray(0, t), at); at += t; if (at >= total) break; }
      if (at < total) out.fill(0, at);
      return out;
    }
    static compare(a, b) { return compare(a, b); }
    static copyBytesFrom(v, off = 0, len = v.length - off) { return Buffer.from(new Uint8Array(v.buffer, v.byteOffset + off * v.BYTES_PER_ELEMENT, len * v.BYTES_PER_ELEMENT)); }
    toString(enc, start, end) {
      if (arguments.length === 0) return N.utf8Decode(this, 0, this.length);
      const e = norm(enc); if (!e) throw unknownEncoding(enc);
      start = start === undefined || start < 0 ? 0 : Math.min(start | 0, this.length);
      end = end === undefined || end > this.length ? this.length : end | 0;
      if (end <= start) return '';
      return decode(this, e, start, end);
    }
    toLocaleString(enc, s, e) { return this.toString(enc, s, e); }
    equals(b) { if (!(b instanceof Uint8Array)) throw N.invalidArg('otherBuffer', 'an instance of Buffer or Uint8Array', b); return compare(this, b) === 0; }
    compare(t, ts = 0, te = t.length, ss = 0, se = this.length) { return compare(this.subarray(ss, se), t.subarray(ts, te)); }
    slice(s, e) { return this.subarray(s, e); }
    write(s, off, len, enc) {
      if (typeof off === 'string') { enc = off; off = 0; len = this.length; }
      else if (typeof len === 'string') { enc = len; len = this.length - (off || 0); }
      off = off >>> 0; if (len === undefined) len = this.length - off;
      const e = norm(enc); if (!e) throw unknownEncoding(enc);
      let b = encode(s, e);
      const room = Math.min(len, this.length - off);
      if (b.length > room) {
        if (e === 'utf8') { let n = room; while (n > 0 && (b[n] & 0xc0) === 0x80) n--; b = b.subarray(0, n); }   // whole characters only
        else b = b.subarray(0, e === 'utf16le' ? room & ~1 : room);
      }
      this.set(b, off); return b.length;
    }
    fill(v, off = 0, end = this.length, enc) {
      if (typeof off === 'string') { enc = off; off = 0; end = this.length; } else if (typeof end === 'string') { enc = end; end = this.length; }
      if (typeof v === 'number') return super.fill(v & 255, off, end);
      if (typeof v === 'boolean') return super.fill(+v, off, end);
      const src = typeof v === 'string' ? encode(v, norm(enc) || 'utf8') : v;
      if (src.length === 0) return super.fill(0, off, end);
      for (let i = off, j = 0; i < end; i++, j = (j + 1) % src.length) this[i] = src[j];
      return this;
    }
    indexOf(v, off, enc) { return indexOf(this, v, off, enc, true); }
    lastIndexOf(v, off, enc) { return indexOf(this, v, off, enc, false); }
    includes(v, off, enc) { return this.indexOf(v, off, enc) !== -1; }
    copy(t, ts = 0, ss = 0, se = this.length) { ts = Math.max(0, ts | 0); const n = Math.max(0, Math.min(se - ss, t.length - ts)); t.set(this.subarray(ss, ss + n), ts); return n; }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    swap16() { for (let i = 0; i + 1 < this.length; i += 2) { const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; } return this; }
    swap32() { for (let i = 0; i + 3 < this.length; i += 4) { this.subarray(i, i + 4).reverse(); } return this; }
    swap64() { for (let i = 0; i + 7 < this.length; i += 8) { this.subarray(i, i + 8).reverse(); } return this; }
    get parent() { return this.buffer; }
    get offset() { return this.byteOffset; }
    [Symbol.for('nodejs.util.inspect.custom')](depth, opts) {
      const max = 50, n = Math.min(max, this.length);
      let str = Array.from(this.subarray(0, n), (b) => (b < 16 ? '0' : '') + b.toString(16)).join(' ');
      const rem = this.length - max;
      if (rem > 0) str += ` ... ${rem} more byte${rem > 1 ? 's' : ''}`;
      return `<${this.constructor.name} ${str}>`.replace(' >', '>');
    }
  }
  const checkSize = (n) => {
    if (typeof n !== 'number') throw N.invalidArg('size', 'of type number', n);
    if (!(n >= 0 && n <= 2 ** 31)) throw N.nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "size" is out of range. It must be >= 0 && <= ${2 ** 31}. Received ${n}`);
    return n;
  };
  const fromBytes = (u) => { const b = new Buffer(u.length); b.set(u); return b; };
  const compare = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length < b.length ? -1 : a.length > b.length ? 1 : 0; };
  const indexOf = (buf, v, off, enc, forward) => {
    if (typeof off === 'string') { enc = off; off = undefined; }
    let needle;
    if (typeof v === 'number') needle = [v & 255];
    else if (typeof v === 'string') needle = encode(v, norm(enc) || 'utf8');
    else needle = v;
    const len = buf.length;
    let start = off === undefined ? (forward ? 0 : len) : +off;
    if (Number.isNaN(start)) start = forward ? 0 : len;
    if (start < 0) start += len;
    if (needle.length === 0) return forward ? Math.min(Math.max(start, 0), len) : Math.min(start, len);
    if (forward) {
      for (let i = Math.max(0, start); i + needle.length <= len; i++) { let j = 0; while (j < needle.length && buf[i + j] === needle[j]) j++; if (j === needle.length) return i; }
    } else {
      for (let i = Math.min(start, len - needle.length); i >= 0; i--) { let j = 0; while (j < needle.length && buf[i + j] === needle[j]) j++; if (j === needle.length) return i; }
    }
    return -1;
  };
  // Numbers, read and written: readUInt8 ... writeDoubleBE, BigInt64, the variable-width ones.
  const P = Buffer.prototype;
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const range = (b, off, n) => {
    if (off === undefined) off = 0;
    if (typeof off !== 'number') throw N.invalidArg('offset', 'of type number', off);
    if (!Number.isInteger(off) || off < 0 || off + n > b.length) {
      if (!Number.isInteger(off)) throw N.nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "offset" is out of range. It must be an integer. Received ${off}`);
      if (b.length - n < 0) throw N.nodeError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', 'Attempt to access memory outside buffer bounds');
      throw N.nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "offset" is out of range. It must be >= 0 and <= ${b.length - n}. Received ${off}`);
    }
    return off;
  };
  for (const [name, get, set, n, le] of [
    ['UInt8', 'getUint8', 'setUint8', 1], ['Int8', 'getInt8', 'setInt8', 1],
    ['UInt16LE', 'getUint16', 'setUint16', 2, true], ['UInt16BE', 'getUint16', 'setUint16', 2, false],
    ['Int16LE', 'getInt16', 'setInt16', 2, true], ['Int16BE', 'getInt16', 'setInt16', 2, false],
    ['UInt32LE', 'getUint32', 'setUint32', 4, true], ['UInt32BE', 'getUint32', 'setUint32', 4, false],
    ['Int32LE', 'getInt32', 'setInt32', 4, true], ['Int32BE', 'getInt32', 'setInt32', 4, false],
    ['FloatLE', 'getFloat32', 'setFloat32', 4, true], ['FloatBE', 'getFloat32', 'setFloat32', 4, false],
    ['DoubleLE', 'getFloat64', 'setFloat64', 8, true], ['DoubleBE', 'getFloat64', 'setFloat64', 8, false],
    ['BigUInt64LE', 'getBigUint64', 'setBigUint64', 8, true], ['BigUInt64BE', 'getBigUint64', 'setBigUint64', 8, false],
    ['BigInt64LE', 'getBigInt64', 'setBigInt64', 8, true], ['BigInt64BE', 'getBigInt64', 'setBigInt64', 8, false],
  ]) {
    P['read' + name] = function (off) { return dv(this)[get](range(this, off, n), le); };
    P['write' + name] = function (v, off) { off = range(this, off, n); const d = dv(this); if (/Int8|Int16|Int32/.test(name) && !/Big/.test(name)) d[set](off, Number(v), le); else d[set](off, v, le); return off + n; };
    if (name.startsWith('UInt') || name.startsWith('BigUInt')) { P['read' + name.replace('UInt', 'Uint')] = P['read' + name]; P['write' + name.replace('UInt', 'Uint')] = P['write' + name]; }
  }
  P.readUIntLE = function (off, n) { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + this[range(this, off, n) + i]; return v; };
  P.readUIntBE = function (off, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this[range(this, off, n) + i]; return v; };
  P.readIntLE = function (off, n) { const v = this.readUIntLE(off, n); return v >= 2 ** (8 * n - 1) ? v - 2 ** (8 * n) : v; };
  P.readIntBE = function (off, n) { const v = this.readUIntBE(off, n); return v >= 2 ** (8 * n - 1) ? v - 2 ** (8 * n) : v; };
  P.writeUIntLE = function (v, off, n) { off = range(this, off, n); for (let i = 0; i < n; i++) { this[off + i] = v & 255; v = Math.floor(v / 256); } return off + n; };
  P.writeUIntBE = function (v, off, n) { off = range(this, off, n); for (let i = n - 1; i >= 0; i--) { this[off + i] = v & 255; v = Math.floor(v / 256); } return off + n; };
  P.writeIntLE = function (v, off, n) { return this.writeUIntLE(v < 0 ? v + 2 ** (8 * n) : v, off, n); };
  P.writeIntBE = function (v, off, n) { return this.writeUIntBE(v < 0 ? v + 2 ** (8 * n) : v, off, n); };
  P.utf8Write = function (s, o, l) { return this.write(s, o, l, 'utf8'); };
  for (const e of ['utf8', 'latin1', 'ascii', 'hex', 'base64', 'base64url', 'ucs2', 'utf16le']) P[e + 'Slice'] = function (s, en) { return this.toString(e, s, en); };

  const kMaxLength = 2 ** 32, constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 2 ** 29 - 24 };
  Buffer.poolSize = 8192;
  N.Buffer = Buffer;
  N.encodeBuffer = encode; N.decodeBuffer = decode; N.normEncoding = norm;
  N.bufferModule = { Buffer, SlowBuffer: Buffer, kMaxLength, kStringMaxLength: constants.MAX_STRING_LENGTH, constants, INSPECT_MAX_BYTES: 50,
    atob: (s) => decode(encode(String(s), 'base64'), 'latin1', 0, encode(String(s), 'base64').length), btoa: (s) => decode(encode(String(s), 'latin1'), 'base64', 0, String(s).length),
    isUtf8: (b) => { try { return N.utf8Encode(N.utf8Decode(b)).length === b.length && !N.utf8Decode(b).includes('�'); } catch { return false; } },
    isAscii: (b) => b.every((x) => x < 128), transcode: (b, from, to) => Buffer.from(Buffer.from(b).toString(from), to) };

  // What a realm of the language alone lacks, the web's text classes among them.
  class TextEncoder { get encoding() { return 'utf-8'; } encode(s = '') { return N.utf8Encode(String(s)); } encodeInto(s, dst) { const b = N.utf8Encode(String(s)), n = Math.min(b.length, dst.length); dst.set(b.subarray(0, n)); return { read: s.length, written: n }; } }
  class TextDecoder {
    constructor(label = 'utf-8', opts = {}) { const l = String(label).toLowerCase(); this._enc = l === 'utf8' || l === 'utf-8' || l === 'unicode-1-1-utf-8' ? 'utf8' : l === 'latin1' || l === 'iso-8859-1' || l === 'ascii' || l === 'windows-1252' ? 'latin1' : l === 'utf-16le' || l === 'utf16le' ? 'utf16le' : null; if (!this._enc) throw new RangeError(`The "${label}" encoding is not supported`); this.fatal = !!opts.fatal; this.ignoreBOM = !!opts.ignoreBOM; this._pending = new Uint8Array(0); }
    get encoding() { return this._enc === 'utf8' ? 'utf-8' : this._enc === 'latin1' ? 'windows-1252' : 'utf-16le'; }
    decode(input, opts = {}) {
      let u = input === undefined ? new Uint8Array(0) : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      if (this._pending.length) { const m = new Uint8Array(this._pending.length + u.length); m.set(this._pending); m.set(u, this._pending.length); u = m; this._pending = new Uint8Array(0); }
      if (opts.stream && this._enc === 'utf8') {                         // an incomplete sequence at the end waits for the next call
        let cut = u.length, k = u.length - 1, n = 0;
        while (k >= 0 && n < 3 && (u[k] & 0xc0) === 0x80) { k--; n++; }
        if (k >= 0) { const c = u[k], need = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0; if (need > n) cut = k; }
        this._pending = u.slice(cut); u = u.subarray(0, cut);
      }
      let s = decode(u, this._enc, 0, u.length);
      if (this.fatal && s.includes('�') && !N.utf8Decode(u).split('').every(() => true)) throw new TypeError('The encoded data was not valid for encoding utf-8');
      if (!this.ignoreBOM && s.charCodeAt(0) === 0xfeff && !this._bomSeen) s = s.slice(1);
      this._bomSeen = !!opts.stream;
      return s;
    }
  }
  N.TextEncoder = TextEncoder; N.TextDecoder = TextDecoder;
}
