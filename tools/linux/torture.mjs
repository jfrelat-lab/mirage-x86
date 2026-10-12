// torture.mjs — gcc's execute torture tests as a conformance bench for MIRAGE-LINUX and the CPU.
//
//   node tools/linux/torture.mjs <dir> [name-filter]
//
// <dir> holds what the oracle run left (see "Building" below): bin/<test> (static i386 ELF),
// bin/<test>.out (its stdout+stderr under Docker's i386/debian) and oracle.txt ("<test> <status>"
// per line, or "<test> CC_FAIL" when gcc would not build it). Each test runs here once, in turn, and
// its exit status and output are compared with the oracle's. A test passes by exiting 0 and fails by
// calling abort() (SIGABRT, 134) — so a mismatch is almost always a wrong answer from our CPU or
// FPU, and the report groups them by what we returned.
//
// Building (the tests are GCC's, GPL, and are not kept in this repository): a sparse clone of
// gcc-mirror/gcc at releases/gcc-12.2.0, path gcc/testsuite/gcc.c-torture/execute, and in the
// mirage-i386-gcc image (i386/debian + gcc, musl-tools) for each test:
//   musl-gcc -static -O2 -w -march=pentiumpro -o bin/<t> <t>.c -lm; timeout 20 bin/<t> > bin/<t>.out 2>&1; echo "<t> $?"
//
// MIRAGE_TORTURE_CYCLES caps each run (default 2e9 cycles).
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';

const [dir, filter] = process.argv.slice(2);
if (!dir) { console.error('usage: node tools/linux/torture.mjs <dir> [name-filter]'); process.exit(2); }
const LIMIT = Number(process.env.MIRAGE_TORTURE_CYCLES) || 2e9;
const ADDRESSES = new Set(['return-addr']);

const oracle = readFileSync(join(dir, 'oracle.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '))
  .filter(([n, s]) => s !== 'CC_FAIL' && (!filter || n.includes(filter))).sort((a, b) => a[0].localeCompare(b[0]));

const results = [];
const t0 = Date.now();
for (const [name, want] of oracle) {
  const bin = join(dir, 'bin', name);
  if (!existsSync(bin)) continue;
  // qemu-user (the oracle's CPU on this host) reports a fatal signal itself, as a kernel would not.
  const wantOut = existsSync(bin + '.out') ? readFileSync(bin + '.out', 'latin1').replace(/^qemu: .*\n/gm, '') : '';
  let got, out = '', note = '';
  try {
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' });
    const lx = installLinux(mc);
    lx.mkdir('/w'); lx.chdir('/w');
    lx.load(new Uint8Array(readFileSync(bin)), ['/w/' + name], ['PATH=/usr/bin:/bin']);
    while (!lx.done && mc.cpu.cycles < LIMIT) mc.runSlice(200000);
    got = lx.done ? String(lx.status) : 'TIMEOUT';
    out = Buffer.from(lx.stdout.concat(lx.stderr)).toString('latin1');
    if (lx.faultInfo) note = `exc ${lx.faultInfo.n} at ${lx.faultInfo.eip.toString(16)}`;
    if (lx.unimplemented.size) note += ' nosys ' + [...lx.unimplemented.keys()].join(',');
  } catch (e) { got = 'CRASH'; note = String(e.message || e).split('\n')[0].slice(0, 100); }
  if (got === 'TIMEOUT' && want === '124') got = want;              // loops for ever there too
  // Prints stack addresses: qemu-user puts the stack at 408xxxxxh, a kernel (and we) at BFFFxxxxh.
  if (ADDRESSES.has(name) && got === want) out = wantOut;
  results.push({ name, want, got, ok: got === want && out === wantOut, outDiff: got === want && out !== wantOut, note });
}

const bad = results.filter((r) => !r.ok);
const groups = new Map();
for (const r of bad) { const k = r.outDiff ? 'output differs' : `oracle ${r.want}, MIRAGE ${r.got}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${k}: ${rs.length}`);
  for (const r of rs) console.log(`  ${r.name}${r.note ? '  (' + r.note.trim() + ')' : ''}`);
}
console.log(`\n${results.length - bad.length}/${results.length} as the oracle, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exitCode = bad.length ? 1 : 0;
