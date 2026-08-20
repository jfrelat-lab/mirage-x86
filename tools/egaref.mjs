// egaref.mjs — capture a whole GAME's EGA/VGA planar frame from real DOSBox-X, as a reference.
//
//   node tools/egaref.mjs <gameSubdir> <PROG.EXE> [ticks] [out.png] [tail]
//   KEYS="-w 8 enter" drives DOSBox-X's AUTOTYPE, the only scriptable way in: its screenshot is a
//   host hotkey (F12+P) with no command and no config trigger, so the grabber stays the dump path.
//
// dosdiff.js covers one self-contained mode-13h program. Most of the corpus is neither: a multi-file
// game in a 16-colour planar mode. The whole game directory is copied beside the grabber, which goes
// resident, chains INT 8, and dumps the four planes plus the state needed to lay them out.
//
// Composed through tools/frame.mjs, the same code tools/shot.mjs uses on our side — so a difference
// in the picture is a difference in the DATA, not in two renderers disagreeing.

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { composePlanar, writePNG } from './frame.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const NASM = '/opt/homebrew/bin/nasm', DOSBOX = '/opt/homebrew/bin/dosbox-x';
const [sub, prog, ticksArg, outArg, tail] = process.argv.slice(2);
const KEYS = process.env.KEYS || '';   // e.g. "-w 8 enter" — see AUTOTYPE /?
if (!sub || !prog) { console.error('usage: node tools/egaref.mjs <subdir> <PROG.EXE> [ticks] [out.png] [tail]'); process.exit(2); }
const K = Number(ticksArg) || 60;
const out = outArg || `/tmp/${sub}-dosbox.png`;

const work = mkdtempSync(join(tmpdir(), 'egaref-'));
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const n of readdirSync(src)) {
    const s = join(src, n), d = join(dst, n);
    if (statSync(s).isDirectory()) copyTree(s, d); else copyFileSync(s, d);
  }
};
copyTree(join(ROOT, 'games', sub), work);
execFileSync(NASM, ['-f', 'bin', `-dKTICKS=${K}`, join(HERE, 'grabber-ega.asm'), '-o', join(work, 'GREGA.COM')]);

writeFileSync(join(work, 'dbx.conf'),
  `[sdl]\noutput=surface\nautolock=false\n[log]\nlogfile=\n[dosbox]\nmachine=svga_s3\n[cpu]\ncore=normal\ncycles=fixed 20000\n` +
  `[autoexec]\nmount c ${work}\nc:\nGREGA.COM\n${KEYS ? `AUTOTYPE ${KEYS}\n` : ''}${prog}${tail ? ' ' + tail : ''}\n`);

// DOSBox never exits on its own here — the grabber halts the guest after K ticks — so kill it from
// outside once the files have appeared.
const child = execFileSync('/bin/sh', ['-c',
  `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy ${DOSBOX} -conf ${join(work, 'dbx.conf')} -nomenu -fastlaunch >/dev/null 2>&1 & ` +
  `p=$!; for i in $(seq 1 900); do [ -s ${join(work, 'INFO.BIN')} ] && break; sleep 1; done; sleep 1; kill -9 $p 2>/dev/null; wait $p 2>/dev/null; true`],
  { encoding: 'utf8' });

const need = ['EGA.BIN', 'PAL.BIN', 'INFO.BIN'].map((f) => join(work, f));
if (!need.every(existsSync)) { console.error(`pas de capture (le programme n a pas atteint ${K} ticks, ou il accroche INT 8)`); process.exit(1); }
const planes = new Uint8Array(readFileSync(need[0]));
const dac = new Uint8Array(readFileSync(need[1]));
const info = new Uint8Array(readFileSync(need[2]));
const mode = info[0], stride = (info[1] || 20) * 2, start = (info[2] << 8) | info[3];
const attr = info.slice(4, 20);
const PLANELEN = 8000;
if (planes.length < PLANELEN * 4) { console.error(`EGA.BIN tronque: ${planes.length} octets`); process.exit(1); }

writePNG(out, composePlanar(planes, PLANELEN, dac, attr, stride, start));
console.log(`${sub}/${prog} @ ${K} ticks — mode 0x${mode.toString(16)} stride=${stride} start=${start} -> ${out}`);
console.log(`  palette attributs: ${Array.from(attr).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
rmSync(work, { recursive: true, force: true });
