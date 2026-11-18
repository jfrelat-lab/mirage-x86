// make-swf.mjs — a small Flash movie of our own (SWF 6, uncompressed), for the Flash Player standalone
// projector on MIRAGE-WIN32: no third-party content. 320x240 at 30 frames a second, 60 frames, looping:
// a background colour, a square turning about its centre, a disc going left and right, a fixed bar.
//
//   node tools/win32/samples/flash/make-swf.mjs [out.swf]   (default: shapes.swf beside this script)

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) { this.cur = (this.cur << 1) | ((v >>> i) & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } } }
  sput(v, n) { this.put(v < 0 ? (v + (1 << n)) >>> 0 : v, n); }
  align() { if (this.n) this.put(0, 8 - this.n); return this; }
}
const sbits = (...vs) => Math.max(1, ...vs.map((v) => (v === 0 ? 1 : Math.floor(Math.log2(Math.abs(v))) + 2)));   // signed width
const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const rect = (x0, x1, y0, y1) => { const n = sbits(x0, x1, y0, y1), b = new Bits(); b.put(n, 5); for (const v of [x0, x1, y0, y1]) b.sput(v, n); return b.align().bytes; };
const tag = (code, body) => (body.length < 63 ? [...u16((code << 6) | body.length), ...body] : [...u16((code << 6) | 63), ...u32(body.length), ...body]);
const TW = 20;                                                                   // twips a pixel

/** A matrix: scale and rotation (16.16), translation in twips. */
const matrix = (a, b, c, d, tx, ty) => {
  const bits = new Bits(), fx = (v) => Math.round(v * 65536);
  const scale = a !== 1 || d !== 1, rot = b !== 0 || c !== 0;
  bits.put(scale ? 1 : 0, 1); if (scale) { const n = sbits(fx(a), fx(d)); bits.put(n, 5); bits.sput(fx(a), n); bits.sput(fx(d), n); }
  bits.put(rot ? 1 : 0, 1); if (rot) { const n = sbits(fx(b), fx(c)); bits.put(n, 5); bits.sput(fx(b), n); bits.sput(fx(c), n); }
  const n = sbits(tx, ty); bits.put(n, 5); bits.sput(tx, n); bits.sput(ty, n);
  return bits.align().bytes;
};
/** DefineShape: one solid fill, no line, an outline of straight and curved edges (twips, from its first point). */
const shape = (id, rgb, start, edges) => {
  const xs = [start[0]], ys = [start[1]]; let px = start[0], py = start[1];
  for (const e of edges) { if (e.length === 2) { px += e[0]; py += e[1]; } else { xs.push(px + e[0]); ys.push(py + e[1]); px += e[0] + e[2]; py += e[1] + e[3]; } xs.push(px); ys.push(py); }
  const body = [...u16(id), ...rect(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)), 1, 0, ...rgb, 0];   // one solid fill, no line styles
  const b = new Bits(); b.put(1, 4); b.put(0, 4);                               // NumFillBits 1, NumLineBits 0
  const mv = sbits(start[0], start[1]); b.put(0, 1); b.put(0b00011, 5); b.put(mv, 5); b.sput(start[0], mv); b.sput(start[1], mv); b.put(1, 1);   // move to, fill style 0 = 1
  for (const e of edges) {
    if (e.length === 2) { const n = sbits(e[0], e[1]); b.put(1, 1); b.put(1, 1); b.put(n - 2, 4); b.put(1, 1); b.sput(e[0], n); b.sput(e[1], n); }
    else { const n = sbits(...e); b.put(1, 1); b.put(0, 1); b.put(n - 2, 4); for (const v of e) b.sput(v, n); }
  }
  b.put(0, 6);                                                                   // end of shape
  return tag(2, [...body, ...b.align().bytes]);
};
const place = (depth, id, m, move) => tag(26, [move ? 0x05 : 0x06, ...u16(depth), ...(move ? [] : u16(id)), ...m]);   // PlaceObject2

const square = (s) => [[s, 0], [0, s], [-s, 0], [0, -s]];
const circle = (r) => {                                                          // eight quadratic arcs
  const out = [], k = Math.tan(Math.PI / 8); let a = 0, x = r, y = 0;
  for (let i = 0; i < 8; i++) {
    const a1 = a + Math.PI / 4, cx = Math.round(r * (Math.cos(a) - k * Math.sin(a))), cy = Math.round(r * (Math.sin(a) + k * Math.cos(a)));
    const nx = Math.round(r * Math.cos(a1)), ny = Math.round(r * Math.sin(a1));
    out.push([cx - x, cy - y, nx - cx, ny - cy]); x = nx; y = ny; a = a1;
  }
  return out;
};
const W = 320, H = 240, FRAMES = 60, S = 60 * TW, R = 30 * TW;
const tags = [
  ...tag(9, [0x33, 0x66, 0x99]),                                                 // SetBackgroundColor
  ...shape(1, [0xff, 0xcc, 0x00], [-S / 2, -S / 2], square(S)),                 // a yellow square, about its centre
  ...shape(2, [0xcc, 0x33, 0x33], [R, 0], circle(R)),                           // a red disc
  ...shape(3, [0xff, 0xff, 0xff], [0, 0], [[280 * TW, 0], [0, 12 * TW], [-280 * TW, 0], [0, -12 * TW]]),   // a white bar
];
for (let f = 0; f < FRAMES; f++) {
  const a = (2 * Math.PI * f) / FRAMES, c = Math.cos(a), s = Math.sin(a);
  tags.push(...place(1, 1, matrix(c, s, -s, c, 90 * TW, 100 * TW), f > 0));
  tags.push(...place(2, 2, matrix(1, 0, 0, 1, Math.round((200 + 70 * Math.sin(a)) * TW), 100 * TW), f > 0));
  if (f === 0) tags.push(...place(3, 3, matrix(1, 0, 0, 1, 20 * TW, 200 * TW), false));
  tags.push(...tag(1, []));                                                      // ShowFrame
}
tags.push(...tag(0, []));                                                        // End
const head = [...rect(0, W * TW, 0, H * TW), ...u16(30 << 8), ...u16(FRAMES)];
const body = [...head, ...tags], file = [0x46, 0x57, 0x53, 6, ...u32(8 + body.length), ...body];
const out = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'shapes.swf');
writeFileSync(out, Uint8Array.from(file));
console.log(`${out}: ${file.length} bytes, ${FRAMES} frames`);
