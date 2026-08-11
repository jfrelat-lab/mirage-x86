// t386-diff.mjs — first disagreement between the MIRAGE and Unicorn protected-mode traces.
//
// Unicorn is QEMU's core and PASSES test386, so any disagreement is ours. This reports the FIRST
// instruction where the two states differ, which replaces walking the failure backwards one
// hypothesis at a time (seven of those were wrong before this tool existed).
//
//   node tools/cosim/test386-cosim.mjs boot/test386.bin
//   python3 tools/cosim/uc-test386.py
//   node tools/cosim/t386-diff.mjs [mirage.json] [uc.json]
//
// Two deliberate narrowings, both because the difference is in the OBSERVER, not the CPU:
//   * only the arithmetic flags are compared. The two model different subsets of the system bits
//     (NT, IOPL, resume) and a mismatch there is not evidence of a defect.
//   * Unicorn's trace has already collapsed REP iterations (see uc-test386.py), so both sides are
//     one entry per retired instruction.

import { readFileSync } from 'fs';

const A = process.argv[2] || '/tmp/t386-mirage.json';
const B = process.argv[3] || '/tmp/t386-uc.json';
const M = JSON.parse(readFileSync(A, 'utf8')).trace;
const U = JSON.parse(readFileSync(B, 'utf8')).trace;

const h = (n, w = 8) => (n >>> 0).toString(16).padStart(w, '0');
const RN = ['EAX', 'ECX', 'EDX', 'EBX', 'ESP', 'EBP', 'ESI', 'EDI'];
const SN = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'];
const FLAGS = 0x8d5;                        // CF PF AF ZF SF OF

const N = Math.min(M.length, U.length);
console.log(`MIRAGE ${M.length} pas, Unicorn ${U.length} pas -> ${N} comparés`);

const at = (t, i) => `${h(t[i].cs, 4)}:${h(t[i].eip)}`;

for (let i = 0; i < N; i++) {
  const m = M[i], u = U[i];
  if (!m || m.err || !u) break;
  const d = [];
  if (m.cs !== u.cs) d.push(`CS   M=${h(m.cs, 4)} U=${h(u.cs, 4)}`);
  if ((m.eip >>> 0) !== (u.eip >>> 0)) d.push(`EIP  M=${h(m.eip)} U=${h(u.eip)}`);
  for (let k = 0; k < 8; k++) {
    if ((m.r[k] >>> 0) !== (u.r[k] >>> 0)) d.push(`${RN[k]}  M=${h(m.r[k])} U=${h(u.r[k])}`);
  }
  for (let k = 0; k < 6; k++) {
    if (k !== 1 && m.s[k] !== u.s[k]) d.push(`${SN[k]}   M=${h(m.s[k], 4)} U=${h(u.s[k], 4)}`);
  }
  if ((m.f & FLAGS) !== (u.f & FLAGS)) d.push(`FLAGS M=${h(m.f & FLAGS, 3)} U=${h(u.f & FLAGS, 3)}`);
  if (!d.length) continue;

  console.log(`\nPREMIERE DIVERGENCE au pas ${i}`);
  for (const x of d) console.log(`   ${x}`);
  // The state compared at step i is the state AFTER step i-1, so the culprit is the instruction
  // recorded at i-1 — not the one at i, which has not run yet.
  if (i > 0) console.log(`\n instruction fautive = pas ${i - 1} : ${at(M, i - 1)}`);
  const from = Math.max(0, i - 6);
  console.log(` MIRAGE  ${M.slice(from, i + 1).map((_, j) => at(M, from + j)).join(' -> ')}`);
  console.log(` UNICORN ${U.slice(from, i + 1).map((_, j) => at(U, from + j)).join(' -> ')}`);
  process.exit(1);
}

console.log(`AUCUNE divergence sur ${N} pas — dernier commun ${at(M, N - 1)}`);
