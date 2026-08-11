// test386-cosim.mjs — MIRAGE side of a PROTECTED-MODE co-sim against Unicorn.
//
// Why this exists. Diagnosing test386's POST 20 by hand meant walking the call stack backwards one
// hop per hypothesis, and seven of those hypotheses were wrong. A differential replaces the whole
// method: run the same instructions in MIRAGE and in Unicorn (QEMU's core, which passes this test)
// and report the FIRST instruction where they disagree. One forward comparison instead of N
// backward guesses.
//
// Unlike the DOS-program co-sim next door, there is no BIOS or DOS to reconcile: test386 IS the
// whole system. It touches exactly two ports (0x190 POST, 0x92 A20) plus stray reads, so Unicorn
// only needs those hooked. The hard part is protected mode — the snapshot has to carry GDTR/IDTR/
// LDTR/TR, CR0 and CR3, or Unicorn resolves selectors against a different world.
//
//   node tools/cosim/test386-cosim.mjs boot/test386.bin       # -> /tmp/t386-snap.bin + -mirage.json
//   POST=0x20 STEPS=20000 node tools/cosim/test386-cosim.mjs  # snapshot at a POST code, step N
//   python3 tools/cosim/uc-test386.py                          # -> /tmp/t386-uc.json
//   node tools/cosim/cosim-diff.mjs /tmp/t386-mirage.json /tmp/t386-uc.json

import { readFileSync, writeFileSync } from 'fs';
import { Machine } from '../../src/machine.js';

const path = process.argv[2] || 'boot/test386.bin';
const SNAP_AT = Number(process.env.POST || 0x20);      // snapshot when this POST code is written
const STEPS = Number(process.env.STEPS || 20000);      // instructions to trace after the snapshot
const rom = new Uint8Array(readFileSync(path));

const mc = new Machine({ memSize: 16 << 20 });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };
mc.mem.blit(0x100000 - rom.length, rom);

const ports = [];                                       // every port event, for Unicorn to replay
let snapped = false;
mc.onPortWrite(0x190, (_p, _s, v) => { if ((v & 0xff) === SNAP_AT && !snapped) snapNow(); });
mc.onPortRead(0x190, () => 0xff);
mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.MM = mc.mem.mask; mc.rec.reset(); });
mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));
// Record what every port read returned, so Unicorn returns the identical value at the identical
// step. A differential is only meaningful if the environment is byte-identical on both sides.
const origIoRead = cpu.ioRead;
cpu.ioRead = (p, s) => { const v = origIoRead(p, s); if (snapped) ports.push({ p, s, v }); return v; };

let snap = null, snapMem = null;
function snapNow() {
  snapped = true;
  snap = {
    reg: [...cpu.reg], seg: [...cpu.seg], base: [...cpu.base], limit: [...cpu.limit],
    eip: cpu.eip >>> 0, flags: cpu.flags >>> 0, csD: cpu.csD, ssB: cpu.ssB,
    cr0: cpu.cr0 >>> 0, cr2: cpu.cr2 >>> 0, cr3: cpu.cr3 >>> 0,
    gdtr: { ...cpu.gdtr }, idtr: { ...cpu.idtr }, ldtr: { ...cpu.ldtr }, tr: { ...cpu.tr },
    a20: mc.mem.a20,
  };
  snapMem = Buffer.from(mc.mem.u8);                              // physical RAM, exactly as-is
  writeFileSync('/tmp/t386-snap.bin', snapMem);
  // Stop the machine here. The run loop only notices between blocks, so a few instructions still
  // retire past this point — which is why phase 2 RESTORES the snapshot rather than continuing from
  // wherever the loop happened to stop. Snapshot and live state must be the same state, or the
  // differential compares two different runs.
  cpu.halted = true;
}

// Phase 1: run until the snapshot point.
const t0 = Date.now();
let blocks = 0;
while (!snapped && blocks < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 60_000) blocks += mc.runSlice(20000);
if (!snapped) { console.error(`POST 0x${SNAP_AT.toString(16)} never reached`); process.exit(2); }

// Restore exactly the snapshot: memory, registers, and the protected-mode control state.
mc.mem.u8.set(snapMem);
cpu.reg.set(snap.reg); cpu.seg.set(snap.seg); cpu.base.set(snap.base); cpu.limit.set(snap.limit);
cpu.eip = snap.eip; cpu.flags = snap.flags; cpu.csD = snap.csD; cpu.ssB = snap.ssB;
cpu.cr0 = snap.cr0; cpu.cr2 = snap.cr2; cpu.cr3 = snap.cr3;
Object.assign(cpu.gdtr, snap.gdtr); Object.assign(cpu.idtr, snap.idtr);
Object.assign(cpu.ldtr, snap.ldtr); Object.assign(cpu.tr, snap.tr);
mc.mem.setA20(snap.a20); mc.mem.rebuildPageTables(); mc.rec.reset();
cpu.halted = false; fault = null;

// Phase 2: single-step, recording one entry per instruction. translate(...,1) is the same
// one-instruction path the Trap Flag uses, so nothing is fused and each step is comparable.
const trace = [];
for (let i = 0; i < STEPS && !cpu.halted && !fault; i++) {
  const lin = (cpu.base[1] + (cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff))) >>> 0;
  const ip0 = cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff);
  // A 128-byte window under SS:ESP travels with every step. Unicorn cannot deliver an exception to
  // the guest IDT, so the co-sim resynchronises it from MIRAGE at each fault — and a handler that
  // inspects its own exception frame (which is the whole point of test386) needs that frame to be
  // present, not just the registers.
  const sp = (cpu.base[2] + (cpu.ssB ? (cpu.reg[4] >>> 0) : (cpu.reg[4] & 0xffff))) >>> 0;
  const stkAt = (sp - 32) >>> 0, stk = [];
  for (let k = 0; k < 128; k++) stk.push(mc.mem.r8((stkAt + k) >>> 0));
  trace.push({ cs: cpu.seg[1], eip: cpu.eip >>> 0, r: [...cpu.reg], f: cpu.flags >>> 0, s: [...cpu.seg],
    b: [...cpu.base], stkAt, stk });
  let blk;
  try { blk = mc.rec.translate(lin, ip0, 1); blk.fn(cpu, blk); cpu.cycles += blk.count; }
  catch (e) { trace.push({ err: String(e.message || e) }); break; }
}
writeFileSync('/tmp/t386-mirage.json', JSON.stringify({ snap, ports, trace }));
console.log(`snapshot at POST 0x${SNAP_AT.toString(16)}: CS=0x${snap.seg[1].toString(16)} EIP=0x${snap.eip.toString(16)} ` +
  `CR0=0x${snap.cr0.toString(16)} CR3=0x${snap.cr3.toString(16)} PE=${snap.cr0 & 1} PG=${(snap.cr0 >>> 31) & 1}`);
console.log(`  GDTR base=0x${snap.gdtr.base.toString(16)} limit=0x${snap.gdtr.limit.toString(16)}  ` +
  `IDTR base=0x${snap.idtr.base.toString(16)} limit=0x${snap.idtr.limit.toString(16)}`);
console.log(`traced ${trace.length} instructions -> /tmp/t386-mirage.json (+ /tmp/t386-snap.bin, 16 MiB)`);
