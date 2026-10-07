// dpmi-probe.mjs — what does a DOS-extended program actually ask a DPMI host for?
//
// Reconnaissance before implementation. The DPMI spec is large and most of it is never called; the
// requirements that matter are the ones a real client issues, in order. So: run the program, log
// every INT 2Fh multiplex query, every INT 31h function, and every INT 21h/other vector it reaches,
// and report where it stopped. The output is the work list.
//
//   node tools/dpmi-probe.mjs games/OMF OMF.EXE
//   FRAMES=400 node tools/dpmi-probe.mjs games/OMF OMF.EXE
//
// Nothing here implements DPMI. INT 2Fh AX=1687h deliberately keeps answering "no host", so this
// records the client's FIRST choice of path. Run it again after a host exists to see the path change.

import { readFileSync } from 'fs';
import { join } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';

const dir = process.argv[2] || 'games/OMF';
const prog = process.argv[3] || 'OMF.EXE';
// Short by default. The DPMI handshake is the FIRST thing a client does, so a long run only buys
// wall-clock: the signal is there within a few frames or it is not there at all.
const FRAMES = Number(process.env.FRAMES) || 40;
const WALL = Number(process.env.WALL) || 4000;
const h = (n, w = 4) => (n >>> 0).toString(16).padStart(w, '0');

const vfs = new VFS();
const mount = '\\';                       // the target directory IS C: — see VFS.mountAt()
for (const rel of walk(dir)) {
  vfs.addFile(mount + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
}
vfs.chdir(mount.replace(/\\$/, ''));

// NOXMS=1 boots without an XMS driver, for a title that refuses to run alongside one.
const { mc, dos } = makeMachine({ vfs, xms: process.env.NOXMS ? false : undefined, ems: process.env.NOEMS ? false : undefined });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };

// Log the multiplex queries by NAME. 1687h is the DPMI host check; 1686h asks "am I already in
// protected mode"; 43xx is XMS, which we do answer.
const mux = new Map();
const MUX_NAMES = { 0x1686: 'DPMI: am I in protected mode?', 0x1687: 'DPMI: host present + entry point',
  0x4300: 'XMS installed?', 0x4310: 'XMS entry point', 0x1680: 'release timeslice' };
const seenOrder = [];
// CHAIN, do not replace: hookInterrupt overwrites the slot, so an observer registered here silently
// disabled the XMS and DPMI answers and the client saw a machine with neither. Observe, then defer.
const prev2f = mc.intHandlers[0x2f];
mc.hookInterrupt(0x2f, (c, m) => {
  const ax = c.ax;
  if (!mux.has(ax)) { mux.set(ax, 0); seenOrder.push(ax); }
  mux.set(ax, mux.get(ax) + 1);
  if (prev2f) prev2f(c, m);
});

// INT 31h is the DPMI service entry. Record AX in call order — the ORDER is the useful part, since
// a client's first few calls tell you which model it is using.
const dpmiCalls = new Map(); const dpmiOrder = [];
const prev31 = mc.intHandlers[0x31];
// Log each call's INPUT registers and what the host answered. A tally of AX values says WHICH
// services are wanted; only the arguments say whether our reply was understood — and a wrong reply
// that the client stores without checking CF is indistinguishable from a right one until much later.
const dpmiLog = [];
const REGN = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const snapRegs = (c) => ({ r: Array.from(c.reg), es: c.seg[0], ds: c.seg[3], f: c.flags });
const fmtRegs = (s) => REGN.map((n, i) => n + '=' + h(s.r[i] & 0xffff)).join(' ') +
  `  es=${h(s.es)} ds=${h(s.ds)} CF=${s.f & 1}`;
mc.hookInterrupt(0x31, (c, m) => {
  const ax = c.ax;
  if (!dpmiCalls.has(ax)) { dpmiCalls.set(ax, 0); dpmiOrder.push(ax); }
  dpmiCalls.set(ax, dpmiCalls.get(ax) + 1);
  const before = snapRegs(c);
  const from = `${h(c.seg[1])}:${h(c.eip >>> 0, 8)}`;
  if (prev31) prev31(c, m);
  // The instructions that FOLLOW a 0204 are where the returned CX:EDX is stored. Reading them from
  // the live machine is the only way to see it — the register log shows the pair arriving, never
  // what the client does with it.
  if (ax === 0x0204 && (c.reg[3] & 0xff) === 0x21) {
    const lin = (c.base[1] + (c.eip >>> 0)) >>> 0;
    const dump = (n) => Array.from({ length: n }, (_, i) => h(mc.mem.u8[(lin + i) & 0xffffff], 2)).join(' ');
    dpmiLog.push(`  >> after 0204 (BL=21), bytes at ${h(c.seg[1])}:${h(c.eip >>> 0, 4)} ` +
      `(linear ${h(lin, 6)}): ${dump(24)}`);
  }
  if (dpmiLog.length < 40) {
    // 0300 and 0302 do NOT finish here — they switch to real mode and complete later at the
    // sentinel. What the registers hold on the way out is the real-mode state we just installed, not
    // a result, and printing it as "out" made perfectly normal values look like garbage.
    const deferred = ax === 0x0300 || ax === 0x0302;
    dpmiLog.push(`  AX=${h(ax)} called from ${from}\n` +
      `     in  : ${fmtRegs(before)}\n` +
      `     ${deferred ? 'real state installed (the service ends at the sentinel)' : 'out'} : ${fmtRegs(snapRegs(c))}`);
  }
});

// The launcher chain is the first thing to verify: a DOS/4GW title is a small real-mode stub that
// EXECs the extender, which then loads the LE image. If EXEC never happens, nothing downstream can.
const execs = [], out = [], seq21 = [], log21 = [];
const origInt21 = mc.intHandlers[0x21];
mc.intHandlers[0x21] = (c, m) => {
  const ah = c.ax >> 8;
  // The FULL INT 21h sequence, in order, for comparison against DOSBox-X's own log. Its
  // "Executing interrupt 21, ah=XX, al=XX" lines are the only external reference we have for this
  // layer, and the first place the two sequences differ localises the defect.
  seq21.push(`${h(ah, 2)}:${h(c.ax & 0xff, 2)}`);
  // Capture what the program PRINTS. A DOS-extended title reports its own failures through AH=09h
  // (a $-terminated string) or AH=40h (write to a handle), and neither touches video memory.
  if (ah === 0x09) {
    let t = '', a = (c.seg[3] << 4) + (c.reg[2] & 0xffff);
    for (let i = 0; i < 400; i++) { const b = mc.mem.u8[(a + i) & 0xfffff]; if (b === 0x24) break; t += String.fromCharCode(b); }
    out.push(t);
  } else if (ah === 0x40) {
    let t = '', a = (c.seg[3] << 4) + (c.reg[2] & 0xffff), n = Math.min(c.reg[1] & 0xffff, 400);
    for (let i = 0; i < n; i++) t += String.fromCharCode(mc.mem.u8[(a + i) & 0xfffff]);
    out.push(t);
  }
  if (ah === 0x4b) {
    let name = '', a = (c.seg[3] << 4) + (c.reg[2] & 0xffff);   // DS:DX = ASCIIZ path
    for (let i = 0; i < 80; i++) { const b = mc.mem.u8[(a + i) & 0xfffff]; if (!b) break; name += String.fromCharCode(b); }
    // Read the bytes from the LIVE machine, not from the file: static offsets need the load segment
    // and the relocation layout, and getting either wrong sends the whole reading astray.
    const cl = (c.seg[1] << 4) >>> 0;
    const dump = (from, n) => Array.from({ length: n }, (_, i) => h(mc.mem.u8[(cl + from + i) & 0xfffff], 2)).join(' ');
    execs.push(`  bytes CS:${h((c.eip - 8) & 0xffff)} = ${dump((c.eip - 8) & 0xffff, 16)}`);
    execs.push(`  parent: PSP=${h(dos.psp)} allocTop=${h(dos.allocTop)} memFloor=${h(dos.memFloor)}  ` +
      `-> l enfant sera charge a ${h(dos.allocTop)}`);
    execs.push(`  the parent reads DS=020e: ${Array.from({length:8},(_,i)=>h(mc.mem.u8[(0x020e<<4)+i],2)).join(' ')}`);
    execs.push(`AL=${c.ax & 0xff} "${name}"  called from ${h(c.seg[1])}:${h(c.eip, 8)} SS:SP=${h(c.seg[2])}:${h(c.reg[4] & 0xffff)}`);
  }
  // The oracle gives the SEQUENCE; only our own returns say what each call answered. The divergence
  // is caused by one of the first calls replying differently, so record them in full.
  // AH=3Dh opens by NAME, and the name is the whole point when a program is probing for a driver.
  if (ah === 0x3d && log21.length < 20) {
    let t = '', a = (c.seg[3] << 4) + (c.reg[2] & 0xffff);
    for (let i = 0; i < 32; i++) { const b = mc.mem.u8[(a + i) & 0xfffff]; if (!b) break; t += String.fromCharCode(b); }
    log21.push(`  3d  ouvre "${t}"`);
  }
  const before21 = snapRegs(c);
  const r21 = origInt21(c, m);
  if (log21.length < 20) {
    log21.push(`  ${h(ah, 2)}  in  ${fmtRegs(before21)}\n      out ${fmtRegs(snapRegs(c))}`);
  }
  return r21;
};

// Ring buffer of block entries. "It ends up at 0000:0187" says nothing about HOW it got there, and
// that is the whole question — the same technique that located every test386 assertion.
const MASK = 2047;
const rCs = new Int32Array(MASK + 1), rIp = new Int32Array(MASK + 1), rN = new Int32Array(MASK + 1);
let ri = 0;
const rSeen = new Map();
const pmTrace = [];
let recent = [], beforeNull = [];

const rec = mc.rec, origTranslate = rec.translate.bind(rec);
rec.translate = (...a) => {
  const b = origTranslate(...a);
  if (b && !b._t) {
    b._t = 1; const f = b.fn;
    b.fn = (c, blk) => {
      // Dedupe CONSECUTIVE repeats at insertion instead of stopping on them. A spin detector has to
      // be armed or it fires on the first legitimate delay loop; deduping needs no tuning at all —
      // any loop, however long, costs one slot, so the lead-up always survives in the ring.
      // Consecutive-dedupe alone is not enough: a two-block loop (A,B,A,B…) alternates, so nothing
      // is consecutive and the ring still fills with it. Cap how many times any single address may
      // be RECORDED — a loop of any shape then costs a bounded number of slots and the lead-up
      // survives, with no threshold to tune.
      const cs = c.seg[1] & 0xffff, ip = c.eip >>> 0;
      // The first blocks AFTER the mode switch are the ones that say whether the client resumed at
      // the address and selector we handed it. The tail of the ring only ever shows where it ended
      // up, which is a different question.
      if (mc.dpmi && mc.dpmi.active && pmTrace.length < 25) pmTrace.push(h(cs) + ':' + h(ip, 4));
      // A rolling window, snapshotted the first time CS goes null. The blocks AFTER a derail are the
      // wreckage; the ones just BEFORE it name the instruction responsible.
      recent.push(h(cs) + ':' + h(ip, 4));
      if (recent.length > 24) recent.shift();
      if (!beforeNull.length && mc.dpmi && mc.dpmi.active && cs === 0) beforeNull = recent.slice();
      const key = (cs << 20) ^ ip;
      const seen = (rSeen.get(key) || 0) + 1;
      rSeen.set(key, seen);
      if (seen <= 3) { const k = ri++ & MASK; rCs[k] = cs; rIp[k] = ip; rN[k] = 1; }
      else { const last = (ri - 1) & MASK; if (rCs[last] === cs && rIp[last] === ip) rN[last]++; }
      return f(c, blk);
    };
  }
  return b;
};

// INT 10h AH=4Fh is VBE/VESA. Under DOSBox-X this demo reaches video mode 0xC5, a VESA mode, while
// MIRAGE stays in text mode — so what it asks INT 10h for matters as much as what it asks INT 31h.
const vbe = new Map();
const prev10 = mc.intHandlers[0x10];
mc.hookInterrupt(0x10, (c, m) => {
  const ax = c.ax;
  if ((ax >> 8) === 0x4f || (ax >> 8) === 0x00) {
    const k = h(ax);
    vbe.set(k, (vbe.get(k) || 0) + 1);
  }
  if (prev10) prev10(c, m);
});

if (mc.dpmi) mc.dpmi.log = [];

// Every selector load in protected mode that names an entry PAST the table limit. setSeg accepts
// those silently, so the only way to see one is to look. The address that performs the load is the
// answer to "where did 0x1519 come from" — a register delta cannot say.
const badSel = [];
const SEGN = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'];
const origSetSeg = cpu.setSeg.bind(cpu);
cpu.setSeg = (i, sel) => {
  sel &= 0xffff;
  if ((cpu.cr0 & 1) && (sel & 0xfffc)) {
    const tbl = (sel & 4) ? cpu.ldtr : cpu.gdtr;
    if ((sel & 0xfff8) + 7 > tbl.limit && badSel.length < 12) {
      badSel.push(`${SEGN[i]}=${h(sel)} (${sel & 4 ? 'LDT' : 'GDT'} limite=${h(tbl.limit)}) ` +
        `charge depuis ${h(cpu.seg[1])}:${h(cpu.eip >>> 0, 8)}`);
    }
  }
  return origSetSeg(i, sel);
};

// biosCallback consumes an IRET frame of its own. While a 0302 call is in flight, the frame it pops
// is the one 0302 pushed — so log what it sees on entry and where it lands, which is the whole
// question. Wrapped here rather than in the engine: it is a diagnostic, not behaviour.
const bcLog = []; let bcCount = 0;
const origBios = mc.biosCallback.bind(mc);
mc.biosCallback = (n) => {
  const inFlight = mc.dpmi && mc.dpmi.rmCalls.length > 0;
  if (!inFlight) return origBios(n);
  const sp = (cpu.seg[2] << 4) + (cpu.reg[4] & 0xffff);
  const w = (i) => h(mc.mem.r16((sp + i * 2) & 0xfffff));
  const before = `INT ${h(n, 2)} in  ${h(cpu.seg[1])}:${h(cpu.eip >>> 0, 4)} ` +
    `ss:sp=${h(cpu.seg[2])}:${h(cpu.reg[4] & 0xffff)} pile=[${w(0)} ${w(1)} ${w(2)} ${w(3)}] ` +
    `bloque=${mc.blocked}`;
  const r = origBios(n);
  bcCount++;
  if (bcLog.length < 6) bcLog.push(`${before}\n     out ${h(cpu.seg[1])}:${h(cpu.eip >>> 0, 4)} ` +
    `ss:sp=${h(cpu.seg[2])}:${h(cpu.reg[4] & 0xffff)} bloque=${mc.blocked} ` +
    `rmCalls=${mc.dpmi.rmCalls.length}`);
  return r;
};

try { dos.load(new Uint8Array(readFileSync(join(dir, prog))), '', 'C:' + mount + prog); }
catch (e) { console.error('chargement impossible: ' + e.message); process.exit(1); }

const t0 = Date.now();
let frames = 0;
const CYCLE_CAP = Number(process.env.CYCLES) || 2e8;
for (; frames < FRAMES && !fault && !dos.programDone; frames++) {
  mc.runSlice(2000);
  // A wall-clock test BETWEEN slices cannot stop a slice, so a big slice made the probe run for
  // minutes. Smaller slices plus a cycle ceiling bound it whatever the guest does.
  if (cpu.cycles > CYCLE_CAP) break;
  mc.tickTimer();
  if (Date.now() - t0 > WALL) break;
  // Stop at the handshake only when nobody asked for a longer run: for reconnaissance that IS the
  // answer, but once you are chasing what happens AFTER it, stopping there hides everything.
  if (!process.env.FRAMES && seenOrder.includes(0x1687)) { frames++; break; }
}

console.log(`=== ${dir}/${prog} — ${frames} frames, ${(cpu.cycles / 1e6).toFixed(1)} Mcycles ===`);
console.log(`stop: ${fault ? 'FAULT ' + fault.message : dos.programDone ? 'program done' : 'still running'}`);
console.log(`CS:EIP = ${h(cpu.seg[1])}:${h(cpu.eip, 8)}  CR0=${h(cpu.cr0, 8)} PE=${cpu.cr0 & 1}\n`);

console.log('INT 2Fh (multiplex) demandes:');
if (!seenOrder.length) console.log('  (none)');
for (const ax of seenOrder) console.log(`  AX=${h(ax)}  x${mux.get(ax)}   ${MUX_NAMES[ax] || ''}`);

console.log('\nINT 31h (DPMI services) requested, in order:');
if (!dpmiOrder.length) console.log('  (none — the client did not take the DPMI path)');
for (const ax of dpmiOrder) console.log(`  AX=${h(ax)}  x${dpmiCalls.get(ax)}`);
if (dpmiLog.length) {
  if (bcLog.length) {
  console.log(`\nbiosCallback during an 0302 call (${bcCount} entries in total):`);
  for (const l of bcLog.slice(0, 6)) console.log('  ' + l);
}

if (badSel.length) {
  // The chain site itself: the far transfer that arrives at selector zero.
if (beforeNull.length && mc.dpmi) {
  const csBase = 0x32c0;                       // base the client set for 0044 via 0007
  const at = 0x1260;
  const dump = (a, n) => Array.from({ length: n }, (_, i) => h(mc.mem.u8[(csBase + a + i) & 0xffffff], 2)).join(' ');
  console.log(`\nchaining site, 0044:${h(at, 4)} (linear ${h(csBase + at, 6)}):`);
  console.log('  ' + dump(at, 16));
  console.log('  ' + dump(at + 16, 16));
}

if (beforeNull.length) {
  console.log('\nlast blocks BEFORE CS goes to zero:');
  console.log('  ' + beforeNull.join(' -> '));
}

console.log('\nselecteurs hors limite charges en mode protege:');
  for (const l of badSel) console.log('  ' + l);
}

if (mc.dpmi && mc.dpmi.log && mc.dpmi.log.length) {
  console.log('\nappels reels via 0302:');
  for (const l of mc.dpmi.log.slice(0, 12)) console.log('  ' + l);
}

console.log('\nINT 31h — in and out registers, in order:');
  for (const l of dpmiLog) console.log(l);
}

const ints = mc.unhandledIntReport();
// What did it SAY? A program that exits on purpose has almost always printed why. Reading the text
// buffer is quicker than inferring the reason from where it stopped.
{
  const lines = [];
  for (let row = 0; row < 25; row++) {
    let t = '';
    for (let col = 0; col < 80; col++) {
      const ch = mc.mem.u8[(0xb8000 + (row * 80 + col) * 2) & 0xfffff];
      t += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' ';
    }
    if (t.trim()) lines.push('  | ' + t.replace(/\s+$/, ''));
  }
  console.log('\nDOS output (INT 21h AH=09h/40h):');
console.log(out.length ? out.join('').split('\n').map((l) => '  | ' + l.replace(/[\r]/g, '')).join('\n') : '  (none)');

// Executing without faulting is not the same as RENDERING. The BIOS mode byte says which surface to
// look at, and counting non-zero bytes distinguishes "cleared the screen" from "drew something".
{
  const mode = mc.mem.u8[0x449];
  const lin = mode === 0x13 || mode >= 0x0d ? 0xa0000 : 0xb8000;
  let nz = 0, distinct = new Set();
  for (let i = 0; i < 64000; i++) { const b = mc.mem.u8[lin + i]; if (b) nz++; if (distinct.size < 40) distinct.add(b); }
  if (process.env.SEQ21) {
  console.log('\nINT 21h — the first calls, in and out:');
  for (const l of log21) console.log(l);
}
if (process.env.SEQ21) {
  console.log('\nINT 21h sequence (ah:al), in order:');
  console.log(seq21.join(' '));
}

console.log(`\nINT 10h (modes / VBE): ${[...vbe].map(([k, v]) => k + 'x' + v).join(' ') || '(none)'}`);
  console.log(`\nvideo: mode=0x${mode.toString(16)} surface=${lin.toString(16)} ` +
    `non-zero bytes=${nz}/64000 distinct values=${distinct.size}`);
}

console.log('\necran texte:');
  console.log(lines.length ? lines.join('\n') : '  (vide)');
}

console.log('\nEXEC (INT 21h AH=4Bh) attempted: ' + (execs.length ? execs.join(' | ') : '(none)'));
console.log('\nunimplemented INT vectors: ' + (ints || '(none)'));
// The final loop's opcodes, read live. "It spins at X" is not a diagnosis; what it is WAITING ON is.
{
  const cl = (cpu.seg[1] << 4) >>> 0, at = (cpu.eip >>> 0) & 0xffff;
  const from = Math.max(0, at - 16);
  const dump = (a, n) => Array.from({ length: n }, (_, i) => h(mc.mem.u8[(cl + a + i) & 0xfffff], 2)).join(' ');
  console.log(`\nbytes around ${h(cpu.seg[1])}:${h(at, 4)} :`);
  console.log(`  ${h(from, 4)}: ${dump(from, 16)}`);
  console.log(`  ${h(at, 4)}: ${dump(at, 16)}   <- ici`);
}

// The loop reads DS=0, so show low memory and the string-op state. Two candidate explanations for a
// scan that never matches: the data is not what the client expects, or SI is not moving the way STD
// says it should.
{
  const dump = (a, n) => Array.from({ length: n }, (_, i) => h(mc.mem.u8[(a + i) & 0xfffff], 2)).join(' ');
  console.log(`\nmemoire basse (DS=0), la zone balayee :`);
  for (let a = 0x2c0; a < 0x300; a += 16) console.log(`  ${h(a, 4)}: ${dump(a, 16)}`);
  console.log(`  SI=${h(cpu.reg[6] & 0xffff, 4)}  BX=${h(cpu.reg[3] & 0xffff, 4)}  DF=${(cpu.flags >> 10) & 1}  DS=${h(cpu.seg[3], 4)}`);
}

console.log('\nfirst blocks AFTER the switch to protected mode:');
console.log(pmTrace.length ? '  ' + pmTrace.join(' -> ') : '  (none)');

console.log('\nlast blocks executed (oldest first):');
{
  const start = Math.max(0, ri - 26);
  for (let i = start; i < ri; i++) {
    const k = i & MASK;
    console.log(`    ${h(rCs[k])}:${h(rIp[k], 4)}${rN[k] > 1 ? `   (x${rN[k]})` : ''}`);
  }
}

console.log('unimplemented INT 21h functions: ' + (dos.unhandledFnReport().join(' ') || '(none)'));
