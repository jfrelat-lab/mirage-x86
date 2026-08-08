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

{ // an EXEC'd child's block is sized from its OWN header, like the parent's. While the MZ parser
  // was duplicated this half of the e_maxalloc fix never reached the EXEC path, so a child that
  // asked for a bounded block was handed all of memory and its own AH=48h then had nowhere to go.
  const c = mk();
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
  // parent PSP 0x100 + 0x200 shrunk paragraphs = child PSP 0x300; block = PSP(0x10) + 32-byte image(2)
  // + maxalloc(0x10) = 0x22 paragraphs. Before this, the child was handed everything up to 0xa000.
  eq('EXEC child block is header-sized, not all of memory', c.dos.allocTop, 0x322);
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
  ok('34h returns a pointer into low memory', p > 0 && p < 0x600);
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
  // cpu.cycles is the PIT clock: 1.193182 MHz, so 1000 us is ~1193 cycles.
  ok(`INT 15h AH=86h advanced the virtual clock (${Math.round(spent)} cycles)`, spent > 1100 && spent < 1300);
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
console.log(`\nmirage DOS/BIOS services: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
