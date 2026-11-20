// oracle.mjs — MIRAGE as the oracle at INSTRUCTION granularity. A recompiled program reports, at each
// of its frames, the exact number of guest instructions it has retired; this runs MIRAGE to exactly
// that count and hashes the same thing (A000's 64,000 bytes and the DAC), so the two are compared
// at the same point of the same instruction stream, not at "the same poll".
//
//   node tools/recomp/oracle.mjs intros/tube.com 1200000,2400000     (prints JSON, one row a count)
//
// How it stops at an exact count: with MIRAGE_MAXOPS=1 and MIRAGE_NOREALCHAIN=1 every block of the
// dynamic recompiler is one instruction, and runSlice(n) runs n blocks -- n instructions, measured
// (tools/recomp/out probe: 300 M instructions in slices of 1000, not one slice off by one). That also
// makes what MIRAGE answers on port 3DAh exact: its beam is cpu.cycles modulo the frame period, and
// cpu.cycles is bumped per block, so at the usual 192-instruction blocks the beam a read sees depends
// on where the block began (a MIRAGE property: the C reads it per instruction, src/bios.js status1).
// The variables are read when src/recompiler.js is imported, so the exact oracle is its own process:
// `oracleHashes` spawns this file.
//
// The machine is tools/bench.js's (1 MiB, BIOS, DOS, timerAuto off: no INT 8 in the middle).
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const SELF = fileURLToPath(import.meta.url);
export const frameHash = (fb, dac) => createHash('sha1').update(fb).update(dac).digest('hex');

/** Hashes of MIRAGE's frame at each count (ascending), from an exact-mode child process. */
export function oracleHashes(path, counts, { keep = [] } = {}) {
  const r = spawnSync(process.execPath, [SELF, path, counts.join(','), keep.join(',')], {
    encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MIRAGE_MAXOPS: '1', MIRAGE_NOREALCHAIN: '1' } });
  if (r.status !== 0) throw new Error(`oracle: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** In-process: the machine, its entry state, and a function running it to an exact count. */
export async function mirageMachine(path) {
  const { Machine } = await import('../../src/machine.js');
  const { installBIOS } = await import('../../src/bios.js');
  const { installDOS } = await import('../../src/dos.js');
  const { VFS } = await import('../../src/vfs.js');
  const mc = new Machine({ memSize: 1 << 20 });
  mc.timerAuto = false;
  installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(new Uint8Array(readFileSync(path)), '', 'C:\\PROG');
  const cpu = mc.cpu;
  const entry = { reg: Array.from(cpu.reg.slice(0, 8), (v) => v & 0xffff), regHi: Array.from(cpu.reg.slice(0, 8), (v) => (v >>> 16) & 0xffff), seg: Array.from(cpu.seg.slice(0, 6)), eip: cpu.eip, flags: cpu.flags, ftop: cpu.ftop & 7,
    // What the program finds in memory beside its image: the interrupt table, the BIOS data area,
    // its PSP (DOS's, with the top-of-memory word and the command tail), and the word DOS pushed.
    dac: Array.from(mc.bios.dac.subarray(0, 768)), ivt: Array.from(mc.mem.u8.subarray(0, 0x500)), psp: Array.from(mc.mem.u8.subarray(cpu.seg[1] * 16, cpu.seg[1] * 16 + 0x100)) };
  const runTo = (n) => {
    while (!fault && !dos.programDone && cpu.cycles < n) mc.runSlice(Math.min(n - cpu.cycles, 1 << 20));
    return cpu.cycles;
  };
  const frame = () => ({ fb: mc.mem.u8.subarray(0xa0000, 0xa0000 + 64000), dac: Buffer.from(mc.bios.dac.buffer, mc.bios.dac.byteOffset, 768) });
  return { mc, dos, cpu, entry, runTo, frame, fault: () => fault };
}

/**
 * The 3DAh beam as MIRAGE computes it headless (src/bios.js status1: the period from pitBase, the
 * fractions from the CRTC, src/vga.js recomputeBeam), for the mode in force now. The generated C
 * computes the same expression from these numbers (tools/recomp/rc.h rc_beam).
 */
export function beamOf(mc) {
  const period = Math.max(1, Math.round((mc.pitBase || mc.pitReload) / 3.845));
  const b = mc.vga.beam;
  const lines = b.lines || 449, hDisp = b.hDisp || 0.8, cLine = period / lines;
  return { period, cBlank: Math.round(period * b.blank), cRS: Math.round(period * b.rStart), cRE: Math.round(period * b.rEnd), cLine, cHD: cLine * hDisp };
}

/**
 * A SNAPSHOT for a program whose code is not in its file (a packed 4K intro unpacks itself, a
 * 256-byte one may relocate itself): MIRAGE runs it, exactly, to the instruction before its first
 * frame point (a read of port 60h or 3DAh, an INT 16h, a write to the DAC) -- or to `at` -- and the whole machine state
 * there is what the C starts from: registers, flags, x87, the PIT, the DAC and the low megabyte. The
 * translation then reads its code out of that memory.
 */
export function oracleSnapshot(path, { at = null, limit = 2e8 } = {}) {
  const r = spawnSync(process.execPath, [SELF, path, '--snapshot', String(at ?? ''), String(limit)], {
    encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, MIRAGE_MAXOPS: '1', MIRAGE_NOREALCHAIN: '1' } });
  if (r.status !== 0) throw new Error(`oracle snapshot: ${r.stderr}`);
  const s = JSON.parse(r.stdout);
  s.mem = new Uint8Array(Buffer.from(s.mem, 'base64'));
  return s;
}

async function snapshotMain(path, at, limit) {
  let S = at;
  if (S === null) {
    // Pass 1: the count before the first frame point (cpu.cycles at an IN is the count before it, in
    // this one-instruction-a-block configuration).
    const m = await mirageMachine(path);
    let hit = null;
    for (const p of [0x60, 0x3da]) { const prev = m.mc.portRead[p]; m.mc.portRead[p] = (q, s) => { if (hit === null) hit = m.cpu.cycles; return prev ? prev(q, s) : 0xff; }; }
    for (const p of [0x3c8, 0x3c9]) { const prev = m.mc.portWrite[p]; m.mc.portWrite[p] = (q, s, v) => { if (hit === null) hit = m.cpu.cycles; if (prev) prev(q, s, v); }; }
    const h16 = m.mc.intHandlers[0x16];
    m.mc.intHandlers[0x16] = (c, mc) => { if (hit === null) hit = m.cpu.cycles; return h16(c, mc); };
    while (hit === null && !m.fault() && !m.dos.programDone && m.cpu.cycles < limit) m.mc.runSlice(1000);
    if (hit === null) throw new Error(`no frame point in ${limit} instructions${m.fault() ? `: ${m.fault().message}` : ''}`);
    S = hit;
  }
  const m = await mirageMachine(path);
  m.runTo(S);
  const { cpu, mc } = m;
  if (cpu.cycles !== S) throw new Error(`stopped at ${cpu.cycles}, not ${S}`);
  if (cpu.cr0 & 1) throw new Error('in protected mode');
  return {
    count: S, eip: cpu.eip & 0xffff,
    reg: Array.from(cpu.reg.slice(0, 8), (v) => v & 0xffff), regHi: Array.from(cpu.reg.slice(0, 8), (v) => (v >>> 16) & 0xffff),
    seg: Array.from(cpu.seg.slice(0, 6)), flags: cpu.flags,
    fpu: { st: Array.from(cpu.fst), ftop: cpu.ftop & 7, fsw: cpu.fsw, fcw: cpu.fcw },
    pit: { mode: mc._pitMode, access: mc._pitAccess, ticks: mc._pitTicks, load: mc._pitLoad, readHi: mc._pitReadHi ? 1 : 0, hiNext: mc._pitHiNext ? 1 : 0, lo: mc._pitLo },
    dac: Array.from(mc.bios.dac.subarray(0, 768)), mode: mc.mem.r8(0x449), planar: !!mc.bios.planar,
    mem: Buffer.from(mc.mem.u8.subarray(0, 0x100000)).toString('base64'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === SELF && process.argv[3] === '--snapshot') {
  const [path, , at, limit] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(await snapshotMain(resolve(path), at ? +at : null, +limit)));
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [path, list, keepList] = process.argv.slice(2);
  const counts = list ? list.split(',').filter(Boolean).map(Number) : [];
  const keep = new Set((keepList || '').split(',').filter(Boolean).map(Number));
  const m = await mirageMachine(resolve(path));
  const rows = [];
  for (const n of counts) {
    const at = m.runTo(n);
    const { fb, dac } = m.frame();
    rows.push({ at, hash: at === n ? frameHash(fb, dac) : null, fault: m.fault() ? String(m.fault().message) : null, done: !!m.dos.programDone,
      ...(keep.has(n) ? { fb: Buffer.from(fb).toString('base64'), dac: Buffer.from(dac).toString('base64') } : {}) });
    if (at !== n) break;
  }
  process.stdout.write(JSON.stringify(rows));
}
