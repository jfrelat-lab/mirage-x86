// crypto.js — what of Node's `crypto` needs no OpenSSL: random bytes from the kernel's getrandom, UUIDs,
// and the hashes md5, sha1, sha256, sha512 with their HMACs. A part of the HLE node (src/node/kernel.js).
export function crypto(N) {
  const { scope, alloc, sys, get } = N;
  const randomFill = (u) => {
    for (let at = 0; at < u.length;) {
      const n = Math.min(u.length - at, 65536);
      scope(() => { const va = alloc(n), r = sys(355, va, n, 0); u.set(get(va, r), at); at += r; });
    }
    return u;
  };
  N.randomBytes = (n) => randomFill(N.Buffer ? N.Buffer.alloc(n) : new Uint8Array(n));

  const rotl = (x, n) => (x << n) | (x >>> (32 - n)), rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const pad = (msg, bigEndian, lenBytes = 8) => {
    const bits = msg.length * 8, total = Math.ceil((msg.length + 1 + lenBytes) / (lenBytes * 8)) * (lenBytes * 8);
    const b = new Uint8Array(total); b.set(msg); b[msg.length] = 0x80;
    const d = new DataView(b.buffer);
    if (bigEndian) { d.setUint32(total - 4, bits >>> 0); d.setUint32(total - 8, Math.floor(bits / 2 ** 32)); }
    else { d.setUint32(total - 8, bits >>> 0, true); d.setUint32(total - 4, Math.floor(bits / 2 ** 32), true); }
    return b;
  };
  const md5 = (m) => {
    const K = [], S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
    const b = pad(m, false), d = new DataView(b.buffer);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let o = 0; o < b.length; o += 64) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + d.getUint32(o + g * 4, true)) | 0;
        A = D; D = C; C = B; B = (B + rotl(F, S[i])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new DataView(new ArrayBuffer(16)); [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return new Uint8Array(out.buffer);
  };
  const sha1 = (m) => {
    const b = pad(m, true), d = new DataView(b.buffer), w = new Int32Array(80);
    let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = d.getInt32(o + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0, bb = h1, c = h2, dd = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        const [f, k] = i < 20 ? [(bb & c) | (~bb & dd), 0x5a827999] : i < 40 ? [bb ^ c ^ dd, 0x6ed9eba1] : i < 60 ? [(bb & c) | (bb & dd) | (c & dd), 0x8f1bbcdc | 0] : [bb ^ c ^ dd, 0xca62c1d6 | 0];
        const t = (rotl(a, 5) + f + e + k + w[i]) | 0; e = dd; dd = c; c = rotl(bb, 30); bb = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + dd) | 0; h4 = (h4 + e) | 0;
    }
    const out = new DataView(new ArrayBuffer(20)); [h0, h1, h2, h3, h4].forEach((v, i) => out.setInt32(i * 4, v));
    return new Uint8Array(out.buffer);
  };
  const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const sha256 = (m, init = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], outLen = 32) => {
    const b = pad(m, true), d = new DataView(b.buffer), w = new Int32Array(64), h = init.map((x) => x | 0);
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = d.getInt32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, bb, c, dd, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      [a, bb, c, dd, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
    }
    const out = new DataView(new ArrayBuffer(32)); h.forEach((v, i) => out.setInt32(i * 4, v));
    return new Uint8Array(out.buffer).slice(0, outLen);
  };
  const K512 = ['428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe',
    '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
    '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5', '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725',
    '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
    'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8', '19a4c116b8d2d0c8', '1e376c085141ab53',
    '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
    '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6',
    '113f9804bef90dae', '1b710b35131c471b', '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'].map((x) => BigInt('0x' + x));
  const sha512 = (m) => {
    const M = 0xffffffffffffffffn, r = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M;
    const b = pad(m, true, 16), d = new DataView(b.buffer), w = new Array(80);
    const h = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map((x) => BigInt('0x' + x));
    for (let o = 0; o < b.length; o += 128) {
      for (let i = 0; i < 16; i++) w[i] = d.getBigUint64(o + i * 8);
      for (let i = 16; i < 80; i++) { const s0 = r(w[i - 15], 1) ^ r(w[i - 15], 8) ^ (w[i - 15] >> 7n), s1 = r(w[i - 2], 19) ^ r(w[i - 2], 61) ^ (w[i - 2] >> 6n); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M; }
      let [a, bb, c, dd, e, f, g, hh] = h;
      for (let i = 0; i < 80; i++) {
        const t1 = (hh + (r(e, 14) ^ r(e, 18) ^ r(e, 41)) + ((e & f) ^ (~e & M & g)) + K512[i] + w[i]) & M, t2 = ((r(a, 28) ^ r(a, 34) ^ r(a, 39)) + ((a & bb) ^ (a & c) ^ (bb & c))) & M;
        hh = g; g = f; f = e; e = (dd + t1) & M; dd = c; c = bb; bb = a; a = (t1 + t2) & M;
      }
      [a, bb, c, dd, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) & M; });
    }
    const out = new DataView(new ArrayBuffer(64)); h.forEach((v, i) => out.setBigUint64(i * 8, v));
    return new Uint8Array(out.buffer);
  };
  const HASHES = { md5: [md5, 64], sha1: [sha1, 64], sha256: [sha256, 64], sha224: [(m) => sha256(m, [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4], 28), 64], sha512: [sha512, 128] };
  const bytesOf = (v, enc) => (typeof v === 'string' ? N.Buffer.from(v, enc || 'utf8') : v instanceof Uint8Array ? v : new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength));
  const hashFn = (alg) => {
    const h = HASHES[String(alg).toLowerCase().replace('-', '')];
    if (!h) { const e = new Error('Digest method not supported'); e.code = 'ERR_OSSL_EVP_UNSUPPORTED'; throw e; }
    return h;
  };
  class Hash {
    constructor(alg, key) { this._h = hashFn(alg); this._parts = []; this._key = key; this._done = false; }
    update(v, enc) { if (this._done) throw N.nodeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called'); this._parts.push(bytesOf(v, enc)); return this; }
    digest(enc) {
      if (this._done) throw N.nodeError(Error, 'ERR_CRYPTO_HASH_FINALIZED', 'Digest already called');
      this._done = true;
      const [f, block] = this._h, msg = N.Buffer.concat(this._parts);
      let out;
      if (this._key !== undefined) {
        let k = bytesOf(this._key); if (k.length > block) k = f(k);
        const kp = new Uint8Array(block); kp.set(k);
        const ip = kp.map((x) => x ^ 0x36), op = kp.map((x) => x ^ 0x5c);
        out = f(N.Buffer.concat([op, f(N.Buffer.concat([ip, msg]))]));
      } else out = f(msg);
      const b = N.Buffer.from(out);
      return enc && enc !== 'buffer' ? b.toString(enc) : b;
    }
    copy() { const h = new Hash('md5'); h._h = this._h; h._parts = this._parts.slice(); h._key = this._key; return h; }
  }
  const uuid = () => { const b = N.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  const randomInt = (min, max, cb) => {
    if (max === undefined || typeof max === 'function') { cb = max; max = min; min = 0; }
    const range = max - min, v = min + Math.floor((Number(N.randomBytes(6).readUIntBE(0, 6)) / 2 ** 48) * range);
    if (cb) { N.nextTick(cb, null, v); return undefined; }
    return v;
  };
  const getRandomValues = (a) => { randomFill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); return a; };
  const notHere = (name) => () => { throw N.nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `crypto.${name} is not available in MIRAGE`); };
  N.cryptoModule = {
    randomBytes: (n, cb) => { const b = N.randomBytes(n); if (cb) { N.nextTick(cb, null, b); return undefined; } return b; },
    randomFillSync: (b, off = 0, size) => { const u = new Uint8Array(b.buffer || b, (b.byteOffset || 0) + off, size ?? (b.byteLength - off)); randomFill(u); return b; },
    randomFill: (b, ...a) => { const cb = a.pop(); N.cryptoModule.randomFillSync(b, ...a); N.nextTick(cb, null, b); },
    randomUUID: uuid, randomInt, getRandomValues,
    createHash: (alg) => new Hash(alg), createHmac: (alg, key) => new Hash(alg, key),
    hash: (alg, data, enc = 'hex') => new Hash(alg).update(data).digest(enc),
    getHashes: () => Object.keys(HASHES), getCiphers: () => [], getCurves: () => [],
    timingSafeEqual: (a, b) => { if (a.length !== b.length) throw N.nodeError(RangeError, 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH', 'Input buffers must have the same byte length'); let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; },
    createCipheriv: notHere('createCipheriv'), createDecipheriv: notHere('createDecipheriv'), generateKeyPairSync: notHere('generateKeyPairSync'), pbkdf2Sync: notHere('pbkdf2Sync'), scryptSync: notHere('scryptSync'), createSign: notHere('createSign'), createVerify: notHere('createVerify'),
    constants: {},
  };
  N.cryptoModule.webcrypto = { getRandomValues, randomUUID: uuid, subtle: {} };
  N.webcrypto = N.cryptoModule.webcrypto;
}
