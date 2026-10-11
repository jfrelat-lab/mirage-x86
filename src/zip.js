// zip.js — read a ZIP archive into a list of files, in the browser and in Node.
//
// Shareware and freeware of the period is distributed as a ZIP, and its licence usually asks that
// it be passed on complete and unmodified. So MIRAGE serves the archive as published and unpacks it
// here, rather than repackaging its contents. The central directory is read (it holds the sizes
// even when a local header defers them to a data descriptor); entries are "stored" (method 0) or
// "deflated" (method 8), the latter through the platform's DecompressionStream('deflate-raw').
// Anything else — encryption, ZIP64, old methods like implode — is reported, not guessed at.

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * @param {Uint8Array} zip
 * @returns {Promise<{path: string, bytes: Uint8Array}[]>} files only (directories are implied by paths)
 */
export async function unzip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes (a comment may follow it).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error('ZIP central directory is damaged');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    // Names of the period are CP437/ASCII; Latin-1 decoding keeps every byte as one character.
    const name = Array.from(zip.subarray(p + 46, p + 46 + nameLen), (b) => String.fromCharCode(b)).join('');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.endsWith('\\')) continue;            // a directory entry
    if (flags & 1) throw new Error(`${name}: encrypted ZIP entries are not supported`);
    if (dv.getUint32(local, true) !== SIG_LOC) throw new Error(`${name}: local header not found`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = zip.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) bytes = await inflateRaw(data);
    else throw new Error(`${name}: compression method ${method} is not supported (only stored and deflate)`);
    if (bytes.length !== size) throw new Error(`${name}: ${bytes.length} bytes unpacked, the directory says ${size}`);
    files.push({ path: name.replace(/\\/g, '/'), bytes });
  }
  return files;
}

/**
 * Apogee's shareware archives (Wolfenstein 3D 1.4, Commander Keen 1 and 4, as 3D Realms served them)
 * hold INSTALL.EXE and one NAME.SHR: a 3Ah-byte header (the file count at 10h), then per file its name
 * in 128 bytes, 40 bytes of attributes (at +8 the compressed size; the DOS date and time), and the
 * file compressed by the PKWARE Data Compression Library (`explode`). The installer is not run; its
 * files are added beside it, as it would have copied them.
 * @param {Uint8Array} shr
 * @returns {{path: string, bytes: Uint8Array}[]}
 */
export function unshr(shr) {
  const dv = new DataView(shr.buffer, shr.byteOffset, shr.byteLength), out = [];
  const count = dv.getUint16(0x10, true);
  let at = 0x3a;
  for (let i = 0; i < count && at + 0xa8 <= shr.length; i++) {
    let name = '';
    for (let k = 0; k < 128 && shr[at + k]; k++) name += String.fromCharCode(shr[at + k]);
    const size = dv.getUint32(at + 0x88, true), data = at + 0xa8;
    if (!name || data + size > shr.length) throw new Error(`unshr: entry ${i} runs past the end`);
    out.push({ path: name.toUpperCase(), bytes: explode(shr.subarray(data, data + size)) });
    at = data + size;
  }
  return out;
}

// ---- PKWARE DCL "implode", decompressed ----
// The format as the Data Compression Library writes it (and as zlib's contrib/blast documents it):
// a byte saying whether literals are coded (1) or raw (0), a byte with the dictionary's size (4, 5
// or 6: 1, 2 or 4 KiB), then LSB-first bits. 1 + a length and a distance copies from the output;
// 0 + a literal. The length 519 ends the stream. The three Huffman tables are fixed; they are given
// here as the library defines them, each byte a run: (count - 1) << 4 | code length.
const LIT_RUNS = [11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6,
  55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8,
  11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252,
  252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173];
const LEN_RUNS = [2, 35, 36, 53, 38, 23];
const DIST_RUNS = [2, 20, 53, 230, 247, 151, 248];
const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const huffman = (runs) => {
  const lengths = [];
  for (const r of runs) for (let k = (r >> 4) + 1; k > 0; k--) lengths.push(r & 15);
  const count = new Array(14).fill(0), offs = new Array(14).fill(0), symbol = [];
  for (const l of lengths) count[l]++;
  for (let l = 1; l < 13; l++) offs[l + 1] = offs[l] + count[l];
  lengths.forEach((l, sym) => { if (l) symbol[offs[l]++] = sym; });
  return { count, symbol };
};
let TABLES = null;
function explode(src) {
  if (!TABLES) TABLES = { lit: huffman(LIT_RUNS), len: huffman(LEN_RUNS), dist: huffman(DIST_RUNS) };
  let pos = 0, buf = 0, cnt = 0;
  const bits = (n) => {
    while (cnt < n) { if (pos >= src.length) throw new Error('explode: out of input'); buf |= src[pos++] << cnt; cnt += 8; }
    const v = buf & ((1 << n) - 1); buf >>>= n; cnt -= n; return v;
  };
  // Codes are stored bit-inverted, first bit first.
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l <= 13; l++) {
      code |= bits(1) ^ 1;
      const c = h.count[l];
      if (code < first + c) return h.symbol[index + code - first];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('explode: bad code');
  };
  const lit = bits(8), dict = bits(8);
  if (lit > 1 || dict < 4 || dict > 6) throw new Error('explode: not a DCL stream');
  let out = new Uint8Array(Math.max(1024, src.length * 4)), n = 0;
  const put = (b) => { if (n === out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; };
  for (;;) {
    if (bits(1)) {
      const s = decode(TABLES.len), len = LEN_BASE[s] + bits(LEN_EXTRA[s]);
      if (len === 519) break;
      const sh = len === 2 ? 2 : dict;
      const dist = (decode(TABLES.dist) << sh) + bits(sh) + 1;
      if (dist > n) throw new Error('explode: distance too far back');
      for (let k = 0; k < len; k++) put(out[n - dist]);
    } else put(lit ? decode(TABLES.lit) : bits(8));
  }
  return out.slice(0, n);
}

/**
 * id Software's shareware archives (DOOM 1.9, Heretic 1.2) do not hold the game: they hold DEICE.EXE
 * and a self-extracting PKZIP archive cut into floppy-sized pieces, NAME.1, NAME.2… INSTALL.BAT runs
 * DEICE, which glues the pieces back into NAME.EXE and runs it. Doing the same here — join the
 * pieces, read the ZIP inside — serves the archive exactly as id published it, installer included,
 * instead of a repackaged copy. The self-extractor keeps its central directory's offsets relative to
 * the start of the whole .EXE, so `unzip` reads it as it stands.
 * Anything without DEICE.EXE and a NAME.1 beside it is returned unchanged.
 * @param {{path: string, bytes: Uint8Array}[]} files
 */
export async function deice(files) {
  const byName = new Map(files.map((f) => [f.path.toUpperCase(), f]));
  const shr = [...byName.keys()].find((p) => p.endsWith('.SHR'));
  if (shr !== undefined && [...byName.keys()].some((p) => p.endsWith('INSTALL.EXE'))) {
    const dir = shr.includes('/') ? shr.slice(0, shr.lastIndexOf('/') + 1) : '';
    return [...files, ...unshr(byName.get(shr).bytes).map((f) => ({ path: dir + f.path, bytes: f.bytes }))];
  }
  const deiceAt = [...byName.keys()].find((p) => p === 'DEICE.EXE' || p.endsWith('/DEICE.EXE'));
  if (deiceAt === undefined) return files;
  const dir = deiceAt.slice(0, -'DEICE.EXE'.length);
  const first = [...byName.keys()].find((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && p.endsWith('.1'));
  if (first === undefined) return files;
  const stem = first.slice(0, -2), pieces = [];
  for (let n = 1; byName.has(`${stem}.${n}`); n++) pieces.push(byName.get(`${stem}.${n}`).bytes);
  const whole = new Uint8Array(pieces.reduce((a, p) => a + p.length, 0));
  let at = 0; for (const p of pieces) { whole.set(p, at); at += p.length; }
  return unzip(whole);
}
