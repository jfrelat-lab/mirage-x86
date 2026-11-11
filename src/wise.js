// wise.js — the files of a Wise installer (Wise Solutions' InstallMaster and Installation System of
// 1996-2000), read without running it, in the browser and in Node. Half-Life's Uplink demo (1999) was
// published as one: hluplink.exe, a Win32 stub followed by its data.
//
// After the stub's last section come raw deflate streams, each followed by its CRC-32: first the
// installer's own (its colours, its script, its DLL), then the files it installs, one stream each. The
// script names every file it writes -- an entry of opcode 0: flags, the stream's start and end offsets
// in the file data, a DOS date and time, the inflated size, then the destination, "%MAINDIR%\..." --
// with offsets counted from where the first file's stream begins. So: the first streams are inflated
// here (a small inflate that reports where each stream ends, which DecompressionStream cannot) until
// one is a script; the file data's base is found where the first file's stream inflates to its size;
// then each file is inflated from its offsets.

// ---- inflate (RFC 1951), returning how many input bytes the stream took -----------------------------
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code from code lengths: counts per length and symbols in code order. */
function huffman(lengths) {
  const count = new Uint16Array(16), sym = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  lengths.forEach((l, s) => { if (l) sym[offs[l]++] = s; });
  return { count, sym };
}

/**
 * Inflate the raw deflate stream at `src[at..]`, to at most `limit` bytes (a guard against a false
 * start). Returns { bytes, end } -- `end` the offset just past the stream -- or null when the bytes
 * there are not a stream.
 */
export function inflateAt(src, at, limit = 1 << 26) {
  let pos = at, bit = 0, bits = 0;
  const need = (n) => { while (bits < n) { if (pos >= src.length) throw new Error('eof'); bit |= src[pos++] << bits; bits += 8; } };
  const get = (n) => { need(n); const v = bit & ((1 << n) - 1); bit >>>= n; bits -= n; return v; };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= get(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('bad code');
  };
  let out = new Uint8Array(1 << 16), n = 0;
  const put = (b) => { if (n === out.length) { if (n >= limit) throw new Error('too long'); const o = new Uint8Array(n * 2); o.set(out); out = o; } out[n++] = b; };
  try {
    let last;
    do {
      last = get(1);
      const type = get(2);
      if (type === 0) {
        bit = 0; bits = 0;
        if (pos + 4 > src.length) return null;
        const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) return null;
        pos += 4;
        for (let i = 0; i < len; i++) put(src[pos++]);
      } else if (type === 1 || type === 2) {
        let lit, dist;
        if (type === 1) {
          const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          lit = huffman(l); dist = huffman(new Uint8Array(30).fill(5));
        } else {
          const hlit = get(5) + 257, hdist = get(5) + 1, hclen = get(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = get(3);
          const clh = huffman(cl), lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const s = decode(clh);
            if (s < 16) lens[i++] = s;
            else if (s === 16) { if (!i) return null; const r = 3 + get(2), v = lens[i - 1]; for (let k = 0; k < r; k++) lens[i++] = v; }
            else { const r = s === 17 ? 3 + get(3) : 11 + get(7); i += r; }
          }
          lit = huffman(lens.subarray(0, hlit)); dist = huffman(lens.subarray(hlit));
        }
        for (;;) {
          const s = decode(lit);
          if (s < 256) put(s);
          else if (s === 256) break;
          else {
            const li = s - 257; if (li >= 29) return null;
            const len = LBASE[li] + get(LEXT[li]), di = decode(dist); if (di >= 30) return null;
            const d = DBASE[di] + get(DEXT[di]); if (d > n) return null;
            for (let k = 0; k < len; k++) put(out[n - d]);
          }
        }
      } else return null;
    } while (!last);
  } catch { return null; }
  return { bytes: out.slice(0, n), end: pos };
}

/** The end of the stub: its last section's raw data. */
function overlayStart(b) {
  const pe = b[0x3c] | (b[0x3d] << 8) | (b[0x3e] << 16) | (b[0x3f] << 24);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = v.getUint16(pe + 6, true), sec = pe + 24 + v.getUint16(pe + 20, true);
  let end = 0;
  for (let i = 0; i < n; i++) end = Math.max(end, v.getUint32(sec + 40 * i + 20, true) + v.getUint32(sec + 40 * i + 16, true));
  return end;
}

/** The files a script installs: { name, start, end, size }, in the script's order. */
export function wiseEntries(script) {
  const v = new DataView(script.buffer, script.byteOffset, script.byteLength), out = [];
  for (let i = 43; i < script.length - 2; i++) {
    if (script[i] !== 0x25 || script[i - 43] !== 0) continue;           // "%MAINDIR%\..." after an opcode 0
    let j = i; while (j < script.length && script[j]) j++;
    const name = String.fromCharCode(...script.subarray(i, j));
    if (!/^%[A-Z_0-9]+%\\./.test(name)) continue;
    const start = v.getUint32(i - 40, true), end = v.getUint32(i - 36, true), size = v.getUint32(i - 28, true);
    if (end > start) out.push({ name, start, end, size });
    i = j;
  }
  return out;
}

/**
 * The files of a Wise installer: [{ path, bytes }], path as the script writes it ("%MAINDIR%\valve\
 * pak0.PAK"). `inflate(bytes)`: a raw-deflate decoder for the files themselves (DecompressionStream's,
 * or zlib's); by default the one here. `want(path)`: only the files it accepts are inflated.
 */
export async function unwise(b, { inflate = null, want = () => true } = {}) {
  const top = overlayStart(b);
  // The installer's streams, from the overlay's start, until one reads as a script.
  let at = top, entries = null, after = 0, skipped = 0;
  for (let k = 0; k < 64 && at < b.length && !entries; k++) {
    let r = null;
    while (at < b.length && skipped < 1 << 16 && !(r = inflateAt(b, at, 1 << 21))) { at++; skipped++; }
    if (!r) break;
    const e = wiseEntries(r.bytes);
    if (e.length >= 2) { entries = e; after = r.end; }
    at = r.end;
  }
  if (!entries) throw new Error('wise: no installation script in this file');
  // The file data's base: the stream the lowest offset names, found after the script where it inflates
  // to that entry's size.
  entries = entries.filter((e) => e.end <= b.length);
  const first = entries.reduce((a, e) => (e.start < a.start ? e : a));
  // Stream by stream from the script on (its DLL, its pictures), each stream's start a candidate.
  let base = -1, o = after;
  for (let k = 0; k < 64 && base < 0 && o < b.length; k++) {
    let r = null, s = 0;
    while (o < b.length && s++ < 64 && !(r = inflateAt(b, o, 1 << 21))) o++;
    if (!r) break;
    const t = first.start ? inflateAt(b, o + first.start, first.size + 1) : r;
    if (t && t.bytes.length === first.size) base = o;
    o = r.end;
  }
  if (base < 0) throw new Error('wise: the file data was not found');
  const seen = new Set(), files = [];
  for (const e of entries) {
    if (seen.has(e.name) || !want(e.name) || base + e.end > b.length) continue;
    seen.add(e.name);
    const data = b.subarray(base + e.start, base + e.end - 4);           // the CRC-32 after each stream
    const bytes = inflate ? await inflate(data) : inflateAt(b, base + e.start, e.size + 1).bytes;
    if (bytes.length !== e.size) throw new Error(`wise: ${e.name}: ${bytes.length} bytes, the script says ${e.size}`);
    files.push({ path: e.name, bytes });
  }
  return files;
}

/**
 * An OASIS `wise` layer's files: { wise: url, into, files? }. Without `files`, what the installer puts
 * under %MAINDIR% (the directory the visitor would have chosen), at the same paths; with it, the files
 * it names (script paths, "%MAINDIR%\valve\pak0.PAK") where it says. [{ to, bytes }], `to` relative.
 */
export async function wiseLayer(bytes, l, inflate) {
  const map = l.files ? new Map(Object.entries(l.files).map(([k, v]) => [k.toLowerCase(), v])) : null;
  const dest = (p) => (map ? map.get(p.toLowerCase()) || null : /^%MAINDIR%\\/i.test(p) ? p.slice(10).replace(/\\/g, '/') : null);
  const files = await unwise(bytes, { inflate, want: (p) => dest(p) !== null });
  if (map) for (const k of map.keys()) if (!files.some((f) => f.path.toLowerCase() === k)) throw new Error(`oasis: ${k} is not in ${l.wise}`);
  return files.map((f) => ({ to: (l.into ? l.into.replace(/\/$/, '') + '/' : '') + dest(f.path), bytes: f.bytes }));
}
