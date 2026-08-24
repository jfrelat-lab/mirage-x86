// golden.js — deterministic output-fingerprint gate for the recompiler.
//
//   node tools/golden.js capture           # write tools/golden-baseline.json from current engine
//   node tools/golden.js capture <file>    # re-bless ONE entry, leaving the rest alone
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
// The harness must be configured like the real player: it now loads the ROM fonts, as video.js does
// in the browser. Without them, BIOS character output in a graphics mode drew blank glyphs, so three
// intros (256b, intro, revitro) were pinned rendering a BLACK SCREEN — and scored 98-99% against
// DOSBox precisely because those reference frames are mostly black. A gate can only see what the
// harness lets it see.
//
// This is the ONLY gate that catches multi-instruction dead-flag bugs: the SST conformance
// harness is single-instruction and never strips, so it is blind to them. Run it with each
// optimisation's kill-switch both ON and OFF — both must match the pre-change baseline.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeMachine } from './harness.mjs';
import { bootSector } from '../src/boot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASELINE = join(HERE, 'golden-baseline.json');
const TICKS = 60, BUDGET = 400000;

// Fixed workload set: both own demos + every third-party intro. Third-party binaries are
// gitignored, so `check` silently skips any that are absent on this machine.
const WORKLOADS = [
  ['demos/PLASMA13.COM'], ['demos/XORMUNCH.COM'], ['demos/PLANAR.COM'], ['demos/CGA.COM'],
  // Every intro in intros/ that renders, not a subset. Thirteen of these were unpinned and therefore
  // unguarded — measured with tools/probe-intro.js, all thirteen set their mode and fill the
  // framebuffer with no fault, so a regression in any of them would have gone unnoticed. Pinning
  // what already works is the cheapest coverage there is.
  ...['256b', '256bytef', 'above', 'abstract', 'animate', 'chaosequ', 'difze', 'dirojed', 'endless',
      'intoanew', 'intro', 'intro256', 'kaneda', 'lattice', 'memories', 'mirrors', 'nibble',
      'oktaeder', 'paleozoa', 'paralaxa', 'pitman', 'puls', 'qblove', 'revitro', 'rv256', 'symetrie',
      'tube', 'upup', 'warp', 'worm']
    .map((n) => [`intros/${n}.com`]),
  ['intros/mars.exe'],
  // Boot-sector workloads run through the INT 19h handoff with no DOS installed at all. Pinning one
  // here is what keeps that second entry point from silently rotting: nothing else exercises it.
  ['boot/BOOTCHESS.IMG', { boot: true }],
];

function fingerprint(relPath, opts = {}) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  // Composed exactly like the browser (fonts, mouse, 16 MiB) — see harness.mjs for why that matters.
  const { mc, dos } = makeMachine({ dos: !opts.boot });
  let fault = null; mc.onError = (e) => { fault = e; };
  if (opts.boot) bootSector(mc, new Uint8Array(readFileSync(abs)));
  else dos.load(new Uint8Array(readFileSync(abs)), '', 'C:\\PROG');
  for (let t = 0; t < TICKS && !fault && !(dos && dos.programDone); t++) { mc.runSlice(BUDGET); }  // run loop owns the PIT timer now
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
  // `capture <file>` re-blesses ONE entry and leaves the rest of the baseline alone. The policy this
  // enforces is written in ROADMAP D7: a golden moves per program, after checking that program is at
  // least as faithful as before — never by recapturing the set, which turns any regression into the
  // new truth. Without the filter, `capture` was all-or-nothing and the safe path was hard to take.
  const out = only && existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  let n = 0;
  for (const [rel, opts] of WORKLOADS) {
    if (only && !rel.includes(only)) continue;
    const fp = fingerprint(rel, opts);
    if (fp) { out[rel] = fp; n++; console.log(`  ${rel}: ${fp.hash.slice(0, 12)} mode=0x${fp.mode.toString(16)}${fp.fault ? ' FAULT:' + fp.fault : ''}`); }
    else console.log(`  ${rel}: (absent — skipped)`);
  }
  if (only && !n) { console.error(`no workload matches "${only}"`); process.exit(2); }
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${n} fingerprint${n === 1 ? '' : 's'} → ${BASELINE}${only ? ' (rest of the baseline untouched)' : ''}`);
} else if (mode === 'check') {
  if (!existsSync(BASELINE)) { console.error('no baseline — run: node tools/golden.js capture'); process.exit(2); }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  let fail = 0, ok = 0, skip = 0;
  for (const [rel, opts] of WORKLOADS) {
    if (only && !rel.includes(only)) continue;
    const want = base[rel];
    const fp = fingerprint(rel, opts);
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
