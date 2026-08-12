// dpmi-probe.mjs — what does a DOS-extended program actually ask a DPMI host for?
//
// Reconnaissance before implementation. The DPMI spec is large and most of it is never called; the
// requirements that matter are the ones a real client issues, in order. So: run the program, log
// every INT 2Fh multiplex query, every INT 31h function, and every INT 21h/other vector it reaches,
// and report where it stopped. The output is the work list.
//
//   node tools/dpmi-probe.mjs games/OMF OMF.EXE
//   FRAMES=400 node tools/dpmi-probe.mjs games/OMF OMF.EXE
//
// Nothing here implements DPMI. INT 2Fh AX=1687h deliberately keeps answering "no host", so this
// records the client's FIRST choice of path. Run it again after a host exists to see the path change.

import { readFileSync } from 'fs';
import { join } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';

const dir = process.argv[2] || 'games/OMF';
const prog = process.argv[3] || 'OMF.EXE';
const FRAMES = Number(process.env.FRAMES) || 300;
const h = (n, w = 4) => (n >>> 0).toString(16).padStart(w, '0');

const vfs = new VFS();
const mount = '\\' + dir.split('/').pop().toUpperCase() + '\\';
for (const rel of walk(dir)) {
  vfs.addFile(mount + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
}
vfs.chdir(mount.replace(/\\$/, ''));

const { mc, dos } = makeMachine({ vfs });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };

// Log the multiplex queries by NAME. 1687h is the DPMI host check; 1686h asks "am I already in
// protected mode"; 43xx is XMS, which we do answer.
const mux = new Map();
const MUX_NAMES = { 0x1686: 'DPMI: am I in protected mode?', 0x1687: 'DPMI: host present + entry point',
  0x4300: 'XMS installed?', 0x4310: 'XMS entry point', 0x1680: 'release timeslice' };
const seenOrder = [];
mc.hookInterrupt(0x2f, (c) => {
  const ax = c.ax;
  if (!mux.has(ax)) { mux.set(ax, 0); seenOrder.push(ax); }
  mux.set(ax, mux.get(ax) + 1);
});

// INT 31h is the DPMI service entry. Record AX in call order — the ORDER is the useful part, since
// a client's first few calls tell you which model it is using.
const dpmiCalls = new Map(); const dpmiOrder = [];
mc.hookInterrupt(0x31, (c) => {
  const ax = c.ax;
  if (!dpmiCalls.has(ax)) { dpmiCalls.set(ax, 0); dpmiOrder.push(ax); }
  dpmiCalls.set(ax, dpmiCalls.get(ax) + 1);
});

// The launcher chain is the first thing to verify: a DOS/4GW title is a small real-mode stub that
// EXECs the extender, which then loads the LE image. If EXEC never happens, nothing downstream can.
const execs = [];
const origInt21 = mc.intHandlers[0x21];
mc.intHandlers[0x21] = (c, m) => {
  if ((c.ax >> 8) === 0x4b) {
    let name = '', a = (c.seg[3] << 4) + (c.reg[2] & 0xffff);   // DS:DX = ASCIIZ path
    for (let i = 0; i < 80; i++) { const b = mc.mem.u8[(a + i) & 0xfffff]; if (!b) break; name += String.fromCharCode(b); }
    execs.push(`AL=${c.ax & 0xff} "${name}"`);
  }
  return origInt21(c, m);
};

try { dos.load(new Uint8Array(readFileSync(join(dir, prog))), '', 'C:' + mount + prog); }
catch (e) { console.error('chargement impossible: ' + e.message); process.exit(1); }

const t0 = Date.now();
let frames = 0;
for (; frames < FRAMES && !fault && !dos.programDone; frames++) {
  mc.runSlice(200000);
  mc.tickTimer();
  if (Date.now() - t0 > 20000) break;
}

console.log(`=== ${dir}/${prog} — ${frames} frames, ${(cpu.cycles / 1e6).toFixed(1)} Mcycles ===`);
console.log(`arret: ${fault ? 'FAUTE ' + fault.message : dos.programDone ? 'programme termine' : 'toujours en cours'}`);
console.log(`CS:EIP = ${h(cpu.seg[1])}:${h(cpu.eip, 8)}  CR0=${h(cpu.cr0, 8)} PE=${cpu.cr0 & 1}\n`);

console.log('INT 2Fh (multiplex) demandes:');
if (!seenOrder.length) console.log('  (aucun)');
for (const ax of seenOrder) console.log(`  AX=${h(ax)}  x${mux.get(ax)}   ${MUX_NAMES[ax] || ''}`);

console.log('\nINT 31h (services DPMI) demandes, dans l ordre:');
if (!dpmiOrder.length) console.log('  (aucun — le client n a pas pris le chemin DPMI)');
for (const ax of dpmiOrder) console.log(`  AX=${h(ax)}  x${dpmiCalls.get(ax)}`);

const ints = mc.unhandledIntReport();
console.log('\nEXEC (INT 21h AH=4Bh) tentes: ' + (execs.length ? execs.join(' | ') : '(aucun)'));
console.log('\nvecteurs INT non implementes: ' + (ints || '(aucun)'));
console.log('fonctions INT 21h non implementees: ' + (dos.unhandledFnReport().join(' ') || '(aucune)'));
