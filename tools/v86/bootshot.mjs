// Boot an image and take a screenshot through src/video.js (the browser's renderer: text, CGA,
// planar, Mode X, VBE) every STEP guest seconds, with the CPU state beside it — for long boots where
// the question is "how far did it get, and is it still moving?".
//
//   MEM=64 MIRAGE_CPU=586 STEP=300 node bootshot.mjs <image> <seconds> <outdir>
// ENTER=5 presses Enter at guest second 5 (BeOS's partition menu waits for it); ENTER=200,260,320
// presses it at each (Windows 95's three dialogs before its desktop).
// With MIRAGE_SERIAL=1, what the guest sends to COM1 is written to <outdir>/serial.txt (ReactOS's debug log).
// An .iso image boots El Torito (src/boot.js bootCD); CDROM=<iso> puts a disc in the drive beside a disk.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector, bootCD } = await import(ROOT + '/src/boot.js');
const { Video } = await import(ROOT + '/src/video.js');
const { writePNG } = await import(ROOT + '/tools/frame.mjs');
const [img, secsS, outdir = '/tmp/bootshot'] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const SECS = Number(secsS) || 600, STEP = Number(process.env.STEP || 300);
const name = img.split('/').pop().replace(/\.[^.]+$/, '');
// readFileSync stops at 2 GiB (Windows 2000's image is exactly that): read in 64 MiB pieces.
const readBig = (file) => { const fd = openSync(file, 'r'), size = fstatSync(fd).size, out = new Uint8Array(size);
  for (let at = 0; at < size;) at += readSync(fd, out, at, Math.min(64 << 20, size - at), at);
  closeSync(fd); return out; };
let bytes = readBig(img);
const { mc } = makeMachine({ dos: false, memSize: Number(process.env.MEM || 16) << 20 });
let drive = 0;
const isISO = /\.iso$/i.test(img);
if (process.env.CDROM) mc.disk.attachCD(new Uint8Array(readFileSync(process.env.CDROM)));
if (isISO) { /* bootCD attaches it */ } else if (bytes.length > 2949120) {                      // hard disk: geometry from the partition table
  const dv = new DataView(bytes.buffer), e = 0x1be;
  const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true), sh = bytes[e + 1], ss = bytes[e + 2] & 63;
  const eh = bytes[e + 5], es = bytes[e + 6] & 63, ec = bytes[e + 7] | ((bytes[e + 6] & 0xc0) << 2);
  const ok = (bytes[e] === 0 || bytes[e] === 0x80) && bytes[e + 4] && n && ec;
  const spt = ok && sh ? (lba - (ss - 1)) / sh : 63, hd = ok ? Math.round(((lba + n - 1 - (es - 1)) / spt - eh) / ec) : 16;
  mc.disk.attach(0x80, bytes, { cyl: Math.floor(bytes.length / (hd * spt * 512)), heads: hd, spt, type: 3 });
  drive = 0x80;
} else {
  if (bytes.length < 1474560) { const p = new Uint8Array(1474560); p.set(bytes); bytes = p; }
  mc.disk.attach(0, bytes);
}
if (mc.serial) { const f = `${outdir}/serial.txt`; writeFileSync(f, ''); let line = ''; mc.serial.onTx = (b) => { line += String.fromCharCode(b); if (b === 10 || line.length > 200) { appendFileSync(f, line); line = ''; } }; }
let fault = null; mc.onError = (x) => { fault = x; };
if (isISO) bootCD(mc, bytes); else bootSector(mc, bytes, { drive });
const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
const v = new Video(mc, canvas); v.font = mc.font;
const c = mc.cpu, sec = 18.2065 * mc.pitBase, t0 = Date.now(), h = (x, n = 8) => (x >>> 0).toString(16).padStart(n, '0');
const enters = (process.env.ENTER || '').split(',').filter(Boolean).map((x) => Number(x) * sec);
let enterAt = enters.shift() || 0;
for (let t = STEP; t <= SECS && !fault; t += STEP) {
  // HLT with IF clear never wakes (a kernel's halt after a crash): guest time stops for good, and
  // waiting for the next STEP would spin for ever on the host. Say so and stop.
  const end = t * sec;
  while (!fault && c.cycles < end && !(c.halted && !(c.flags & 0x200))) {
    if (enterAt && c.cycles > enterAt) { enterAt = enters.shift() || 0; mc.pushScancodes([0x1c, 0x9c]); mc.keyQueue.push({ scan: 0x1c, ascii: 13 }); }
    mc.runSlice(20000); mc.pumpKeyboard();
  }
  if (c.halted && !(c.flags & 0x200)) fault = { message: `dead: HLT with IF=0 at ${(c.seg[1] >>> 0).toString(16)}:${(c.eip >>> 0).toString(16)} — the guest stopped itself` };
  v.frame = 16; v.render();
  const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3); let nz = 0;
  for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 0xff; rgb[i * 3 + 1] = (p >> 8) & 0xff; rgb[i * 3 + 2] = (p >> 16) & 0xff; if (p & 0xffffff) nz++; }
  const file = `${outdir}/${name}-${String(t).padStart(5, '0')}.png`;
  writePNG(file, rgb, W, H, 1);
  console.log(`${t}s (${((Date.now() - t0) / 1000) | 0}s host) mode ${h(mc.mem.u8[0x449], 2)}h ${W}x${H} ${nz} lit px  CR0=${h(c.cr0)} ${h(c.seg[1], 4)}:${h(c.eip)} VM=${(c.flags >> 17) & 1} IF=${(c.flags >> 9) & 1}${c.halted ? ' HLT' : ''} -> ${file}`);
}
if (fault) console.log('FAULT', String(fault.message).slice(0, 200));
