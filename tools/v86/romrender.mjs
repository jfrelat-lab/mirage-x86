// Boot an image, run N guest seconds, and render the screen with src/video.js itself (the browser's
// renderer, on a fake canvas) — with our own INT 10h, or with a real VGA BIOS ROM (VGAROM=<file>).
// The two PNGs should be the same picture: that is what makes a ROM usable as the machine's BIOS.
//
//   node romrender.mjs <image> <seconds> <out.png>
//   VGAROM=boot/roms/5446bv.vbi node romrender.mjs <image> <seconds> <out.png>
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const { Video } = await import(ROOT + '/src/video.js');
const { writePNG } = await import(ROOT + '/tools/frame.mjs');
const [img, secs, out] = process.argv.slice(2);
let bytes = new Uint8Array(readFileSync(img));
if (bytes.length < 1474560) { const p = new Uint8Array(1474560); p.set(bytes); bytes = p; }
const { mc } = makeMachine({ dos: false });
if (process.env.VGAROM) {
  const { installVgaRom } = await import(ROOT + '/src/vgarom.js');
  installVgaRom(mc, new Uint8Array(readFileSync(process.env.VGAROM)));
}
const hd = bytes.length > 2949120;
if (hd) mc.disk.attach(0x80, bytes, { cyl: Math.floor(bytes.length / (16 * 63 * 512)), heads: 16, spt: 63, type: 3 });
else mc.disk.attach(0x00, bytes);
let fault = null; mc.onError = (e) => { fault = e; };
bootSector(mc, bytes, { drive: hd ? 0x80 : 0 });
const c = mc.cpu, end = c.cycles + Number(secs) * 18.2065 * mc.pitBase;
while (!fault && c.cycles < end) mc.runSlice(20000);
const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
const v = new Video(mc, canvas);
v.font = mc.font;
v.frame = 16;                                   // the "cursor on" phase, so both runs agree
v.render();
const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 0xff; rgb[i * 3 + 1] = (p >> 8) & 0xff; rgb[i * 3 + 2] = (p >> 16) & 0xff; }
writePNG(out, rgb, W, H, 1);
console.log(`${out}: ${W}x${H} BDA mode ${mc.mem.r8(0x449).toString(16)}h planar=${mc.mem.planar} ${fault ? 'FAULT ' + String(fault.message).slice(0, 80) : ''}`);
