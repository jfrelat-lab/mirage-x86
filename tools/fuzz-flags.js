// fuzz-flags.js — differential fuzzer for the dead-flag-elimination pass.
//
//   node tools/fuzz-flags.js [iterations] [seed]
//
// The dead-flag pass strips flag computations it proves dead within a basic block. A wrong
// def/use annotation (a flag reader not marked as using a flag) can strip a live producer —
// a corruption that is INVISIBLE to the SingleStepTests harness, because that runs one
// instruction at a time and a single-instruction block never strips (live-out = all flags).
//
// This exploits exactly that asymmetry as an oracle: run the same random straight-line block
// two ways in one process —
//   A) rec.run() over a cached MULTI-instruction block  → stripping ACTIVE
//   B) rec.stepOne() one instruction at a time           → stripping never happens
// — from identical random initial state, then compare all registers and the arithmetic
// flags. Any divergence isolates a stripping bug and prints a reproducer (bytes + seed).

import { Machine } from '../src/machine.js';
import { CS, DS, ES, SS } from '../src/cpu.js';

const ITERS = Number(process.argv[2]) || 200000;
let seed = (Number(process.argv[3]) || 0x1234abcd) >>> 0;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const r8 = () => rnd() & 0xff, r16 = () => rnd() & 0xffff, pick = (a) => a[rnd() % a.length];

const FLAGMASK = 0x8d5;   // CF|PF|AF|ZF|SF|OF — the flags these instructions touch

// Instruction templates → bytes. Producers set flags; consumers make a flag observable in a
// register (SETcc/ADC/SBB/RCL/RCR/DAA/LAHF/PUSHF+POP); transparent ops move data around.
const PRODUCERS = [
  () => [0x05, r8(), r8()],  () => [0x2d, r8(), r8()],  () => [0x25, r8(), r8()],   // ADD/SUB/AND AX,imm16
  () => [0x0d, r8(), r8()],  () => [0x35, r8(), r8()],  () => [0x3d, r8(), r8()],   // OR/XOR/CMP AX,imm16
  () => [0xa9, r8(), r8()],  () => [0x04, r8()],        () => [0x2c, r8()],         // TEST AX,imm16 / ADD,SUB AL,imm8
  () => [0x40 + (rnd() & 7)], () => [0x48 + (rnd() & 7)],                           // INC/DEC reg16
  () => [0x01, 0xc0 | (rnd() & 0x3f)], () => [0x29, 0xc0 | (rnd() & 0x3f)],         // ADD/SUB r/m16,r16
  () => [0x21, 0xc0 | (rnd() & 0x3f)], () => [0x09, 0xc0 | (rnd() & 0x3f)],         // AND/OR r/m16,r16
  () => [0xc1, 0xe0 | (rnd() & 7), (rnd() & 7) + 1], () => [0xc1, 0xe8 | (rnd() & 7), (rnd() & 7) + 1], // SHL/SHR r16,imm
  () => [0xc1, 0xf8 | (rnd() & 7), (rnd() & 7) + 1], () => [0xd1, 0xe0 | (rnd() & 7)],                  // SAR r16,imm / SHL r16,1
  () => [0xf7, 0xe0 | (rnd() & 7)], () => [0xf7, 0xe8 | (rnd() & 7)], () => [0xf7, 0xd8 | (rnd() & 7)], // MUL/IMUL/NEG r16
  () => [0xf9], () => [0xf8],                                                        // STC / CLC
];
const CONSUMERS = [
  () => [0x81, 0xd0 | (rnd() & 7), r8(), r8()],   // ADC r16,imm16 (reads CF)
  () => [0x81, 0xd8 | (rnd() & 7), r8(), r8()],   // SBB r16,imm16 (reads CF)
  () => [0x0f, 0x90 | (rnd() & 0xf), 0xc0 | (rnd() & 7)],  // SETcc r8 (reads flags)
  () => [0xd1, 0xd0 | (rnd() & 7)], () => [0xd1, 0xd8 | (rnd() & 7)],  // RCL/RCR r16,1 (read CF)
  () => [0x27], () => [0x2f], () => [0x37], () => [0x3f],   // DAA/DAS/AAA/AAS (read CF/AF)
  () => [0x9f], () => [0x9c, 0x5b], () => [0xf5],           // LAHF / PUSHF+POP BX / CMC
];
const TRANSPARENT = [
  () => [0xb8 | (rnd() & 7), r8(), r8()],   // MOV reg16,imm16
  () => [0x89, 0xc0 | (rnd() & 0x3f)],      // MOV r/m16,r16
  () => [0x90], () => [0x91 + (rnd() & 6)], // NOP / XCHG AX,reg
  () => [0x50 + (rnd() & 7)], () => [0x58 + (rnd() & 7)],  // PUSH/POP reg16
];
const POOL = [...PRODUCERS, ...PRODUCERS, ...CONSUMERS, ...TRANSPARENT];  // bias toward flag ops

function makeBlock() {
  const n = 3 + (rnd() % 8), bytes = [];
  for (let i = 0; i < n; i++) bytes.push(...pick(POOL)());
  bytes.push(0xf4);  // HLT
  return bytes;
}

function fresh(bytes, init) {
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.setSeg(DS, 0x200); cpu.setSeg(ES, 0x200); cpu.setSeg(SS, 0x300);
  cpu.eip = 0; cpu.sp = 0x1000;
  for (let i = 0; i < 8; i++) cpu.reg[i] = init.reg[i];
  cpu.reg[4] = (cpu.reg[4] & ~0xffff) | 0x1000;   // stable SP
  cpu.flags = init.flags;
  mc.mem.blit(0x1000, Uint8Array.from(bytes));
  return mc;
}

function stateOf(mc) {
  const cpu = mc.cpu, s = [];
  for (let i = 0; i < 8; i++) s.push(cpu.reg[i] >>> 0);
  s.push(cpu.flags & FLAGMASK);
  return s;
}

let bad = 0;
const startSeed = seed;
for (let it = 0; it < ITERS && bad < 5; it++) {
  const bytes = makeBlock();
  const init = { reg: Array.from({ length: 8 }, () => r16()), flags: (r16() & FLAGMASK) | 2 };

  const A = fresh(bytes, init); let fa = null; A.onError = (e) => { fa = e; };  // stripping ON  (rec.run)
  const B = fresh(bytes, init); let fb = null; B.onError = (e) => { fb = e; };  // stripping OFF (stepOne)
  try { A.runSlice(2000); } catch { continue; }
  try { for (let k = 0; k < 2000 && !B.cpu.halted; k++) B.rec.stepOne(); } catch { continue; }
  if (fa || fb) continue;   // a faulting/unimplemented block — skip (not a strip concern)

  const sa = stateOf(A), sb = stateOf(B);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) {
    bad++;
    const names = ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI', 'FLAGS'];
    console.log(`MISMATCH #${bad}  ${names[i]}: strip=0x${sa[i].toString(16)} nostrip=0x${sb[i].toString(16)}`);
    console.log(`  bytes: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`  init : regs=[${init.reg.map((x) => x.toString(16)).join(',')}] flags=0x${init.flags.toString(16)}`);
    break;
  }
}
console.log(`\nfuzz-flags: ${ITERS} blocks, seed 0x${startSeed.toString(16)} — ${bad ? bad + ' MISMATCH(es)' : 'strip == no-strip on all'}`);
process.exit(bad ? 1 : 0);
