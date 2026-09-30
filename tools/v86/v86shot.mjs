// v86 (release build) headless: boot a hard-disk image, PNG screenshot + instruction counter every
// STEP wall seconds, keys (set-1 scancodes) at given wall seconds — the SPEED reference beside QEMU
// and MIRAGE: v86 is also JavaScript and also a recompiler.
//
//   V86_DIR=/some/dir STEP=15 KEYS=90:1c MEM=128 node tools/v86/v86shot.mjs <img> <secs> <outdir>
//
// V86_DIR holds `npm i v86` (node_modules/v86/build/libv86.mjs + v86.wasm) and bios/seabios.bin +
// bios/vgabios.bin from github.com/copy/v86/tree/master/bios — never committed (boot/ rule).
// Renders mode 12h (4 planes through the attribute map and DAC), mode 13h and VBE 8/16/32 bpp.
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { writePNG } = await import(ROOT + '/tools/frame.mjs');
const V = process.env.V86_DIR;
const { V86 } = await import(V + '/node_modules/v86/build/libv86.mjs');
const [imgPath, secsS, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const img = readFileSync(imgPath), SECS = Number(secsS), STEP = Number(process.env.STEP || 15);
const e = new V86({
  wasm_path: V + '/node_modules/v86/build/v86.wasm',
  bios: { buffer: readFileSync(V + '/bios/seabios.bin').buffer }, vga_bios: { buffer: readFileSync(V + '/bios/vgabios.bin').buffer },
  hda: { buffer: img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength) },
  memory_size: Number(process.env.MEM || 128) << 20, vga_memory_size: 8 << 20, autostart: true, disable_speaker: true,
});
let size = [720, 400, 0];
e.add_listener('screen-set-size', (a) => { size = a; });
const keys = (process.env.KEYS || '').split(',').filter(Boolean).map((x) => { const [t, c] = x.split(':'); return { t: Number(t), c: parseInt(c, 16), done: false }; });
const vga = () => e.v86.cpu.devices.vga;
function shot(file) {
  const v = vga(); const [w0, h0, bpp] = size;
  if (!bpp) return null;                       // text mode: nothing to render here
  const w = w0, h = h0, rgb = new Uint8Array(w * h * 3); let lit = 0;
  const put = (i, c) => { rgb[i * 3] = (c >> 16) & 255; rgb[i * 3 + 1] = (c >> 8) & 255; rgb[i * 3 + 2] = c & 255; if (c & 0xffffff) lit++; };
  if (bpp === 4 || (bpp === 8 && w === 320 && !v.svga_enabled)) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c;
      if (bpp === 4) { const o = y * (w >> 3) + (x >> 3), b = 7 - (x & 7);
        const idx = ((v.plane0[o] >> b) & 1) | (((v.plane1[o] >> b) & 1) << 1) | (((v.plane2[o] >> b) & 1) << 2) | (((v.plane3[o] >> b) & 1) << 3);
        c = v.vga256_palette[v.dac_map[idx]]; }
      else { const o = y * w + x; c = v.vga256_palette[[v.plane0, v.plane1, v.plane2, v.plane3][o & 3][o >> 2]]; }
      put(y * w + x, c);
    }
  } else {
    const m = v.svga_memory, Bpp = bpp >> 3;
    for (let i = 0; i < w * h; i++) {
      let c;
      if (bpp === 8) c = v.vga256_palette[m[i]];
      else if (bpp === 16) { const p = m[i * 2] | m[i * 2 + 1] << 8; c = ((p >> 11) << 19) | (((p >> 5) & 63) << 10) | ((p & 31) << 3); }
      else c = m[i * Bpp + 2] << 16 | m[i * Bpp + 1] << 8 | m[i * Bpp];
      put(i, c);
    }
  }
  writePNG(file, rgb, w, h, 1); return lit;
}
const T0 = Date.now(); let t = STEP, lastI = 0;
const timer = setInterval(() => {
  const s = (Date.now() - T0) / 1000;
  for (const k of keys) if (!k.done && s >= k.t) { k.done = true; e.keyboard_send_scancodes([k.c, k.c | 0x80]); console.log('key', k.c.toString(16), 'at', s.toFixed(0), 's'); }
  if (s >= t) {
    const n = e.get_instruction_counter(), file = `${out}/v86-${String(t).padStart(4, '0')}.png`;
    const lit = shot(file);
    console.log(`${t}s  ${size.join('x')}  ${((n - lastI) / STEP / 1e6).toFixed(0)} M instr/s  lit ${lit}  -> ${lit === null ? '(text)' : file}`);
    lastI = n; t += STEP;
    if (t > SECS) { clearInterval(timer); e.stop(); process.exit(0); }
  }
}, 200);
