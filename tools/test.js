// test.js — headless correctness harness for the x86→JS recompiler.
//
// Each case is hand-encoded machine code (so we test the decoder against known
// bytes, not against an assembler we also wrote) run to a HLT, then we assert on
// architectural state. Run:  node tools/test.js
//
// This is the proof the dynamic recompiler is correct without a browser, and it
// doubles as a deterministic regression net for the engine.

import { Machine } from '../src/machine.js';
import { installMouse } from '../src/mouse.js';
import { installDisk } from '../src/disk.js';
import { installBIOS } from '../src/bios.js';
import { Video } from '../src/video.js';
import { CPU, CS, DS, ES, SS, CF, ZF, SF, OF, PF } from '../src/cpu.js';
import { describeRegion, recentBlocks } from '../src/derail.js';

let pass = 0, fail = 0;
const fails = [];

function run(bytes, setup) {
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0;
  cpu.setSeg(DS, 0x200); cpu.setSeg(ES, 0x200); cpu.setSeg(SS, 0x300);
  cpu.sp = 0x1000;
  mc.mem.blit(0x100 * 16, Uint8Array.from(bytes));
  const ctx = { mc, cpu, out: [] };
  if (setup) setup(ctx);
  let steps = 0;
  while (!cpu.halted && steps < 200000) { mc.rec.step(); steps++; }
  ctx.steps = steps;
  return ctx;
}

function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; fails.push(`${name}: got ${typeof got === 'number' ? '0x' + (got >>> 0).toString(16) : got}, want ${typeof want === 'number' ? '0x' + (want >>> 0).toString(16) : want}`); }
}

// ----------------------------------------------------------------------------
// 1. immediate load + add
{ const { cpu } = run([0xb8, 0x34, 0x12, 0x05, 0x11, 0x11, 0xf4]); eq('mov+add AX', cpu.ax, 0x2345); }

// 2. CMP sets ZF, JZ taken skips a MOV
{ const { cpu } = run([0xb0, 0x05, 0x3c, 0x05, 0x74, 0x02, 0xb0, 0xff, 0xf4]); eq('cmp/jz AL', cpu.al, 0x05); }

// 3. summation loop 1..10 via LOOP  (expect 55)
{ const { cpu } = run([0x31, 0xc0, 0xb9, 0x0a, 0x00, 0x01, 0xc8, 0xe2, 0xfc, 0xf4]); eq('loop sum', cpu.ax, 55); }

// 4. REP MOVSB copies 4 bytes
{ const { mc, cpu } = run(
    [0xfc, 0xbe, 0x00, 0x00, 0xbf, 0x10, 0x00, 0xb9, 0x04, 0x00, 0xf3, 0xa4, 0xf4],
    ({ mc }) => mc.mem.blit(0x2000, Uint8Array.from([0xde, 0xad, 0xbe, 0xef])));
  const dst = [mc.mem.r8(0x2010), mc.mem.r8(0x2011), mc.mem.r8(0x2012), mc.mem.r8(0x2013)];
  eq('rep movsb', dst.join(','), '222,173,190,239');
  eq('rep movsb CX drained', cpu.cx, 0);
}

// 5. PUSH/POP round-trips a value through the stack
{ const { cpu } = run([0xb8, 0x78, 0x56, 0x50, 0x5b, 0xf4]); eq('push/pop BX', cpu.bx, 0x5678); }

// 6. MUL BX  (10*3=30 in DX:AX)
{ const { cpu } = run([0xb8, 0x0a, 0x00, 0xbb, 0x03, 0x00, 0xf7, 0xe3, 0xf4]); eq('mul AX', cpu.ax, 30); eq('mul DX', cpu.dx, 0); }

// 7. DIV BL  (100/7 = 14 r2)
{ const { cpu } = run([0xb8, 0x64, 0x00, 0xb3, 0x07, 0xf6, 0xf3, 0xf4]); eq('div AL', cpu.al, 14); eq('div AH', cpu.ah, 2); }

// 8. software INT routed to a JS handler that reads AL
{ const out = [];
  run([0xb0, 0x41, 0xcd, 0x21, 0xf4], ({ mc }) => mc.hookInterrupt(0x21, (cpu) => out.push(cpu.al)));
  eq('int 21h AL seen', out[0], 0x41);
}

// 9. carry flag: 0xFFFF + 1 wraps and sets CF/ZF
{ const { cpu } = run([0xb8, 0xff, 0xff, 0x05, 0x01, 0x00, 0xf4]); eq('add wrap AX', cpu.ax, 0); eq('add wrap CF', !!(cpu.flags & CF), true); eq('add wrap ZF', !!(cpu.flags & ZF), true); }

// 10. SHL/SHR
{ const { cpu } = run([0xb0, 0x01, 0xc0, 0xe0, 0x04, 0xf4]); eq('shl AL', cpu.al, 0x10); }       // 1<<4
{ const { cpu } = run([0xb0, 0x80, 0xc0, 0xe8, 0x03, 0xf4]); eq('shr AL', cpu.al, 0x10); }       // 0x80>>3

// 11. signed compare: -1 vs 1 → SF!=OF so JL taken
{ const { cpu } = run([0xb8, 0xff, 0xff, 0x3d, 0x01, 0x00, 0x7c, 0x03, 0xb8, 0x00, 0x00, 0xf4]);
  eq('jl signed keeps AX', cpu.ax, 0xffff); }   // JL taken → skip MOV AX,0

// 12. memory store then load through DS
{ const { cpu, mc } = run([0xb8, 0xbe, 0xba, 0xa3, 0x20, 0x00, 0xa1, 0x20, 0x00, 0xf4]);
  eq('store word', mc.mem.r16(0x2000 + 0x20), 0xbabe);
  eq('reload word', cpu.ax, 0xbabe); }

// 13. near CALL/RET
{ const { cpu } = run([
    0xe8, 0x02, 0x00,   // CALL +2 (to the MOV at offset 5)
    0xeb, 0x04,         // JMP +4 (to HLT at offset 9) — RET returns here
    0xb8, 0x99, 0x00,   // sub: MOV AX,0x99
    0xc3,               // RET
    0xf4                // HLT
  ]);
  // CALL → sub sets AX=0x99, RET → JMP → HLT
  eq('call/ret AX', cpu.ax, 0x99); }

// ---- 386/486 opcodes the 8088 conformance set can't cover -----------------
// BTS imm: set bit 2 of AX(0) → 4
{ const { cpu } = run([0xb8, 0x00, 0x00, 0x0f, 0xba, 0xe8, 0x02, 0xf4]); eq('bts imm', cpu.ax, 4); }
// BTR imm: clear bit 0 of AX(0xff) → 0xfe
{ const { cpu } = run([0xb8, 0xff, 0x00, 0x0f, 0xba, 0xf0, 0x00, 0xf4]); eq('btr imm', cpu.ax, 0xfe); }
// BT reg: bit 3 of 8 is set → CF=1 → SBB DX,DX = 0xffff
{ const { cpu } = run([0xb8, 0x08, 0x00, 0xb9, 0x03, 0x00, 0x0f, 0xa3, 0xc8, 0x1b, 0xd2, 0xf4]); eq('bt reg CF', cpu.dx, 0xffff); }
// BSF: lowest set bit of 0x0140 is 6
{ const { cpu } = run([0xb8, 0x40, 0x01, 0x0f, 0xbc, 0xd8, 0xf4]); eq('bsf', cpu.bx, 6); }
// BSR: highest set bit of 0x0140 is 8
{ const { cpu } = run([0xb8, 0x40, 0x01, 0x0f, 0xbd, 0xd8, 0xf4]); eq('bsr', cpu.bx, 8); }
// SHLD AX,BX,4: (0x1234<<4)|(0x5678>>12) = 0x2345
{ const { cpu } = run([0xb8, 0x34, 0x12, 0xbb, 0x78, 0x56, 0x0f, 0xa4, 0xd8, 0x04, 0xf4]); eq('shld', cpu.ax, 0x2345); }
// SHRD AX,BX,4: (0x1234>>4)|(0x5678<<12) = 0x8123
{ const { cpu } = run([0xb8, 0x34, 0x12, 0xbb, 0x78, 0x56, 0x0f, 0xac, 0xd8, 0x04, 0xf4]); eq('shrd', cpu.ax, 0x8123); }
// XADD AX,BX: AX=5,BX=3 → AX=8, BX=5
{ const { cpu } = run([0xb8, 0x05, 0x00, 0xbb, 0x03, 0x00, 0x0f, 0xc1, 0xd8, 0xf4]); eq('xadd sum', cpu.ax, 8); eq('xadd swap', cpu.bx, 5); }
// CMPXCHG CL,DL equal: AL=CL=5 → CL=DL=0x42, ZF=1
{ const { cpu } = run([0xb0, 0x05, 0xb1, 0x05, 0xb2, 0x42, 0x0f, 0xb0, 0xd1, 0xf4]); eq('cmpxchg eq', cpu.cx & 0xff, 0x42); }
// CMPXCHG CL,DL not equal: AL=5,CL=9 → AL=CL=9
{ const { cpu } = run([0xb0, 0x05, 0xb1, 0x09, 0xb2, 0x42, 0x0f, 0xb0, 0xd1, 0xf4]); eq('cmpxchg ne', cpu.al, 9); }

// self-modifying code: run a subroutine (caches it), patch its MOV BL,0x11 immediate
// to 0x42, run again — fine-grained SMC must invalidate the block so we see 0x42.
{ const { cpu } = run(
    [0xe8, 0x09, 0x00,                // CALL patch (->0x0C)
     0xc6, 0x06, 0x0d, 0x00, 0x42,    // MOV byte [0x0D], 0x42   (patch the imm)
     0xe8, 0x01, 0x00,                // CALL patch again
     0xf4,                            // HLT
     0xb3, 0x11,                      // patch: MOV BL, 0x11  (imm at 0x0D)
     0xc3],                           // RET
    ({ cpu }) => cpu.setSeg(DS, 0x100));  // DS=CS so the write lands on the code
  eq('SMC re-patch', cpu.bx & 0xff, 0x42); }

// ---- dead-flag elimination (Phase 1.A2) — flags a producer sets must survive to a
// later reader even across intervening ops; these catch a wrong def/use annotation that
// the single-instruction conformance harness is structurally blind to. -----------------
// ADC reads a prior ADD's CF across a transparent MOV (tests adc use=CF keeps the ADD).
{ const { cpu } = run([0xb8, 0xff, 0xff, 0x05, 0x01, 0x00, 0xbb, 0x10, 0x00, 0x83, 0xd3, 0x00, 0xf4]);
  eq('strip: adc reads prior CF', cpu.bx, 0x11); }
// INC preserves CF (def is all-but-carry); a later ADC must still see the ADD's CF.
{ const { cpu } = run([0xb8, 0xff, 0xff, 0x05, 0x01, 0x00, 0x43, 0x83, 0xd1, 0x00, 0xf4]);
  eq('strip: inc preserves CF', cpu.cx, 1); eq('strip: inc result', cpu.bx, 1); }
// DAA reads the prior ADD's AF, with a trailing CMP that would let the ADD strip if AF
// weren't marked used (0x08+0x08=0x10 AF=1 → DAA yields 0x16, not 0x10).
{ const { cpu } = run([0xb0, 0x08, 0x04, 0x08, 0x27, 0x3c, 0x99, 0xf4]);
  eq('strip: daa reads prior AF', cpu.al, 0x16); }
// PUSHF reads the live flags; a trailing CMP would strip the ADD if PUSHF weren't a reader.
{ const { cpu } = run([0xb8, 0xff, 0xff, 0x05, 0x01, 0x00, 0x9c, 0x5b, 0x3d, 0x00, 0x00, 0xf4]);
  eq('strip: pushf sees CF', !!(cpu.bx & CF), true); eq('strip: pushf sees ZF', !!(cpu.bx & ZF), true); }

// ---- 32-bit MUL/DIV/IMUL/IDIV (66h operand-size) — these ran as 16-bit before, which
// silently truncated the operands (the Mars-demo sky was a 32-bit `div ecx` computed as a
// 16-bit `div cx`). The single-instruction conformance set is 8088-only and never sees them.
// MUL ECX: EAX=0x10000 * ECX=0x10000 = 0x1_0000_0000 → EAX=0, EDX=1.
{ const { cpu } = run([0x66, 0xb8, 0x00, 0x00, 0x01, 0x00, 0x66, 0xb9, 0x00, 0x00, 0x01, 0x00, 0x66, 0xf7, 0xe1, 0xf4]);
  eq('mul32 EAX', cpu.reg[0] >>> 0, 0); eq('mul32 EDX', cpu.reg[2] >>> 0, 1); }
// DIV ECX (the Mars pattern): EAX=1000000, xor edx,edx, div ECX=7 → 142857 r1.
{ const { cpu } = run([0x66, 0xb8, 0x40, 0x42, 0x0f, 0x00, 0x66, 0x31, 0xd2, 0x66, 0xb9, 0x07, 0x00, 0x00, 0x00, 0x66, 0xf7, 0xf1, 0xf4]);
  eq('div32 quotient', cpu.reg[0] >>> 0, 142857); eq('div32 remainder', cpu.reg[2] >>> 0, 1); }
// IMUL ECX signed: EAX=-2 * ECX=3 = -6 → EAX=0xFFFFFFFA, EDX=0xFFFFFFFF (sign-extended).
{ const { cpu } = run([0x66, 0xb8, 0xfe, 0xff, 0xff, 0xff, 0x66, 0xb9, 0x03, 0x00, 0x00, 0x00, 0x66, 0xf7, 0xe9, 0xf4]);
  eq('imul32 EAX', cpu.reg[0] >>> 0, 0xfffffffa >>> 0); eq('imul32 EDX', cpu.reg[2] >>> 0, 0xffffffff >>> 0); }
// IDIV ECX signed: EDX:EAX = -6, div ECX=3 → -2 r0.
{ const { cpu } = run([0x66, 0xb8, 0xfa, 0xff, 0xff, 0xff, 0x66, 0xba, 0xff, 0xff, 0xff, 0xff, 0x66, 0xb9, 0x03, 0x00, 0x00, 0x00, 0x66, 0xf7, 0xf9, 0xf4]);
  eq('idiv32 quotient', cpu.reg[0] | 0, -2); eq('idiv32 remainder', cpu.reg[2] | 0, 0); }

// ---- CMOVcc (0F 40-4F): MOV Gv,Ev only if the condition holds; flags untouched. -------
// AX=5; CMP AX,5 (ZF=1); CMOVZ CX,BX copies (taken); CMOVNZ DX,BX does not (not taken).
{ const { cpu } = run([0xb8, 0x05, 0x00, 0x3d, 0x05, 0x00, 0xbb, 0x34, 0x12, 0xb9, 0x00, 0x00, 0xba, 0x00, 0x00, 0x0f, 0x44, 0xcb, 0x0f, 0x45, 0xd3, 0xf4]);
  eq('cmovz taken', cpu.cx, 0x1234); eq('cmovnz not taken', cpu.dx, 0); }

// ---- BOUND (0x62): #BR (INT 5) when the signed index is outside [lower,upper] in memory.
// bounds [10,100] at DS:0x40. In-range (AX=50) falls through to the trailing MOV; the hook
// must NOT fire. Out-of-range (AX=200) diverts to INT 5 before the trailing MOV runs.
{ const out = [];
  const { cpu } = run([0xbb, 0x11, 0x00, 0xb8, 0x32, 0x00, 0x62, 0x06, 0x40, 0x00, 0xbb, 0x77, 0x00, 0xf4],
    ({ mc }) => { mc.mem.w16(0x2040, 10); mc.mem.w16(0x2042, 100); mc.hookInterrupt(5, (c) => { out.push(1); c.halted = true; }); });
  eq('bound in-range falls through', cpu.bx, 0x77); eq('bound in-range no #BR', out.length, 0); }
{ const out = [];
  const { cpu } = run([0xbb, 0x11, 0x00, 0xb8, 0xc8, 0x00, 0x62, 0x06, 0x40, 0x00, 0xbb, 0x77, 0x00, 0xf4],
    ({ mc }) => { mc.mem.w16(0x2040, 10); mc.mem.w16(0x2042, 100); mc.hookInterrupt(5, (c) => { out.push(1); c.halted = true; }); });
  eq('bound out-of-range #BR fired', out.length, 1); eq('bound out-of-range skips trailing MOV', cpu.bx, 0x11); }

// ---- INT 33h mouse driver — the functions Mars polls to steer the camera. ------------
// AX=0000 reset/detect → AX=FFFF (present), BX=2 (buttons).
{ const { cpu } = run([0xb8, 0x00, 0x00, 0xcd, 0x33, 0xf4], ({ mc }) => installMouse(mc));
  eq('mouse detect present', cpu.ax, 0xffff); eq('mouse detect buttons', cpu.bx, 2); }
// AX=000B read motion counters: returns accumulated mickeys (signed) and clears them.
{ const { cpu } = run([0xb8, 0x0b, 0x00, 0xcd, 0x33, 0xf4], ({ mc }) => { installMouse(mc); mc.mouseMoveRel(7, -3); });
  eq('mouse mickeys dx', cpu.cx, 7); eq('mouse mickeys dy (signed)', cpu.dx, 0xfffd); }
// AX=0003 get position + buttons: two buttons held → BX bit0|bit1.
{ const { cpu } = run([0xb8, 0x03, 0x00, 0xcd, 0x33, 0xf4], ({ mc }) => { installMouse(mc); mc.mouseButton(0, true); mc.mouseButton(1, true); });
  eq('mouse buttons L+R', cpu.bx, 3); }
// AX=0005 button press data: two left presses since reset → BX=2.
{ const { cpu } = run([0xbb, 0x00, 0x00, 0xb8, 0x05, 0x00, 0xcd, 0x33, 0xf4], ({ mc }) => { installMouse(mc); mc.mouseButton(0, true); mc.mouseButton(0, false); mc.mouseButton(0, true); });
  eq('mouse press count', cpu.bx, 2); }

// ---- BSWAP r32 (0F C8+r): reverse a 32-bit register's byte order (486+). --------------
{ const { cpu } = run([0x66, 0xb8, 0x44, 0x33, 0x22, 0x11, 0x0f, 0xc8, 0xf4]);   // MOV EAX,0x11223344; BSWAP EAX
  eq('bswap eax', cpu.reg[0] >>> 0, 0x44332211); }
{ const { cpu } = run([0x66, 0xbb, 0x01, 0x00, 0x00, 0x00, 0x0f, 0xcb, 0xf4]);   // MOV EBX,1; BSWAP EBX (reg-index math)
  eq('bswap ebx', cpu.reg[3] >>> 0, 0x01000000); }

// ---- Sound-hardware detection so games start (no audio, just the probe handshakes). ---
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  mc.ioWrite(0x226, 1, 1); mc.ioWrite(0x226, 1, 0);                 // SB DSP reset: 1 then 0
  eq('sb dsp data-ready', mc.ioRead(0x22e, 1) & 0x80, 0x80);       // status bit7 set
  eq('sb dsp reset ack', mc.ioRead(0x22a, 1), 0xaa);               // read-data = 0xAA
  mc.ioWrite(0x388, 1, 0x04); mc.ioWrite(0x389, 1, 0x21);          // OPL: select timer-ctrl, start timer1
  eq('opl timer expired', mc.ioRead(0x388, 1), 0xc0);              // status shows timer-expired bits
  mc.ioWrite(0x388, 1, 0x04); mc.ioWrite(0x389, 1, 0x80);          // OPL: reset
  eq('opl reset clears', mc.ioRead(0x388, 1), 0x00); }

// ---- EGA/VGA detection: INT 10h AH=12h BL=10h returns EGA info so games find a card. --
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  mc.cpu.ax = 0x1200; mc.cpu.bx = 0x0010;                          // AH=12h, BL=10h "return EGA info"
  mc.intHandlers[0x10](mc.cpu, mc);
  eq('ega detect present', mc.cpu.bx, 0x0003); }                   // BH=0 colour, BL=3 (256K) → EGA/VGA present

// ---- EGA planar write pipeline: map-mask selects planes; read-map selects read-back. --
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const vga = mc.vga, mem = mc.mem;
  mem.planar = true; vga.setMode(0x0d, true);                      // enter planar mode 0Dh
  mc.ioWrite(0x3c4, 1, 0x02); mc.ioWrite(0x3c5, 1, 0x05);          // Sequencer map-mask = planes 0 and 2
  mc.ioWrite(0x3ce, 1, 0x05); mc.ioWrite(0x3cf, 1, 0x00);          // Graphics Ctrl write mode 0
  mem.w8(0xa0000, 0xff);                                           // → planes 0,2 = 0xFF; 1,3 untouched
  eq('planar plane0 written', vga.planes[0], 0xff);
  eq('planar plane1 masked out', vga.planes[0x10000], 0x00);
  eq('planar plane2 written', vga.planes[0x20000], 0xff);
  mc.ioWrite(0x3ce, 1, 0x04); mc.ioWrite(0x3cf, 1, 0x02);          // read-map select = plane 2
  eq('planar read-back plane2', mem.r8(0xa0000), 0xff);
  mc.ioWrite(0x3cf, 1, 0x01);                                      // read-map select = plane 1
  eq('planar read-back plane1', mem.r8(0xa0000), 0x00); }

// ---- Interrupt chaining: a guest that far-jumps to a saved BIOS vector (f000:n) — the
// ubiquitous TSR/game pattern — must hit a real IRET stub and return, not run off into
// uninitialised BIOS memory (this was Commander Keen's INT 8 derail). Simulate an interrupt
// frame (PUSHF; PUSH CS; PUSH ret) then JMP FAR f000:0008; the IRET must resume at `cont`.
{ const { cpu } = run([0x9c, 0x0e, 0xb8, 0x0b, 0x00, 0x50, 0xea, 0x08, 0x00, 0x00, 0xf0, 0xbb, 0x78, 0x56, 0xf4]);
  eq('chain to f000 stub returns via IRET', cpu.bx, 0x5678); }

// ---- 8042 keyboard controller: a queued scancode is delivered to a guest INT 9h handler via
// port 0x60 + IRQ1, once interrupts are unmasked (the run-loop polls the pending IRQ). This is
// the path QBasic's IDE and most games use for input, distinct from the BIOS INT 16h buffer.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu, mem = mc.mem;
  mem.blit(0x100 * 16 + 0x50, Uint8Array.from([0xe4, 0x60, 0xa2, 0x80, 0x00, 0xcf])); // INT9: in al,0x60; mov [0x80],al; iret
  mc.setVector(9, 0x100, 0x50);
  mem.blit(0x100 * 16, Uint8Array.from([0xfb, 0xeb, 0xfe]));   // sti; jmp $   (spin with IF set)
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0x100); cpu.setSeg(SS, 0x100); cpu.sp = 0x1000;
  cpu.flags &= ~0x200;                                          // start with IF clear — the STI must unmask
  mc.pushScancodes([0x1e]);                                     // scancode for 'a'
  for (let i = 0; i < 4; i++) { mc.pumpKeyboard(); mc.runSlice(2000); }
  eq('8042 IRQ1 delivers scancode to guest INT 9', mem.u8[0x100 * 16 + 0x80], 0x1e); }

// ---- 0x67 address-size prefix: 32-bit effective addresses (ModRM + SIB + disp32) ------------
// The 8088 conformance vectors cannot reach this (386-only), and a mis-decode is silent: a 0x67
// instruction is 1-5 bytes longer than its 16-bit lookalike, so getting the LENGTH wrong
// desynchronises the whole instruction stream. Test both the value AND the resulting stream sync
// (each case ends with `mov bx,0x1234; hlt` — BX only lands if the earlier lengths were right).
{ // MOV AX,[EDI+0x10] — mod=01 disp8, 32-bit base
  const { cpu } = run([0x67, 0x8b, 0x47, 0x10, 0xbb, 0x34, 0x12, 0xf4],
    ({ cpu, mc }) => { cpu.reg[7] = 0x2000; mc.mem.w16(0x200 * 16 + 0x2010, 0xbeef); });
  eq('addr32 [EDI+disp8] value', cpu.reg[0] & 0xffff, 0xbeef);
  eq('addr32 [EDI+disp8] stream stayed in sync', cpu.reg[3] & 0xffff, 0x1234); }
{ // LEA AX,[EAX+EAX*4] — SIB scale=2 (x4), index=base=EAX; EAX=3 -> 15
  const { cpu } = run([0x67, 0x8d, 0x04, 0x80, 0xbb, 0x34, 0x12, 0xf4], ({ cpu }) => { cpu.reg[0] = 3; });
  eq('addr32 SIB LEA [EAX+EAX*4]', cpu.reg[0] & 0xffff, 15);
  eq('addr32 SIB LEA stream stayed in sync', cpu.reg[3] & 0xffff, 0x1234); }
{ // MOV AX,[ECX*4+disp32] — SIB with base=101 & mod=0 => no base, disp32 follows the SIB
  const { cpu } = run([0x67, 0x8b, 0x04, 0x8d, 0x00, 0x20, 0x00, 0x00, 0xbb, 0x34, 0x12, 0xf4],
    ({ cpu, mc }) => { cpu.reg[1] = 4; mc.mem.w16(0x200 * 16 + 0x2010, 0x5678); });
  eq('addr32 SIB [ECX*4+disp32]', cpu.reg[0] & 0xffff, 0x5678);
  eq('addr32 SIB disp32 stream stayed in sync', cpu.reg[3] & 0xffff, 0x1234); }
{ // MOV AX,[EBX+ESI*2+4] — SIB with a real base, mod=01 disp8
  const { cpu } = run([0x67, 0x8b, 0x44, 0x73, 0x04, 0xbb, 0x34, 0x12, 0xf4],
    ({ cpu, mc }) => { cpu.reg[3] = 0x2000; cpu.reg[6] = 8; mc.mem.w16(0x200 * 16 + 0x2014, 0x9abc); });
  eq('addr32 SIB [EBX+ESI*2+disp8]', cpu.reg[0] & 0xffff, 0x9abc);
  eq('addr32 SIB base+index stream stayed in sync', cpu.reg[3] & 0xffff, 0x1234); }
{ // MOV AX,[moffs32] — A1 takes a 4-byte displacement under 0x67, not 2
  const { cpu } = run([0x67, 0xa1, 0x10, 0x20, 0x00, 0x00, 0xbb, 0x34, 0x12, 0xf4],
    ({ mc }) => { mc.mem.w16(0x200 * 16 + 0x2010, 0xcafe); });
  eq('addr32 moffs32 value', cpu.reg[0] & 0xffff, 0xcafe);
  eq('addr32 moffs32 stream stayed in sync', cpu.reg[3] & 0xffff, 0x1234); }
{ // [EBP] defaults to SS (like 16-bit [BP]) — SS=0x300 here, DS=0x200
  const { cpu } = run([0x67, 0x8b, 0x45, 0x00, 0xbb, 0x34, 0x12, 0xf4],
    ({ cpu, mc }) => { cpu.reg[5] = 0x40; mc.mem.w16(0x300 * 16 + 0x40, 0x0ff0); mc.mem.w16(0x200 * 16 + 0x40, 0xdead); });
  eq('addr32 [EBP] defaults to SS', cpu.reg[0] & 0xffff, 0x0ff0); }

// ---- 0x66 operand-size on the sign-extend and stack-frame opcodes ---------------------------
{ // 66 98 = CWDE (AX->EAX), not CBW. AX=0x8001 -> EAX=0xFFFF8001
  const { cpu } = run([0x66, 0x98, 0xf4], ({ cpu }) => { cpu.reg[0] = 0x00008001; });
  eq('66 98 = CWDE (not CBW)', cpu.reg[0] >>> 0, 0xffff8001); }
{ // 66 99 = CDQ (EAX->EDX:EAX), not CWD. EAX negative -> EDX = 0xFFFFFFFF
  const { cpu } = run([0x66, 0x99, 0xf4], ({ cpu }) => { cpu.reg[0] = 0x80000000; cpu.reg[2] = 0x1234; });
  eq('66 99 = CDQ (not CWD)', cpu.reg[2] >>> 0, 0xffffffff); }
{ // plain 98/99 must still be CBW/CWD
  const { cpu } = run([0x98, 0x99, 0xf4], ({ cpu }) => { cpu.reg[0] = 0x000000ff; });
  eq('98 still CBW', cpu.reg[0] & 0xffff, 0xffff);
  eq('99 still CWD', cpu.reg[2] & 0xffff, 0xffff); }

// ---- a #DE must abort the block ------------------------------------------------------------
// DIV by zero vectors INT 0. If the block kept running, its terminator would overwrite cpu.eip and
// silently discard the interrupt — on a stack that already holds the IRET frame.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0x200); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mc.setVector(0, 0x400, 0x10);                                  // guest #DE handler at 0400:0010
  //  xor ah,ah ; div bl  (BL=0 -> #DE) ; mov bx,0x1234 ; hlt
  mc.mem.blit(0x100 * 16, Uint8Array.from([0x30, 0xe4, 0xf6, 0xf3, 0xbb, 0x34, 0x12, 0xf4]));
  cpu.reg[3] = 0x0000;
  mc.rec.step();
  eq('#DE vectors to the guest handler', (cpu.seg[CS] << 16) | (cpu.eip & 0xffff), (0x400 << 16) | 0x10);
  eq('#DE aborted the block (BX untouched)', cpu.reg[3] & 0xffff, 0x0000);
  eq('#DE pushed the faulting IP, not the block start', mc.mem.r16(0x300 * 16 + ((cpu.sp) & 0xffff)), 0x0002); }

// ---- 0x67 on the implicit-address instructions (strings, XLAT, LOOP, JCXZ) -------------------
{ // 67 F3 A4 = REP MOVSB over ESI/EDI/ECX. Put the pointers above 0xFFFF so 16-bit regs can't work.
  const { cpu, mc } = run([0x67, 0xf3, 0xa4, 0xf4], ({ cpu, mc }) => {
    cpu.setSeg(DS, 0); cpu.setSeg(ES, 0);
    cpu.reg[6] = 0x12000; cpu.reg[7] = 0x13000; cpu.reg[1] = 4;      // ESI, EDI, ECX
    mc.mem.blit(0x12000, Uint8Array.from([1, 2, 3, 4]));
  });
  eq('67 REP MOVSB copies via ESI/EDI', mc.mem.r32(0x13000) >>> 0, 0x04030201);
  eq('67 REP MOVSB drains ECX', cpu.reg[1] >>> 0, 0);
  eq('67 REP MOVSB advances ESI past 16 bits', cpu.reg[6] >>> 0, 0x12004); }
{ // 67 D7 = XLAT using EBX
  const { cpu } = run([0x67, 0xd7, 0xf4], ({ cpu, mc }) => {
    cpu.setSeg(DS, 0); cpu.reg[3] = 0x12000; cpu.reg[0] = 0x0003; mc.mem.w8(0x12003, 0x7e);
  });
  eq('67 XLAT uses EBX', cpu.reg[0] & 0xff, 0x7e); }
{ // 67 E2 00 = LOOP to the next instruction: exercises the decrement alone. A 16-bit decrement of
  // ECX=0x00010000 would borrow only within CX (→0x0001FFFF); the 32-bit one gives 0x0000FFFF.
  const { cpu } = run([0x67, 0xe2, 0x00, 0xf4], ({ cpu }) => { cpu.reg[1] = 0x00010000; });
  eq('67 LOOP decrements ECX (not CX)', cpu.reg[1] >>> 0, 0x0000ffff); }
{ // 67 E3 = JECXZ: ECX=0x10000 is non-zero, but CX==0 — a 16-bit test would wrongly jump
  const { cpu } = run([0x67, 0xe3, 0x02, 0xbb, 0x34, 0x12, 0xf4], ({ cpu }) => { cpu.reg[1] = 0x00010000; });
  eq('67 JECXZ tests ECX, not CX', cpu.reg[3] & 0xffff, 0x1234); }

// ---- 0x66 on the stack-frame opcodes (PUSHAD/POPAD/PUSHFD/POPFD) ----------------------------
{ // 66 60 / 66 61 must move 32 bytes, and round-trip EAX's full width
  const { cpu } = run([0x66, 0x60, 0x66, 0x61, 0xf4], ({ cpu }) => { cpu.reg[0] = 0xdeadbeef; });
  eq('66 PUSHAD/POPAD round-trips EAX', cpu.reg[0] >>> 0, 0xdeadbeef); }
{ // PUSHAD pushes 32 bytes: SP must drop by exactly that
  const { cpu } = run([0x66, 0x60, 0xf4], ({ cpu }) => { cpu.sp = 0x1000; });
  eq('66 PUSHAD moves SP by 32', (0x1000 - cpu.sp) & 0xffff, 32); }
{ // 66 9C PUSHFD pushes 4 bytes, not 2
  const { cpu } = run([0x66, 0x9c, 0xf4], ({ cpu }) => { cpu.sp = 0x1000; });
  eq('66 PUSHFD moves SP by 4', (0x1000 - cpu.sp) & 0xffff, 4); }

// ---- unhandled INTs are reported, not silently "successful" --------------------------------
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mc.mem.blit(0x100 * 16, Uint8Array.from([0xf8, 0xcd, 0x13, 0xf4]));   // clc ; int 13h ; hlt
  let steps = 0; while (!cpu.halted && steps++ < 50) mc.rec.step();
  eq('unhandled INT 13h sets CF (not a silent success)', cpu.flags & 1, 1);
  eq('unhandled INT 13h is counted', mc.unhandledInts[0x13], 1); }

// ---- INT 13h AH=08h: ES:DI belongs to the CALLER on a fixed disk ------------------------------
// MS-DOS 4's IO.SYS holds its drive-table pointer in DI across this call and stores the geometry
// through it the instruction after (`mov [di+15h],dh`). Zeroing ES:DI for want of a table sent
// those stores into the IVT and left the BPB at IO.SYS's template, so the divide at 0070:3aeb
// divided by heads * sectorsPerTrack = 0. SeaBIOS under QEMU and under v86 both hand ES:DI back
// untouched; only floppies get the diskette parameter table.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  installBIOS(mc); installDisk(mc);
  mc.disk.attach(0x80, new Uint8Array(1024 * 1024), { cyl: 32, heads: 4, spt: 16, type: 3 });
  mc.disk.attach(0x00, new Uint8Array(737280));
  cpu.setSeg(ES, 0xbeef); cpu.di = 0x1234; cpu.ax = 0x0800; cpu.dx = 0x0080;
  mc.intHandlers[0x13](cpu, mc);
  eq('AH=08h on a fixed disk preserves ES', cpu.seg[ES], 0xbeef);
  eq('AH=08h on a fixed disk preserves DI', cpu.di & 0xffff, 0x1234);
  eq('AH=08h on a fixed disk reports heads-1 in DH', (cpu.dx >> 8) & 0xff, 3);
  cpu.setSeg(ES, 0xbeef); cpu.di = 0x1234; cpu.ax = 0x0800; cpu.dx = 0x0000;
  mc.intHandlers[0x13](cpu, mc);
  eq('AH=08h on a floppy still returns the diskette parameter table', cpu.seg[ES], 0xf000);
  eq('...at the offset INT 1Eh points to', cpu.di & 0xffff, 0xefc7); }

// ---- INT 13h AH=15h: the sector count is a FIXED-DISK answer -----------------------------------
// On a floppy a real BIOS reports the type in AH and leaves everything else to the caller. MS-DOS 4
// keeps its drive-table loop variable in DL across the call, so returning the count there (0x0b40
// for a 1.44M disk) made it build both floppy entries for drive 0x40. SeaBIOS answers
// AX=0100 CX=5555 DX=0001 to a probe that arrives with CX=5555 and DL=1.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  installBIOS(mc); installDisk(mc);
  mc.disk.attach(0x00, new Uint8Array(1474560));
  mc.disk.attach(0x80, new Uint8Array(1024 * 1024), { cyl: 32, heads: 4, spt: 16, type: 3 });
  cpu.ax = 0x1500; cpu.cx = 0x5555; cpu.dx = 0x0000;
  mc.intHandlers[0x13](cpu, mc);
  eq('AH=15h calls a floppy type 01', (cpu.ax >> 8) & 0xff, 0x01);
  eq('AH=15h leaves CX alone on a floppy', cpu.cx & 0xffff, 0x5555);
  eq('AH=15h leaves DX alone on a floppy', cpu.dx & 0xffff, 0x0000);
  cpu.ax = 0x1500; cpu.cx = 0x5555; cpu.dx = 0x0080;
  mc.intHandlers[0x13](cpu, mc);
  eq('AH=15h calls a fixed disk type 03', (cpu.ax >> 8) & 0xff, 0x03);
  eq('...and reports its sector count in CX:DX', ((cpu.cx & 0xffff) << 16) | (cpu.dx & 0xffff), 2048);
  // BL is the IBM drive-type code, not a size class: a 1.44M drive is 04, not "anything big".
  cpu.ax = 0x0800; cpu.dx = 0x0000; cpu.bx = 0xff00;
  mc.intHandlers[0x13](cpu, mc);
  eq('AH=08h reports a 1.44M floppy as drive type 04', cpu.bx & 0xff, 0x04);
  eq('...with the geometry SeaBIOS gives for it', cpu.cx & 0xffff, 0x4f12); }

// ---- a 286 TSS lays its inner-ring stacks out differently from a 386 one ----------------------
// Windows 3.1 in standard mode enters its ring-0 kernel through a 286 call gate, and the inward
// stack switch reads SS0/SP0 out of a 286 TSS: SP0 at +2, SS0 at +4, four bytes per level. Read as
// a 386 TSS (ESP0 at +4, SS0 at +8) the selector comes from past the end of a 2Ch-byte TSS, i.e.
// zero, and the switch raises #GP(0).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  const GDT = 0x8000, TSS286 = 0x9000, TSS386 = 0x9100;
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, base, limit, access) => {
    const a = GDT + i * 8;
    mc.mem.w16(a, limit & 0xffff); mc.mem.w16(a + 2, base & 0xffff);
    mc.mem.w8(a + 4, (base >> 16) & 0xff); mc.mem.w8(a + 5, access);
    mc.mem.w8(a + 6, (limit >> 16) & 0x0f); mc.mem.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(1, TSS286, 0x2b, 0x81);                       // type 1: available 286 TSS
  desc(2, TSS386, 0x67, 0x89);                       // type 9: available 386 TSS
  mc.mem.w16(TSS286 + 2, 0x30a8); mc.mem.w16(TSS286 + 4, 0x0068);            // SP0, SS0
  mc.mem.w32(TSS386 + 4, 0x00012340); mc.mem.w16(TSS386 + 8, 0x0010);        // ESP0, SS0
  cpu.loadTR(0x08);
  eq('a 286 TSS is recognised as one', cpu.tr.is386, false);
  eq('...and SS0 comes from +4', cpu.tssStack(0).ss, 0x0068);
  eq('...and SP0 from +2', cpu.tssStack(0).esp, 0x30a8);
  cpu.loadTR(0x10);
  eq('a 386 TSS is recognised as one', cpu.tr.is386, true);
  eq('...and SS0 comes from +8', cpu.tssStack(0).ss, 0x0010);
  eq('...and ESP0 from +4, 32 bits wide', cpu.tssStack(0).esp >>> 0, 0x00012340); }

// ---- CPUID, and the generation it belongs to ---------------------------------------------------
// CPUID is 486-and-later, so it is a PROFILE feature: on the default 386 the opcode is not there and
// EFLAGS.ID must not stick, which is how software detects it. kvm-unit-tests' realmode suite runs
// CPUID unconditionally and was stopped dead by it (105 of 127 cases reached); with the '586'
// profile it now matches QEMU and v86 at 127/127.
{ const mc = new Machine({ memSize: 1 << 20, cpu: '586' }); const cpu = mc.cpu;
  cpu.reg[0] = 0; cpu.cpuid();
  eq('CPUID leaf 0 reports one further leaf', cpu.reg[0] >>> 0, 1);
  // The vendor is ours, not a copy of anyone's: EBX:EDX:ECX spell it in that order.
  const vendor = [cpu.reg[3], cpu.reg[2], cpu.reg[1]]
    .map((r) => String.fromCharCode(r & 0xff, (r >> 8) & 0xff, (r >> 16) & 0xff, (r >>> 24) & 0xff)).join('');
  eq('CPUID leaf 0 gives our own vendor string', vendor, 'MIRAGE      ');
  cpu.reg[0] = 1; cpu.cpuid();
  eq('CPUID leaf 1 reports family 5', (cpu.reg[0] >> 8) & 0xf, 5);
  // Each feature bit is set only if MIRAGE implements the thing: an x87 (src/fpu.js) and RDTSC.
  eq('CPUID claims the FPU', cpu.reg[2] & 1, 1);
  eq('CPUID claims the TSC', (cpu.reg[2] >> 4) & 1, 1);
  eq('CPUID claims no SSE, which we implement only in part', (cpu.reg[2] >> 25) & 1, 0);
  eq('CPUID claims no CMPXCHG8B, which we do not have', (cpu.reg[2] >> 8) & 1, 0);
  cpu.reg[0] = 7; cpu.cpuid();
  eq('an unknown leaf answers zeros', (cpu.reg[0] | cpu.reg[1] | cpu.reg[2] | cpu.reg[3]) >>> 0, 0); }
{ // The ID flag and CPUID are one feature: a CPU that accepts the bit but has no CPUID cannot exist.
  eq('the 586 profile lets EFLAGS.ID be written', new Machine({ memSize: 1 << 20, cpu: '586' }).cpu.idFlagMask, 0x200000);
  eq('the 386 profile does not', new Machine({ memSize: 1 << 20, cpu: '386' }).cpu.idFlagMask, 0); }
{ // SMSW to a 32-bit REGISTER stores the whole of CR0; to memory it is 16 bits, always.
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.cr0 = 0x40000011;
  // 66 0f 01 e0 = smswl %eax ; f4 = hlt
  mc.mem.blit(0x100 * 16, Uint8Array.from([0x66, 0x0f, 0x01, 0xe0, 0xf4]));
  let steps = 0; while (!cpu.halted && steps++ < 20) mc.rec.step();
  eq('SMSW to a 32-bit register gives the whole of CR0', cpu.reg[0] >>> 0, 0x40000011); }
{ // MOV to and from a debug register IGNORES the mod field, and the value must read back.
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.reg[3] = 0xaced;
  // 0f 23 c3 = mov %ebx,%dr0 ; 0f 21 00 = mov %dr0,%eax with mod=00 ; f4 = hlt
  mc.mem.blit(0x100 * 16, Uint8Array.from([0x0f, 0x23, 0xc3, 0x0f, 0x21, 0x00, 0xf4]));
  let steps = 0; while (!cpu.halted && steps++ < 20) mc.rec.step();
  eq('a debug register reads back what was written', cpu.reg[0] >>> 0, 0xaced);
  eq('...and the mod bits consumed no displacement', cpu.eip >>> 0, 7); }

// ---- LAR and LSL answer for a NOT-PRESENT descriptor -------------------------------------------
// Presence is not one of LAR's conditions, and that is the point of the instruction: it is how
// software asks about a segment that may have been discarded, and it hands back the access byte so
// the caller can test P itself. Windows 3.1's KERNEL does exactly that — `lar ax,[ss:bx+2]` / `jnz
// fail` / `test ah,0x80` at 037f:0ede — so refusing P=0 turned "discarded, go and load it" into
// "not a valid selector", the segment was never loaded, and the far call into it ran through empty
// memory. The six expected answers below are the ones QEMU and v86 both give to tools/larprobe.asm.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  const GDT = 0x8000;
  cpu.gdtr = { base: GDT, limit: 0x27 };              // four descriptors: 0x28 is past the end
  const desc = (i, base, limit, access) => {
    const a = GDT + i * 8;
    mc.mem.w16(a, limit & 0xffff); mc.mem.w16(a + 2, base & 0xffff);
    mc.mem.w8(a + 4, (base >> 16) & 0xff); mc.mem.w8(a + 5, access);
    mc.mem.w8(a + 6, (limit >> 16) & 0x0f); mc.mem.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(1, 0, 0xffff, 0x9a);                           // present code
  desc(3, 0, 0xffff, 0x1b);                           // code, readable — NOT PRESENT
  desc(4, 0, 0x1234, 0x12);                           // data, writable — NOT PRESENT
  cpu.cr0 |= 1;
  eq('LAR accepts a not-present descriptor', cpu.larRights(0x18, 0), 0x1b00);
  eq('LAR accepts a present one', cpu.larRights(0x08, 0), 0x9a00);
  eq('LAR refuses the null selector', cpu.larRights(0x00, 0), -1);
  eq('LAR refuses a selector past the table', cpu.larRights(0x38, 0), -1);
  eq('LSL accepts a not-present descriptor too', cpu.lslLimit(0x20), 0x1234);
  eq('LSL refuses a selector past the table', cpu.lslLimit(0x38), -1); }

// ---- #UD belongs to whoever holds the vector, in EITHER mode ------------------------------------
// An invalid opcode is a service, and guests use it: Windows 3.1's DOS extender installs a handler
// for vector 6 through DPMI and then executes `0f ff` on purpose. Ownership was read from the
// real-mode IVT only, so in protected mode the answer was always "the guest has no handler" and
// MIRAGE threw "unimplemented opcode 0x0f 0xff" at a fault the guest had just asked for.
// The segment bases are set BEFORE PE goes on, which is what a guest does across the transition:
// the descriptor caches keep the real-mode bases until something reloads them. It is the only way
// to place code for the recompiler without also building a GDT, which is not what is under test.
const udRun = (gated) => {
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  const IDT = 0xa000;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.cr0 |= 1; cpu.idtr = { base: IDT, limit: 0xff };
  if (gated) mc.mem.w8(IDT + 6 * 8 + 5, 0x8e);        // present 386 interrupt gate for vector 6
  mc.mem.blit(0x100 * 16, Uint8Array.from([0x0f, 0xff, 0xf4]));
  let raised = null, caught = null;
  mc.protInt = (n) => { raised = n; cpu.halted = true; };
  try { let steps = 0; while (!cpu.halted && steps++ < 20) mc.rec.step(); }
  catch (e) { caught = String(e.message || e); }
  return { raised, caught };
};
{ eq('an invalid opcode in protected mode reaches the guest gate', udRun(true).raised, 6);
  // ...and with NO gate the diagnostic must survive: an unhandled #UD would re-raise for ever.
  const bare = udRun(false);
  eq('with no gate for vector 6 nothing is delivered', bare.raised, null);
  eq('...and it still says what it could not do',
    !!(bare.caught && bare.caught.includes('0x0f 0xff')), true); }


// ---- INT 15h AH=C0h: the system configuration table ---------------------------------------------
// Windows 1.01 and 2.03 ask for this before deciding what machine they are on. With no table they
// fall through to the Microsoft serial-mouse probe, find nothing, and never draw a cursor — which is
// how a missing BIOS table read as a missing mouse. Both reference BIOSes answer the same shape:
// length 8, model FCh (AT), submodel 0, revision 1.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  installBIOS(mc);
  cpu.ax = 0xc000; cpu.flags |= 1;
  mc.intHandlers[0x15](cpu, mc);
  eq('AH=C0h clears CF', cpu.flags & 1, 0);
  eq('AH=C0h returns AH=0', (cpu.ax >> 8) & 0xff, 0);
  eq('AH=C0h points ES:BX at the table in the BIOS segment', cpu.seg[ES], 0xf000);
  const t = (cpu.seg[ES] << 4) + (cpu.bx & 0xffff);
  eq('the table is 8 bytes long', mc.mem.r16(t), 8);
  eq('...for an AT-class machine', mc.mem.r8(t + 2), 0xfc);
  // Each feature bit is only set if it is true HERE: a cascaded PIC and an RTC, nothing else. Both
  // references also set bit 6 of feature byte 2 (INT 16h AH=09h), which our INT 16h does not have.
  eq('feature byte 1 claims the second PIC and the RTC, and nothing else', mc.mem.r8(t + 5), 0x60);
  eq('feature byte 2 claims nothing', mc.mem.r8(t + 6), 0x00); }

// ---- MC146818 clock + CMOS ---------------------------------------------------------------------
// The chip is the reference, not any one BIOS: four implementations (SeaBIOS under QEMU and under
// v86, the Bochs BIOS, DOSBox-X) answer INT 1Ah by copying these registers out verbatim, and every
// difference between them was a difference in what their CMOS held.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  installBIOS(mc);
  const cmos = (reg) => { mc.portWrite[0x70](0x70, 1, reg); return mc.portRead[0x71](0x71, 1) & 0xff; };
  eq('CMOS register B is 24-hour BCD with no daylight saving', cmos(0x0b), 0x02);
  eq('CMOS register D reports a valid clock (VRT)', cmos(0x0d) & 0x80, 0x80);
  eq('CMOS register A has the divider on and UIP clear', cmos(0x0a), 0x26);
  // There is no century register in the chip; the byte INT 1Ah returns in CH lives in CMOS RAM,
  // at 32h on the AT and 37h on PS/2, and it has to match the year or the guest lands 100 years out.
  eq('the AT century byte matches the epoch', cmos(0x32), 0x19);
  eq('the PS/2 century byte holds the same', cmos(0x37), 0x19);
  eq('the clock starts in year 90 (BCD)', cmos(0x09), 0x90);
  eq('...in month 01', cmos(0x08), 0x01);
  eq('...on day 01', cmos(0x07), 0x01);
  eq('...which the chip knows was a Monday', cmos(0x06), 2);        // 1-7, Sunday = 1
  // MS-DOS and PC DOS decide whether the machine HAS a clock by checking AH=02h for non-zero
  // values, so a machine that powers up at midnight reads as having none — measured on MS-DOS 4,
  // which then skips AH=04h and falls back to 01-01-1980.
  cpu.ax = 0x0200; cpu.cx = 0x5555; cpu.dx = 0x5555; cpu.flags |= 1;
  mc.intHandlers[0x1a](cpu, mc);
  eq('AH=02h clears CF', cpu.flags & 1, 0);
  eq('AH=02h returns a NON-ZERO time', (cpu.cx & 0xffff) !== 0, true);
  eq('AH=02h returns BCD hours and minutes', cpu.cx & 0xffff, 0x0800);
  eq('AH=02h reports no daylight saving in DL', cpu.dx & 0xff, 0x00);
  cpu.ax = 0x0400; cpu.cx = 0x5555; cpu.dx = 0x5555; cpu.flags |= 1;
  mc.intHandlers[0x1a](cpu, mc);
  eq('AH=04h clears CF', cpu.flags & 1, 0);
  eq('AH=04h returns century and year in BCD', cpu.cx & 0xffff, 0x1990);
  eq('AH=04h returns month and day in BCD', cpu.dx & 0xffff, 0x0101);
  cpu.ax = 0x2c00; mc.intHandlers[0x1a](cpu, mc);
  eq('an unknown INT 1Ah function sets CF instead of passing silently', cpu.flags & 1, 1);
  // Setting the date through AH=05h moves the chip.
  cpu.ax = 0x0500; cpu.cx = 0x2013; cpu.dx = 0x0725;
  mc.intHandlers[0x1a](cpu, mc);
  cpu.ax = 0x0400; mc.intHandlers[0x1a](cpu, mc);
  eq('AH=05h then AH=04h round-trips the year', cpu.cx & 0xffff, 0x2013);
  eq('...and the month and day', cpu.dx & 0xffff, 0x0725); }

// ---- CPU profiles: the generation differences a DOS program uses to DETECT the chip -----------
// Until src/cpu-profile.js existed, MIRAGE was a hybrid nobody shipped — 8088 on some corners, 286
// on others, 386 decoding throughout — so a detection routine could conclude something impossible.
// Each of these is a DEFINED difference, not an undefined-flag corner.
{
  /** Run `code` at 0100:0000 under `cpu` profile until HLT, return the machine. */
  const run = (cpuProfile, code) => {
    const mc = new Machine({ memSize: 1 << 20, cpu: cpuProfile });
    const c = mc.cpu;
    c.setSeg(CS, 0x100); c.eip = 0; c.setSeg(SS, 0x300); c.sp = 0x1000;
    mc.mem.blit(0x100 * 16, Uint8Array.from(code));
    let n = 0; while (!c.halted && n++ < 200) mc.rec.step();
    return mc;
  };

  // NOTE on shifts: `shiftCountMask` is plumbed through the profile, but the 8088 shift ARITHMETIC
  // for counts >= the operand size is not implemented — the helpers assume a masked count, and JS's
  // own `<<` masks to 5 bits anyway. `MIRAGE_CPU=8088 node tools/conformance.js d2.4 d3.4` measures
  // exactly what that costs: 81.19%, against 100% (with 4028 cases skipped) under the default. That
  // number is the size of the remaining work, so there is no assertion here pretending otherwise.

  // PUSH SP: an 8086/88 pushes SP AFTER the decrement, a 286+ the value it had on entry.
  const pushsp = [0x54, 0x58, 0xf4];                      // push sp ; pop ax ; hlt
  eq('386: PUSH SP pushes the entry value', run('386', pushsp).cpu.reg[0] & 0xffff, 0x1000);
  eq('8088: PUSH SP pushes the decremented value', run('8088', pushsp).cpu.reg[0] & 0xffff, 0x0ffe);

  // PUSHF: an 8086/88 always reads bits 12-15 back as 1; a 286+ clears them in real mode.
  const pushf = [0x9c, 0x58, 0xf4];                       // pushf ; pop ax ; hlt
  eq('386: PUSHF clears the reserved bits', run('386', pushf).cpu.reg[0] & 0xf000, 0x0000);
  eq('8088: PUSHF sets the reserved bits', run('8088', pushf).cpu.reg[0] & 0xf000, 0xf000);

  let threw = false;
  try { new Machine({ memSize: 1 << 20, cpu: 'z80' }); } catch { threw = true; }
  eq('an unknown profile is refused rather than silently ignored', threw, true);
}

// ---- #PF, CPL, and the descriptor-table limit ------------------------------------------------
{
  // CPL is STORED. Between `mov cr0` (PE on) and the far jump that reloads CS, the selector register
  // still holds the REAL-MODE value, whose low two bits mean nothing. Windows 3.0 sits there with
  // CS = 0x13b, and a CPL derived from `seg[CS] & 3` read 3 — so the far jump to its DPL-0 code
  // selector was rejected with #GP(8), one instruction into protected mode.
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.setSeg(CS, 0x13b);
  eq('CPL is 0 in real mode whatever CS looks like', cpu.cpl, 0);
  cpu.setCR0(cpu.cr0 | 1);                            // PE on, CS not yet reloaded
  eq('...and stays 0 across the PE transition, before CS is reloaded', cpu.cpl, 0);
}
{
  // A selector past the table limit is #GP(selector), not a read past the table.
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  let raised = null;
  mc.protInt = (n, err) => { raised = { n, err }; };
  cpu.cr0 |= 1;
  cpu.gdtr = { base: 0x2000, limit: 0x0f };           // two descriptors only
  cpu.setSeg(DS, 0x40);                               // index 8 — well past it
  eq('a selector past the GDT limit raises #GP', raised && raised.n, 13);
  eq('...with that selector as the error code', raised && raised.err, 0x40);
  eq('readDesc reports no descriptor there rather than reading past', cpu.readDesc(0x40), null);
}
{
  // #PF: a not-present page raises INT 14 with CR2 and the error code, instead of reading zero.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  mem.w32(0x1000, 0x2003);                            // PDE[0] present -> table at 0x2000
  mem.w32(0x2000, 0x0003);                            // PTE[0] present, everything else absent
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);
  eq('paging: the mapped page reads back', mem.r8(0), mem.u8[0]);
  let caught = null;
  try { mem.r8(0x9000); } catch (e) { caught = e; }
  eq('a not-present page throws a PageFault instead of reading zero', caught && caught.constructor.name, 'PageFault');
  eq('...carrying the faulting linear address', caught && caught.lin, 0x9000);
  eq('...and whether it was a write', caught && caught.write, false);
  let w = null;
  try { mem.w8(0x9000, 1); } catch (e) { w = e; }
  eq('...a write says so', w && w.write, true);
  // A bare Memory has no run loop to catch it, so it keeps the old silent zero.
  const bare = new Machine({ memSize: 1 << 20 }).mem;
  bare.pfRaise = false;
  eq('with pfRaise off it still reads zero, for inspectors', bare.r8(0x1234) >= 0, true);
}

// ---- multi-byte memory access is translated under paging -------------------------------------
// Only r8/w8 translated; r16/r32/w16/w32 did `a &= this.mask`, which treats a LINEAR address as
// physical. loadDescriptor mixes r16 and r8, so every descriptor load was HALF translated. Windows
// 3.0's WIN386 puts its GDT at linear 0x8010011c and we read the descriptor from 0x0010011c.
{
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;   // without A20 the mask is 20 bits and every
                                           // address above 1 MiB folds back onto zero
  // One page directory at 0x1000, one table at 0x2000: linear 0x00400000 -> physical 0x00300000.
  mem.w32(0x1000, 0x2003);                                     // PDE[0] -> table, present+rw
  for (let i = 0; i < 1024; i++) mem.w32(0x2000 + i * 4, ((i << 12) | 3) >>> 0);   // identity
  mem.w32(0x1000 + 1 * 4, 0x3003);                             // PDE[1] -> a second table
  for (let i = 0; i < 1024; i++) mem.w32(0x3000 + i * 4, (((0x300 + i) << 12) | 3) >>> 0);
  mem.w32(0x300000, 0xdeadbeef);                               // the physical frame linear 0x400000 maps to
  cpu.setCR3(0x1000);
  cpu.setCR0(0x80000001);                                      // PE | PG
  eq('paging: an 8-bit read is translated', mem.r8(0x400000), 0xef);
  eq('paging: a 16-bit read is translated too', mem.r16(0x400000), 0xbeef);
  eq('paging: and a 32-bit one', mem.r32(0x400000) >>> 0, 0xdeadbeef);
  mem.w32(0x400004, 0x12345678);
  eq('paging: a 32-bit write lands in the mapped frame', mem.r32(0x300004) >>> 0, 0x12345678);
  mem.w16(0x400008, 0xabcd);
  eq('paging: and a 16-bit one', mem.r16(0x300008), 0xabcd);
  // Clearing PG turns translation off even with PE still set — the cached `paged` flag has to follow
  // BOTH bits. 0x400000 now means physical 0x400000, which on this 4 MiB machine wraps to 0, not to
  // the frame the page tables pointed at.
  cpu.setCR0(0x00000001);
  eq('paging: clearing PG stops translation, even with PE still set',
     (mem.r32(0x400000) >>> 0) === 0xdeadbeef, false);
}

// ---- Mode X (unchained 256-colour) ----------------------------------------------------------
// Implemented since the planar work and exercised in anger by Wolf3D (88411 non-zero plane bytes),
// but nothing in the gate set pinned it, so a regression would have surfaced as "a game looks wrong"
// rather than as a failing test. The layout: clearing bit 3 of Sequencer index 4 (memory mode) while
// in mode 13h unchains the framebuffer, and pixel (x,y) then lives in plane (x&3) at plane offset
// start + y*stride + (x>>2) — four bytes of VRAM per four horizontal pixels, one per plane.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const cpu = mc.cpu, vga = mc.vga, mem = mc.mem;
  cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);                 // mode 13h, chained
  eq('mode 13h starts CHAINED', vga.modeX, false);
  eq('...and is not routed through the plane logic', mem.planar, false);

  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, vga.memMode & ~0x08);   // clear chain-4
  eq('clearing chain-4 in mode 13h enters Mode X', vga.modeX, true);
  eq('...which routes A000 through the plane logic', mem.planar, true);

  // One byte, one plane: with the map mask selecting plane 2 only, a write to A000:0005 must land in
  // plane 2 at offset 5 and nowhere else.
  mc.ioWrite(0x3c4, 1, 2); mc.ioWrite(0x3c5, 1, 0x04);            // map mask = plane 2
  mem.w8(0xa0000 + 5, 0xab);
  eq('a Mode X write lands in the selected plane', vga.planes[2 * 0x10000 + 5], 0xab);
  eq('...and in no other', [0, 1, 3].map((p) => vga.planes[p * 0x10000 + 5]).join(), '0,0,0');

  // Reads come from the plane the Graphics Controller's read-map-select names, not from the mask.
  mc.ioWrite(0x3ce, 1, 4); mc.ioWrite(0x3cf, 1, 2);               // read map select = plane 2
  eq('a Mode X read comes from the read-map-selected plane', mem.r8(0xa0000 + 5), 0xab);
  mc.ioWrite(0x3cf, 1, 0);
  eq('...and a different plane reads its own byte', mem.r8(0xa0000 + 5), 0x00);

  // The mask takes several planes at once, which is how a Mode X clear fills four pixels per write.
  mc.ioWrite(0x3c4, 1, 2); mc.ioWrite(0x3c5, 1, 0x0f);
  mem.w8(0xa0000 + 6, 0x7e);
  eq('a full map mask writes every plane', [0, 1, 2, 3].map((p) => vga.planes[p * 0x10000 + 6]).join(), '126,126,126,126');

  // And the RENDERER's half of the contract: plane p at offset o is the pixel at x = o%stride*4 + p,
  // y = o/stride. With the default stride of 80, plane 2 offset 5 is (22, 0) and plane 0 offset 6 is
  // (24, 0) — the memory layout above is only half the feature if the mapping back is wrong.
  const fakeCanvas = {
    width: 0, height: 0,
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }),
  };
  mc.bios.dac[0xab * 3] = 0x3f;                                   // make index 0xab distinguishable
  const video = new Video(mc, fakeCanvas);
  video._palette(); video._renderModeX();
  const at = (x, y) => video.u32[y * 320 + x];
  eq('Mode X renders plane 2 offset 5 at x=22', at(22, 0), video.pal[0xab]);
  eq('...and nothing at x=21', at(21, 0), video.pal[0]);
  eq('...and plane 0 offset 6 at x=24', at(24, 0), video.pal[0x7e]);

  // Restoring chain-4 leaves Mode X again — a game that switches back must not stay unchained.
  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, vga.memMode | 0x08);
  eq('restoring chain-4 leaves Mode X', vga.modeX, false);
  eq('...and stops routing A000 through the planes', mem.planar, false);
}

// ---- a self-modifying instruction still commits its FLAGS before the block stops ------------
// The guard used to `return` from inside the write emitter — the middle of an instruction — so
// everything the instruction had left to do was skipped. FreeDOS's kernel decompressor does
// `sub byte [cs:si+0x12],0x10` on its own code and then branches on the carry: the abort fired
// between the store and `cpu.setSub`, the following `jnc` read a stale carry, and the loop that
// should have fallen through ran a second pass whose segment arithmetic wrapped past 1 MiB over the
// kernel itself. The check belongs at the instruction boundary.
{
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.setSeg(DS, 0x100); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.eip = 0;
  // sub byte [0x0003],0x10 ; hlt — the target is byte 3 OF THIS INSTRUCTION, so the write lands
  // inside the running block and must stop it.
  mc.mem.blit(0x1000, Uint8Array.from([0x80, 0x2e, 0x03, 0x00, 0x10, 0xf4]));
  cpu.flags &= ~CF;
  mc.rec.step();
  eq('a self-modifying SUB still writes its result', mc.mem.u8[0x1003], 0xf0);
  eq('...and still commits its flags: 0x00 - 0x10 borrows', (cpu.flags & CF) !== 0, true);
  eq('...and the block stops AFTER it, not inside it', cpu.eip >>> 0, 5);
}

// ---- self-modification invalidation works above 2 GiB ----------------------------------------
// `invalidate` computed its page index with a SIGNED shift, so a linear address at or above 2 GiB
// came out negative and the lookup missed every time. Windows 3.0 pages its kernel in at linear
// 0x80006000 AFTER blocks there are translated, and we kept running the stale ones — a block decoded
// as `CD 20` (INT 20h) where the memory had since been rewritten to `FF 15 …` (an indirect call).
{
  const mc = new Machine({ memSize: 16 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  mem.w32(0x1000, 0x2003);
  for (let i = 0; i < 1024; i++) mem.w32(0x2000 + i * 4, ((i << 12) | 3) >>> 0);
  mem.w32(0x1000 + 512 * 4, 0x3003);                     // PDE[512]: linear 0x80000000 -> 0x500000
  for (let i = 0; i < 1024; i++) mem.w32(0x3000 + i * 4, (((0x500 + i) << 12) | 3) >>> 0);
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);
  const hits = [];
  const orig = mc.rec.invalidate.bind(mc.rec);
  mc.rec.invalidate = (a, l) => { hits.push(a >>> 0); return orig(a, l); };
  mem.markCodePage(0x80006);
  mem.w8(0x80006366, 0x90);
  eq('a write to a code page above 2 GiB reaches the invalidator', hits.length, 1);
  eq('...with the address unsigned', hits[0], 0x80006366);
  // And the invalidator itself must index the page unsigned, or it silently does nothing.
  mc.rec.invalidate = orig;
  let ok2 = true;
  try { mc.rec.invalidate(0x80006366, 1); } catch { ok2 = false; }
  eq('invalidate() survives an address above 2 GiB', ok2, true);
}

// ---- the STACK is a linear address too -------------------------------------------------------
// push/pop masked with mem.mask, which is the PHYSICAL wrap. Windows 3.0's kernel stack lives at
// linear 0x800131e8; with A20 closed that became 0x131e8, so every push landed in low memory and
// every pop read zeros — its exception dispatcher read a return address of 0 and called through a
// wild pointer, which is where 495 page faults on seven phantom pages came from.
{
  const mc = new Machine({ memSize: 16 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(false); mc.rec.MM = mem.mask;               // A20 CLOSED, as Windows leaves it
  mem.w32(0x1000, 0x2003);
  for (let i = 0; i < 1024; i++) mem.w32(0x2000 + i * 4, ((i << 12) | 3) >>> 0);
  mem.w32(0x1000 + 512 * 4, 0x3003);                     // PDE[512]: linear 0x80000000 -> physical 0x500000
  for (let i = 0; i < 1024; i++) mem.w32(0x3000 + i * 4, (((0x500 + i) << 12) | 3) >>> 0);
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);
  cpu.base[SS] = 0; cpu.ssB = 1; cpu.reg[4] = 0x800131e8;
  cpu.push32(0x80005fc7);                                // a return address, as a CALL would
  // linear 0x800131e4 -> PDE 512, PTE 0x13 -> frame (0x500+0x13)<<12 = 0x513000, offset 0x1e4
  const phys = 0x5131e4;
  const dw = (mem.u8[phys] | (mem.u8[phys + 1] << 8) | (mem.u8[phys + 2] << 16) | (mem.u8[phys + 3] << 24)) >>> 0;
  eq('a 32-bit push under paging goes to the mapped frame', dw, 0x80005fc7);
  eq('...and low memory is untouched', mem.u8[0x131e4], 0);
  eq('...and it pops back', cpu.pop32() >>> 0, 0x80005fc7);
  cpu.setCR0(0x00000001);                                // paging off: the physical wrap returns
  cpu.reg[4] = 0x800131e8;
  cpu.push16(0x1234);
  eq('with paging off the stack masks again', mem.r16(0x131e6), 0x1234);
}

// ---- a linear address is not masked under paging ---------------------------------------------
// A20 gates a PHYSICAL address line and the RAM-size wrap is physical too, so applying either
// BEFORE the page walk truncates the guest's address space. Windows 3.0 runs its kernel at linear
// 0x80201b5e; with A20 closed that was masked to 0x1b5e and we decoded whatever sat in low memory.
{
  const mc = new Machine({ memSize: 16 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(false); mc.rec.MM = mem.mask;              // A20 CLOSED: the 1 MiB wrap, as Windows leaves it
  eq('with A20 closed the real-mode mask is 1 MiB', mem.mask, 0xfffff);
  mem.w32(0x1000, 0x2003);                              // PDE[0] -> table, identity
  for (let i = 0; i < 1024; i++) mem.w32(0x2000 + i * 4, ((i << 12) | 3) >>> 0);
  mem.w32(0x1000 + 512 * 4, 0x3003);                    // PDE[512] covers linear 0x80000000+
  for (let i = 0; i < 1024; i++) mem.w32(0x3000 + i * 4, (((0x500 + i) << 12) | 3) >>> 0);
  mem.u8[0x500000] = 0xf4;                              // a HLT at the frame linear 0x80000000 maps to
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);
  eq('the recompiler knows paging is on', mc.rec.pagedMode, true);
  const blk = mc.rec.translate(0x80000000, 0x80000000, 4, 1);
  eq('a block above 1 MiB keeps its full linear address', blk.linStart >>> 0, 0x80000000);
  eq('...and decodes the byte the page tables point at', blk.count, 1);
  // Turning paging off restores the wrap, so real mode still gets it.
  cpu.setCR0(0x00000001);
  eq('clearing PG restores masking', mc.rec.pagedMode, false);
}
{
  // A paging change must END the slice: run() hoists pagedMode into a local at entry, so the rest of
  // a slice that turned paging on would keep masking — and cache those blocks under the masked key.
  const mc = new Machine({ memSize: 1 << 20 });
  mc.cpu.tbudget = 500;
  mc.cpu.setCR0(mc.cpu.cr0 | 0x80000001);
  eq('turning paging on ends the current slice', mc.cpu.tbudget, 0);
}

// ---- self-modification bookkeeping is LINEAR, including under paging -------------------------
// codePage is filled from blk.linStart and the block cache is keyed by linear address, but the paged
// write path tested and reported the TRANSLATED address. Every self-modifying write under paging
// missed its invalidation — which is exactly what an OS relocating code does.
{
  // 16 MiB, because rdOfs/wrOfs/codePage are indexed by LINEAR page and sized from installed RAM:
  // linear page 0x400 needs at least 0x401 entries to exist. (That sizing is itself a limit — a
  // guest mapping code above installed RAM, as Windows does at 0x80000000, has no entry at all.)
  const mc = new Machine({ memSize: 16 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  mem.w32(0x1000, 0x2003);                                     // PDE[0] -> table
  for (let i = 0; i < 1024; i++) mem.w32(0x2000 + i * 4, ((i << 12) | 3) >>> 0);
  mem.w32(0x1000 + 4, 0x3003);                                 // PDE[1] -> second table
  for (let i = 0; i < 1024; i++) mem.w32(0x3000 + i * 4, (((0x300 + i) << 12) | 3) >>> 0);
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);                  // linear 0x400000 -> physical 0x300000
  const hits = [];
  mem.onCodeWrite = (addr, len) => hits.push(addr >>> 0);
  mem.markCodePage(0x400);                                     // the LINEAR page holding code
  mem.w8(0x400010, 0x90);
  eq('a write to a code page under paging is reported', hits.length, 1);
  eq('...by its LINEAR address, which is how blocks are keyed', hits[0], 0x400010);
  eq('...and the byte still lands in the mapped frame', mem.u8[0x300010], 0x90);
  hits.length = 0;
  mem.w8(0x401010, 0x90);                                      // a different linear page: no report
  eq('a write to a non-code page is not reported', hits.length, 0);
}

// ---- #UD is a service the guest can ask for -------------------------------------------------
// The Windows 3.0 loader hooks INT 6 through DOS (`mov ax,2506h / int 21h`) and then executes
// `0f a6` on purpose to identify the processor. Reporting "unimplemented opcode 0x0f 0xa6" for an
// opcode that is invalid on every CPU and is MEANT to fault was the wrong answer.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const cpu = mc.cpu;
  mc.setVector(6, 0x2000, 0x100);                    // a guest #UD handler, as Windows installs
  cpu.setSeg(CS, 0x100); cpu.eip = 0;
  cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mc.mem.blit(0x1000, Uint8Array.from([0x0f, 0xa6, 0xca, 0xf4]));   // <invalid> ; hlt
  let threw = null;
  try { mc.rec.step(); } catch (e) { threw = e.message; }
  eq('an invalid opcode raises #UD when the guest owns INT 6', threw, null);
  eq('...entering the guest handler', `${cpu.seg[CS].toString(16)}:${(cpu.eip >>> 0).toString(16)}`, '2000:100');
  eq('...with the FAULTING address pushed, not the next one', mc.mem.r16((0x300 << 4) + (cpu.sp & 0xffff)), 0x0000);

  // With no guest handler the loud diagnostic must survive: an unhandled #UD would re-raise forever
  // and turn "unimplemented opcode 0x0f 0xa6" into "INT 06h looped".
  const mc2 = new Machine({ memSize: 1 << 20 });
  installBIOS(mc2);
  mc2.cpu.setSeg(CS, 0x100); mc2.cpu.eip = 0;
  mc2.mem.blit(0x1000, Uint8Array.from([0x0f, 0xa6, 0xca, 0xf4]));
  let msg = '';
  try { mc2.rec.step(); } catch (e) { msg = e.message; }
  eq('...but with no guest handler it is still reported as an unimplemented opcode',
     msg.includes('unimplemented opcode 0x0f 0xa6'), true);
}

// ---- virtual-8086 mode: EFLAGS.VM, its segment semantics, and the IOPL-sensitive set ---------
// test386's POST 0x21 is the gate for this; these pin the pieces individually so a regression says
// WHICH one, rather than "POST 21" again.
{
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.cr0 |= 1;                                                 // protected mode, no descriptors yet

  // A V86 segment register is an 8086 value: base = sel << 4, whatever the GDT says.
  cpu.flags |= 0x20000;
  cpu.setSeg(CS, 0xf000);
  eq('V86: a segment register is an 8086 value, not a selector', cpu.base[CS], 0xf0000);
  eq('V86: the limit is 64K', cpu.limit[CS], 0xffff);
  eq('V86: CPL is 3 even though CS & 3 is 0', cpu.cpl, 3);
  eq('V86: CS.D is 16-bit', cpu.csD, 0);
}
{
  // IRETD from ring 0 with VM set in the popped EFLAGS is the only way in, and its frame is NINE
  // dwords: the four data segments ride along because no descriptor can describe an 8086 value.
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.cr0 |= 1;
  cpu.base[SS] = 0; cpu.limit[SS] = 0xfffff; cpu.ssB = 1; cpu.reg[4] = 0x1000;
  const frame = [0x1234, 0xf000, 0x20202, 0x7ffe, 0x1000, 0x3040, 0x2010, 0x5060, 0x7080];
  let a = 0x1000;
  for (const v of frame) { mc.mem.w32(a, v); a += 4; }
  cpu.iret(1);
  eq('IRETD with VM set enters virtual-8086 mode', (cpu.flags & 0x20000) !== 0, true);
  eq('...at CS:EIP from the frame', `${cpu.seg[CS].toString(16)}:${(cpu.eip >>> 0).toString(16)}`, 'f000:1234');
  eq('...with the 8086 CS base', cpu.base[CS], 0xf0000);
  eq('...and SS:ESP from the frame', `${cpu.seg[SS].toString(16)}:${(cpu.reg[4] >>> 0).toString(16)}`, '1000:7ffe');
  eq('...ES, DS, FS and GS all ride on the frame',
     [cpu.seg[ES], cpu.seg[DS], cpu.seg[4], cpu.seg[5]].map((x) => x.toString(16)).join(','), '3040,2010,5060,7080');

  // POPF may never write VM: only IRETD from ring 0 (and a task switch) set it.
  cpu.flags |= 0x3000;                                          // IOPL 3, so POPF does not trap
  cpu.reg[4] = 0x2000; mc.mem.w32(cpu.base[SS] + 0x2000, 0x0002);
  const rec = mc.rec;
  // `jmp $` ends the block, not HLT: HLT is privileged now, so it would trap out of V86 and clear
  // VM before the assertion could look at it.
  mc.mem.blit((0xf000 << 4) + 0x1234, Uint8Array.from([0x9d, 0xeb, 0xfe]));   // popf ; jmp $
  cpu.eip = 0x1234;
  rec.step();
  eq('POPF cannot leave virtual-8086 mode', (cpu.flags & 0x20000) !== 0, true);
}
{
  // The TSS I/O permission bitmap. Before this, IN/OUT raised #GP for every CPL > IOPL, so a port
  // the bitmap PERMITS was refused too.
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.cr0 |= 1; cpu.flags |= 0x20000;                           // V86: CPL 3, IOPL 0
  cpu.tr.base = 0x4000; cpu.tr.limit = 0x67 + 0x2000;
  mc.mem.w16(0x4000 + 0x66, 0x68);                              // bitmap starts right after the TSS
  for (let i = 0; i < 0x2000; i++) mc.mem.w8(0x4000 + 0x68 + i, 0xff);   // deny everything
  mc.mem.w8(0x4000 + 0x68 + (0x60 >> 3), 0x00);                 // ...except ports 0x60-0x67
  eq('I/O bitmap: a permitted port is allowed in V86', cpu.ioDenied(0x60, 1), false);
  eq('I/O bitmap: a denied port faults', cpu.ioDenied(0x64 + 4, 1), true);
  eq('I/O bitmap: a word access needs BOTH bytes permitted', cpu.ioDenied(0x67, 2), true);
  cpu.tr.limit = 0x67;                                          // the minimum 386 TSS: no bitmap
  eq('I/O bitmap: a map past the TSS limit denies everything', cpu.ioDenied(0x60, 1), true);
  cpu.flags &= ~0x20000; cpu.flags |= 0x3000;                   // IOPL 3, not V86
  // Set CPL directly. This used to say `setSeg(CS, 0)`, which is not a way to reach CPL 0 — loading
  // the null selector into CS is #GP(0) on a 386, and once the CPU enforced that, the shortcut faulted.
  cpu._cpl = 0;
  eq('at CPL <= IOPL the bitmap is not consulted at all', cpu.ioDenied(0x60, 1), false);
}

// ---- derail classification: what the guest is executing when it is not executing code -------
// Four investigations began from a message naming an opcode that turned out to be innocent, so the
// address gets classified. These assert the SHAPE of the four regions we actually walked into.
{
  const mc = new Machine({ memSize: 1 << 20 });
  const say = (lin) => describeRegion(mc.mem, lin, mc.cpu);

  eq('derail: the IVT is named as the IVT, with the vector', say(0x30).includes('IVT (vector 12)'), true);
  eq('derail: the BIOS data area is named', say(0x480).includes('BIOS data area'), true);

  mc.mem.blit(0x50000, Uint8Array.from([...'Exception fault.'].map(c => c.charCodeAt(0)).concat([0x12])));
  eq('derail: a string is quoted from its start, not from the fault address',
     say(0x50008), 'INSIDE A STRING — "Exception fault." — the guest is executing text, not code');

  eq('derail: zeroed memory is named', say(0x60000).includes('zero bytes'), true);

  // Ordinary code must NOT be classified — a false positive would send the reader the wrong way.
  mc.mem.blit(0x70000, Uint8Array.from([0xb8, 0x34, 0x12, 0x8e, 0xd8, 0x89, 0xc3, 0xcd, 0x21, 0xf4]));
  eq('derail: real code is left unclassified', say(0x70000), '');

  // Packed data: Pinball Fantasies executes a sprite mask. The window straddles the address because
  // the fault lands inside the run, not at its start.
  mc.mem.blit(0x90000, Uint8Array.from([
    0xff, 0xfc, 0x00, 0xff, 0xff, 0xc0, 0xff, 0xff, 0xf8, 0x00, 0x7f, 0xff, 0x80, 0x00, 0x00, 0x1f,
    0x80, 0x07, 0xff, 0xff, 0xc0, 0x0f, 0xff, 0xfe, 0x00, 0x00, 0x01, 0xff, 0x80, 0x7e, 0xaa, 0xaa]));
  eq('derail: a bitmap is named as data, from a fault inside it', say(0x90015).includes('PACKED DATA'), true);

  // The block trail: equal steps mean the decoder is walking, so the derail started earlier.
  const ring = (ips) => ({ recentCs: Int32Array.from(ips.map(() => 0x18)),
                           recentIp: Int32Array.from(ips), recentI: 0 });
  eq('derail: a forward walk through memory is called out',
     recentBlocks(ring([0x481, 0x601, 0x781, 0x901, 0xa81])).includes('walking forward'), true);
  eq('derail: ordinary branching is not called out',
     recentBlocks(ring([0x481, 0x601, 0x120, 0x904, 0xa11])).includes('walking forward'), false);

  // A descriptor table: test386 decoded gate access bytes as an instruction.
  mc.cpu.idtr = { base: 0x80000, limit: 0x7ff };
  eq('derail: the IDT is named, with the entry number', say(0x80048).includes('IDT (entry 9)'), true);
}

// ----------------------------------------------------------------------------

// A HARDWARE interrupt handler owes the interrupted instruction its flags byte for byte; only a
// SERVICE reports back through the flags image on the stack. MIRAGE carried the handler's arithmetic
// flags back for both, which rewrote a carry the guest was mid-way through consuming: Dune's
// decompressor runs `shr bp,1` / `jnz` / `rcl cx,1`, so a timer tick on that boundary shifted a 0
// into a match length of 3, and the resource it was unpacking came out corrupt from that byte on.
{
  const mkFrame = (n, callerFlags, handlerFlags) => {
    const mc = new Machine({ memSize: 1 << 20 });
    const cpu = mc.cpu;
    cpu.setSeg(CS, 0xf000); cpu.eip = n;
    cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
    cpu.push16(callerFlags); cpu.push16(0x0100); cpu.push16(0x0042);   // FLAGS, CS, IP
    cpu.flags = handlerFlags;
    mc.biosCallback(n);
    return cpu.flags & CF;
  };
  // caller had CF=1, handler ends with CF=0
  eq('IRQ 8 restores the interrupted CF', mkFrame(0x08, 0x0203, 0x0202), CF);
  eq('IRQ 1Ch restores the interrupted CF', mkFrame(0x1c, 0x0203, 0x0202), CF);
  // a service must still report its own carry back to a chained caller
  eq('INT 21h reports the service CF', mkFrame(0x21, 0x0202, 0x0203), CF);
  eq('INT 21h clears CF when the service did', mkFrame(0x21, 0x0203, 0x0202), 0);
}

// A null selector is legal to LOAD into a data segment and faults later, on use; into CS or SS it is
// #GP(0) at once. MIRAGE accepted it everywhere, which is why Heretic's DOS4GW — leaving through an
// IRET whose saved CS:IP reads back 0:0 — got CS base 0 and ran from linear 0 for 20000 blocks
// instead of stopping at the instruction that broke.
{
  const mc = new Machine({ memSize: 1 << 20 });
  const cpu = mc.cpu;
  cpu.cr0 |= 1;                                        // protected mode, not V86
  const raised = [];
  cpu.raise = (n, err) => { raised.push(`${n},${err}`); return true; };

  cpu.setSeg(DS, 0);
  eq('null selector into DS does not fault', raised.length, 0);
  eq('null selector into DS gives a zero base', cpu.base[DS], 0);

  raised.length = 0; cpu.setSeg(CS, 0);
  eq('null selector into CS is #GP(0)', raised.join('|'), '13,0');

  raised.length = 0; cpu.setSeg(SS, 0);
  eq('null selector into SS is #GP(0)', raised.join('|'), '13,0');

  // Not while an exception is being DELIVERED: there a null CS/SS means the gate or the TSS is
  // uninitialised, and raising would recurse instead of letting the depth guard report.
  raised.length = 0; cpu._delivering = true; cpu.setSeg(CS, 0); cpu._delivering = false;
  eq('while delivering, a null CS is accepted so the depth guard can report', raised.length, 0);
}

console.log(`\nmirage recompiler: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
