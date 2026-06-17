// run-com.js — load and run an arbitrary DOS .COM/.EXE through the engine for a
// fixed budget, then report what happened: video mode, framebuffer coverage,
// colours, whether it terminated, and — crucially — any fault (e.g. an
// unimplemented opcode), which is exactly the signal we want when probing real
// third-party programs.
//
//   node tools/run-com.js <path-to-program> [blockBudget]

import { readFileSync } from 'fs';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const path = process.argv[2];
const budget = Number(process.argv[3]) || 4_000_000;
if (!path) { console.error('usage: node tools/run-com.js <program> [budget]'); process.exit(2); }

const mc = new Machine({ memSize: 1 << 20 });
installBIOS(mc);
const dos = installDOS(mc, new VFS());
let fault = null;
mc.onError = (e) => { fault = e; };

const bytes = new Uint8Array(readFileSync(path));
dos.load(bytes, '', 'C:\\PROG');

const wallMs = Number(process.argv[4]) || 6000;     // wall-clock guard
const t0 = Date.now();
let ran = 0, ticks = 0, blocked = 0;
while (ran < budget && !dos.programDone && !fault) {
  ran += mc.runSlice(50000);
  mc.tickTimer(); ticks++;            // drive INT 1Ch + BDA tick so timers advance
  if (mc.blocked) blocked++;
  if (Date.now() - t0 > wallMs) break;
}

const mode = mc.mem.r8(0x449);
const base = mode === 0x13 ? 0xa0000 : 0xb8000;
const span = mode === 0x13 ? 64000 : 4000;
const colours = new Set(); let nonzero = 0;
for (let i = 0; i < span; i++) { const p = mc.mem.u8[base + i]; if (p) nonzero++; colours.add(p); }

console.log(`program:    ${path} (${bytes.length} bytes)`);
console.log(`blocks run: ${ran.toLocaleString()} (${ticks} timer ticks)${dos.programDone ? ' (terminated)' : blocked ? ' (waited on input)' : ''}`);
console.log(`video mode: 0x${mode.toString(16)}`);
console.log(`framebuffer: ${nonzero}/${span} non-zero, ${colours.size} distinct colours`);
if (fault) { console.log(`FAULT: ${fault.message}`); process.exit(1); }
else console.log('no fault ✓');
