// bench.js — throughput benchmark for the recompiler (fps-equivalent per workload).
//
//   node tools/bench.js                 # all workloads, human table
//   node tools/bench.js tube memories   # subset
//   node tools/bench.js --json          # machine-readable (for baseline capture / regression diff)
//
// Protocol: WARMUP frames untimed (let V8's tiering optimise the emitted block functions —
// this takes thousands of executions), then MEASURED frames timed individually; report the
// median (p50) ms/frame and fps-equivalent. A frame = runSlice(BUDGET) + tickTimer(). Run
// several times from fresh processes and take the median-of-medians for a stable baseline;
// this script reports one process's p50 (robust within a process).

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Frame counts overridable via env for a fuller/slower run (e.g. WARMUP=100 MEASURED=300).
const WARMUP = Number(process.env.WARMUP) || 40, MEASURED = Number(process.env.MEASURED) || 80, BUDGET = 2_000_000;

const PATHS = {
  plasma13: 'demos/PLASMA13.COM', xormunch: 'demos/XORMUNCH.COM',
  tube: 'intros/tube.com', memories: 'intros/memories.com',
  kaneda: 'intros/kaneda.com', lattice: 'intros/lattice.com',
};
const DEFAULT = ['tube', 'memories', 'plasma13', 'xormunch', 'kaneda', 'lattice'];

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const names = argv.filter((a) => !a.startsWith('--'));
const pick = names.length ? names : DEFAULT;

function bench(name) {
  const rel = PATHS[name];
  if (!rel || !existsSync(join(ROOT, rel))) return null;
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(new Uint8Array(readFileSync(join(ROOT, rel))), '', 'C:\\PROG');
  const frame = () => { mc.runSlice(BUDGET); mc.tickTimer(); };
  for (let i = 0; i < WARMUP && !fault; i++) frame();       // warmup (untimed)
  const t = new Float64Array(MEASURED);
  for (let i = 0; i < MEASURED && !fault; i++) {
    const a = process.hrtime.bigint(); frame(); t[i] = Number(process.hrtime.bigint() - a) / 1e6;
  }
  const s = Array.from(t).sort((x, y) => x - y);
  const p50 = s[s.length >> 1], p05 = s[(s.length * 0.05) | 0];
  return { name, p50, best: p05, fps: 1000 / p50, fault: fault ? fault.message : null };
}

const rows = pick.map(bench).filter(Boolean);
if (json) {
  const out = {}; for (const r of rows) out[r.name] = { p50: +r.p50.toFixed(3), fps: +r.fps.toFixed(2) };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`bench: warmup ${WARMUP} + measured ${MEASURED} frames of runSlice(${(BUDGET / 1e6)}M)+tick\n`);
  console.log('  workload      p50 ms/frame   fps-equiv   best ms');
  for (const r of rows) console.log(`  ${r.name.padEnd(12)}  ${r.p50.toFixed(2).padStart(10)}  ${r.fps.toFixed(2).padStart(10)}  ${r.best.toFixed(2).padStart(8)}${r.fault ? '  FAULT:' + r.fault : ''}`);
}
