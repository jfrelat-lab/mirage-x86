// samples.mjs — the Win32 samples (tools/win32/samples) on Windows 2000 and on MIRAGE-WIN32, side by side.
//
//   node tools/win32/samples.mjs [name ...]      (default: every sample)
//
// The oracle: Windows 2000 itself, v86's image (boot/v86/windows2k-v2.img, 1024x768, the classic blue
// desktop), booted in QEMU with -snapshot (the image is never written) and the samples' CD
// (tools/win32/samples/samples.iso, made by build.sh) in its drive D:. Each sample is started from
// Run (Win+R, typed through QEMU's monitor), its screen taken (screendump) after it has drawn; it ends
// by itself after ten seconds. MIRAGE: tools/win32/run.mjs, its screen at 3 guest seconds, with the
// page's Arial (Arimo, its win metrics as the page sets them).
//
// Out ($OUT, default /tmp/w32-samples): <name>-win2k.png, <name>-mirage.png, and <name>.png -- the two
// side by side, cropped to where either differs from the desktop, then their difference (the pixels
// that differ, in red). One line a sample: how many of the cropped pixels differ.
//
// Environment: WIN2K (the disk image), QEMU (qemu-system-i386), PORT (the monitor's, 4555), BOOT (seconds
// to wait for the desktop, 75).

import { spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { createConnection } from 'net';
import { inflateSync } from 'zlib';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { writePNG } from '../frame.mjs';
import { pageFonts } from '../../src/win32/fonts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), DIR = join(ROOT, 'tools/win32/samples');
const OUT = process.env.OUT || '/tmp/w32-samples', PORT = Number(process.env.PORT || 4555), BOOT = Number(process.env.BOOT || 75);
const WIN2K = process.env.WIN2K || join(ROOT, 'boot/v86/windows2k-v2.img'), ISO = join(DIR, 'samples.iso');
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DIR).filter((f) => f.endsWith('.exe')).map((f) => f.slice(0, -4)).sort();
mkdirSync(OUT, { recursive: true });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ---- pictures: { w, h, px: Uint8Array RGB } --------------------------------------------------------
const readPPM = (file) => {                                          // QEMU's screendump: P6, 255
  const b = readFileSync(file); let at = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[at]))) at++; let s = ''; while (!/\s/.test(String.fromCharCode(b[at]))) s += String.fromCharCode(b[at++]); return s; };
  if (tok() !== 'P6') throw new Error(`${file}: not a P6 PPM`);
  const w = +tok(), h = +tok(); tok(); at++;
  return { w, h, px: new Uint8Array(b.subarray(at, at + w * h * 3)) };
};
const readPNG = (file) => {                                          // writePNG's own: 8-bit RGB, filter 0
  const b = readFileSync(file), idat = []; let at = 8, w = 0, h = 0;
  while (at < b.length) { const n = b.readUInt32BE(at), t = b.toString('latin1', at + 4, at + 8); if (t === 'IHDR') { w = b.readUInt32BE(at + 8); h = b.readUInt32BE(at + 12); } if (t === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + n)); at += 12 + n; }
  const raw = inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  return { w, h, px };
};
const DESK = [0x3a, 0x6e, 0xa5];
/** Where a picture is not the desktop -- the plain blue, or `base` (Windows 2000's with its icons) -- its
 *  taskbar (below 740) left out: [x0, y0, x1, y1]. */
const extent = (p, base = null) => {
  let x0 = p.w, y0 = p.h, x1 = 0, y1 = 0;
  for (let y = 0; y < Math.min(p.h, 740); y++) for (let x = 0; x < p.w; x++) {
    const i = 3 * (y * p.w + x), d = base ? [base.px[i], base.px[i + 1], base.px[i + 2]] : DESK;
    if (p.px[i] === d[0] && p.px[i + 1] === d[1] && p.px[i + 2] === d[2]) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return x1 > x0 ? [x0, y0, x1, y1] : null;
};
/** The oracle and MIRAGE cropped to [x0, y0, x1, y1], side by side, then what differs; and how much does. */
const compare = (a, b, box) => {
  const [x0, y0, x1, y1] = box, W = x1 - x0, H = y1 - y0, G = 8, OW = 3 * W + 2 * G, out = new Uint8Array(OW * H * 3).fill(255);
  let diff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ia = 3 * ((y0 + y) * a.w + x0 + x), ib = 3 * ((y0 + y) * b.w + x0 + x), same = a.px[ia] === b.px[ib] && a.px[ia + 1] === b.px[ib + 1] && a.px[ia + 2] === b.px[ib + 2];
    for (let k = 0; k < 3; k++) { out[3 * (y * OW + x) + k] = a.px[ia + k]; out[3 * (y * OW + W + G + x) + k] = b.px[ib + k]; }
    const g = (a.px[ia] + a.px[ia + 1] + a.px[ia + 2]) / 12 + 160 | 0, o = 3 * (y * OW + 2 * (W + G) + x);
    if (same) { out[o] = out[o + 1] = out[o + 2] = g; } else { diff++; out[o] = 230; out[o + 1] = 30; out[o + 2] = 30; }
  }
  return { rgb: out, w: OW, h: H, diff: diff / (W * H) };
};

// ---- MIRAGE ------------------------------------------------------------------------------------------
const fontDir = join(OUT, 'fonts');
const fonts = async () => {
  const reg = join(fontDir, 'arial.ttf'), bold = join(fontDir, 'arial-bold.ttf');
  if (!existsSync(reg)) { mkdirSync(fontDir, { recursive: true }); const f = await pageFonts(['Arial'], (s) => console.error(s), false); writeFileSync(reg, f.arial); writeFileSync(bold, f['arial:bold']); }
  return `arial=${reg},arial:bold=${bold}`;
};
const mirage = async (name) => {
  const prefix = join(OUT, `${name}-m`), env = { ...process.env, MIRAGE_W32SHOTS: '3', MIRAGE_W32SHOTPREFIX: prefix, MIRAGE_W32DIR: DIR, MIRAGE_W32SECS: '4', MIRAGE_W32FONTS: await fonts() };
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/win32/run.mjs'), join(DIR, `${name}.exe`)], { env, encoding: 'utf8' });
  const file = `${prefix}-3s.png`;
  if (!existsSync(file)) { console.error(`${name}: MIRAGE drew nothing\n${(r.stderr || '').split('\n').filter((l) => /mirage-win32|Error/.test(l)).slice(0, 6).join('\n')}`); return null; }
  return readPNG(file);
};

// ---- the oracle: Windows 2000 in QEMU ---------------------------------------------------------------
const monitor = async () => {
  const s = createConnection(PORT, '127.0.0.1'); await new Promise((r, e) => { s.once('connect', r); s.once('error', e); }); s.on('data', () => {});
  const cmd = async (c) => { s.write(c + '\n'); await sleep(0.15); };
  const KEY = { ' ': 'spc', '.': 'dot', '\\': 'backslash', ':': 'shift-semicolon', '-': 'minus', '_': 'shift-minus', '/': 'slash' };
  const type = async (t) => { for (const c of t) await cmd(`sendkey ${KEY[c] || (c >= 'A' && c <= 'Z' ? `shift-${c.toLowerCase()}` : c)}`); };
  return { cmd, type, close: () => s.end() };
};
const oracle = async () => {
  if (!existsSync(ISO)) throw new Error(`${ISO}: none -- sh tools/win32/samples/build.sh`);
  const qemu = spawn(process.env.QEMU || 'qemu-system-i386', ['-m', '256', '-snapshot', '-drive', `file=${WIN2K},format=raw,if=ide,index=0`, '-cdrom', ISO,
    '-vga', 'std', '-display', 'none', '-monitor', `tcp:127.0.0.1:${PORT},server,nowait`, '-rtc', 'base=localtime', '-net', 'none'], { stdio: 'ignore' });
  await sleep(2); const m = await monitor();
  console.error(`win2k: booting (${BOOT} s)`); await sleep(BOOT);
  await m.cmd('sendkey alt-f4'); await sleep(1);                    // v86's welcome window
  await m.cmd('mouse_move 1000 700'); await sleep(1);
  const desk = join(OUT, 'desktop-win2k.ppm'); await m.cmd(`screendump ${desk}`); await sleep(1.5);
  const base = readPPM(desk);                                       // the desktop with nothing on it: what a sample adds
  const shot = async (name) => {
    await m.cmd('sendkey meta_l-r'); await sleep(2); await m.type(`D:\\${name}.exe`); await m.cmd('sendkey ret'); await sleep(6);
    const f = join(OUT, `${name}-win2k.ppm`); await m.cmd(`screendump ${f}`); await sleep(1.5);
    await sleep(6);                                                   // it ends itself (ten seconds)
    return readPPM(f);
  };
  return { shot, base, done: () => { m.close(); qemu.kill(); } };
};

const o = await oracle();
try {
  for (const name of names) {
    const a = await o.shot(name), b = await mirage(name);
    writePNG(join(OUT, `${name}-win2k.png`), a.px, a.w, a.h, 1);
    if (!b) continue;
    const ea = extent(a, o.base) || extent(b), eb = extent(b) || ea;
    const box = [Math.min(ea[0], eb[0]), Math.min(ea[1], eb[1]), Math.max(ea[2], eb[2]), Math.max(ea[3], eb[3])].map((v, i) => Math.max(0, Math.min(i & 1 ? a.h : a.w, v + (i < 2 ? -8 : 8))));
    const c = compare(a, b, box); writePNG(join(OUT, `${name}.png`), c.rgb, c.w, c.h, 1);
    console.log(`${name}: ${(100 * c.diff).toFixed(1)}% of ${box[2] - box[0]}x${box[3] - box[1]} differ -> ${join(OUT, `${name}.png`)}`);
  }
} finally { o.done(); }
