// avi.js — the AVI files MCI's "avivideo" device plays (src/win32/classic.js, api.js): RIFF AVI read in
// JavaScript, its frames decoded as Video for Windows' own codecs of 1992-1996 draw them. Half-Life's
// intro (1998) is Microsoft RLE8 ('mrle'): 320x240, 256 colours, 25 frames a second, with 22 kHz PCM.
//
// What is made: 8-bit video, uncompressed ('00db', a bottom-up DIB) or RLE8 ('00dc', drawn over the frame
// before it, as a delta frame leaves what it skips), its palette from the stream's format and changed by
// '00pc' chunks (AVIPALCHANGE); one PCM audio stream, its chunks put end to end. Other codecs (Cinepak,
// Video 1, Indeo) are not here: such a file is refused when opened.

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/**
 * The AVI in `b` (a Uint8Array): { w, h, usPerFrame, frames: [{ kind: 'db'|'dc'|'pc', data }], palette
 * (256 0x00RRGGBB), audio: { ch, rate, bits, data } | null }, or null when it is not one this player draws.
 */
export function parseAvi(b) {
  if (b.length < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'AVI ') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = { w: 0, h: 0, usPerFrame: 66667, frames: [], palette: new Uint32Array(256), audio: null, codec: '' };
  const streams = [];                                    // per stream: 'vids' or 'auds', with its handler
  const audio = [];
  const walk = (at, end, inMovi) => {
    while (at + 8 <= end) {
      const id = fourcc(b, at), len = v.getUint32(at + 4, true), body = at + 8;
      if (id === 'LIST') { const t = fourcc(b, body); walk(body + 4, Math.min(end, body + len), inMovi || t === 'movi'); }
      else if (id === 'avih') { out.usPerFrame = v.getUint32(body, true) || out.usPerFrame; out.w = v.getUint32(body + 32, true); out.h = v.getUint32(body + 36, true); }
      else if (id === 'strh') streams.push({ type: fourcc(b, body), handler: fourcc(b, body + 4).toLowerCase() });
      else if (id === 'strf' && streams.length) {
        const s = streams[streams.length - 1];
        if (s.type === 'vids') {                         // BITMAPINFOHEADER, then its colours
          const hs = v.getUint32(body, true), bits = v.getUint16(body + 14, true), comp = v.getUint32(body + 16, true), used = v.getUint32(body + 32, true) || 256;
          out.w = v.getInt32(body + 4, true); out.h = Math.abs(v.getInt32(body + 8, true)); s.bits = bits; s.comp = comp;
          for (let i = 0; i < Math.min(256, used) && body + hs + 4 * i + 3 < body + len; i++) { const q = body + hs + 4 * i; out.palette[i] = (b[q + 2] << 16) | (b[q + 1] << 8) | b[q]; }
        } else if (s.type === 'auds') {                  // WAVEFORMATEX
          s.tag = v.getUint16(body, true); s.ch = v.getUint16(body + 2, true); s.rate = v.getUint32(body + 4, true); s.sbits = v.getUint16(body + 14, true);
        }
      } else if (inMovi && /^\d\d(db|dc|pc|wb)$/.test(id)) {
        const n = parseInt(id.slice(0, 2), 10), s = streams[n], kind = id.slice(2);
        if (s && s.type === 'vids' && kind !== 'wb') out.frames.push({ kind, data: b.subarray(body, body + len) });
        else if (s && s.type === 'auds' && kind === 'wb') audio.push(b.subarray(body, body + len));
      }
      at = body + ((len + 1) & ~1);
    }
  };
  walk(12, b.length, false);
  const vs = streams.find((s) => s.type === 'vids'), as = streams.find((s) => s.type === 'auds');
  if (!vs || vs.bits !== 8 || !(vs.comp === 0 || vs.comp === 1)) return null;      // BI_RGB or BI_RLE8, 8 bits
  out.codec = vs.comp === 1 ? 'rle8' : 'dib8';
  if (as && as.tag === 1 && (as.sbits === 8 || as.sbits === 16) && audio.length) {
    const n = audio.reduce((a, c) => a + c.length, 0), data = new Uint8Array(n);
    let o = 0; for (const c of audio) { data.set(c, o); o += c.length; }
    out.audio = { ch: as.ch, rate: as.rate, bits: as.sbits, data };
  }
  return out;
}

/**
 * One frame onto `idx` (w x h palette indices, top row first), as Video for Windows decodes it: an
 * uncompressed DIB (bottom-up rows of 4-byte multiples), or RLE8 over what is there -- a count and a
 * colour, or 0 and an escape: 0 the line's end, 1 the bitmap's, 2 a jump (dx, dy), n >= 3 n literal bytes
 * padded to a word. A palette change (AVIPALCHANGE: first entry, count, flags, then PALETTEENTRYs) goes into
 * `palette` instead.
 */
export function decodeFrame(f, idx, w, h, palette) {
  const d = f.data;
  if (f.kind === 'pc') {
    const first = d[0], n = d[1] || 256;
    for (let i = 0; i < n && first + i < 256 && 4 + 4 * i + 2 < d.length; i++) palette[first + i] = (d[4 + 4 * i] << 16) | (d[5 + 4 * i] << 8) | d[6 + 4 * i];
    return;
  }
  if (!d.length) return;                                 // an empty chunk: the frame as it was
  const row = (y) => (h - 1 - y) * w;                    // DIB rows run from the bottom
  if (f.kind === 'db' && d.length >= ((w + 3) & ~3) * h) {
    const stride = (w + 3) & ~3;
    for (let y = 0; y < h; y++) idx.set(d.subarray(y * stride, y * stride + w), row(y));
    return;
  }
  let x = 0, y = 0, p = 0;
  while (p + 1 < d.length && y < h) {
    const n = d[p++], c = d[p++];
    if (n) { for (let k = 0; k < n && x < w; k++) idx[row(y) + x++] = c; continue; }
    if (c === 0) { x = 0; y++; }
    else if (c === 1) break;
    else if (c === 2) { x += d[p++]; y += d[p++]; }
    else { for (let k = 0; k < c; k++) { const v = d[p++]; if (x < w) idx[row(y) + x++] = v; } if (c & 1) p++; }
  }
}
