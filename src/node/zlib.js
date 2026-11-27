// zlib.js — node's zlib: deflate and inflate (raw, zlib's wrapper, gzip's), their Sync, callback and stream
// forms, crc32, the constants; in JavaScript, in the guest's realm (a page's Worker has no zlib of its own
// that answers synchronously). A part of the HLE node (src/node/kernel.js).
//
// inflate is RFC 1951 decoded block by block, resumable: given part of a stream it gives what the blocks it
// has whole make, and takes up the rest when more comes (minizlib, under npm's tar, writes a tarball chunk
// by chunk). deflate is LZ77 on hash chains (lazy matching from level 4) and each block's cheapest of
// stored, fixed and dynamic Huffman codes: what it makes is a valid stream that zlib inflates, not zlib's
// own bytes. Brotli and zstd are not here.
export function zlib(N) {
  const Buffer = N.Buffer;
  const C = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, ZLIB_VERNUM: 4897, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6,
    UNZIP: 7, BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_DECOMPRESS: 11, ZSTD_COMPRESS: 10, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64,
    Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0,
    BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11,
    BROTLI_PARAM_LGWIN: 2, BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30, BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3,
    BROTLI_MIN_INPUT_BLOCK_BITS: 16, BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_PARAM_LARGE_WINDOW: 6,
    BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8, BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
    BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0, BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0,
    BROTLI_DECODER_SUCCESS: 1, BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3, ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_CLEVEL_DEFAULT: 3,
  };
  const codes = { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6 };
  for (const [k, v] of Object.entries({ ...codes })) codes[v] = k;

  // ---- checksums ----------------------------------------------------------------------------------
  const CRC = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  const crc32 = (b, crc = 0) => { crc = ~crc; for (let i = 0; i < b.length; i++) crc = CRC[(crc ^ b[i]) & 255] ^ (crc >>> 8); return ~crc >>> 0; };
  const adler32 = (b, a = 1) => {
    let s1 = a & 0xffff, s2 = a >>> 16;
    for (let i = 0; i < b.length;) { const end = Math.min(b.length, i + 3800); for (; i < end; i++) { s1 += b[i]; s2 += s1; } s1 %= 65521; s2 %= 65521; }
    return ((s2 << 16) | s1) >>> 0;
  };

  // ---- errors -------------------------------------------------------------------------------------
  const zerr = (msg, code = 'Z_DATA_ERROR') => { const e = new Error(msg); e.errno = C[code]; e.code = code; return e; };
  class NeedMore { }
  const NEED = new NeedMore();

  // ---- Huffman tables -----------------------------------------------------------------------------
  // A table indexed by the next `bits` bits (LSB first): (symbol << 4) | length, 0 where no code is.
  // Lengths that over-subscribe, or leave codes unused where more than one length is used, are refused.
  const table = (lens, n, what, loose = false) => {
    const count = new Uint16Array(16); let max = 0;
    for (let i = 0; i < n; i++) { count[lens[i]]++; if (lens[i] > max) max = lens[i]; }
    count[0] = 0;
    let left = 1;
    for (let b = 1; b < 16; b++) { left <<= 1; left -= count[b]; if (left < 0) throw zerr(what); }
    if (left > 0 && !loose && (what === 'invalid code lengths set' || max > 1)) throw zerr(what);   // zlib's inflate_table: an incomplete set only for one code
    if (!max) return { t: new Uint32Array(2), bits: 1 };
    const next = new Uint16Array(16);
    for (let b = 1, code = 0; b < 16; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
    const size = 1 << max, t = new Uint32Array(size);
    for (let s = 0; s < n; s++) {
      const l = lens[s]; if (!l) continue;
      const c = next[l]++; let r = 0;
      for (let k = 0; k < l; k++) r |= ((c >> k) & 1) << (l - 1 - k);
      for (let j = r; j < size; j += 1 << l) t[j] = (s << 4) | l;
    }
    return { t, bits: max };
  };
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const fixedLens = new Uint8Array(288); fixedLens.fill(8, 0, 144); fixedLens.fill(9, 144, 256); fixedLens.fill(7, 256, 280); fixedLens.fill(8, 280, 288);
  let FIXED = null;
  const fixed = () => FIXED || (FIXED = { lit: table(fixedLens, 288, 'invalid literal/lengths set'), dist: table(new Uint8Array(30).fill(5), 30, 'invalid distances set', true) });

  // ---- inflate ------------------------------------------------------------------------------------
  // `wrap`: 0 raw, 1 zlib, 2 gzip, 3 either (unzip). push(bytes) takes input; run(finish) -> the bytes
  // made since, throwing zlib's error on bad data, and 'unexpected end of file' when finishing short.
  class Inflater {
    constructor(wrap, dictionary) {
      this.wrap = wrap; this.dict = dictionary || null;
      this.in = new Uint8Array(0); this.ip = 0; this.bb = 0; this.bc = 0;
      this.win = new Uint8Array(65536); this.wl = 0; this.emitted = 0;   // the history (32 KiB kept) and what came after it
      this.stage = wrap ? 'header' : 'blocks'; this.final = false; this.check = wrap === 2 ? 0 : 1; this.total = 0; this.members = 0;
      if (!wrap && this.dict) this.preset(this.dict);
    }
    preset(d) { this.room(d.length); this.win.set(d, this.wl); this.wl += d.length; this.emitted = this.wl; }
    push(b) { if (!b.length) return; const rest = this.in.subarray(this.ip); const n = new Uint8Array(rest.length + b.length); n.set(rest); n.set(b, rest.length); this.in = n; this.ip = 0; }
    room(n) { if (this.wl + n <= this.win.length) return; let size = this.win.length; while (size < this.wl + n) size *= 2; const w = new Uint8Array(size); w.set(this.win.subarray(0, this.wl)); this.win = w; }
    bits(n) { while (this.bc < n) { if (this.ip >= this.in.length) throw NEED; this.bb |= this.in[this.ip++] << this.bc; this.bc += 8; } const v = this.bb & ((1 << n) - 1); this.bb >>>= n; this.bc -= n; return v; }
    byte() { if (this.ip >= this.in.length) throw NEED; return this.in[this.ip++]; }
    // To a byte boundary: the bits of this byte dropped, the whole bytes read ahead (a code's lookahead) given back.
    byteAlign() { this.ip -= this.bc >> 3; this.bb = 0; this.bc = 0; }
    sym(h, bad) {
      while (this.bc < h.bits && this.ip < this.in.length) { this.bb |= this.in[this.ip++] << this.bc; this.bc += 8; }
      const e = h.t[this.bb & ((1 << h.bits) - 1)], l = e & 15;
      if (!e || l > this.bc) { if (this.bc < h.bits && this.ip >= this.in.length) throw NEED; throw zerr(bad); }
      this.bb >>>= l; this.bc -= l; return e >> 4;
    }
    mark() { return [this.ip, this.bb, this.bc, this.wl]; }
    back(m) { [this.ip, this.bb, this.bc, this.wl] = m; }
    header() {
      if (this.wrap === 3) this.wrap = this.in.length - this.ip >= 2 && this.in[this.ip] === 0x1f && this.in[this.ip + 1] === 0x8b ? 2 : this.in.length - this.ip >= 2 ? 1 : (() => { throw NEED; })();
      if (this.wrap === 1) {
        const cmf = this.byte(), flg = this.byte();
        if (((cmf << 8) | flg) % 31) throw zerr('incorrect header check');
        if ((cmf & 15) !== 8) throw zerr('unknown compression method');
        if ((cmf >> 4) > 7) throw zerr('invalid window size');
        if (flg & 0x20) {
          const id = ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
          if (!this.dict) throw zerr('Missing dictionary', 'Z_NEED_DICT');
          if (adler32(this.dict) !== id) throw zerr('Bad dictionary');
          this.preset(this.dict);
        }
        this.check = 1;
      } else {
        if (this.byte() !== 0x1f || this.byte() !== 0x8b) throw zerr('incorrect header check');
        if (this.byte() !== 8) throw zerr('unknown compression method');
        const flg = this.byte(); if (flg & 0xe0) throw zerr('unknown header flags set');
        for (let i = 0; i < 6; i++) this.byte();
        if (flg & 4) { const n = this.byte() | (this.byte() << 8); for (let i = 0; i < n; i++) this.byte(); }
        if (flg & 8) while (this.byte()) { /* the name */ }
        if (flg & 16) while (this.byte()) { /* the comment */ }
        if (flg & 2) { this.byte(); this.byte(); }
        this.check = 0; this.total = 0;
      }
    }
    block() {
      this.final = !!this.bits(1);
      const type = this.bits(2);
      if (type === 0) {
        this.byteAlign();
        const len = this.byte() | (this.byte() << 8), nlen = this.byte() | (this.byte() << 8);
        if ((len ^ 0xffff) !== nlen) throw zerr('invalid stored block lengths');
        if (this.in.length - this.ip < len) throw NEED;
        this.room(len); this.win.set(this.in.subarray(this.ip, this.ip + len), this.wl); this.wl += len; this.ip += len;
        return;
      }
      if (type === 3) throw zerr('invalid block type');
      let lit, dist;
      if (type === 1) ({ lit, dist } = fixed());
      else {
        const hlit = this.bits(5) + 257, hdist = this.bits(5) + 1, hclen = this.bits(4) + 4;
        if (hlit > 286 || hdist > 30) throw zerr('too many length or distance symbols');
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ORDER[i]] = this.bits(3);
        const clt = table(cl, 19, 'invalid code lengths set');
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = this.sym(clt, 'invalid code lengths set');
          if (s < 16) { lens[i++] = s; continue; }
          let v = 0, n;
          if (s === 16) { if (!i) throw zerr('invalid bit length repeat'); v = lens[i - 1]; n = 3 + this.bits(2); } else if (s === 17) n = 3 + this.bits(3); else n = 11 + this.bits(7);
          if (i + n > hlit + hdist) throw zerr('invalid bit length repeat');
          while (n--) lens[i++] = v;
        }
        if (!lens[256]) throw zerr('invalid code -- missing end-of-block');
        lit = table(lens.subarray(0, hlit), hlit, 'invalid literal/lengths set');
        dist = table(lens.subarray(hlit), hdist, 'invalid distances set');
      }
      for (;;) {
        const s = this.sym(lit, 'invalid literal/length code');
        if (s < 256) { if (this.wl >= this.win.length) this.room(1); this.win[this.wl++] = s; continue; }
        if (s === 256) return;
        if (s > 285) throw zerr('invalid literal/length code');
        const len = LBASE[s - 257] + this.bits(LEXT[s - 257]);
        const ds = this.sym(dist, 'invalid distance code');
        if (ds > 29) throw zerr('invalid distance code');
        const d = DBASE[ds] + this.bits(DEXT[ds]);
        if (d > this.wl) throw zerr('invalid distance too far back');
        this.room(len);
        const w = this.win; let at = this.wl;
        for (let i = 0; i < len; i++, at++) w[at] = w[at - d];
        this.wl = at;
      }
    }
    trailer() {
      this.byteAlign();
      if (this.wrap === 1) { const a = ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0; if (a !== this.check) throw zerr('incorrect data check'); }
      else if (this.wrap === 2) {
        const c = (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0, n = (this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
        if (c !== this.check) throw zerr('incorrect data check');
        if (n !== (this.total >>> 0)) throw zerr('incorrect length check');
      }
    }
    // What the blocks made since the last call, the checksum taken over it; the history cut to 32 KiB.
    take() {
      const out = this.win.slice(this.emitted, this.wl);
      if (out.length) { if (this.wrap === 1) this.check = adler32(out, this.check); else if (this.wrap === 2) { this.check = crc32(out, this.check); this.total += out.length; } }
      if (this.wl > 32768) { this.win.copyWithin(0, this.wl - 32768, this.wl); this.wl = 32768; }
      this.emitted = this.wl;
      return out;
    }
    run(finish) {
      const outs = [];
      for (;;) {
        if (this.stage === 'done') break;
        const m = this.mark();
        try {
          if (this.stage === 'header') { this.header(); this.stage = 'blocks'; }
          else if (this.stage === 'blocks') { this.block(); outs.push(this.take()); if (this.final) this.stage = this.wrap ? 'trailer' : 'done'; }
          else if (this.stage === 'trailer') {
            this.trailer(); this.members++;
            this.stage = this.wrap === 2 && this.ip < this.in.length ? 'header' : 'done';
          }
        } catch (e) {
          if (e !== NEED) throw e;
          this.back(m);
          if (finish) throw zerr('unexpected end of file', 'Z_BUF_ERROR');
          break;
        }
      }
      return outs;
    }
  }

  // ---- deflate ------------------------------------------------------------------------------------
  // Huffman code lengths (at most `limit` bits) for frequencies `f`: Huffman's own, the frequencies
  // halved until the longest fits.
  const lengths = (f, limit) => {
    const n = f.length, len = new Uint8Array(n);
    let freq = Array.from(f);
    for (;;) {
      const live = []; for (let i = 0; i < n; i++) if (freq[i]) live.push(i);
      if (!live.length) return len;
      if (live.length === 1) { len[live[0]] = 1; return len; }
      const nodes = live.map((s) => ({ w: freq[s], s })), heap = nodes.slice().sort((a, b) => a.w - b.w || a.s - b.s);
      // two queues: the leaves in order, the joined nodes in the order they were made (each heavier than the last)
      const q2 = []; let i1 = 0, i2 = 0;
      const pop = () => (i2 >= q2.length || (i1 < heap.length && heap[i1].w <= q2[i2].w) ? heap[i1++] : q2[i2++]);
      while ((heap.length - i1) + (q2.length - i2) > 1) { const a = pop(), b = pop(); q2.push({ w: a.w + b.w, l: a, r: b }); }
      let max = 0;
      const walk = (t, d) => { if (t.s !== undefined) { len[t.s] = d; if (d > max) max = d; } else { walk(t.l, d + 1); walk(t.r, d + 1); } };
      len.fill(0); walk(q2[q2.length - 1], 0);
      if (max <= limit) return len;
      freq = freq.map((v) => (v ? (v >> 1) | 1 : 0));
    }
  };
  const codesOf = (len) => {
    const count = new Uint16Array(16), next = new Uint16Array(16), out = new Uint16Array(len.length);
    for (const l of len) count[l]++; count[0] = 0;
    for (let b = 1, c = 0; b < 16; b++) { c = (c + count[b - 1]) << 1; next[b] = c; }
    for (let s = 0; s < len.length; s++) if (len[s]) { const c = next[len[s]]++; let r = 0; for (let k = 0; k < len[s]; k++) r |= ((c >> k) & 1) << (len[s] - 1 - k); out[s] = r; }
    return out;
  };
  const lcode = new Uint16Array(259), dcodeOf = (d) => { let i = 0; while (i < 29 && DBASE[i + 1] <= d) i++; return i; };
  for (let l = 3; l <= 258; l++) { let i = 0; while (i < 28 && LBASE[i + 1] <= l) i++; lcode[l] = i; }
  const dcode = new Uint8Array(32769); for (let d = 1; d <= 32768; d++) dcode[d] = dcodeOf(d);
  const CHAIN = [0, 4, 8, 32, 16, 32, 128, 256, 1024, 4096], LAZY = [0, 0, 0, 0, 4, 16, 16, 32, 128, 258];
  class Deflater {
    constructor(level, strategy, wrap, dictionary) {
      this.level = level < 0 ? 6 : level; this.strategy = strategy; this.wrap = wrap;
      this.hist = new Uint8Array(0); this.pend = []; this.pendLen = 0;
      this.out = []; this.bb = 0; this.bc = 0; this.started = false; this.ended = false;
      this.check = wrap === 2 ? 0 : 1; this.total = 0; this.dict = dictionary || null;
      if (this.dict && wrap !== 2) this.hist = this.dict.slice(-32768);
    }
    put(v, n) { this.bb |= v << this.bc; this.bc += n; while (this.bc >= 8) { this.out.push(this.bb & 255); this.bb >>>= 8; this.bc -= 8; } }
    align() { if (this.bc) { this.out.push(this.bb & 255); this.bb = 0; this.bc = 0; } }
    bytes(b) { for (const x of b) this.out.push(x); }
    header() {
      this.started = true;
      if (this.wrap === 1) {
        const cmf = 0x78, lv = this.level < 2 ? 0 : this.level < 6 ? 1 : this.level === 6 ? 2 : 3;
        let flg = (lv << 6) | (this.dict ? 0x20 : 0); flg += 31 - (((cmf << 8) | flg) % 31);
        this.bytes([cmf, flg]);
        if (this.dict) { const a = adler32(this.dict); this.bytes([a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255]); }
      } else if (this.wrap === 2) this.bytes([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, this.level === 9 ? 2 : this.strategy >= 2 || this.level < 2 ? 4 : 0, 3]);
    }
    // One block of `data` (its history before `start`): stored, fixed or dynamic, whichever is shortest.
    block(data, start, final) {
      const end = data.length, n = end - start;
      const lits = [], dists = [];                                         // a literal (dist 0) or a match's length and distance
      const lf = new Uint32Array(286), df = new Uint32Array(30);
      if (this.level > 0) {
        const chain = this.strategy === 2 ? 0 : CHAIN[this.level], lazy = LAZY[this.level], rle = this.strategy === 3;
        const head = new Int32Array(32768).fill(-1), prev = new Int32Array(Math.max(1, end));
        const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 32767;
        for (let i = Math.max(0, start - 32768); i < start && i + 2 < end; i++) { const h = hash(i); prev[i] = head[h]; head[h] = i; }
        const find = (i) => {
          let best = 0, bd = 0;
          if (i + 3 > end) return [0, 0];
          const max = Math.min(258, end - i);
          if (rle) { if (i > 0) { let l = 0; while (l < max && data[i + l] === data[i - 1 + l]) l++; if (l >= 3) return [l, 1]; } return [0, 0]; }
          let j = head[hash(i)], tries = chain;
          while (j >= 0 && i - j <= 32768 && tries-- > 0) {
            if (data[j + best] === data[i + best] && data[j] === data[i]) { let l = 0; while (l < max && data[j + l] === data[i + l]) l++; if (l > best) { best = l; bd = i - j; if (l >= max) break; } }
            j = prev[j];
          }
          return best >= 3 ? [best, bd] : [0, 0];
        };
        const insert = (i) => { if (i + 2 < end) { const h = hash(i); prev[i] = head[h]; head[h] = i; } };
        let i = start;
        while (i < end) {
          let [l, d] = chain || rle ? find(i) : [0, 0];
          if (l && lazy && l < lazy && i + 1 < end) { insert(i); const [l2, d2] = find(i + 1); if (l2 > l) { lits.push(data[i]); dists.push(0); lf[data[i]]++; i++; l = l2; d = d2; } else { lits.push(l); dists.push(d); lf[257 + lcode[l]]++; df[dcode[d]]++; for (let k = 1; k < l; k++) insert(i + k); i += l; continue; } }
          if (l) { lits.push(l); dists.push(d); lf[257 + lcode[l]]++; df[dcode[d]]++; for (let k = 0; k < l; k++) insert(i + k); i += l; }
          else { lits.push(data[i]); dists.push(0); lf[data[i]]++; insert(i); i++; }
        }
      } else for (let i = start; i < end; i++) { lits.push(data[i]); dists.push(0); lf[data[i]]++; }
      lf[256]++;
      const cost = (ll, dl) => { let c = 0; for (let s = 0; s < 286; s++) if (lf[s]) c += lf[s] * (ll[s] + (s > 256 ? LEXT[s - 257] : 0)); for (let s = 0; s < 30; s++) if (df[s]) c += df[s] * (dl[s] + DEXT[s]); return c; };
      // dynamic: its code lengths, run-length coded
      const ll = lengths(lf, 15), dl = lengths(df, 15);
      if (!dl.some((x) => x)) dl[0] = 1;
      let hlit = 286; while (hlit > 257 && !ll[hlit - 1]) hlit--;
      let hdist = 30; while (hdist > 1 && !dl[hdist - 1]) hdist--;
      const seq = [...ll.subarray(0, hlit), ...dl.subarray(0, hdist)], rl = [];
      for (let i = 0; i < seq.length;) {
        const v = seq[i]; let r = 1; while (i + r < seq.length && seq[i + r] === v) r++;
        if (v === 0 && r >= 3) { const k = Math.min(r, 138); rl.push(k >= 11 ? [18, k - 11, 7] : [17, k - 3, 3]); i += k; }
        else if (v !== 0 && r >= 4) { rl.push([v, 0, 0]); const k = Math.min(r - 1, 6); rl.push([16, k - 3, 2]); i += 1 + k; }
        else { rl.push([v, 0, 0]); i++; }
      }
      const cf = new Uint32Array(19); for (const [s] of rl) cf[s]++;
      const cl = lengths(cf, 7);
      let hclen = 19; while (hclen > 4 && !cl[ORDER[hclen - 1]]) hclen--;
      let dyn = 17 + hclen * 3 + cost(ll, dl); for (const [s, , eb] of rl) dyn += cl[s] + eb;
      const fl = fixedLens, fd = new Uint8Array(30).fill(5), fix = 3 + cost(fl, fd);
      const stored = (this.bc + 3 + 7 & ~7) - this.bc + 32 + 8 * n + 40 * Math.floor(Math.max(0, n - 1) / 65535);
      const writeSyms = (lcodes, llen, dcodes, dlen) => {
        for (let k = 0; k < lits.length; k++) {
          if (!dists[k]) { this.put(lcodes[lits[k]], llen[lits[k]]); continue; }
          const l = lits[k], d = dists[k], lc = lcode[l], dc = dcode[d];
          this.put(lcodes[257 + lc], llen[257 + lc]); if (LEXT[lc]) this.put(l - LBASE[lc], LEXT[lc]);
          this.put(dcodes[dc], dlen[dc]); if (DEXT[dc]) this.put(d - DBASE[dc], DEXT[dc]);
        }
        this.put(lcodes[256], llen[256]);
      };
      if (this.level === 0 || (stored < fix && stored < dyn && this.strategy !== 4)) {
        let at = start;
        do { const k = Math.min(65535, end - at), last = final && at + k >= end; this.put(last ? 1 : 0, 3); this.align(); this.bytes([k & 255, k >> 8, ~k & 255, (~k >> 8) & 255]); this.bytes(data.subarray(at, at + k)); at += k; } while (at < end);
      } else if (fix <= dyn || this.strategy === 4) { this.put(final ? 3 : 2, 3); writeSyms(codesOf(fl), fl, codesOf(fd), fd); }
      else {
        this.put(final ? 5 : 4, 3); this.put(hlit - 257, 5); this.put(hdist - 1, 5); this.put(hclen - 4, 4);
        for (let k = 0; k < hclen; k++) this.put(cl[ORDER[k]], 3);
        const cc = codesOf(cl); for (const [s, x, eb] of rl) { this.put(cc[s], cl[s]); if (eb) this.put(x, eb); }
        writeSyms(codesOf(ll), ll, codesOf(dl), dl);
      }
    }
    // Input taken, its blocks written as far as `flush` asks; the bytes made since.
    write(b, flush) {
      if (this.ended) return [];
      if (!this.started) this.header();
      if (b.length) {
        this.pend.push(b); this.pendLen += b.length;
        if (this.wrap === 1) this.check = adler32(b, this.check); else if (this.wrap === 2) { this.check = crc32(b, this.check); this.total += b.length; }
      }
      const BLOCK = 65536, finish = flush === C.Z_FINISH;
      while (this.pendLen >= BLOCK || (flush !== C.Z_NO_FLUSH && this.pendLen > 0) || (finish && !this.ended)) {
        const all = new Uint8Array(this.pendLen); let at = 0; for (const p of this.pend) { all.set(p, at); at += p.length; }
        const take = Math.min(all.length, BLOCK), cur = all.subarray(0, take), rest = all.subarray(take);
        const data = new Uint8Array(this.hist.length + cur.length); data.set(this.hist); data.set(cur, this.hist.length);
        const last = finish && !rest.length;
        this.block(data, this.hist.length, last);
        this.hist = data.slice(Math.max(0, data.length - 32768));
        this.pend = rest.length ? [rest] : []; this.pendLen = rest.length;
        if (last) this.ended = true;
      }
      if (finish) {
        this.align();
        if (this.wrap === 1) this.bytes([this.check >>> 24, (this.check >>> 16) & 255, (this.check >>> 8) & 255, this.check & 255]);
        else if (this.wrap === 2) { const c = this.check, t = this.total >>> 0; this.bytes([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24, t & 255, (t >>> 8) & 255, (t >>> 16) & 255, t >>> 24]); }
      } else if (flush === C.Z_SYNC_FLUSH || flush === C.Z_FULL_FLUSH) {
        this.put(0, 3); this.align(); this.bytes([0, 0, 0xff, 0xff]);
        if (flush === C.Z_FULL_FLUSH) this.hist = new Uint8Array(0);
      } else if (flush === C.Z_PARTIAL_FLUSH || flush === C.Z_BLOCK) { if (this.bc) { this.put(2, 3); this.put(0, 7); this.align(); } }
      const out = Uint8Array.from(this.out); this.out = [];
      return out.length ? [out] : [];
    }
  }

  // ---- the classes and functions Node's zlib has ------------------------------------------------
  const MODES = { Deflate: 1, Inflate: 2, Gzip: 3, Gunzip: 4, DeflateRaw: 5, InflateRaw: 6, Unzip: 7 };
  const toBytes = (b, name = 'buffer') => {
    if (typeof b === 'string') return Buffer.from(b);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    throw N.invalidArg(name, 'of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer', b);
  };
  const checkOpts = (o) => {
    const range = (k, lo, hi) => { const v = o[k]; if (v === undefined) return; if (typeof v !== 'number') throw N.invalidArg(`options.${k}`, 'of type number', v); if (!(v >= lo && v <= hi)) throw N.nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "options.${k}" is out of range. It must be >= ${lo} and <= ${hi}. Received ${v}`); };
    range('level', -1, 9); range('memLevel', 1, 9); range('strategy', 0, 4); range('windowBits', 0, 15); range('chunkSize', 64, Infinity);
  };
  class Handle { close() {} }
  class Zlib extends N.stream.Transform {
    constructor(opts, mode) {
      opts = opts || {};
      checkOpts(opts);
      super({ ...opts, writableHighWaterMark: opts.chunkSize || C.Z_DEFAULT_CHUNK, readableHighWaterMark: opts.chunkSize || C.Z_DEFAULT_CHUNK });
      this._mode = mode; this._opts = opts;
      this._finishFlushFlag = opts.finishFlush ?? C.Z_FINISH; this._defaultFlushFlag = opts.flush ?? C.Z_NO_FLUSH;
      this._defaultFullFlushFlag = C.Z_FULL_FLUSH;
      this.bytesWritten = 0; this._handle = new Handle(); this._closed = false; this._level = opts.level ?? -1; this._strategy = opts.strategy ?? 0;
      this._maxOutputLength = opts.maxOutputLength ?? N.bufferModule.kMaxLength;
      this._make();
    }
    _make() {
      const m = this._mode, dict = this._opts.dictionary ? toBytes(this._opts.dictionary, 'options.dictionary') : null;
      this._engine = m === 1 || m === 3 || m === 5 ? new Deflater(this._level, this._strategy, m === 1 ? 1 : m === 3 ? 2 : 0, dict) : new Inflater(m === 2 ? 1 : m === 4 ? 2 : m === 6 ? 0 : 3, dict);
    }
    get bytesRead() { return this.bytesWritten; }
    reset() { this._make(); }
    params(level, strategy, cb) { this._level = level; this._strategy = strategy; if (this._engine instanceof Deflater) { this._engine.level = level < 0 ? 6 : level; this._engine.strategy = strategy; } if (cb) N.nextTick(cb); }
    close(cb) { if (cb) N.nextTick(cb); if (!this._closed) { this._closed = true; this.destroy(); } }
    flush(kind, cb) {
      if (typeof kind === 'function' || kind === undefined) { cb = kind; kind = C.Z_FULL_FLUSH; }
      if (this.writableEnded) { if (cb) N.nextTick(cb); return; }
      const chunk = Buffer.alloc(0); chunk._flushFlag = kind; this.write(chunk, cb);
    }
    // One chunk through the engine: its output, as Node's zlibBufferSync gives it (Buffer.concat of the
    // pieces -- minizlib patches Buffer.concat to have the pieces themselves).
    _processChunk(chunk, flushFlag, cb) {
      if (typeof cb === 'function') { try { const r = this._processChunk(chunk, flushFlag); N.nextTick(cb, null, r); } catch (e) { N.nextTick(cb, e); } return undefined; }
      const b = toBytes(chunk, 'chunk');
      this.bytesWritten += b.length;
      let outs;
      if (this._engine instanceof Deflater) outs = this._engine.write(b, flushFlag);
      else { this._engine.push(b); outs = this._engine.run(flushFlag === C.Z_FINISH).filter((o) => o.length); }
      const bufs = outs.map((o) => Buffer.from(o.buffer, o.byteOffset, o.byteLength));
      const total = bufs.reduce((a, o) => a + o.length, 0);
      if (total > this._maxOutputLength) throw N.nodeError(RangeError, 'ERR_BUFFER_TOO_LARGE', `Cannot create a Buffer larger than ${this._maxOutputLength} bytes`);
      return Buffer.concat(bufs, total);
    }
    _transform(chunk, enc, cb) {
      const flag = typeof chunk._flushFlag === 'number' ? chunk._flushFlag : this._defaultFlushFlag;
      let out; try { out = this._processChunk(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk, flag); } catch (e) { cb(e); return; }
      cb(null, out.length ? out : undefined);
    }
    _flush(cb) {
      let out; try { out = this._processChunk(Buffer.alloc(0), this._finishFlushFlag); } catch (e) { cb(e); return; }
      cb(null, out.length ? out : undefined);
    }
  }
  const classes = {};
  for (const [name, mode] of Object.entries(MODES)) {
    classes[name] = { [name]: class extends Zlib { constructor(opts) { super(opts, mode); } } }[name];
  }
  const sync = (Cls, buf, opts) => { const z = new Cls(opts); const r = z._processChunk(toBytes(buf), z._finishFlushFlag); return opts && opts.info ? { buffer: r, engine: z } : r; };
  const api = { constants: Object.freeze({ ...C }), codes: Object.freeze(codes), crc32: (data, value = 0) => { if (typeof data === 'string') data = Buffer.from(data); else if (!ArrayBuffer.isView(data)) throw N.invalidArg('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data); return crc32(toBytes(data), value >>> 0); } };
  for (const [name] of Object.entries(MODES)) {
    const lower = name[0].toLowerCase() + name.slice(1), Cls = classes[name];
    api[name] = Cls;
    api['create' + name] = (o) => new Cls(o);
    api[lower + 'Sync'] = (buf, o) => sync(Cls, buf, o);
    api[lower] = (buf, o, cb) => {
      if (typeof o === 'function') { cb = o; o = {}; }
      if (typeof cb !== 'function') throw N.invalidArg('callback', 'of type function', cb);
      let r, e = null; try { r = sync(Cls, buf, o); } catch (x) { e = x; }
      N.timers.setImmediate(() => (e ? cb(e) : cb(null, r)));
    };
    Object.defineProperty(api[lower], Symbol.for('nodejs.util.promisify.custom'), { value: (buf, o) => new Promise((res, rej) => api[lower](buf, o || {}, (e, r) => (e ? rej(e) : res(r)))) });
  }
  const notHere = (what) => () => { throw N.nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `zlib's ${what} is not available in MIRAGE yet`); };
  for (const k of ['BrotliCompress', 'BrotliDecompress', 'ZstdCompress', 'ZstdDecompress']) {
    const lower = k[0].toLowerCase() + k.slice(1), f = notHere(k.replace(/([a-z])([A-Z])/, '$1 ').toLowerCase());
    api[k] = function () { f(); }; api['create' + k] = f; api[lower] = f; api[lower + 'Sync'] = f;
  }
  N.zlib = api;
  N.builtins.zlib = api;
}
