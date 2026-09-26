// A boot image under MIRAGE (rendered by src/video.js, as the browser shows it) against QEMU with
// the vendor Cirrus ROM (tools/v86/qemucap.mjs), after the same number of seconds: the pixels that
// differ, and a side-by-side PNG (MIRAGE | QEMU | differences in red). The ROADMAP H2 reference.
//
//   node qemudiff.mjs <image> <seconds> [outdir]
// MIRAGE's seconds are guest seconds (cycles), QEMU's are wall-clock: a timer-paced program lines up,
// an animation may be a frame or two out of phase — look at the picture before trusting the count.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { inflateSync } from 'zlib';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const [img, secs, outdir = '/tmp/qemudiff'] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const name = img.split('/').pop().replace(/\.[^.]+$/, '');
const mirPng = `${outdir}/${name}-mirage.png`;
execFileSync('node', [HERE + 'romrender.mjs', img, secs, mirPng], { stdio: 'ignore' });
execFileSync('node', [HERE + 'qemucap.mjs', img, secs], { stdio: 'ignore' });

// Minimal PNG (8-bit RGB, filter 0 only — what frame.mjs writes) and PPM (P6) readers.
const readPNG = (f) => {
  const b = readFileSync(f); let o = 8, W = 0, H = 0; const idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8);
    if (t === 'IHDR') { W = b.readUInt32BE(o + 8); H = b.readUInt32BE(o + 12); } else if (t === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len; }
  const raw = inflateSync(Buffer.concat(idat)), px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) raw.copy(px, y * W * 3, y * (W * 3 + 1) + 1, (y + 1) * (W * 3 + 1));
  return { W, H, px };
};
const readPPM = (f) => {
  const b = readFileSync(f); const hdr = b.toString('latin1', 0, 64).split(/\s+/);
  const W = +hdr[1], H = +hdr[2], start = b.indexOf('255', 2 + hdr[0].length) + 4;
  return { W, H, px: new Uint8Array(b.subarray(start, start + W * H * 3)) };
};
const m = readPNG(mirPng), q = readPPM(`/tmp/qcap_${name}.ppm`);
// Bring QEMU's picture to MIRAGE's size by sampling (QEMU doubles 320x200 to 640x400, text 720 wide).
const sx = q.W / m.W, sy = q.H / m.H, qs = new Uint8Array(m.W * m.H * 3);
for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
  const s = (Math.floor(y * sy) * q.W + Math.floor(x * sx)) * 3, d = (y * m.W + x) * 3;
  qs[d] = q.px[s]; qs[d + 1] = q.px[s + 1]; qs[d + 2] = q.px[s + 2];
}
// "Same" allows the 6-to-8-bit DAC rounding difference between the two (a few units per channel).
let diff = 0; const PW = m.W * 3 + 16, side = new Uint8Array(PW * m.H * 3);   // three panels, 8 px apart
for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
  const i = (y * m.W + x) * 3;
  const same = Math.abs(m.px[i] - qs[i]) <= 6 && Math.abs(m.px[i + 1] - qs[i + 1]) <= 6 && Math.abs(m.px[i + 2] - qs[i + 2]) <= 6;
  if (!same) diff++;
  const row = y * PW * 3;
  for (let k = 0; k < 3; k++) { side[row + x * 3 + k] = m.px[i + k]; side[row + (m.W + 8 + x) * 3 + k] = qs[i + k]; }
  const r = row + (2 * m.W + 16 + x) * 3; if (!same) side[r] = 255;
}
const { writePNG } = await import(fileURLToPath(new URL('../frame.mjs', import.meta.url)));
writePNG(`${outdir}/${name}-side.png`, side, m.W * 3 + 16, m.H, 1);
console.log(`${name.padEnd(20)} @${secs}s ${m.W}x${m.H}: ${diff} px differ (${(100 * diff / (m.W * m.H)).toFixed(2)}%) -> ${outdir}/${name}-side.png`);
