// First pass over v86 images under MIRAGE: does it fault, derail or halt, which video mode does it
// end in, and what is on screen. Writes a PNG for graphics modes and the text screen for text modes,
// so the QEMU comparison that follows has something to compare against.
//
//   node v86triage.mjs <image> [seconds]      (512-byte images are padded to a 1.44 MB floppy)
import { readFileSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const { dac6to8 } = await import(ROOT + '/tools/frame.mjs');
const path = process.argv[2];
const SECS = Number(process.argv[3]) || 20;
const name = path.split('/').pop().replace(/\.[^.]+$/, '');
let bytes = new Uint8Array(readFileSync(path));
const { mc } = makeMachine({ dos: false });
let drive = 0x00, geo = '';
if (bytes.length > 2949120) {                        // a hard disk: geometry from the partition table
  // Solve the geometry from the first partition's CHS/LBA pair — reading "end head + 1" and "end
  // sector" directly is wrong whenever the partition does not end on a cylinder boundary (this
  // image ends at 130/0/32, which gave 1 head and 32 sectors and "Error loading operating system").
  const e = 0x1be, dv = new DataView(bytes.buffer, bytes.byteOffset);
  const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true);
  const sh = bytes[e + 1], ss = bytes[e + 2] & 63;
  const eh = bytes[e + 5], es = bytes[e + 6] & 63, ec = bytes[e + 7] | ((bytes[e + 6] & 0xc0) << 2);
  const spt = sh ? (lba - (ss - 1)) / sh : 63;
  const end = lba + n - 1, hd = ec ? Math.round(((end - (es - 1)) / spt - eh) / ec) : 16;
  const cyl = Math.floor(bytes.length / (hd * spt * 512));
  mc.disk.attach(0x80, bytes, { cyl, heads: hd, spt, type: 3 });
  drive = 0x80; geo = `hd ${cyl}/${hd}/${spt}`;
} else {
  if (bytes.length < 1474560 && ![163840, 184320, 327680, 368640, 737280, 1228800].includes(bytes.length)) {
    const pad = new Uint8Array(1474560); pad.set(bytes); bytes = pad;
  }
  const g = mc.disk.attach(0x00, bytes); geo = `fd ${g.cyl}/${g.heads}/${g.spt}`;
}
let fault = null, derail = null;
mc.onError = (e) => { fault = e; }; mc.onDerail = (d) => { if (!derail) derail = d; };
bootSector(mc, bytes, { drive });
const t0 = Date.now(); let halted = false;
while (!fault && !derail && Date.now() - t0 < SECS * 1000) {
  mc.runSlice(20000); mc.tickTimer();
  if (mc.cpu.halted && !(mc.cpu.flags & 0x200)) { halted = true; break; }   // HLT with IF clear: over
}
const mode = mc.mem.u8[0x449];
const stop = fault ? 'FAULT ' + String(fault.message || fault).slice(0, 110)
  : derail ? 'DERAIL ' + String(derail).slice(0, 110) : halted ? 'halted (cli;hlt)' : `ran ${SECS}s`;
let screen = '';
const pngOut = `/tmp/v86t_${name}.png`;
const png = (W, H, rgb) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(rgb.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  const crc32 = (b) => { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(body)); return Buffer.concat([L, body, C]); };
  writeFileSync(pngOut, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
};
const dac = mc.bios.dac;
const rgbOf = (d, rgb, i) => { rgb[i] = dac6to8(dac[d * 3]); rgb[i + 1] = dac6to8(dac[d * 3 + 1]); rgb[i + 2] = dac6to8(dac[d * 3 + 2]); };
if (mode === 3 || mode === 2 || mode === 7 || mode === 1 || mode === 0) {
  const cols = mode <= 1 ? 40 : 80, base = mode === 7 ? 0xb0000 : 0xb8000;
  const lines = [];
  for (let y = 0; y < 25; y++) { let l = '';
    for (let x = 0; x < cols; x++) { const ch = mc.mem.u8[base + (y * cols + x) * 2]; l += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ch ? '.' : ' '; }
    lines.push(l.replace(/\s+$/, '')); }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  screen = lines.filter((l, i) => l || (lines[i - 1] && lines[i + 1])).slice(-10).map((l) => '    | ' + l).join('\n');
  writeFileSync(`/tmp/v86t_${name}.b8000`, Buffer.from(mc.mem.u8.slice(base, base + cols * 50)));
} else if (mode === 0x13) {
  const rgb = new Uint8Array(320 * 200 * 3); let nz = 0;
  for (let i = 0; i < 64000; i++) { const d = mc.mem.u8[0xa0000 + i]; rgbOf(d, rgb, i * 3); if (d) nz++; }
  png(320, 200, rgb); screen = `    mode 13h, ${nz} non-zero pixels -> ${pngOut}`;
} else if (mc.vga && mc.mem.planar) {
  const W = mode === 0x6a ? 800 : mode === 0x12 || mode === 0x11 ? 640 : mode === 0x0d ? 320 : 640, H = mode === 0x6a ? 600 : mode === 0x12 || mode === 0x11 ? 480 : mode === 0x10 || mode === 0x0f ? 350 : 200;
  const vga = mc.vga, planes = vga.planes, stride = (vga.crtc[0x13] || (W >> 4)) * 2;
  const start = ((vga.crtc[0x0c] << 8) | vga.crtc[0x0d]) >>> 0, rgb = new Uint8Array(W * H * 3); let nz = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const off = (start + y * stride + (x >> 3)) & 0xffff, bit = 7 - (x & 7); let idx = 0;
    for (let p = 0; p < 4; p++) idx |= ((planes[p * 0x10000 + off] >> bit) & 1) << p;
    rgbOf((vga.palette ? vga.palette[idx] : idx) & 0x3f, rgb, (y * W + x) * 3); if (idx) nz++;
  }
  png(W, H, rgb); screen = `    mode ${mode.toString(16)}h planar ${W}x${H}, ${nz} non-zero pixels -> ${pngOut}`;
} else if (mode === 4 || mode === 5 || mode === 6) {
  const W = mode === 6 ? 640 : 320, rgb = new Uint8Array(W * 200 * 3); let nz = 0;
  const pal4 = [0, 3, 5, 7];   // CGA palette 1 high-intensity approximation: presence is what matters here
  for (let y = 0; y < 200; y++) for (let x = 0; x < W; x++) {
    const off = 0xb8000 + ((y & 1) ? 0x2000 : 0) + (y >> 1) * 80 + (mode === 6 ? (x >> 3) : (x >> 2));
    const v = mode === 6 ? (mc.mem.u8[off] >> (7 - (x & 7))) & 1 : (mc.mem.u8[off] >> ((3 - (x & 3)) * 2)) & 3;
    const d = mode === 6 ? (v ? 0x3f : 0) : [0, 0x13, 0x15, 0x17][v]; rgbOf(d & 0x3f, rgb, (y * W + x) * 3); if (v) nz++;
  }
  png(W, 200, rgb); screen = `    CGA mode ${mode}, ${nz} non-zero pixels -> ${pngOut}`;
} else screen = `    mode ${mode.toString(16)}h — no capture for this layout`;
const vbe = mc.vbe ? ` VBE ${mc.vbe.number.toString(16)}` : '';
console.log(`${name.padEnd(20)} ${geo.padEnd(14)} ${stop}  [mode ${mode.toString(16)}h${vbe}]`);
if (screen) console.log(screen);
