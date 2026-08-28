// probe-intro.js — diagnose why a demo renders black/garbled: mode, fault, modeX,
// where pixels live (chained A000 vs planes), progress. Renders via video.js (Mode-X aware).
//   node tools/probe-intro.js <program> [ticks]
import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';

const [prog, ticksArg, outArg] = process.argv.slice(2);
const TICKS = Number(ticksArg) || 300;
const { mc, dos } = makeMachine();          // composed like the browser — see harness.mjs
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(prog)), '', 'C:\\PROG');

let blocks = 0;
const t0 = Date.now();
for (let t = 0; t < TICKS && !fault && !dos.programDone; t++) {
  mc.runSlice(400000);
  if (Date.now() - t0 > 15000) { console.log('  (wall-clock cap hit at tick', t, ')'); break; }
}
const vga = mc.vga || {}, fb = mc.mem.u8;
let chained = 0; for (let i = 0; i < 64000; i++) if (fb[0xa0000 + i]) chained++;
let planar = 0; const planes = vga.planes; if (planes) for (let i = 0; i < planes.length; i++) if (planes[i]) planar++;
const dac = mc.bios.dac; let dacNonGray = 0; for (let i = 0; i < 768; i++) if ((dac[i] & 63) !== 0) dacNonGray++;
// Chained A000 is not the only surface a program can draw on, and a probe that reports only that one
// files a text-mode game as blank -- which is how Pitman was once recorded as broken. Report B800
// too, and count DISTINCT values: a solid fill is 64000 non-zero bytes AND a blank screen.
const mode = mc.mem.r8(0x449);
let cells = 0; for (let i = 0; i < 80 * 25; i++) { const c = fb[0xb8000 + i * 2]; if (c && c !== 32) cells++; }
const hist = new Uint8Array(256); for (let i = 0; i < 64000; i++) hist[fb[0xa0000 + i]] = 1;
let distinct = 0; for (let i = 0; i < 256; i++) distinct += hist[i];
const textual = mode === 0x03 || mode === 0x02 || mode === 0x07;
console.log(`${prog}
  mode=0x${mode.toString(16)}  modeX=${!!vga.modeX}  planar=${!!vga.planar}  fault=${fault ? fault.message : 'none'}  done=${dos.programDone}
  chained A000 nonzero: ${chained}/64000 (${distinct} distinct)   planes nonzero: ${planar}   DAC set entries: ${dacNonGray}/768
  B800 text cells used: ${cells}/2000${textual && cells && !chained ? '   <- drawing in TEXT mode; not a failure' : ''}`);

// render through the real video path if available, else naive chained read
if (outArg) {
  const S = 2, W = 320 * S, H = 200 * S, rgb = Buffer.alloc(W * H * 3);
  const pal = new Uint8Array(768); for (let i = 0; i < 768; i++) pal[i] = Math.round((dac[i] & 63) * 255 / 63);
  const stride = (vga.modeX && mc.video && mc.video.crtc) ? (mc.video.crtc[0x13] * 2 || 80) : 80;
  const px = (x, y) => {
    if (vga.modeX && planes) return planes[((x & 3) * (planes.length >> 2)) + (((y * stride) + (x >> 2)) & 0xffff)];
    return fb[0xa0000 + y * 320 + x];
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = px((x / S) | 0, (y / S) | 0), o = (y * W + x) * 3;
    rgb[o] = pal[v * 3]; rgb[o + 1] = pal[v * 3 + 1]; rgb[o + 2] = pal[v * 3 + 2];
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, y * W * 3 + W * 3);
  const ck = (ty, d) => { const b = Buffer.concat([Buffer.from(ty), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } const cr = Buffer.alloc(4); cr.writeUInt32BE(~c >>> 0); return Buffer.concat([l, b, cr]); };
  writeFileSync(outArg, Buffer.concat([sig, ck('IHDR', ih), ck('IDAT', deflateSync(raw)), ck('IEND', Buffer.alloc(0))]));
  console.log('  wrote', outArg);
}
