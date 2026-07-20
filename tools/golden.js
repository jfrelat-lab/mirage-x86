// golden.js — deterministic output-fingerprint gate for the recompiler.
//
//   node tools/golden.js capture           # write tools/golden-baseline.json from current engine
//   node tools/golden.js check             # recompute + diff against the baseline (exit 1 on mismatch)
//   node tools/golden.js check <file.com>  # check a single program
//
// For each workload it runs a FIXED, wall-clock-independent schedule (K ticks of a fixed
// runSlice budget, stopping only on fault/exit) and hashes the visible + fault state:
// video mode byte, the mode-13h framebuffer (A000:0, 64000B), the DAC palette (768B), and
// the fault message. Because the engine has no nondeterminism (RDTSC reads cpu.cycles, no
// Math.random/Date), the same code path yields the same hash — so any behavioural drift
// (a wrongly-stripped flag, an FPU stack skew, a bad inlined store) flips the digest.
//
// This is the ONLY gate that catches multi-instruction dead-flag bugs: the SST conformance
// harness is single-instruction and never strips, so it is blind to them. Run it with each
// optimisation's kill-switch both ON and OFF — both must match the pre-change baseline.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASELINE = join(HERE, 'golden-baseline.json');
const TICKS = 60, BUDGET = 400000;

// Fixed workload set: both own demos + every third-party intro. Third-party binaries are
// gitignored, so `check` silently skips any that are absent on this machine.
const WORKLOADS = [
  ['demos/PLASMA13.COM'], ['demos/XORMUNCH.COM'], ['demos/PLANAR.COM'], ['demos/CGA.COM'],
  ...['256b', '256bytef', 'above', 'chaosequ', 'difze', 'intoanew', 'intro', 'intro256',
      'kaneda', 'lattice', 'memories', 'oktaeder', 'puls', 'revitro', 'rv256', 'tube', 'upup']
    .map((n) => [`intros/${n}.com`]),
];

function fingerprint(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(new Uint8Array(readFileSync(abs)), '', 'C:\\PROG');
  for (let t = 0; t < TICKS && !fault && !dos.programDone; t++) { mc.runSlice(BUDGET); }  // run loop owns the PIT timer now
  const h = createHash('sha1');
  const meta = Buffer.alloc(8);
  meta[0] = mc.mem.r8(0x449);                     // video mode
  meta[1] = fault ? 1 : 0;
  h.update(meta);
  if (fault) h.update(String(fault.message));
  h.update(mc.mem.u8.subarray(0xa0000, 0xa0000 + 64000));  // mode-13h framebuffer
  h.update(Buffer.from(mc.bios.dac.buffer, mc.bios.dac.byteOffset, 768));  // DAC palette
  if (mc.mem.planar && mc.vga) {                           // EGA/VGA 16-colour modes: A000 is empty,
    h.update(mc.vga.planes);                               // the picture lives in the four bit-planes,
    h.update(mc.vga.palette);                              // the attribute palette,
    h.update(Buffer.from([mc.vga.crtc[0x0c], mc.vga.crtc[0x0d], mc.vga.crtc[0x13]]));  // and the CRTC start/stride
  }
  const md = mc.mem.r8(0x449);
  if (md === 4 || md === 5 || md === 6) {                  // CGA graphics: the picture is in B800,
    h.update(mc.mem.u8.subarray(0xb8000, 0xb8000 + 16384));  // interleaved even/odd banks,
    h.update(Buffer.from([mc.bios.cga.color]));            // through the CGA colour-select register
  }
  return { hash: h.digest('hex'), mode: mc.mem.r8(0x449), fault: fault ? fault.message : null };
}

const mode = process.argv[2] || 'check';
const only = process.argv[3];

if (mode === 'capture') {
  const out = {};
  for (const [rel] of WORKLOADS) {
    const fp = fingerprint(rel);
    if (fp) { out[rel] = fp; console.log(`  ${rel}: ${fp.hash.slice(0, 12)} mode=0x${fp.mode.toString(16)}${fp.fault ? ' FAULT:' + fp.fault : ''}`); }
    else console.log(`  ${rel}: (absent — skipped)`);
  }
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${Object.keys(out).length} fingerprints → ${BASELINE}`);
} else if (mode === 'check') {
  if (!existsSync(BASELINE)) { console.error('no baseline — run: node tools/golden.js capture'); process.exit(2); }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  let fail = 0, ok = 0, skip = 0;
  for (const [rel] of WORKLOADS) {
    if (only && !rel.includes(only)) continue;
    const want = base[rel];
    const fp = fingerprint(rel);
    if (!fp) { if (want) { console.log(`  MISSING ${rel} (in baseline, absent here)`); } skip++; continue; }
    if (!want) { console.log(`  NEW     ${rel}: ${fp.hash.slice(0, 12)} (not in baseline)`); continue; }
    if (fp.hash === want.hash) { ok++; }
    else { fail++; console.log(`  MISMATCH ${rel}: got ${fp.hash.slice(0, 12)} want ${want.hash.slice(0, 12)}` +
      `${fp.mode !== want.mode ? ` mode 0x${fp.mode.toString(16)}!=0x${want.mode.toString(16)}` : ''}` +
      `${fp.fault !== want.fault ? ` fault "${fp.fault}"!="${want.fault}"` : ''}`); }
  }
  console.log(`\ngolden: ${ok} ok, ${fail} mismatch, ${skip} skipped` + (process.env.MIRAGE_NOFPUINLINE || process.env.MIRAGE_NOSTRIP || process.env.MIRAGE_NOMEMINLINE ? ' [kill-switch active]' : ''));
  process.exit(fail ? 1 : 0);
} else { console.error('usage: node tools/golden.js capture|check [file]'); process.exit(2); }
