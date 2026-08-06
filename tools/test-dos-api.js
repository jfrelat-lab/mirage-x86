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
import { VFS } from '../src/vfs.js';

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
{ // an impossible allocation must fail AND report the largest block available in BX
  const c = mk();
  const r = int21(c, 0x48, (cpu) => { cpu.reg[3] = 0xffff; });
  eq('48h over-large alloc sets CF', r.cf, CF);
  eq('48h over-large alloc reports "insufficient memory"', r.ax, 8);
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

// ---------------------------------------------------------------- unhandled services are loud
{
  const c = mk();
  const r = int21(c, 0xfe);                                       // no such function
  eq('an unimplemented INT 21h function sets CF', r.cf, CF);
  eq('an unimplemented INT 21h function reports "invalid function"', r.ax, 1);
}
{ // and an interrupt we don't implement at all must not read as success
  const { mc, cpu } = mk();
  cpu.flags &= ~CF;
  mc.swInt(0x13);                                                 // BIOS disk services — not implemented
  eq('an unhandled INT sets CF', cpu.flags & CF, CF);
  eq('an unhandled INT is counted', mc.unhandledInts[0x13], 1);
  ok('unhandledIntReport names the vector', mc.unhandledIntReport().includes('INT 13h'));
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

// ----------------------------------------------------------------------------
console.log(`\nmirage DOS/BIOS services: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
