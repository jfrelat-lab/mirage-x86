// t386-probe.mjs — instrument ONE instruction of the test386 snapshot.
//
// The co-sim narrows a failure to a single step; this says what the engine actually did there,
// instead of inferring it from the register delta. Every wrong hypothesis in the POST 20
// investigation came from reading a delta and guessing the mechanism, so this wraps the mechanisms
// themselves: cpu.raise, machine.protInt, and the block the recompiler emitted.
//
//   node tools/cosim/t386-probe.mjs [step] [count]     # default: the step the diff reported

import { readFileSync } from 'fs';
import { Machine } from '../../src/machine.js';

const STEP = Number(process.argv[2] || 176);
const COUNT = Number(process.argv[3] || 2);
const mir = JSON.parse(readFileSync('/tmp/t386-mirage.json', 'utf8'));
const snapMem = readFileSync('/tmp/t386-snap.bin');
const snap = mir.snap;

const mc = new Machine({ memSize: 16 << 20 });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };
mc.onPortRead(0x190, () => 0xff); mc.onPortWrite(0x190, () => {});
mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));
mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.MM = mc.mem.mask; mc.rec.reset(); });

mc.mem.u8.set(snapMem);
cpu.reg.set(snap.reg); cpu.seg.set(snap.seg); cpu.base.set(snap.base); cpu.limit.set(snap.limit);
cpu.eip = snap.eip; cpu.flags = snap.flags; cpu.csD = snap.csD; cpu.ssB = snap.ssB;
cpu.cr0 = snap.cr0; cpu.cr2 = snap.cr2; cpu.cr3 = snap.cr3;
Object.assign(cpu.gdtr, snap.gdtr); Object.assign(cpu.idtr, snap.idtr);
Object.assign(cpu.ldtr, snap.ldtr); Object.assign(cpu.tr, snap.tr);
mc.mem.setA20(snap.a20); mc.mem.rebuildPageTables(); mc.rec.reset();
cpu.halted = false;

const h = (n, w = 8) => (n >>> 0).toString(16).padStart(w, '0');
const step = () => {
  const lin = (cpu.base[1] + (cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff))) >>> 0;
  const ip0 = cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff);
  const blk = mc.rec.translate(lin, ip0, 1);
  blk.fn(cpu, blk); cpu.cycles += blk.count;
  return blk;
};

for (let i = 0; i < STEP && !cpu.halted && !fault; i++) step();

console.log(`au pas ${STEP} : CS=${h(cpu.seg[1], 4)} EIP=${h(cpu.eip)} CPL=${cpu.seg[1] & 3} ` +
  `IOPL=${(cpu.flags >>> 12) & 3} ESP=${h(cpu.reg[4])} CR0=${h(cpu.cr0)}`);

// Wrap the two paths an exception can take, so a silent no-op is distinguishable from a delivery
// that landed somewhere unexpected — the register delta alone cannot tell those apart.
// Read the IDT AS IT IS NOW, not as it was in the snapshot: test386 rewrites its own vectors, so a
// gate read from the snapshot file describes a state hundreds of instructions stale.
{
  const a = (cpu.idtr.base + 13 * 8) >>> 0;
  const off = mc.mem.r16(a) | (mc.mem.r16(a + 6) << 16), sel = mc.mem.r16(a + 2), acc = mc.mem.r8(a + 5);
  console.log(`  IDT[13] maintenant -> ${h(sel, 4)}:${h(off)} type=0x${(acc & 0x1f).toString(16)} DPL=${(acc >> 5) & 3} P=${(acc >> 7) & 1}`);
}

// The TSS I/O permission bitmap decides IN/OUT at CPL > IOPL. A bit of 0 permits the port; a bitmap
// that starts beyond the TSS limit denies everything.
{
  const tb = cpu.tr.base >>> 0, tl = cpu.tr.limit >>> 0;
  const iomap = mc.mem.r16((tb + 0x66) >>> 0);
  const port = 0x64;
  const byteOff = iomap + (port >> 3);
  const inLimit = byteOff <= tl;
  const bit = inLimit ? ((mc.mem.r8((tb + byteOff) >>> 0) >> (port & 7)) & 1) : 1;
  console.log(`  TSS base=${h(tb)} limit=${h(tl, 4)}  base carte E/S=${h(iomap, 4)}  ` +
    `octet ${h(byteOff, 4)} ${inLimit ? 'dans' : 'HORS'} limite  -> port 0x64 ${bit ? 'INTERDIT' : 'AUTORISE'}`);
}

const origRaise = cpu.raise;
cpu.raise = (v, err) => { console.log(`  -> cpu.raise(${v}, ${err})`); return origRaise.call(cpu, v, err); };
if (mc.protInt) {
  const origProt = mc.protInt.bind(mc);
  mc.protInt = (n, err) => { console.log(`  -> protInt(${n}, ${err})`); return origProt(n, err); };
}

for (let i = 0; i < COUNT && !cpu.halted && !fault; i++) {
  const lin = (cpu.base[1] + (cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff))) >>> 0;
  const bytes = [...mc.mem.u8.subarray(mc.mem.xlat ? mc.mem.xlat(lin) : lin, (mc.mem.xlat ? mc.mem.xlat(lin) : lin) + 8)];
  console.log(`pas ${STEP + i}: ${h(cpu.seg[1], 4)}:${h(cpu.eip)}  octets ${bytes.map((b) => h(b, 2)).join(' ')}`);
  const blk = step();
  console.log(`   -> ${h(cpu.seg[1], 4)}:${h(cpu.eip)}  ESP=${h(cpu.reg[4])}  IF=${(cpu.flags >>> 9) & 1}  ` +
    `(bloc: ${blk.count} instr, ${blk.len ?? '?'} octets)`);
  console.log(`   source emise:\n${String(blk.src || blk.body || '(non conservee)').split('\n').map((l) => '     ' + l).join('\n')}`);
}
if (fault) console.log(`faute machine: ${fault.message}`);
