// zstd.js — a Zstandard decompressor (RFC 8878), for the browser, which has none: Docker image layers
// compressed with zstd (application/vnd.oci.image.layer.v1.tar+zstd). Node has zlib.zstdDecompressSync;
// a page has only this. Frames one after the other (skippable frames skipped), raw, RLE and compressed
// blocks; literals raw, RLE or Huffman-coded in one or four streams, the tree described directly or
// with FSE; sequences coded with the predefined, RLE, described or repeated FSE tables, and the three
// repeated offsets. No dictionaries (an image layer has none); the content checksum is not checked --
// the layer's sha256 already is. Checked against the zstd command (tools/test.js).

const highBit = (v) => 31 - Math.clz32(v);

/** A bit stream read backward from its end, as FSE and Huffman streams are: the last byte's highest set
 *  bit marks where the bits begin; reading past the start yields zeros (`pos` < 0 says it happened). */
class BackBits {
  constructor(b, start, end) {
    this.b = b; this.start = start;
    const last = b[end - 1];
    if (!last) throw new Error('zstd: a bit stream without its end mark');
    this.pos = (end - 1 - start) * 8 + highBit(last);              // bits left, the mark excluded
  }
  /** `n` bits (0 to 32), most significant first as the encoder wrote them. */
  read(n) {
    if (n === 0) return 0;
    if (n > 24) { const hi = this.read(n - 16); return (hi * 65536 + this.read(16)) >>> 0; }
    this.pos -= n;
    let p = this.pos, shift = 0;
    if (p < 0) { shift = -p; n += p; p = 0; if (n <= 0) return 0; }
    const at = this.start + (p >> 3), b = this.b;
    const w = (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
    return (((w >>> (p & 7)) & ((1 << n) - 1)) << shift) >>> 0;
  }
}

/** FSE's normalized counts from a forward bit stream at `at`: { counts, log, size } (bytes used). */
function readFseCounts(b, at, maxSymbol) {
  let bit = 0;
  const peek = (n) => { let v = 0; for (let i = 0; i < n; i++) { const k = bit + i; v |= ((b[at + (k >> 3)] >> (k & 7)) & 1) << i; } return v >>> 0; };
  const log = peek(4) + 5; bit += 4;
  let remaining = (1 << log) + 1, threshold = 1 << log, nb = log + 1, sym = 0;
  const counts = [];
  while (remaining > 1 && sym <= maxSymbol) {
    const max = 2 * threshold - 1 - remaining;
    let v;
    const low = peek(nb - 1);
    if (low < max) { v = low; bit += nb - 1; }
    else { v = peek(nb); if (v >= threshold) v -= max; bit += nb; }
    const c = v - 1;                                                  // -1: "less than one"
    remaining -= c < 0 ? -c : c;
    counts[sym++] = c;
    if (c === 0) {                                                    // runs of zero probabilities: 2-bit repeat flags
      for (;;) { const r = peek(2); bit += 2; for (let i = 0; i < r; i++) counts[sym++] = 0; if (r !== 3) break; }
    }
    while (remaining < threshold) { nb--; threshold >>= 1; }
  }
  if (remaining !== 1) throw new Error('zstd: bad FSE table description');
  return { counts, log, size: (bit + 7) >> 3 };
}

/** The decoding table of FSE counts (RFC 8878 4.1.1): per state, { sym, nb, base }. */
function fseTable(counts, log) {
  const size = 1 << log, sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size), next = [];
  let high = size - 1;
  counts.forEach((c, s) => { if (c === -1) { sym[high--] = s; next[s] = 1; } else next[s] = c; });
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let pos = 0;
  counts.forEach((c, s) => { for (let i = 0; i < c; i++) { sym[pos] = s; do pos = (pos + step) & mask; while (pos > high); } });
  if (pos !== 0) throw new Error('zstd: FSE table not filled');
  for (let i = 0; i < size; i++) {
    const s = sym[i], x = next[s]++, n = log - highBit(x);
    nb[i] = n; base[i] = (x << n) - size;
  }
  return { sym, nb, base, log };
}
const rle = (s) => ({ sym: Uint8Array.of(s), nb: Uint8Array.of(0), base: Uint16Array.of(0), log: 0 });

// The predefined distributions (RFC 8878 3.1.1.3.2.2) and what each code means.
const LL_DEF = fseTable([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
const ML_DEF = fseTable([1, 4, 3, 2, 2, 2, 2, 2, 2, ...new Array(37).fill(1), ...new Array(7).fill(-1)], 6);   // 53 symbols
const OF_DEF = fseTable([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);
const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [...Array.from({ length: 32 }, (_, i) => i + 3), 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [...new Array(32).fill(0), 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** A Huffman tree description at `at`: { table: { sym, nb }, bits, size }. */
function readHuffman(b, at) {
  const hb = b[at];
  let weights = [], size;
  if (hb < 128) {                                                    // weights compressed with FSE, two interleaved states
    const { counts, log, size: ds } = readFseCounts(b, at + 1, 255);
    const t = fseTable(counts, log), bits = new BackBits(b, at + 1 + ds, at + 1 + hb);
    let s1 = bits.read(log), s2 = bits.read(log);
    for (;;) {
      weights.push(t.sym[s1]); s1 = t.base[s1] + bits.read(t.nb[s1]);
      if (bits.pos < 0) { weights.push(t.sym[s2]); break; }
      weights.push(t.sym[s2]); s2 = t.base[s2] + bits.read(t.nb[s2]);
      if (bits.pos < 0) { weights.push(t.sym[s1]); break; }
      if (weights.length > 255) throw new Error('zstd: too many Huffman weights');
    }
    size = 1 + hb;
  } else {                                                           // direct: four bits a weight
    const n = hb - 127;
    for (let i = 0; i < n; i++) weights.push(i & 1 ? b[at + 1 + (i >> 1)] & 15 : b[at + 1 + (i >> 1)] >> 4);
    size = 1 + ((n + 1) >> 1);
  }
  let total = 0;
  for (const w of weights) if (w) total += 1 << (w - 1);
  const bits = highBit(total) + 1, rest = (1 << bits) - total;     // the last symbol's weight is implied
  if (rest & (rest - 1)) throw new Error('zstd: bad Huffman weights');
  weights.push(highBit(rest) + 1);
  const sym = new Uint8Array(1 << bits), nb = new Uint8Array(1 << bits);
  let pos = 0;
  for (let w = 1; w <= bits; w++) weights.forEach((wt, s) => {
    if (wt !== w) return;
    const n = 1 << (w - 1);
    sym.fill(s, pos, pos + n); nb.fill(bits + 1 - w, pos, pos + n); pos += n;
  });
  return { table: { sym, nb, bits }, size };
}
function huffStream(b, start, end, t, out, o, n) {
  const bits = new BackBits(b, start, end);
  for (let i = 0; i < n; i++) {
    const p = bits.pos;                                               // peek without consuming: read, then give back
    const v = bits.read(t.bits); bits.pos = p;
    out[o + i] = t.sym[v]; bits.pos -= t.nb[v];
  }
}

/** Decompress a whole zstd stream: one or more frames. Returns a Uint8Array. */
export function zstdDecompress(src) {
  const b = src instanceof Uint8Array ? src : new Uint8Array(src);
  let out = new Uint8Array(Math.max(1024, b.length * 4)), op = 0;
  const room = (n) => { if (op + n <= out.length) return; let m = out.length * 2; while (m < op + n) m *= 2; const o2 = new Uint8Array(m); o2.set(out.subarray(0, op)); out = o2; };
  const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  let at = 0;
  while (at < b.length) {
    const magic = u32(at);
    if ((magic & 0xfffffff0) === 0x184d2a50) { at += 8 + u32(at + 4); continue; }   // a skippable frame
    if (magic !== 0xfd2fb528) throw new Error('zstd: not a zstd frame');
    at += 4;
    const fhd = b[at++], fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) at++;                                                // window descriptor
    const dictSize = [0, 1, 2, 4][dictFlag];
    if (dictSize) { let id = 0; for (let i = 0; i < dictSize; i++) id |= b[at + i] << (8 * i); if (id) throw new Error('zstd: frames with a dictionary are not supported'); at += dictSize; }
    at += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    const frameStart = op;
    const rep = [1, 4, 8];
    let huff = null, tLL = null, tOF = null, tML = null;
    for (let last = 0; !last;) {
      const h = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16); at += 3;
      last = h & 1; const type = (h >> 1) & 3, size = h >>> 3;
      if (type === 0) { room(size); out.set(b.subarray(at, at + size), op); op += size; at += size; continue; }
      if (type === 1) { room(size); out.fill(b[at], op, op + size); op += size; at += 1; continue; }
      if (type === 3) throw new Error('zstd: reserved block type');
      const end = at + size;
      // ---- literals
      const lb = b[at], lt = lb & 3, sf = (lb >> 2) & 3;
      let lits, nLits;
      if (lt === 0 || lt === 1) {
        let hs;
        if (sf === 0 || sf === 2) { nLits = lb >> 3; hs = 1; } else if (sf === 1) { nLits = (lb >> 4) + (b[at + 1] << 4); hs = 2; } else { nLits = (lb >> 4) + (b[at + 1] << 4) + (b[at + 2] << 12); hs = 3; }
        at += hs;
        if (lt === 0) { lits = b.subarray(at, at + nLits); at += nLits; } else { lits = new Uint8Array(nLits).fill(b[at]); at += 1; }
      } else {
        let comp, hs, streams = sf === 0 ? 1 : 4;
        if (sf < 2) { const v = lb | (b[at + 1] << 8) | (b[at + 2] << 16); nLits = (v >> 4) & 0x3ff; comp = (v >> 14) & 0x3ff; hs = 3; }
        else if (sf === 2) { const v = u32(at); nLits = (v >> 4) & 0x3fff; comp = (v >>> 18) & 0x3fff; hs = 4; }
        else { const v = u32(at); nLits = (v >> 4) & 0x3ffff; comp = (v >>> 22) + (b[at + 4] << 10); hs = 5; }
        at += hs;
        let p = at;
        if (lt === 2) { const h2 = readHuffman(b, p); huff = h2.table; p += h2.size; }
        else if (!huff) throw new Error('zstd: treeless literals with no tree before');
        lits = new Uint8Array(nLits);
        const dataEnd = at + comp;
        if (streams === 1) huffStream(b, p, dataEnd, huff, lits, 0, nLits);
        else {
          const s1 = b[p] | (b[p + 1] << 8), s2 = b[p + 2] | (b[p + 3] << 8), s3 = b[p + 4] | (b[p + 5] << 8), seg = Math.floor((nLits + 3) / 4);
          let q = p + 6;
          const ends = [q + s1, q + s1 + s2, q + s1 + s2 + s3, dataEnd], outs = [0, seg, 2 * seg, 3 * seg], lens = [seg, seg, seg, nLits - 3 * seg];
          for (let k = 0; k < 4; k++) { huffStream(b, k ? ends[k - 1] : q, ends[k], huff, lits, outs[k], lens[k]); }
        }
        at = dataEnd;
      }
      // ---- sequences
      let nSeq = b[at++];
      if (nSeq >= 128) { if (nSeq < 255) nSeq = ((nSeq - 128) << 8) + b[at++]; else { nSeq = b[at] + (b[at + 1] << 8) + 0x7f00; at += 2; } }
      let lp = 0;
      if (nSeq > 0) {
        const modes = b[at++];
        const table = (mode, def, maxSym, prev) => {
          if (mode === 0) return def;
          if (mode === 1) return rle(b[at++]);
          if (mode === 3) { if (!prev) throw new Error('zstd: a repeated table with none before'); return prev; }
          const { counts, log, size: ds } = readFseCounts(b, at, maxSym); at += ds; return fseTable(counts, log);
        };
        tLL = table(modes >> 6, LL_DEF, 35, tLL); tOF = table((modes >> 4) & 3, OF_DEF, 31, tOF); tML = table((modes >> 2) & 3, ML_DEF, 52, tML);
        const bits = new BackBits(b, at, end);
        let sLL = bits.read(tLL.log), sOF = bits.read(tOF.log), sML = bits.read(tML.log);
        for (let i = 0; i < nSeq; i++) {
          const ofCode = tOF.sym[sOF], mlCode = tML.sym[sML], llCode = tLL.sym[sLL];
          const ofVal = ofCode ? ((1 << ofCode) >>> 0) + bits.read(ofCode) : 1;
          const ml = ML_BASE[mlCode] + bits.read(ML_BITS[mlCode]);
          const ll = LL_BASE[llCode] + bits.read(LL_BITS[llCode]);
          let offset;
          if (ofVal > 3) { offset = ofVal - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
          else {
            const idx = ofVal - 1 + (ll === 0 ? 1 : 0);
            if (idx === 0) offset = rep[0];
            else { offset = idx === 3 ? rep[0] - 1 : rep[idx]; if (idx !== 1) rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
          }
          if (i < nSeq - 1) {                                       // the states, in that order: literals, match, offset
            sLL = tLL.base[sLL] + bits.read(tLL.nb[sLL]);
            sML = tML.base[sML] + bits.read(tML.nb[sML]);
            sOF = tOF.base[sOF] + bits.read(tOF.nb[sOF]);
          }
          room(ll + ml);
          out.set(lits.subarray(lp, lp + ll), op); op += ll; lp += ll;
          if (offset > op - frameStart || offset === 0) throw new Error('zstd: an offset before the frame');
          let from = op - offset;
          if (offset >= ml) { out.copyWithin(op, from, from + ml); op += ml; }
          else for (let k = 0; k < ml; k++) out[op++] = out[from++];
        }
      }
      const restLits = nLits - lp;
      room(restLits); out.set(lits.subarray(lp, nLits), op); op += restLits;
      at = end;
    }
    if (checksum) at += 4;
  }
  return out.slice(0, op);
}
