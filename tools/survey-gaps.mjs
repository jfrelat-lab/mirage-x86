// survey-gaps.mjs — run every program in games/ (and intros/) and report what each one ASKED FOR
// and did not get: unimplemented INT vectors and INT 21h functions that fell through to `default:`.
//
//   node tools/survey-gaps.mjs              # all games/<dir>/*.EXE|COM + intros/*.com
//   node tools/survey-gaps.mjs WOLF3DSW     # only matching subdirs
//   FRAMES=120 node tools/survey-gaps.mjs
//
// Why: gaps have been picked by reading the code and guessing which ones matter. That is how we
// spent effort on INT 21h 39h/3Ah/3Bh without knowing whether any game we have actually calls them.
// The engine already counts unhandled INTs (`machine.unhandledInts`) and now unhandled INT 21h
// functions (`dos.unhandledFn`); this just runs the corpus and adds them up. Measurement first.
//
// A caveat worth keeping in mind while reading the output: a program only reaches the calls that
// come after the point where it currently derails, so a title that dies early under-reports. The
// ranking is "what the corpus asks for", not "what the corpus would ask for if everything worked".

import { readFileSync } from 'fs';
import { join } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { targets, walk } from './corpus.mjs';

const FRAMES = Number(process.env.FRAMES) || 80;
const filter = process.argv[2];

/** Run one program with its own directory mounted, and report what it asked for. */
function probe(gameDir, mountPrefix, prog) {
  const vfs = new VFS();
  for (const rel of walk(gameDir)) {
    vfs.addFile(mountPrefix + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(gameDir, rel))));
  }
  vfs.chdir(mountPrefix.replace(/\\$/, ''));
  const { mc, dos } = makeMachine({ vfs });
  let fault = null; mc.onError = (e) => { fault = e; };
  try { dos.load(new Uint8Array(readFileSync(join(gameDir, prog))), '', 'C:' + mountPrefix + prog); }
  catch (e) { return { error: 'load: ' + e.message }; }

  const t0 = Date.now();
  for (let t = 0; t < FRAMES && !fault && !dos.programDone; t++) {
    mc.runSlice(200000);
    mc.tickTimer();
    if (Date.now() - t0 > 12000) break;                 // some titles idle on input forever
  }
  return {
    ints: mc.unhandledIntReport() ? mc.unhandledIntReport().split(', ') : [],
    fns: dos.unhandledFnReport(),
    fault: fault ? fault.message : null,
    done: dos.programDone,
  };
}

const list = targets(filter);

const intTotals = new Map(), fnTotals = new Map(), fnWho = new Map();
console.log(`surveying ${list.length} programs, ${FRAMES} frames each\n`);
for (const t of list) {
  const r = probe(t.dir, t.mount, t.prog);
  if (r.error) { console.log(`  ${t.label.padEnd(34)} ${r.error}`); continue; }
  const bits = [];
  if (r.fns.length) bits.push('INT21 ' + r.fns.join(' '));
  if (r.ints.length) bits.push(r.ints.join(' '));
  if (r.fault) bits.push('FAULT ' + r.fault);
  console.log(`  ${t.label.padEnd(34)} ${bits.join('  |  ') || '—'}`);
  for (const s of r.fns) {
    const [k, n] = s.split(' x');
    fnTotals.set(k, (fnTotals.get(k) || 0) + Number(n));
    if (!fnWho.has(k)) fnWho.set(k, new Set());
    fnWho.get(k).add(t.label.split('/')[1]);
  }
  for (const s of r.ints) {
    const [k, n] = s.split(' ×');
    intTotals.set(k, (intTotals.get(k) || 0) + Number(n));
  }
}

const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n=== INT 21h functions asked for and not implemented ===');
for (const [k, n] of rank(fnTotals)) console.log(`  ${k}  ${String(n).padStart(8)} calls   ${[...(fnWho.get(k) || [])].slice(0, 6).join(', ')}`);
if (!fnTotals.size) console.log('  (none)');
console.log('\n=== INT vectors asked for and not implemented ===');
for (const [k, n] of rank(intTotals)) console.log(`  ${k}  ${String(n).padStart(8)} calls`);
if (!intTotals.size) console.log('  (none)');
