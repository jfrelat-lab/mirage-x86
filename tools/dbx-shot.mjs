// dbx-shot.mjs — what DOSBox-X's VGA actually shows for a DOS program, as PNG frames.
//
//   node tools/dbx-shot.mjs <prog.com|dir> <seconds> <outPrefix> [at=1,5,10] [tail]
//   PROG=NAME.EXE for a directory; DBXCYCLES (default "fixed 20000"), DBXMACHINE (default svga_s3),
//   DBXCPUTYPE (DOSBox-X's cputype, e.g. pentium_mmx or ppro_slow; its default otherwise).
//
// The other DOSBox-X paths in this repo read guest MEMORY (tools/grabber.asm, egaref.mjs): the
// framebuffer bytes and the DAC, laid out by our own idea of the mode. That cannot tell how the card
// displays them — the CRTC's display end, blanking, line doubling. `DX-CAPTURE /V` records the frames
// DOSBox-X's VGA renders, from the host side, with nothing installed in the guest; tools/zmbv.mjs
// (from PRISM, the sibling project) decodes the ZMBV video. Helium is the case that needed it: QEMU's
// screendump shows 288 pixels across, DOSBox-X 252 — the CRTC blanks the last 36, and QEMU ignores it.
//
// Frames are written at their own size: a 32 bpp capture (svga_s3, vgaonly) doubles every VGA pixel
// both ways, mode 13h comes out 640x400. `at` lists seconds of the capture (its frame rate, ~70 Hz).
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { zmbvFrames } from './zmbv.mjs';
import { writePNG } from './frame.mjs';

const [target, secsArg, prefix, atArg = '1,5,10', tail = ''] = process.argv.slice(2);
if (!target || !prefix) { console.error('usage: node tools/dbx-shot.mjs <prog|dir> <seconds> <outPrefix> [at=1,5,10] [tail]'); process.exit(2); }
const SECS = Number(secsArg) || 10, AT = atArg.split(',').map(Number);

const work = mkdtempSync(join(tmpdir(), 'dbxshot-'));
mkdirSync(join(work, 'c')); mkdirSync(join(work, 'cap'));
let prog;
if (statSync(target).isDirectory()) {
  const copyTree = (src, dst) => {               // subdirectories too: a game keeps its data in them
    for (const f of readdirSync(src)) {
      const from = join(src, f), to = join(dst, f);
      if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); copyTree(from, to); } else copyFileSync(from, to);
    }
  };
  copyTree(target, join(work, 'c'));
  prog = process.env.PROG;
  if (!prog) { console.error('a directory needs PROG=<NAME.EXE>'); process.exit(2); }
} else { prog = basename(target); copyFileSync(target, join(work, 'c', prog)); }

const r = spawnSync('/bin/sh', ['-c', `ulimit -t ${SECS * 4 + 60}; exec dosbox-x -silent -nogui -nomenu -time-limit ${SECS} ` +
  `-set "dosbox captures=${join(work, 'cap')}" -set "dosbox machine=${process.env.DBXMACHINE || 'svga_s3'}" ` +
  `-set "cpu cycles=${process.env.DBXCYCLES || 'fixed 20000'}" -set "speaker pcspeaker=false" ` +
  (process.env.DBXCPUTYPE ? `-set "cpu cputype=${process.env.DBXCPUTYPE}" ` : '') +
  `-c "mount c ${join(work, 'c')}" -c c: -c "dx-capture /v ${prog}${tail ? ' ' + tail : ''}" -c exit`],
{ encoding: 'utf8', env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
const avis = readdirSync(join(work, 'cap')).filter((f) => f.endsWith('.avi')).sort();
if (!avis.length) { console.error('no capture', r.stderr || ''); process.exit(1); }

// The capture's frame rate, from the AVI main header (microseconds per frame).
const first = readFileSync(join(work, 'cap', avis[0]));
const usPerFrame = first.readUInt32LE(first.indexOf('avih') + 8) || 14286;
const want = new Map(AT.map((s) => [Math.round(s * 1e6 / usPerFrame), s]));
let n = 0;
const sizes = new Map();
for (const a of avis) {
  for (const f of zmbvFrames(readFileSync(join(work, 'cap', a)))) {
    const k = `${f.width}x${f.height}`; sizes.set(k, (sizes.get(k) || 0) + 1);
    const s = want.get(n++);
    if (s === undefined || !f.pix) continue;
    const rgb = new Uint8Array(f.width * f.height * 3);
    for (let i = 0; i < f.width * f.height; i++) {
      if (f.bpp === 8) { const c = f.pix[i] * 3; rgb[3 * i] = f.palette[c]; rgb[3 * i + 1] = f.palette[c + 1]; rgb[3 * i + 2] = f.palette[c + 2]; }
      else { rgb[3 * i] = f.pix[4 * i + 2]; rgb[3 * i + 1] = f.pix[4 * i + 1]; rgb[3 * i + 2] = f.pix[4 * i]; }
    }
    writePNG(`${prefix}-${s}s.png`, rgb, f.width, f.height, 1);
    console.log(`${prefix}-${s}s.png  ${f.width}x${f.height}`);
  }
}
console.log(`${n} frames at ${(1e6 / usPerFrame).toFixed(1)} Hz; sizes ${[...sizes].map(([k, v]) => `${k}:${v}`).join(' ')}`);
