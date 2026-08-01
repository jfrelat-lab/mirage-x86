// render-com.js — run a DOS program headless and render its mode-13h framebuffer
// (A000:0 + the DAC palette) to a PNG, so a demo's output can be inspected without
// a browser. Useful for visual diffing against a reference (e.g. DOSBox).
//
//   node tools/render-com.js <program> <out.png> [timerTicks=60] [scale=2]

import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const [prog, out, ticksArg, scaleArg] = process.argv.slice(2);
if (!prog || !out) { console.error('usage: node tools/render-com.js <program> <out.png> [ticks] [scale]'); process.exit(2); }
const TICKS = Number(ticksArg) || 60, S = Number(scaleArg) || 2;

const mc = new Machine({ memSize: 1 << 20 });
installBIOS(mc);
const dos = installDOS(mc, new VFS());
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(prog)), '', 'C:\\PROG');

// run, advancing the timer, until we've issued TICKS ticks (or it faults/exits)
const t0 = Date.now();
for (let t = 0; t < TICKS && !fault && !dos.programDone; t++) {
  mc.runSlice(400000);   // the run loop owns the PIT timer (timerAuto); a manual tickTimer here would
                         // double-deliver INT 8 vs serviceTimer and desync HLT-paced intros
  if (Date.now() - t0 > 8000) break;
}

// build an 8-bit→RGB palette from the DAC (6-bit channels)
const dac = mc.bios.dac, pal = new Uint8Array(256 * 3);
for (let i = 0; i < 768; i++) pal[i] = Math.round((dac[i] & 63) * 255 / 63);

const W = 320 * S, H = 200 * S, rgb = Buffer.alloc(W * H * 3), fb = mc.mem.u8;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const px = fb[0xa0000 + ((y / S) | 0) * 320 + ((x / S) | 0)];
  const o = (y * W + x) * 3;
  rgb[o] = pal[px * 3]; rgb[o + 1] = pal[px * 3 + 1]; rgb[o + 2] = pal[px * 3 + 2];
}
writeFileSync(out, encodePNG(W, H, rgb));
console.log(`${prog}: mode=0x${mc.mem.r8(0x449).toString(16)} ${fault ? 'FAULT ' + fault.message : 'ok'} → ${out} (${W}x${H})`);

// ---- minimal PNG (truecolor) ----
function encodePNG(w, h, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;  // 8-bit, truecolor
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) { let c = ~0 >>> 0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
