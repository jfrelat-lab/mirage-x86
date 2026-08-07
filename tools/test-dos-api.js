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
