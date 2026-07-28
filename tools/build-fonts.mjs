// build-fonts.mjs — GRAPHICAL font extraction from the reference emulator (DOSBox-X), not from any
// source code. Runs tools/fontdump.asm headless in DOSBox-X: it draws all 256 glyphs in modes
// 13h/10h/12h and dumps the framebuffer; here we reverse-engineer the 8x8 / 8x14 / 8x16 bitmaps
// from those rendered pixels and write assets/vga-rom-8x{8,14,16}.bin (256 glyphs, 1 byte/row,
// MSB = leftmost pixel — the layout src/bios.js + src/video.js expect).
//   node tools/build-fonts.mjs
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NASM = '/opt/homebrew/bin/nasm', DOSBOX = '/opt/homebrew/bin/dosbox-x';

const work = mkdtempSync(join(tmpdir(), 'fd-'));
try {
  execSync(`${NASM} -f bin -o "${join(work, 'FONTDUMP.COM')}" "${join(HERE, 'fontdump.asm')}"`, { stdio: 'inherit' });
  writeFileSync(join(work, 'db.conf'),
    `[sdl]\noutput=surface\nautolock=false\n[dosbox]\nmachine=svga_s3\nlogfile=\n[cpu]\ncore=normal\ncputype=pentium\ncycles=max\n[autoexec]\nmount c ${work}\nc:\nFONTDUMP.COM\n`);
  try { execSync(`SDL_VIDEODRIVER=dummy perl -e 'alarm 8; exec @ARGV' ${DOSBOX} -conf "${join(work, 'db.conf')}" -exit`, { stdio: 'ignore', timeout: 15000 }); }
  catch { /* alarm kills DOSBox — expected */ }

  const rd = (f, min) => { const p = join(work, f); if (!existsSync(p) || statSync(p).size < min) throw new Error(`${f} missing/short (${existsSync(p) ? statSync(p).size : 'none'})`); return new Uint8Array(readFileSync(p)); };
  const fb13 = rd('FONT13.BIN', 64000);   // 320x200 linear, 1 byte/pixel
  const fb10 = rd('FONT10.BIN', 28000);   // 640x350 plane 0, 80 bytes/row
  const fb12 = rd('FONT12.BIN', 38400);   // 640x480 plane 0, 80 bytes/row

  // 8x8 from the linear mode-13h framebuffer (threshold each pixel)
  const f8 = new Uint8Array(256 * 8);
  for (let c = 0; c < 256; c++) for (let r = 0; r < 8; r++) {
    let b = 0, X = (c & 15) * 8, Y = (c >> 4) * 8;
    for (let x = 0; x < 8; x++) if (fb13[(Y + r) * 320 + X + x]) b |= 0x80 >> x;
    f8[c * 8 + r] = b;
  }
  // 8x14 / 8x16 from plane 0: the byte at (row, col) IS the glyph row (colour 15 -> plane0 bit set)
  const planar = (fb, h) => { const out = new Uint8Array(256 * h); for (let c = 0; c < 256; c++) for (let r = 0; r < h; r++) out[c * h + r] = fb[((c >> 4) * h + r) * 80 + (c & 15)]; return out; };
  const f14 = planar(fb10, 14), f16 = planar(fb12, 16);

  writeFileSync(join(ROOT, 'assets/vga-rom-8x8.bin'), f8);
  writeFileSync(join(ROOT, 'assets/vga-rom-8x14.bin'), f14);
  writeFileSync(join(ROOT, 'assets/vga-rom-8x16.bin'), f16);
  console.log('wrote assets/vga-rom-8x8.bin (2048), 8x14.bin (3584), 8x16.bin (4096)');

  // sanity: render a few glyphs from each extracted font
  const show = (font, h, ch) => { let s = `  '${String.fromCharCode(ch)}' (${8}x${h}):\n`; for (let r = 0; r < h; r++) { let l = '    '; const b = font[ch * h + r]; for (let x = 0; x < 8; x++) l += (b & (0x80 >> x)) ? '#' : '.'; s += l + '\n'; } return s; };
  for (const [font, h] of [[f8, 8], [f14, 14], [f16, 16]]) { console.log(show(font, h, 0x41)); }
} finally { rmSync(work, { recursive: true, force: true }); }
