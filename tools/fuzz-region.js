// fuzz-region.js — differential fuzzer for the tier-2 region compiler.
//
//   node tools/fuzz-region.js [iterations] [seed]
//
// Forces MIRAGE_TIER2=1, then for each random LOOP program compares two executions in one
// process: rec.run() (which promotes the hot loop to a fused region) against rec.stepOne()
// one instruction at a time (which never promotes — the tier-1 reference). Identical final
// register/flag/memory state proves the region is semantics-identical to tier-1; any
// divergence prints a reproducer (bytes + seed).
//
// Programs are `mov cx,K; <body>; loop L; hlt`, K large enough that the loop block crosses
// T2_HOT and promotes mid-run. Bodies mix straight ALU/mem instructions with short forward
// conditional skips (jcc over a few bytes) so regions span multiple blocks, exercising the
// switch-in-loop edge rewiring. Faulting/runaway programs are skipped, not counted.

process.env.MIRAGE_TIER2 = '1';
const { Machine } = await import('../src/machine.js');
const { CS, DS, ES, SS } = await import('../src/cpu.js');

const ITERS = Number(process.argv[2]) || 100000;
let seed = (Number(process.argv[3]) || 0xc0ffee01) >>> 0;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const r8 = () => rnd() & 0xff, r16 = () => rnd() & 0xffff, pick = (a) => a[rnd() % a.length];
const FLAGMASK = 0x8d5;   // CF|PF|AF|ZF|SF|OF
const SCRATCH = 0x100, SCRATCHLEN = 64;   // memory window the body reads/writes (DS-relative)

// straight instructions (no control flow, no div/int). Register operands are restricted to
// AX/DX/BX/SI/DI (never CX — the loop counter — nor SP), so the body can't turn the loop
// infinite by clobbering CX. Direct [SCRATCH] memory ops included.
const SAFE = [0, 2, 3, 6, 7];   // reg indices excluding CX(1) and SP(4)
const sreg = () => SAFE[rnd() % 5];
const modrmRR = () => 0xc0 | (sreg() << 3) | sreg();
const STRAIGHT = [
  () => [0x05, r8(), r8()], () => [0x2d, r8(), r8()], () => [0x25, r8(), r8()], () => [0x0d, r8(), r8()],  // ALU AX,imm
  () => [0x35, r8(), r8()], () => [0x3d, r8(), r8()], () => [0x01, modrmRR()], () => [0x29, modrmRR()],    // XOR/CMP AX,imm; ADD/SUB r,r
  () => [0x40 + sreg()], () => [0x48 + sreg()], () => [0xf7, 0xe0 | sreg()], () => [0xf7, 0xd8 | sreg()],  // inc/dec/mul/neg
  () => [0xc1, 0xe0 | sreg(), (rnd() & 7) + 1], () => [0xc1, 0xe8 | sreg(), (rnd() & 7) + 1],               // shl/shr r,imm
  () => [0x81, 0xd0 | sreg(), r8(), r8()], () => [0x81, 0xd8 | sreg(), r8(), r8()],                         // adc/sbb r,imm
  () => [0xd1, 0xd0 | sreg()], () => [0x27], () => [0x9f],                                                  // rcl/daa/lahf
  () => [0xb8 | sreg(), r8(), r8()], () => [0x89, modrmRR()], () => [0x90],                                 // mov r,imm / mov r,r / nop
  () => [0xa1, SCRATCH & 0xff, SCRATCH >> 8], () => [0xa3, SCRATCH & 0xff, SCRATCH >> 8],                   // mov ax,[m] / mov [m],ax
  () => [0x03, 0x06, SCRATCH & 0xff, SCRATCH >> 8], () => [0x01, 0x06, SCRATCH & 0xff, SCRATCH >> 8],       // add ax,[m] / add [m],ax
];

function makeBody() {
  const units = [];
  const n = 3 + (rnd() % 7);
  for (let i = 0; i < n; i++) {
    if ((rnd() & 3) === 0) {                       // forward conditional skip → multi-block loop
      const skipped = [];
      const k = 1 + (rnd() % 3);
      for (let j = 0; j < k; j++) skipped.push(...pick(STRAIGHT)());
      units.push([0x70 | (rnd() & 0xf), skipped.length], skipped);   // jcc rel8 = bytes to skip
    } else units.push(pick(STRAIGHT)());
  }
  return units.flat();
}

function makeProgram() {
  let body;
  do { body = makeBody(); } while (body.length > 120);   // keep the loop rel8 in range
  const K = 90 + (rnd() % 220);                            // > T2_HOT so it promotes
  const rel = (-(body.length + 2)) & 0xff;                 // loop L → body start
  return [0xb9, K & 0xff, K >> 8, ...body, 0xe2, rel, 0xf4];
}

function fresh(bytes, init) {
  const mc = new Machine({ memSize: 1 << 20 });
  mc.timerAuto = false;   // region(runSlice) vs tier-1(stepOne) equivalence — exclude async PIT ticks
  const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.setSeg(DS, 0x200); cpu.setSeg(ES, 0x200); cpu.setSeg(SS, 0x300);
  cpu.eip = 0; cpu.sp = 0x1000;
  for (let i = 0; i < 8; i++) cpu.reg[i] = init.reg[i];
  cpu.reg[4] = (cpu.reg[4] & ~0xffff) | 0x1000;
  cpu.flags = init.flags;
  mc.mem.blit(0x1000, Uint8Array.from(bytes));
  for (let i = 0; i < SCRATCHLEN; i++) mc.mem.u8[0x2000 + SCRATCH + i] = init.mem[i];   // DS=0x200 → 0x2000
  return mc;
}

function stateOf(mc) {
  const cpu = mc.cpu, s = [];
  for (let i = 0; i < 8; i++) s.push(cpu.reg[i] >>> 0);
  s.push(cpu.flags & FLAGMASK);
  for (let i = 0; i < SCRATCHLEN; i++) s.push(mc.mem.u8[0x2000 + SCRATCH + i]);
  return s;
}

let bad = 0, ran = 0, regions = 0;
const startSeed = seed;
for (let it = 0; it < ITERS && bad < 5; it++) {
  const bytes = makeProgram();
  const init = { reg: Array.from({ length: 8 }, () => r16()), flags: (r16() & FLAGMASK) | 2, mem: Array.from({ length: SCRATCHLEN }, () => r8()) };

  const A = fresh(bytes, init); let fa = null; A.onError = (e) => { fa = e; };   // regions (rec.run)
  const B = fresh(bytes, init); let fb = null; B.onError = (e) => { fb = e; };   // reference (stepOne)
  let ok = true;
  try { for (let k = 0; k < 20 && !A.cpu.halted && !fa; k++) A.runSlice(20000); } catch { ok = false; }
  try { for (let k = 0; k < 200000 && !B.cpu.halted && !fb; k++) B.rec.stepOne(); } catch { ok = false; }
  if (!ok || fa || fb || !A.cpu.halted || !B.cpu.halted) continue;   // runaway/fault/didn't finish → skip
  ran++; if (A.rec.stats.t2compiles > 0) regions++;

  const sa = stateOf(A), sb = stateOf(B);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) {
    bad++;
    const where = i < 8 ? ['AX', 'CX', 'DX', 'BX', 'SP', 'BP', 'SI', 'DI'][i] : i === 8 ? 'FLAGS' : 'mem[' + (i - 9) + ']';
    console.log(`MISMATCH #${bad}  ${where}: region=0x${sa[i].toString(16)} tier1=0x${sb[i].toString(16)}  (t2compiles=${A.rec.stats.t2compiles})`);
    console.log(`  bytes: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`  init : regs=[${init.reg.map((x) => x.toString(16)).join(',')}] flags=0x${init.flags.toString(16)}`);
    break;
  }
}
console.log(`\nfuzz-region: ${ran} programs ran (${regions} formed a region), seed 0x${startSeed.toString(16)} — ${bad ? bad + ' MISMATCH(es)' : 'region == tier-1 on all'}`);
process.exit(bad ? 1 : 0);
