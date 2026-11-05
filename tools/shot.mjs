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
import { dac6to8 } from './frame.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [sub, prog, ticksArg, outArg, tail, keysArg, feedArg] = process.argv.slice(2);
if (!sub || !prog) { console.error('usage: node tools/shot.mjs <subdir> <PROG.EXE> [frames] [out.png] [tail]'); process.exit(2); }
const K = Number(ticksArg) || 60;
const out = outArg || `/tmp/${sub}.png`;
const KEYS = (keysArg || '').split(',').filter(Boolean).map((x) => parseInt(x, 16));
// When to press them. Half-way through is the right guess for a title that runs an attract loop, and
// the wrong one for a title that STOPS on "press any key": Hexen's shareware nag holds the guest at
// tick 39, so a feed scheduled for tick 1100 never happens and the guard expires first.
const FEED = feedArg !== undefined ? Number(feedArg) : (K >> 1);
// MAKE scancode -> ASCII, for the BIOS/DOS half of a keypress. Only the keys a headless run needs
// to send: enough to answer a prompt, not a keyboard layout.
const MAKE_ASCII = { 0x01: 0x1b, 0x0e: 0x08, 0x0f: 0x09, 0x1c: 0x0d, 0x39: 0x20,
  0x02: 0x31, 0x03: 0x32, 0x04: 0x33, 0x05: 0x34, 0x06: 0x35,
  0x15: 0x79, 0x31: 0x6e, 0x1f: 0x73, 0x14: 0x74 };

const dir = join(ROOT, 'games', sub);
const vfs = new VFS();
for (const rel of walk(dir)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
vfs.chdir('\\');

// NOXMS=1 boots without an XMS driver (as tools/dpmi-probe.mjs does), for a title that refuses to
// run beside one: Zone 66 asks INT 2Fh AX=4300h and quits on AL=80h, as it does under DOSBox-X's
// default xms=true.
const { mc, dos } = makeMachine({ vfs, xms: process.env.NOXMS ? false : undefined });
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(join(dir, prog))), tail ? ' ' + tail : '', 'C:\\' + prog);
// Bounded on the BIOS tick counter at 0040:006C — the same clock tools/egaref.mjs stops DOSBox on,
// so the two captures are the SAME MOMENT. Counting host iterations instead, as run-game.mjs does,
// advances roughly 150 guest ticks each: its "frame 40" is minutes of guest time, and comparing that
// against a 60-tick DOSBox capture says nothing. No tickTimer() either — the run loop owns the PIT,
// and calling it drives the clock a second time.
// Counted from where the BIOS started it: 0040:006C begins at the time of day (the RTC's), not at 0,
// so an absolute bound ended every run before its first instruction.
const tick0 = (mc.mem.r16(0x46c) | (mc.mem.r16(0x46e) << 16)) >>> 0;
const ticks = () => ((((mc.mem.r16(0x46c) | (mc.mem.r16(0x46e) << 16)) >>> 0) - tick0 + 0x1800b0) % 0x1800b0);
// A guest that hooks INT 8 for its own pacing and does not chain to the BIOS leaves 0040:006C
// frozen — the counter is software, kept by the BIOS handler, not by the PIT. Quake does exactly
// that: it reaches mode 13h and draws while `ticks()` stays at 0, so a tick-bounded loop never
// ends. SHOT_BLOCKS gives a second bound in BLOCKS for those.
const BLOCK_BUDGET = Number(process.env.SHOT_BLOCKS) || 0;
let blocks = 0;
let fed = false, guard = 0;
// The guard is a hang stop, not a budget: a guest polling INT 16h burns iterations without advancing
// a single tick, so it has to be far above the number of iterations a real run needs.
while (ticks() < K && !fault && !dos.programDone && guard++ < 20000000) {
  if (!fed && KEYS.length && (BLOCK_BUDGET ? blocks >= BLOCK_BUDGET >> 1 : ticks() >= FEED) && mc.pushScancodes) {
    mc.pushScancodes(KEYS);
    // A real keypress feeds BOTH paths — src/keyboard.js pushes the scancode to the 8042 AND a
    // (scan, ascii) pair onto machine.keyQueue. Feeding only the hardware path left every DOS
    // console read unanswered: Hexen polls INT 21h AH=08 for its "press any key" nag and sat there
    // for ever while the browser walked straight past it.
    for (const s of KEYS) { const a = MAKE_ASCII[s]; if (a !== undefined) mc.keyQueue.push({ scan: s, ascii: a }); }
    fed = true;
  }
  // pushScancodes only QUEUES; pumpKeyboard is what stages a byte into the 8042 and raises IRQ1.
  // Without it the KEYS argument did nothing at all, and SCUMM — which reads the INT 9 path, not the
  // DOS buffer — sat on "Press ENTER to continue…" forever while the browser (ui.js, which does pump)
  // went past it. That was half of the "browser and headless disagree" report.
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  blocks += mc.runSlice(20000);
  if (BLOCK_BUDGET && blocks >= BLOCK_BUDGET) break;
}

const mode = mc.mem.r8(0x449), vga = mc.vga, dac = mc.bios.dac;
const rgb = new Uint8Array(320 * 200 * 3);
const put = (i, r, g, b) => { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; };

if (vga && vga.modeX) {
  // Mode X — unchained 256-colour. `mem.planar` is true here too, but the layout is NOT the EGA one:
  // each plane byte is a whole 8-bit pixel, and pixel x lives in plane x&3 at offset x>>2. Decoding
  // it as EGA bit-planes turns a real picture into vertical stripes, which is exactly what Wolf3D
  // looked like until this arm existed — the emulator was right and the viewer was not.
  const planes = vga.planes;
  const stride = (vga.crtc[0x13] || 20) * 2;           // bytes per plane per row
  const start = ((vga.crtc[0x0c] << 8) | vga.crtc[0x0d]) >>> 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const off = (start + y * stride + (x >> 2)) & 0xffff;
    const d = planes[(x & 3) * 0x10000 + off] & 0xff;
    put(y * 320 + x, dac6to8(dac[d * 3]), dac6to8(dac[d * 3 + 1]), dac6to8(dac[d * 3 + 2]));
  }
} else if (mc.mem.planar && vga) {
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
    put(y * 320 + x, dac6to8(dac[d * 3]), dac6to8(dac[d * 3 + 1]), dac6to8(dac[d * 3 + 2]));
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
    put(i, dac6to8(dac[d * 3]), dac6to8(dac[d * 3 + 1]), dac6to8(dac[d * 3 + 2]));
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
console.log(`${sub}/${prog} @ ${ticks()} ticks — mode 0x${mode.toString(16)} ${mc.mem.planar ? '(planar)' : ''} — ${fault ? 'FAULT ' + fault.message : dos.programDone ? 'done' : 'running'} -> ${out}`);
// A text mode has no picture to write: its screen, as text, says where the program stopped.
if (mode <= 3 || mode === 7) {
  const base = mode === 7 ? 0xb0000 : 0xb8000, cols = mc.mem.r16(0x44a) || 80, rows = (mc.mem.r8(0x484) || 24) + 1;
  for (let r = 0; r < rows; r++) { let l = ''; for (let c = 0; c < cols; c++) { const ch = mc.mem.r8(base + (r * cols + c) * 2); l += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; } if (l.trim()) console.log('| ' + l.trimEnd()); }
}
