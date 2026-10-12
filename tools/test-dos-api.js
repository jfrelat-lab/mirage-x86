// test-dos-api.js — behavioural tests for the DOS (INT 21h) and BIOS (INT 10h/16h/1Ah) services.
//
//   node tools/test-dos-api.js
//
// Why this exists: `conformance.js` is single-instruction 8088 vectors, and `golden.js` hashes demo
// framebuffers. Neither can see `dos.js`, `vfs.js`, `xms.js`, or most of `bios.js` — so the entire
// service layer was unguarded, and a whole class of defect (a call that silently reports success)
// could be introduced or re-introduced with every gate green.
//
// The convention under test is as important as the values: **real DOS clears CF on success and sets
// it on failure with the error code in AX**. A handler that forgets CF makes a guest believe a failed
// call worked, which is exactly how these bugs stay invisible.
//
// Services are invoked by calling the registered handler directly (the same shape `test.js` uses),
// so a test states register-in → register-out without assembling a program.

import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { readFileSync } from 'fs';
import { VFS } from '../src/vfs.js';
import { bootSector, isBootSector } from '../src/boot.js';

const CF = 1;
let pass = 0, fail = 0; const fails = [];
const eq = (name, got, want) => {
  const g = typeof got === 'number' ? got >>> 0 : got, w = typeof want === 'number' ? want >>> 0 : want;
  if (g === w) pass++;
  else { fail++; fails.push(`${name}: got ${typeof g === 'number' ? '0x' + g.toString(16) : g}, want ${typeof w === 'number' ? '0x' + w.toString(16) : w}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };

/** A machine with BIOS+DOS installed and an optional set of files already present. */
function mk(files = {}) {
  // 16 MiB, not 1: extended memory starts AT 1 MiB, so an XMS allocation on a 1 MiB machine
  // correctly has nowhere to go. Loading a program first puts the allocator in the state a real
  // guest sees (PSP built, memFloor/allocTop above the program) rather than its pre-load defaults.
  const mc = new Machine({ memSize: 16 << 20 });
  installBIOS(mc);
  const vfs = new VFS();
  for (const [path, data] of Object.entries(files)) {
    vfs.addFile(path, typeof data === 'string' ? Uint8Array.from([...data].map(c => c.charCodeAt(0))) : data);
  }
  const dos = installDOS(mc, vfs);
  dos.load(Uint8Array.from([0xcd, 0x20]), '', 'C:\\T.COM');      // minimal COM: int 20h
  const cpu = mc.cpu;
  cpu.setSeg(3, 0x100); cpu.setSeg(0, 0x100);                     // DS/ES at the PSP, like a .COM
  return { mc, cpu, dos, vfs };
}
/** Invoke INT 21h with AH=ah (plus any other registers set by `pre`), return {ax, cf}. */
function int21(ctx, ah, pre) {
  const { mc, cpu } = ctx;
  cpu.ah = ah;
  if (pre) pre(cpu, mc);
  cpu.flags |= CF;                       // poison CF: a handler that succeeds must actively clear it
  mc.intHandlers[0x21](cpu, mc);
  return { ax: cpu.reg[0] & 0xffff, cf: cpu.flags & CF, cpu, mc };
}
/** Write an ASCIIZ string into DS:offset and return the offset. */
function asciiz(mc, cpu, off, str) {
  const base = (cpu.seg[3] << 4) + off;
  for (let i = 0; i < str.length; i++) mc.mem.w8(base + i, str.charCodeAt(i));
  mc.mem.w8(base + str.length, 0);
  return off;
}

// ------------------------------------------------- CF survives a CHAINED return (the TSR idiom)
// A program that hooks INT 21h and chains to the saved vector does not `int 21h`: it pushes a flags
// image and far-CALLs f000:21, and our service returns through machine.biosCallback, which pops that
// frame. Restoring the caller's flags verbatim threw away the carry the service had just set, so
// EVERY DOS error was invisible to a hooking program. Windows 3.0's WIN386 hooks INT 21h, and then
// read AX=2 from a failed open as if it were a file handle.
{
  const c = mk();
  const { mc, cpu } = c;
  const off = asciiz(mc, cpu, 0x200, 'C:\\NOSUCH.XYZ');
  cpu.setSeg(2, 0x100); cpu.sp = 0x800;                 // a stack inside the PSP segment
  cpu.ah = 0x3d; cpu.al = 0; cpu.reg[2] = off;
  cpu.flags &= ~CF;                                     // the caller's saved flags have carry CLEAR
  // pushf ; call far f000:0021 ; hlt — exactly what a chaining ISR executes.
  mc.mem.blit((0x100 << 4) + 0x400, Uint8Array.from([0x9c, 0x9a, 0x21, 0x00, 0x00, 0xf0, 0xf4]));
  cpu.setSeg(1, 0x100); cpu.eip = 0x400;
  for (let i = 0; i < 8 && !cpu.halted; i++) mc.rec.step();
  eq('a chained INT 21h reports its error: CF survives the IRET', (cpu.flags & CF) !== 0, true);
  eq('...with the DOS error code in AX', cpu.reg[0] & 0xffff, 2);
}

// ---------------------------------------------------------------- CF convention
// The defect this catches: ~23 INT 21h functions used to `break` without touching CF, so they
// returned whatever the caller had. `stc / mov ah,30h / int 21h / jc no_dos` took the error branch.
{
  const c = mk();
  for (const [name, ah] of [['30h get version', 0x30], ['2Ch get time', 0x2c], ['2Ah get date', 0x2a],
                            ['19h current drive', 0x19], ['0Bh kbd status', 0x0b], ['33h ctrl-break', 0x33]]) {
    const r = int21(c, ah);
    eq(`CF cleared on success: ${name}`, r.cf, 0);
  }
  eq('30h reports a DOS version', int21(c, 0x30).ax & 0xff, 5);
}

// ---------------------------------------------------------------- file handles
{
  const c = mk({ '\\HELLO.TXT': 'hello world' });
  const nameOff = asciiz(c.mc, c.cpu, 0x200, 'C:\\HELLO.TXT');

  const open = int21(c, 0x3d, (cpu) => { cpu.al = 0; cpu.reg[2] = nameOff; });   // DX = name
  eq('3Dh open succeeds (CF clear)', open.cf, 0);
  const fd = open.ax;
  ok('3Dh returns a usable handle', fd >= 5);

  const read = int21(c, 0x3f, (cpu) => { cpu.reg[3] = fd; cpu.reg[1] = 5; cpu.reg[2] = 0x300; }); // BX=fd CX=len DX=buf
  eq('3Fh read succeeds', read.cf, 0);
  eq('3Fh returns the byte count', read.ax, 5);
  const got = [0, 1, 2, 3, 4].map(i => String.fromCharCode(c.mc.mem.r8((c.cpu.seg[3] << 4) + 0x300 + i))).join('');
  eq('3Fh delivered the bytes', got, 'hello');

  const seek = int21(c, 0x42, (cpu) => { cpu.al = 0; cpu.reg[3] = fd; cpu.reg[1] = 0; cpu.reg[2] = 6; }); // SEEK_SET to 6
  eq('42h seek succeeds', seek.cf, 0);
  const read2 = int21(c, 0x3f, (cpu) => { cpu.reg[3] = fd; cpu.reg[1] = 5; cpu.reg[2] = 0x310; });
  const got2 = [0, 1, 2, 3, 4].map(i => String.fromCharCode(c.mc.mem.r8((c.cpu.seg[3] << 4) + 0x310 + i))).join('');
  eq('42h seek repositioned the handle', got2, 'world');

  eq('3Eh close succeeds', int21(c, 0x3e, (cpu) => { cpu.reg[3] = fd; }).cf, 0);
}
{ // opening something that isn't there must FAIL — the important half of the convention
  const c = mk();
  const off = asciiz(c.mc, c.cpu, 0x200, 'C:\\NOPE.TXT');
  const r = int21(c, 0x3d, (cpu) => { cpu.al = 0; cpu.reg[2] = off; });
  eq('3Dh on a missing file sets CF', r.cf, CF);
  eq('3Dh on a missing file reports "file not found"', r.ax, 2);
}
{ // create + write + read back
  const c = mk();
  const off = asciiz(c.mc, c.cpu, 0x200, 'C:\\OUT.TXT');
  const cr = int21(c, 0x3c, (cpu) => { cpu.reg[1] = 0; cpu.reg[2] = off; });
  eq('3Ch create succeeds', cr.cf, 0);
  const fd = cr.ax;
  const base = (c.cpu.seg[3] << 4) + 0x300;
  for (let i = 0; i < 3; i++) c.mc.mem.w8(base + i, 0x41 + i);                    // "ABC"
  const w = int21(c, 0x40, (cpu) => { cpu.reg[3] = fd; cpu.reg[1] = 3; cpu.reg[2] = 0x300; });
  eq('40h write succeeds', w.cf, 0);
  eq('40h returns the byte count', w.ax, 3);
  int21(c, 0x3e, (cpu) => { cpu.reg[3] = fd; });
  const data = c.vfs.readFile('C:\\OUT.TXT');
  eq('40h actually wrote the file', data && String.fromCharCode(...data), 'ABC');
}

// ---------------------------------------------------------------- find first / find next
{
  const c = mk({ '\\A.TXT': 'a', '\\B.TXT': 'b' });
  const off = asciiz(c.mc, c.cpu, 0x200, 'C:\\*.TXT');
  const f1 = int21(c, 0x4e, (cpu) => { cpu.reg[1] = 0; cpu.reg[2] = off; });
  eq('4Eh find-first succeeds', f1.cf, 0);
  const f2 = int21(c, 0x4f);
  eq('4Fh find-next succeeds for the 2nd match', f2.cf, 0);
  const f3 = int21(c, 0x4f);
  eq('4Fh sets CF when the matches run out', f3.cf, CF);
  eq('4Fh reports "no more files"', f3.ax, 18);
}
{ // find-first on a pattern that matches nothing must fail, not report a stale entry
  const c = mk({ '\\A.TXT': 'a' });
  const off = asciiz(c.mc, c.cpu, 0x200, 'C:\\*.ZZZ');
  const r = int21(c, 0x4e, (cpu) => { cpu.reg[1] = 0; cpu.reg[2] = off; });
  eq('4Eh with no match sets CF', r.cf, CF);
}

// ---------------------------------------------------------------- extended keys through AH=08h
{ // Left arrow then "a": 00h, then the scan code 4Bh on the next call, then 61h — what DOSBox-X answers
  // to tools/extkey.asm. The scan code used to be dropped, and Unreal's menu waited for it for ever.
  const c = mk();
  c.mc.keyQueue.push({ scan: 0x4b, ascii: 0 }, { scan: 0x1e, ascii: 0x61 });
  const got = [0, 1, 2].map(() => int21(c, 0x08).ax & 0xff);
  eq('08h: an extended key reads as 00h then its scan code', got.map((v) => v.toString(16)).join(), '0,4b,61');
  c.mc.keyQueue.push({ scan: 0x48, ascii: 0 });
  int21(c, 0x08);
  eq('...and 0Bh reports the waiting scan code as input available', int21(c, 0x0b).ax & 0xff, 0xff);
}

// ---------------------------------------------------------------- 3Fh on the console reads a line
{ // tools/conread.asm under DOSBox-X: a read of handle 0 at the keyboard waits for Enter and returns the
  // line with CR LF, "0004 68690D0A". Ours answered 0 bytes (end of file), and DJGPP's scanf read
  // nothing: Dhrystone ran "0 runs through Dhrystone".
  const c = mk();
  const rd = (n) => int21(c, 0x3f, (cpu) => { cpu.reg[3] = 0; cpu.reg[1] = n; cpu.reg[2] = 0x300; });
  c.mc.blocked = false; rd(10);
  eq('3Fh on the console with no key typed waits', c.mc.blocked, true);
  c.mc.blocked = false;
  c.mc.keyQueue.push({ scan: 0x23, ascii: 0x68 }, { scan: 0x17, ascii: 0x69 }, { scan: 0x1c, ascii: 0x0d });
  const a = rd(10), got = [0, 1, 2, 3].map((i) => c.mc.mem.r8((c.cpu.seg[3] << 4) + 0x300 + i));
  eq('3Fh on the console: the line, CR and LF', JSON.stringify([a.ax, got]), JSON.stringify([4, [0x68, 0x69, 0x0d, 0x0a]]));
}

// ---------------------------------------------------------------- memory (48/49/4A)
{
  const c = mk();
  // A .COM owns all of conventional memory, so AH=48h correctly fails until the program shrinks its
  // own block — which is exactly why real programs call AH=4Ah first. Test that sequence.
  const noRoom = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x10; });
  eq('48h fails while the program still owns all memory', noRoom.cf, CF);

  const shrink = int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x200; }); // ES=PSP BX=paras
  eq('4Ah shrink succeeds', shrink.cf, 0);

  const a = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x10; });      // BX = paragraphs
  eq('48h alloc succeeds once the block is shrunk', a.cf, 0);
  const seg = a.ax;
  ok('48h returns a segment above the program', seg > c.dos.psp);
  const b = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x10; });
  ok('48h twice returns distinct blocks', b.ax !== seg);
  ok('48h blocks do not overlap', b.ax >= seg + 0x10);
  eq('49h free succeeds for a live block', int21(c, 0x49, (cpu) => { cpu.setSeg(0, seg); }).cf, 0);
}
{ // Every block AH=48h hands out has its MCB in the paragraph before it, and the chain is walkable
  // from the program's MCB to the 'Z' block at the top, holes included. Future Crew's Unreal loader
  // checks the MCB in front of its block and stopped with "Block allocation error!" without it.
  const c = mk(), m = c.mc.mem;
  int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x200; });
  const a = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x10; }).ax;
  const b = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x20; }).ax;
  const mcb = (seg) => [String.fromCharCode(m.r8(seg << 4)), m.r16((seg << 4) + 1), m.r16((seg << 4) + 3)];
  eq('48h: the block has an MCB in front of it, owned by the program, of its size', mcb(a - 1).join(), ['M', c.dos.psp, 0x10].join());
  eq('...and the next block is one paragraph further, after that MCB', b, a + 0x10 + 1);
  int21(c, 0x49, (cpu) => { cpu.setSeg(0, a); });
  const walk = []; let seg = c.dos.psp - 1;
  for (let i = 0; i < 10; i++) { const [sig, owner, size] = mcb(seg); walk.push(`${sig}${owner ? 'u' : 'f'}${size.toString(16)}`); if (sig === 'Z') break; seg += size + 1; }
  eq('...after freeing the first, the chain is program, free hole, block, free rest', walk.join(' '), `M${'u'}200 Mf10 Mu20 Zf${(0x9fff - (b + 0x20) - 1).toString(16)}`);
  eq('...the chain ends at the top of conventional memory', seg + mcb(seg)[2] + 1, 0x9fff);
  const again = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x08; }).ax;
  eq('...and first fit reuses the hole', again, a); }
{ // AH=58h strategies, as tools/memstrat.asm reads them on MS-DOS 6.22 (in QEMU), DOSBox-X and MIRAGE:
  // holes A (200h) and C (80h) above the program, then a 40h block under each strategy goes to A
  // (first fit), C (best fit) or the top of memory (last fit). Fractint asks for last fit and then
  // grows its own block; with every strategy treated as first fit it stopped with R6009.
  const c = mk();
  int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x1000; });
  const al = (n) => int21(c, 0x48, (cpu) => { cpu.reg[3] = n; }).ax;
  const A = al(0x200); al(0x10); const C = al(0x80); al(0x10);
  int21(c, 0x49, (cpu) => { cpu.setSeg(0, A); }); int21(c, 0x49, (cpu) => { cpu.setSeg(0, C); });
  const placed = [0, 1, 2].map((st) => {
    int21(c, 0x58, (cpu) => { cpu.reg[0] = 0x5801; cpu.reg[3] = st; });
    const x = al(0x40); int21(c, 0x49, (cpu) => { cpu.setSeg(0, x); }); return x;
  });
  eq('58h/48h: first fit takes the first hole, best fit the smallest, last fit the top of memory',
    placed.map((x) => (x - c.dos.psp).toString(16)).join(), ['1001', '1213', (0x9fff - 0x40 - c.dos.psp).toString(16)].join()); }
{ // an impossible allocation must fail AND report the largest block available in BX
  const c = mk();
  const r = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0xffff; });
  eq('48h over-large alloc sets CF', r.cf, CF);
  eq('48h over-large alloc reports "insufficient memory"', r.ax, 8);
}

{ // an EXEC'd child's block is sized from its OWN header, like the parent's. While the MZ parser
  // was duplicated this half of the e_maxalloc fix never reached the EXEC path, so a child that
  // asked for a bounded block was handed all of memory and its own AH=48h then had nowhere to go.
  const c = mk();
  const parentPsp = c.dos.psp;
  int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x200; });   // parent shrinks, as a stub loader does
  // minimal MZ: 1 page, header 1 para, no relocs, minalloc=0, maxalloc=0x10 (a bounded request)
  const mz = new Uint8Array(48);
  const w = (o, v) => { mz[o] = v & 0xff; mz[o + 1] = v >> 8; };
  mz[0] = 0x4d; mz[1] = 0x5a; w(2, 48 % 512); w(4, 1); w(6, 0); w(8, 1);
  w(0x0a, 0); w(0x0c, 0x10); w(0x0e, 0); w(0x10, 0x100); w(0x14, 0); w(0x16, 0); w(0x18, 0x1c);
  mz[16] = 0xcd; mz[17] = 0x20;                       // the image itself: int 20h
  c.vfs.addFile('\\CHILD.EXE', mz);
  const nameOff = asciiz(c.mc, c.cpu, 0x200, 'C:\\CHILD.EXE');
  const pb = 0x280; for (let i = 0; i < 14; i++) c.mc.mem.w8((c.cpu.seg[3] << 4) + pb + i, 0);
  const r = int21(c, 0x4b, (cpu) => { cpu.al = 0; cpu.reg[2] = nameOff; cpu.setSeg(0, cpu.seg[3]); cpu.reg[3] = pb; });
  eq('4Bh EXEC succeeds', r.cf, 0);
  // Derived from the PSP, not hard-coded: G1 moved it from 0x0100 to the measured 0x0814 and every
  // literal here had to change. The parent shrinks to 0x200 paragraphs, so the free block's MCB
  // header lands at parentPsp + 0x200 and the child's PSP one paragraph above it — the header lives
  // BELOW the PSP it describes, exactly as the parent's does at PSP-1. The child's block is
  // PSP(0x10) + 32-byte image(2) + maxalloc(0x10) = 0x22 paragraphs.
  const childMcb = parentPsp + 0x200, childPsp = childMcb + 1;
  eq('EXEC child block is header-sized, not all of memory', c.dos.allocTop, childPsp + 0x22);
  eq('...and the child PSP leaves its MCB header a paragraph', c.dos.psp, childPsp);
  eq('...which describes the child block', String.fromCharCode(c.mc.mem.r8(childMcb << 4)), 'M');
  eq('...and is owned by the child', c.mc.mem.r16((childMcb << 4) + 1), childPsp);
}

// ---------------------------------------------------------------- DTA get/set round-trip
{
  const c = mk();
  const want = (c.cpu.seg[3] << 4) + 0x456;
  int21(c, 0x1a, (cpu) => { cpu.reg[2] = 0x456; });               // set DTA to DS:0456
  const g = int21(c, 0x2f);                                       // get DTA into ES:BX
  // Assert the linear address: DOS hands back a seg:off pair, and ours is normalised
  // (ES:BX = 0145:0006 for DS:DX = 0100:0456) — same address, different split.
  eq('1Ah/2Fh DTA round-trips the address', ((g.cpu.seg[0] << 4) + (g.cpu.reg[3] & 0xffff)) >>> 0, want >>> 0);
}

// ---------------------------------------------------------------- unhandled services
// MS-DOS 6.22 (tools/lfnprobe.asm under QEMU, DOSBox-X alike): AL = 0, the carry left as it came in.
// AH=71h, the long-name calls, are among them, and DJGPP reads AX = 7100h as "no long names here".
{
  const c = mk();
  const r = int21(c, 0xfe);                                       // no such function, CF set going in
  eq('an unimplemented INT 21h function answers AL = 0', r.ax, 0xfe00);
  eq('...and leaves a carry that was set', r.cf, CF);
  c.cpu.ax = 0x71a0; c.cpu.flags &= ~CF; c.mc.intHandlers[0x21](c.cpu, c.mc);
  eq('...71A0h with the carry clear: AX = 7100h, still clear', `${(c.cpu.ax & 0xffff).toString(16)} ${c.cpu.flags & CF}`, '7100 0');
}
{ // the F000 segment is ours only while OUR stub is still there
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const cpu = mc.cpu;
  // A guest that replaces the ROM owns its vectors. test386.asm does exactly that — it IS the BIOS —
  // and we were swallowing its #UD handler and spinning on the faulting instruction forever.
  mc.mem.blit(0xf0000 + 0x40, Uint8Array.from([0xb8, 0x99, 0x99, 0xcf]));   // mov ax,9999h ; iret
  mc.setVector(0x40, 0xf000, 0x40);
  cpu.setSeg(2, 0x3000); cpu.sp = 0x100; cpu.reg[0] = 0;
  mc.swInt(0x40);
  eq('a guest handler inside F000 is entered, not swallowed', (cpu.seg[1] << 16) | (cpu.eip & 0xffff), (0xf000 << 16) | 0x40);
  eq('...and our own IRET stub still takes the unhandled path', (mc.mem.u8[0xf0000 + 0x41] !== 0xcf), true);
}

{ // and an interrupt we don't implement at all must not read as success
  const { mc, cpu } = mk();
  cpu.flags &= ~CF;
  mc.swInt(0x18);                                                 // ROM BASIC — not implemented
  eq('an unhandled INT sets CF', cpu.flags & CF, CF);
  eq('an unhandled INT is counted', mc.unhandledInts[0x18], 1);
  ok('unhandledIntReport names the vector', mc.unhandledIntReport().includes('INT 18h'));
}

// ---------------------------------------------------------------- BIOS: INT 10h / 16h / 1Ah
{
  const { mc, cpu } = mk();
  cpu.ah = 0x0f; mc.intHandlers[0x10](cpu, mc);                   // get video mode
  eq('INT 10h AH=0Fh reports the current mode', cpu.reg[0] & 0xff, 3);
  eq('INT 10h AH=0Fh reports the column count', (cpu.reg[0] >> 8) & 0xff, 80);
}
{
  const { mc, cpu } = mk();
  cpu.ah = 0x00; cpu.al = 0x13; mc.intHandlers[0x10](cpu, mc);    // set mode 13h
  eq('INT 10h AH=00 sets the BDA mode byte', mc.mem.r8(0x449), 0x13);
  cpu.ah = 0x0f; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h AH=0Fh reflects the new mode', cpu.reg[0] & 0xff, 0x13);
}
{ // cursor position round-trip through the BDA
  const { mc, cpu } = mk();
  cpu.ah = 0x02; cpu.reg[2] = (7 << 8) | 12; cpu.reg[3] = 0;      // DH=row DL=col
  mc.intHandlers[0x10](cpu, mc);
  cpu.ah = 0x03; cpu.reg[3] = 0; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h AH=02/03 round-trips the cursor row', (cpu.reg[2] >> 8) & 0xff, 7);
  eq('INT 10h AH=02/03 round-trips the cursor column', cpu.reg[2] & 0xff, 12);
}
{ // INT 16h AH=01 must report "no key" via ZF, and AH=00 must return a queued key
  const { mc, cpu } = mk();
  cpu.ah = 0x01; mc.intHandlers[0x16](cpu, mc);
  ok('INT 16h AH=01 sets ZF when the buffer is empty', (cpu.flags & 0x40) !== 0);
  mc.keyQueue.push({ ascii: 0x41, scan: 0x1e });
  cpu.ah = 0x01; mc.intHandlers[0x16](cpu, mc);
  ok('INT 16h AH=01 clears ZF when a key is waiting', (cpu.flags & 0x40) === 0);
  eq('INT 16h AH=01 previews the key without consuming it', mc.keyQueue.length, 1);
  cpu.ah = 0x00; mc.intHandlers[0x16](cpu, mc);
  eq('INT 16h AH=00 returns the key', cpu.reg[0] & 0xffff, (0x1e << 8) | 0x41);
  eq('INT 16h AH=00 consumed it', mc.keyQueue.length, 0);
}
{ // INT 1Ah AH=00 returns the BDA tick count
  const { mc, cpu } = mk();
  mc.mem.w32(0x46c, 0x00012345);
  cpu.ah = 0x00; mc.intHandlers[0x1a](cpu, mc);
  eq('INT 1Ah AH=00 returns the tick count in CX:DX',
    (((cpu.reg[1] & 0xffff) << 16) | (cpu.reg[2] & 0xffff)) >>> 0, 0x00012345);
}

// ---------------------------------------------------------------- video quick wins
{ // AH=0Ch/0Dh write/read pixel in mode 13h — used to be swallowed by `default`, so a program
  // plotting through the BIOS drew nothing at all and got no error.
  const { mc, cpu } = mk();
  cpu.ah = 0x00; cpu.al = 0x13; mc.intHandlers[0x10](cpu, mc);
  cpu.ah = 0x0c; cpu.al = 0x2a; cpu.reg[1] = 10; cpu.reg[2] = 5; mc.intHandlers[0x10](cpu, mc);  // CX=x DX=y
  eq('INT 10h AH=0Ch writes the pixel (mode 13h)', mc.mem.r8(0xa0000 + 5 * 320 + 10), 0x2a);
  cpu.ah = 0x0d; cpu.al = 0; cpu.reg[1] = 10; cpu.reg[2] = 5; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h AH=0Dh reads it back', cpu.reg[0] & 0xff, 0x2a);
}
{ // AH=0Ch in a planar EGA mode must go through the plane pipeline
  const { mc, cpu } = mk();
  cpu.ah = 0x00; cpu.al = 0x0d; mc.intHandlers[0x10](cpu, mc);
  cpu.ah = 0x0c; cpu.al = 0x09; cpu.reg[1] = 3; cpu.reg[2] = 1; mc.intHandlers[0x10](cpu, mc);
  cpu.ah = 0x0d; cpu.al = 0; cpu.reg[1] = 3; cpu.reg[2] = 1; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h AH=0Ch/0Dh round-trip a planar pixel', cpu.reg[0] & 0x0f, 0x09);
}
{ // AH=01 cursor shape: CH bit 5 hides it, and AH=03 must report what was set (not a constant)
  const { mc, cpu } = mk();
  cpu.ah = 0x01; cpu.reg[1] = (0x20 << 8) | 0x00; mc.intHandlers[0x10](cpu, mc);
  ok('INT 10h AH=01 CH bit5 hides the cursor', mc.bios.cursor.hidden);
  cpu.ah = 0x01; cpu.reg[1] = (0x06 << 8) | 0x07; mc.intHandlers[0x10](cpu, mc);
  ok('INT 10h AH=01 un-hides it', !mc.bios.cursor.hidden);
  cpu.ah = 0x03; cpu.reg[3] = 0; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h AH=03 reports the shape that was set', cpu.reg[1] & 0xffff, 0x0607);
}
{ // AH=10h AL=03 toggles blink vs bright-background; AL=17h reads a DAC block back
  const { mc, cpu } = mk();
  cpu.ah = 0x10; cpu.al = 0x03; cpu.reg[3] = 0; mc.intHandlers[0x10](cpu, mc);
  ok('INT 10h AH=10h AL=03 can disable blink', mc.bios.blink === false);
  cpu.ah = 0x10; cpu.al = 0x03; cpu.reg[3] = 1; mc.intHandlers[0x10](cpu, mc);
  ok('INT 10h AH=10h AL=03 can re-enable blink', mc.bios.blink === true);
  mc.bios.dac[3] = 11; mc.bios.dac[4] = 22; mc.bios.dac[5] = 33;                 // DAC entry 1
  cpu.ah = 0x10; cpu.al = 0x17; cpu.reg[3] = 1; cpu.reg[1] = 1; cpu.reg[2] = 0x600; cpu.setSeg(0, 0x100);
  mc.intHandlers[0x10](cpu, mc);
  const p = (0x100 << 4) + 0x600;
  eq('INT 10h AH=10h AL=17h reads the DAC back (r,g,b)',
    (mc.mem.r8(p) << 16) | (mc.mem.r8(p + 1) << 8) | mc.mem.r8(p + 2), (11 << 16) | (22 << 8) | 33);
}
{ // 0x3BA mirrors 0x3DA. Unregistered it read 0xFF — bit 3 always set — so a "wait for retrace to
  // END" loop never exited: a hang, not a glitch.
  const { mc } = mk();
  const a = mc.ioRead(0x3da, 1), b = mc.ioRead(0x3ba, 1);
  eq('0x3BA mirrors 0x3DA', b & 0x09, a & 0x09);
  ok('0x3BA is not stuck at 0xFF', b !== 0xff);
}
{ // 0x3C6 (pixel mask) is a real register — the standard VGA probe writes and reads it back
  const { mc } = mk();
  mc.ioWrite(0x3c6, 1, 0x5a);
  eq('0x3C6 pixel mask round-trips', mc.ioRead(0x3c6, 1), 0x5a);
  mc.ioWrite(0x3c6, 1, 0xff);
}
{ // read mode 1 (colour compare): after filling a byte with colour 9, comparing against 9 must
  // return all-ones for those pixels. Read mode 0 would return raw plane data instead.
  const { mc, cpu } = mk();
  cpu.ah = 0x00; cpu.al = 0x0d; mc.intHandlers[0x10](cpu, mc);
  const vga = mc.vga;
  vga.gc[0] = 0x09; vga.gc[1] = 0x0f; vga.gc[5] = 0; vga.gc[8] = 0xff;   // write mode 0, set/reset = 9
  vga.writeByte(0, 0);
  vga.gc[5] = 0x08; vga.gc[2] = 0x09; vga.gc[7] = 0x0f;                  // read mode 1, compare 9, care all
  eq('read mode 1 reports a full match', vga.readByte(0), 0xff);
  vga.gc[2] = 0x0a;                                                      // compare against a colour we did not write
  eq('read mode 1 reports no match', vga.readByte(0), 0x00);
  vga.gc[5] = 0;                                                         // back to read mode 0
}
{ // a mode set must reload the CRTC, or the previous mode's offset/start shears the new one
  const { mc, cpu } = mk();
  cpu.ah = 0x00; cpu.al = 0x13; mc.intHandlers[0x10](cpu, mc);
  mc.vga.crtc[0x13] = 32; mc.vga.crtc[0x0c] = 0x12; mc.vga.crtc[0x0d] = 0x34;   // a Mode-X-ish setup
  cpu.ah = 0x00; cpu.al = 0x13; mc.intHandlers[0x10](cpu, mc);                  // re-set the mode
  eq('mode set restores the standard offset', mc.vga.crtc[0x13], 40);
  eq('mode set clears the display start', mc.vga.startAddr(), 0);
}

// ---------------------------------------------------------------- second survey batch
// AH=29h (Ski or Die), AH=38h (OMF), INT 03h (1578 calls from LOOM's bundled !RAWCOPY.EXE), plus
// three audit items in the same area: IOCTL ignoring AL, free accepting any segment, PSP:0002.
{
  const c = mk();
  // INT 03h is a breakpoint: its real vector is a bare IRET, which RESTORES the flags. Setting CF
  // makes a debugger-detection routine conclude a debugger is attached.
  c.cpu.flags &= ~CF;
  c.mc.swInt(0x03);
  eq('INT 03h leaves the flags alone', c.cpu.flags & CF, 0);
  // Not a gap either: a bare IRET IS the correct default vector, so it must not show up in the
  // survey as something the corpus asked for and did not get.
  eq('INT 03h is not reported as unimplemented', c.mc.unhandledInts[0x03], 0);
  c.cpu.flags &= ~CF;
  c.mc.swInt(0x18);                                             // a genuinely unsupported vector (ROM BASIC)
  eq('an unsupported vector still reports failure', c.cpu.flags & CF, CF);
  // INT 2Ah AH=00: "is a network installed?" — AL=0 means no. Returning CF read as "installed, and
  // erroring", which is a different and worse answer.
  c.cpu.ah = 0x00; c.cpu.flags |= CF;
  c.mc.intHandlers[0x2a](c.cpu, c.mc);
  eq('INT 2Ah AH=00 clears CF', c.cpu.flags & CF, 0);
  eq('INT 2Ah AH=00 reports no network', c.cpu.reg[0] & 0xffff, 0);
}
{ // AH=29h — parse a filename into an FCB
  const c = mk();
  const at = (off, s) => asciiz(c.mc, c.cpu, off, s);
  const fcbOff = 0x300;
  const parse = (text, al = 0) => {
    at(0x200, text);
    c.cpu.reg[6] = 0x200; c.cpu.setSeg(0, c.cpu.seg[3]); c.cpu.reg[7] = fcbOff;
    return int21(c, 0x29, (cpu) => { cpu.al = al; });
  };
  const fcbStr = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(c.mc.mem.r8((c.cpu.seg[0] << 4) + fcbOff + off + i));
    return s;
  };
  parse('GAME.TDT');
  eq('29h fills the 8-character name, blank padded', fcbStr(1, 8), 'GAME    ');
  eq('29h fills the extension', fcbStr(9, 3), 'TDT');
  eq('29h reports no wildcard', c.cpu.reg[0] & 0xff, 0);
  eq('29h leaves the drive as "default"', c.mc.mem.r8((c.cpu.seg[0] << 4) + fcbOff), 0);

  parse('B:SAVE*.D?T');
  eq('29h takes the drive letter', c.mc.mem.r8((c.cpu.seg[0] << 4) + fcbOff), 2);
  eq('29h expands * to ? across the field', fcbStr(1, 8), 'SAVE????');
  eq('29h keeps a literal ?', fcbStr(9, 3), 'D?T');
  eq('29h reports the wildcard in AL', c.cpu.reg[0] & 0xff, 1);
  // 16 bytes and no more: tools/fcbparse.asm, MS-DOS 6.22 under QEMU and DOSBox-X alike. Watcom C's exec
  // parses the FCB at PSP 6Ch after copying the command line to 80h; 37 bytes wiped it (C-Dogs).
  for (let i = 0; i < 48; i++) c.mc.mem.w8((c.cpu.seg[0] << 4) + fcbOff + i, 0xaa);
  parse('c:name.ext', 1);
  eq('29h writes 16 bytes, and leaves what follows', fcbStr(16, 4), '\xaa\xaa\xaa\xaa');
  eq('29h uppercases', (parse('lower.txt'), fcbStr(1, 8)), 'LOWER   ');
}
{ // AH=38h — country info
  const c = mk();
  const r = int21(c, 0x38, (cpu) => { cpu.al = 0; cpu.reg[2] = 0x300; });
  eq('38h clears CF', r.cf, 0);
  eq('38h reports the country code in BX', c.cpu.reg[3] & 0xffff, 1);
  const p = (c.cpu.seg[3] << 4) + 0x300;
  eq('38h: date format is MM/DD/YY', c.mc.mem.r16(p), 0);
  eq('38h: currency symbol', String.fromCharCode(c.mc.mem.r8(p + 2)), '$');
  eq('38h: decimal separator', String.fromCharCode(c.mc.mem.r8(p + 9)), '.');
  eq('38h with DX=FFFF (set country) fails', int21(c, 0x38, (cpu) => { cpu.al = 0; cpu.reg[2] = 0xffff; }).cf, CF);
}
{ // AH=44h IOCTL used to ignore AL, so AL=06/07 always answered "ready"
  const c = mk({ '\\F.TXT': 'x' });
  const off = asciiz(c.mc, c.cpu, 0x200, 'C:\\F.TXT');
  const fd = int21(c, 0x3d, (cpu) => { cpu.al = 0; cpu.reg[2] = off; }).ax;
  eq('44h AL=00 reports a character device for stdin', int21(c, 0x44, (cpu) => { cpu.al = 0; cpu.reg[3] = 0; }).ax & 0x80, 0x80);
  eq('44h AL=06 says an open file is ready to read', int21(c, 0x44, (cpu) => { cpu.al = 6; cpu.reg[3] = fd; }).ax & 0xff, 0xff);
  eq('44h AL=06 on a bogus handle fails', int21(c, 0x44, (cpu) => { cpu.al = 6; cpu.reg[3] = 0x99; }).cf, CF);
  eq('44h with an unknown subfunction fails', int21(c, 0x44, (cpu) => { cpu.al = 0x7f; cpu.reg[3] = 0; }).cf, CF);
}
{ // PSP:0002, "first paragraph past this program's block". Measured with tools/mem.asm rather than
  // reasoned about: dosbox-x gives a .COM 0x9FFF, and STILL 0x9FFF after it shrinks to 0x100
  // paragraphs. So the loader writes it once, from the block it hands over, and AH=4Ah does not
  // revise it. We used to follow the shrink — the reasoning was that a program sizing its heap from
  // a stale number would go wrong, and the oracle says the stale number is exactly what DOS gives.
  const c = mk();
  eq('PSP:0002 is the top of memory for a .COM, which owns everything',
     c.mc.mem.r16((c.dos.psp << 4) + 2), 0x9fff);
  int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x200; });   // shrink to 0x200 paras
  eq('PSP:0002 does NOT follow a shrink', c.mc.mem.r16((c.dos.psp << 4) + 2), 0x9fff);
}
{ // AH=49h accepted any segment, so a double free looked fine and left the allocator wrong
  const c = mk();
  int21(c, 0x4a, (cpu) => { cpu.setSeg(0, c.dos.psp); cpu.reg[3] = 0x200; });
  const seg = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0x10; }).ax;
  eq('49h frees a block we handed out', int21(c, 0x49, (cpu) => { cpu.setSeg(0, seg); }).cf, 0);
  const twice = int21(c, 0x49, (cpu) => { cpu.setSeg(0, seg); });
  eq('49h refuses a double free', twice.cf, CF);
  eq('49h reports "invalid memory block address"', twice.ax, 9);
}

// ---------------------------------------------------------------- the 8259 PIC
// Before this there was `onPortWrite(0x20, () => {})`: no IRR, no ISR, a no-op EOI, and interrupts
// delivered straight from the device. A guest that masked an IRQ still received it, and an ISR
// that had not finished could not hold off the next one.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const pic = mc.pic;

  pic.raise(0);
  eq('a raised IRQ shows in the request register', mc.ioRead(0x20, 1) & 1, 1);
  eq('...and is what the CPU would take', pic.pending(), 0);
  eq('acknowledging returns the vector', pic.acknowledge(), 0x08);
  mc.ioWrite(0x20, 1, 0x0b);                                    // OCW3: read ISR instead of IRR
  eq('...and moves the bit to the in-service register', mc.ioRead(0x20, 1) & 1, 1);

  // In-service state is the point: a second IRQ0 cannot be taken until the first ends.
  pic.raise(0);
  eq('an in-service IRQ blocks the next one at the same level', pic.pending(), -1);
  mc.ioWrite(0x20, 1, 0x20);                                    // non-specific EOI
  eq('EOI clears the in-service bit', mc.ioRead(0x20, 1) & 1, 0);
  eq('...and the queued request is taken', pic.pending(), 0);
  pic.acknowledge(); mc.ioWrite(0x20, 1, 0x20);

  // Priority: IRQ0 outranks IRQ1, and an open IRQ0 blocks IRQ1 too.
  pic.raise(1); pic.raise(0);
  eq('the higher-priority line wins', pic.pending(), 0);
  pic.acknowledge();
  eq('an open higher-priority ISR blocks the lower one', pic.pending(), -1);
  mc.ioWrite(0x20, 1, 0x20);
  eq('...which is taken once the first ends', pic.pending(), 1);
  eq('IRQ1 maps to INT 09h', pic.acknowledge(), 0x09);
  mc.ioWrite(0x20, 1, 0x61);                                    // specific EOI for level 1
  eq('a specific EOI clears its own level', mc.ioRead(0x20, 1) & 2, 0);

  // The mask.
  mc.ioWrite(0x21, 1, 0x01);
  pic.raise(0);
  eq('a masked line is not delivered', pic.pending(), -1);
  ok('...but is still requested', (mc.ioWrite(0x20, 1, 0x0a), mc.ioRead(0x20, 1) & 1) === 1);
  mc.ioWrite(0x21, 1, 0x00);
  eq('unmasking releases it', pic.pending(), 0);
  pic.acknowledge(); mc.ioWrite(0x20, 1, 0x20);

  // ICW sequence: a guest that re-initialises the pair can move the vector base.
  mc.ioWrite(0x20, 1, 0x11);                                    // ICW1: cascade, expect ICW4
  mc.ioWrite(0x21, 1, 0x50);                                    // ICW2: vectors at 0x50
  mc.ioWrite(0x21, 1, 0x04);                                    // ICW3
  mc.ioWrite(0x21, 1, 0x01);                                    // ICW4: 8086 mode
  pic.raise(0);
  eq('after re-initialisation IRQ0 uses the new vector base', pic.acknowledge(), 0x50);
  mc.ioWrite(0x20, 1, 0x20);
  eq('ICW1 clears the mask', mc.ioRead(0x21, 1), 0x00);

  // The cascade: a slave line raises the master's IRQ2 and vectors from the slave's base.
  pic.reset();
  pic.raise(12);                                                // IRQ12 = slave line 4
  eq('a slave request appears on the master cascade line', (mc.ioWrite(0x20, 1, 0x0a), mc.ioRead(0x20, 1)) & 4, 4);
  eq('...and vectors from the slave base', pic.acknowledge(), 0x74);
}
{ // end to end: masking IRQ0 stops the timer reaching a guest ISR
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  // What these assert is whether the tick MOVES, so they read a delta. The tick no longer starts at
  // zero: installRTC seeds it to 08:00, the way a real BIOS seeds it from the clock at POST, and
  // asserting the absolute value silently turned this into a test of the epoch.
  const tick0 = mc.mem.r32(0x46c) >>> 0;
  mc.setVector(8, 0x2000, 0x100);                               // pretend a guest hooked INT 8
  mc.cpu.setSeg(2, 0x4000); mc.cpu.sp = 0x200; mc.cpu.flags |= 0x200;
  const sp0 = mc.cpu.sp & 0xffff;
  mc.tickTimer();
  ok('an unmasked timer tick enters the guest ISR', (mc.cpu.sp & 0xffff) === ((sp0 - 6) & 0xffff));
  mc.pic.eoi(0);
  mc.ioWrite(0x21, 1, 0x01);                                    // mask IRQ0
  const sp1 = mc.cpu.sp & 0xffff;
  mc.tickTimer();
  eq('a masked timer tick does not', mc.cpu.sp & 0xffff, sp1);
  // 0040:006C is a SOFTWARE counter kept by the BIOS INT 8 handler, not the PIT counter. Measured on
  // dosbox-x with tools/tickq.asm and its own control: IRQ0 unmasked "BDA TICK ADVANCED", IRQ0 masked
  // "BDA TICK FROZEN". This assertion used to claim the opposite ("the counter is not the
  // interrupt"), and machine.tickTimer bumped the tick per PIT tick to match — so a game that
  // reprograms counter 0 ran the BDA clock at ITS rate (Monkey Island: 473 Hz) instead of 18.2 Hz.
  eq('...and the BDA tick does not advance either: it is the BIOS ISR that keeps it',
     (mc.mem.r32(0x46c) >>> 0) - tick0, 0);
  // A guest ISR that never chains to f000:08 freezes the DOS clock — the period-correct behaviour,
  // and why games chain.
  mc.ioWrite(0x21, 1, 0x00);                                    // unmask
  mc.pic.eoi(0);
  mc.tickTimer();
  eq('a guest ISR that does not chain leaves the BDA tick alone', (mc.mem.r32(0x46c) >>> 0) - tick0, 0);
  // With no guest ISR we ARE the BIOS handler, so the tick advances.
  const mc2 = new Machine({ memSize: 1 << 20 });
  installBIOS(mc2);
  mc2.cpu.setSeg(2, 0x4000); mc2.cpu.sp = 0x200; mc2.cpu.flags |= 0x200;
  const t2 = mc2.mem.r32(0x46c) >>> 0;
  mc2.tickTimer();
  eq('with no guest ISR the BIOS handler advances the tick', (mc2.mem.r32(0x46c) >>> 0) - t2, 1);
}

// ---------------------------------------------------------------- ports the corpus hammers
// From tools/survey-ports.mjs. 0x61 had no handler at all and takes 37205 reads / 102563 writes
// across nearly every game; 0x21 takes 23 reads and 23 writes.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);

  // An unregistered read returns all-ones, so "save the IMR, mask my IRQ, restore it" read 0xFF and
  // restored 0xFF — every interrupt masked, including the timer.
  mc.ioWrite(0x21, 1, 0xfe);
  eq('the PIC mask register reads back what was written', mc.ioRead(0x21, 1), 0xfe);
  mc.ioWrite(0xa1, 1, 0x0f);
  eq('...on the slave too', mc.ioRead(0xa1, 1), 0x0f);

  // Port 0x61: the low bits read back, and bit 4 (the RAM-refresh toggle) must actually toggle —
  // a delay loop that counts flips spins forever against a stuck value.
  mc.ioWrite(0x61, 1, 0x03);
  eq('port 0x61 reads back the speaker gate bits', mc.ioRead(0x61, 1) & 0x03, 0x03);
  const seen = new Set();
  for (let i = 0; i < 64; i++) { mc.cpu.cycles += 10; seen.add(mc.ioRead(0x61, 1) & 0x10); }
  eq('port 0x61 bit 4 toggles as time passes', seen.size, 2);

  // The OPL is mirrored at the SB16 stereo bases too, because BLASTER advertises T6 (an SB16).
  // Claiming a card at a base we then ignore is the inconsistency: a game driving the FM at
  // 0x220/0x222 wrote into nothing and read 0xFF from the status port.
  // The timers are bank-0 registers: an index written at 222h selects bank 1, whose register 04h is
  // the OPL3's four-operator select, not the timer control. There only the status read is mirrored.
  for (const base of [0x388, 0x228, 0x220]) {
    mc.ioWrite(base, 1, 0x04); mc.ioWrite(base + 1, 1, 0x80);   // timer control: reset
    eq(`OPL status reads clear at base 0x${base.toString(16)}`, mc.ioRead(base, 1), 0x00);
    mc.ioWrite(base, 1, 0x02); mc.ioWrite(base + 1, 1, 0x00);   // timer 1 preset 0: 256 x 80 us
    mc.ioWrite(base, 1, 0x04); mc.ioWrite(base + 1, 1, 0x21);   // start timer 1
    // Not at once: the chip counts 20.48 ms (tools/oplprobe.asm, DOSBox-X and QEMU: T1=5F70h PIT ticks).
    eq(`OPL timer 1 has not expired the moment it starts, at base 0x${base.toString(16)}`, mc.ioRead(base, 1), 0x00);
    mc.cpu.cycles += Math.ceil(0.025 * 18.2065 * mc.pitBase);  // 25 ms of machine time
    eq(`OPL timer-expired shows at base 0x${base.toString(16)}`, mc.ioRead(base, 1), 0xc0);
  }
  eq('...and the status reads the same at 0x222', mc.ioRead(0x222, 1), mc.ioRead(0x220, 1));

  // PIT channel 2 drives the speaker tone; its counter has to count.
  mc.ioWrite(0x42, 1, 0x00); mc.ioWrite(0x42, 1, 0x10);        // reload 0x1000, LSB then MSB
  const c1 = mc.ioRead(0x42, 1) | (mc.ioRead(0x42, 1) << 8);
  mc.cpu.cycles += 0x400;
  const c2 = mc.ioRead(0x42, 1) | (mc.ioRead(0x42, 1) << 8);
  ok(`PIT channel 2 counts down (${c1} then ${c2})`, c1 !== c2);
}

// ---------------------------------------------------------------- blocking on the far-call path
// Audit T1.3, "élevé, silencieux". A guest can reach a BIOS service two ways: `INT n`, or by reading
// the vector, pushing an IRET frame and far-JMP/CALLing f000:n — the ubiquitous TSR/game pattern.
// On the second path, biosCallback popped the frame unconditionally right after the handler ran,
// which overwrote the rewind block() had just done: the guest never re-asked, `blocked` stayed set,
// and AX was never loaded with the key.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const cpu = mc.cpu;
  const SS = 0x3000, RET_CS = 0x1234, RET_IP = 0x5678;
  cpu.setSeg(2, SS); cpu.sp = 0x100;
  cpu.push16(0x0202); cpu.push16(RET_CS); cpu.push16(RET_IP);   // the IRET frame the guest pushes
  const spAfterPush = cpu.sp & 0xffff;

  cpu.ah = 0x00;                                                 // INT 16h AH=00: wait for a key
  mc.keyQueue.length = 0;
  mc.biosCallback(0x16);
  ok('a blocking service on the far-call path sets blocked', mc.blocked);
  eq('...leaves the caller\'s IRET frame on the stack', cpu.sp & 0xffff, spAfterPush);
  eq('...and re-enters the BIOS entry, not the caller', (cpu.seg[1] << 16) | (cpu.eip & 0xffff), (0xf000 << 16) | 0x16);

  mc.blocked = false;
  mc.keyQueue.push({ ascii: 0x41, scan: 0x1e });                 // 'A'
  mc.biosCallback(0x16);
  ok('once the key arrives the service completes', !mc.blocked);
  eq('...loading AL with the character', cpu.reg[0] & 0xff, 0x41);
  eq('...and AH with the scan code', (cpu.reg[0] >> 8) & 0xff, 0x1e);
  eq('...consuming the IRET frame exactly once', cpu.sp & 0xffff, (spAfterPush + 6) & 0xffff);
  eq('...and returning to the caller', (cpu.seg[1] << 16) | (cpu.eip & 0xffff), (RET_CS << 16) | RET_IP);
}
{ // the INT path must keep rewinding, which is how it re-asks
  const c = mk();
  c.mc.keyQueue.length = 0;
  c.cpu.eip = 0x200;
  c.cpu.ah = 0x01;                                               // INT 21h AH=01: read with echo
  c.mc.intHandlers[0x21](c.cpu, c.mc);
  ok('a blocking INT 21h service sets blocked', c.mc.blocked);
  eq('...and rewinds past the INT so it is re-executed', c.cpu.eip & 0xffff, 0x1fe);
}

// ---------------------------------------------------------------- INT 13h disk services
// INT 13h had no handler at all, which is the audit's worst finding made concrete: an unhandled INT
// returns CF with registers untouched, so a guest that asks for a sector is told nothing went wrong
// and parses whatever was already in its buffer. The "no media" case below is the important one.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const cpu = mc.cpu;
  const int13 = (pre) => { pre(cpu); cpu.flags |= CF; mc.intHandlers[0x13](cpu, mc);
                           return { ah: (cpu.reg[0] >> 8) & 0xff, al: cpu.reg[0] & 0xff, cf: cpu.flags & CF }; };

  // An empty drive must say so. Silence here is what makes a guest walk off into uninitialised RAM.
  const empty = int13((c) => { c.ah = 0x02; c.al = 1; c.reg[1] = 0x0001; c.reg[2] = 0x0000; });
  eq('13h read from an empty drive sets CF', empty.cf, CF);
  eq('13h read from an empty drive reports "not ready"', empty.ah, 0x80);

  // A 360K image: 40 cylinders, 2 heads, 9 sectors/track.
  const img = new Uint8Array(368640);
  for (let i = 0; i < 512; i++) img[i] = 0x11;                    // C0 H0 S1
  for (let i = 0; i < 512; i++) img[512 + i] = 0x22;              // C0 H0 S2
  const lba = (1 * 2 + 1) * 9 + (3 - 1);                          // C1 H1 S3
  for (let i = 0; i < 512; i++) img[lba * 512 + i] = 0x33;
  const g = mc.disk.attach(0x00, img);
  eq('a 360K image gets the right geometry', `${g.cyl}/${g.heads}/${g.spt}`, '40/2/9');

  cpu.setSeg(0, 0x2000); cpu.reg[3] = 0x100;                      // ES:BX = 2000:0100
  const r1 = int13((c) => { c.ah = 0x02; c.al = 2; c.reg[1] = 0x0001; c.reg[2] = 0x0000; });
  eq('13h reads two sectors', r1.cf, 0);
  eq('13h reports the count in AL', r1.al, 2);
  eq('13h delivered sector 1', mc.mem.r8(0x20100), 0x11);
  eq('13h delivered sector 2', mc.mem.r8(0x20100 + 512), 0x22);

  // CHS decoding: CH = cylinder, CL bits 0-5 = sector, DH = head. Getting this wrong reads the
  // wrong part of the disk and reports success, which is the silent-wrongness shape again.
  const r2 = int13((c) => { c.ah = 0x02; c.al = 1; c.reg[1] = 0x0103; c.reg[2] = 0x0100; });  // C1 S3 H1
  eq('13h reads a sector addressed by full CHS', r2.cf, 0);
  eq('...from the right place on the disk', mc.mem.r8(0x20100), 0x33);

  const bad = int13((c) => { c.ah = 0x02; c.al = 1; c.reg[1] = 0x0001 | (0x28 << 8); c.reg[2] = 0x0000; }); // cyl 40
  eq('13h past the last cylinder fails', bad.cf, CF);
  eq('13h past the last cylinder reports "sector not found"', bad.ah, 0x04);
  eq('...and reports 0 sectors transferred', bad.al, 0);
  eq('13h AH=01 reports the previous status', int13((c) => { c.ah = 0x01; }).ah, 0x04);

  const p = int13((c) => { c.ah = 0x08; c.reg[2] = 0x0000; });
  eq('13h AH=08 succeeds', p.cf, 0);
  eq('13h AH=08 reports sectors per track', cpu.reg[1] & 0x3f, 9);
  eq('13h AH=08 reports the last cylinder', (cpu.reg[1] >> 8) & 0xff, 39);
  eq('13h AH=08 reports the last head', (cpu.reg[2] >> 8) & 0xff, 1);

  // Write back into the image: it IS the medium, not a copy of it. (AH=08 above returned ES:DI=0,
  // as a real BIOS does, so the buffer segment has to be set again.)
  cpu.setSeg(0, 0x2000); cpu.reg[3] = 0x100;
  mc.mem.w8(0x20100, 0xAB);
  eq('13h AH=03 writes', int13((c) => { c.ah = 0x03; c.al = 1; c.reg[1] = 0x0001; c.reg[2] = 0x0000; }).cf, 0);
  eq('...into the image', img[0], 0xAB);

  const unk = int13((c) => { c.ah = 0x4f; });
  eq('13h reports an unimplemented subfunction', unk.ah, 0x01);
  ok('...and still counts it for the survey', mc.unhandledInts[0x13] > 0);
}

// ---------------------------------------------------------------- two-sector boot, end to end
// The rung above the boot handoff: a sector that loads more of itself. demos/bootload.asm reads
// sector 2 through INT 13h and jumps into it; "STAGE2 OK" can only appear if the read worked.
{
  const imgPath = new URL('../demos/BOOTLOAD.IMG', import.meta.url);
  let img = null;
  try { img = new Uint8Array(readFileSync(imgPath)); } catch { /* not assembled — skip */ }
  if (img) {
    const mc = new Machine({ memSize: 1 << 20 });
    installBIOS(mc);
    mc.disk.attach(0x00, img, { cyl: 1, heads: 1, spt: 2, type: 1 });
    bootSector(mc, img);
    for (let i = 0; i < 200 && !mc.cpu.halted; i++) mc.runSlice(2000);
    let text = '';
    for (let i = 0; i < 9; i++) text += String.fromCharCode(mc.mem.u8[0xb8000 + i * 2]);
    eq('a two-sector boot image loads its second sector via INT 13h', text, 'STAGE2 OK');
  }
}

// ---------------------------------------------------------------- gaps the corpus actually asked for
// Chosen from tools/survey-gaps.mjs rather than from a reading of the code: these are the INT 21h
// functions programs in games/ called and did not get.
{
  const c = mk();
  const psp = int21(c, 0x62);                                   // get PSP — Jazz, Keen1, Loom, ROC, Ski or Die
  eq('62h clears CF', psp.cf, 0);
  eq('62h returns the current PSP in BX', c.cpu.reg[3] & 0xffff, c.dos.psp);

  eq('58h AL=00 reports the strategy', int21(c, 0x58, (cpu) => { cpu.al = 0; }).ax, 0);
  eq('58h AL=01 sets it', int21(c, 0x58, (cpu) => { cpu.al = 1; cpu.reg[3] = 2; }).cf, 0);
  eq('58h AL=00 reads back what was set', int21(c, 0x58, (cpu) => { cpu.al = 0; }).ax, 2);
  eq('58h AL=02 reports the UMB link state', int21(c, 0x58, (cpu) => { cpu.al = 2; }).cf, 0);
  eq('58h with a bogus subfunction fails', int21(c, 0x58, (cpu) => { cpu.al = 9; }).cf, CF);

  const indos = int21(c, 0x34);                                 // InDOS flag — Keen1
  eq('34h clears CF', indos.cf, 0);
  const p = (c.cpu.seg[0] << 4) + (c.cpu.reg[3] & 0xffff);
  // In the DOS kernel's own segment, as a real DOS has it (tools/dosvec.asm: FreeDOS under QEMU
  // answers InDOS 00D8:0321 beside INT 21h at 00D8:129A); ours is the List of Lists' segment.
  const es34 = c.cpu.seg[0], lolSeg = (int21(c, 0x52), c.cpu.seg[0]);   // 52h: the List of Lists' segment
  eq('34h returns a pointer into the DOS kernel segment, the List of Lists\' (0071h, as DOSBox-X has it)', es34, lolSeg);
  eq('34h: the flag is clear outside a DOS call', c.mc.mem.r8(p), 0);
}

// ---------------------------------------------------------------- INT 15h AH=86h (wait)
// 16384 calls from revitro alone. With no handler at all the wait returned instantly, so a demo
// pacing itself on it ran as fast as the host could go.
{
  const c = mk();
  const before = c.mc.cpu.cycles;
  c.cpu.ah = 0x86; c.cpu.reg[1] = 0; c.cpu.reg[2] = 1000;        // CX:DX = 1000 us
  c.cpu.flags |= CF;
  c.mc.intHandlers[0x15](c.cpu, c.mc);
  eq('INT 15h AH=86h clears CF when the wait completes', c.cpu.flags & CF, 0);
  const spent = c.mc.cpu.cycles - before;
  // What the wait must advance is 1000 us of EMULATED time, so the expectation is derived from the
  // machine speed rather than written down: a PIT tick is 1/18.2065 s and costs pitBase cycles, so
  // 1000 us costs pitBase / (1e6 / 18.2065 / 1000). This used to be the constant "~1193 cycles",
  // which silently assumed pitBase = 65536; calibrating the machine to DOSBox (docs/notes/timing.md §7) moved
  // it to 182584 and this was the one test in the suite that noticed — and it stayed red because no
  // gate I was running covered it. Derived, it survives the next speed change.
  const expect = c.mc.pitBase / (1e6 / 18.2065 / 1000);
  ok(`INT 15h AH=86h advanced the virtual clock (${Math.round(spent)} cycles, attendu ~${Math.round(expect)})`,
     spent > expect * 0.95 && spent < expect * 1.05);
  c.cpu.ah = 0x4f; c.mc.intHandlers[0x15](c.cpu, c.mc);          // an unsupported subfunction
  eq('INT 15h reports unsupported subfunctions', c.cpu.flags & CF, CF);
  eq('...with AH=86h', (c.cpu.reg[0] >> 8) & 0xff, 0x86);
  ok('...and still counts them for the survey', c.mc.unhandledInts[0x15] > 0);
}

// ---------------------------------------------------------------- boot-sector handoff (INT 19h)
// Not a DOS service at all — that is the point. A boot-sector prod (BootChess and its kind) is what
// the BIOS loads and jumps to, with no PSP, no INT 21h and no termination convention. This checks the
// handoff state a real BIOS leaves behind, and that a sector without the 55 AA signature is refused
// rather than silently run, which would look like a MIRAGE fault instead of a bad image.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const img = new Uint8Array(512);
  img.set([0xb8, 0x00, 0xb8,                          // mov ax,0b800h
           0x8e, 0xc0,                                // mov es,ax
           0x26, 0xc7, 0x06, 0x00, 0x00, 0x41, 0x07,  // mov word [es:0000],0741h  ('A', white)
           0xf4], 0);                                 // hlt
  img[510] = 0x55; img[511] = 0xaa;

  ok('a sector with 55 AA is recognised', isBootSector(img));
  bootSector(mc, img);
  const cpu = mc.cpu;
  eq('boot sets CS:IP to 0000:7C00', (cpu.seg[1] << 16) | (cpu.eip & 0xffff), 0x7c00);
  eq('boot puts the stack just below the sector', cpu.reg[4] & 0xffff, 0x7c00);
  eq('boot passes the drive in DL', cpu.reg[2] & 0xff, 0x00);
  eq('boot enables interrupts', cpu.flags & 0x200, 0x200);
  eq('the sector is at 0000:7C00', mc.mem.u8[0x7c00], 0xb8);

  while (!cpu.halted) mc.rec.step();
  eq('the booted sector ran and halted', mc.mem.u8[0xb8000], 0x41);
  eq('...with its attribute', mc.mem.u8[0xb8001], 0x07);

  const bad = new Uint8Array(512);                    // no signature
  let threw = false;
  try { bootSector(new Machine({ memSize: 1 << 20 }), bad); } catch { threw = true; }
  ok('a sector without 55 AA is refused, not silently booted', threw);
  ok('...unless strict is off', (() => {
    const m = new Machine({ memSize: 1 << 20 }); installBIOS(m);
    try { bootSector(m, bad, { strict: false }); return true; } catch { return false; }
  })());
}

// ---------------------------------------------------------------- directories (39/3A/3B/47)
// These fell through to the "invalid function" arm even though the VFS has always been able to do
// them — the shell's own MD and CD call straight into it. A program creating its SAVES\ directory on
// first run, or chdir-ing before an EXEC, was simply told no.
{
  const c = mk({ '\\DATA\\F.TXT': 'x' });
  const at = (off, s) => asciiz(c.mc, c.cpu, off, s);

  eq('39h mkdir succeeds', int21(c, 0x39, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\SAVES'); }).cf, 0);
  ok('39h actually created the directory', c.vfs.isDir('C:\\SAVES'));
  const again = int21(c, 0x39, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\SAVES'); });
  eq('39h on an existing name sets CF', again.cf, CF);
  eq('39h on an existing name reports "access denied"', again.ax, 5);
  eq('39h under a missing parent reports "path not found"',
     int21(c, 0x39, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\NOPE\\SUB'); }).ax, 3);

  eq('3Bh chdir succeeds', int21(c, 0x3b, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\SAVES'); }).cf, 0);
  const cwd = int21(c, 0x47, (cpu) => { cpu.reg[6] = 0x280; });   // SI = buffer; no drive, no leading \
  eq('47h clears CF', cwd.cf, 0);
  eq('3Bh moved the current directory (47h agrees)',
     String.fromCharCode(...c.mc.mem.readStr((c.cpu.seg[3] << 4) + 0x280, 0)), 'SAVES');
  eq('3Bh into a missing directory reports "path not found"',
     int21(c, 0x3b, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\GONE'); }).ax, 3);

  // rmdir refuses the directory you are standing in — DOS error 16, and letting it through would
  // leave the cwd pointing at a node detached from the tree.
  eq('3Ah refuses to remove the current directory',
     int21(c, 0x3a, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\SAVES'); }).ax, 16);
  int21(c, 0x3b, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\'); });   // back to the root
  eq('3Ah refuses a non-empty directory',
     int21(c, 0x3a, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\DATA'); }).ax, 5);
  eq('3Ah on a missing directory reports "path not found"',
     int21(c, 0x3a, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\GONE'); }).ax, 3);
  eq('3Ah on a file, not a directory, fails',
     int21(c, 0x3a, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\DATA\\F.TXT'); }).ax, 3);
  eq('3Ah removes an empty directory',
     int21(c, 0x3a, (cpu) => { cpu.reg[2] = at(0x200, 'C:\\SAVES'); }).cf, 0);
  ok('3Ah actually removed it', !c.vfs.exists('C:\\SAVES'));
}

// ---------------------------------------------------------------- the mount base (VFS.mountAt)
// A title's own directory is the root of C: while it runs — `mount c games/X`, which is the drive
// the original media presented. Before this, every title lived under \GAMES\<TITLE>\ and the guest
// could tell: it reconstructs paths from argv0, so the mount point became part of its own state.
{
  const c = mk({ '\\GAMES\\JAZZ\\JAZZ.EXE': 'exe', '\\GAMES\\JAZZ\\RTM.000': 'rtm',
                 '\\GAMES\\KEEN\\KEEN.EXE': 'keen', '\\README.TXT': 'hi' });
  const at = (off, s) => asciiz(c.mc, c.cpu, off, s);
  const open = (p) => int21(c, 0x3d, (cpu) => { cpu.reg[2] = at(0x200, p); });

  eq('before mounting, a title is only reachable through \\GAMES', open('C:\\RTM.000').cf, CF);

  const view = c.vfs.mountAt('\\GAMES\\JAZZ');
  eq('mounted: the title addresses itself absolutely', open('C:\\RTM.000').cf, 0);
  eq('mounted: 47h reports the root', (int21(c, 0x47, (cpu) => { cpu.reg[6] = 0x280; }),
     String.fromCharCode(...c.mc.mem.readStr((c.cpu.seg[3] << 4) + 0x280, 0))), '');
  eq('mounted: what is above the mount point is gone', open('C:\\README.TXT').cf, CF);
  eq('mounted: so is every other title', open('C:\\GAMES\\KEEN\\KEEN.EXE').cf, CF);
  eq('mounted: .. cannot climb out of the mount, as on DOS', open('C:\\..\\..\\README.TXT').cf, CF);
  c.vfs.writeFile('C:\\SAVE.001', Uint8Array.of(1));   // a save file, written where the title expects

  c.vfs.restore(view);
  ok('a file the title created at C:\\ landed inside its directory', c.vfs.exists('\\GAMES\\JAZZ\\SAVE.001'));
  eq('restored: the shell browses the whole tree again', open('C:\\README.TXT').cf, 0);
  eq('restored: including the title it just ran', open('C:\\GAMES\\JAZZ\\RTM.000').cf, 0);
}

// ---------------------------------------------------------------- XMS
{
  const { mc, cpu } = mk();
  cpu.reg[0] = 0x4300; mc.intHandlers[0x2f](cpu, mc);
  eq('INT 2Fh AX=4300h reports XMS installed', cpu.reg[0] & 0xff, 0x80);
  cpu.reg[0] = 0x4310; mc.intHandlers[0x2f](cpu, mc);
  ok('INT 2Fh AX=4310h returns an entry point', (cpu.seg[0] << 16 | (cpu.reg[3] & 0xffff)) !== 0);
  // allocate → lock → free through the driver entry
  cpu.ah = 0x00; mc.cpu.xmsCall(); eq('XMS AH=00 reports version 3.00', cpu.reg[0] & 0xffff, 0x0300);
  cpu.ah = 0x09; cpu.reg[2] = 64; mc.cpu.xmsCall();               // DX = KB
  eq('XMS AH=09 alloc succeeds', cpu.reg[0] & 0xffff, 1);
  const h = cpu.reg[2] & 0xffff;
  cpu.ah = 0x0c; cpu.reg[2] = h; mc.cpu.xmsCall();
  eq('XMS AH=0C lock succeeds', cpu.reg[0] & 0xffff, 1);
  ok('XMS AH=0C returns an address at or above 1 MiB', ((cpu.reg[2] & 0xffff) << 16 | (cpu.reg[3] & 0xffff)) >>> 0 >= 0x100000);
  cpu.ah = 0x0d; cpu.reg[2] = h; mc.cpu.xmsCall();
  cpu.ah = 0x0a; cpu.reg[2] = h; mc.cpu.xmsCall();
  eq('XMS AH=0A free succeeds', cpu.reg[0] & 0xffff, 1);
  cpu.ah = 0x0a; cpu.reg[2] = 0x1234; mc.cpu.xmsCall();           // bogus handle
  eq('XMS AH=0A on a bad handle fails', cpu.reg[0] & 0xffff, 0);
  eq('XMS AH=0A on a bad handle reports "invalid handle"', cpu.reg[3] & 0xff, 0xa2);
}

// ---------------------------------------------------------------- XMS AH=0Bh move block
// The defect class: a move endpoint used to be resolved without ever checking it against the block's
// size, so an out-of-range copy scribbled over a neighbouring handle — or past the end of RAM, where
// it vanished with no diagnostic at all. And the copy itself was an ascending byte loop, which
// corrupts an overlapping move instead of behaving like memmove.
{
  const { mc, cpu } = mk();
  const alloc = (kb) => { cpu.ah = 0x09; cpu.reg[2] = kb; mc.cpu.xmsCall(); return cpu.reg[2] & 0xffff; };
  const lin = (h) => { cpu.ah = 0x0c; cpu.reg[2] = h; mc.cpu.xmsCall();
                       const a = (((cpu.reg[2] & 0xffff) << 16) | (cpu.reg[3] & 0xffff)) >>> 0;
                       cpu.ah = 0x0d; cpu.reg[2] = h; mc.cpu.xmsCall(); return a; };
  /** Build an ExtMemMoveStruct at DS:0x400 and invoke AH=0Bh. */
  const move = (len, srcH, srcOff, dstH, dstOff) => {
    const p = (cpu.seg[3] << 4) + 0x400;
    mc.mem.w32(p, len); mc.mem.w16(p + 4, srcH); mc.mem.w32(p + 6, srcOff);
    mc.mem.w16(p + 10, dstH); mc.mem.w32(p + 12, dstOff);
    cpu.ah = 0x0b; cpu.reg[6] = 0x400;                          // SI
    mc.cpu.xmsCall();
    return { ax: cpu.reg[0] & 0xffff, bl: cpu.reg[3] & 0xff };
  };

  const a = alloc(4), b = alloc(4);                             // two adjacent 4 KB blocks
  const aLin = lin(a), bLin = lin(b);
  for (let i = 0; i < 64; i++) mc.mem.u8[aLin + i] = 0x40 + i;    // recognisable payload in A
  mc.mem.u8[bLin] = 0x99;                                        // canary at the head of B

  eq('XMS AH=0B moves within bounds', move(64, a, 0, b, 0).ax, 1);
  eq('XMS AH=0B copied the bytes', mc.mem.u8[bLin + 63], 0x40 + 63);

  const past = move(64, a, 4096 - 32, b, 0);                    // source runs 32 bytes past A's end
  eq('XMS AH=0B rejects a source range past the block', past.ax, 0);
  eq('XMS AH=0B reports "invalid source offset"', past.bl, 0xa4);
  const pastD = move(64, a, 0, b, 4096 - 32);
  eq('XMS AH=0B rejects a destination range past the block', pastD.ax, 0);
  eq('XMS AH=0B reports "invalid destination offset"', pastD.bl, 0xa6);
  eq('XMS AH=0B rejects an odd length', move(3, a, 0, b, 0).bl, 0xa7);
  eq('XMS AH=0B rejects an unknown source handle', move(2, 0x1234, 0, b, 0).bl, 0xa3);
  eq('XMS AH=0B rejects an unknown destination handle', move(2, a, 0, 0x1234, 0).bl, 0xa5);

  // Overlap, forward: dst inside [src, src+len). The old ascending byte loop smeared byte 0 across
  // the range; memmove keeps the original bytes.
  for (let i = 0; i < 32; i++) mc.mem.u8[aLin + i] = i;
  eq('XMS AH=0B handles an overlapping move', move(16, a, 0, a, 4).ax, 1);
  eq('XMS AH=0B overlapping move is a memmove, not a smear', mc.mem.u8[aLin + 8], 4);
}

// ---------------------------------------------------------------- XMS move vs self-modifying code
// The audit's worst XMS finding: AH=0Bh wrote straight into the backing array, bypassing block
// invalidation — on the one bulk path whose whole purpose is swapping *code* overlays into
// conventional memory. Stale compiled blocks then kept running the code that used to be there.
// End-to-end: run a routine, XMS-move a different one over it, run again.
{
  const { mc, cpu } = mk();
  const CS = 0x2000, LIN = CS << 4;
  const run = () => { cpu.setSeg(1, CS); cpu.eip = 0; cpu.halted = false; mc.rec.step(); return cpu.reg[0] & 0xff; };
  mc.mem.blit(LIN, Uint8Array.from([0xb0, 0x01, 0xf4]));         // mov al,1 ; hlt
  eq('the original routine runs', run(), 1);

  cpu.ah = 0x09; cpu.reg[2] = 4; mc.cpu.xmsCall();               // alloc 4 KB
  const h = cpu.reg[2] & 0xffff;
  cpu.ah = 0x0c; cpu.reg[2] = h; mc.cpu.xmsCall();
  const base = (((cpu.reg[2] & 0xffff) << 16) | (cpu.reg[3] & 0xffff)) >>> 0;
  cpu.ah = 0x0d; cpu.reg[2] = h; mc.cpu.xmsCall();
  mc.mem.u8.set([0xb0, 0x02, 0xf4, 0x00], base);                 // mov al,2 ; hlt   (even length)

  const p = (cpu.seg[3] << 4) + 0x400;                           // ExtMemMoveStruct: 4 bytes, XMS → conventional
  mc.mem.w32(p, 4); mc.mem.w16(p + 4, h); mc.mem.w32(p + 6, 0);
  mc.mem.w16(p + 10, 0); mc.mem.w32(p + 12, (CS << 16) | 0);     // handle 0 = far pointer CS:0000
  cpu.ah = 0x0b; cpu.reg[6] = 0x400; mc.cpu.xmsCall();
  eq('XMS AH=0B swapped the overlay in', cpu.reg[0] & 0xffff, 1);
  eq('the swapped-in routine runs, not the cached block', run(), 2);
}

// ---------------------------------------------------------------- XMS AH=0Fh reallocate / AH=0Ah free
{
  const { mc, cpu } = mk();
  const alloc = (kb) => { cpu.ah = 0x09; cpu.reg[2] = kb; mc.cpu.xmsCall(); return cpu.reg[2] & 0xffff; };
  const info = (h) => { cpu.ah = 0x0e; cpu.reg[2] = h; mc.cpu.xmsCall(); return cpu.reg[2] & 0xffff; };  // → size KB
  const lin = (h) => { cpu.ah = 0x0c; cpu.reg[2] = h; mc.cpu.xmsCall();
                       const a = (((cpu.reg[2] & 0xffff) << 16) | (cpu.reg[3] & 0xffff)) >>> 0;
                       cpu.ah = 0x0d; cpu.reg[2] = h; mc.cpu.xmsCall(); return a; };
  const realloc = (h, kb) => { cpu.ah = 0x0f; cpu.reg[2] = h; cpu.reg[3] = kb; mc.cpu.xmsCall();
                               return { ax: cpu.reg[0] & 0xffff, bl: cpu.reg[3] & 0xff }; };

  const a = alloc(4), b = alloc(4);
  const bLin = lin(b);
  for (let i = 0; i < 16; i++) mc.mem.u8[lin(a) + i] = 0x11 + i;
  mc.mem.u8[bLin] = 0x99;                                        // canary: B must survive A growing

  // Growing A past B used to just widen A's size field, so A and B aliased the same bytes.
  eq('XMS AH=0F grows a boxed-in block', realloc(a, 32).ax, 1);
  eq('XMS AH=0F reports the new size', info(a), 32);
  eq('XMS AH=0F relocated instead of overrunning the neighbour', mc.mem.u8[bLin], 0x99);
  ok('XMS AH=0F moved the block clear of its neighbour', lin(a) >= bLin + 4096);
  eq('XMS AH=0F carried the contents to the new home', mc.mem.u8[lin(a) + 15], 0x11 + 15);

  eq('XMS AH=0F shrinks in place', realloc(a, 8).ax, 1);
  eq('XMS AH=0F reports the shrunk size', info(a), 8);

  cpu.ah = 0x0c; cpu.reg[2] = a; mc.cpu.xmsCall();              // leave A locked
  eq('XMS AH=0F refuses to resize a locked block', realloc(a, 64).bl, 0xab);
  cpu.ah = 0x0a; cpu.reg[2] = a; mc.cpu.xmsCall();
  eq('XMS AH=0A refuses to free a locked block', cpu.reg[3] & 0xff, 0xab);
  cpu.ah = 0x0d; cpu.reg[2] = a; mc.cpu.xmsCall();              // unlock
  eq('XMS AH=0D on an unlocked block reports "not locked"', (cpu.ah = 0x0d, cpu.reg[2] = a, mc.cpu.xmsCall(), cpu.reg[3] & 0xff), 0xaa);
  cpu.ah = 0x0a; cpu.reg[2] = a; mc.cpu.xmsCall();
  eq('XMS AH=0A frees the now-unlocked block', cpu.reg[0] & 0xffff, 1);
}

// ----------------------------------------------------------------------------
// EMS save/restore of the page map (INT 67h AH=47/48). These used to return success while keeping
// nothing, which is not a harmless stub: the universal idiom is save -> remap -> restore, and a
// caller that skips the restore keeps reading through a window pointing at whatever it borrowed.
// Turbo Pascal 7.1 does this around every library access and died with "Fatal error: Disk or EMS
// I/O failure."; it renders its whole IDE once the restore actually restores.
{
  const { mc, cpu } = mk();
  const ems = (ah, pre) => { cpu.ah = ah; if (pre) pre(); mc.intHandlers[0x67](cpu, mc); return cpu.ah; };
  eq('EMS present', ems(0x40), 0);
  const frame = (cpu.ah = 0x41, mc.intHandlers[0x41] ? 0 : 0, ems(0x41), cpu.bx & 0xffff);
  eq('EMS allocates 4 pages', ems(0x43, () => { cpu.bx = 4; }), 0);
  const h = cpu.dx & 0xffff;
  // Distinguish two logical pages by their first byte, then map page 0 into slot 0.
  const lin = (seg, off) => ((seg << 4) + off) >>> 0;
  eq('EMS maps logical page 0 into slot 0', ems(0x44, () => { cpu.al = 0; cpu.bx = 0; cpu.dx = h; }), 0);
  mc.mem.u8[lin(frame, 0)] = 0xa1;
  eq('EMS saves the page map', ems(0x47, () => { cpu.dx = h; }), 0);
  eq('EMS remaps slot 0 to logical page 1', ems(0x44, () => { cpu.al = 0; cpu.bx = 1; cpu.dx = h; }), 0);
  mc.mem.u8[lin(frame, 0)] = 0xb2;
  eq('EMS restores the page map', ems(0x48, () => { cpu.dx = h; }), 0);
  eq('the restored window shows logical page 0 again', mc.mem.u8[lin(frame, 0)], 0xa1);
  // and the borrowed page kept what was written to it
  eq('EMS re-maps logical page 1', ems(0x44, () => { cpu.al = 0; cpu.bx = 1; cpu.dx = h; }), 0);
  eq('logical page 1 kept its own byte', mc.mem.u8[lin(frame, 0)], 0xb2);
}

// ----------------------------------------------------------------------------
console.log(`\nmirage DOS/BIOS services: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
