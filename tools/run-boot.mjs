// run-boot.mjs — boot a sector image headless and report what it drew.
//
//   node tools/run-boot.mjs <image> [blockBudget] [keysHexCSV]
//   e.g. node tools/run-boot.mjs intros/BOOTCHESS.IMG 2000000 20,a0
//
// The counterpart of run-com.js for the boot path: no DOS is installed, so there is no PSP, no
// INT 21h and no termination convention — a boot sector runs until it halts or we stop it. That
// makes the interesting signals "did it fault", "what mode did it set" and "what is on screen".

import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { bootSector, isBootSector } from '../src/boot.js';

const path = process.argv[2];
if (!path) { console.error('usage: node tools/run-boot.mjs <image> [budget] [keysHexCSV]'); process.exit(2); }
const budget = Number(process.argv[3]) || 2_000_000;
const keys = process.argv[4] ? process.argv[4].split(',').map(h => parseInt(h, 16)) : [];
const png = process.env.PNG || null;                 // PNG=out.png to dump the mode-13h screen

const mc = new Machine({ memSize: 1 << 20 });
installBIOS(mc);
for (const f of ['vga-rom-8x16.bin', 'vga-rom-8x8.bin', 'vga-rom-8x14.bin']) {
  const prop = f.includes('8x8') ? 'font8x8' : f.includes('8x14') ? 'font8x14' : 'font';
  try { mc[prop] = new Uint8Array(readFileSync(new URL('../assets/' + f, import.meta.url))); } catch {}
}
let fault = null;
mc.onError = (e) => { fault = e; };

const bytes = new Uint8Array(readFileSync(path));
const info = bootSector(mc, bytes);
console.log(`=== ${path} (${bytes.length} bytes, signature ${isBootSector(bytes) ? '55 AA ✓' : 'MISSING'}) ===`);
console.log(`booted at 0000:7C00, DL=0x${info.drive.toString(16).padStart(2, '0')}`);

const t0 = Date.now();
let ran = 0, ticks = 0, fed = 0;
while (ran < budget && !mc.cpu.halted && !fault && Date.now() - t0 < 8000) {
  ran += mc.runSlice(50000);
  mc.tickTimer(); ticks++;
  // Feed a keystroke whenever the sector is sitting in a BIOS key wait — a chess program does
  // nothing at all until someone types a move.
  if (mc.blocked && fed < keys.length) { mc.keyQueue.push({ ascii: keys[fed], scan: keys[fed] }); fed++; }
}

const mode = mc.mem.r8(0x449);
console.log(`blocks: ${ran.toLocaleString()} (${ticks} ticks)${mc.cpu.halted ? ' — halted' : ''}`);
console.log(`video mode(0x449): 0x${mode.toString(16)}  planar: ${!!mc.planar}`);

if (mode === 0x13 || mc.planar) {
  const base = 0xa0000, span = 64000, seen = new Set();
  let nonzero = 0;
  for (let i = 0; i < span; i++) { const p = mc.mem.u8[base + i]; if (p) nonzero++; seen.add(p); }
  console.log(`framebuffer: ${nonzero}/${span} non-zero, ${seen.size} distinct`);
} else {                                        // text mode: show what it actually printed
  console.log('--- B800 text ---');
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const ch = mc.mem.u8[0xb8000 + (row * 80 + col) * 2];
      line += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ch ? '·' : ' ';
    }
    if (line.trim()) console.log(String(row).padStart(2) + ': ' + line.replace(/\s+$/, ''));
  }
}
if (png && (mode === 0x13)) {
  const S = 2, W = 320 * S, H = 200 * S, rgb = Buffer.alloc(W * H * 3), dac = mc.bios.dac;
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = Math.round((dac[i] & 63) * 255 / 63);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = mc.mem.u8[0xa0000 + ((y / S) | 0) * 320 + ((x / S) | 0)], o = (y * W + x) * 3;
    rgb[o] = pal[px * 3]; rgb[o + 1] = pal[px * 3 + 1]; rgb[o + 2] = pal[px * 3 + 2];
  }
  writeFileSync(png, encodePNG(W, H, rgb));
  console.log(`wrote ${png} (${W}x${H})`);
}
if (fault) { console.log(`FAULT: ${fault.message}`); process.exit(1); }
console.log('no fault ✓');

// ---- minimal PNG (truecolor), same encoder as render-com.js ----
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
                        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}
