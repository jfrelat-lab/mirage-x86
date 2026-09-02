// test-x86-uc.mjs — check MIRAGE's instruction semantics against a Unicorn-captured reference.
//
//   node tools/test-x86-uc.mjs              # gate: compare against the committed expectations
//   node tools/test-x86-uc.mjs --capture    # regenerate them (needs python3 + `pip install unicorn`)
//
// Why: `conformance.js` runs real-8088 silicon vectors but is 16-bit-only, so it cannot see the
// 386 forms (0x66/0x67, SIB, 32-bit registers) — the class that produced the 0x67 bug. Unicorn is
// QEMU's TCG core: a far better oracle for those than hand-derived expectations, and unlike DOSBox
// it has no DOS layer of its own to disagree about.
//
// The captured reference is committed (like golden-baseline.json), so the gate needs neither
// Python nor Unicorn — those are only required to add or refresh a case.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { CASES as HAND, SCRATCH_PATTERN } from './x86-cases.mjs';
import { generateCases } from './x86-gen.mjs';
import { SSE_CASES, X87_CMP_CASES, X87_CMOV_CASES } from './x86-sse-cases.mjs';
import { X87_CASES } from './x87-cases.mjs';
import { X87_STACK_CASES } from './x87-stack-cases.mjs';
import { DE_CASES } from './x86-de-cases.mjs';

// The hand-written cases encode intent (each one is a regression lock with a comment); the generated
// ones enumerate the ModRM/SIB/prefix grid mechanically, because the 0x67 bug lived in a corner
// nobody thought to write a case for. Both go through the same oracle.
// The SSE cases end by storing XMM back into the scratch, which is how an oracle that never reads
// XMM still checks it — see x86-sse-cases.mjs.
const CASES = [...HAND, ...generateCases(), ...SSE_CASES, ...X87_CMP_CASES, ...X87_CMOV_CASES, ...X87_CASES, ...X87_STACK_CASES, ...DE_CASES];

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED = join(HERE, 'x86-uc-expected.json');
const CS = 0x1000, DS = 0x2000, SS = 0x3000, SCRATCH = 256, FLAGMASK = 0x8d5;
const GP = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];   // MIRAGE reg[] order

/** Run one case in MIRAGE from the same initial state the oracle used. */
function runMirage(c) {
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  for (let i = 0; i < SCRATCH; i++) mem.w8((DS << 4) + i, SCRATCH_PATTERN(i));
  // Append HLT: rec.step() runs a whole basic BLOCK, so without a terminator it keeps decoding the
  // zeros after the case (as ADD [BX+SI],AL) — clobbering flags and scribbling over the scratch.
  mem.blit(CS << 4, Uint8Array.from([...c.code, 0xf4]));
  cpu.setSeg(1, CS); cpu.setSeg(3, DS); cpu.setSeg(0, DS); cpu.setSeg(2, SS);
  for (let i = 0; i < 8; i++) cpu.reg[i] = (c.regs && c.regs[GP[i]]) || 0;
  if (!c.regs || c.regs.esp === undefined) cpu.reg[4] = 0x1000;
  cpu.flags = 0x2 | (c.flags || 0);
  cpu.eip = 0;
  // Execute exactly the bytes of the case (one block; REP loops run to completion inside it).
  const raised = [];
  const swInt = mc.swInt.bind(mc);
  mc.swInt = (n, ...rest) => { raised.push(n); mc.cpu.halted = true; return undefined; };
  let guard = 0;
  while (!cpu.halted && guard++ < 4096) mc.rec.step();   // sequences may loop
  const mems = []; for (let i = 0; i < SCRATCH; i++) mems.push(mem.r8((DS << 4) + i));
  const regs = {}; for (let i = 0; i < 8; i++) regs[GP[i]] = cpu.reg[i] >>> 0;
  return { regs, flags: cpu.flags & FLAGMASK, mem: mems, raised };
}

if (process.argv.includes('--capture')) {
  const inFile = '/tmp/x86-cases.json', outFile = '/tmp/x86-expected.json';
  writeFileSync(inFile, JSON.stringify(CASES));
  console.log(execFileSync('python3', [join(HERE, 'uc-capture.py'), inFile, outFile]).toString().trim());
  const got = JSON.parse(readFileSync(outFile, 'utf8'));
  writeFileSync(EXPECTED, JSON.stringify(got));
  console.log(`wrote ${got.length} expectations → ${EXPECTED}`);
  process.exit(0);
}

if (!existsSync(EXPECTED)) { console.error('no expectations yet — run: node tools/test-x86-uc.mjs --capture'); process.exit(2); }
const want = JSON.parse(readFileSync(EXPECTED, 'utf8'));
if (want.length !== CASES.length) { console.error(`case count changed (${CASES.length} vs ${want.length}) — re-run --capture`); process.exit(2); }

let pass = 0, faultChecked = 0, oracleSkips = 0; const fails = [], tol = [];
const F64 = new DataView(new ArrayBuffer(8)), I64 = new BigInt64Array(1), F64B = new Float64Array(I64.buffer);
const asF64 = (mem, off) => { for (let k = 0; k < 8; k++) F64.setUint8(k, mem[off + k]); return F64.getFloat64(0, true); };
const ulpDiff = (a, b, off) => {
  const x = asF64(a, off), y = asF64(b, off);
  if (x === y) return 0;
  if (Number.isNaN(x) !== Number.isNaN(y) || !Number.isFinite(x) !== !Number.isFinite(y)) return Infinity;
  F64B[0] = x; const bx = I64[0]; F64B[0] = y; const by = I64[0];
  return Number(bx > by ? bx - by : by - bx);
};
const hex = (n, w = 8) => (n >>> 0).toString(16).padStart(w, '0');
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i], w = want[i];
  // A case that declares `fault` EXPECTS the oracle to have raised an exception — Unicorn reports a
  // #DE to the embedder rather than dispatching it — and expects MIRAGE to raise the same vector.
  // Without this arm those cases land in the `w.error` skip below and pass without running.
  if (c.fault !== undefined) {
    const oracleFaulted = !!(w.error && /EXCEPTION/i.test(w.error));
    const g = runMirage(c);
    const ours = g.raised.includes(c.fault);
    if (oracleFaulted && ours) { pass++; faultChecked++; continue; }
    fails.push(`${c.n}: oracle ${oracleFaulted ? 'a faute' : "n'a PAS faute"}, mirage ${ours ? 'a leve INT ' + c.fault : "n'a rien leve"}`);
    continue;
  }
  if (w.error) { pass++; oracleSkips++; continue; }            // the oracle itself faulted — skip
  const g = runMirage(c);
  const diffs = [];
  for (const r of GP) if (g.regs[r] !== w.regs[r]) diffs.push(`${r}=${hex(g.regs[r])} want ${hex(w.regs[r])}`);
  const mask = FLAGMASK & ~(c.undef || 0);                 // ignore architecturally-undefined flags
  if ((g.flags & mask) !== (w.flags & mask)) diffs.push(`flags=${hex(g.flags & mask, 3)} want ${hex(w.flags & mask, 3)}`);
  // MIRAGE holds the x87 stack as float64; silicon and QEMU use 80-bit extended and round on the
  // store, so a transcendental can land an ulp away with nothing wrong. `fp` declares which qword
  // slots are floating-point results and how many ulps that case is allowed — anything outside a
  // declared slot, or beyond its budget, still fails. Tolerated cases are counted and printed, so
  // the allowance cannot quietly grow.
  // `skip` declares byte ranges that CANNOT match by construction — FNSTENV writes the address of
  // the last x87 instruction, which MIRAGE does not model. Declared per case and listed below, so
  // it is visible rather than an invisible hole in the comparison.
  const skips = c.skip || [];
  const skipped = (k) => skips.some((sk) => k >= sk.off && k < sk.off + sk.len);
  const slots = c.fp ? (Array.isArray(c.fp) ? c.fp : [c.fp]) : [];
  const inSlot = (k) => slots.find((sl) => k >= sl.off && k < sl.off + 8);
  let tolerated = false;
  for (let k = 0; k < SCRATCH; k++) {
    if (g.mem[k] === w.mem[k] || skipped(k)) continue;
    const sl = inSlot(k);
    if (!sl) { diffs.push(`mem[${k}]=${hex(g.mem[k], 2)} want ${hex(w.mem[k], 2)}`); break; }
    const d = ulpDiff(g.mem, w.mem, sl.off);
    if (d > sl.ulp) { diffs.push(`mem[${sl.off}] ecart ${d} ulp > ${sl.ulp} tolere`); break; }
    tolerated = true;
    k = sl.off + 7;                                        // this slot is accounted for
  }
  if (tolerated && !diffs.length) tol.push(`${c.n} (${slots.map((sl) => ulpDiff(g.mem, w.mem, sl.off) + ' ulp').join(', ')})`);
  if (diffs.length) fails.push(`${c.n}: ${diffs.join(', ')}`); else pass++;
}

console.log(`\nmirage vs unicorn: ${pass} passed, ${fails.length} failed`);
console.log(`  ${faultChecked} cas de faute verifies des DEUX cotes, ${oracleSkips} cas sautes (oracle en erreur)`);
const skipCount = CASES.filter((x) => x.skip).length;
if (skipCount) console.log(`  ${skipCount} cas avec des octets declares non comparables (pointeur d'instruction FNSTENV)`);
if (tol.length) { console.log(`  ${tol.length} tolerees (float64 vs 80 bits):`); for (const t of tol) console.log('    ~ ' + t); }
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('all green ✓');
