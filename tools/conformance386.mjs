// conformance386.mjs — run the engine against SingleStepTests/80386 real-mode vectors.
//
//   node tools/conformance386.mjs            # a curated default set
//   node tools/conformance386.mjs 00 01 0FBA.4
//
// The sibling of conformance.js, and the reason it is a separate tool: those vectors are 8088
// silicon and 16-bit, so nothing in them exercises a 32-bit operand, an address-size prefix, or the
// 0F space. These are captured from an actual 80386EX over an Arduino interface, each test run twice
// and replayed to verify, so they are silicon too — just a generation later.
//
// Vectors are fetched on demand into tools/sst386/ (gitignored), same as conformance.js does.
// Real mode only: the protected-mode sets are announced but not published, and the reason is worth
// knowing — memory cannot simply be randomised there without triple-faulting on entry.

import { gunzipSync } from 'zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { parseMOO } from './moo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'sst386');
const BASE = 'https://raw.githubusercontent.com/SingleStepTests/80386/main/v1_ex_real_mode';

// A first slice aimed at the BLIND SPOT: the 8088 vectors cannot reach a 32-bit operand (0x66), a
// 32-bit address (0x67), the two combined, or the 0F space, and those are exactly the forms the
// engine has the least outside coverage for. 941 files are published; fetching them all is ~660 MB,
// so this is a representative cut. Pass names on the command line for any others.
const DEFAULT = [
  '00', '01', '02', '03', '38', '39', '88', '89', '8D',        // the 16-bit grid, as a control
  '6601', '6603', '6609', '660B', '6621', '6629', '6631', '6639', '663B',   // 32-bit operand ALU
  '66C1.4', '66C1.5', '66C1.7', '66D3.4', '66D3.5',            // 32-bit shifts
  '66F7.4', '66F7.5', '66F7.6', '66F7.7',                      // 32-bit mul/div
  '660FAF', '660FB6', '660FB7', '660FBE', '660FBF',            // IMUL r32, MOVZX/MOVSX
  '660FA4', '660FAC', '660FA3', '660FBB',                      // SHLD/SHRD, BT/BTC
  '6700', '6703', '670B', '6721', '6739', '678B', '678D',      // 32-bit ADDRESSING
  '6766C7', '67668B', '67668D', '676603', '676633',            // both prefixes at once
  'A4', 'A5', 'A6', 'A7', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF',  // string ops
  '66A5', '66A7', '66AB', '66AD', '66AF',                      // ...32-bit operand
  '67A4', '67A5', '67A6', '67A7', '67AA', '67AB', '67AC', '67AD', '67AE', '67AF',   // ...32-bit address
  '6766A5', '6766A7', '6766AB', '6766AD', '6766AF',            // ...both
  '27', '2F', '37', '3F', 'D4', 'D5', 'D6', 'D7', '98', '99',  // BCD, XLAT, sign extension
  '84', '85', '86', '87', '8F', '60', '61', '62', '68', '69', '6A', '6B',
  'E4', 'E5', 'E6', 'E7', 'EC', 'ED', 'EE', 'EF',              // port I/O
  'F5', 'F8', 'F9', 'FA', 'FB', 'FC', 'FD', '9B',              // flag ops
  '0F06', '0FA0', '0FA1', '0FA5', '0FAB', '0FAD', '0FB2', '0FB4', '0FB5', '0FBC', '0FBD',  // the 0F space
  '0F80', '0F84', '0F88', '0F8C', '0F90', '0F94', '0F98', '0F9C',   // long conditionals, SETcc
  '70', '74', '78', '7C', '90', '91', '96', '97',              // short conditionals, XCHG
  'B0', 'B4', 'B8', 'BC', '8C', '8E', '8F',                    // MOV imm, segment moves, POP r/m
  'C2', 'C3', 'C8', 'C9', 'CA', 'CB', 'CC', 'CD', 'CE', 'CF',  // control transfers and the stack frame
  'E8', 'E9', 'EA', 'EB', '9A', '9C', '9D',
  '66C2', '66C3', '66C8', '66C9', '66CA', '66CB', '66CF',      // ...32-bit operand
  '66E8', '66E9', '66EA', '66EB', '669A', '669C', '669D',
];
async function vectors(op) {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, `${op}.MOO`);
  if (!existsSync(f)) {
    const r = await fetch(`${BASE}/${op}.MOO.gz`);
    if (!r.ok) return null;
    writeFileSync(f, gunzipSync(Buffer.from(await r.arrayBuffer())));
  }
  return parseMOO(new Uint8Array(readFileSync(f)));
}

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
const ARITH = CF | PF | AF | ZF | SF | OF;

/** Flags the architecture leaves UNDEFINED for an opcode, so they are not compared — the same
 *  reasoning conformance.js applies to the 8088. These vectors come from silicon, so the "undefined"
 *  bits do have a value on THAT chip; comparing them would test which 386 the capture used, not
 *  whether we are right. Keyed on the opcode NAME so the 66/67 prefixes fall away with it. */
function undefMask(op) {
  const core = op.replace(/^(66|67)+/, '');
  if (/^F[67]\.[45]$/.test(core)) return SF | ZF | AF | PF;              // MUL / IMUL
  if (/^F[67]\.[67]$/.test(core)) return ARITH;                          // DIV / IDIV
  if (/^(C0|C1|D0|D1|D2|D3)\./.test(core)) return AF | OF;               // shifts and rotates
  if (/^0FAF$/.test(core)) return SF | ZF | AF | PF;                     // IMUL r,r/m
  if (/^0F(A4|A5|AC|AD)$/.test(core)) return AF | OF;                    // SHLD / SHRD
  if (/^0F(A3|AB|B3|BB)$/.test(core)) return OF | SF | ZF | AF | PF;     // BT / BTS / BTR / BTC
  if (/^0F(BC|BD)$/.test(core)) return CF | OF | SF | AF | PF;           // BSF / BSR — only ZF is defined
  if (/^(27|2F)$/.test(core)) return OF;                                // DAA / DAS
  if (/^(37|3F)$/.test(core)) return OF | SF | ZF | PF;                 // AAA / AAS
  if (/^(D4|D5)$/.test(core)) return OF | AF | CF;                      // AAM / AAD
  if (/^(69|6B)$/.test(core)) return SF | ZF | AF | PF;                 // IMUL r,r/m,imm
  return 0;
}

const R32 = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };
const SEG = { es: 0, cs: 1, ss: 2, ds: 3, fs: 4, gs: 5 };

function apply(cpu, r) {
  for (const [k, i] of Object.entries(R32)) if (k in r) cpu.reg[i] = r[k] >>> 0;
  for (const [k, i] of Object.entries(SEG)) if (k in r) cpu.setSeg(i, r[k] & 0xffff);
  if ('eip' in r) cpu.eip = r.eip >>> 0;
  if ('eflags' in r) cpu.flags = r.eflags >>> 0;
  if ('cr3' in r) cpu.cr3 = r.cr3 >>> 0;
}

async function runOp(op) {
  const m = await vectors(op);
  const arch = undefMask(op);
  const core = op.replace(/^(66|67)+/, '');
  const isShiftDouble = /^0F(A4|A5|AC|AD)$/.test(core);
  const clForm = /^0F(A5|AD)$/.test(core);
  const opBits = /^66/.test(op) ? 32 : 16;
  if (!m) return { op, missing: true };
  const mc = new Machine({ memSize: 16 << 20, cpu: '386' });
  mc.mem.setA20(true); mc.rec.MM = mc.mem.mask; mc.rec.reset();
  const cpu = mc.cpu, u8 = mc.mem.u8, mask = mc.mem.mask;
  let pass = 0, regFail = 0, ramFail = 0, threw = 0, skipped = 0;
  const ex = [];
  for (const t of m.tests) {
    if (!t.initial || !t.final) { skipped++; continue; }
    if (t.exception) { skipped++; continue; }        // exception cases need the IVT the capture used
    // SHLD/SHRD with a masked count LARGER than the operand size: the architecture leaves the result
    // undefined, so the vector records what this 80386EX happened to produce rather than something to
    // conform to — and unlike the undefined FLAGS, no mask accompanies it. Verified before skipping:
    // every count at or below the operand size matches the ordinary formula exactly.
    if (isShiftDouble) {
      const b = t.bytes; let k = 0; while (b[k] === 0x66 || b[k] === 0x67 || b[k] === 0x2e || b[k] === 0x36 ||
        b[k] === 0x3e || b[k] === 0x26 || b[k] === 0x64 || b[k] === 0x65) k++;
      const cl = clForm ? ((t.initial.regs32.ecx >>> 0) & 0xff) : b[b.length - 2];
      if ((cl & 31) > opBits) { skipped++; continue; }
    }
    apply(cpu, t.initial.regs32);
    for (const [a, v] of t.initial.ram) u8[a & mask] = v;
    cpu.halted = false;
    // The byte stream is the instruction under test FOLLOWED BY A HLT, and the captured final state
    // is taken after that HLT retires — so the expected EIP is one past it. Step once for the
    // instruction (a REP is one step here), then once more for the HLT, and only if EIP is actually
    // sitting on it: a long `rep stos` can overwrite its own terminator, and "step until halted" then
    // runs whatever follows and drifts the registers. That is what the last handful of string-op
    // failures were — the engine was right and the harness kept going.
    // The capture terminates each test with a HLT and reports the state AFTER it retires — so the
    // expected EIP is one past it. The HLT sits wherever execution ARRIVES, which for a CALL, RET or
    // IRET is the branch target, not the next address: keying on "initial eip + length" works for
    // straight-line code and reports every control transfer as an off-by-one on EIP.
    // Look for it under CS:EIP instead. If it is not there, either a long `rep stos` wrote over its
    // own terminator or the transfer landed somewhere without one; the capture's CPU then ran
    // whatever was there, so its final state describes an arbitrary continuation and there is nothing
    // to conform to. Skip those, as conformance.js skips its own untestable cases.
    try {
      mc.rec.stepOne();
      if (!cpu.halted) {
        const at = (((cpu.base[1] >>> 0) + (cpu.eip >>> 0)) & mask) >>> 0;
        if (u8[at] !== 0xf4) { skipped++; continue; }
        mc.rec.stepOne();
      }
    } catch (e) { threw++; if (ex.length < 3) ex.push(`${t.name}: ${e.message}`); continue; }
    const want = { ...t.initial.regs32, ...t.final.regs32 };
    let ok = true, why = '';
    for (const [k, i] of Object.entries(R32)) {
      if (!(k in want)) continue;
      if ((cpu.reg[i] >>> 0) !== (want[k] >>> 0)) { ok = false; why = `${k}=${(cpu.reg[i] >>> 0).toString(16)} veut ${(want[k] >>> 0).toString(16)}`; break; }
    }
    if (ok && 'eip' in want && (cpu.eip >>> 0) !== (want.eip >>> 0)) { ok = false; why = `eip=${(cpu.eip >>> 0).toString(16)} veut ${(want.eip >>> 0).toString(16)}`; }
    if (ok && 'eflags' in want) {
      // The test's own mask names the bits it leaves undefined for this opcode.
      const um = (((t.final.mask32 && t.final.mask32.eflags) || 0) | arch) >>> 0;
      const got = (cpu.flags >>> 0) & ~um, exp = (want.eflags >>> 0) & ~um;
      if ((got & 0xfd5) !== (exp & 0xfd5)) { ok = false; why = `flags=${got.toString(16)} veut ${exp.toString(16)}`; }
    }
    if (!ok) { regFail++; if (ex.length < 3) ex.push(`${t.name}: ${why}`); continue; }
    let ramOk = true;
    for (const [a, v] of t.final.ram) if (u8[a & mask] !== v) { ramOk = false; if (ex.length < 3) ex.push(`${t.name}: [${a.toString(16)}]=${u8[a & mask].toString(16)} veut ${v.toString(16)}`); break; }
    if (!ramOk) { ramFail++; continue; }
    pass++;
  }
  return { op, pass, regFail, ramFail, threw, skipped, total: m.tests.length, ex };
}

const ops = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
let P = 0, T = 0;
for (const op of ops) {
  const r = await runOp(op);
  if (r.missing) { console.log(`${op}: pas de vecteurs`); continue; }
  P += r.pass; T += r.total - r.skipped;
  const bad = r.regFail + r.ramFail + r.threw;
  console.log(`${op}: ${r.pass}/${r.total - r.skipped}` +
    (bad ? `  regs=${r.regFail} ram=${r.ramFail} exc=${r.threw}` : '  ✓') +
    (r.skipped ? `  (${r.skipped} ignores)` : ''));
  for (const e of r.ex) console.log('    ' + e.slice(0, 120));
}
console.log(`\nTOTAL 386: ${P}/${T} (${T ? (P * 100 / T).toFixed(2) : 0}%)`);
