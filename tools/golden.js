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

// Intros whose picture is not on screen at the default 60 ticks — measured, not guessed, by counting
// DISTINCT framebuffer values across candidate budgets. `animate` had already finished and cleared to
// a flat fill (2 values) at 60; `mesha` needs ~400 ticks to finish precomputing and draws nothing
// before that. The engine is deterministic, so any budget is reproducible — the choice is only about
// sampling where the content is.
// Re-measured 2026-09-02 after the machine speed was calibrated to the reference (TIMING.md §6):
// a timer-paced program advances by TICKS, so changing how many instructions a tick is worth moves
// where its picture is. Only `freality` needed moving (20 -> 40, 2 distinct values -> 90).
// mesha is pinned at 170 and NOT at 400 because it EXITS at 214: a later sample catches the demo
// after it has restored text mode, which resets the DAC, so the entry was blind to the palette. It
// stayed 43/43 across the fix for INT 10h AL=12h that transformed every frame of it — verified both
// ways, the 400-tick digest is byte-identical with the bug present and absent, the 170-tick one is
// not. Pin a program while its picture is on screen; "pin the show, not the curtain" below is the
// same rule, and this is the case that showed it also applies to the palette.
const TICK_OVERRIDE = { animate: 20, crevenge: 200, freality: 40, mesha: 170, omniscent: 120, starport: 200 };

// Fixed workload set: both own demos + every third-party intro. Third-party binaries are
// gitignored, so `check` silently skips any that are absent on this machine.
const WORKLOADS = [
  ['demos/PLASMA13.COM'], ['demos/XORMUNCH.COM'], ['demos/PLANAR.COM'], ['demos/CGA.COM'],
  ['demos/VESA.COM'],   // VESA VBE: mode-list walk, 4F01/4F02, and five 4F05 bank switches
  // Every intro in intros/ that renders, not a subset. Thirteen of these were unpinned and therefore
  // unguarded — measured with tools/probe-intro.js, all thirteen set their mode and fill the
  // framebuffer with no fault, so a regression in any of them would have gone unnoticed. Pinning
  // what already works is the cheapest coverage there is.
  // The 2026-08-28 additions are the pouet MS-Dos 4K top ten (see COMPAT). `juggler` is left out
  // because it blocks on a keypress before it draws, and `void3` because it needs VESA and exits.
  ...['256b', '256bytef', 'above', 'abstract', 'animate', 'chaosequ', 'difze', 'dirojed', 'endless',
      'crevenge', 'freality', 'intoanew', 'intro', 'intro256', 'kaneda', 'lattice', 'memories', 'mesha',
      'mirrors', 'nibble', 'oktaeder', 'omniscent', 'paleozoa', 'paralaxa', 'pitman', 'puls',
      'qblove', 'revitro', 'rv256', 'soullost', 'starport', 'symetrie', 'tube', 'upup', 'warp',
      'worm']
    .map((n) => [`intros/${n}.com`, TICK_OVERRIDE[n] ? { ticks: TICK_OVERRIDE[n] } : undefined]),
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
  // Per-workload tick budget. A program that FINISHES inside the default budget leaves the screen
  // it exits to, not the one it drew: `animate` is a flat fill at 60 ticks. Pin the show, not the
  // curtain -- `opts.ticks` moves the sample to where the picture actually is.
  const ticks = opts.ticks || TICKS;
  let vbeSeen = null;
  for (let t = 0; t < ticks && !fault && !(dos && dos.programDone); t++) {
    mc.runSlice(BUDGET);                          // run loop owns the PIT timer now
    if (mc.vbe) vbeSeen = { ...mc.vbe };          // a VESA program restores text mode before it exits
  }
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
  // A VESA mode's picture is in the reserved framebuffer, not in A000 — hash it, and the geometry
  // with it, or VESA.COM's fingerprint would be "text mode, empty A000" like any failing program.
  if (vbeSeen) {
    h.update(Buffer.from([vbeSeen.number & 0xff, vbeSeen.number >> 8, vbeSeen.bpp, vbeSeen.linear ? 1 : 0,
                          vbeSeen.width & 0xff, vbeSeen.width >> 8, vbeSeen.height & 0xff, vbeSeen.height >> 8]));
    h.update(mc.mem.u8.subarray(vbeSeen.base, vbeSeen.base + vbeSeen.height * vbeSeen.pitch));
  }
  const md = mc.mem.r8(0x449);
  if (md === 3 || md === 2 || md === 7) {                  // TEXT modes: the picture is the B800 cell
    h.update(mc.mem.u8.subarray(0xb8000, 0xb8000 + 4000)); // grid, and nothing above covers it — so a
  }                                                        // text-mode program's golden was hashing an
  // empty A000 plus its mode byte and could not fail. Pitman is a text-mode GAME and sat in this list
  // fully unguarded; it is the reason this arm exists.
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
