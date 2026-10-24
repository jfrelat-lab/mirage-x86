// bunzip2.js — bzip2 decompression, for archives a page fetches from their authors' servers: YOLP's
// Linux intros come as .tar.bz2 (yolp.omgwtf.ru), and a browser decompresses gzip and deflate but not
// bzip2. Written from the format as bzip2 1.0 writes it (Julian Seward's bzip2, decompress.c and
// huffman.c); tools/test.js holds it to the bzip2 command's own output.
//
// A stream is "BZh" and a block size (1-9, in 100 000 bytes), then blocks, each: the 48-bit magic
// 314159265359h, its CRC, a randomised bit, the BWT origin pointer, the map of the bytes used, 2 to 6
// Huffman tables and the selectors that choose one per 50 symbols (MTF-coded), the tables' code lengths
// (delta-coded), then the symbols: MTF indices with runs of the front byte in bijective base 2 (RUNA,
// RUNB), up to the end-of-block symbol. The block is the Burrows-Wheeler transform of the data after a
// first run-length coding (four equal bytes, then a count). The stream ends with 177245385090h and the
// combined CRC; streams may follow one another.

const CRC = new Int32Array(256);
for (let i = 0; i < 256; i++) {                        // CRC-32 as bzip2 computes it: MSB first, poly 04C11DB7h
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC[i] = c;
}

class Bits {
  constructor(u8) { this.u8 = u8; this.pos = 0; this.acc = 0; this.n = 0; }
  bits(k) {                                             // k <= 24
    while (this.n < k) {
      if (this.pos >= this.u8.length) throw new Error('bunzip2: the data ends early');
      this.acc = ((this.acc << 8) | this.u8[this.pos++]) >>> 0; this.n += 8;
    }
    this.n -= k;
    return (this.acc >>> this.n) & ((1 << k) - 1);
  }
  bit() { return this.bits(1); }
}

/** Decompress a .bz2 (one stream or several in a row) into a Uint8Array. */
export function bunzip2(u8) {
  const br = new Bits(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
  const out = [];                                       // chunks
  let total = 0;
  for (;;) {
    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) throw new Error('bunzip2: not a bzip2 stream');
    const level = br.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bunzip2: bad block size');
    const tt = new Uint32Array(level * 100000);
    let streamCrc = 0;
    for (;;) {
      const m1 = br.bits(24), m2 = br.bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) {         // end of stream
        const want = ((br.bits(16) << 16) | br.bits(16)) | 0;
        if (want !== streamCrc) throw new Error('bunzip2: the stream CRC does not match');
        break;
      }
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bunzip2: bad block magic');
      const blockCrc = ((br.bits(16) << 16) | br.bits(16)) | 0;
      if (br.bit()) throw new Error('bunzip2: randomised blocks (bzip2 0.9.0) are not supported');
      const origPtr = br.bits(24);
      // the byte map: 16 groups of 16
      const used = br.bits(16), seqToUnseq = new Uint8Array(256);
      let nInUse = 0;
      for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) {
        const g = br.bits(16);
        for (let j = 0; j < 16; j++) if (g & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
      }
      if (!nInUse) throw new Error('bunzip2: a block uses no byte');
      const alphaSize = nInUse + 2, EOB = nInUse + 1;
      const nGroups = br.bits(3), nSelectors = br.bits(15);
      if (nGroups < 2 || nGroups > 6 || !nSelectors) throw new Error('bunzip2: bad tables');
      const mtfG = [0, 1, 2, 3, 4, 5].slice(0, nGroups), selectors = new Uint8Array(nSelectors);
      for (let i = 0; i < nSelectors; i++) {
        let j = 0; while (br.bit()) { j++; if (j >= nGroups) throw new Error('bunzip2: bad selector'); }
        const v = mtfG[j]; mtfG.splice(j, 1); mtfG.unshift(v); selectors[i] = v;
      }
      // the code lengths, then canonical Huffman decoding tables per group
      const tables = [];
      for (let t = 0; t < nGroups; t++) {
        const len = new Uint8Array(alphaSize);
        let cur = br.bits(5);
        for (let s = 0; s < alphaSize; s++) {
          for (;;) {
            if (cur < 1 || cur > 20) throw new Error('bunzip2: bad code length');
            if (!br.bit()) break;
            cur += br.bit() ? -1 : 1;
          }
          len[s] = cur;
        }
        let minLen = 32, maxLen = 0;
        for (const l of len) { if (l < minLen) minLen = l; if (l > maxLen) maxLen = l; }
        // limit[l]: the largest code of length l; base[l]: what to subtract from a code of length l
        // to index perm, the symbols sorted by length.
        const perm = [], limit = new Int32Array(maxLen + 2), base = new Int32Array(maxLen + 2), count = new Int32Array(maxLen + 2);
        for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (len[s] === l) perm.push(s);
        for (const l of len) count[l]++;
        let code = 0, idx = 0;
        for (let l = minLen; l <= maxLen; l++) {
          base[l] = code - idx; code += count[l]; idx += count[l];
          limit[l] = code - 1; code <<= 1;
        }
        tables.push({ minLen, maxLen, perm, limit, base });
      }
      // the symbols: MTF + RUNA/RUNB, into tt's low bytes, counting each byte
      const mtf = new Uint8Array(256); for (let i = 0; i < 256; i++) mtf[i] = i;
      const unzftab = new Int32Array(256);
      let n = 0, groupPos = 0, sel = 0, tbl = null, runLen = 0, runBit = 1;
      const flushRun = () => {
        if (!runLen) return;
        const b = seqToUnseq[mtf[0]];
        if (n + runLen > tt.length) throw new Error('bunzip2: a block overflows');
        unzftab[b] += runLen;
        for (; runLen; runLen--) tt[n++] = b;
        runBit = 1;
      };
      for (;;) {
        if (!groupPos) { if (sel >= nSelectors) throw new Error('bunzip2: out of selectors'); tbl = tables[selectors[sel++]]; groupPos = 50; }
        groupPos--;
        let l = tbl.minLen, v = br.bits(l);
        while (l <= tbl.maxLen && v > tbl.limit[l]) { l++; v = (v << 1) | br.bit(); }
        if (l > tbl.maxLen) throw new Error('bunzip2: bad Huffman code');
        const sym = tbl.perm[v - tbl.base[l]];
        if (sym <= 1) { runLen += sym === 0 ? runBit : runBit * 2; runBit *= 2; continue; }   // RUNA, RUNB
        flushRun();
        if (sym === EOB) break;
        const j = sym - 1, b = mtf[j];
        mtf.copyWithin(1, 0, j); mtf[0] = b;
        const byte = seqToUnseq[b];
        if (n >= tt.length) throw new Error('bunzip2: a block overflows');
        unzftab[byte]++; tt[n++] = byte;
      }
      if (origPtr >= n) throw new Error('bunzip2: bad origin pointer');
      // the inverse BWT: tt[cftab[byte]++] gets i in its upper bits
      const cftab = new Int32Array(257);
      for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
      for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[cftab[b]++] |= i << 8; }
      // walk it, undoing the first run-length coding (4 equal bytes, then a count), CRC as we go
      const block = new Uint8Array(n * 2 > 1 << 16 ? n + (n >> 1) + 16 : 1 << 16);
      let bn = 0, buf = block, crc = -1, last = -1, same = 0;
      const put = (b) => {
        if (bn >= buf.length) { const g = new Uint8Array(buf.length * 2); g.set(buf); buf = g; }
        buf[bn++] = b; crc = (crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff];
      };
      let p = tt[origPtr] >>> 8;
      for (let k = 0; k < n; k++) {
        const e = tt[p]; const b = e & 0xff; p = e >>> 8;
        if (same === 4) { for (let r = 0; r < b; r++) put(last); same = 0; last = -1; continue; }
        put(b);
        if (b === last) same++; else { last = b; same = 1; }
      }
      crc = ~crc | 0;
      if (crc !== blockCrc) throw new Error('bunzip2: a block CRC does not match');
      streamCrc = (((streamCrc << 1) | (streamCrc >>> 31)) ^ crc) | 0;
      out.push(buf.subarray(0, bn)); total += bn;
    }
    // another stream may follow, byte-aligned; anything else ends it
    br.n -= br.n & 7;
    if (br.pos >= br.u8.length && br.n < 8) break;
    const save = { pos: br.pos, acc: br.acc, n: br.n };
    try { if (br.bits(8) !== 0x42) throw 0; } catch { break; }
    br.pos = save.pos; br.acc = save.acc; br.n = save.n;
  }
  const r = new Uint8Array(total);
  let o = 0; for (const c of out) { r.set(c, o); o += c.length; }
  return r;
}
