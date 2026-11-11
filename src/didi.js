// didi.js — the files of Epic MegaGames' own installer of 1998 (Jazz Jackrabbit 2's shareware,
// JAZZ2SWF.EXE), read without running it, in the browser and in Node.
//
// After the stub's last section: "DiDi", a header of 40 bytes, then one record per file -- "FILE", the
// file's size and the record's data size (32 bits each), its time (a FILETIME), its attributes, a group
// number, its name's length (16 bits) and its name ("HTML\index.html"), then its data. The data: a table
// of 16-bit sizes, one per 16 KiB of the file, then that many blocks, each the CRC-32 of its 16 KiB and
// the deflate output that makes them. The blocks are not streams of their own: the installer compressed
// file after file as ONE zlib stream, flushed at each 16 KiB, so a block refers back into the files
// before it. A new stream (its zlib header) starts where the previous one ended, at a group's first file.
// So: the blocks are put end to end, each stream inflated whole, its output cut into the files in order.

import { inflateAt } from './wise.js';

/** The end of the stub: its last section's raw data. */
function overlayStart(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), pe = v.getUint32(0x3c, true);
  const n = v.getUint16(pe + 6, true), sec = pe + 24 + v.getUint16(pe + 20, true);
  let end = 0;
  for (let i = 0; i < n; i++) end = Math.max(end, v.getUint32(sec + 40 * i + 20, true) + v.getUint32(sec + 40 * i + 16, true));
  return end;
}

/** The files of an Epic installer: [{ path, bytes }], path as it names them ("HTML\index.html"). */
export function undidi(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), at0 = overlayStart(b);
  const tag = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  if (tag(at0) !== 'DiDi') throw new Error('didi: not an Epic MegaGames installer');
  // The records, and every block's compressed bytes end to end.
  const files = [], parts = [];
  let p = at0 + 40, total = 0;
  while (p + 30 <= b.length && tag(p) === 'FILE') {
    const size = v.getUint32(p + 4, true), dsize = v.getUint32(p + 8, true), nl = v.getUint16(p + 28, true);
    const path = String.fromCharCode(...b.subarray(p + 30, p + 30 + nl)), d = p + 30 + nl, blocks = Math.ceil(size / 16384);
    let q = d + 2 * blocks;
    for (let k = 0; k < blocks; k++) { const n = v.getUint16(d + 2 * k, true); parts.push(b.subarray(q + 4, q + n)); total += n - 4; q += n; }
    files.push({ path, size });
    p = d + dsize;
  }
  if (!files.length) throw new Error('didi: no files');
  const all = new Uint8Array(total);
  let o = 0; for (const s of parts) { all.set(s, o); o += s.length; }
  // Stream after stream (a 2-byte zlib header, the deflate data, its Adler-32), each cut into files.
  const out = []; let i = 0;
  for (o = 0; i < files.length && o + 2 < all.length;) {
    if ((all[o] & 0x0f) !== 8 || ((all[o] << 8) | all[o + 1]) % 31) throw new Error(`didi: no stream at ${files[i].path}`);
    const r = inflateAt(all, o + 2, 1 << 28);
    if (!r) throw new Error(`didi: ${files[i].path}: the data does not inflate`);
    let k = 0;
    while (i < files.length && k + files[i].size <= r.bytes.length) { out.push({ path: files[i].path, bytes: r.bytes.subarray(k, k + files[i].size) }); k += files[i++].size; }
    if (k !== r.bytes.length) throw new Error(`didi: a stream of ${r.bytes.length} bytes does not end with a file`);
    o = r.end + 4;
  }
  if (i < files.length) throw new Error(`didi: ${files.length - i} files missing`);
  return out;
}

/**
 * An OASIS `didi` layer's files: { didi: url, into, files? }. Without `files`, every file at its own
 * path (where the installer puts them, under the directory the visitor would have chosen); with it, the
 * files it names, where it says. [{ to, bytes }], `to` relative.
 */
export function didiLayer(bytes, l) {
  const all = undidi(bytes), into = l.into ? l.into.replace(/\/$/, '') + '/' : '';
  if (!l.files) return all.map((f) => ({ to: into + f.path.replace(/\\/g, '/'), bytes: f.bytes }));
  return Object.entries(l.files).map(([from, to]) => {
    const f = all.find((e) => e.path.toLowerCase() === from.toLowerCase());
    if (!f) throw new Error(`oasis: ${from} is not in ${l.didi}`);
    return { to: into + to.replace(/^\//, ''), bytes: f.bytes };
  });
}
