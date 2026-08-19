// shot.mjs — run a game headless and write what it drew to a PNG.
//
//   node tools/shot.mjs <gameSubdir> <PROG.EXE> [ticks] [out.png] [tail] [keysHexCSV]
//   KEYS are scancodes fed once the title is up, e.g. 1c,9c for Enter make+break.
//
// run-game.mjs reports occupancy counts, which say a picture EXISTS but not whether it is the right
// one. Handles the three layouts a title can be in: linear mode 13h at A000, the four EGA bit-planes
// with the attribute palette, and CGA's interleaved banks at B800.

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [sub, prog, ticksArg, outArg, tail, keysArg] = process.argv.slice(2);
if (!sub || !prog) { console.error('usage: node tools/shot.mjs <subdir> <PROG.EXE> [frames] [out.png] [tail]'); process.exit(2); }
const K = Number(ticksArg) || 60;
const out = outArg || `/tmp/${sub}.png`;
const KEYS = (keysArg || '').split(',').filter(Boolean).map((x) => parseInt(x, 16));

const dir = join(ROOT, 'games', sub);
const vfs = new VFS();
for (const rel of walk(dir)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
vfs.chdir('\\');

const { mc, dos } = makeMachine({ vfs });
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(join(dir, prog))), tail ? ' ' + tail : '', 'C:\\' + prog);
// Bounded on the BIOS tick counter at 0040:006C — the same clock tools/egaref.mjs stops DOSBox on,
// so the two captures are the SAME MOMENT. Counting host iterations instead, as run-game.mjs does,
// advances roughly 150 guest ticks each: its "frame 40" is minutes of guest time, and comparing that
// against a 60-tick DOSBox capture says nothing. No tickTimer() either — the run loop owns the PIT,
// and calling it drives the clock a second time.
const ticks = () => (mc.mem.r16(0x46c) | (mc.mem.r16(0x46e) << 16)) >>> 0;
let fed = false, guard = 0;
while (ticks() < K && !fault && !dos.programDone && guard++ < 500000) {
  if (!fed && KEYS.length && ticks() >= K >> 1 && mc.pushScancodes) { mc.pushScancodes(KEYS); fed = true; }
  mc.runSlice(20000);
}

const mode = mc.mem.r8(0x449), vga = mc.vga, dac = mc.bios.dac;
const rgb = new Uint8Array(320 * 200 * 3);
const put = (i, r, g, b) => { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; };

if (mc.mem.planar && vga) {
  // Four 64 KB planes, one bit each; the 4-bit index goes through the attribute palette, and that
  // entry is a DAC index. Stride comes from CRTC 0x13 in words, start address from 0x0C/0x0D.
  const planes = vga.planes;
  const stride = (vga.crtc[0x13] || 40) * 2;
  const start = ((vga.crtc[0x0c] << 8) | vga.crtc[0x0d]) >>> 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const off = (start + y * stride + (x >> 3)) & 0xffff, bit = 7 - (x & 7);
    let idx = 0;
    for (let p = 0; p < 4; p++) idx |= ((planes[p * 0x10000 + off] >> bit) & 1) << p;
    const d = (vga.palette ? vga.palette[idx] : idx) & 0x3f;
    put(y * 320 + x, dac[d * 3] << 2, dac[d * 3 + 1] << 2, dac[d * 3 + 2] << 2);
  }
} else if (mode === 4 || mode === 5 || mode === 6) {
  const CGA = [[0, 0, 0], [0, 170, 170], [170, 0, 170], [170, 170, 170]];
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const b = mc.mem.u8[0xb8000 + (y & 1) * 0x2000 + (y >> 1) * 80 + (x >> 2)];
    const c = CGA[(b >> (6 - 2 * (x & 3))) & 3];
    put(y * 320 + x, c[0], c[1], c[2]);
  }
} else {
  for (let i = 0; i < 64000; i++) {
    const d = mc.mem.u8[0xa0000 + i];
    put(i, dac[d * 3] << 2, dac[d * 3 + 1] << 2, dac[d * 3 + 2] << 2);
  }
}

const S = 2, W = 320 * S, H = 200 * S, buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const s = (((y / S) | 0) * 320 + ((x / S) | 0)) * 3, d = (y * W + x) * 3;
  buf[d] = rgb[s]; buf[d + 1] = rgb[s + 1]; buf[d + 2] = rgb[s + 2];
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const stride = W * 3, raw = Buffer.alloc((stride + 1) * H);
for (let y = 0; y < H; y++) buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
const crc32 = (b) => { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(body)); return Buffer.concat([L, body, C]); };
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`${sub}/${prog} @ ${ticks()} ticks — mode 0x${mode.toString(16)} ${mc.mem.planar ? '(planaire)' : ''} — ${fault ? 'FAUTE ' + fault.message : dos.programDone ? 'termine' : 'en cours'} -> ${out}`);
