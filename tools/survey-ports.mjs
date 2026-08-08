// survey-ports.mjs — run the corpus and report what it does to the I/O bus.
//
//   node tools/survey-ports.mjs                 # ranked table over games/ + intros/
//   node tools/survey-ports.mjs WOLF3DSW        # one game
//   node tools/survey-ports.mjs --watch=0x21    # dump the exact access sequence on one port
//   FRAMES=120 node tools/survey-ports.mjs
//
// The port-bus counterpart of survey-gaps.mjs, and for the same reason: we know exactly which INT
// vectors and DOS functions the corpus asks for, and that changed what we worked on. We know nothing
// equivalent about ports — which is awkward, because the next large piece of work is a real 8259
// (today the EOI is `() => {}`, with no IMR, no priority, no IRR/ISR). "Who writes 0x20/0x21, and
// what?" is a question worth answering before writing that, not after.
//
// The hook has to replace cpu.ioRead/cpu.ioWrite rather than machine.ioRead: recompiled code calls
// the cpu closures directly (they capture the port tables), so wrapping the machine methods would
// trace nothing. Replacing the closures also catches accesses to ports with NO handler — the miss
// path, which is exactly where a missing device shows up.

import { readFileSync } from 'fs';
import { join } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { targets, walk } from './corpus.mjs';

const FRAMES = Number(process.env.FRAMES) || 80;
const argv = process.argv.slice(2);
const watchArg = argv.find((a) => a.startsWith('--watch='));
const WATCH = watchArg ? parseInt(watchArg.split('=')[1], 16) : null;
const filter = argv.find((a) => !a.startsWith('--'));
const MAX_SEQ = 200;          // watched-port sequence entries kept per program

// Names for the ports that carry meaning. Anything unnamed shows as bare hex, which is itself a
// signal worth looking at.
const NAMES = new Map(Object.entries({
  0x20: 'PIC1 cmd/EOI', 0x21: 'PIC1 IMR', 0xa0: 'PIC2 cmd/EOI', 0xa1: 'PIC2 IMR',
  0x40: 'PIT ch0', 0x41: 'PIT ch1', 0x42: 'PIT ch2', 0x43: 'PIT mode',
  0x60: '8042 data', 0x61: 'PPI/speaker', 0x64: '8042 status/cmd', 0x70: 'CMOS index', 0x71: 'CMOS data',
  0x92: 'A20 (fast gate)', 0x201: 'game port',
  0x220: 'SB base', 0x226: 'SB reset', 0x22a: 'SB read-data', 0x22c: 'SB write/cmd', 0x22e: 'SB read-status',
  0x388: 'OPL addr', 0x389: 'OPL data',
  0x3b4: 'CRTC index (mono)', 0x3b5: 'CRTC data (mono)', 0x3ba: 'status1 (mono)',
  0x3c0: 'ATC index/data', 0x3c1: 'ATC read', 0x3c2: 'misc out (w)', 0x3c4: 'seq index', 0x3c5: 'seq data',
  0x3c6: 'DAC pel mask', 0x3c7: 'DAC read idx', 0x3c8: 'DAC write idx', 0x3c9: 'DAC data', 0x3cc: 'misc out (r)',
  0x3ce: 'GC index', 0x3cf: 'GC data', 0x3d4: 'CRTC index', 0x3d5: 'CRTC data',
  0x3d8: 'CGA mode', 0x3d9: 'CGA colour', 0x3da: 'status1',
  0x3f2: 'FDC digital output', 0x3f4: 'FDC status', 0x3f5: 'FDC data',
}).map(([k, v]) => [Number(k), v]));

/** Run one program with the I/O bus instrumented. */
function probe(t) {
  const vfs = new VFS();
  for (const rel of walk(t.dir)) {
    vfs.addFile(t.mount + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(t.dir, rel))));
  }
  vfs.chdir(t.mount.replace(/\\$/, ''));
  const { mc, dos } = makeMachine({ vfs });

  // Replace the closures the recompiled code actually calls. Keep the originals so behaviour is
  // untouched — a survey that changes what it measures is worthless.
  const reads = new Map(), writes = new Map(), values = new Map(), seq = [];
  const noHandler = new Set();
  const origRead = mc.cpu.ioRead, origWrite = mc.cpu.ioWrite;
  mc.cpu.ioRead = (p, s) => {
    reads.set(p, (reads.get(p) || 0) + 1);
    if (!mc.portRead[p]) noHandler.add(p);
    const v = origRead(p, s);
    if (p === WATCH && seq.length < MAX_SEQ) seq.push(`IN  ${s * 8}b -> ${hex(v)}`);
    return v;
  };
  mc.cpu.ioWrite = (p, s, v) => {
    writes.set(p, (writes.get(p) || 0) + 1);
    if (!mc.portWrite[p]) noHandler.add(p);
    let set = values.get(p);
    if (!set) values.set(p, set = new Set());
    if (set.size < 24) set.add(v & (s === 1 ? 0xff : 0xffff));
    if (p === WATCH && seq.length < MAX_SEQ) seq.push(`OUT ${s * 8}b <- ${hex(v)}`);
    return origWrite(p, s, v);
  };

  let fault = null; mc.onError = (e) => { fault = e; };
  try { dos.load(new Uint8Array(readFileSync(join(t.dir, t.prog))), '', 'C:' + t.mount + t.prog); }
  catch (e) { return { error: 'load: ' + e.message }; }
  const t0 = Date.now();
  for (let i = 0; i < FRAMES && !fault && !dos.programDone; i++) {
    mc.runSlice(200000);
    mc.tickTimer();
    if (Date.now() - t0 > 12000) break;
  }
  return { reads, writes, values, noHandler, seq, fault: fault ? fault.message : null };
}

const hex = (n) => '0x' + (n >>> 0).toString(16);
const port = (p) => `0x${p.toString(16).padStart(3, '0')}`;

const list = targets(filter);
console.log(`surveying ${list.length} programs, ${FRAMES} frames each` +
            (WATCH !== null ? `, watching port ${port(WATCH)}` : '') + '\n');

const totalR = new Map(), totalW = new Map(), allValues = new Map(), unhandled = new Set(), who = new Map();
for (const t of list) {
  const r = probe(t);
  if (r.error) { console.log(`  ${t.label.padEnd(34)} ${r.error}`); continue; }
  const add = (dst, src) => { for (const [p, n] of src) dst.set(p, (dst.get(p) || 0) + n); };
  add(totalR, r.reads); add(totalW, r.writes);
  for (const [p, set] of r.values) {
    let s = allValues.get(p); if (!s) allValues.set(p, s = new Set());
    for (const v of set) if (s.size < 24) s.add(v);
  }
  for (const p of r.noHandler) unhandled.add(p);
  for (const p of new Set([...r.reads.keys(), ...r.writes.keys()])) {
    if (!who.has(p)) who.set(p, new Set());
    who.get(p).add(t.label.split('/')[1]);
  }
  if (WATCH !== null && r.seq.length) {
    console.log(`  ${t.label}`);
    for (const line of r.seq) console.log(`      ${line}`);
  }
}

if (WATCH !== null) process.exit(0);

const ports = [...new Set([...totalR.keys(), ...totalW.keys()])]
  .sort((a, b) => ((totalR.get(b) || 0) + (totalW.get(b) || 0)) - ((totalR.get(a) || 0) + (totalW.get(a) || 0)));

console.log('port    name                     reads      writes   values written');
for (const p of ports) {
  const vals = [...(allValues.get(p) || [])].sort((a, b) => a - b).map(hex);
  const shown = vals.length >= 24 ? vals.slice(0, 8).join(' ') + ' …' : vals.join(' ');
  console.log(`${port(p)}  ${(NAMES.get(p) || '').padEnd(22)} ${String(totalR.get(p) || 0).padStart(9)} ${String(totalW.get(p) || 0).padStart(9)}   ${shown}`);
}

if (unhandled.size) {
  console.log('\n=== ports with NO handler (a read returns all-ones, a write vanishes) ===');
  for (const p of [...unhandled].sort((a, b) => a - b)) {
    console.log(`  ${port(p)}  ${(NAMES.get(p) || '').padEnd(22)} r=${totalR.get(p) || 0} w=${totalW.get(p) || 0}   ${[...(who.get(p) || [])].slice(0, 6).join(', ')}`);
  }
} else {
  console.log('\nevery port touched has a handler.');
}
