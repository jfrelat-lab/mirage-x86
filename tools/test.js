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
import { installBIOS } from '../src/bios.js';
import { CPU, CS, DS, ES, SS, CF, ZF, SF, OF, PF } from '../src/cpu.js';

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

// ----------------------------------------------------------------------------
console.log(`\nmirage recompiler: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
