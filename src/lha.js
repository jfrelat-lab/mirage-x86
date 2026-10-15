// lha.js — the LHA archives of the DOS years, read without the host's tools.
//
// id's Quake 1.06 shareware (quake106.zip) holds its game in resource.1, an "LHA's SFX 2.13L"
// self-extractor: a small DOS program followed by an ordinary LHA archive. OASIS points at that
// archive as id published it, so its files are read here: level-0 and level-1 headers, methods
// -lh0- (stored) and -lh5- (LZSS with static Huffman tables per block, an 8 KiB window) — the
// method LHarc 2 and LHA 2.x wrote by default. The decoder is Haruhiko Okumura's from ar002 and
// LHa for UNIX, the reference implementation of the format.

const NC = 510, NT = 19, TBIT = 5, CBIT = 9, THRESHOLD = 3;

/** Decode `orig` bytes of -lh5- (dicbit 13: np 14, pbit 4) from `src`. */
function lh5(src, orig, np = 14, pbit = 4) {
  const out = new Uint8Array(orig);
  let pos = 0, inAt = 0, bitbuf = 0, subbitbuf = 0, bitcount = 0, blocksize = 0;
  const fillbuf = (n) => {
    bitbuf = (bitbuf << n) & 0xffff;
    while (n > bitcount) {
      n -= bitcount;
      bitbuf |= (subbitbuf << n) & 0xffff;
      subbitbuf = inAt < src.length ? src[inAt++] : 0;
      bitcount = 8;
    }
    bitcount -= n;
    bitbuf |= subbitbuf >> bitcount;
  };
  const getbits = (n) => { const x = bitbuf >> (16 - n); fillbuf(n); return x; };
  fillbuf(16);

  const left = new Uint16Array(2 * NC - 1), right = new Uint16Array(2 * NC - 1);
  const cLen = new Uint8Array(NC), cTable = new Uint16Array(4096);
  const ptLen = new Uint8Array(Math.max(NT, np)), ptTable = new Uint16Array(256);

  // Canonical Huffman decoding table: direct for codes up to `bits` long, a tree below that.
  const makeTable = (nchar, bitlen, bits, table) => {
    const count = new Uint16Array(17), weight = new Uint32Array(17), start = new Uint32Array(18);
    for (let i = 0; i < nchar; i++) count[bitlen[i]]++;
    for (let i = 1; i <= 16; i++) start[i + 1] = start[i] + (count[i] << (16 - i));
    if (start[17] !== 1 << 16) throw new Error('lha: bad Huffman table');
    const jut = 16 - bits;
    for (let i = 1; i <= bits; i++) { start[i] >>>= jut; weight[i] = 1 << (bits - i); }
    for (let i = bits + 1; i <= 16; i++) weight[i] = 1 << (16 - i);
    let i = start[bits + 1] >>> jut;
    if (i !== 1 << 16) { const k = 1 << bits; while (i !== k) table[i++] = 0; }
    let avail = nchar;
    const mask = 1 << (15 - bits);
    for (let ch = 0; ch < nchar; ch++) {
      const len = bitlen[ch];
      if (len === 0) continue;
      const next = start[len] + weight[len];
      if (len <= bits) { for (let j = start[len]; j < next; j++) table[j] = ch; }
      else {
        let k = start[len], arr = table, at = k >>> jut;
        for (let n = len - bits; n !== 0; n--) {
          if (arr[at] === 0) { right[avail] = left[avail] = 0; arr[at] = avail++; }
          const node = arr[at];
          if (k & mask) { arr = right; at = node; } else { arr = left; at = node; }
          k <<= 1;
        }
        arr[at] = ch;
      }
      start[len] = next;
    }
  };
  const readPtLen = (nn, nbit, special) => {
    const n = getbits(nbit);
    if (n === 0) { const c = getbits(nbit); ptLen.fill(0, 0, nn); ptTable.fill(c); return; }
    let i = 0;
    while (i < n) {
      let c = bitbuf >> 13;
      if (c === 7) { let m = 1 << 12; while (m & bitbuf) { m >>= 1; c++; } }
      fillbuf(c < 7 ? 3 : c - 3);
      ptLen[i++] = c;
      if (i === special) { let z = getbits(2); while (z-- > 0) ptLen[i++] = 0; }
    }
    while (i < nn) ptLen[i++] = 0;
    makeTable(nn, ptLen, 8, ptTable);
  };
  const readCLen = () => {
    const n = getbits(CBIT);
    if (n === 0) { const c = getbits(CBIT); cLen.fill(0); cTable.fill(c); return; }
    let i = 0;
    while (i < n) {
      let c = ptTable[bitbuf >> 8];
      if (c >= NT) { let m = 1 << 7; do { c = (bitbuf & m) ? right[c] : left[c]; m >>= 1; } while (c >= NT); }
      fillbuf(ptLen[c]);
      if (c <= 2) {
        let z = c === 0 ? 1 : c === 1 ? getbits(4) + 3 : getbits(CBIT) + 20;
        while (z-- > 0) cLen[i++] = 0;
      } else cLen[i++] = c - 2;
    }
    while (i < NC) cLen[i++] = 0;
    makeTable(NC, cLen, 12, cTable);
  };
  const decodeC = () => {
    if (blocksize === 0) { blocksize = getbits(16); readPtLen(NT, TBIT, 3); readCLen(); readPtLen(np, pbit, -1); }
    blocksize--;
    let j = cTable[bitbuf >> 4];
    if (j >= NC) { let m = 1 << 3; do { j = (bitbuf & m) ? right[j] : left[j]; m >>= 1; } while (j >= NC); }
    fillbuf(cLen[j]);
    return j;
  };
  const decodeP = () => {
    let j = ptTable[bitbuf >> 8];
    if (j >= np) { let m = 1 << 7; do { j = (bitbuf & m) ? right[j] : left[j]; m >>= 1; } while (j >= np); }
    fillbuf(ptLen[j]);
    if (j !== 0) j = (1 << (j - 1)) + getbits(j - 1);
    return j;
  };
  while (pos < orig) {
    const c = decodeC();
    if (c < 256) { out[pos++] = c; continue; }
    let len = c - 256 + THRESHOLD, from = pos - decodeP() - 1;
    while (len-- > 0 && pos < orig) out[pos++] = out[from++];
  }
  return out;
}

/**
 * The files of an LHA archive, or of a self-extractor that carries one (the archive starts at the
 * first header found). Directories use `\` in LHA; they come out with `/`.
 * @param {Uint8Array} b
 * @returns {{path: string, bytes: Uint8Array}[]}
 */
export function unlha(b) {
  const files = [];
  const isHeader = (h) => h + 22 <= b.length && b[h + 2] === 0x2d && b[h + 3] === 0x6c && b[h + 4] === 0x68 && b[h + 6] === 0x2d && b[h] > 20;
  let h = 0;
  while (h < b.length - 22 && !isHeader(h)) h++;
  const u32 = (a) => (b[a] | (b[a + 1] << 8) | (b[a + 2] << 16) | (b[a + 3] << 24)) >>> 0;
  while (h < b.length - 22 && b[h] !== 0) {
    if (!isHeader(h)) throw new Error(`lha: no header at ${h}`);
    const method = String.fromCharCode(...b.subarray(h + 2, h + 7)), level = b[h + 20];
    if (level > 1) throw new Error(`lha: header level ${level} not supported`);
    let packed = u32(h + 7);
    const orig = u32(h + 11), nameLen = b[h + 21];
    const path = new TextDecoder('latin1').decode(b.subarray(h + 22, h + 22 + nameLen)).replace(/\\/g, '/');
    let data = h + 2 + b[h];                       // header size counts from byte 2
    if (level === 1) {                             // extended headers follow; their sizes are in `packed`
      let next = b[data - 2] | (b[data - 1] << 8);
      while (next) { const sz = next; next = b[data + sz - 2] | (b[data + sz - 1] << 8); data += sz; packed -= sz; }
    }
    const src = b.subarray(data, data + packed);
    if (method === '-lh0-') files.push({ path, bytes: src.slice() });
    else if (method === '-lh5-') files.push({ path, bytes: lh5(src, orig) });
    else if (method === '-lhd-') { /* a directory entry */ }
    else throw new Error(`lha: method ${method} not supported (${path})`);
    h = data + packed;
  }
  return files;
}
