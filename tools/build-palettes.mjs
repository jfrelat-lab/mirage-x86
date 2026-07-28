// build-palettes.mjs — GRAPHICAL palette extraction from the reference (DOSBox-X), not source code.
// Runs tools/palettedump.asm headless: it sets mode 13h (BIOS loads the default VGA DAC) and dumps
// all 256 DAC entries. We write assets/vga-default-dac.bin (768 bytes, 6-bit R,G,B) and verify it
// matches MIRAGE's baked default DAC. The first 16 entries are the CGA/EGA 16-colour palette that
// text/EGA/CGA modes use. Rebuild: node tools/build-palettes.mjs (needs dosbox-x + nasm).
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NASM = '/opt/homebrew/bin/nasm', DOSBOX = '/opt/homebrew/bin/dosbox-x';

const work = mkdtempSync(join(tmpdir(), 'pd-'));
let dac;
try {
  execSync(`${NASM} -f bin -o "${join(work, 'PALDUMP.COM')}" "${join(HERE, 'palettedump.asm')}"`, { stdio: 'inherit' });
  writeFileSync(join(work, 'db.conf'),
    `[sdl]\noutput=surface\nautolock=false\n[dosbox]\nmachine=svga_s3\nlogfile=\n[cpu]\ncore=normal\ncputype=pentium\ncycles=max\n[autoexec]\nmount c ${work}\nc:\nPALDUMP.COM\n`);
  try { execSync(`SDL_VIDEODRIVER=dummy perl -e 'alarm 8; exec @ARGV' ${DOSBOX} -conf "${join(work, 'db.conf')}" -exit`, { stdio: 'ignore', timeout: 15000 }); }
  catch { /* alarm kills DOSBox — expected */ }
  const p = join(work, 'DAC.BIN');
  if (!existsSync(p) || statSync(p).size < 768) throw new Error('DAC.BIN missing/short');
  dac = new Uint8Array(readFileSync(p)).subarray(0, 768);
} finally { rmSync(work, { recursive: true, force: true }); }

writeFileSync(join(ROOT, 'assets/vga-default-dac.bin'), dac);
console.log('wrote assets/vga-default-dac.bin (768 bytes, 6-bit)');

// verify against MIRAGE's baked default DAC (set mode 13h -> bios.dac)
const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); installDOS(mc, new VFS());
mc.cpu.ax = 0x0013; mc.swInt(0x10);   // set mode 13h -> defaultPalette loads bios.dac
const baked = mc.bios.dac;
let diffs = 0, first = -1;
for (let i = 0; i < 768; i++) if ((dac[i] & 63) !== (baked[i] & 63)) { diffs++; if (first < 0) first = i; }
console.log(diffs === 0 ? 'MATCH: extracted DAC == baked VGA_DEFAULT_DAC (byte-exact, 6-bit)'
  : `DIFF: ${diffs}/768 entries differ (first at byte ${first}: extracted ${dac[first]&63} vs baked ${baked[first]&63})`);
// show the 16 CGA/EGA colours (entries 0-15) as RGB 0-255
console.log('16-colour palette (entries 0-15), RGB 0-255:');
for (let i = 0; i < 16; i++) { const r = Math.round((dac[i*3]&63)*255/63), g = Math.round((dac[i*3+1]&63)*255/63), b = Math.round((dac[i*3+2]&63)*255/63); console.log('  ', i.toString().padStart(2), `#${[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')}`); }
