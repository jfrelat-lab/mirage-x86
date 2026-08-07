// run-game.mjs — mount a game directory into the VFS and run one of its programs headless,
// reporting the video mode, device state, framebuffer occupancy and any text on screen.
// Useful for diagnosing "what mode did it set / why is the screen wrong" without a browser.
//
//   node tools/run-game.mjs <gameSubdir> <PROG.EXE> [frames=200] [keys=hex,hex,...]
//   e.g. node tools/run-game.mjs COSMO CATALOG.EXE 150
//        node tools/run-game.mjs ALLEYCAT CAT.EXE 300 39,b9        (space make+break)

import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';

const [sub, prog, framesArg, keysArg] = process.argv.slice(2);
if (!sub || !prog) { console.error('usage: node tools/run-game.mjs <subdir> <PROG.EXE> [frames] [keysHexCSV]'); process.exit(2); }
const FRAMES = Number(framesArg) || 200;
const KEYS = keysArg ? keysArg.split(',').map(h => parseInt(h, 16)) : [];

const ROOT = new URL('../games/', import.meta.url).pathname;
const gameDir = join(ROOT, sub);

// Composed like the browser (16 MiB, ROM fonts, INT 33h mouse) — see harness.mjs for why each of
// those mattered. MEM_MB forces a deliberately memory-starved run.
const vfs = new VFS();
const { mc, dos } = makeMachine({ vfs, memSize: process.env.MEM_MB ? Number(process.env.MEM_MB) << 20 : undefined });
let fault = null; mc.onError = (e) => { fault = e; };

// mount every file under games/<sub> into \GAMES\<sub>\...
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(ROOT, p).split('/').join('\\');
      vfs.addFile('\\GAMES\\' + rel, new Uint8Array(readFileSync(p)));
    }
  }
}
walk(gameDir);
vfs.chdir('\\GAMES\\' + sub);

const exeBytes = readFileSync(join(gameDir, prog));
const tail = process.env.RUNTAIL || '';           // command-line args (e.g. RUNTAIL="ENG VGA ADL")
dos.load(new Uint8Array(exeBytes), tail, 'C:\\GAMES\\' + sub + '\\' + prog);

const fb = mc.mem.u8;
const modeAt = () => mc.mem.r8(0x449);
const snap = [];
let fedKeys = false;
for (let t = 0; t < FRAMES && !fault && !dos.programDone; t++) {
  // once things are running a bit, feed the keys (to advance a title screen)
  if (!fedKeys && t === Math.min(60, FRAMES >> 1) && KEYS.length && mc.pushScancodes) { mc.pushScancodes(KEYS); fedKeys = true; }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  mc.runSlice(200000);
  mc.tickTimer();
  if (t % 40 === 0) snap.push({ t, mode: modeAt().toString(16), planar: !!mc.mem.planar, cga: mc.bios.cga && {...mc.bios.cga} });
}

const count = (a, b) => { let n = 0; for (let i = a; i < b; i++) if (fb[i]) n++; return n; };
const planes = mc.vga && mc.vga.planes;
let planarNz = 0; if (planes) for (let i = 0; i < planes.length; i++) if (planes[i]) planarNz++;

console.log('=== ' + sub + '\\' + prog + ' ===');
console.log('final mode(0x449):', modeAt().toString(16), 'planar:', !!mc.mem.planar, 'cga:', JSON.stringify(mc.bios.cga));
console.log('fault:', fault && (fault.message || String(fault)), 'programDone:', dos.programDone, 'halted:', mc.cpu.halted);
console.log('framebuffer nonzero — A000(13h):', count(0xa0000, 0xa0000 + 64000), ' B800(text/cga):', count(0xb8000, 0xb8000 + 0x4000), ' planes:', planarNz);
console.log('mode timeline:', JSON.stringify(snap));

// dump B800 text (80x25) in case it printed an error
let lines = [];
for (let row = 0; row < 25; row++) {
  let s = '';
  for (let col = 0; col < 80; col++) { const ch = fb[0xb8000 + (row*80+col)*2]; s += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : ' '; }
  s = s.replace(/\s+$/, ''); if (s) lines.push(row.toString().padStart(2) + ': ' + s);
}
if (lines.length) { console.log('--- B800 text ---'); console.log(lines.join('\n')); }
