// conformance.js — run the engine against the TomHarte / SingleStepTests 8088
// vectors (10,000 cases per opcode). Each case provides a full initial machine
// state (registers, flags, RAM) and the expected final state after ONE
// instruction. We set the state, single-step, and compare registers + RAM
// strictly and flags masked by the flags that are *defined* for that opcode on
// the 8088 (mul/div/shift/BCD leave some flags officially undefined).
//
//   node tools/conformance.js                 # curated default set
//   node tools/conformance.js 00 01 27 2f     # specific opcodes (hex)
//
// Vector files are fetched on demand into tools/sst/ (gitignored).

import { gunzipSync } from 'zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { CS, DS, ES, SS } from '../src/cpu.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'sst');
const BASE = 'https://raw.githubusercontent.com/SingleStepTests/8088/main/v1';

// flag bits
const CFb = 0x01, PFb = 0x04, AFb = 0x10, ZFb = 0x40, SFb = 0x80, OFb = 0x800;
const REAL = 0xfd5;                       // the 9 real flag bits (exclude fixed 1,3,5,12-15)

// Group opcodes (80-83, D0-D3, F6/F7, FE) are split per modrm.reg in the vector
// set, e.g. "80.0". 186+ opcodes (C0/C1 shifts, 0F-prefixed, 60/61, 68-6B, C8/C9)
// are excluded: the 8088 silicon decodes them differently, so they aren't a fair
// comparison for our 186/286-targeted core.
const DEFAULT = [
  '00', '01', '08', '10', '18', '20', '28', '30', '38',     // ALU grid
  '40', '48', 'fe.0', 'fe.1',                                // inc/dec
  '84', '85', 'a8',                                          // test
  '88', '89', '8a', '8b', '86', '87',                        // mov / xchg
  '80.0', '80.5', '80.7', '81.5', '83.0',                    // group1 (ALU r/m, imm)
  'd0.0', 'd0.4', 'd0.5', 'd0.7', 'd1.4', 'd1.5', 'd2.4', 'd3.4', // shifts / rotates
  'f6.2', 'f6.3', 'f6.4', 'f6.5', 'f7.3', 'f7.4',            // not / neg / mul / imul
  '27', '2f', '37', '3f', 'd4', 'd5',                        // BCD
];

async function ensure(op) {
  op = op.toUpperCase();                          // vector files use uppercase hex names
  const fp = join(DIR, op + '.json.gz');
  if (existsSync(fp)) return fp;
  const res = await fetch(`${BASE}/${op}.json.gz`);
  if (!res.ok) throw new Error(`fetch ${op}: ${res.status}`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(fp, Buffer.from(await res.arrayBuffer()));
  return fp;
}

// flags the 8088 leaves UNDEFINED for a given opcode (so we don't compare them)
function ignoreMask(op, bytes) {
  const grp1 = (bytes[1] >> 3) & 7;
  if (op < 0x40 && (op & 7) < 6) { const g = op >> 3; return (g === 1 || g === 4 || g === 6) ? AFb : 0; }
  if (op >= 0x40 && op <= 0x4f) return 0;
  if (op === 0xfe) return 0;
  if (op === 0x84 || op === 0x85 || op === 0xa8 || op === 0xa9) return AFb;        // TEST
  if (op === 0x80 || op === 0x81 || op === 0x83) return (grp1 === 1 || grp1 === 4 || grp1 === 6) ? AFb : 0;
  if ((op >= 0xd0 && op <= 0xd3) || op === 0xc0 || op === 0xc1) return AFb | OFb;  // shifts/rotates
  if (op === 0x27 || op === 0x2f) return OFb;                                       // DAA/DAS
  if (op === 0x37 || op === 0x3f) return OFb | SFb | ZFb | PFb;                      // AAA/AAS
  if (op === 0xd4 || op === 0xd5) return OFb | AFb | CFb;                            // AAM/AAD
  if (op === 0xf6 || op === 0xf7) { if (grp1 <= 1) return AFb; if (grp1 === 4 || grp1 === 5) return SFb | ZFb | AFb | PFb; return 0; }
  return 0;                                                                          // MOV/XCHG/NOP etc.
}

// some cases exercise machinery we intentionally don't conformance-test here
function skip(op, bytes) {
  if ((op === 0xf6 || op === 0xf7) && ((bytes[1] >> 3) & 7) >= 6) return true;       // DIV/IDIV (#DE semantics)
  if (op === 0xd4 && bytes[bytes.length - 1] === 0) return true;                       // AAM by 0 → #DE (imm is last byte)
  return false;
}

const REGSET = (cpu, r) => {
  cpu.reg[0] = r.ax & 0xffff; cpu.reg[1] = r.cx & 0xffff; cpu.reg[2] = r.dx & 0xffff; cpu.reg[3] = r.bx & 0xffff;
  cpu.reg[4] = r.sp & 0xffff; cpu.reg[5] = r.bp & 0xffff; cpu.reg[6] = r.si & 0xffff; cpu.reg[7] = r.di & 0xffff;
  cpu.setSeg(CS, r.cs); cpu.setSeg(SS, r.ss); cpu.setSeg(DS, r.ds); cpu.setSeg(ES, r.es);
  cpu.eip = r.ip & 0xffff; cpu.flags = r.flags & 0xffff;
};
const REGGET = {
  ax: c => c.reg[0] & 0xffff, bx: c => c.reg[3] & 0xffff, cx: c => c.reg[1] & 0xffff, dx: c => c.reg[2] & 0xffff,
  sp: c => c.reg[4] & 0xffff, bp: c => c.reg[5] & 0xffff, si: c => c.reg[6] & 0xffff, di: c => c.reg[7] & 0xffff,
  cs: c => c.seg[1], ds: c => c.seg[3], es: c => c.seg[0], ss: c => c.seg[2], ip: c => c.eip & 0xffff,
};

function runOpcode(op, tests) {
  const mc = new Machine({ memSize: 1 << 20 });   // 1 MB → 8088 wrap at 1 MB
  const cpu = mc.cpu, u8 = mc.mem.u8, mask = mc.mem.mask;
  let pass = 0, hard = 0, flag = 0, skipped = 0;
  const opn = parseInt(op, 16);
  const examples = [];
  for (const t of tests) {
    if (skip(opn, t.bytes)) { skipped++; continue; }
    // variable shift by CL: the 286+ masks the count to 5 bits, the 8088 doesn't,
    // so counts >= 32 are a generation difference, not a bug — don't compare them.
    if ((opn === 0xd2 || opn === 0xd3) && (t.initial.regs.cx & 0xff) >= 32) { skipped++; continue; }
    REGSET(cpu, t.initial.regs);
    for (const [a, v] of t.initial.ram) u8[a & mask] = v;
    cpu.halted = false;
    try { mc.rec.stepOne(); } catch (e) { hard++; if (examples.length < 3) examples.push(`${t.name}: threw ${e.message}`); continue; }

    let okRegRam = true;
    for (const k in t.final.regs) {
      if (k === 'flags') continue;
      if (REGGET[k] && REGGET[k](cpu) !== (t.final.regs[k] & 0xffff)) { okRegRam = false; break; }
    }
    if (okRegRam) for (const [a, v] of t.final.ram) if (u8[a & mask] !== v) { okRegRam = false; break; }

    let okFlags = true;
    if ('flags' in t.final.regs) {
      const ign = ignoreMask(opn, t.bytes);
      okFlags = (((cpu.flags ^ t.final.regs.flags) & REAL & ~ign) === 0);
    }
    if (okRegRam && okFlags) pass++;
    else {
      if (!okRegRam) hard++; else flag++;
      if (examples.length < 3) examples.push(`${t.name}: ${okRegRam ? 'flags' : 'reg/ram'} mismatch (got flags ${(cpu.flags & REAL).toString(16)}, want ${(t.final.regs.flags & REAL).toString(16)})`);
    }
  }
  return { pass, hard, flag, skipped, total: tests.length, examples };
}

const ops = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
let gTotal = 0, gPass = 0, gHard = 0, gFlag = 0;
console.log(`Running SingleStepTests on ${ops.length} opcode(s)…\n`);
for (const op of ops) {
  let tests;
  try { tests = JSON.parse(gunzipSync(readFileSync(await ensure(op))).toString()); }
  catch (e) { console.log(`  ${op}: SKIP (${e.message})`); continue; }
  const r = runOpcode(op, tests);
  const denom = r.total - r.skipped;
  gTotal += denom; gPass += r.pass; gHard += r.hard; gFlag += r.flag;
  const pct = denom ? ((r.pass / denom) * 100).toFixed(1) : 'n/a';
  const tag = r.hard === 0 && r.flag === 0 ? '✓' : '✗';
  console.log(`  ${op}: ${r.pass}/${r.total - r.skipped} ${pct}%  ${tag}  ${r.hard ? 'reg/ram-fail=' + r.hard + ' ' : ''}${r.flag ? 'flag-fail=' + r.flag : ''}`);
  for (const ex of r.examples) console.log(`        · ${ex}`);
}
console.log(`\nTOTAL: ${gPass}/${gTotal} (${((gPass / gTotal) * 100).toFixed(2)}%)  reg/ram-fail=${gHard}  flag-fail=${gFlag}`);
process.exit(gHard + gFlag ? 1 : 0);
