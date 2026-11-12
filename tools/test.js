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
import { Keyboard } from '../src/keyboard.js';
import { installLinux } from '../src/linux.js';
import { bootCD } from '../src/boot.js';
import { unzip, deice } from '../src/zip.js';
import { deflateRawSync } from 'zlib';
import { Video } from '../src/video.js';
import { CPU, CS, DS, ES, SS, CF, ZF, SF, OF, PF } from '../src/cpu.js';
import { sig24 } from '../src/fpu.js';
import { describeRegion, recentBlocks, allZero } from '../src/derail.js';
import { installDOS, DOS_PLAYER_MEM, playerMem } from '../src/dos.js';
import { installAudio } from '../src/audio.js';
import { createOPL } from '../src/opl.js';
import { createHash } from 'crypto';
import { VFS } from '../src/vfs.js';

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

// ---- CMPXCHG8B m64 (0F C7 /1): tools/cx8probe.asm, the same four lines as QEMU -cpu pentium ------
// 66 B8/BA/B9/BB imm32 load EAX/EDX/ECX/EBX; the quadword is at DS:0010h = 22222222:11111111.
{ const prog = (eax, flags) => [0x66, 0xb8, ...[0, 8, 16, 24].map((k) => (eax >>> k) & 0xff), 0x66, 0xba, 0x22, 0x22, 0x22, 0x22,
    0x66, 0xb9, 0xaa, 0xaa, 0xaa, 0xaa, 0x66, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0x68, flags & 0xff, flags >> 8, 0x9d, 0x0f, 0xc7, 0x0e, 0x10, 0x00, 0xf4];
  const go = (eax, flags) => { try { const { mc, cpu } = run(prog(eax, flags), ({ mc }) => { mc.mem.w32(0x2010, 0x11111111); mc.mem.w32(0x2014, 0x22222222); });
    const h = (v) => (v >>> 0).toString(16); return [h(cpu.reg[2]), h(cpu.reg[0]), h(mc.mem.r32(0x2014)), h(mc.mem.r32(0x2010)), h(cpu.flags & 0x8d5)].join(' '); } catch (e) { return String(e.message).slice(0, 50); } };
  eq('CMPXCHG8B equal: ECX:EBX stored, ZF set and nothing else', go(0x11111111, 0), '22222222 11111111 aaaaaaaa bbbbbbbb 40');
  eq('CMPXCHG8B different: the quadword into EDX:EAX, ZF cleared, SF AF PF CF OF kept', go(0x11111112, 0x8d5), '22222222 11111111 22222222 11111111 895'); }
// The P6 profiles: family 6, CMOV and MSR advertised, leaf 2, and RDMSR itself.
{ const mc = new Machine({ memSize: 1 << 20, cpu: 'pentiumpro' }); const cpu = mc.cpu;
  cpu.reg[0] = 0; cpu.cpuid(); const max = cpu.reg[0];
  cpu.reg[0] = 1; cpu.cpuid();
  eq("the 'pentiumpro' profile: leaves 0-2, family 6 model 1, FPU PSE TSC MSR CX8 CMOV", [max, (cpu.reg[0] >>> 0).toString(16), (cpu.reg[2] >>> 0).toString(16)].join(), '2,619,8139');
  let gp = 0; cpu.raise = (n) => { gp = n; };
  cpu.cycles = 0x123456789; cpu.reg[1] = 0x10; const ok = cpu.rdmsr();
  eq('...RDMSR 10h is the time-stamp counter', [ok, cpu.reg[2], (cpu.reg[0] >>> 0).toString(16)].join(), 'true,1,23456789');
  cpu.reg[1] = 0x1234; const bad = cpu.rdmsr();
  eq('...and a register the part lacks is #GP', [bad, gp].join(), 'false,13');
  // Windows 2000's update.sys loads its microcode for family 6 model 1 through WRMSR 79h: a #GP there
  // was KMODE_EXCEPTION_NOT_HANDLED. The write is taken, nothing is applied: 8Bh still reads zero.
  gp = 0; cpu.reg[1] = 0x79; cpu.reg[0] = 0x81234000; cpu.reg[2] = 0; const upd = cpu.wrmsr();
  cpu.reg[1] = 0x8b; cpu.reg[0] = 5; cpu.reg[2] = 5; cpu.rdmsr();
  eq('...WRMSR 79h (BIOS update trigger) is taken, and the microcode revision (8Bh) stays zero', [upd, gp, cpu.reg[0], cpu.reg[2]].join(), 'true,0,0,0'); }

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

// ---- INVD / WBINVD (0F 08 / 0F 09, 486+): no cache to flush, execution just goes on. ----------
// KolibriOS's kernel (v86 kolibri.img) stopped on WBINVD as an unimplemented opcode.
// ENDBR32 (F3 0F 1E FB) and the other reserved-NOP hints (0F 19-1E, 0F 18 prefetch) run as NOPs, as
// in QEMU: FreeNOS, built with -fcf-protection, stopped on "unimplemented opcode 0x0f 0x1e".
{ let got; try { const { cpu } = run([0xf3, 0x0f, 0x1e, 0xfb, 0x0f, 0x18, 0x0e, 0x00, 0x00, 0x0f, 0x19, 0xc0, 0xbb, 0x34, 0x12, 0xf4]); got = cpu.bx.toString(16); }
  catch (e) { got = e.message.slice(0, 60); }
  eq('ENDBR32, PREFETCH and the 0F 19-1E hints are NOPs', got, '1234'); }
{ let got; try { const { cpu } = run([0x0f, 0x09, 0x0f, 0x08, 0xbb, 0x78, 0x56, 0xf4]); got = cpu.bx.toString(16); }
  catch (e) { got = String(e.message).slice(0, 60); }
  eq('WBINVD and INVD run through to the next instruction', got, '5678'); }

// ---- Sound-hardware detection: the DSP reset handshake, and the OPL timers a detection waits on. ---
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  mc.ioWrite(0x226, 1, 1); mc.ioWrite(0x226, 1, 0);                 // SB DSP reset: 1 then 0
  eq('sb dsp data-ready', mc.ioRead(0x22e, 1) & 0x80, 0x80);       // status bit7 set
  eq('sb dsp reset ack', mc.ioRead(0x22a, 1), 0xaa);               // read-data = 0xAA
  // OPL timers run for real (src/opl.js): timer 1 preset FFh is one 80 us step. tools/oplprobe.asm,
  // DOSBox-X: S0=00 S1=C0 T1=5EC4 S2=A0 T2=BE58 S3=00 (an OPL3); QEMU's flags agree.
  const us = (n) => { mc.cpu.cycles += Math.ceil(n * 1e-6 * 18.2065 * mc.pitBase); };
  mc.ioWrite(0x388, 1, 0x02); mc.ioWrite(0x389, 1, 0xff);          // OPL: timer 1 = FFh
  mc.ioWrite(0x388, 1, 0x04); mc.ioWrite(0x389, 1, 0x21);          // select timer-ctrl, start timer1
  eq('opl timer not yet expired', mc.ioRead(0x388, 1), 0x00);
  us(85);
  eq('opl timer expired after 80 us', mc.ioRead(0x388, 1), 0xc0);  // status shows timer-expired bits
  mc.ioWrite(0x388, 1, 0x04); mc.ioWrite(0x389, 1, 0x80);          // OPL: reset
  eq('opl reset clears', mc.ioRead(0x388, 1), 0x00);
  us(80);
  eq('...and the flag comes back at the next overflow, the timer still running', mc.ioRead(0x388, 1), 0xc0); }

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

// The browser's arrow keys reach port 60h as an AT keyboard sends them, E0 48 / E0 C8, not as the
// keypad's 8: C-Dogs tells the two apart, and its menus ignored the arrows.
{ const sent = [], kb = new Keyboard({ keyQueue: [], pushScancodes: (a) => sent.push(...a) });
  kb._onDown({ code: 'ArrowUp', key: 'ArrowUp', preventDefault() {} }); kb._onUp({ code: 'ArrowUp' });
  kb._onDown({ code: 'Numpad8', key: '8', preventDefault() {} }); kb._onUp({ code: 'Numpad8' });
  eq('keyboard: an arrow is E0-prefixed, the keypad is not', sent.map((x) => x.toString(16)).join(' '), 'e0 48 e0 c8 48 c8'); }

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

// ---- INT 13h: drive A is fitted even with no diskette in it -------------------------------------
// Windows 98's HSFLOP.PDR sized its DMA buffer from the drive it was told about; with no drive A it
// took an error path that overwrote IVT[1Ah] ("Windows protection error"). QEMU with its drive A
// removed stops on the logo too. The BIOS describes an empty drive like SeaBIOS: the drive answers,
// the missing medium times out.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  installBIOS(mc); installDisk(mc);
  mc.disk.attach(0x80, new Uint8Array(1024 * 1024), { cyl: 32, heads: 4, spt: 16, type: 3 });
  cpu.ax = 0x0800; cpu.dx = 0x0000; cpu.bx = 0; mc.intHandlers[0x13](cpu, mc);
  eq('empty drive A: AH=08h succeeds with the 1.44 MB drive (BL=04, CX=4F12, DX=0101)',
    [cpu.flags & 1, cpu.bx & 0xff, (cpu.cx & 0xffff).toString(16), (cpu.dx & 0xffff).toString(16)].join(), '0,4,4f12,101');
  cpu.ax = 0x1500; cpu.dx = 0x0000; mc.intHandlers[0x13](cpu, mc);
  eq('...AH=15h calls it a diskette drive', [cpu.flags & 1, (cpu.ax >> 8) & 0xff].join(), '0,1');
  cpu.ax = 0x0201; cpu.cx = 0x0001; cpu.dx = 0x0000; cpu.bx = 0; mc.intHandlers[0x13](cpu, mc);
  eq('...and a read times out, for want of a diskette', [cpu.flags & 1, (cpu.ax >> 8) & 0xff].join(), '1,128');
  cpu.ax = 0x0800; cpu.dx = 0x0001; mc.intHandlers[0x13](cpu, mc);
  eq('...while drive B stays absent', [cpu.flags & 1, (cpu.ax >> 8) & 0xff].join(), '1,128'); }

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

// ---- hardware task switch: JMP / CALL to a 32-bit TSS, IRET with NT back -----------------------
// 386BSD 1.0 switches processes with `ljmp *0xc0(%ecx)` onto a TSS selector; MIRAGE raised #GP(48h)
// there ("trap 9 code 48, panic: trap"). Intel SDM vol. 3 "Task Switching": the outgoing registers
// go into the current TSS, busy bits move, a CALL links back and sets NT, and IRET follows the link.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, TA = 0x9000, TB = 0x9100;
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, base, limit, access, gran = 0) => {
    const a = GDT + i * 8;
    m.w16(a, limit & 0xffff); m.w16(a + 2, base & 0xffff); m.w8(a + 4, (base >> 16) & 0xff); m.w8(a + 5, access);
    m.w8(a + 6, ((limit >> 16) & 0x0f) | gran); m.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(1, 0, 0xfffff, 0x9a, 0xc0); desc(2, 0, 0xfffff, 0x92, 0xc0);          // flat code 08h, data 10h
  desc(3, TA, 0x67, 0x8b);                                                    // 18h: busy 386 TSS (current)
  desc(4, TB, 0x67, 0x89);                                                    // 20h: available 386 TSS
  m.w32(TB + 0x20, 0x4000); m.w32(TB + 0x24, 0x0002); m.w32(TB + 0x28, 0x11111111);  // EIP, EFLAGS, EAX
  m.w32(TB + 0x38, 0x7000);                                                   // ESP
  for (const o of [0x48, 0x50, 0x54, 0x58, 0x5c]) m.w16(TB + o, 0x10); m.w16(TB + 0x4c, 0x08);
  cpu.cr0 = 1; cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.setSeg(DS, 0x10); cpu.loadTR(0x18);
  cpu.reg[0] = 0xaaaaaaaa; cpu.eip = 0x1000;
  const busy = (sel) => (m.r8(GDT + sel + 5) >> 1) & 1;
  try {
  cpu.farJmp(0x20, 0, 0x1000, 0x1007);
  eq('JMP to a TSS: the new task runs (EIP, EAX, TR)', [cpu.eip.toString(16), (cpu.reg[0] >>> 0).toString(16), cpu.tr.sel.toString(16)].join(), '4000,11111111,20');
  eq('...the old task saved EIP after the JMP and its EAX', [m.r32(TA + 0x20).toString(16), (m.r32(TA + 0x28) >>> 0).toString(16)].join(), '1007,aaaaaaaa');
  eq('...busy bits: old freed, new claimed; CR0.TS set', [busy(0x18), busy(0x20), (cpu.cr0 >> 3) & 1].join(), '0,1,1');
  cpu.eip = 0x4010;
  cpu.farCall(0x18, 0, 1, 0x4009);
  eq('CALL to a TSS: link = caller, NT set, both busy', [m.r16(TA).toString(16), (cpu.flags >> 14) & 1, busy(0x18), busy(0x20)].join(), '20,1,1,1');
  eq('...and it resumes the saved task at its saved EIP', cpu.eip.toString(16), '1007');
  cpu.iret(1, 0x1008);
  eq('IRET with NT: back in the caller at its return address, callee freed', [cpu.tr.sel.toString(16), cpu.eip.toString(16), busy(0x18)].join(), '20,4010,0');
  eq('...and the image it left has NT clear', (m.r32(TA + 0x24) >> 14) & 1, 0);
  } catch (e) { eq('a far JMP to a TSS switches tasks instead of faulting', String(e.message || e).slice(0, 60), 'no exception'); } }

// ---- an interrupt gate clears NT for the handler (and the pushed EFLAGS keeps it) ---------------
// Once IRET honoured NT, Windows 98 died: its ring-3 code POPFs NT on, the gate left it set, and the
// VMM's IRET at c00015e1 followed the NULL back link. The SDM clears TF, VM, RF and NT on delivery.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, IDT = 0x8800;
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff; cpu.idtr.base = IDT; cpu.idtr.limit = 0x7ff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92);
  const g = IDT + 0x40 * 8; m.w16(g, 0x5000); m.w16(g + 2, 0x08); m.w8(g + 4, 0); m.w8(g + 5, 0x8e); m.w16(g + 6, 0);   // 32-bit interrupt gate
  cpu.cr0 = 1; cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.reg[4] = 0x7000; cpu.eip = 0x1000;
  cpu.flags = 0x4202;                                                         // NT | IF
  try { mc.protInt(0x40, undefined, undefined, true); } catch (e) { /* reported below */ }
  eq('interrupt gate: the handler runs with NT clear, the pushed EFLAGS has it',
    [cpu.eip.toString(16), (cpu.flags >> 14) & 1, (m.r32(0x7000 - 4) >> 14) & 1].join(), '5000,0,1'); }

// ---- CS takes any code segment, readable or not, and nothing else ---------------------------------------
// HelenOS's kernel far-jumps to its execute-only code segment (access 98h): the data registers' rule
// "a code segment must be readable" was applied to CS, and the #GP(8) came before any IDT — a triple
// fault. The SDM: far JMP/CALL raise #GP(selector) when the target "is not code"; readability is a
// data-register rule. And a writable data segment loaded into CS is that #GP.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, IDT = 0x8800;
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff; cpu.idtr.base = IDT; cpu.idtr.limit = 0x7ff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92); desc(3, 0x98);                                // 08 code, 10 data, 18 execute-only code
  const g = IDT + 13 * 8; m.w16(g, 0x6000); m.w16(g + 2, 0x08); m.w8(g + 4, 0); m.w8(g + 5, 0x8e); m.w16(g + 6, 0);   // #GP → 08:6000
  cpu.cr0 = 1; cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.reg[4] = 0x7000; cpu.eip = 0x1000;
  let got;
  try { cpu.farJmp(0x18, 0x2000, 0x1000, 0x1007); const a = [cpu.seg[CS].toString(16), cpu.eip.toString(16)];
    cpu.farJmp(0x10, 0x3000, 0x2000, 0x2007); got = [...a, cpu.eip.toString(16), (m.r32(cpu.reg[4]) >>> 0).toString(16)].join();
  } catch (e) { got = e.message.slice(0, 60); }
  eq('CS: an execute-only code segment loads, a data segment is #GP', got, '18,2000,6000,10'); }

// ---- a far CALL/JMP to a code segment keeps CPL: CS's RPL becomes the CPL -----------------------
// QNX 4 calls a CONFORMING DPL-0 segment (00E0h) from ring 1; we loaded CS=00E0h as given and ran it
// in ring 0, so its RETF was taken for an outward return and popped an SS:ESP that was never pushed.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000; cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0xba);                                   // 08h: ring-1 code
  desc(2, 0xb2);                                   // 10h: ring-1 data (stack)
  desc(3, 0x9e);                                   // 18h: CONFORMING code, DPL 0
  cpu.cr0 = 1; cpu._cpl = 1; cpu.setSeg(CS, 0x09); cpu.setSeg(SS, 0x11); cpu.reg[4] = 0x7000; cpu.eip = 0x1005;
  try { cpu.farCall(0x18, 0x2000, 1, 0x1000); } catch (e) { /* reported below */ }
  eq('far CALL to a conforming DPL-0 segment from ring 1: CS = 0019h, still ring 1',
    [cpu.seg[CS].toString(16), cpu.cpl, cpu.eip.toString(16)].join(), '19,1,2000');
  cpu.eip = 0x2010;
  try { cpu.farJmp(0x08, 0x3000, 0x2010, 0x2017); } catch (e) { /* reported below */ }
  eq('...and a far JMP back to ring-1 code by an RPL-0 selector loads 0009h', [cpu.seg[CS].toString(16), cpu.cpl].join(), '9,1'); }

// ---- the PCI bus (src/pci.js), read through mechanism #1 as tools/pcidump.asm reads QEMU -M pc ---
// Off by default — QEMU's -M isapc — and identical to QEMU's i440FX/PIIX3 when asked for: Windows
// NT 3.51 and 9legacy only boot under -M pc.
{ const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc, { pci: true }); const cpu = mc.cpu;
  const out = (p, sz, v) => { if (mc.portWrite[p]) mc.portWrite[p](p, sz, v); }, inp = (p, sz) => (mc.portRead[p] ? mc.portRead[p](p, sz) >>> 0 : 0xffffffff);
  const cfg = (dev, fn, reg) => { out(0xcf8, 4, (0x80000000 | (dev << 11) | (fn << 8) | reg) >>> 0); return inp(0xcfc, 4); };
  eq('PCI 00.0 / 01.0 / 01.1 / 02.0: i440FX, PIIX3, PIIX3 IDE, display — as QEMU -M pc', [cfg(0, 0, 0), cfg(1, 0, 0), cfg(1, 1, 0), cfg(2, 0, 0)].map((v) => v.toString(16)).join(), '12378086,70008086,70108086,11111234');
  eq('...an empty slot reads all ones', cfg(3, 0, 0), 0xffffffff);
  eq('...the IDE function: legacy mode with bus mastering (class 010180h), BAR4 at C000h', [(cfg(1, 1, 8) >>> 8).toString(16), cfg(1, 1, 0x20).toString(16)].join(), '10180,c001');
  out(0xcf8, 4, 0x80000920); out(0xcfc, 4, 0xffffffff);
  eq('...sizing BAR4 by writing all ones reads back a 16-byte I/O window', cfg(1, 1, 0x20).toString(16), 'fffffff1');
  eq('...ELCR 0C00h and SeaBIOS\'s PIRQ routing (A,B -> 10, C,D -> 11)', [inp(0x4d1, 1) & 0xff, cfg(1, 0, 0x60).toString(16)].join(), '12,b0b0a0a');
  cpu.ax = 0xb101; cpu.reg[2] = 0; mc.intHandlers[0x1a](cpu, mc);
  eq('INT 1Ah B101h: present, mechanism #1, version 2.10, "PCI "', [cpu.flags & 1, cpu.ax & 0xffff, cpu.bx & 0xffff, (cpu.reg[2] >>> 0).toString(16)].join(), '0,1,528,20494350');
  cpu.ax = 0xb102; cpu.cx = 0x7010; cpu.dx = 0x8086; cpu.si = 0; mc.intHandlers[0x1a](cpu, mc);
  eq('INT 1Ah B102h finds the IDE function at bus 0, device 1 function 1', [cpu.flags & 1, cpu.bx & 0xffff].join(), '0,9');
  const pir = String.fromCharCode(...mc.mem.u8.subarray(0xfd000, 0xfd004));
  eq('...and the $PIR table is in the BIOS area, checksummed', [pir, mc.mem.u8.subarray(0xfd000, 0xfd080).reduce((a, b) => (a + b) & 0xff, 0)].join(), '$PIR,0');
  const rom = Buffer.from(mc.mem.u8.subarray(0xf0000, 0x100000)).toString('latin1');
  eq('...and the F000 segment carries "PCI ", which NT 3.51\'s NTDETECT scans for before calling B101h', rom.includes('PCI '), true);
  const isa = new Machine({ memSize: 16 << 20 }); installBIOS(isa);
  eq('without the option there is no bus: CF8h is not decoded', isa.portRead[0xcfc] ? 'decoded' : 'none', 'none');
  // The PIIX sets bus-master status bit 2 when its channel's INTRQ rises, PIO included; BeOS 5's PCI
  // IDE driver waits on that bit after IDENTIFY and panicked "boot device not found" without it.
  out(0xcf8, 4, 0x80000920); out(0xcfc, 4, 0xc001);                          // BAR4 back at C000h after the sizing above
  out(0xc002, 1, 0x04); mc.raiseIRQ(14);
  eq('...an IDE interrupt sets the bus-master INTERRUPT bit, which writing 1 clears', [inp(0xc002, 1) & 4, (out(0xc002, 1, 0x04), inp(0xc002, 1) & 4)].join(), '4,0'); }

// ---- VBE 4F02h with a standard VGA mode number --------------------------------------------------
// VBE 2.0 §4.5 lets 4F02h set modes below 100h, and SeaVGABIOS does; Windows NT 3.51's video
// miniport resets the screen with 4F02h BX=0003h and got 014Fh here.
{ const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc); const cpu = mc.cpu;
  cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);
  cpu.ax = 0x4f02; cpu.bx = 0x0003; mc.intHandlers[0x10](cpu, mc);
  eq('4F02h BX=0003h: succeeds (004Fh) and the BIOS is in mode 3', [(cpu.ax & 0xffff).toString(16), mc.mem.u8[0x449]].join(), '4f,3'); }

// ---- PIT counter 0 read back: 1.193 MHz ticks from the reload write, as an 8254 -----------------
// BeOS 5 calibrates its TSC by loading FFFFh and reading the count: the old count ran in cycles with
// a phase that ignored the write, and BeOS spent two minutes in a one-second delay.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
  const read = () => { mc.ioWrite(0x43, 1, 0x00); const lo = mc.ioRead(0x40, 1); return lo | (mc.ioRead(0x40, 1) << 8); };
  cpu.cycles = 1234567;
  mc.ioWrite(0x43, 1, 0x34); mc.ioWrite(0x40, 1, 0xff); mc.ioWrite(0x40, 1, 0xff);
  const at0 = read();
  cpu.cycles += Math.ceil(mc.pitBase * 1000 / 65536);
  eq('PIT: FFFFh just loaded reads FFFFh, and 1000 ticks of cycles later FFFFh-1000', [at0.toString(16), (0xffff - read()).toString()].join(), 'ffff,1000');
  mc.ioWrite(0x43, 1, 0x30); mc.ioWrite(0x40, 1, 0x00); mc.ioWrite(0x40, 1, 0x10);
  cpu.cycles += Math.ceil(mc.pitBase * 0x100 / 65536);
  eq('...and a new reload restarts the count from it', read().toString(16), 'f00');
  // Mode 3 (36h, the BIOS's square wave) counts by two, N to 0 twice a period. Second Reality's
  // copper times a frame so -- FFFFh, a retrace, the count, (65536 - count) / 2 -- and counted by one it
  // found 8522 clocks a frame, not 17045: its interrupts all came in the first half of the frame, the
  // last polled 3DAh through the second, and the credit texts, drawn too late, came out doubled.
  mc.ioWrite(0x43, 1, 0x36); mc.ioWrite(0x40, 1, 0xff); mc.ioWrite(0x40, 1, 0xff);
  cpu.cycles += Math.ceil(mc.pitBase * 17045 / 65536);
  const sq = read();
  cpu.cycles += Math.ceil(mc.pitBase * 32768 / 65536);
  eq('PIT mode 3: a frame after FFFFh reads FFFEh - 2 x 17045, and half a period later the same again',
    [(0xfffe - sq) / 2, read() === sq].join(), '17045,true'); }

// The BIOS leaves counter 0 in mode 3, so a program that never programs the timer reads it counting by
// two: tools/pit40.asm's run A, 256 even counts of 256 on DOSBox-X (256bytef and kaneda seed from it).
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
  const read = () => { mc.ioWrite(0x43, 1, 0x00); const lo = mc.ioRead(0x40, 1); return lo | (mc.ioRead(0x40, 1) << 8); };
  let even = 0;
  for (let i = 0; i < 256; i++) { cpu.cycles += 977 + i; if (!(read() & 1)) even++; }
  eq('PIT at power-on: mode 3 as the BIOS leaves it, 256 of 256 latched counts even', even, 256); }

// 16-bit SHLD/SHRD past 16 (tools/shd16.asm): a P6 shifts dst:src:dst, as QEMU answers; a Pentium,
// and here a 386 or 486, rotates the source, as DOSBox-X answers. kaneda's palette, qblove, crevenge.
{ const shd = (cpu) => { const c = new Machine({ memSize: 1 << 20, cpu }).cpu;
    return [17, 18, 24, 31].map((n) => c.shld(0x1234, 0xabcd, n, 16).toString(16) + '/' + c.shrd(0x1234, 0xabcd, n, 16).toString(16)).join(); };
  eq('SHLD/SHRD 16-bit, counts 17, 18, 24, 31 (1234h, ABCDh): a 686 as QEMU', shd('686'), '579a/55e6,af34/2af3,cd12/34ab,891a/2469');
  eq('...and a 386 or 586 as DOSBox-X', [shd('386'), shd('586')].join(' '), '579b/d5e6,af36/6af3,cdab/cdab,d5e6/579b '.repeat(2).trim()); }

// The 8x8 font's first half at F000:FA6E, as every PC BIOS keeps it: 256bytef reads its digits there.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const f = new Uint8Array(256 * 8); for (let i = 0; i < f.length; i++) f[i] = (i * 7) & 0xff; mc.font8x8 = f;
  eq("ROM font: '2' at F000:FBFE is the 8x8 font's", [...mc.mem.u8.slice(0xffbfe, 0xffc06)].join(), [...f.slice(0x32 * 8, 0x33 * 8)].join()); }

// ---- the ATAPI CD-ROM, secondary master (src/ide.js): what tools/atapiprobe.asm reads on QEMU -cdrom ----
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  eq('ATAPI: no drive fitted, the secondary channel floats', mc.ioRead(0x177, 1), 0xff);
  const iso = new Uint8Array(20 * 2048); iso.set([1, 0x43, 0x44, 0x30, 0x30, 0x31, 1], 16 * 2048);
  mc.disk.attachCD(iso);
  const out = (p, v) => mc.ioWrite(p, 1, v), inp = (p) => mc.ioRead(p, 1);
  const tf = () => [0x172, 0x173, 0x174, 0x175, 0x177, 0x171].map((p) => inp(p).toString(16)).join(' ');
  out(0x376, 0x02); out(0x176, 0xa0); out(0x177, 0xec);
  eq('...IDENTIFY DEVICE is aborted, leaving the 14h/EBh signature', tf(), '1 1 14 eb 41 4');
  out(0x177, 0xa1); const w0 = mc.ioRead(0x170, 2); for (let i = 1; i < 256; i++) mc.ioRead(0x170, 2);
  eq('...IDENTIFY PACKET DEVICE: an ATAPI CD-ROM, removable', w0.toString(16), '85c0');
  // One PACKET command: returns [reason after A0h, DRQ block sizes, status, error, reason, data].
  const packet = (cdb, limit = 0x800) => {
    out(0x174, limit & 0xff); out(0x175, limit >> 8); out(0x171, 0); out(0x177, 0xa0);
    const r0 = inp(0x172); const c = [...cdb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 12);
    for (let i = 0; i < 12; i += 2) mc.ioWrite(0x170, 2, c[i] | (c[i + 1] << 8));
    const blocks = [], data = [];
    for (let k = 0; k < 64 && (inp(0x177) & 0x08); k++) { const n = inp(0x174) | (inp(0x175) << 8); blocks.push(n.toString(16)); for (let i = 0; i < n; i += 2) { const v = mc.ioRead(0x170, 2); data.push(v & 0xff, v >> 8); } }
    return { s: [r0, blocks.join('/'), inp(0x177).toString(16), inp(0x171).toString(16), inp(0x172)].join(' '), data };
  };
  eq('...TEST UNIT READY with a disc: reason 01h for the command, then 03h, status 50h', packet([0]).s, '1  50 0 3');
  const inq = packet([0x12, 0, 0, 0, 36]);
  eq('...INQUIRY: 36 bytes, peripheral type 05h, removable', [inq.s, inq.data[0], inq.data[1]].join(), '1 24 50 0 3,5,128');
  const cap = packet([0x25]);
  eq('...READ CAPACITY: last LBA 19, 2048-byte blocks', [cap.data[3], cap.data[6]].join(), '19,8');
  const rd = packet([0x28, 0, 0, 0, 0, 16, 0, 0, 2], 0x200);
  eq('...READ (10) of 2 sectors under a 512-byte limit: 8 blocks, the volume descriptor first', [rd.s, String.fromCharCode(...rd.data.slice(1, 6))].join(), '1 200/200/200/200/200/200/200/200 50 0 3,CD001');
  eq('...an invalid opcode: CHECK CONDITION, ILLEGAL REQUEST in the error register', packet([0xff]).s, '1  41 50 3');
  const sn = packet([0x03, 0, 0, 0, 18]);
  eq('...and REQUEST SENSE says why: 05h / 20h', [sn.data[0].toString(16), sn.data[2], sn.data[12].toString(16)].join(), 'f0,5,20');
  eq('...READ past the end: ILLEGAL REQUEST', packet([0x28, 0, 0, 0, 0, 20, 0, 0, 1]).s, '1  41 50 3');
  mc.disk.attachCD(null);
  eq('...with the drive empty, TEST UNIT READY is NOT READY', packet([0]).s, '1  41 20 3');
  mc.disk.attachCD(iso, { changed: true });
  eq('...and a disc put in is UNIT ATTENTION once, then ready', [packet([0]).s, packet([0]).s].join(), '1  41 60 3,1  50 0 3'); }

// ---- El Torito: booting a CD (src/boot.js bootCD) and INT 13h on drive E0h, as tools/cdboot.asm
// reads SeaBIOS under QEMU -cdrom -boot d.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu, mem = mc.mem;
  const iso = new Uint8Array(30 * 2048), dv = new DataView(iso.buffer);
  iso.set([1, 0x43, 0x44, 0x30, 0x30, 0x31, 1], 16 * 2048);                       // primary volume descriptor
  iso.set([0, 0x43, 0x44, 0x30, 0x30, 0x31, 1, ...[...'EL TORITO SPECIFICATION'].map((ch) => ch.charCodeAt(0))], 17 * 2048);
  dv.setUint32(17 * 2048 + 0x47, 20, true);                                         // the catalog at sector 20
  const cat = 20 * 2048; iso[cat] = 1; iso[cat + 30] = 0x55; iso[cat + 31] = 0xaa;
  let sum = 0; for (let i = 0; i < 32; i += 2) sum = (sum + dv.getUint16(cat + i, true)) & 0xffff;
  dv.setUint16(cat + 28, (0x10000 - sum) & 0xffff, true);                          // validation checksum
  iso[cat + 32] = 0x88; dv.setUint16(cat + 38, 4, true); dv.setUint32(cat + 40, 25, true);
  iso.set([0xeb, 0xfe, 0x5a, 0xa5], 25 * 2048);
  bootCD(mc, iso);
  eq('El Torito: no emulation, entered at 0000:7C00 with DL = E0h', [cpu.seg[1], cpu.eip.toString(16), (cpu.dx & 0xff).toString(16), mem.r16(0x7c02).toString(16)].join(), '0,7c00,e0,a55a');
  const int13 = () => mc.intHandlers[0x13](cpu, mc);
  cpu.ax = 0x4100; cpu.bx = 0x55aa; cpu.dx = 0xe0; int13();
  eq('...INT 13h 41h on E0h: EDD 3.0, CX = 0007h', [(cpu.ax >> 8).toString(16), (cpu.bx & 0xffff).toString(16), cpu.cx & 0xffff, cpu.flags & 1].join(), '30,aa55,7,0');
  mem.w8(0x600, 0x10); mem.w16(0x602, 1); mem.w16(0x604, 0x1000); mem.w16(0x606, 0); mem.w32(0x608, 16); mem.w32(0x60c, 0);
  cpu.ax = 0x4200; cpu.dx = 0xe0; cpu.setSeg(3, 0); cpu.si = 0x600; int13();
  eq('...42h reads 2048-byte sectors: the volume descriptor', [cpu.flags & 1, mem.r8(0x1001), mem.r8(0x1005)].join(), '0,67,49');
  mem.w32(0x608, 0x100000); cpu.ax = 0x4200; int13();
  eq('...and past the end: CF, AH = 0Ch', [cpu.flags & 1, (cpu.ax >> 8).toString(16)].join(), '1,c');
  cpu.ax = 0x4b01; cpu.si = 0x700; int13();
  eq('...4B01h: the specification packet (13h bytes, no emulation, E0h, controller 1, sector 25, 07C0h, 4)', [...mem.u8.subarray(0x700, 0x710)].map((b) => b.toString(16)).join(' '), '13 0 e0 1 19 0 0 0 0 0 0 0 c0 7 4 0');
  cpu.ax = 0x4300; cpu.si = 0x600; int13();
  eq('...43h: write protected', [cpu.flags & 1, cpu.ax >> 8].join(), '1,3'); }

// ---- ZIP archives (src/zip.js): a stored entry, a deflated one, a directory entry ----------------
{ const enc = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
  const entries = [['GAME/', new Uint8Array(0), 0], ['GAME/README.TXT', enc('freeware'), 0], ['GAME/GAME.EXE', enc('MZ'.padEnd(3000, 'x')), 8]];
  const parts = [], cen = []; let off = 0;
  for (const [name, data, method] of entries) {
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data, nm = enc(name);
    const loc = new Uint8Array(30 + nm.length), ld = new DataView(loc.buffer);
    ld.setUint32(0, 0x04034b50, true); ld.setUint16(8, method, true); ld.setUint32(18, body.length, true); ld.setUint32(22, data.length, true); ld.setUint16(26, nm.length, true); loc.set(nm, 30);
    const c = new Uint8Array(46 + nm.length), cd = new DataView(c.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(10, method, true); cd.setUint32(20, body.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, nm.length, true); cd.setUint32(42, off, true); c.set(nm, 46);
    parts.push(loc, body); cen.push(c); off += loc.length + body.length;
  }
  const cenLen = cen.reduce((a, c) => a + c.length, 0), end = new Uint8Array(22), ed = new DataView(end.buffer);
  ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, entries.length, true); ed.setUint16(10, entries.length, true); ed.setUint32(12, cenLen, true); ed.setUint32(16, off, true);
  const zip = new Uint8Array(off + cenLen + 22); let at = 0; for (const b of [...parts, ...cen, end]) { zip.set(b, at); at += b.length; }
  const files = await unzip(zip);
  eq('ZIP: stored and deflated entries come back, the directory entry is skipped', files.map((f) => `${f.path}:${f.bytes.length}`).join(), 'GAME/README.TXT:8,GAME/GAME.EXE:3000');
  eq('...the deflated content is intact', String.fromCharCode(...files[1].bytes.subarray(0, 4)), 'MZxx');
  let err = ''; try { await unzip(enc('not a zip at all, just text, long enough to be scanned')); } catch (e) { err = e.message; }
  eq('...and something that is not a ZIP says so', err.startsWith('not a ZIP archive'), true);
  // id's shareware layout: DEICE.EXE beside a ZIP cut in pieces. Joined, the pieces are the archive.
  const cut = zip.length >> 1, outer = [{ path: 'INSTALL.BAT', bytes: enc('DEICE.EXE') }, { path: 'DEICE.EXE', bytes: enc('MZ') },
    { path: 'GAME_1.DAT', bytes: enc('PATH=\\GAME') }, { path: 'GAME_1.2', bytes: zip.slice(cut) }, { path: 'GAME_1.1', bytes: zip.slice(0, cut) }];
  eq('DEICE: the pieces NAME.1, NAME.2 are joined and the ZIP inside is what comes back',
    (await deice(outer)).map((f) => `${f.path}:${f.bytes.length}`).join(), 'GAME/README.TXT:8,GAME/GAME.EXE:3000');
  eq('...and an archive without DEICE.EXE is left as it is', (await deice(files)) === files, true); }

// ---- Apogee's shareware archives: INSTALL.EXE and a .SHR of PKWARE DCL-compressed files (src/zip.js) --
// examples/games/1keen.zip as 3D Realms served it. Its VENDOR.DOC lists the files that make a legal
// copy, with their sizes; KEEN1.EXE is the one a Keen 1 shareware install has (sha256 8b3f829f…).
{ const { readFileSync, existsSync } = await import('fs');
  const zp = new URL('../examples/games/1keen.zip', import.meta.url);
  if (existsSync(zp)) {
    const files = await deice(await unzip(new Uint8Array(readFileSync(zp))));
    const get = (n) => files.find((f) => f.path === n);
    eq('SHR: Keen 1\'s archive unpacks to its 33 files beside the installer', files.length, 3 + 33);
    eq('...at the sizes its VENDOR.DOC lists', ['KEEN1.EXE', 'EGALATCH.CK1', 'LEVEL13.CK1', 'SOUNDS.CK1'].map((n) => get(n) && get(n).bytes.length).join(), '51190,57065,9908,8898');
    eq('...and KEEN1.EXE is the shareware 1.31 executable', get('KEEN1.EXE') ? createHash('sha256').update(get('KEEN1.EXE').bytes).digest('hex').slice(0, 16) : 'missing', '8b3f829f7eeab18a');
  } }

// ---- a Cirrus machine has the PCI bus, and the GD5446 on it with its 32 MiB aperture -----------------
// XFree86 3.3.2's cirrus driver reads the PCI device list for 1013h before anything else (a null one
// without a bus: it stopped there), and takes the linear framebuffer 16 MiB-aligned from BAR0: at 60
// MiB, the framebuffer was drawn at 48 MiB, into the RAM. As QEMU's -vga cirrus: 1013:00B8, BAR0 a
// prefetchable 32 MiB, size-aligned — above 60 MiB of RAM, at 64 MiB.
{ const mc = new Machine({ memSize: 128 << 20, ramSize: 60 << 20 }); installBIOS(mc, { vga: 'cirrus' });
  const out = (p, sz, v) => { if (mc.portWrite[p]) mc.portWrite[p](p, sz, v); }, inp = (p, sz) => (mc.portRead[p] ? mc.portRead[p](p, sz) >>> 0 : 0xffffffff);
  const cfg = (dev, fn, reg) => { out(0xcf8, 4, (0x80000000 | (dev << 11) | (fn << 8) | reg) >>> 0); return inp(0xcfc, 4); };
  const id = cfg(2, 0, 0), bar = cfg(2, 0, 0x10);
  out(0xcf8, 4, 0x80001010); out(0xcfc, 4, 0xffffffff);
  eq('a Cirrus machine: PCI 02.0 is a GD5446 (1013:00B8), BAR0 at 64 MiB, sized 32 MiB', [id, bar, cfg(2, 0, 0x10)].map((v) => v.toString(16)).join(), 'b81013,4000008,fe000008'); }

// ---- the Bochs DISPI registers (src/dispi.js): tools/dispiprobe.asm on QEMU -vga std, vgamem_mb=4 ----
// Windows NT 3.51 sets its mode through these ports, not the VBE BIOS. They come with the PCI bus.
{ const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc, { pci: true }); const cpu = mc.cpu;
  const wr = (i, v) => { mc.ioWrite(0x1ce, 2, i); mc.ioWrite(0x1cf, 2, v); };
  const dump = () => Array.from({ length: 11 }, (_, i) => (mc.ioWrite(0x1ce, 2, i), mc.ioRead(0x1cf, 2).toString(16))).join(' ');
  eq('DISPI at power-on: ID B0C5h, everything else 0, 4 MiB of video memory', dump(), 'b0c5 0 0 0 0 0 0 0 0 0 40');
  wr(4, 2);
  eq('...GETCAPS reads QEMU\'s maxima', dump(), 'b0c5 3e80 2ee0 20 2 0 0 0 0 0 40');
  wr(4, 0); cpu.ax = 0x4f02; cpu.bx = 0x4117; mc.intHandlers[0x10](cpu, mc);
  eq('...a mode the VBE BIOS set reads back as SeaVGABIOS leaves it', dump(), 'b0c5 400 300 10 41 0 400 800 0 0 40');
  wr(4, 0); wr(3, 8); wr(1, 0x400); wr(2, 0x300); wr(5, 0); mc.mem.u8[mc.vbeFbBase] = 0x55; wr(4, 0x41);
  eq('...NT 3.51\'s sequence sets 1024x768x8 over the LFB, cleared', [dump(), mc.vbe && [mc.vbe.width, mc.vbe.height, mc.vbe.bpp, mc.vbe.pitch].join('x'), mc.mem.u8[mc.vbeFbBase]].join(), 'b0c5 400 300 8 41 0 400 1000 0 0 40,1024x768x8x1024,0');
  wr(6, 1280); wr(8, 8); wr(9, 4);
  eq('...a virtual width and a display offset move the scanned-out base', [dump(), mc.vbe.pitch, mc.vbe.base - mc.vbeFbBase].join(), 'b0c5 400 300 8 41 0 500 ccc 8 4 40,1280,5128');
  wr(4, 0);
  eq('...and disabling leaves the mode, keeping the registers', [dump(), mc.vbe].join(), 'b0c5 400 300 8 0 0 500 ccc 8 4 40,');
  const isa = new Machine({ memSize: 16 << 20 }); installBIOS(isa);
  eq('without PCI the ports are not decoded', isa.ioRead(0x1cf, 2), 0xffff); }

// ---- the 16550A on COM1 (src/uart.js): what tools/uartprobe.asm reads on QEMU ---------------------
// QEMU's 16550A answers 60 01 C1 5A F0 F0 61 A5 C2 C1 B0 B0 to the probe's twelve reads.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc, { serial: true });
  const inb = (p) => (mc.portRead[p] ? mc.portRead[p](p, 1) & 0xff : 0xff), outb = (p, v) => { if (mc.portWrite[p]) mc.portWrite[p](p, 1, v); };
  const r = [];
  r.push(inb(0x3fd), inb(0x3fa)); outb(0x3fa, 0x07); r.push(inb(0x3fa));
  outb(0x3ff, 0x5a); r.push(inb(0x3ff));
  outb(0x3fc, 0x1f); r.push(inb(0x3fe), inb(0x3fe));
  outb(0x3f8, 0xa5); r.push(inb(0x3fd), inb(0x3f8));
  outb(0x3f9, 0x02); r.push(inb(0x3fa), inb(0x3fa)); outb(0x3f9, 0);
  outb(0x3fc, 0x03); r.push(inb(0x3fe), inb(0x3fe));
  eq('COM1 answers the probe as QEMU\'s 16550A does', r.map((v) => v.toString(16).padStart(2, '0')).join(' '), '60 01 c1 5a f0 f0 61 a5 c2 c1 b0 b0');
  outb(0x3fc, 0x08); outb(0x3f9, 0x01); mc.irqPendingMask = 0;
  if (mc.serial) mc.serial.receive('A');
  eq('...a received byte with IER bit 0 and OUT2 raises IRQ 4', [(mc.irqPendingMask >> 4) & 1, inb(0x3f8)].join(), '1,65');
  eq('...and the BDA names COM1 at 3F8h, one port in the equipment word', [mc.mem.r16(0x400).toString(16), (mc.mem.r16(0x410) >> 9) & 7].join(), '3f8,1'); }

// ---- the RTC's periodic interrupt: register A's rate, register B's PIE, IRQ 8 ----------------------
// Windows NT 3.51's HAL calibrates its stall loop on it (A = 2Dh: 8 Hz, B = 42h: PIE) with every
// other IRQ masked; without it the HAL counted for ever at hal.dll+8390.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
  const w = (r, v) => { mc.portWrite[0x70](0x70, 1, r); mc.portWrite[0x71](0x71, 1, v); };
  const r = (reg) => { mc.portWrite[0x70](0x70, 1, reg); return mc.portRead[0x71](0x71, 1) & 0xff; };
  w(0x0a, 0x2d); w(0x0b, 0x42);
  mc.irqPendingMask = 0;
  const period = 18.2065 * mc.pitBase / 8;
  cpu.cycles += period * 0.5; mc.rtcPoll && mc.rtcPoll();
  const early = (mc.irqPendingMask >> 8) & 1;
  cpu.cycles += period * 0.6; mc.rtcPoll && mc.rtcPoll();
  eq('8 Hz with PIE: no IRQ 8 before an eighth of a second, one after', [early, (mc.irqPendingMask >> 8) & 1].join(), '0,1');
  eq('...register C says PF and IRQF, and reading it clears them', [r(0x0c).toString(16), r(0x0c)].join(), 'c0,0'); }

// ---- D8: a CR3 load keeps the translated blocks, and a remapped page is still caught -----------
// Windows 9x reloads CR3 with the same value thousands of times a minute; dropping every block each
// time cost Windows ME 35% of its host time in translate(). Blocks now survive the load and are
// revalidated against the frames they were translated from.
{ const mc = new Machine({ memSize: 8 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, DIR = 0x10000, PT0 = 0x11000, PT1 = 0x12000, A = 0x200000, B = 0x201000;
  m.setA20(true); mc.rec.setMask(m.mask);                                    // the frames are above 1 MiB
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92);
  for (let i = 0; i < 1024; i++) m.w32(PT0 + i * 4, (i << 12) | 3);           // 0-4 MiB identity
  m.w32(DIR, PT0 | 3); m.w32(DIR + 4, PT1 | 3); m.w32(PT1, A | 3);            // linear 400000h -> A
  m.blit(A, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xeb, 0xfe]));                 // mov eax,1 ; jmp $
  m.blit(B, Uint8Array.from([0xb8, 2, 0, 0, 0, 0xeb, 0xfe]));                 // mov eax,2 ; jmp $
  cpu.setCR3(DIR); cpu.setCR0(0x80000001); cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.reg[4] = 0x9000;
  const go = () => { cpu.eip = 0x400000; cpu.halted = false; cpu.reg[0] = 0; mc.runSlice(50); return cpu.reg[0]; };
  try {
  const first = go(), c1 = mc.rec.stats.compiles;
  cpu.setCR3(DIR);                                                            // same value: a TLB flush
  const again = go(), c2 = mc.rec.stats.compiles;
  eq('D8: a CR3 reload with the mapping unchanged recompiles nothing', [first, again, c2 - c1].join(), '1,1,0');
  m.w32(PT1, B | 3); cpu.setCR3(DIR);                                         // remap the code page
  eq('...and a remapped code page runs the new bytes', go(), 2);
  } catch (e) { eq('D8 test machine runs', String(e.message).slice(0, 60), 'no exception'); } }

// ---- flat segments: no limit check, until a segment is no longer flat --------------------------------
// A block whose segments are flat (limit 4 GiB, expand-up: Linux's, Win32's) is translated without
// limit checks and checks once at its head that they still are (FLATSPEC). Here a subroutine runs with
// DS flat, then again after DS is loaded with a 4 KiB segment: its read at 3000h must be #GP the
// second time, the translated block notwithstanding. And under paging an instruction that only moves
// registers stores no EIP: the #GP's EIP must still be the faulting `mov eax,[3000h]`, not the
// `mov ebx,eax` before it.
{ const mc = new Machine({ memSize: 8 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, IDT = 0x8800, DIR = 0x10000, PT0 = 0x11000, PT1 = 0x12000, A = 0x200000;
  m.setA20(true); mc.rec.setMask(m.mask);
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff; cpu.idtr.base = IDT; cpu.idtr.limit = 0x7ff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92);
  m.w16(GDT + 0x18, 0x0fff); m.w16(GDT + 0x1a, 0); m.w8(GDT + 0x1c, 0); m.w8(GDT + 0x1d, 0x92); m.w8(GDT + 0x1e, 0x40); m.w8(GDT + 0x1f, 0);   // 18h: data, limit FFFh
  const g = IDT + 13 * 8; m.w16(g, 0x6000); m.w16(g + 2, 0x08); m.w8(g + 4, 0); m.w8(g + 5, 0x8e); m.w16(g + 6, 0);   // #GP -> 08:6000
  for (let i = 0; i < 1024; i++) m.w32(PT0 + i * 4, (i << 12) | 3);
  m.w32(DIR, PT0 | 3); m.w32(DIR + 4, PT1 | 3); m.w32(PT1, A | 3);
  // nasm (bits 32, org 400000h): call sub / mov ax,18h / mov ds,ax / call sub / hlt ... 400100h:
  //   sub: mov ebx,eax / add ebx,1 / mov eax,[3000h] / ret
  m.blit(A, Uint8Array.from('e8fb00000066b818008ed8e8f0000000f4'.match(/../g).map((x) => parseInt(x, 16))));
  m.blit(A + 0x100, Uint8Array.from('89c383c301a100300000c3'.match(/../g).map((x) => parseInt(x, 16))));
  m.blit(0x6000, Uint8Array.from('8b44240436a300710000f4'.match(/../g).map((x) => parseInt(x, 16))));   // #GP: [7100h] = the pushed EIP; hlt
  cpu.setCR3(DIR); cpu.setCR0(0x80000001); cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.setSeg(DS, 0x10); cpu.reg[4] = 0x9000; cpu.eip = 0x400000;
  let got;
  try { for (let i = 0; i < 50 && !cpu.halted; i++) mc.runSlice(100); got = (m.r32(0x7100) >>> 0).toString(16); } catch (e) { got = e.message.slice(0, 60); }
  eq('flat segments: a block translated with DS flat faults once DS has a 4 KiB limit, at the faulting instruction', got, '400105');
  // A #PF is raised from inside the access and needs the per-instruction EIP: 400200h: mov ebx,eax /
  // add ebx,1 / mov eax,[800000h] (not mapped) / hlt; the #PF handler at 6100h keeps the pushed EIP.
  const p = IDT + 14 * 8; m.w16(p, 0x6100); m.w16(p + 2, 0x08); m.w8(p + 4, 0); m.w8(p + 5, 0x8e); m.w16(p + 6, 0);
  m.blit(A + 0x200, Uint8Array.from('89c383c301a100008000f4'.match(/../g).map((x) => parseInt(x, 16))));
  m.blit(0x6100, Uint8Array.from('8b44240436a304710000f4'.match(/../g).map((x) => parseInt(x, 16))));
  try { cpu.setSeg(DS, 0x10); cpu.reg[4] = 0x9000; cpu.eip = 0x400200; cpu.halted = false;
    for (let i = 0; i < 50 && !cpu.halted; i++) mc.runSlice(100); got = (m.r32(0x7104) >>> 0).toString(16); } catch (e) { got = e.message.slice(0, 60); }
  eq('...and a page fault after instructions that store no EIP reports the faulting instruction', got, '400205'); }

// ---- 32-bit shifts by an immediate count, translated inline: the helper's result and flags ----------
// `shl eax,3` in a flat 32-bit program called cpu.shl and computed every flag for the next `add` to
// overwrite; it is now a JavaScript shift, its flags in the strippable setShiftResult. Here each of
// SHL/SHR/SAR by 1, 3, 31 on values with the top and low bits in every state: EAX, and CF PF ZF SF OF
// read live by PUSHFD, must be what the helpers give.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000; cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92);
  cpu.cr0 = 1; cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.setSeg(DS, 0x10);
  const ref = new Machine({ memSize: 1 << 16 }).cpu;
  const bad = [];
  let at = 0x2000;
  for (const [reg, name] of [[4, 'shl'], [5, 'shr'], [7, 'sar']]) for (const c of [1, 3, 31]) for (const v of [0x80000001, 0x40000000, 0x7fffffff, 0xc0000000, 1, 0]) {
    // mov eax,v / shl|shr|sar eax,c / pushfd / pop ebx / hlt
    const code = [0xb8, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24, 0xc1, 0xc0 | (reg << 3), c, 0x9c, 0x5b, 0xf4];
    m.blit(at, Uint8Array.from(code)); cpu.eip = at; cpu.halted = false; cpu.reg[4] = 0x9000; cpu.flags = 0x2;
    for (let i = 0; i < 10 && !cpu.halted; i++) mc.runSlice(10);
    ref.flags = 0x2; const want = ref[name](v, c, 32) >>> 0, wf = ref.flags & 0x8c5, gf = cpu.reg[3] & 0x8c5;
    if ((cpu.reg[0] >>> 0) !== want || gf !== wf) bad.push(`${name} ${v.toString(16)},${c}: ${(cpu.reg[0] >>> 0).toString(16)}/${gf.toString(16)} want ${want.toString(16)}/${wf.toString(16)}`);
    at += 16;
  }
  eq('32-bit SHL/SHR/SAR by an immediate count: the helpers\' result and flags', bad.slice(0, 3).join(' | ') || 'same', 'same'); }

// ---- paging off and on again keeps the blocks; code changed meanwhile is still caught -------------------
// CWSDPMI returns to real mode for every interrupt: under FreeDOS, Kraptor toggled paging 2600 times a
// second, each toggle dropped the whole cache, and the browser translated 128 000 blocks a second. Each
// paging state now keeps its own cache; the one put away is checked against its bytes when it returns.
{ const mc = new Machine({ memSize: 8 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const GDT = 0x8000, DIR = 0x10000, PT0 = 0x11000, PT1 = 0x12000, A = 0x200000;
  m.setA20(true); mc.rec.setMask(m.mask);
  cpu.gdtr.base = GDT; cpu.gdtr.limit = 0xff;
  const desc = (i, access) => { const a = GDT + i * 8; m.w16(a, 0xffff); m.w16(a + 2, 0); m.w8(a + 4, 0); m.w8(a + 5, access); m.w8(a + 6, 0xcf); m.w8(a + 7, 0); };
  desc(1, 0x9a); desc(2, 0x92);
  for (let i = 0; i < 1024; i++) m.w32(PT0 + i * 4, (i << 12) | 3);
  m.w32(DIR, PT0 | 3); m.w32(DIR + 4, PT1 | 3); m.w32(PT1, A | 3);            // linear 400000h -> A
  m.blit(A, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xeb, 0xfe]));                 // mov eax,1 ; jmp $
  cpu.setCR3(DIR); cpu.setCR0(0x80000001); cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.reg[4] = 0x9000;
  const go = () => { cpu.eip = 0x400000; cpu.halted = false; cpu.reg[0] = 0; mc.runSlice(50); return cpu.reg[0]; };
  const away = () => { cpu.setCR0(0x00000001); cpu.setCR3(DIR); cpu.setCR0(0x80000001); };   // CWSDPMI's round trip
  try {
    const first = go(), c1 = mc.rec.stats.compiles;
    for (let i = 0; i < 20; i++) away();
    const again = go(), c2 = mc.rec.stats.compiles;
    eq('paging off and on (CR3 loaded between) keeps the translated blocks', [first, again, c2 - c1].join(), '1,1,0');
    cpu.setCR0(0x00000001); m.blit(A, Uint8Array.from([0xb8, 3, 0, 0, 0])); cpu.setCR0(0x80000001);
    eq('...and code rewritten while paging was off runs as rewritten', go(), 3);
  } catch (e) { eq('paging-toggle test machine runs', String(e.message).slice(0, 60), 'no exception'); } }

// ---- leaving paging copies the identity tables back instead of refilling every page --------------------
// CWSDPMI leaves paging 2000 times a second for Liquid War; each time the tables were refilled page by
// page, 16384 entries for 64 MiB, and loading the game ran at 1 M instructions a second in Chrome. The
// identity tables are kept and copied back, and must still follow a page that gains code and the A20.
{ const mc = new Machine({ memSize: 8 << 20 }); const cpu = mc.cpu, m = mc.mem;
  const DIR = 0x10000, PT0 = 0x11000;
  m.setA20(true); mc.rec.setMask(m.mask);
  for (let i = 0; i < 1024; i++) m.w32(PT0 + i * 4, (i << 12) | 3);
  m.w32(DIR, PT0 | 3);
  let fills = 0; const f0 = m._fillPage.bind(m); m._fillPage = (p, pg) => { fills++; return f0(p, pg); };
  const round = () => { cpu.setCR3(DIR); cpu.setCR0(0x80000001); cpu.setCR0(0x00000001); };
  round(); fills = 0;
  for (let i = 0; i < 10; i++) round();
  eq('leaving paging ten times refills no page of the identity tables', fills, 0);
  m.markCodePage(0x150); round();
  eq('...a page that gained code while paged still traps writes', [m.wrOfs[0x150], m.rdOfs[0x150], m.wrOfs[0x151]].join(), '-1,0,0');
  m.setA20(false); round();
  eq('...and closing the A20 sends the pages above 1 MiB to the helper again', [m.rdOfs[0x100], m.rdOfs[0x50]].join(), '-1,0'); }

// ---- D8 step 3: the xlat TLB keeps protection, dirty bits and INVLPG exact -------------------------
// The NT/9x kernels live above the installed RAM, where every byte used to take a full page walk;
// a small TLB now sits in front of the walk. It must not widen any right the walk would refuse.
{ const mc = new Machine({ memSize: 8 << 20 }); const cpu = mc.cpu, m = mc.mem;
  m.setA20(true); mc.rec.setMask(m.mask);
  const DIR = 0x10000, PT0 = 0x11000, PTH = 0x12000, F1 = 0x300000, F2 = 0x301000;
  for (let i = 0; i < 1024; i++) m.w32(PT0 + i * 4, (i << 12) | 3);
  m.w32(DIR, PT0 | 3); m.w32(DIR + (0x80000000 >>> 22) * 4, PTH | 7);        // PDE: user-accessible
  m.w32(PTH, F1 | 3);                                                         // PTE: supervisor, R/W
  m.u8[F1 + 0x10] = 0x5a; m.u8[F2 + 0x10] = 0xa5;
  cpu.setCR3(DIR); cpu.setCR0(0x80000001);
  cpu._cpl = 0;
  const sup = m.xlat(0x80000010, false);
  cpu._cpl = 3;
  let user; try { user = m.xlat(0x80000010, false); } catch (e) { user = e.constructor.name === 'PageFault' ? 'PF' : String(e); }
  eq('xlat TLB: a supervisor read is cached, a user read of the same page is still refused', [sup === F1 + 0x10, user].join(), 'true,PF');
  cpu._cpl = 0;
  const pte0 = m.r32phys(PTH); m.xlat(0x80000020, true);
  eq('...the first write after a cached read sets D in the PTE', [(pte0 >> 6) & 1, (m.r32phys(PTH) >> 6) & 1].join(), '0,1');
  m.w32(PTH, F2 | 3); cpu.invlpg(0x80000000);
  eq('...and INVLPG on a page above RAM drops the entry: the remap is seen', m.r8(0x80000010), 0xa5); }

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
  eq('CPUID claims CMPXCHG8B, which cpu.cmpxchg8b implements', (cpu.reg[2] >> 8) & 1, 1);
  eq('...and on a 586 neither CMOV nor MSR: those are the P6 profiles', ((cpu.reg[2] >> 15) & 1) | ((cpu.reg[2] >> 5) & 1), 0);
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

// ---- a CALL GATE is honoured by the INDIRECT far forms too ------------------------------------
// FF /3 and FF /5 loaded CS themselves instead of going through cpu.farCall/farJmp, so a call gate
// was not followed there although the direct 9A/EA forms had followed one since test386. A gate is
// a SYSTEM descriptor, so loading it as a segment is #GP(selector) — which is exactly what Windows
// 3.1's DOS extender reported: `call far [cs:1408]` through selector 00D3, a 286 gate to 0070:1415,
// answered with "Standard Mode: Bad Fault in MS-DOS Extender. Fault: 000D ... EC=00D0".
//
// The bases are set BEFORE PE goes on, as in the #UD test below: the descriptor caches keep them,
// which places code for the recompiler without needing a GDT entry for CS itself.
const gateRun = (op) => {                             // op: 3 = CALLF Ev, 5 = JMPF Ev
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  const GDT = 0x8000;
  const desc = (i, base, limit, access) => {
    const a = GDT + i * 8;
    mem.w16(a, limit & 0xffff); mem.w16(a + 2, base & 0xffff);
    mem.w8(a + 4, (base >> 16) & 0xff); mem.w8(a + 5, access);
    mem.w8(a + 6, (limit >> 16) & 0x0f); mem.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(1, 0x1000, 0xffff, 0x9a);                      // 08: the gate's target code segment
  mem.w16(GDT + 3 * 8, 0x0100); mem.w16(GDT + 3 * 8 + 2, 0x0008);
  mem.w8(GDT + 3 * 8 + 4, 0); mem.w8(GDT + 3 * 8 + 5, 0x84);   // 18: 286 call gate, P=1 DPL=0 type 4
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0x100); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mem.blit(0x1000, Uint8Array.from([0xff, (op << 3) | 0x06, 0x20, 0x00]));              // ff /op [0020]
  mem.w16(0x1020, 0x0000); mem.w16(0x1022, 0x0018);   // the far pointer: selector 0018, offset 0
  // A MARKER at the gate's entry, not just a HLT: landing one byte early would also halt, and the
  // test would pass. Only entry at exactly 0100 leaves AX = 1234.
  mem.blit(0x1100, Uint8Array.from([0xb8, 0x34, 0x12, 0xf4]));                          // mov ax,1234 ; hlt
  cpu.gdtr = { base: GDT, limit: 0x3f }; cpu.cr0 |= 1;
  let raised = null;
  mc.protInt = (n, e) => { raised = { n, e }; cpu.halted = true; };
  let steps = 0; while (!cpu.halted && steps++ < 40) mc.rec.step();
  return { cs: cpu.seg[CS], eip: cpu.eip >>> 0, ax: cpu.reg[0] & 0xffff, raised, sp: cpu.reg[4] & 0xffff, mem };
};
{ const call = gateRun(3);
  eq('FF /3 through a call gate raises nothing', call.raised, null);
  eq('...and lands in the gate\'s code segment', call.cs, 0x08);
  eq('...at the gate\'s own offset, not the one in memory', call.ax, 0x1234);
  eq('...having pushed the return offset', call.mem.r16(0x3000 + call.sp), 4);
  eq('...and the return segment', call.mem.r16(0x3000 + call.sp + 2), 0x100);
  const jmp = gateRun(5);
  eq('FF /5 through a call gate raises nothing', jmp.raised, null);
  eq('...and lands in the gate\'s code segment', jmp.cs, 0x08);
  eq('...at the gate\'s own offset', jmp.ax, 0x1234);
  eq('...pushing nothing', jmp.sp, 0x1000); }

// ---- a FAULTING far transfer is delivered as if the instruction never ran ----------------------
// The fault is delivered INSIDE setSeg, synchronously, so by the time the load reports a refusal
// CS:EIP and SS:ESP already belong to the handler. farCall/farJmp were written for a deferred
// fault — push, load, then on refusal rewind ESP and set EIP — and that was wrong three times
// over: the frame saved the RETURN address, the handler's entry EIP was overwritten with the
// caller's offset, and ESP was rewound under the handler's frame. Windows 3.1 demand-loads its
// code through exactly this #NP, and a handler that cannot restart the faulting CALL cannot load
// anything: it ran from its own CS at the caller's IP until it hit #GP(07D0).
//
// Each case: a far transfer to a NOT-PRESENT code segment; the #NP handler is a 286 interrupt gate
// whose entry leaves a marker. Checked: the handler ran from its OWN entry, the frame holds exactly
// err / IP / CS / FLAGS with IP = the faulting instruction, and nothing else was pushed.
const npRun = (code) => {
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  const GDT = 0x8000, IDT = 0xa000;
  const desc = (i, base, limit, access) => {
    const a = GDT + i * 8;
    mem.w16(a, limit & 0xffff); mem.w16(a + 2, base & 0xffff);
    mem.w8(a + 4, (base >> 16) & 0xff); mem.w8(a + 5, access);
    mem.w8(a + 6, (limit >> 16) & 0x0f); mem.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(1, 0x1000, 0xffff, 0x9a);                      // 08: the handler's code segment
  desc(3, 0x5000, 0xffff, 0x1a);                      // 18: code, readable — NOT PRESENT
  mem.w16(IDT + 11 * 8, 0x0200); mem.w16(IDT + 11 * 8 + 2, 0x0008);
  mem.w8(IDT + 11 * 8 + 5, 0x86);                     // #NP -> 286 interrupt gate to 08:0200
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0x100); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mem.blit(0x1000, Uint8Array.from(code));
  mem.w16(0x1020, 0x0000); mem.w16(0x1022, 0x0018);   // an indirect form's far pointer
  mem.blit(0x1200, Uint8Array.from([0xb8, 0x34, 0x12, 0xf4]));                          // mov ax,1234 ; hlt
  cpu.gdtr = { base: GDT, limit: 0x3f }; cpu.idtr = { base: IDT, limit: 0xff }; cpu.cr0 |= 1;
  let steps = 0; while (!cpu.halted && steps++ < 40) mc.rec.step();
  const sp = cpu.reg[4] & 0xffff, w = (k) => mem.r16(0x3000 + sp + k * 2);
  return { ax: cpu.reg[0] & 0xffff, sp, err: w(0), ip: w(1), cs: w(2) };
};
for (const [name, code] of [['9A call far ptr', [0x9a, 0x00, 0x00, 0x18, 0x00]],
                            ['FF /3 call far [mem]', [0xff, 0x1e, 0x20, 0x00]],
                            ['FF /5 jmp far [mem]', [0xff, 0x2e, 0x20, 0x00]]]) {
  const r = npRun(code);
  eq(`${name} to a not-present segment: the #NP handler runs from its own entry`, r.ax, 0x1234);
  eq(`...its frame is err/IP/CS/FLAGS and nothing more`, r.sp, 0x1000 - 8);
  eq(`...the error code names the selector`, r.err, 0x18);
  eq(`...the saved IP is the FAULTING instruction, so the handler can restart it`, r.ip, 0);
  eq(`...and the saved CS is the caller's`, r.cs, 0x100);
}

// ---- VIRTUAL-8086 MODE: three things MS-DOS 6.22's EMM386 needs, in the order it hit them -------
// Each is set up directly on the CPU (PE on, VM on, CPL 3), because what is under test is the
// instruction's semantics in V86, not how the task got there.
const v86 = (iopl) => {
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.cr0 |= 1; cpu.flags = (0x20000 | (iopl << 12) | 2) >>> 0;
  cpu.setSeg(CS, 0x0f40); cpu.eip = 0x100; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.setSeg(DS, 0x0f40); cpu.setSeg(ES, 0x0f40);
  const calls = [];
  const orig = mc.protInt.bind(mc);
  mc.protInt = (n, err, f, soft) => { calls.push([n, err === undefined ? -1 : err]); if (calls.length === 1) return orig(n, err, f, soft); };
  return { mc, cpu, calls };
};
{ // (1) A far RET, CALL or JMP in V86 is an 8086 one: the selector is a paragraph. Judged by the
  // protected-mode rules, CS 0F40 has RPL 0 below CPL 3 — "a return inward" — and raised #GP(0F40):
  // EMM386 took that at a plain `retf` 155 000 times a second.
  const { mc, cpu, calls } = v86(3);
  cpu.push16(0x0f40); cpu.push16(0x1234);
  cpu.farRet(false, 0);
  eq('V86: RETF to CS=0F40 raises nothing', calls.length, 0);
  eq('...and lands at 0F40:1234', (cpu.seg[CS] << 16 | cpu.eip) >>> 0, 0x0f401234);
  eq('...with an 8086 base', cpu.base[CS] >>> 0, 0xf400);
  eq('...still in V86', (cpu.flags >> 17) & 1, 1);
  cpu.farJmp(0x0003, 0x0010);
  eq('V86: far JMP to a paragraph with RPL 3 is plain too', (cpu.base[CS] >>> 0) + cpu.eip, 0x40);
  cpu.farCall(0x0070, 0x0774, false, 0);
  eq('V86: far CALL pushes 8086-style and raises nothing', calls.length, 0);
  eq('...and lands in 0070', cpu.base[CS] >>> 0, 0x700); }
{ // (2) The BIOS stub's IRET, reached from V86. At IOPL 3 it must keep VM; below IOPL 3 it must
  // TRAP (IRET is IOPL-sensitive) with the service's answer already in the flags IMAGE.
  const a = v86(3);
  a.mc.intHandlers[0x61] = (c) => { c.flags |= 1; };             // a service that reports CF
  a.cpu.push16(0x3202); a.cpu.push16(0x0f40); a.cpu.push16(0x0200);   // FLAGS, CS, IP
  a.cpu.setSeg(CS, 0xf000); a.cpu.eip = 0x61;
  a.mc.biosCallback(0x61);
  eq('V86, IOPL 3: the stub IRET keeps VM', (a.cpu.flags >> 17) & 1, 1);
  eq('...returns to the caller', (a.cpu.seg[CS] << 16 | a.cpu.eip) >>> 0, 0x0f400200);
  eq('...and carries the service\'s CF back', a.cpu.flags & 1, 1);
  eq('...and keeps IOPL', (a.cpu.flags >> 12) & 3, 3);
  const b = v86(0);
  b.mc.intHandlers[0x61] = (c) => { c.flags |= 1; };
  b.cpu.push16(0x0202); b.cpu.push16(0x0f40); b.cpu.push16(0x0200);
  const sp = b.cpu.sp;
  b.cpu.setSeg(CS, 0xf000); b.cpu.eip = 0x61;
  b.mc.biosCallback(0x61);
  eq('V86, IOPL 0: the stub IRET traps to the monitor as #GP(0)', b.calls[0] && b.calls[0].join(','), '13,0');
  eq('...with the service\'s CF written into the flags IMAGE', b.mc.mem.r16(0x3000 + sp + 4) & 1, 1); }
{ // (3) The IDT gate is validated before it is used. EMM386 leaves IDT entries EMPTY on purpose:
  // an INT n from V86 must reach its #GP handler with error code n*8+2 and be reflected. Read as a
  // gate to selector 0, the empty IDT[12h] sent MIRAGE to 0003:0000 at CPL 3 with VM clear.
  const { mc, cpu, calls } = v86(3);
  const IDT = 0xa000;
  cpu.idtr = { base: IDT, limit: 0x1ff };
  mc.mem.w16(IDT + 0x10 * 8 + 2, 0x0048); mc.mem.w8(IDT + 0x10 * 8 + 5, 0x8e);   // INT 10h: DPL 0
  mc.mem.w8(IDT + 0x21 * 8 + 5, 0x6e);                                           // INT 21h: DPL 3, NOT present
  mc.softInt(0x12, 0x102, 0x100);
  eq('INT 12h through an EMPTY gate: #GP(12h*8+2)', calls[0] && calls[0].join(','), '13,146');
  calls.length = 0;
  mc.softInt(0x10, 0x102, 0x100);
  eq('INT 10h from V86 to a DPL-0 gate: #GP(10h*8+2), CPL 3 not seg[CS]&3', calls[0] && calls[0].join(','), '13,130');
  calls.length = 0;
  mc.softInt(0x21, 0x102, 0x100);
  eq('INT 21h through a NOT-PRESENT gate: #NP(21h*8+2)', calls[1] && calls[1].join(','), '11,266');
  calls.length = 0;
  cpu.idtr = { base: IDT, limit: 0x7f };                                         // 16 entries
  mc.softInt(0x40, 0x102, 0x100);
  eq('INT 40h past the IDT limit: #GP(40h*8+2)', calls[0] && calls[0].join(','), '13,514');
  // An EXCEPTION through an empty gate sets EXT: error code n*8+2+1.
  calls.length = 0; cpu.idtr = { base: IDT, limit: 0x1ff };
  mc.protInt(0x0b, 0);
  eq('an exception through an empty gate sets EXT', calls[1] && calls[1].join(','), '13,91'); }

// ---- segment WRITE PROTECTION and segment LIMITS are enforced by default ------------------------
// Both checks existed behind MIRAGE_SEGWP / MIRAGE_SEGLIM, "off until the bench says what it costs".
// It said 0-5% on the real-mode workloads with golden unchanged, so they are on. test386's POST 0x12
// tests exactly these two first: a store through a read-only data segment, and a dword read whose
// LAST byte is past the limit although its offset is inside.
const segRun = (code) => {
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  const GDT = 0x8000;
  const desc = (i, base, limit, access) => {
    const a = GDT + i * 8;
    mem.w16(a, limit & 0xffff); mem.w16(a + 2, base & 0xffff);
    mem.w8(a + 4, (base >> 16) & 0xff); mem.w8(a + 5, access);
    mem.w8(a + 6, (limit >> 16) & 0x0f); mem.w8(a + 7, (base >> 24) & 0xff);
  };
  desc(2, 0x5000, 0xffff, 0x90);                      // 10: data, READ-ONLY
  desc(3, 0x5000, 0x00ff, 0x92);                      // 18: data, writable, limit FFh
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.gdtr = { base: GDT, limit: 0x1f }; cpu.cr0 |= 1;
  mem.blit(0x1000, Uint8Array.from(code));
  let raised = null;
  mc.protInt = (n, err) => { raised = [n, err]; cpu.halted = true; };
  let steps = 0; while (!cpu.halted && steps++ < 40) mc.rec.step();
  return raised && raised.join(',');
};
eq('a store through a READ-ONLY data segment is #GP(0)',
  segRun([0xb8, 0x10, 0x00, 0x8e, 0xd8, 0xa3, 0x00, 0x00, 0xf4]), '13,0');   // mov ax,10 / mov ds,ax / mov [0],ax
eq('...while a read through it is fine',
  segRun([0xb8, 0x10, 0x00, 0x8e, 0xd8, 0xa1, 0x00, 0x00, 0xf4]), null);     // mov ax,[0]
eq('a word read whose LAST byte is past the limit is #GP(0)',
  segRun([0xb8, 0x18, 0x00, 0x8e, 0xd8, 0xa1, 0xff, 0x00, 0xf4]), '13,0');   // mov ax,[00FF], limit FF
eq('...while one that ends ON the limit is fine',
  segRun([0xb8, 0x18, 0x00, 0x8e, 0xd8, 0xa1, 0xfe, 0x00, 0xf4]), null);     // mov ax,[00FE]

// ---- a block translated in real mode carries no limit guards, and must not run in protected mode --
// The guards are dead in real and V86 mode, so the recompiler leaves them out of a block translated
// there and marks it `real`. Two ways that block could then run with PE set: reached again after the
// switch (the dispatch loop must retranslate it), or switching itself part-way through with LMSW (the
// block must have been translated checked). Each case faults only if its safeguard is in place.
{ const realThenPM = (code, between) => {
    const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
    const GDT = 0x8000, a = GDT + 3 * 8;                // 18: data, writable, base 5000h, limit FFh
    mem.w16(a, 0x00ff); mem.w16(a + 2, 0x5000); mem.w8(a + 4, 0); mem.w8(a + 5, 0x92);
    cpu.gdtr = { base: GDT, limit: 0x1f };
    cpu.setSeg(CS, 0x100); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x500);
    mem.blit(0x1000, Uint8Array.from(code));
    let raised = null;
    mc.protInt = (n, err) => { raised = [n, err]; cpu.halted = true; };
    const go = () => { cpu.eip = 0; cpu.halted = false; let s = 0; while (!cpu.halted && s++ < 40) mc.rec.step(); };
    between(cpu, go);
    return raised && raised.join(',');
  };
  eq('a block translated in real mode is retranslated when reached in protected mode',
    realThenPM([0xa1, 0xff, 0x00, 0xf4], (cpu, go) => {            // mov ax,[00FF] / hlt
      go();                                                       // real mode: no limit, no fault
      cpu.cr0 |= 1; cpu.setSeg(DS, 0x18); go();                   // same bytes, DS limit FFh
    }), '13,0');
  eq('a real-mode block whose LMSW sets PE keeps its limit guards',
    realThenPM([0xb8, 0x01, 0x00, 0x0f, 0x01, 0xf0, 0xa1, 0xff, 0x00, 0xf4], (cpu, go) => { // mov ax,1 / lmsw ax / mov ax,[00FF]
      cpu.cr0 |= 1; cpu.setSeg(DS, 0x18); cpu.cr0 &= ~1;          // DS keeps its FFh limit in real mode
      go();
    }), '13,0'); }

// ---- VERR / VERW answer a question, they do not always say yes -------------------------------
// This was `cpu.flags |= ZF`: a stub that cannot fail, and therefore cannot be told apart from a
// working implementation until a guest asks about a selector that is NOT accessible. Six of the
// thirteen cases in tools/pmprobe.asm were wrong, and QEMU and v86 agree on all thirteen.
//
// The one that is not guessable: presence is NOT required. "May I read it" sounds as though the
// segment would have to be in memory; both references say ZF=1 for a not-present data segment, and
// the manual's pseudocode checks only the limit, the type and the privilege.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  const GDT = 0x8000;
  cpu.gdtr = { base: GDT, limit: 0x37 };              // seven descriptors: 0x40 is past the end
  const desc = (i, access, limit = 0xffff) => {
    const a = GDT + i * 8;
    mc.mem.w16(a, limit & 0xffff); mc.mem.w16(a + 2, 0);
    mc.mem.w8(a + 4, 0); mc.mem.w8(a + 5, access); mc.mem.w8(a + 6, 0); mc.mem.w8(a + 7, 0);
  };
  desc(1, 0x9a); desc(2, 0x92); desc(3, 0x98); desc(4, 0x90); desc(5, 0x12); desc(6, 0x82);
  // Bases first, PE after — the descriptor caches keep them, which places code for the recompiler
  // without needing a GDT entry for CS itself. Setting them the other way round loads 0x100 as a
  // selector, which is past this GDT and faults before the test begins.
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  cpu.cr0 |= 1;
  const R = (s) => cpu.verifySeg(s, 0), W = (s) => cpu.verifySeg(s, 1);
  eq('VERR: readable code is readable', R(0x08), true);
  eq('VERW: code is NEVER writable', W(0x08), false);
  eq('VERR: execute-only code is not readable', R(0x18), false);
  eq('VERW: execute-only code is not writable', W(0x18), false);
  eq('VERR: writable data is readable', R(0x10), true);
  eq('VERW: writable data is writable', W(0x10), true);
  eq('VERR: read-only data is still readable', R(0x20), true);
  eq('VERW: read-only data is not writable', W(0x20), false);
  eq('VERR: a NOT-PRESENT segment is readable — presence is not a condition', R(0x28), true);
  eq('VERW: ...and writable, for the same reason', W(0x28), true);
  eq('VERR: a system descriptor is refused, though LAR accepts one', R(0x30), false);
  eq('VERR: the null selector is refused', R(0x00), false);
  eq('VERR: a selector past the table is refused', R(0x40), false);
  // ...and the recompiler must EMIT that, not a constant. 0f 00 e3 = verr bx ; f4 = hlt
  cpu.flags |= 0x40;                                  // ZF set on the way in, so a no-op shows
  cpu.reg[3] = 0x18;                                  // BX = the execute-only selector
  mc.mem.blit(0x100 * 16, Uint8Array.from([0x0f, 0x00, 0xe3, 0xf4]));
  let steps = 0; while (!cpu.halted && steps++ < 20) mc.rec.step();
  eq('VERR through the recompiler CLEARS ZF when the answer is no', (cpu.flags >> 6) & 1, 0); }

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


// ---- INT 15h AH=87h: copy extended memory ------------------------------------------------------
// The AT BIOS block move. It answered "function not supported", and MS-DOS 6.22's HIMEM and EMM386
// both call it while installing (v86's msdos622.img): EMM386 copies its protected-mode tables up to
// 1.2 MB with it. ES:SI -> a six-descriptor GDT, source at +10h, destination at +18h, CX in WORDS,
// base = the 24-bit field plus byte 7 on a 386.
{ const mc = new Machine({ memSize: 4 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  installBIOS(mc);
  const GDT = 0x3000, desc = (off, base) => {
    mem.w16(GDT + off, 0xffff); mem.w16(GDT + off + 2, base & 0xffff);
    mem.w8(GDT + off + 4, (base >>> 16) & 0xff); mem.w8(GDT + off + 5, 0x93);
    mem.w8(GDT + off + 6, 0); mem.w8(GDT + off + 7, (base >>> 24) & 0xff);
  };
  for (let i = 0; i < 0x30; i++) mem.w8(GDT + i, 0);
  desc(0x10, 0x180000); desc(0x18, 0x2000);            // ABOVE 1 MiB -> conventional memory
  for (let i = 0; i < 16; i++) mem.u8[0x180000 + i] = 0xa0 + i;
  for (let i = 0; i < 20; i++) mem.u8[0x2000 + i] = 0x55;
  cpu.setSeg(ES, 0x300); cpu.si = 0; cpu.cx = 8; cpu.ax = 0x8700; cpu.flags |= 1;
  mc.intHandlers[0x15](cpu, mc);
  eq('AH=87h clears CF', cpu.flags & 1, 0);
  eq('...and returns AH=00', (cpu.ax >> 8) & 0xff, 0);
  eq('...having copied the first byte from above 1 MiB', mem.u8[0x2000], 0xa0);
  eq('...and the last of the CX WORDS', mem.u8[0x200f], 0xaf);
  eq('...and not one byte more', mem.u8[0x2010], 0x55);
  // ...and the other way, with byte 7 of the base in use: 0x01180000 is past 16 MiB, so a copy that
  // ignored it would land 16 MiB lower.
  const big = new Machine({ memSize: 32 << 20 }); installBIOS(big);
  const bm = big.mem, bc = big.cpu;
  for (let i = 0; i < 0x30; i++) bm.w8(GDT + i, 0);
  const d2 = (off, base) => { bm.w16(GDT + off, 0xffff); bm.w16(GDT + off + 2, base & 0xffff);
    bm.w8(GDT + off + 4, (base >>> 16) & 0xff); bm.w8(GDT + off + 5, 0x93); bm.w8(GDT + off + 7, (base >>> 24) & 0xff); };
  d2(0x10, 0x2000); d2(0x18, 0x01180000);
  bm.u8[0x2000] = 0x77; bm.u8[0x2001] = 0x88;
  bc.setSeg(ES, 0x300); bc.si = 0; bc.cx = 1; bc.ax = 0x8700;
  big.intHandlers[0x15](bc, big);
  eq('AH=87h honours byte 7 of the base (past 16 MiB)', bm.u8[0x01180000] | (bm.u8[0x01180001] << 8), 0x8877);
  eq('...rather than landing 16 MiB lower', bm.u8[0x00180000], 0); }

// ---- a PS/2 mouse: INT 15h C2xx, the 8042 aux channel, IRQ12 and the INT 74h routine -----------
// CuteMouse on v86's msdos622.img asked C205 and got "function not supported": "Error: device not
// found" where QEMU installs it "at PS/2 port". Here: the BIOS interface, then a packet all the way
// into a GUEST handler registered with C207, which records the four words the BIOS pushes.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  installBIOS(mc);
  const call = (ax, bx, es) => { cpu.ax = ax; cpu.bx = bx; if (es !== undefined) cpu.setSeg(ES, es); cpu.flags &= ~1; mc.intHandlers[0x15](cpu, mc); return { ah: (cpu.ax >> 8) & 0xff, cf: cpu.flags & 1 }; };
  eq('C200 enable with no handler installed: AH=05', call(0xc200, 0x0100).ah, 0x05);
  eq('C205 initialise, 3-byte packets: success', call(0xc205, 0x0300).cf, 0);
  eq('C201 reset: BL=AAh, BH=device 00', (call(0xc201, 0), cpu.bx & 0xffff), 0x00aa);
  eq('C205 with packet size 0 is invalid input', call(0xc205, 0x0000).ah, 0x02);
  call(0xc205, 0x0300);
  // The guest handler at 0200:0000 stores status, X, Y, Z at CS:0300.. and counts its calls.
  mem.blit(0x2000, Uint8Array.from([0x55, 0x89, 0xe5,
    0x8b, 0x46, 0x0c, 0x2e, 0xa3, 0x00, 0x03,  0x8b, 0x46, 0x0a, 0x2e, 0xa3, 0x02, 0x03,
    0x8b, 0x46, 0x08, 0x2e, 0xa3, 0x04, 0x03,  0x8b, 0x46, 0x06, 0x2e, 0xa3, 0x06, 0x03,
    0x2e, 0xff, 0x06, 0x08, 0x03, 0x5d, 0xcb]));
  eq('C207 installs the handler', call(0xc207, 0x0000, 0x0200).cf, 0);
  eq('C200 enable: success once there is one', call(0xc200, 0x0100).cf, 0);
  eq('INT 74h points at the BIOS routine', mc.getVector(0x74).seg * 16 + mc.getVector(0x74).off, 0xfe800);
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mem.blit(0x1000, Uint8Array.from([0xfb, 0xeb, 0xfe]));          // sti ; jmp $
  mc.ps2.motion(10, 0); mc.runSlice(3000);
  eq('a move reaches the guest handler', mem.r16(0x2308), 1);
  eq('...status: bit 3 set, no sign', mem.r16(0x2300), 0x08);
  eq('...X = +10', mem.r16(0x2302), 10);
  eq('...Y = 0 and Z = 0', mem.r16(0x2304) | mem.r16(0x2306), 0);
  mc.ps2.motion(-5, 10); mc.runSlice(3000);                      // left, and DOWN on the screen
  eq('a second move is a second packet', mem.r16(0x2308), 2);
  eq('...with both sign bits (PS/2 Y counts UP)', mem.r16(0x2300), 0x38);
  eq('...X = -5 as a byte', mem.r16(0x2302), 0xfb);
  eq('...Y = -10 as a byte', mem.r16(0x2304), 0xf6);
  mc.ps2.button(0, true); mc.runSlice(3000);
  eq('a button alone sends a packet too', mem.r16(0x2300) & 0x07, 1);
  // The raw 8042 path a driver without the BIOS would use: D4h, then a device command on 60h.
  mc.ioWrite(0x64, 1, 0xd4); mc.ioWrite(0x60, 1, 0xff);
  eq('aux reset: status says OBF and AUX', mc.ioRead(0x64, 1) & 0x21, 0x21);
  eq('...and the mouse answers FA AA 00', [mc.ioRead(0x60, 1), mc.ioRead(0x60, 1), mc.ioRead(0x60, 1)].join(','), '250,170,0');
  eq('...after which the aux channel is empty', mc.ioRead(0x64, 1) & 0x20, 0); }

// ---- INT 16h / INT 1Ah open an INTERRUPT WINDOW, as SeaBIOS's do -----------------------------
// tools/ifprobe.asm under QEMU: with CLI before every call, 65 536 calls to INT 16h AH=01 let 2Ah
// ticks through, and INT 1Ah AH=00 29h — while every call returns IF=0. SvarDOS's EDR-DOS kernel
// (doof-1440.img) waits for "a key or N ticks" that way; here the clock never moved and it waited
// for ever, where Doom now runs. Both timer regimes: cycle-driven (headless) and latched (browser).
{ const run = (latched) => {
    const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
    installBIOS(mc);
    cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
    // cli ; mov ah,1 ; int 16h ; pushf ; hlt
    mem.blit(0x1000, Uint8Array.from([0xfa, 0xb4, 0x01, 0xcd, 0x16, 0x9c, 0xf4]));
    const t0 = mem.r32(0x46c);
    if (latched) { mc.timerAuto = false; cpu.flags &= ~0x200; mc.tickTimer(); }   // a tick arrives with IF=0
    else cpu.cycles = mc.nextTimerCycle + 1;                                       // a tick is due
    let steps = 0; while (!cpu.halted && steps++ < 50) mc.rec.step();
    return { ticks: (mem.r32(0x46c) - t0) >>> 0, ifBack: (mem.r16(0x3000 + cpu.sp) >> 9) & 1, latchedFirst: latched };
  };
  const a = run(false);
  eq('a due tick gets in through INT 16h although the caller has IF=0', a.ticks, 1);
  eq('...and the caller still gets IF=0 back', a.ifBack, 0);
  const b = run(true);
  eq('a tick that arrived while IF=0 is kept, not dropped, and gets in through INT 16h', b.ticks, 1);
  eq('...still handing IF=0 back', b.ifBack, 0); }

// ---- the BIOS timer protects the interrupted program from its INT 1Ch hook --------------------
// tools/i1cprobe.asm: under QEMU a 1Ch hook that zeroes AX..BP and ES without saving them leaves the
// interrupted loop's registers intact; here all eight were lost. "Exploring the IBM PC" stalled on
// it: its hook starts with `xor dx,dx`, and a BLOAD loop kept its destination segment in DX.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  installBIOS(mc);
  mem.blit(0x600, Uint8Array.from([0x31, 0xc0, 0x31, 0xd2, 0x31, 0xdb, 0x8e, 0xc0,     // xor ax,ax/dx,dx/bx,bx ; mov es,ax
    0x2e, 0xff, 0x06, 0x00, 0x07, 0xcf]));                                          // inc word cs:[0700] ; iret
  mc.setVector(0x1c, 0x0000, 0x0600);
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(ES, 0x0880);
  mem.blit(0x1000, Uint8Array.from([0xfb, 0xeb, 0xfe]));                            // sti ; jmp $
  cpu.reg[0] = 0x1111; cpu.reg[2] = 0x4444; cpu.reg[3] = 0x2222;
  mc.runSlice(4); mc.timerAuto = false; mc.tickTimer(); mc.runSlice(200);
  eq('the INT 1Ch hook ran once', mem.r16(0x700), 1);
  eq('...and the interrupted program still has its AX', cpu.reg[0] & 0xffff, 0x1111);
  eq('...its DX', cpu.reg[2] & 0xffff, 0x4444);
  eq('...its BX', cpu.reg[3] & 0xffff, 0x2222);
  eq('...and its ES', cpu.seg[ES], 0x0880);
  eq('...running where it was', (cpu.seg[CS] << 16 | cpu.eip) >>> 0, 0x01000001); }

// ---- a guest INT 8 that CHAINS to the BIOS still gets INT 1Ch called -------------------------
// The TSR idiom: hook INT 8, count, `jmp far [old8]`. tools/i8chain.asm under QEMU: 20 INT 8, 20
// INT 1Ch, 20 ticks. MIRAGE's F000:0008, reached that way, advanced the tick and never called 1Ch.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  installBIOS(mc);
  const old8 = mc.getVector(8);
  mem.w16(0x710, old8.off); mem.w16(0x712, old8.seg);
  mem.blit(0x600, Uint8Array.from([0x2e, 0xff, 0x06, 0x00, 0x07, 0x2e, 0xff, 0x2e, 0x10, 0x07]));  // inc cs:[700] ; jmp far cs:[710]
  mem.blit(0x620, Uint8Array.from([0x2e, 0xff, 0x06, 0x02, 0x07, 0xcf]));                       // inc cs:[702] ; iret
  mc.setVector(8, 0, 0x600); mc.setVector(0x1c, 0, 0x620);
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mem.blit(0x1000, Uint8Array.from([0xfb, 0xeb, 0xfe]));                                         // sti ; jmp $
  mc.timerAuto = false; mc.runSlice(4);
  const t0 = mem.r32(0x46c);
  for (let k = 0; k < 3; k++) { mc.tickTimer(); mc.runSlice(300); }
  eq('three ticks reach the guest INT 8', mem.r16(0x700), 3);
  eq('...which chains to the BIOS, and the BIOS calls INT 1Ch each time', mem.r16(0x702), 3);
  eq('...and advances the BIOS tick each time', (mem.r32(0x46c) - t0) >>> 0, 3);
  eq('...and the program is back where it was', (cpu.seg[CS] << 16 | cpu.eip) >>> 0, 0x01000001);
  eq('...with its stack balanced', cpu.sp, 0x1000); }

// ---- hardware IRQs in protected and V86 mode go through the IDT; the BIOS INT 9 reads port 60h ---
// MS-DOS 6.22 under EMM386 (V86): typing VER got one key in, then nothing. Two defects. IRQ1 had no
// protected-mode path at all (always the real-mode vector, behind the monitor's back), and IRQ0 was
// kept out of the IDT in V86. And our BIOS INT 9, reached at the end of DOS's chain, sent the EOI
// but never READ port 0x60 — so the 8042's output buffer stayed full and no second scancode could
// be staged. With both fixed, `ver` answers "MS-DOS Version 6.22".
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  mc.kb.obf = true; mc.kb.data = 0x2f;
  mc.intHandlers[9](mc.cpu, mc);
  eq('the BIOS INT 9 empties the 8042 output buffer', mc.kb.obf, false); }
{ const irq = (vm, n) => {
    const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
    cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
    cpu.cr0 |= 1; if (vm) cpu.flags |= 0x20000; cpu.flags |= 0x200;
    cpu.idtr = { base: 0xa000, limit: 0x7ff };
    mem.w16(0xa000 + n * 8 + 2, 0x08); mem.w8(0xa000 + n * 8 + 5, 0x8e);   // a present gate
    let got = null; mc.protInt = (v) => { got = v; };
    if (n === 9) { mc.kb.data = 0x1e; mc.kb.obf = true; mc.raiseKeyboardIRQ(); }
    else { mc.timerAuto = false; mc.tickTimer(); }
    return got;
  };
  eq('IRQ1 in protected mode goes through the IDT', irq(false, 9), 9);
  eq('IRQ1 in V86 goes through the IDT (to the monitor)', irq(true, 9), 9);
  eq('IRQ0 in V86 goes through the IDT (to the monitor)', irq(true, 8), 8); }

// ---- INT 10h in graphics modes: AH=00h clears CGA pixels, AH=06h fills mode 13h, AH=13h uses BL ----
// Three defects found by pixel-comparing v86's boot-sector demos against QEMU: hello-v86.img went
// from 63 115 differing pixels to 0, bootlogo.img from 6 000 to 3 (its blinking cursor).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const int10 = (ax, bx = 0, cx = 0, dx = 0) => { cpu.ax = ax; cpu.bx = bx; cpu.cx = cx; cpu.dx = dx; mc.intHandlers[0x10](cpu, mc); };
  for (let i = 0; i < 0x4000; i++) mem.u8[0xb8000 + i] = 0x77;
  int10(0x0004);
  eq('a mode 4 set clears the CGA pixels to ZERO (not text blanks)', mem.u8[0xb8000] | mem.u8[0xb8001] | mem.u8[0xbbfff], 0);
  mem.u8[0xb8000] = 0x55;
  int10(0x0084);
  eq('...and AL bit 7 keeps them, read from the CALLER\'s AL', mem.u8[0xb8000], 0x55);
  int10(0x0013);
  int10(0x0600, 0x4f00, 0x0000, 0x184f);                     // clear the whole screen with colour 4Fh
  eq('AH=06h in mode 13h fills the window with the colour in BH', mem.u8[0xa0000], 0x4f);
  eq('...down to the last pixel of the 40x25 window', mem.u8[0xa0000 + 199 * 320 + 319], 0x4f);
  // AH=13h, characters only (AL bit 1 clear): the attribute is BL. Cursor kept (AL bit 0 clear).
  mc.font8x8 = new Uint8Array(256 * 8).fill(0xff);           // a bare Machine has no font loaded
  mc.font = new Uint8Array(256 * 16).fill(0xff);
  mem.blit(0x2000, Uint8Array.from([0x41]));
  cpu.setSeg(ES, 0x200); cpu.bp = 0;
  mem.w8(0x450, 3); mem.w8(0x451, 2);                        // cursor at col 3, row 2
  int10(0x1300, 0x000f, 1, 0x0000);                          // one 'A' at 0,0 in colour 0Fh
  let fg = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (mem.u8[0xa0000 + y * 320 + x] === 0x0f) fg++;
  eq('AH=13h draws in the colour BL gives', fg > 0, true);
  eq('...and with AL bit 0 clear the cursor stays where it was', mem.r16(0x450), 0x0203); }

// ---- 320x200x4 coloured through the attribute registers and the DAC, as on a VGA ----------------
// The renderer took the colours from the 3D9h value and DAC 8-15 — which the 'cga' DAC fills with the
// DARK hues, so the BIOS's default palette (bright cyan/magenta/white) came out dark, and a program
// that reprograms the registers or the DAC was not seen at all. GentleOS reads registers 0 and 3
// with AX=1007h (unimplemented: BH stayed 0) and sets the two DAC entries behind them.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const int10 = (ax, bx = 0, cx = 0, dx = 0) => { cpu.ax = ax; cpu.bx = bx; cpu.cx = cx; cpu.dx = dx; mc.intHandlers[0x10](cpu, mc); };
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const video = new Video(mc, canvas);
  const px = (v) => { mem.u8[0xb8000] = v << 6; video._palette(); video._renderCGA(4); return video.u32[0]; };
  const dacRGB = (i) => video.pal[i];
  int10(0x0004);
  eq('mode 4: the four colours are attribute registers 0-3', Array.from(mc.vga.palette.slice(0, 4)).map((v) => v.toString(16)).join(), '0,13,15,17');
  eq('...rendered through the DAC: pixel 3 is DAC 17h (bright white), not DAC 0Fh', px(3), dacRGB(0x17));
  int10(0x0b00, 0x0001); int10(0x0b00, 0x0100);          // background blue, low intensity; palette 0
  eq('AH=0Bh: background -> reg 0, intensity -> bit 4, palette 0 -> bit 0 of regs 1-3', Array.from(mc.vga.palette.slice(0, 4)).map((v) => v.toString(16)).join(), '1,2,4,6');
  mc.ioWrite(0x3d9, 1, 0x3e);                            // background 14 (yellow), intensity, palette 1
  eq('port 3D9h writes the same registers (bit 3 of the background moves to 10h)', Array.from(mc.vga.palette.slice(0, 4)).map((v) => v.toString(16)).join(), '16,13,15,17');
  int10(0x1007, 0x0003);
  eq('AX=1007h reads a palette register into BH', (cpu.bx >> 8) & 0xff, 0x17);
  int10(0x1010, 0x0017, 0x2814, 0x1900);                 // DAC 17h := 19h,28h,14h
  eq('...and the DAC entry behind it is what pixel 3 shows', px(3), dacRGB(0x17));
  int10(0x1015, 0x0017);
  eq('AX=1015h reads a DAC register back into DH CH CL', [(cpu.dx >> 8) & 0xff, cpu.cx].map((v) => v.toString(16)).join(), '19,2814'); }

// ---- A real VGA BIOS ROM as INT 10h (src/vgarom.js), and register-derived window routing -------
// A ROM only writes registers, so the A000 routing has to follow them as on the card: planar when
// the GC is in graphics mode (GC6 bit 0) and the Sequencer does not chain (SEQ4 bit 3). With the
// Cirrus CL-GD5446 ROM, tools/int10gfx.asm then prints the same lines as QEMU with that ROM, but for
// the two Cirrus extensions (8-bit GR index, 800x600 clock).
{ const { installVgaRom } = await import('../src/vgarom.js');
  const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  // A 512-byte option ROM whose init points INT 10h at C000:0020 and returns: `xor ax,ax; mov ds,ax;
  // mov word [40h],20h; mov word [42h],0C000h; retf`, and an IRET at 0020h.
  const rom = new Uint8Array(512); rom.set([0x55, 0xaa, 1]);
  rom.set([0x31, 0xc0, 0x8e, 0xd8, 0xc7, 0x06, 0x40, 0x00, 0x20, 0x00, 0xc7, 0x06, 0x42, 0x00, 0x00, 0xc0, 0xcb], 3);
  rom[0x20] = 0xcf;
  const r = installVgaRom(mc, rom);
  eq('installVgaRom runs the init by a far call and the ROM takes INT 10h', `${r.vector.seg.toString(16)}:${r.vector.off.toString(16)}`, 'c000:20');
  eq('...and switches the VGA to register-derived routing', mc.vga.hw, true);
  mc.ioWrite(0x3ce, 1, 6); mc.ioWrite(0x3cf, 1, 0x05);                 // GC6: graphics, A000 64K
  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, 0x06);                 // SEQ4: chain-4 off
  eq('graphics + no chain-4 routes A000 through the planes', mc.mem.planar, true);
  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, 0x0e);                 // chain-4 on: mode 13h's
  eq('...chain-4 makes it plain RAM again', mc.mem.planar, false);
  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, 0x06); mc.ioWrite(0x3ce, 1, 6); mc.ioWrite(0x3cf, 1, 0x0e);
  eq('...and so does text mode (GC6 bit 0 clear, B800)', mc.mem.planar, false); }

// ---- src/ must load in a browser: every process.env read is guarded -----------------------------
// There is no `process` in a browser. rtc.js and dos.js read process.env bare, the page stopped on
// "Loading…" for two weeks, and every other gate runs under Node, where it exists. A read counts as
// guarded when `typeof process` is on its line or the line before (the statement's start).
{ const { readdirSync, readFileSync } = await import('fs');
  const dir = new URL('../src/', import.meta.url), bare = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const lines = readFileSync(new URL(f, dir), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!l.includes('process.env') || /^\s*(\/\/|\*)/.test(l)) return;
      if (!l.includes('typeof process') && !(i > 0 && lines[i - 1].includes('typeof process'))) bare.push(`${f}:${i + 1}`);
    });
  }
  eq('every process.env read in src/ is guarded by typeof process', bare.join(' '), ''); }

// ---- The renderer follows the card (H7) ---------------------------------------------------------
// Text colours go attribute nibble -> AC palette -> DAC. They indexed the DAC directly: after
// AX=0003h (DAC = the 64-colour EGA table) colour 6 was dark yellow, not brown, and 8-15 wrong.
// With a real VGA ROM as INT 10h (vga.hw), rows/columns, blink, cursor and the planar size come from
// the BDA and the registers, since no setMode or bios.cursor is maintained by it.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const video = new Video(mc, canvas); video.font = new Uint8Array(4096); mc.font = video.font;
  for (let i = 0; i < 16; i++) video.font[0xdb * 16 + i] = 0xff;           // a full block, to see the ink
  cpu.ax = 0x0003; mc.intHandlers[0x10](cpu, mc);
  const cell = (ch, attr) => { mem.w16(0xb8000, ch | (attr << 8)); video.frame = 0; video.render(); return video.u32[0]; };
  eq('text: background 6 is AC 6 = 14h -> DAC 14h (brown), not DAC 6', cell(0x20, 0x60), video.pal[0x14]);
  eq('text: ink 8 is AC 8 = 38h -> DAC 38h (dark grey)', cell(0xdb, 0x08), video.pal[0x38]);
  cpu.ax = 0x0100; cpu.cx = 0x0e10; mc.intHandlers[0x10](cpu, mc);
  eq('AH=01h keeps the cursor type in the BDA (0460h end, 0461h start)', [mem.r8(0x460), mem.r8(0x461)].join(), '16,14');
  // hw: 40 columns as a ROM's mode 1 leaves them (CRTC 01h = 27h, BDA 40), cursor from CRTC 0Eh/0Fh,
  // shape from 0Ah/0Bh.
  mc.vga.hw = true; mem.w16(0x44a, 40); mem.w8(0x484, 24); mc.vga.crtc[0x01] = 0x27;
  mc.vga.crtc[0x0e] = 0; mc.vga.crtc[0x0f] = 41; mc.vga.crtc[0x0a] = 0x0e; mc.vga.crtc[0x0b] = 0x0f;
  for (let i = 0; i < 80; i++) mem.w16(0xb8000 + i * 2, 0x0720);
  video.frame = 16; video.render();
  eq('hw text: the width comes from the CRTC (40 columns)', video.imgW, 320);
  eq('...and the cursor from CRTC 0Eh/0Fh: row 1, column 1, scanline 14', video.u32[(16 + 14) * 320 + 8], video.pal[7]);
  // hw planar: 640x480 from the CRTC programming mode 12h (display end 4Fh, VDE 1DFh).
  const c = mc.vga.crtc; c[0x01] = 0x4f; c[0x12] = 0xdf; c[0x07] = 0x3e; c[0x09] = 0x40;
  eq('hw planar: size from the CRTC', JSON.stringify(mc.vga.crtcDims?.()), '{"w":640,"h":480}');
  c[0x01] = 0x27; c[0x12] = 0x8f; c[0x07] = 0x1f; c[0x09] = 0xc0;          // mode 0Dh: 40 clocks, doubled 400 lines
  eq('...320x200 when the CRTC doubles every line', JSON.stringify(mc.vga.crtcDims?.()), '{"w":320,"h":200}'); }

// ---- Text geometry is the card's, not the BDA's (386BSD) -------------------------------------------
// 386BSD's kernel zeroes physical page 0 and its pccons writes only the cursor registers: the
// renderer took rows from 0040:0084 (now 0) and drew ONE row of the console, while QEMU (whose BDA
// reads mode 0 too) draws the CRTC's 80x25. Our POST loads no CRTC, so a zeroed BDA under an
// unloaded CRTC is 80x25 too; once the CRTC is loaded, its geometry wins over the BDA.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const video = new Video(mc, canvas); video.font = new Uint8Array(4096);
  for (let a = 0x400; a < 0x500; a++) mem.w8(a, 0);                        // the kernel's page 0
  video.frame = 0; video.render();
  eq('text with a zeroed BDA and no CRTC loaded: 80x25', `${video.imgW}x${video.imgH}`, '640x400');
  cpu.ax = 0x0003; mc.intHandlers[0x10](cpu, mc);                         // loads the mode-3 CRTC
  for (let a = 0x400; a < 0x500; a++) mem.w8(a, 0);
  video.render();
  eq('...with the mode-3 CRTC loaded: 80x25 from it', `${video.imgW}x${video.imgH}`, '640x400');
  mc.vga.crtc[0x09] = 0x47;                                                // 8-line cells: 50 rows
  video.render();
  eq('...and rows follow CRTC 09h, not the BDA', video.imgH / 16, 50); }
// A VGA BIOS's POST leaves the card in mode 3: the CRTC holds that geometry at power-on, before any
// INT 10h mode set (src/vga.js installVGA). 386BSD takes the console from that state.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const c = mc.vga.crtc;
  eq('power-on CRTC: mode 3 (01h=4Fh, 09h=4Fh, 12h=8Fh, 13h=28h)', [c[0x01], c[0x09], c[0x12], c[0x13]].map((v) => v.toString(16)).join(','), '4f,4f,8f,28'); }

// ---- INT 10h AX=1121h-1124h: graphics fonts set the BDA rows and height; AX=1130h reports them ---
// They were no-ops, and AX=1130h answered the REQUESTED font's height. QEMU/SeaBIOS, DOSBox-X and
// the vendor Cirrus ROM agree on every value below (tools/int10gfx.asm T11).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  mc.font = new Uint8Array(256 * 16).fill(0xff); mc.font8x8 = new Uint8Array(256 * 8).fill(0xff); mc.font8x14 = new Uint8Array(256 * 14).fill(0xff);
  const int10 = (ax, bx = 0, cx = 0, dx = 0) => { cpu.ax = ax; cpu.bx = bx; cpu.cx = cx; cpu.dx = dx; mc.intHandlers[0x10](cpu, mc); };
  const row = (mode, ax, bx, dx) => { int10(mode); int10(ax, bx, 0, dx);
    const bda = [mem.r8(0x484), mem.r8(0x485)]; int10(0x1130, 0x0000); return [...bda, cpu.cx & 0xff, cpu.dx & 0xff].map((v) => v.toString(16)).join('/'); };
  eq('12h + 1124h BL=3: 43 rows of 16', row(0x12, 0x1124, 3, 0), '2a/10/10/2a');
  eq('12h + 1123h BL=2: 25 rows of 8', row(0x12, 0x1123, 2, 0), '18/8/8/18');
  eq('12h + 1122h BL=0 DL=30: 30 rows of 14', row(0x12, 0x1122, 0, 30), '1d/e/e/1d');
  eq('6Ah + 1124h BL=3 (stillalive-os)', row(0x6a, 0x1124, 3, 0), '2a/10/10/2a');
  // 1121h: the program's own font at ES:BP, CX bytes a character; the glyph comes from it.
  int10(0x0012); cpu.setSeg(ES, 0x0200); cpu.bp = 0; for (let i = 0; i < 256 * 8; i++) mem.u8[0x2000 + i] = 0;
  mem.u8[0x2000 + 0x41 * 8 + 3] = 0x81;                               // 'A', scanline 3 only
  int10(0x1121, 0x0002, 8, 0);
  eq('1121h: user font height and INT 43h vector', [mem.r8(0x485), mc.getVector(0x43).seg.toString(16), mc.getVector(0x43).off].join(), '8,200,0');
  mem.w8(0x450, 0); mem.w8(0x451, 0);
  int10(0x0e41, 0x000f);
  const P = 0x10000, pl = mc.vga.planes;
  eq('...and teletype draws from it: scanline 3 of cell 0 is 81h, the rest empty', [pl[3 * 80], pl[2 * 80], pl[4 * 80]].join(), '129,0,0'); }

// ---- INT 10h in planar modes: mode 6Ah, glyphs into the planes, SeaBIOS's register side effect ----
// v86's stillalive-os.img sets mode 6Ah (800x600x16) and prints with AH=0Eh; QEMU shows the lyrics,
// we stayed in text mode. It then clears its lyrics panel with bare stores through A000, relying on
// the teletype in between to have left the map mask at 0Fh (SeaBIOS's stdvga_planar4_plane(-1)).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const int10 = (ax, bx = 0, cx = 0, dx = 0) => { cpu.ax = ax; cpu.bx = bx; cpu.cx = cx; cpu.dx = dx; mc.intHandlers[0x10](cpu, mc); };
  mc.font = new Uint8Array(256 * 16).fill(0xff); mc.font8x8 = new Uint8Array(256 * 8).fill(0xff);
  int10(0x006a);
  eq('mode 6Ah is an 800x600 planar mode', [mc.vga.width, mc.vga.height, mem.planar].join(), '800,600,true');
  // AL: the Cirrus CL-GD5446 ROM and DOSBox-X return it unchanged, SeaVGABIOS 20h/30h (int10gfx T10).
  const als = [0x03, 0x06, 0x12, 0x13, 0x6a, 0x84].map((m) => { int10(m); return cpu.al.toString(16); }).join();
  eq('...and AH=00h leaves the caller\'s AL alone, bit 7 included', als, '3,6,12,13,6a,84');
  int10(0x006a);
  eq('...100 text columns in the BDA, 100 bytes per scanline', [mem.r16(0x44a), mc.vga.rowBytes()].join(), '100,100');
  // rows-1 / character height: SeaBIOS and DOSBox-X agree on every mode (tools/int10gfx.asm T7, T9).
  eq('...37 rows of 16-line cells in the BDA', [mem.r8(0x484), mem.r16(0x485)].join(), '36,16');
  int10(0x0012); const g12 = [mem.r8(0x484), mem.r16(0x485)].join();
  int10(0x0013); const g13 = [mem.r8(0x484), mem.r16(0x485)].join();
  int10(0x006a);
  eq('...mode 12h 30 rows of 16, mode 13h 25 rows of 8', `${g12} ${g13}`, '29,16 24,8');
  const P = 0x10000, pl = mc.vga.planes;
  mc.vga.mapMask = 0x02; mc.vga.gc[4] = 1;                   // what the program's own drawing leaves
  mem.w8(0x450, 5); mem.w8(0x451, 0);
  int10(0x0e41, 0x0006);                                     // 'A' in colour 6 (planes 1 and 2), no wrap
  eq('AH=0Eh draws the glyph in the planes of the colour in BL', [pl[5], pl[P + 5], pl[2 * P + 5], pl[3 * P + 5]].join(), '0,255,255,0');
  // Map mask 0Fh on all three BIOSes; the read map stays the program's on Cirrus and DOSBox-X (int10gfx T5).
  eq('...and leaves map mask 0Fh, the read map it found, GC index 01h', [mc.vga.mapMask, mc.vga.gc[4], mc.vga.gcIndex].join(), '15,1,1');
  mem.w8(0x450, 99); mem.w8(0x451, 36);                      // last cell of the 100x37 screen
  int10(0x0e41, 0x0006);
  const off = 35 * 16 * 100 + 99;                            // row 35: the wrap scrolled it up a row
  eq('...scrolling the full 37-row screen up a text row', [mem.r8(0x450), mem.r8(0x451), pl[P + off], pl[P + off + 1600]].join(), '0,36,255,0');
  mc.vga.mapMask = 0x01; mc.vga.gc[4] = 2;
  int10(0x0600, 0x0000, 0x0000, 0x2463);
  eq('AH=06h in a planar mode clears the pixels', pl[P + off] | pl[2 * P + off], 0);
  eq('...leaving map mask 0Fh and the read map it found (int10gfx T8)', [mc.vga.mapMask, mc.vga.gc[4]].join(), '15,2'); }

// ---- INT 15h AX=E820h: the system address map --------------------------------------------------
// KolibriOS reads it and, finding nothing, probed memory itself and never finished. Walk it the way
// a loader does: EBX=0, then whatever EBX comes back, until it is 0 again.
{ const mc = new Machine({ memSize: 16 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  installBIOS(mc);
  cpu.setSeg(ES, 0x0100); const ranges = []; let ebx = 0, n = 0;
  do {
    cpu.reg[0] = 0xe820; cpu.reg[2] = 0x534d4150; cpu.reg[1] = 20; cpu.reg[3] = ebx; cpu.di = 0; cpu.flags |= 1;
    mc.intHandlers[0x15](cpu, mc);
    if (cpu.flags & 1) { ranges.push('CF'); break; }
    ranges.push(`${mem.r32(0x1000).toString(16)}+${mem.r32(0x1008).toString(16)}:${mem.r32(0x1010)}`);
    ebx = cpu.reg[3] >>> 0;
  } while (ebx && ++n < 10);
  eq('AX=E820h returns SMAP in EAX', cpu.reg[0] >>> 0, 0x534d4150);
  eq('...a map with the VBE framebuffer reserved near the top, the RAM above it usable', ranges.join(' '),
    `0+a0000:1 f0000+10000:2 100000+${(mc.vbeFbBase - 0x100000).toString(16)}:1 ${mc.vbeFbBase.toString(16)}+400000:2`);
  // 4 MiB-aligned like a real aperture: KolibriOS maps it with a 4 MiB page once CPUID says PSE, and
  // at 14 MiB (unaligned) it drew 2 MiB below the screen.
  eq('...and the framebuffer starts on a 4 MiB boundary', (mc.vbeFbBase & 0x3fffff).toString(16), '0'); }

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

// ---- CMOS configuration bytes ------------------------------------------------------------------
// PC-MOS/386 reads 10h (diskette types) before it has a boot sector; with the zeros we held it
// assumed no drive and addressed every sector with a default geometry. tools/cmosdump.asm on QEMU
// and DOSBox-X: 10h types, 14h equipment (drives, x87, bit 2), 15h/16h 640 KB, 17h/18h = 30h/31h
// extended KB.
{ const mc = new Machine({ memSize: 16 << 20 });
  installBIOS(mc);
  const cmos = (reg) => { mc.portWrite[0x70](0x70, 1, reg); return mc.portRead[0x71](0x71, 1) & 0xff; };
  // Drive A is fitted with no diskette in it (QEMU's default, DOSBox-X, our equipment word): with
  // 10h = 0 Windows 98's HSFLOP.PDR overwrote IVT[1Ah] and the boot ended in a protection error.
  eq('CMOS 10h/14h with no diskette: an empty 1.44 MB drive A, as the equipment word says', [cmos(0x10), cmos(0x14)].join(), '64,7');
  mc.disk.attach(0x00, new Uint8Array(1474560));
  eq('CMOS 10h: drive A is a 1.44 MB diskette, B absent', cmos(0x10), 0x40);
  eq('CMOS 14h: one diskette drive, x87, bit 2, EGA/VGA', cmos(0x14), 0x07);
  eq('CMOS 15h/16h: 640 KB base memory', cmos(0x15) | (cmos(0x16) << 8), 640);
  eq('CMOS 17h/18h and 30h/31h: extended memory in KB', [cmos(0x17) | (cmos(0x18) << 8), cmos(0x30) | (cmos(0x31) << 8)].join(), '15360,15360');
  eq('CMOS 12h: no hard disk', cmos(0x12), 0);
  mc.disk.attach(0x80, new Uint8Array(512 * 63 * 16), { cyl: 1, heads: 16, spt: 63 });
  eq('...and with one, type 15 in 12h pointing at user type 47 in 19h', [cmos(0x12), cmos(0x19)].join(), '240,47');
  mc.portWrite[0x70](0x70, 1, 0x10); mc.portWrite[0x71](0x71, 1, 0x24);
  eq('a guest\'s own write to a configuration byte reads back', cmos(0x10), 0x24); }

// ---- The primary IDE channel (src/ide.js): what Linux 2.2 needs to mount /dev/hda1 ---------------
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const inb = (p) => (mc.portRead[p] ? mc.portRead[p](p, 1) & 0xff : 0xff), inw = (p) => (mc.portRead[p] ? mc.portRead[p](p, 2) & 0xffff : 0xffff), outb = (p, v) => { if (mc.portWrite[p]) mc.portWrite[p](p, 1, v); };
  eq('no hard disk: the IDE registers float at FFh, as before the device existed', [inb(0x1f7), inb(0x1f1), inb(0x3f6)].join(), '255,255,255');
  const img = new Uint8Array(4 * 16 * 63 * 512); for (let i = 0; i < img.length; i++) img[i] = (i * 7 + (i >> 9)) & 0xff;
  mc.disk.attach(0x80, img, { cyl: 4, heads: 16, spt: 63, type: 3 });
  const fdpt = mc.getVector(0x41), t = ((fdpt.seg << 4) + fdpt.off) & 0xfffff;
  eq('INT 41h points at a Fixed Disk Parameter Table: cylinders, heads, sectors', [mc.mem.r16(t), mc.mem.r8(t + 2), mc.mem.r8(t + 14)].join(), '4,16,63');
  outb(0x1f6, 0xa0); outb(0x1f7, 0xec);                                        // IDENTIFY
  eq('IDENTIFY: DRQ set and IRQ 14 raised', [inb(0x3f6) & 0x08, (mc.irqPendingMask >> 14) & 1].join(), '8,1');
  const id = []; for (let i = 0; i < 256; i++) id.push(inw(0x1f0));
  eq('...256 words: CHS 4/16/63, LBA capacity, "MIRAGE ATA DISK"', [id[1], id[3], id[6], id[60] | (id[61] << 16),
    String.fromCharCode(...id.slice(27, 34).flatMap((w) => [w >> 8, w & 0xff]))].join(), `4,16,63,${4 * 16 * 63},MIRAGE ATA DIS`);
  eq('...and DRQ drops once the buffer is read', inb(0x1f7) & 0x08, 0);
  outb(0x1f2, 2); outb(0x1f3, 5); outb(0x1f4, 0); outb(0x1f5, 0); outb(0x1f6, 0xe0); outb(0x1f7, 0x20);   // READ 2 sectors at LBA 5
  const rd = []; for (let k = 0; k < 512; k++) { const w = inw(0x1f0); rd.push(w & 0xff, w >> 8); }
  eq('READ SECTORS (LBA): the image bytes, sector by sector', rd.every((b, i) => b === img[5 * 512 + i]), true);
  outb(0x1f2, 1); outb(0x1f3, 9); outb(0x1f6, 0xe0); outb(0x1f7, 0x30);        // WRITE 1 sector at LBA 9
  for (let k = 0; k < 256; k++) if (mc.portWrite[0x1f0]) mc.portWrite[0x1f0](0x1f0, 2, 0xa55a);
  eq('WRITE SECTORS lands in the image', [img[9 * 512], img[9 * 512 + 1], img[9 * 512 + 511]].join(), '90,165,165');
  outb(0x1f6, 0xb0); outb(0x1f7, 0xec);                                        // IDENTIFY to the absent slave
  eq('the absent slave reads status 00h', inb(0x1f7), 0);
  outb(0x1f6, 0xa0);
  eq('...and the master keeps its own status (a slave probe cleared it: "drive not ready")', inb(0x1f7) & 0x40, 0x40); }
// A BIOS geometry ATA cannot express (Windows 2000's v86 image is partitioned with 128 heads): the
// drive reports and translates 16 heads, 63 sectors, as QEMU's and a real drive do. atapi.sys
// addresses by CHS with the heads IDENTIFY gives; with 128 it wrote head 72 as A0h|48h (the LBA bit),
// head 80 as F0h (the slave), and the read never completed: the boot screen for ever.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const inb = (p) => mc.portRead[p](p, 1) & 0xff, inw = (p) => mc.portRead[p](p, 2) & 0xffff, outb = (p, v) => mc.portWrite[p](p, 1, v);
  const img = new Uint8Array(2 * 128 * 63 * 512); for (let i = 0; i < img.length; i++) img[i] = (i >> 9) & 0xff ^ (i & 0x1ff);
  mc.disk.attach(0x80, img, { cyl: 2, heads: 128, spt: 63, type: 3 });
  outb(0x1f6, 0xa0); outb(0x1f7, 0xec);
  const id = []; for (let i = 0; i < 256; i++) id.push(inw(0x1f0));
  eq('IDENTIFY with a 128-head BIOS geometry: 16 heads, 63 sectors, the cylinders that fill the disk (words 1/3/6, 54-56)',
    [id[1], id[3], id[6], id[54], id[55], id[56]].join(), '16,16,63,16,16,63');
  outb(0x1f2, 1); outb(0x1f3, 7); outb(0x1f4, 3); outb(0x1f5, 0); outb(0x1f6, 0xa5); outb(0x1f7, 0x20);   // CHS 3/5/7
  const lba = (3 * 16 + 5) * 63 + 6, rd = []; for (let k = 0; k < 256; k++) { const w = inw(0x1f0); rd.push(w & 0xff, w >> 8); }
  eq('...and READ SECTORS by CHS translates with those 16 heads', rd.every((b, i) => b === img[lba * 512 + i]), true); }

// ---- INT 13h extensions (EDD), BDA 0475h, CMOS type-47 parameters ------------------------------
// Windows 95/98 (FAT32 boot sector) and NetBSD's bootstrap read by LBA through AH=42h: "Disk I/O error",
// "/boot load failed". NetBSD took drive 80h for a CD because BDA 0475h said 0 hard disks; 386BSD reads
// the user-type geometry QEMU keeps in CMOS 1Bh-23h.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  const img = new Uint8Array(20 * 16 * 63 * 512); for (let i = 0; i < img.length; i++) img[i] = (i >> 9) & 0xff;
  mc.disk.attach(0x80, img, { cyl: 20, heads: 16, spt: 63, type: 3 });
  const i13 = (ax, extra) => { cpu.ax = ax; cpu.dx = 0x0080; extra(); mc.intHandlers[0x13](cpu, mc); };
  i13(0x4100, () => { cpu.bx = 0x55aa; });
  eq('AH=41h: EDD present, BX=AA55h, version 30h, fixed-disk access + EDD', [(cpu.bx & 0xffff).toString(16), (cpu.ax >> 8).toString(16), cpu.cx & 0xffff, cpu.flags & 1].join(), 'aa55,30,5,0');
  // Disk address packet at 0000:0600: 16 bytes, 2 sectors, buffer 0000:2000, LBA 7.
  mem.w8(0x600, 0x10); mem.w8(0x601, 0); mem.w16(0x602, 2); mem.w16(0x604, 0x2000); mem.w16(0x606, 0); mem.w32(0x608, 7); mem.w32(0x60c, 0);
  i13(0x4200, () => { cpu.setSeg(DS, 0); cpu.si = 0x600; });
  eq('AH=42h: extended read of LBA 7-8 into the buffer', [cpu.flags & 1, mem.u8[0x2000], mem.u8[0x2000 + 512], mem.u8[0x2000 + 1023]].join(), '0,7,8,8');
  mem.w16(0x700, 0x1e);
  i13(0x4800, () => { cpu.setSeg(DS, 0); cpu.si = 0x700; });
  eq('AH=48h: CHS 20/16/63, total sectors, 512-byte sectors', [mem.r32(0x704), mem.r32(0x708), mem.r32(0x70c), mem.r32(0x710), mem.r16(0x718)].join(), `20,16,63,${20 * 16 * 63},512`);
  eq('BDA 0475h counts the attached hard disks', mem.r8(0x475), 1);
  const cmos = (reg) => { mc.portWrite[0x70](0x70, 1, reg); return mc.portRead[0x71](0x71, 1) & 0xff; };
  eq('CMOS 1Bh-23h: the type-47 parameters (cyl 20, heads 16, sectors 63)', [cmos(0x1b) | (cmos(0x1c) << 8), cmos(0x1d), cmos(0x23)].join(), '20,16,63'); }

// ---- The CPU profile: MIRAGE_CPU, EFLAGS.AC on a 486+, the Intel-identity 'pentium' -------------
// MIRAGE_CPU was documented and read nowhere; and AC (bit 18) could not be toggled, so NetBSD and Linux
// classed our 586 as a 386 (NetBSD then panicked, "no appropriate CPU class available").
{ const was = process.env.MIRAGE_CPU; process.env.MIRAGE_CPU = '586';
  const viaEnv = new Machine({ memSize: 1 << 20 }).cpu.profile.name;
  if (was === undefined) delete process.env.MIRAGE_CPU; else process.env.MIRAGE_CPU = was;
  eq('MIRAGE_CPU selects the profile when none is passed', viaEnv, '586');
  const toggle = (prof, code) => { const mc = new Machine({ memSize: 1 << 20, cpu: prof }); const cpu = mc.cpu;
    cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0x200); cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
    mc.mem.blit(0x1000, Uint8Array.from(code)); let n = 0; while (!cpu.halted && n++ < 1000) mc.rec.step(); return cpu; };
  // pushfd; pop eax; or eax,40000h; push eax; popfd; pushfd; pop eax; hlt
  const acSeq = [0x66, 0x9c, 0x66, 0x58, 0x66, 0x0d, 0x00, 0x00, 0x04, 0x00, 0x66, 0x50, 0x66, 0x9d, 0x66, 0x9c, 0x66, 0x58, 0xf4];
  eq('EFLAGS.AC toggles on the 586 profile (a 486+ has it)...', (toggle('586', acSeq).reg[0] >>> 18) & 1, 1);
  eq('...and stays 0 on the 386', (toggle('386', acSeq).reg[0] >>> 18) & 1, 0);
  // Set AC with popfd, then a 16-bit pushf/popf pair: the high word must survive.
  const keep = toggle('586', [0x66, 0x68, 0x02, 0x00, 0x24, 0x00, 0x66, 0x9d, 0x9c, 0x9d, 0x66, 0x9c, 0x66, 0x58, 0xf4]);   // push 240002h; popfd; pushf; popf; pushfd; pop eax
  eq('a 16-bit POPF keeps AC and ID (it owns only the low word)', ((keep.reg[0] >>> 0) & 0x240000).toString(16), '240000');
  let pent;
  try { const p = new Machine({ memSize: 1 << 20, cpu: 'pentium' }).cpu; p.reg[0] = 0; p.cpuid();
    const vend = String.fromCharCode(...[p.reg[3], p.reg[2], p.reg[1]].flatMap((w) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24]));
    p.reg[0] = 1; p.cpuid(); pent = [vend, (p.reg[0] >>> 0).toString(16), p.reg[2]].join();
  } catch (e) { pent = String(e.message).slice(0, 40); }
  eq("the 'pentium' profile says GenuineIntel, family 5 model 2, features FPU+PSE+TSC+CX8 only", pent, 'GenuineIntel,520,281'); }

// ---- CR4.PSE: a page-directory entry with PS set maps 4 MiB ---------------------------------------
// 9legacy's loader maps its kernel with 4 MiB pages when CPUID says PSE, and panics at "vmap:
// va=0x81000000" without them — QEMU `-cpu pentium,-pse` panics the same way. Before CR4 existed
// here, MOV CR4 was ignored and every PDE was read as a page-table pointer.
{ const mc = new Machine({ memSize: 32 << 20, cpu: '586' }); const cpu = mc.cpu, m = mc.mem;
  const DIR = 0x10000;
  m.w32(DIR + (0x81000000 >>> 22) * 4, 0x01000000 | 0x83);                   // 4 MiB page at 16 MiB: P, R/W, PS
  cpu.setCR3(DIR); cpu.setCR4(0x10); cpu.setCR0(0x80000001);
  eq('PSE: linear 81234567h -> physical 01234567h through one PDE', (m.walk(0x81234567) >>> 0).toString(16), '1234000');
  eq('...the PDE takes the accessed bit', (m.r32phys(DIR + 0x204 * 4) >> 5) & 1, 1);
  eq('...and MOV from CR4 would read PSE back', cpu.cr4, 0x10); }

// ---- A HLT is woken by what the 8259 holds, for a protected-mode OS of its own ------------------
// A device IRQ raised while IRQ0 was in service was left in the IRR and never delivered; a HLT then
// waited for ever (386BSD after its disk probe).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  cpu.cr0 |= 1; cpu.flags |= 0x200; cpu.halted = true;
  const got = []; mc.idtGatePresent = () => true; mc.protInt = (v) => { got.push(v); };
  mc.pic.raise(1);                                                          // a keyboard request nobody took
  mc.runSlice(1);
  eq('a halted PM guest with IF set gets the IRQ its PIC holds, at the PIC vector', got.join(), String(mc.pic.vector(1))); }

// ---- The 8042 answers an OS's keyboard initialisation -------------------------------------------
// Linux 2.2 self-tests the controller, resets the keyboard and waits for the ACK in its IRQ1 handler:
// "keyboard: Timeout - AT keyboard not present?" when any of it was missing.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const inb = (p) => (mc.portRead[p] ? mc.portRead[p](p, 1) & 0xff : 0xff), outb = (p, v) => { if (mc.portWrite[p]) mc.portWrite[p](p, 1, v); };
  outb(0x64, 0xaa); const st = inb(0x60); outb(0x64, 0xab); const it = inb(0x60); outb(0x64, 0x20); const cb = inb(0x60);
  eq('8042: self-test 55h, interface test 00h, command byte 45h', [st, it, cb].map((v) => v.toString(16)).join(), '55,0,45');
  mc.kbIrqPending = false;
  outb(0x60, 0xff);
  eq('keyboard reset: ACK then AAh, and the ACK raises IRQ1 (command byte bit 0)', [inb(0x60), inb(0x60), mc.kbIrqPending].map(String).join(), '250,170,true');
  outb(0x64, 0x60); outb(0x60, 0x44); outb(0x64, 0x20);
  eq('...the command byte is writable (60h) and reads back', inb(0x60), 0x44);
  mc.kbIrqPending = false; outb(0x60, 0xf4); inb(0x60);
  eq('...and with its bit 0 clear a keyboard ACK raises nothing', mc.kbIrqPending, false); }

// ---- The RTC is a chip: it reads the BDA tick physically, never through the guest's paging --------
// Linux 2.2 (v86's bl3-5.img) reads the CMOS clock while low memory is unmapped; our chip read
// 0040:006C with mem.r32, took a #PF at 0000046Ch inside `in al,71h`, and the kernel panicked.
{ const mc = new Machine({ memSize: 4 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  mem.setA20(true);
  mem.w32(0x10000, 0x11007);
  for (let p = 1; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);   // page 0 NOT mapped
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  let v, err = null;
  try { mc.portWrite[0x70](0x70, 1, 0x04); v = mc.portRead[0x71](0x71, 1) & 0xff; } catch (e) { err = e.constructor.name; }
  eq('reading the RTC with page 0 unmapped does not fault, and gives the hour (08 BCD)', [err, v].join(), ',8'); }

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
  // AH=01h sets the BIOS tick count (SeaBIOS handle_1a01): CX:DX into 0040:006C, the midnight flag
  // cleared — and the chip untouched, although ours reads epoch + tick.
  mc.mem.w8(0x470, 1);
  cpu.ax = 0x0100; cpu.cx = 0x0001; cpu.dx = 0x2345; cpu.flags |= 1; mc.intHandlers[0x1a](cpu, mc);
  eq('AH=01h sets the tick count from CX:DX and clears the midnight flag', [mc.mem.r32(0x46c).toString(16), mc.mem.r8(0x470), cpu.flags & 1, (cpu.ax >> 8) & 0xff].join(), '12345,0,0,0');
  cpu.ax = 0x0200; mc.intHandlers[0x1a](cpu, mc);
  eq('...and the RTC still reads 08:00', cpu.cx & 0xffff, 0x0800);
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
  // Descriptor-table and TSS reads are IMPLICIT SUPERVISOR accesses: the processor makes them on its
  // own behalf, so the page-level U/S check does not apply whatever the CPL. They were judged at the
  // current CPL, so a ring-3 interrupt could not read ESP0 out of a TSS in a supervisor page — and
  // delivering THAT #PF read the TSS again, a double fault at the same address. The FreeDOS desktop
  // on v86's xcom144.img (HDPMI32) took the host process down that way, at TSS+4.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  mem.w32(0x1000, 0x2007);                            // PDE[0]: present, writable, user
  for (let p = 0; p < 16; p++) mem.w32(0x2000 + p * 4, ((p << 12) | 0x07) >>> 0);   // identity, user
  mem.w32(0x2000 + 5 * 4, (5 << 12) | 0x03);          // ...except page 5 (0x5000): SUPERVISOR only
  mem.w32(0x5004, 0x12345678); mem.w16(0x5008, 0x0010);           // a 386 TSS: ESP0, SS0
  mem.w16(0x5108, 0xffff); mem.w16(0x510a, 0); mem.w8(0x510c, 0); mem.w8(0x510d, 0xf2);
  mem.w8(0x510e, 0); mem.w8(0x510f, 0);                            // GDT[1] at 0x5108: data, DPL 3
  cpu.setCR3(0x1000); cpu.setCR0(0x80000001);
  cpu.tr.base = 0x5000; cpu.tr.limit = 0x67; cpu.tr.is386 = true;
  cpu.gdtr = { base: 0x5100, limit: 0x0f };
  cpu._cpl = 3;
  const faults = (fn) => { try { fn(); return false; } catch (e) { return e && e.constructor.name === 'PageFault'; } };
  eq('ring 3: an ORDINARY read of a supervisor page still faults', faults(() => mem.r8(0x5000)), true);
  eq('...but the TSS read a ring switch makes does not', faults(() => cpu.tssStack(0)), false);
  const safe = (fn) => { try { return fn(); } catch (e) { return 'faulted'; } };
  eq('...and returns ESP0 from it', safe(() => cpu.tssStack(0).esp >>> 0), 0x12345678);
  eq('...nor does a descriptor read', faults(() => cpu.readDesc(0x0b)), false);
  eq('...which returns the descriptor', safe(() => cpu.readDesc(0x0b).access), 0xf2);
  eq('...and the exemption does not outlive the access', faults(() => mem.r8(0x5000)), true);
  eq('...nor survive an access that faulted inside it', (() => {
    cpu.tr.base = 0x3ff000;                           // unmapped: the TSS read itself must #PF
    const f = faults(() => cpu.tssStack(0)); cpu.tr.base = 0x5000;
    return f && mem.sup === 0; })(), true);
}
{
  // ENTER probes the FINAL stack pointer before anything else: the 386 faults "whenever a write
  // using the final value of the stack pointer would", even though that byte is never written.
  // Here the push of BP lands at 4000h (user page) and the final SP is 3FFFh (supervisor page): at
  // CPL 3 that is #PF with nothing changed. test386's POST 0x1A is this case exactly.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0); cpu.sp = 0x4002; cpu.reg[5] = 0x1234;
  mem.blit(0x1000, Uint8Array.from([0xc8, 0x01, 0x00, 0x00, 0xf4]));   // enter 1,0 ; hlt
  mem.w32(0x10000, 0x11007);                          // PDE[0] -> table at 0x11000, user
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  mem.w32(0x11000 + 3 * 4, (3 << 12) | 0x03);         // page 3: SUPERVISOR
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  cpu._cpl = 3;
  let pf = null;
  mc.protInt = (n, err) => { pf = [n, err]; cpu.halted = true; };
  mc.runSlice(4);
  eq('ENTER at CPL 3 whose FINAL SP is in a supervisor page: #PF', pf && pf[0], 14);
  eq('...a write, from user mode, to a present page (err 7)', pf && pf[1], 7);
  eq('...and nothing moved: SP', cpu.sp, 0x4002);
  eq('...BP', cpu.reg[5] & 0xffff, 0x1234);
  eq('...and the frame slot below the old SP is untouched', mem.r16(0x4000), 0);
}
{
  // REP MOVS that #PFs part-way restarts WHERE IT STOPPED. The count lived in a local and was
  // written back only after the loop, while ESI/EDI advanced in the registers: the restart ran the
  // full count again from the advanced position and overran the destination. KolibriOS's kernel
  // copied a file into @ICON's buffer that way, faulted on the page after it, and killed @ICON.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0); cpu.sp = 0x3000;
  mem.blit(0x1000, Uint8Array.from([0xb9, 0x08, 0x00, 0xf3, 0xa4, 0xf4]));   // mov cx,8 ; rep movsb ; hlt
  cpu.reg[6] = 0x4ffc; cpu.reg[7] = 0x6ffc;
  for (let i = 0; i < 8; i++) mem.u8[0x4ffc + i] = i + 1;
  for (let i = 0; i < 8; i++) mem.u8[0x7000 + i] = 0xee;                    // what must survive past the end
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  mem.w32(0x11000 + 7 * 4, 0);                                              // page 7 (0x7000): absent
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  let pfs = 0;
  mc.protInt = (n) => { if (n === 14) { pfs++; mem.dv.setUint32(0x11000 + 7 * 4, 0x7007, true); mem.rebuildPageTables(); } };
  for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
  const dst = []; for (let i = 0; i < 12; i++) dst.push(mem.u8[0x6ffc + i].toString(16));
  eq('REP MOVSB across a #PF: one fault, then the copy resumes', pfs, 1);
  eq('...copying exactly CX bytes and nothing past them', dst.join(','), '1,2,3,4,5,6,7,8,ee,ee,ee,ee');
  eq('...leaving CX 0 and DI one past the end', [cpu.cx & 0xffff, (cpu.reg[7] & 0xffff).toString(16)].join(), '0,7004');
}
{
  // PUSH and POP m that #PF commit ESP only once the store succeeded. Both moved ESP first, so the
  // restart moved it again: KolibriOS's libini ran `pop [ebx]` into a fresh heap page and returned
  // with EBX/ESI/EDI restored one slot off, and @ICON gave up reading icon.ini.
  const pf = (code, setup) => {
    const mc = new Machine({ memSize: 4 << 20 });
    const cpu = mc.cpu, mem = mc.mem;
    mem.setA20(true); mc.rec.MM = mem.mask;
    cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0);
    mem.blit(0x1000, Uint8Array.from(code));
    mem.w32(0x10000, 0x11007);
    for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
    mem.w32(0x11000 + 7 * 4, 0);                                            // page 7 (0x7000): absent
    setup(cpu, mem);
    cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
    let n = 0;
    mc.protInt = (v) => { if (v === 14) { n++; mem.dv.setUint32(0x11000 + 7 * 4, 0x7007, true); mem.rebuildPageTables(); } };
    for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
    return { cpu, mem, n };
  };
  { const { cpu, mem, n } = pf([0x68, 0x34, 0x12, 0xf4], (cpu) => { cpu.sp = 0x8000; });   // push 1234h ; hlt
    eq('PUSH onto an absent stack page: one #PF, then one slot pushed', [n, (cpu.sp & 0xffff).toString(16), mem.u8[0x7ffe] | (mem.u8[0x7fff] << 8)].join(), '1,7ffe,4660'); }
  { const { cpu, mem, n } = pf([0x8f, 0x07, 0xf4], (cpu, mem) => { cpu.sp = 0x3000; cpu.reg[3] = 0x7000; mem.u8[0x3000] = 0x78; mem.u8[0x3001] = 0x56; mem.u8[0x3002] = 0x34; mem.u8[0x3003] = 0x12; });   // pop [bx] ; hlt
    eq('POP [mem] into an absent page: one #PF, then ESP up by one slot only', [n, (cpu.sp & 0xffff).toString(16), (mem.u8[0x7000] | (mem.u8[0x7001] << 8)).toString(16)].join(), '1,3002,5678'); }
}
{
  // INVLPG after a PTE rewrite: the next access sees the NEW frame. The software TLB was refreshed
  // only on a CR3 load and INVLPG was a no-op, so a kernel that remaps one page and invalidates it
  // (KolibriOS, freeing and reallocating heap pages) kept running on the frame it had given away.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0x1100); cpu.setSeg(SS, 0); cpu.sp = 0x3000;
  mem.blit(0x1000, Uint8Array.from([
    0xa0, 0x00, 0x50,                                            // mov al,[5000h]
    0x26, 0x66, 0xc7, 0x06, 0x14, 0x00, 0x07, 0x60, 0x00, 0x00,  // mov dword es:[0014h],6007h: page 5 -> frame 6
    0x0f, 0x01, 0x3e, 0x00, 0x50,                                // invlpg [5000h]
    0x8a, 0x26, 0x00, 0x50,                                      // mov ah,[5000h]
    0xf4]));
  mem.u8[0x5000] = 0xaa; mem.u8[0x6000] = 0xbb;
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 32; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
  eq('INVLPG after remapping a page: the read before sees the old frame, the read after the new', (cpu.ax & 0xffff).toString(16), 'bbaa');
}
{
  // x87 memory operands go through the page tables. They indexed physical memory with the LINEAR
  // address: under HDPMI32, xcom144's `fistp qword` (a loop bound) landed elsewhere and the program
  // read back two stale stack addresses as a bound of ~2^54 iterations.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0); cpu.sp = 0x3000;
  mem.blit(0x1000, Uint8Array.from([0xd9, 0x06, 0x10, 0x50, 0xdf, 0x3e, 0x00, 0x50, 0xdd, 0x06, 0x20, 0x50, 0xdd, 0x1e, 0x28, 0x50, 0xf4]));
  // fld dword [5010h] ; fistp qword [5000h] ; fld qword [5020h] ; fstp qword [5028h] ; hlt
  mem.dv.setFloat32(0x9010, 1234.0, true); mem.dv.setFloat32(0x5010, 7.0, true);     // frame 9 real, frame 5 a decoy
  mem.dv.setFloat64(0x9020, 2.5, true);
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  mem.w32(0x11000 + 5 * 4, 0x9007);                                         // linear page 5 -> frame 9
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
  eq('x87 under paging: FLD m32 / FISTP m64 use the mapped frame', [Number(mem.dv.getBigInt64(0x9000, true)), Number(mem.dv.getBigInt64(0x5000, true))].join(), '1234,0');
  eq('...and FLD / FSTP m64 too', [mem.dv.getFloat64(0x9028, true), mem.dv.getFloat64(0x5028, true)].join(), '2.5,0');
}
{
  // PUSH and POP inline under paging take SS's base: "flat" is a 4 GiB expand-up limit, not a zero
  // base. HDPMI32's stack (xcom144) has a base, and its pushes landed at ESP itself: the host halted.
  const mc = new Machine({ memSize: 4 << 20 }), cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0);
  mem.blit(0x1000, Uint8Array.from([0x68, 0x44, 0x33, 0x22, 0x11, 0x58, 0x68, 0x88, 0x77, 0x66, 0x55, 0xf4]));   // push 11223344h; pop eax; push 55667788h; hlt
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  cpu.csD = 1; cpu.base[SS] = 0x4000; cpu.limit[SS] = 0xffffffff; cpu.limLo[SS] = 0; cpu.ssB = 1; cpu.reg[4] = 0x100;
  for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
  eq('push/pop inline under paging go to SS\'s base plus ESP', [(cpu.reg[0] >>> 0).toString(16), (cpu.reg[4] >>> 0).toString(16), mem.r32(0x40fc).toString(16)].join(), '11223344,fc,55667788');
}
{
  // An undefined 0F opcode decoded past a side exit, at ring 3: the translator asks whether the guest
  // handles #UD by reading the IDT, which the processor reads as a supervisor. Read as a user access,
  // FreeNOS's IDT page faulted at translate time -- a #PF for code that never runs -- and the kernel
  // killed the process. `xor eax,eax; jz +2; 0f ff; jmp $`, the IDT in a supervisor page.
  const mc = new Machine({ memSize: 4 << 20, cpu: '686' }), cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0);
  mem.blit(0x1000, Uint8Array.from([0x31, 0xc0, 0x74, 0x02, 0x0f, 0xff, 0xeb, 0xfe]));
  mem.blit(0x6000 + 6 * 8, Uint8Array.from([0, 0, 8, 0, 0, 0x8e, 0, 0]));                 // a present gate for #UD
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | (p === 6 ? 0x03 : 0x07)) >>> 0);
  cpu.idtr.base = 0x6000; cpu.idtr.limit = 0x7ff;
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  cpu.csD = 1; cpu._cpl = 3;
  let got;
  try { for (let i = 0; i < 10; i++) mc.runSlice(4); got = [(cpu.eip >>> 0).toString(16), (cpu.cr2 >>> 0).toString(16)].join(); }
  catch (e) { got = e.message.slice(0, 60); }
  eq('ring 3: the IDT read for an opcode past a side exit is a supervisor access, and faults nobody', got, '6,0');
}
{
  // The VGA / VBE window is PHYSICAL A0000h, reached through whatever linear page maps it. Under paging
  // the device routing was skipped and the TLB marked device pages by LINEAR number, so xcom144 under
  // HDPMI32 (VBE 111h, banked) drew into the RAM behind A000 and its framebuffer stayed black.
  const mc = new Machine({ memSize: 4 << 20 });
  const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  mem.setA20(true); mc.rec.MM = mem.mask;
  cpu.ax = 0x4f02; cpu.bx = 0x0111; mc.intHandlers[0x10](cpu, mc);            // 640x480x16, banked
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0); cpu.sp = 0x3000;
  mem.blit(0x1000, Uint8Array.from([0xc6, 0x06, 0x00, 0x50, 0x5a, 0x8a, 0x26, 0x00, 0x50, 0xf4]));   // mov byte [5000h],5Ah ; mov ah,[5000h] ; hlt
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 256; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  mem.w32(0x11000 + 5 * 4, 0xa0007);                                          // linear page 5 -> frame A0h
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  for (let i = 0; i < 20 && !cpu.halted; i++) mc.runSlice(4);
  eq('paged write through a page mapped on A000: it reaches the VBE framebuffer, not the RAM behind', [mem.u8[mc.vbeFbBase], mem.u8[0xa0000]].join(), '90,0');
  eq('...and reads back through the window', (cpu.ax >> 8) & 0xff, 0x5a);
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
// ...and Mode X set by the registers alone, no INT 10h: SVGAlib (Linux Quake II's 320x240) leaves the BIOS
// mode at 3 and programs the Sequencer, then the Graphics Controller's 256-colour bits. Seen as text
// mode, the window stayed plain RAM and the screen black.
{
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const vga = mc.vga, mem = mc.mem;
  mc.ioWrite(0x3c4, 1, 4); mc.ioWrite(0x3c5, 1, 0x06);            // chain-4 off, while the card is in text mode
  const before = vga.modeX;
  mc.ioWrite(0x3ce, 1, 5); mc.ioWrite(0x3cf, 1, 0x40);            // 256 colours
  mc.ioWrite(0x3ce, 1, 6); mc.ioWrite(0x3cf, 1, 0x05);            // graphics, A000 64K
  eq('Mode X from the registers alone: not before 256 colours, then planes', [before, vga.modeX, mem.planar].join(), 'false,true,true');
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

// ---- Windows 95 under a V86 monitor: five defects between VMM's first breakpoint and the desktop ----
// v86's windows95-v3.img, safe mode, each checked against the BOOTLOG.TXT QEMU writes for the same
// image (as an ISA PC). In the order they were hit.
{ // (1) ARPL does not exist in virtual-8086 mode: #UD. VMM plants `63 xx` as its V86 breakpoints.
  const { mc, cpu, calls } = v86(3);
  mc.mem.blit(0xf500, Uint8Array.from([0x63, 0xc8, 0xf4]));          // arpl ax,cx ; hlt
  cpu.reg[0] = 0x10; cpu.reg[1] = 0x13;
  mc.rec.step();
  eq('ARPL in V86 is #UD', calls[0] && calls[0][0], 6);
  eq('...and did not adjust the RPL', cpu.reg[0] & 0xffff, 0x10); }
{ // (1b) LES/LDS with a REGISTER operand is #UD — Windows NT's "BOP" (C4 C4 FE) ends every BIOS
  // call it makes in V86 and is recognised in its #UD handler; we loaded ES and ran on into the page.
  const { mc, cpu, calls } = v86(3);
  mc.mem.blit(0xf500, Uint8Array.from([0xc4, 0xc4, 0xfe, 0xf4]));    // BOP FE ; hlt
  mc.rec.step();
  eq('C4 C4 (LES, register form) in V86 is #UD', calls[0] && calls[0][0], 6); }
{ // (2) STI's interrupt window: the block ends after the instruction that follows STI, so an IRQ
  // waiting for it lands there. VMM idles in `sti; nop; nop; cli; jmp` — one block, IF never set
  // at a boundary, and the timer the scheduler waited for never came.
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  mem.blit(0x600, Uint8Array.from([0x2e, 0xff, 0x06, 0x00, 0x07, 0xb0, 0x20, 0xe6, 0x20, 0xcf]));   // inc cs:[700] ; EOI ; iret
  mc.setVector(8, 0, 0x600);
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.flags &= ~0x200;
  mem.blit(0x1000, Uint8Array.from([0xfb, 0x90, 0x90, 0xfa, 0xeb, 0xfa]));    // sti ; nop ; nop ; cli ; jmp $-4
  mc.timerAuto = true;
  for (let k = 0; k < 40; k++) mc.runSlice(2000);
  eq('an IRQ is taken in the window STI opens, even when CLI closes it two instructions later', mem.r16(0x700) > 0, true); }
{ // (3) The BIOS INT 8 / INT 9 under a monitor that traps the PIC: the EOI must be an OUT the
  // monitor sees. Windows 95's VPICD ends the VM's virtual IRQ0 only on a trapped EOI.
  const trapRun = (n, deny) => {
    const { mc, cpu } = v86(3); installBIOS(mc);
    const TSS = 0x9000;
    cpu.tr = { sel: 0x28, base: TSS, limit: 0x67 + 0x2000 / 8, is386: true };
    mc.mem.w16(TSS + 0x66, 0x68);
    if (deny) { mc.mem.w8(TSS + 0x68 + (0x20 >> 3), 0x01); mc.mem.w8(TSS + 0x68 + (0x60 >> 3), 0x01); }
    cpu.push16(0x3202); cpu.push16(0x0f40); cpu.push16(0x0200);        // FLAGS, CS, IP
    cpu.setSeg(CS, 0xf000); cpu.eip = n;
    mc.biosCallback(n);
    return { mc, cpu, at: (cpu.seg[CS] << 16 | cpu.eip) >>> 0 };
  };
  const a = trapRun(8, true);
  eq('INT 8 with port 20h trapped: hands over to ROM code', a.at, (0xf000 << 16 | a.mc.eoi8Rom) >>> 0);
  eq('...which is push ax / mov al,20h / out 20h,al / pop ax / iret',
    [...a.mc.mem.u8.subarray(0xf0000 + a.mc.eoi8Rom, 0xf0000 + a.mc.eoi8Rom + 7)].join(), '80,176,32,230,32,88,207');
  const e1c = 0xf0000 + a.mc.eoi8Then1cRom;
  eq('...and the 1Ch variant jumps exactly to the ROM 1Ch caller',
    (a.mc.eoi8Then1cRom + 9 + a.mc.mem.r16(e1c + 7)) & 0xffff, a.mc.int1cViaRom);
  eq('INT 8 with the port allowed returns straight to the caller', trapRun(8, false).at, 0x0f400200);
  const k = trapRun(9, true);
  eq('INT 9 with ports 60h/20h trapped: hands over to ROM code', k.at, (0xf000 << 16 | k.mc.eoi9Rom) >>> 0); }
{ // (4) mem.blit writes where the GUEST named, through its page tables. The real-mode mapper's
  // INT 13h buffer at V86 081b:xxxx was mapped elsewhere; the sector went to physical 81bxx.
  const mc = new Machine({ memSize: 4 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  mem.setA20(true);
  mem.w32(0x10000, 0x11007);
  for (let p = 0; p < 16; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);
  mem.w32(0x11000 + 5 * 4, (0x9000 | 0x07) >>> 0);                   // linear page 5 -> frame 9
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  mem.blit(0x5010, Uint8Array.from([0xaa, 0xbb]));
  eq('blit under paging lands in the mapped frame', mem.u8[0x9010] << 8 | mem.u8[0x9011], 0xaabb);
  eq('...and not at the linear address taken as physical', mem.u8[0x5010], 0); }
{ // (5) An EXPAND-DOWN data segment is valid above its limit. KRNL386 reads KERNEL32 at BFF71000h
  // through a selector with limit FFFFh, B=1, type 6; checked as expand-up it was #GP(0).
  const run16 = (access, flags, off) => {
    const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
    const GDT = 0x8000, a = GDT + 2 * 8;
    mem.w16(a, 0xffff); mem.w8(a + 5, access); mem.w8(a + 6, flags);
    cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
    cpu.gdtr = { base: GDT, limit: 0x1f }; cpu.cr0 |= 1;
    // mov ax,10h / mov ds,ax / mov eax,[off] (addr32) / hlt
    mem.blit(0x1000, Uint8Array.from([0xb8, 0x10, 0x00, 0x8e, 0xd8, 0x67, 0x66, 0xa1, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, off >>> 24, 0xf4]));
    let raised = null; mc.protInt = (n, err) => { raised = [n, err].join(); cpu.halted = true; };
    let s = 0; while (!cpu.halted && s++ < 40) mc.rec.step();
    return raised;
  };
  eq('expand-down, B=1: an offset above the limit is valid', run16(0x96, 0x40, 0x00050000), null);
  eq('expand-down: an offset AT the limit is #GP(0)', run16(0x96, 0x40, 0x0000fff0), '13,0');
  eq('expand-down, B=0: the top is FFFFh', run16(0x96, 0x00, 0x00050000), '13,0');
  eq('expand-up with the same limit: above it is #GP(0)', run16(0x92, 0x40, 0x00050000), '13,0'); }

// ---- the renderer is the card: it reads the BDA and text memory physically ------------------------
// Linux unmaps linear page 0; video.js read 0040:0049 through the guest's paging, and every frame of
// the browser's bare-PC page (boot.html) threw a #PF out of render().
{ const mc = new Machine({ memSize: 4 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  mc.font = new Uint8Array(256 * 16).fill(0xff);
  mem.u8[0xb8000] = 0x41; mem.u8[0xb8001] = 0x1f;
  mem.setA20(true);
  mem.w32(0x10000, 0x11007);
  for (let p = 1; p < 256; p++) mem.w32(0x11000 + p * 4, ((p << 12) | 0x07) >>> 0);   // page 0 NOT mapped
  cpu.setCR3(0x10000); cpu.setCR0(0x80000001);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const v = new Video(mc, canvas); v.font = mc.font;
  let err = null; try { v.render(); } catch (e) { err = e.constructor.name; }
  eq('render() with linear page 0 unmapped does not fault', err, null);
  eq('...and draws the text cell (blue background behind a white glyph)', !!v.u32 && v.u32[0] !== v.u32[v.imgW * 20], true); }

// ---- the translation memo is bounded by the source it holds -------------------------------------------
// Each memo entry keeps its compiled function (V8 charges about eight times the source). Bounded by a
// count of 200 000 blocks, it reached 1.3 GB once paged blocks followed jumps and calls: Linux 3.x,
// TinyCore and Windows ME spent 99 % of their time in the garbage collector, guest time standing still.
{ const mc = new Machine({ memSize: 1 << 20 }), rec = mc.rec;
  rec.memoCap = 10000;
  for (let i = 0; i < 100; i++) rec._memoPut('k' + i, { linStart: 0x1000 + i * 16, linEnd: 0x1010 + i * 16, bodyLen: 1000 });
  eq('the memo keeps no more source than its bound, the newest entries', [rec.memoBytes <= 10000, rec.memo.size, rec.memo.has('k99'), rec.memo.has('k0')].join(), 'true,10,true,false'); }

// ---- a 16-colour mode's height is the CRTC's, double scan included ------------------------------------
// Pinball Fantasies sets mode 12h and then doubles every line (CRTC 09h bit 7) for a 640x240 menu. The
// planar renderer took the mode's 480 lines and drew the memory below the menu as its lower half.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  cpu.ax = 0x0012; mc.intHandlers[0x10](cpu, mc);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const v = new Video(mc, canvas); v.font = mc.font;
  v.render(); const h12 = v.imgH;
  mc.ioWrite(0x3d4, 1, 0x09); mc.ioWrite(0x3d5, 1, mc.vga.crtc[0x09] | 0x80);
  v.render();
  eq('mode 12h renders 480 lines, and 240 once the CRTC doubles each one', [h12, v.imgH].join(), '480,240'); }

// ---- cursor shape and the PS/2 aux channel, from testing boot.html ---------------------------------
{ // The mode set programs the CRTC cursor as SeaVGABIOS does (0607h scaled to the 16-line cell), and
  // AH=01h scales a CGA-style shape. Nothing set 0Ah/0Bh: under MS-DOS the cursor sat on the TOP line.
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  cpu.ax = 0x0003; mc.intHandlers[0x10](cpu, mc);
  eq('mode 3 leaves the cursor an underline (CRTC 0Ah/0Bh = 0Eh/0Fh)', (mc.vga.crtc[0x0a] << 8) | mc.vga.crtc[0x0b], 0x0e0f);
  cpu.ax = 0x0100; cpu.cx = 0x0007; mc.intHandlers[0x10](cpu, mc);
  eq('AH=01h 0007h (a block) scales as SeaVGABIOS does, to 1..0Fh', (mc.vga.crtc[0x0a] << 8) | mc.vga.crtc[0x0b], 0x010f);
  eq('...and the BDA keeps the value asked for', mc.mem.r16(0x460), 0x0007); }
{ // One IRQ12 per aux BYTE while bytes remain, withdrawn once drained; button changes one per packet.
  const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); installMouse(mc);
  const p = mc.ps2; p.enabled = true; p.handler = { seg: 0, off: 0 };
  mc.mouseMoveRel(3, 0);
  eq('a packet raises IRQ12', mc.mouseIrqPending, true);
  mc.mouseIrqPending = false;
  p.read();
  eq('...and bytes still waiting after one read raise it again (a driver reading one byte per IRQ)', mc.mouseIrqPending, true);
  p.read(); p.read();
  eq('...and a drained queue withdraws it', mc.mouseIrqPending, false);
  mc.mouseButton(0, true); mc.mouseButton(0, false);        // a click while... nothing is in flight: press sent
  const st1 = p.queue[0]; p.read(); p.read(); p.read();
  const st2 = p.queue[0];
  eq('a quick click: the press goes out', st1 & 1, 1);
  eq('...and the release in the next packet', st2 !== undefined && (st2 & 1) === 0, true); }

// ---- LMSW can set PE, never clear it --------------------------------------------------------------
// DOOM's DOS/4GW under EMM386 does `smsw cx / ... / and ax,cx / lmsw ax` with PE clear in AX. Applied,
// it left "real mode with paging on" and the next blocks derailed; QEMU stays in protected mode.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000;
  mc.mem.blit(0x1000, Uint8Array.from([0x31, 0xc0, 0x0f, 0x01, 0xf0, 0xf4]));      // xor ax,ax / lmsw ax / hlt
  cpu.setCR0(cpu.cr0 | 1);                                                       // PE on, CS not reloaded
  let s = 0; while (!cpu.halted && s++ < 20) mc.rec.step();
  eq('LMSW with PE clear leaves the CPU in protected mode', cpu.cr0 & 1, 1);
  const mc2 = new Machine({ memSize: 1 << 20 }); const c2 = mc2.cpu;
  c2.setSeg(CS, 0x100); c2.eip = 0; c2.setSeg(SS, 0x300); c2.sp = 0x1000;
  mc2.mem.blit(0x1000, Uint8Array.from([0xb8, 0x01, 0x00, 0x0f, 0x01, 0xf0, 0xf4]));   // mov ax,1 / lmsw ax / hlt
  s = 0; while (!c2.halted && s++ < 20) mc2.rec.step();
  eq('...while LMSW can still set it', c2.cr0 & 1, 1); }

// ---- FLDCW changing the precision recompiles the FPU blocks, not the whole cache ------------------------
// Kraptor (Allegro, DJGPP) sets the precision control thousands of times a second; each change dropped
// every translated block. A loop alternates single and double precision for 1/3: both results must be
// exact for their precision, and the loop must not be translated again on every FLDCW.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  // nasm: mov cx,50 / L: fldcw [cw24] / fld1 / fidiv word [three] / fstp qword [r1] / fldcw [cw53] / ... / loop L / hlt
  mc.mem.blit(0x1000, Uint8Array.from('b93200d92e2200d9e8de362600dd1e2800d92e2400d9e8de362600dd1e3000e2e2f47f007f0203000000000000000000000000000000000000'.match(/../g).map((x) => parseInt(x, 16))));
  let n = 0; while (!cpu.halted && n++ < 400) mc.runSlice(1000);
  const r1 = mc.mem.dv.getFloat64(0x1028, true), r2 = mc.mem.dv.getFloat64(0x1030, true);
  eq('FLDCW: single precision gives 1/3 rounded to 24 bits, double to 53', [r1 === Math.fround(1 / 3), r2 === 1 / 3].join(), 'true,true');
  eq('...and the loop is not retranslated on each change of precision', mc.rec.stats.compiles < 30, true); }

// ---- FPTAN, FSIN, FCOS, FSINCOS clear C2 for an operand in range ------------------------------------------
// C2 left as FXAM had set it (a normal number) after FPTAN: Microsoft's C runtime tests C2 right after FPTAN
// (out of range: reduce the argument), and Half-Life's R_ViewChanged, under Quake's single precision, got NaN
// for its projection -- an engine running, its world never drawn. Each: fld1 / fxam / op / fnstsw ax / store.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  mc.mem.blit(0x1000, Uint8Array.from('d9e8d9e5d9f2dfe0a34000dbe3d9e8d9e5d9fedfe0a34200dbe3d9e8d9e5d9ffdfe0a34400dbe3d9e8d9e5d9fbdfe0a34600dbe3f4'.match(/../g).map((x) => parseInt(x, 16))));
  let n = 0; while (!cpu.halted && n++ < 100) mc.runSlice(1000);
  eq('x87: FPTAN, FSIN, FCOS, FSINCOS clear C2 for an operand in range', [0x40, 0x42, 0x44, 0x46].map((a) => (mc.mem.dv.getUint16(0x1000 + a, true) & 0x400).toString(16)).join(), '0,0,0,0'); }
// ---- FILD m64 / FISTP m64 copy 8 bytes exactly, through an FXCH ---------------------------------------------
// The x87 holds a 64-bit integer whole; a float64 register rounds it past 2^53. Jazz Jackrabbit 2 copies its
// video frames so (fild, fild, fxch, fistp, fistp), and the lowest byte of every eight came back wrong. Two
// integers that round to the same double, exchanged, in a loop run 40 times (interpreted, then compiled).
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  mc.mem.blit(0x1000, Uint8Array.from('b92800dbe3df2e0001df2e0801d9c9df3e1001df3e1801e2eaf4'.match(/../g).map((x) => parseInt(x, 16))));
  mc.mem.dv.setBigUint64(0x1100, 0x0123456789abcdefn, true); mc.mem.dv.setBigUint64(0x1108, 0x0123456789abcde1n, true);
  let n = 0; while (!cpu.halted && n++ < 100) mc.runSlice(1000);
  eq('x87: FILD m64 / FISTP m64 copy 8 bytes exactly, through an FXCH', [0x1110, 0x1118].map((a) => mc.mem.dv.getBigUint64(a, true).toString(16)).join(), '123456789abcdef,123456789abcde1'); }

// ---- one block under both precisions: checked when it is dispatched -----------------------------------
// gcc 2.x converts a float to an int between two FLDCW: XFree86 3.3.2 and Mesa change the precision
// thousands of times a second, and each change made every translated block revalidate. A block now says
// whether its arithmetic depends on the precision (fprec), and only such blocks are checked against the
// control word when they are dispatched: here one subroutine `fld1 / fidiv [three] / ret`, called
// under single then double precision, must give 1/3 rounded to 24 bits, then to 53.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  // nasm: mov cx,20 / L: fldcw [cw24] / call third / fstp qword [r1] / fldcw [cw53] / call third / fstp qword [r2] / loop L / hlt
  //       third: fld1 / fidiv word [three] / ret
  mc.mem.blit(0x1000, Uint8Array.from('b91400d92e2300e81200dd1e3000d92e2500e80700dd1e3800e2e8f4d9e8de362700c37f007f0203009090909090909000000000000000000000000000000000'.match(/../g).map((x) => parseInt(x, 16))));
  let n = 0; while (!cpu.halted && n++ < 400) mc.runSlice(1000);
  const r1 = mc.mem.dv.getFloat64(0x1030, true), r2 = mc.mem.dv.getFloat64(0x1038, true);
  eq('one block under both precisions: 1/3 to 24 bits, then to 53', [r1 === Math.fround(1 / 3), r2 === 1 / 3].join(), 'true,true'); }

// A real-mode program at 1000h (DS = CS = 100h), the control word at 40h and 42h, doubles from 48h on;
// run until HLT. For the precision-control checks below.
const x87Prog = (code, cw, doubles) => {
  const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  mc.mem.blit(0x1000, Uint8Array.from(code));
  mc.mem.dv.setUint16(0x1040, cw[0], true); mc.mem.dv.setUint16(0x1042, cw[1], true);
  doubles.forEach((v, i) => mc.mem.dv.setFloat64(0x1048 + 8 * i, v, true));
  let n = 0; while (!cpu.halted && n++ < 100) mc.runSlice(1000);
  return (i) => mc.mem.dv.getFloat64(0x1048 + 8 * i, true);
};

// ---- FLDCW in the middle of a block: what follows it is translated for the new precision ---------------
// The precision is folded into a block when it is translated, and checked when the block is dispatched:
// an FADD after an FLDCW in the same block ran at the precision the block began with. kkrieger's sFPow
// (fldcw 103Fh, then the call, then the arithmetic, all one block under paging) came out at 53 bits.
// nasm: fldcw [40h] / fld qword [48h] / fadd qword [50h] / fstp qword [58h] / fldcw [42h] / hlt
{ const r = x87Prog([0xd9, 0x2e, 0x40, 0x00, 0xdd, 0x06, 0x48, 0x00, 0xdc, 0x06, 0x50, 0x00, 0xdd, 0x1e, 0x58, 0x00, 0xd9, 0x2e, 0x42, 0x00, 0xf4],
    [0x007f, 0x027f], [1 / 3, 0, 0]);
  eq('FLDCW to single in the middle of a block: the FADD after it is rounded to 24 bits', r(2) === Math.fround(1 / 3), true); }

// ---- single precision rounds the significand, not the exponent -----------------------------------------
// At PC = single the x87 rounds a result's significand to 24 bits and keeps its own 15-bit exponent:
// 1e-40 * 1e-33 is about 1e-73, not 0, and 1e30 * 1e30 is not infinity. Math.fround made them a float.
// kkrieger's sFPow(x, 64) lives there. Folded (FMUL) and run-time (FDIV, through cpu.fprec) paths both.
// nasm: fldcw [40h] / fld qword [48h] / fmul qword [50h] / fstp qword [68h] / fld qword [48h] /
//       fdiv qword [58h] / fstp qword [70h] / fld qword [60h] / fmul qword [60h] / fstp qword [78h] /
//       fldcw [42h] / hlt
{ const r = x87Prog([0xd9, 0x2e, 0x40, 0x00, 0xdd, 0x06, 0x48, 0x00, 0xdc, 0x0e, 0x50, 0x00, 0xdd, 0x1e, 0x68, 0x00,
    0xdd, 0x06, 0x48, 0x00, 0xdc, 0x36, 0x58, 0x00, 0xdd, 0x1e, 0x70, 0x00, 0xdd, 0x06, 0x60, 0x00, 0xdc, 0x0e, 0x60, 0x00,
    0xdd, 0x1e, 0x78, 0x00, 0xd9, 0x2e, 0x42, 0x00, 0xf4], [0x007f, 0x027f], [1e-40, 1e-33, 1e33, 1e30, 0, 0, 0]);
  // The 24-bit rounding of each, by a scale that keeps it inside float's range (exact both ways).
  const at24 = (v, s) => Math.fround(v * 2 ** s) * 2 ** -s;
  const got = [r(4), r(5), r(6)], want = [at24(1e-40 * 1e-33, 250), at24(1e-40 / 1e33, 250), at24(1e30 * 1e30, -200)];
  eq('single precision: 1e-40*1e-33, 1e-40/1e33 and 1e30*1e30 keep their exponent, 24-bit significands', got.map((v, i) => v === want[i] && v !== 0 && Number.isFinite(v)).join(), 'true,true,true');
  eq('...and those really are rounded (not left at 53 bits)', got.map((v, i) => v !== [1e-40 * 1e-33, 1e-40 / 1e33, 1e30 * 1e30][i]).join(), 'true,true,true'); }

// ---- sig24 at the edges: a power of two, a value that rounds up to one, float's range limits ------------
{ const at24 = (v, s) => Math.fround(v * 2 ** s) * 2 ** -s;
  const cases = [[2 ** -200, 200], [2 ** -200 * (1 - 2 ** -30), 200], [2 ** -200 * (1 + 2 ** -24), 200], [2 ** -200 * (1 + 3 * 2 ** -25), 200],
    [-(2 ** 300) * (1 + 2 ** -23 + 2 ** -40), -300], [2 ** -126 * (1 - 2 ** -30), 126], [2 ** 128 * (1 + 2 ** -20), -128], [2 ** -1000 * 1.1, 1000], [2 ** 1000 * 1.7, -1000]];
  eq('sig24: 24-bit significands at any double exponent, powers of two and carries included', cases.filter(([v, s]) => sig24(v) !== at24(v, s)).length, 0);
  eq('...and float\'s normal range is Math.fround', [1, 1 / 3, -1e-20, 3e38, 2 ** -126].every((v) => sig24(v) === Math.fround(v)) && Object.is(sig24(-0), -0) && Number.isNaN(sig24(NaN)) && sig24(-Infinity) === -Infinity, true); }

// ---- an immediate the code keeps rewriting is read at run time, not retranslated ----------------------
// DOOM's R_DrawColumn writes each column's texture step into `add ebp,imm32`: every write evicted the
// block and the next column translated it again — 14 000 translations in 8 s of its demo, four frames
// a second in Chrome. Here a loop rewrites the immediate of its own `add bx,imm16` with CX each time
// round: the sum must stay exact, and after the first rewrites the block must stop being translated.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0x100);
  // mov cx,100 / xor bx,bx / L: mov [cs:0x0c],cx / add bx,0x1234 (its immediate at 0x0c) / loop L / hlt
  mc.mem.blit(0x1000, Uint8Array.from([0xb9, 0x64, 0x00, 0x31, 0xdb, 0x2e, 0x89, 0x0e, 0x0c, 0x00, 0x81, 0xc3, 0x34, 0x12, 0xe2, 0xf5, 0xf4]));
  let n = 0; while (!cpu.halted && n++ < 5000) mc.rec.step();
  eq('SMC immediate: the sum uses every rewritten value', cpu.bx & 0xffff, 5050);
  eq('...and the loop is not retranslated once per rewrite', mc.rec.stats.compiles < 20, true); }

// ---- VBE 4F06h / 4F07h: the logical scan line and the display start ---------------------------------
// tools/vbescan.asm in mode 101h, QEMU (SeaVGABIOS) and DOSBox-X alike: set 1024 pixels → BX 400h
// bytes, CX 400h pixels, DX the lines video memory holds; set in bytes; display start set and read.
// Allegro (Kraptor) sets the 1024-pixel line; MIRAGE failed it and showed 640-byte rows.
{ const mc = new Machine({ memSize: 32 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  const call = (ax, bx, cx = 0, dx = 0) => { cpu.ax = ax; cpu.bx = bx; cpu.cx = cx; cpu.dx = dx; mc.intHandlers[0x10](cpu, mc);
    return [cpu.ax, cpu.bx, cpu.cx, cpu.dx].map((x) => (x & 0xffff).toString(16)).join(' '); };
  call(0x4f02, 0x101);
  const lines = ((mc.vbeFbBytes / 1024) & 0xffff).toString(16);
  eq('VBE 4F06h BL=0: a 1024-pixel line in mode 101h', call(0x4f06, 0, 1024), `4f 400 400 ${lines}`);
  eq('...and the renderer\'s pitch follows', mc.vbe.pitch, 1024);
  eq('...BL=2 sets it in bytes', call(0x4f06, 2, 2048), `4f 800 800 ${((mc.vbeFbBytes / 2048) & 0xffff).toString(16)}`);
  eq('VBE 4F07h: the display start, set then read (BX keeps the 1 asked with, as on both)', (call(0x4f07, 0, 8, 16), call(0x4f07, 1)), '4f 1 8 10');
  eq('...and the picture starts there', mc.vbe.base - mc.vbe.fbBase, 16 * 2048 + 8); }

// ---- a tweaked chained 256-colour mode: the size the CRTC gives, blanking included -----------------
// Helium (examples/intros) sets mode 13h, then CRTC 01h = 47h (display to 72 characters), 02h = 3Fh
// (blanking from 63), 13h = 20h (256-byte rows), 12h = FFh with 07h = 3Eh (512 lines), 09h = 41h
// (two lines a row). DOSBox-X's DX-CAPTURE of it is 504x512, every pixel doubled: 252x256 (QEMU shows
// 288, ignoring the blanking). MIRAGE drew the standard 320x200.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const vid = new Video(mc, canvas); vid.font = new Uint8Array(4096);
  vid.render();
  eq('mode 13h as the BIOS sets it is 320x200', `${vid.imgW}x${vid.imgH}`, '320x200');
  const c = mc.vga.crtc; c[0x11] &= 0x7f;
  Object.assign(c, { 0x01: 0x47, 0x02: 0x3f, 0x13: 0x20, 0x12: 0xff, 0x07: 0x3e, 0x09: 0x41, 0x15: 0xff });
  mem.u8[0xa0000 + 256 * 255 + 251] = 7;                                   // last row, last visible pixel
  vid.render();
  eq('Helium\'s tweaked 13h is 252x256, the size DOSBox-X shows', `${vid.imgW}x${vid.imgH}`, '252x256');
  eq('...rows 256 bytes apart', vid.u32 && vid.u32[255 * 252 + 251] === vid.pal[7], true); }

// ---- the Windows 9x logo: 320x400 unchained, with 03h in the BDA ------------------------------------
// IO.SYS sets mode 13h, turns chain-4 and double scan off (Sequencer 04h = 02h, CRTC 09h = 40h), and
// writes 03h to 0040:0049. The renderer dispatched on that byte, and INT 10h kept drawing DOS's output
// as mode 13h glyphs over the logo.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; installBIOS(mc);
  cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);
  const v = mc.vga;
  v.memMode = 0x06; v.modeX = true; v.crtc[0x09] = 0x40;                   // unchained, no double scan
  v.crtc[0x12] = 0x8f; v.crtc[0x07] = 0x1f; v.crtc[0x13] = 0x28;          // 400 lines, 80 bytes per row
  v.planes[3 * 0x10000 + 80 * 399] = 0x0f;                                 // plane 3, last row, x=3
  mem.u8[0x449] = 0x03;
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const vid = new Video(mc, canvas); vid.font = new Uint8Array(4096);
  vid.render();
  eq('a 256-colour card is drawn as such whatever the BDA says: 320x400', `${vid.imgW}x${vid.imgH}`, '320x400');
  eq('...from the planes, row 399 included', vid.u32 && vid.u32[399 * 320 + 3] === vid.pal[0x0f], true);
  const a0 = mem.u8.slice(0xa0000, 0xa0000 + 320 * 16).reduce((s, x) => s + x, 0);
  cpu.ax = 0x0e41; cpu.bx = 0x000f; mc.intHandlers[0x10](cpu, mc);
  eq('INT 10h follows the BDA mode: teletype goes to the text buffer', mem.u8[0xb8000], 0x41);
  eq('...and draws nothing in A000', mem.u8.slice(0xa0000, 0xa0000 + 320 * 16).reduce((s, x) => s + x, 0), a0); }

// ---- a RETF that faults on CS: the stack as before, and nothing after the exception ---------------
// Win16 loads a discarded code segment when a RETF to it raises #NP. MIRAGE delivered the #NP with the
// return address already popped, then assigned EIP anyway — Windows 95's VMM handler ran from
// 0028:<return offset>, took a #GP, and the Win16 kernel never came back: an empty desktop.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
  const GDT = 0x8000;
  const desc = (i, base, limit, access, flags) => { const a = GDT + i * 8;
    mem.w16(a, limit & 0xffff); mem.w16(a + 2, base & 0xffff); mem.w8(a + 4, (base >> 16) & 0xff);
    mem.w8(a + 5, access); mem.w8(a + 6, flags | ((limit >> 16) & 0x0f)); mem.w8(a + 7, (base >> 24) & 0xff); };
  desc(1, 0x1000, 0xffff, 0x9a, 0);          // 08: code, present
  desc(2, 0x3000, 0xffff, 0x92, 0);          // 10: data/stack
  desc(3, 0x5000, 0xffff, 0x1a, 0);          // 18: code, NOT present
  cpu.gdtr = { base: GDT, limit: 0x1f }; cpu.cr0 |= 1;
  cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.sp = 0x1000;
  cpu.push16(0x18); cpu.push16(0x1234);      // return to 0018:1234
  mem.blit(0x1000, Uint8Array.from([0xcb, 0xf4]));   // retf / hlt
  cpu.eip = 0;
  let got = null;
  mc.protInt = (n, err) => { got = { n, err, sp: cpu.sp, eip: cpu.eip }; cpu.halted = true; };
  mc.rec.step();
  eq('RETF to a not-present code segment is #NP(selector)', got && `${got.n},${got.err}`, '11,24');
  eq('...delivered with the stack as it was before the RETF', got && got.sp, 0x0ffc);
  eq('...and at the RETF itself', got && got.eip, 0);
  eq('...and nothing overwrites EIP after the exception', cpu.eip, 0); }

// ---- an IRET to a code segment whose DPL is not its RPL: #GP(selector), as a far RET -------------
// Windows NT 3.51 ends every V86 BIOS call (VideoPortInt10) with an IRETD whose CS is its ring-0 code
// selector with RPL 3 (000Bh), and resumes the caller from the #GP(0008) that follows (QEMU takes it).
// MIRAGE accepted the frame and ran ring 3 at a kernel address: VBEMP's first INT 10h never came
// back, and NT stayed in text mode where it should have switched to 1024x768.
{ const iretTo = (cs) => {
    const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem;
    const GDT = 0x8000;
    const desc = (i, base, limit, access, flags) => { const a = GDT + i * 8;
      mem.w16(a, limit & 0xffff); mem.w16(a + 2, base & 0xffff); mem.w8(a + 4, (base >> 16) & 0xff);
      mem.w8(a + 5, access); mem.w8(a + 6, flags | ((limit >> 16) & 0x0f)); mem.w8(a + 7, (base >> 24) & 0xff); };
    desc(1, 0x1000, 0xffff, 0x9a, 0);        // 08: ring-0 code
    desc(2, 0x3000, 0xffff, 0x92, 0);        // 10: ring-0 data/stack
    desc(3, 0x1000, 0xffff, 0xfa, 0);        // 18: ring-3 code
    desc(4, 0x3000, 0xffff, 0xf2, 0);        // 20: ring-3 data/stack
    cpu.gdtr = { base: GDT, limit: 0x2f }; cpu.cr0 |= 1;
    cpu.setSeg(CS, 0x08); cpu.setSeg(SS, 0x10); cpu.sp = 0x1000;
    for (const v of [0x23, 0x0800, 0x0202, cs, 0x0100]) cpu.push32(v);   // SS ESP EFLAGS CS EIP
    mem.blit(0x1000, Uint8Array.from([0x66, 0xcf, 0xf4]));                // iretd / hlt
    cpu.eip = 0;
    let got = null;
    mc.protInt = (n, err) => { got = { n, err, sp: cpu.sp, eip: cpu.eip }; cpu.halted = true; };
    mc.rec.step();
    return { got, cpu };
  };
  const bad = iretTo(0x0b);
  eq('IRETD to CS=000Bh (DPL 0, RPL 3) is #GP(0008h)', bad.got && `${bad.got.n},${bad.got.err}`, '13,8');
  eq('...delivered with the frame still on the stack', bad.got && bad.got.sp, 0x1000 - 20);
  eq('...at the IRET itself, still in ring 0', bad.got && `${bad.got.eip},${bad.cpu.cpl}`, '0,0');
  const good = iretTo(0x1b);
  eq('...while IRETD to a DPL-3 code segment at RPL 3 goes to ring 3', good.got === null && `${good.cpu.cpl},${good.cpu.seg[CS]},${good.cpu.eip}`, `3,${0x1b},${0x100}`); }

// ---- VBE 4F09h and the Attribute Controller's read-back: what tools/vbeprobe.asm saw under QEMU ------
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu, mem = mc.mem; const bios = installBIOS(mc);
  cpu.setSeg(ES, 0x0800); cpu.di = 0;
  mem.w8(0x8000, 0x21); mem.w8(0x8001, 0x22); mem.w8(0x8002, 0x23);          // entry: blue, green, red
  cpu.ax = 0x4f09; cpu.bx = 0x0000; cpu.cx = 1; cpu.dx = 5; mc.intHandlers[0x10](cpu, mc);
  eq('4F09h BL=00h loads the DAC from ES:DI, blue first', `${cpu.ax & 0xffff},${bios.dac[15]},${bios.dac[16]},${bios.dac[17]}`, `${0x4f},35,34,33`);
  cpu.di = 0x10; cpu.ax = 0x4f09; cpu.bx = 0x0001; cpu.cx = 1; cpu.dx = 5; mc.intHandlers[0x10](cpu, mc);
  eq('...and BL=01h reads it back in the same order', [0, 1, 2, 3].map((i) => mem.u8[0x8010 + i]).join(), '33,34,35,0');
  mc.portRead[0x3da](0x3da, 1);                                                  // reset the flip-flop
  mc.portWrite[0x3c0](0x3c0, 1, 0x32);                                           // PAS + index 12h
  const rd = (p) => (mc.portRead[p] ? mc.portRead[p](p, 1) & 0xff : -1);
  eq('3C0h reads back the Attribute Controller address register, PAS included', rd(0x3c0), 0x32);
  mc.portWrite[0x3c0](0x3c0, 1, 0x0f);                                           // data: plane enable
  mc.portRead[0x3da](0x3da, 1); mc.portWrite[0x3c0](0x3c0, 1, 0x32);
  eq('...and 3C1h the register it selects', rd(0x3c1), 0x0f); }

// ---- a mode set under a monitor that traps the VGA ports is replayed as OUTs it can see -------------
// Windows 95's VDD builds its copy of the card from trapped writes; ours came from JS, its copy kept
// CRTC 09h = 0 after mode 3, and it trapped the DAC for ever (the default palette on the desktop).
{ const trapped = (deny) => {
    const { mc, cpu } = v86(3); installBIOS(mc);
    const TSS = 0x9000;
    cpu.tr = { sel: 0x28, base: TSS, limit: 0x67 + 0x2000 / 8, is386: true };
    mc.mem.w16(TSS + 0x66, 0x68);
    if (deny) mc.mem.w8(TSS + 0x68 + (0x3d4 >> 3), 1 << (0x3d4 & 7));
    cpu.push16(0x3202); cpu.push16(0x0f40); cpu.push16(0x0200);
    cpu.setSeg(CS, 0xf000); cpu.eip = 0x10; cpu.ax = 0x0003;
    mc.biosCallback(0x10);
    return { mc, at: (cpu.seg[CS] << 16 | cpu.eip) >>> 0 };
  };
  const a = trapped(true), t = 0xf0000 + (a.mc.modeOutTable || 0);
  eq('INT 10h mode 3 with 3D4h trapped hands over to the ROM register load', a.at, (0xf000 << 16 | (a.mc.modeOutRom || 0)) >>> 0);
  eq('...whose table carries the mode\'s CRTC 09h (16-line characters)', a.mc.mem.u8[t + 1 + 5 + 9], 0x4f);
  eq('...and without a trap the mode set returns straight to the caller', trapped(false).at, 0x0f400200); }

// ---- the host clock, switched on after the chip is installed, re-seeds the century ----------------
// boot.html in real time: switching rtc.host alone left 19h at CMOS 32h (the 1990 epoch's century),
// INT 1Ah AH=04h answered 1926 and MS-DOS 6.22 fell back to 01-04-1980.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  if (mc.rtc.useHostClock) mc.rtc.useHostClock(); else mc.rtc.host = true;
  cpu.ax = 0x0400; mc.intHandlers[0x1a](cpu, mc);
  const y = new Date().getUTCFullYear(), bcd = (n) => ((n / 10 | 0) << 4) | (n % 10);
  eq('on the host clock, INT 1Ah AH=04h gives the host\'s century and year', cpu.cx & 0xffff, (bcd(y / 100 | 0) << 8) | bcd(y % 100)); }

// ---- DPMI: returning from INT 31h reloads the client's segment registers ----------------------
// tools/dpmireload.asm loads a selector into ES, FS, GS, DS and SS in turn, moves its base with
// AX=0007h and reads through the register: 'B' if the register was reloaded on the way out, 'A' if
// it kept the cached descriptor. CWSDPMI answers B five times under DOSBox-X and under QEMU (MS-DOS
// 6.22). DJGPP's crt0 counts on it: it widens DS and SS to 4 GiB with 0008h and goes on using both —
// Jump 'n Bump stopped on a #GP through DS, Quake on a #SS through SS, with the old limit cached.
{ const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc);
  const vfs = new VFS(), dos = installDOS(mc, vfs);
  const hex = (                                         // nasm -f bin tools/dpmireload.asm, 484 bytes
    'b44abb0010cd218c0ea402b43c31c9ba6002cd210f822801a3a602b88716cd2f85c00f851a01893ea8028c06aa0289f3' +
    'b448cd210f8208018ec0b80100ff1ea8020f82fb00b806008cdbcd318916ac02890eae0231c0b90100cd31a3b00289c3' +
    'b8080031c9baffffcd31be8502e8e3008e06b002be8602e8d90026a00000a26e02be8502e8cc008e26b002be8602e8c2' +
    '0064a00000a27302be8502e8b5008e2eb002be8602e8ab0065a00000a27802be8502e89e00be8602e88a008b1eb0021e' +
    '8edbb80700cd31a000001fa27d0231c0b90100cd31a398021e07b80b008cd366bf9c020000cd31b80c008b1e9802cd31' +
    '8c169a02be1000e84b008b1e98028ed3b80700cd3136a087028e169a02a282021e07c706ce020040a1a602a3c202c706' +
    'ca021a00c706c6026b02a1a402a3d602b80003bb210031c966bfb2020000cd31b8004ccd218b16ac028b0eae0201f283' +
    'd100c3e8efff8b1eb002b80700cd31c344504d49524c2e5458540045533d3f2046533d3f2047533d3f2044533d3f2053' +
    '533d3f0d0a4142412d2d2d2d2d2d2d2d2d2d2d2d2d2d2d42');
  const img = new Uint8Array(484); img.set(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
  dos.load(img, '', 'C:\\DPMIRL.COM');
  let guard = 0; while (!dos.programDone && guard++ < 2000) mc.runSlice(20000);
  const out = vfs.readFile('\\DPMIRL.TXT');
  eq('INT 31h returns with ES, FS, GS, DS and SS reloaded from the descriptor it changed',
    out && new TextDecoder().decode(out).trim(), 'ES=B FS=B GS=B DS=B SS=B'); }

// ---- the DOS player's memory: 16 MiB of RAM, and the VBE aperture above it, not inside it --------
// DOSBox-X's default 16 MiB machine offers 15,360 KB of XMS (its MEM command). With the linear
// framebuffer carved out of the top of 16 MiB of RAM, MIRAGE offered 11,200: Stash asks for one
// 12 MiB block, ignores the refusal, and cleared 10 MiB of memory at an address made of the error.
{ const mc = new Machine(DOS_PLAYER_MEM); installBIOS(mc); const cpu = mc.cpu;
  cpu.ax = 0x0800; cpu.xmsCall();
  eq('the DOS player has at least the 14,912 KB of free XMS DOSBox-X\'s 16 MiB machine has', (cpu.ax & 0xffff) >= 14912, true);
  eq('...because the VBE framebuffer is above the 16 MiB of RAM', mc.vbeFbBase >>> 0, 16 << 20);
  eq('...and INT 15h E801 reports the 16 MiB of RAM, not the 32 MiB address space', (() => { cpu.reg[0] = 0xe801; mc.intHandlers[0x15](cpu, mc); return [cpu.ax & 0xffff, cpu.bx & 0xffff].join(); })(), '15360,0'); }
// ?mem=64 (src/dos.js playerMem): 64 MiB of RAM, the aperture above it in a 128 MiB space.
{ const mc = new Machine(playerMem(64)); installBIOS(mc); const cpu = mc.cpu;
  eq('?mem=64: INT 15h E801 reports 64 MiB of RAM', (() => { cpu.reg[0] = 0xe801; mc.intHandlers[0x15](cpu, mc); return [cpu.ax & 0xffff, cpu.bx & 0xffff].join(); })(), '15360,768');
  eq('...the VBE framebuffer sits above it', mc.vbeFbBase >>> 0, 64 << 20);
  cpu.ax = 0x0800; cpu.xmsCall();
  eq('...and XMS offers more than 60 MiB of it', (cpu.ax & 0xffff) > 60 * 1024, true);
  eq('playerMem(16) is the default player machine', JSON.stringify(playerMem(16)), JSON.stringify(DOS_PLAYER_MEM)); }

// ---- POPF that sets TF: the trap comes after the next instruction, not at the end of the block ----
// tools/reptrap.asm sets TF with POPF, runs `rep stosb` (CX=5) and four more instructions, clears TF
// with POPF and counts INT 1. DOSBox-X: TRAPS=06, every one with CX=0 (the REP is one step); QEMU
// traps per iteration and prints 0B. Both trap; MIRAGE ran the traced code inside the POPF's block
// and printed TRAPS=00.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const vfs = new VFS(), dos = installDOS(mc, vfs);
  const hex = (                                         // nasm -f bin tools/reptrap.asm, 193 bytes
    'b80125ba6801cd210e07bfaa01b9050030c0fc9c580d00015030c09df3aa9c5825fffe509da09901bab201b409cd21a0' +
    '9901e84b00bab901b409cd2131f60fb62e990139ee73158a949a0180c230b402cd21b220cd214683fe1072e7babe01b4' +
    '09cd21b8004ccd21532e0fb61e990183fb1073052e888f9a012efe0699015bcf50c0e804e8030058240f04303c397602' +
    '040788c2b402cd21c30000000000000000000000000000000000000000000000000054524150533d242043583d240d0a' +
    '24');
  const img = new Uint8Array(193); img.set(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
  dos.load(img, '', 'C:\\REPTRAP.COM');
  let guard = 0; while (!dos.programDone && guard++ < 2000) mc.runSlice(2000);
  let line = ''; for (let r = 0; r < 25; r++) { let t = ''; for (let i = 0; i < 80; i++) { const ch = mc.mem.u8[0xb8000 + (r * 80 + i) * 2]; t += ch >= 32 ? String.fromCharCode(ch) : ' '; } if (t.includes('TRAPS=')) line = t.trim(); }
  eq('POPF setting TF traps the instructions after it, as DOSBox-X does', line, 'TRAPS=06 CX=0 0 0 0 0 0'); }

// ---- INT n under TF: no trap after it, none in its handler -------------------------------------------
// tools/inttrap.asm traces nop / int 60h / nop / mov ah,30h / int 21h / nop and prints the low byte of
// each trapped IP. DOSBox-X (normal and dynamic): nine traps, none at the INT 60h handler (6D) and none
// right after INT 21h (1F). MIRAGE trapped after every traced instruction, INT n included, so INT 1 was
// entered at the handler's first instruction with TF clear in its frame: Second Reality's INT 1 thread
// scheduler lost a thread's TF that way and ran into its anti-debug wipe of the IVT.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  const hex = (                                         // nasm -f bin tools/inttrap.asm, 206 bytes
    'b80125ba7301cd21b86025ba6d01cd219c580d0001509d90cd6090b430cd21909c5825fffe509da0ad01babf01b409cd21' +
    'a0ad01e85d00bac601b409cd2131f60fb62ead0183fd107603bd100039ee73108a84af01e83c00b220b402cd2146ebecba' +
    'cb01b409cd21b8004ccd212efe06ae01cf5589e5532e0fb61ead0183fb10730a508a46022e8887af01582efe06ad015b5d' +
    'cf50c0e804e8030058240f04303c397602040788c2b402cd21c300000000000000000000000000000000000054524150' +
    '533d242049503d240d0a24');
  const img = Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
  dos.load(img, '', 'C:\\INTTRAP.COM');
  let guard = 0; while (!dos.programDone && guard++ < 2000) mc.runSlice(2000);
  let line = ''; for (let r = 0; r < 25; r++) { let t = ''; for (let i = 0; i < 80; i++) { const ch = mc.mem.u8[0xb8000 + (r * 80 + i) * 2]; t += ch >= 32 ? String.fromCharCode(ch) : ' '; } if (t.includes('TRAPS=')) line = t.trim(); }
  eq('INT n under TF: no trap after it nor in its handler, as DOSBox-X', line, 'TRAPS=09 IP=18 1B 1D 20 21 22 25 26 27'); }

// ---- chained blocks without paging (recompiler.js translate, `exact`) -------------------------------
// tools/realchain.asm, chained and not, slice by slice under the timer: a chained block checks, wherever
// the block would have ended, what the dispatcher checks between two blocks, and counts its cycles there,
// so the instructions run, the slices and the cycle every timer interrupt lands at are the same -- the
// DOS golden runs are timed to the block. And it takes fewer dispatches. BYTE's Sieve: 3.0 instructions
// a dispatch before, 8.5 after (docs/notes/2026-11-03-sieve-profile.md).
{ let got;
  try {
    const img = Uint8Array.from('fa31c08ec026c70620005e01268c0e2200b036e64330c0e640b004e640fbb9004031f631ff31db4683fe07720331f64701f3031e6a014975eeb9003031d281faf02f7715428816530101d03d0080720231c0bd000001efebe5b8004ccd212eff066a0150b020e62058cf0000'.match(/../g), (x) => parseInt(x, 16));
    const run = (chain) => {
      const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); mc.timerAuto = true;
      const dos = installDOS(mc, new VFS()); mc.rec.realChain = chain;
      dos.load(img, '', 'C:\\RC.COM');
      const states = []; let dispatches = 0;
      for (let k = 0; k < 1000 && !dos.programDone; k++) {
        dispatches += mc.runSlice(97);
        states.push([mc.cpu.cycles, mc.cpu.eip, ...mc.cpu.reg, mc.mem.r16(0x46c)].join(','));
      }
      return { states, dispatches, done: dos.programDone };
    };
    const a = run(false), b = run(true);
    const firstDiff = a.states.findIndex((v, i) => v !== b.states[i]);
    got = [a.done && b.done, a.states.length === b.states.length, firstDiff, b.dispatches < a.dispatches].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('realmode chaining: the same instructions, slices and timer interrupts as unchained, in fewer dispatches', got, 'true true -1 true'); }

// A chained block decodes on past a side exit, into bytes that may never run: gcc puts a UD2 after a
// call that does not return, and CoreMark's DJGPP build stopped translating there ("unimplemented
// opcode 0f 0b") though the branch before it is always taken. Past a side exit the block now ends
// before what it cannot decode. `xor ax,ax; inc ax; jnz +2; ud2; mov ax,4c00h; int 21h`.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
    const dos = installDOS(mc, new VFS());
    dos.load(Uint8Array.of(0x31, 0xc0, 0x40, 0x75, 0x02, 0x0f, 0x0b, 0xb8, 0x00, 0x4c, 0xcd, 0x21), '', 'C:\\UD2.COM');
    for (let k = 0; k < 20 && !dos.programDone; k++) mc.runSlice(100);
    got = dos.programDone;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('a chained block ends before code it cannot decode past a side exit (a UD2 after a taken JNZ)', got, true); }
// The same for an instruction the CPU profile does not have: DOOM's DOS/4GW tests EFLAGS.ID and
// jumps over its CPUID on a 386, and on the 386 profile the chained block stopped translating there.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20, cpu: '386' }); installBIOS(mc);
    const dos = installDOS(mc, new VFS());
    dos.load(Uint8Array.of(0x31, 0xc0, 0x40, 0x75, 0x02, 0x0f, 0xa2, 0xb8, 0x00, 0x4c, 0xcd, 0x21), '', 'C:\\NOCPUID.COM');
    for (let k = 0; k < 20 && !dos.programDone; k++) mc.runSlice(100);
    got = dos.programDone;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('...and before a CPUID the 386 profile does not have, jumped over', got, true); }

// ---- x87: FSQRT under precision control, FPREM's condition codes and partial reduction, F2XM1 near 0 ----
// Against Docker's i386 QEMU (its 80-bit floatx80 x87), as PRISM probed them for .kkrieger, whose
// generator runs at 24 bits (cw 0x103F) and whose sFExp does fprem; f2xm1: fsqrt(2) at 24 bits is
// 3ff6a09e60000000; 7 fprem 2 leaves 1 with Q=3 (C3=Q1, C1=Q0); 1e30 fprem 1 reduces only partly and
// sets C2; f2xm1(-1e-6) is bea742163dc65d92, which 2^x-1 misses by some 1e5 ulp.
{ const bits = (dv, o) => dv.getBigUint64(o, true).toString(16).padStart(16, '0');
  const want = '3ff6a09e60000000 4200 400 bea742163dc65d92';
  let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);           // the recompiled path: nasm of the program in the comment
    const dos = installDOS(mc, new VFS());
    // fninit; fldcw 007Fh; fld 2; fsqrt; fstp [es:0]; fldcw 037Fh; fld 2; fld 7; fprem; fstsw [es:8]; fstp [es:16]; fstp st0;
    // fld1; fld 1e30; fprem; fstsw [es:24]; fstp st0; fstp st0; fld -1e-6; f2xm1; fstp [es:32]; exit (ES = 9000h)
    dos.load(Uint8Array.from(Buffer.from('b800908ec0dbe3d92e5301dd065701d9fa26dd1e0000d92e5501dd065701dd065f01d9f89b26dd3e080026dd1e1000ddd8d9e8dd066701d9f89b26dd3e1800ddd8ddd8dd066f01d9f026dd1e2000b8004ccd217f007f0300000000000000400000000000001c40ea8ca039593e29468dedb5a0f7c6b0be', 'hex')), '', 'C:\\X87PC.COM');
    for (let k = 0; k < 20 && !dos.programDone; k++) mc.runSlice(1000);
    const dv = new DataView(mc.mem.u8.buffer, 0x90000);
    got = [bits(dv, 0), (dv.getUint16(8, true) & 0x4700).toString(16), (dv.getUint16(24, true) & 0x4700).toString(16), bits(dv, 32)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('x87, recompiled: FSQRT at 24 bits, FPREM\'s C0-C3 and partial C2, F2XM1 near 0', got, want);
  const c = new Machine({ memSize: 1 << 20 }).cpu, f = new Float64Array(1), dv = new DataView(f.buffer);
  const run = (cw, a, b, op) => { c.fcw = cw; c.fsw = 0; c.ftop = 6; c.fst[6] = a; c.fst[7] = b; c.focc.fill(0); c.focc[6] = c.focc[7] = 1; c.fpuReg(0xd9, op[0], op[1]); f[0] = c.fst[c.ftop]; return bits(dv, 0); };
  const sq = run(0x7f, 2, 0, [7, 2]), sw1 = (run(0x37f, 7, 2, [7, 0]), c.fsw & 0x4700), sw2 = (run(0x37f, 1e30, 1, [7, 0]), c.fsw & 0x4700);
  eq('x87, interpreted (src/fpu.js): the same', [sq, sw1.toString(16), sw2.toString(16), run(0x37f, -1e-6, 0, [6, 0])].join(' '), want); }

// ---- the 8237 DMA controllers read back what was programmed (src/dma.js) ----------------------
// tools/dmaprobe.asm under QEMU and DOSBox-X: A1=1234 C1=0FFF P1=05 A3=4321 C3=07FF P3=0A. Every one
// of those read FFh here, and Void 3, which fills its sound buffer up to `0FFFh - count`, spun in its
// timer handler on a target it could not reach.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  const o = (p, v) => mc.ioWrite(p, 1, v), i = (p) => mc.ioRead(p, 1);
  o(0x0b, 0x59); o(0x0c, 0); o(0x02, 0x34); o(0x02, 0x12); o(0x03, 0xff); o(0x03, 0x0f); o(0x83, 0x05);
  o(0x0c, 0); o(0xc4, 0x78); o(0xc4, 0x56); o(0x8b, 0x07);                  // and channel 6, on the second controller
  const w = (p) => { o(0x0c, 0); o(0xd8, 0); const lo = i(p); return (i(p) << 8) | lo; };
  eq('8237: channel 1 address, count and page read back as written',
    [w(0x02), w(0x03), i(0x83)].map((v) => v.toString(16)).join(), '1234,fff,5');
  eq('...and channel 6 on the second controller', [(() => { o(0xd8, 0); const lo = i(0xc4); return (i(0xc4) << 8) | lo; })(), i(0x8b)].map((v) => v.toString(16)).join(), '5678,7'); }

// ---- running a .COM probe and reading what it wrote ---------------------------------------------
const runProbe = (hex, size, name, mem = 16 << 20, budget = 4000) => {
  const mc = new Machine({ memSize: mem }); installBIOS(mc);
  const vfs = new VFS(), dos = installDOS(mc, vfs);
  const img = new Uint8Array(size); img.set(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
  dos.load(img, '', 'C:\\' + name);
  let guard = 0; while (!dos.programDone && guard++ < budget) mc.runSlice(20000);
  return { mc, vfs };
};

// ---- DPMI: a PM hardware-interrupt handler runs on the host's locked stack ----------------------
// tools/dpmiphys.asm: DPMI AX=0800h maps a physical address -- 64 KiB at 8 MiB, written and read back
// through a selector on the linear address it gives -- and A0000h too. CWSDPMI under DOSBox-X:
// HI=0 RW=1 LO=0. MIRAGE's host answered 8001h, and Heaven Seven's DOS version said "VESA error".
{ const hex = (                                         // nasm -f bin tools/dpmiphys.asm, 391 bytes
    'b44abb0010cd218c0e4b02b43c31c9ba2602cd210f82ee00a34d02b88716cd2f85c00f85e000893e51028c06530289f3' +
    'b448cd210f82ce008ec0b80100ff1e51020f82c100b80008bb800031c9be010031ffcd31c6063602307307c606360231' +
    'eb49535131c0b90100cd31723ea34f0289c35a59b80700cd31b808008b1e4f0231c9baffffcd318e064f022666c70600' +
    '0178563412c6063b02302666813e0001785634127505c6063b0231b80008bb0a0031c931f6bf0010cd31c60640023073' +
    '15c6064002315088e0e83f00a3450258e83800a347021e07c70671020040a14d02a36502c7066d021800c70669023302' +
    'a14b02a37902b80003bb210031c966bf55020000cd31b8004ccd2188c4c0e804e80a0086c4240fe8030086c4c304303c' +
    '3976020407c344504d49504859532e5458540048493d3f2052573d3f204c4f3d3f2041583d3f3f3f3f0d0a0000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000');
  const { vfs } = runProbe(hex, 391, 'DPMIPHYS.COM');
  const out = vfs.readFile('\\DPMIPHYS.TXT');
  eq('DPMI: 0800h maps a physical address, as CWSDPMI does', out && new TextDecoder().decode(out).trim(), 'HI=0 RW=1 LO=0 AX=????'); }

// tools/dpmistack.asm: CWSDPMI under DOSBox-X and QEMU runs its IRQ 0 handler on another SS, and 64
// bytes below the client's ESP survive five ticks. Void 3 keeps its scratch there (`lea esi,[esp-7Eh]`);
// with the frame on the client's stack its blitter read a width of millions and drew nothing.
{ const hex = (                                         // nasm -f bin tools/dpmistack.asm, 462 bytes
    'b44abb0010cd218c0e8802b43c31c9ba5d02cd210f82fd00a38a02b88716cd2f85c00f85ef00893e8c028c068e0289f3' +
    'b448cd210f82dd008ec0b80100ff1e8c020f82d0008c0e90028c1692028c1e9402b80402b308cd316689169602890e9a' +
    '02b80502b3088cc966ba1a020000cd316689e76683ef40160766b91000000066b8a55aa55a26676689076683c704e2f5' +
    'fb803e85020572f96689e76683ef4066b910000000c606870231366766813fa55aa55a7405c6068702306683c704e2ea' +
    'b80502b3088b0e9a02668b169602cd31a08502e86c00a36f02a08602a27902a08702a282021e07c706b8020040a18a02' +
    'a3ac02c706b4021c00c706b0026902a18802a3c002b80003bb210031c966bf9c020000cd31b8004ccd211e66502ea194' +
    '028ed8fe0685028cd03b069202c6068602317405c60686023066581f2e66ff2e960288c4c0e804e80a0086c4240fe803' +
    '0086c4c304303c3976020407c344504d4953544b2e545854005449434b533d3f3f2053414d4553533d3f20494e544143' +
    '543d3f0d0a003f3f');
  const { vfs } = runProbe(hex, 462, 'DPMISTK.COM');
  const out = vfs.readFile('\\DPMISTK.TXT');
  eq('DPMI: the IRQ 0 handler runs on another stack, and below the client\'s ESP is left alone',
    out && new TextDecoder().decode(out).trim(), 'TICKS=05 SAMESS=0 INTACT=1'); }

// tools/dpminest.asm: an IRQ 0 handler leaves the host's locked stack for its own, and the next tick
// nests in it (DOOM's DMX does this, its Sound Blaster IRQ arriving inside its timer handler). CWSDPMI
// under DOSBox-X: the outer handler returns, and a marker it left on the host's stack survives. MIRAGE
// started every switch at the top of the locked stack, over the outer frame: #GP at the outer return.
{ const hex = (                                         // nasm -f bin tools/dpminest.asm, 464 bytes
    'b44abb0010cd218c0e8802b43c31c9ba5c02cd210f82b200a38a02b88716cd2f85c00f85a400893e8c028c068e0289f3' +
    'b448cd210f8292008ec0b80100ff1e8c020f8285008c1e9002b80402b308cd316689169802890e9c02b80502b3088cc9' +
    '66bacf010000cd31fb803e84020272f9fab80502b3088b0e9c02668b169802cd31fba08402e8b900a36f02a08502e8b0' +
    '00a37902a08702a281021e07c706ba020040a18a02a3ae02c706b6021b00c706b2026902a18802a3c202b80003bb2100' +
    '31c966bf9e020000cd31b8004ccd211e66502ea190028ed8803e8602007555c60686020166686824571366892692028c' +
    '1696028cd88ed066bcd0040000b020e620fba085023a06850274fafa660fb22692026766813c24682457137405c60687' +
    '02306683c404fe068402c60686020066581f66cffe068502b020e62066581f66cf88c4c0e804e80a0086c4240fe80300' +
    '86c4c304303c3976020407c344504d494e4553542e545854004f555445523d3f3f204e45535445443d3f3f204d41524b' +
    '3d3f0d0a0000003100000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000');
  let got;
  try { const out = runProbe(hex, 464, 'DPMINEST.COM').vfs.readFile('\\DPMINEST.TXT'); got = out && new TextDecoder().decode(out).trim(); }
  catch (e) { got = e.message; }
  eq('DPMI: an IRQ nested in a handler that left the locked stack does not overwrite its frame',
    got, 'OUTER=02 NESTED=02 MARK=1'); }

// ---- DPMI: selector 0040h is the BIOS data area -------------------------------------------------
// tools/sel40.asm: CWSDPMI under DOSBox-X gives a client 0040h in its GDT, base 400h, limit FFFFh,
// a ring-3 data segment (LAR F200). DOS/4GW 1.97 (C-Dogs) loads it as it stands; with no GDT of
// ours that was #GP(40h).
{ const hex = (                                         // nasm -f bin tools/sel40.asm, 367 bytes
    'b44abb0010cd218c0e3502a12c000631c08ec026a1100407a33302b43c31c9bafa01cd210f82b500a33702b88716cd2f' +
    '85c00f85a700893e39028c063b0289f3b448cd210f8295008ec0b80100ff1e39020f828800c7063102addeb840000f02' +
    'c8c6062c0230751bc6062c0231890e2d020f03c8890e2f02068ec026a11000a3310207bf0802a12d02e85600bf1102a1' +
    '2f02e84d00bf1902a13102e84400bf2102a13302e83b00a02c02a229021e07c70659020040a13702a34d02c706550228' +
    '00c70651020402a13502a36102b80003bb210031c966bf3d020000cd31b8004ccd21b90400c1c00450240f04303c3976' +
    '02040788054758e2ecc353454c34302e545854004c41523d3f3f3f3f204c534c3d3f3f3f3f2045513d3f3f3f3f20524d' +
    '3d3f3f3f3f205a463d3f0d0a3f0000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000');
  const out = runProbe(hex, 367, 'SEL40.COM').vfs.readFile('\\SEL40.TXT');
  const got = out ? new TextDecoder().decode(out).trim() : '';
  const m = /EQ=(\w+) RM=(\w+)/.exec(got);
  eq('DPMI: selector 0040h is a data segment on the BIOS data area',
    got.replace(/EQ=\w+ RM=\w+/, m && m[1] === m[2] ? 'EQ=RM' : 'EQ!=RM'), 'LAR=F200 LSL=FFFF EQ=RM ZF=1'); }

// tools/pmkey.asm: INT 16h AH=00 from a 32-bit client before any key is typed, called through the
// vector 0204h reports, as DOS/4GW chains to it. A waiting service is retried at its stub; reloading CS=F000 for that is #GP(F000) in protected mode, and DSETUP32 (C-Dogs'
// sound setup) never saw a key.
{ const hex = (                                         // nasm -f bin tools/pmkey.asm, 253 bytes
    'b44abb0010cd218c0ebd01b43c31c9baa901cd217276a3bf01b88716cd2f85c0756a893ec1018c06c30189f3b448cd21' +
    '725a8ec0b80100ff1ec101724fb80402b316cd31668916c501890ec90130e4669c66ff1ec501bfb701e835001e07c706' +
    'e7010040a1bf01a3db01c706e3010a00c706df01b301a1bd01a3ef01b80003bb210031c966bfcb010000cd31b8004ccd' +
    '21b90400c1c00450240f04303c397602040788054758e2ecc3504d4b45592e545854004b45593d3f3f3f3f0d0a000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000');
  const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc);
  const vfs = new VFS(), dos = installDOS(mc, vfs);
  const img = new Uint8Array(253); img.set(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
  dos.load(img, '', 'C:\\PMKEY.COM');
  let got;
  try {
    for (let i = 0; i < 200 && !dos.programDone; i++) mc.runSlice(20000);
    mc.keyQueue.push({ scan: 0x1c, ascii: 13 });
    for (let i = 0; i < 2000 && !dos.programDone; i++) mc.runSlice(20000);
    const out = vfs.readFile('\\PMKEY.TXT'); got = out && new TextDecoder().decode(out).trim();
  } catch (e) { got = e.message; }
  eq('DPMI: INT 16h waiting for a key from protected mode gets it', got, 'KEY=1C0D'); }

// ---- DPMI: what Borland's RTM needs from the host (Jazz Jackrabbit) -----------------------------
// tools/rtmhost.asm, one letter per check, '1' when it holds: V 0400h Get Version (CL = 3, our 386);
// M the "MS-DOS" vendor API (INT 2Fh AX=168Ah) and its LDT alias; I/G/P INT 21h AH=34h, 35h and
// 51h/50h/62h answering selectors, not paragraphs, in protected mode; F INT 10h AX=1130h the same;
// D INT 10h AX=1012h reading ES:DX through a selector's base; N a LES of a not-present selector
// restarted by a #NP handler that writes below the client's SP (the frame is on the locked stack);
// R a 0306h raw switch to real mode and back, landing at ring 3 with IOPL 3. Each of these stopped
// Jazz Jackrabbit in turn. Not oracle-checked against another host: CWSDPMI has no "MS-DOS" API.
{ const hex = (                                         // nasm -f bin tools/rtmhost.asm, 799 bytes
    'b44abb0010cd218c0ec303b43c31c9baa203cd210f823302a3c503b88716cd2f85c00f852502893ec7038c06c90389f3' +
    'b448cd210f8213028ec031c0ff1ec7030f8207028c0edd038c1edf038c16e103b8000431c9cd3183f85a750a80f90375' +
    '05c606b50331b88a16beae03cd2f84c07524893ecb038c06cd03b80001ff1ecb0372138ee08ccb83e3f864807f05fa75' +
    '05c606b60331b434cd2126803f007505c606b70331b80402b309cd318916cf03890ed103b80935cd213b1ecf03750d8c' +
    'c03b06d1037505c606b80331b451cd21891ed303b80600cd31a1c303c1c00489c383e0f083e30f39c2751b39d975178b' +
    '1ed303b450cd21b462cd213b1ed3037505c606b9033155b83011b706cd105d8cc08ee0c606ba03311e07b81210bb0100' +
    'b90100bac003cd10bac703b001eebac903ec88c4ec3d2211750aec3c337505c606bb033131c0b90100cd317266a3d503' +
    '89c3b807008b0ec303c1c10489ca83e2f083e10fcd31b808008b1ed50331c9baffffcd31b809008b1ed503b97200cd31' +
    'b80302b30b8cc9ba5003cd31a1d503a3d903bf3412c43ed70381ff785675148cc03b06d503750c803edb03017505c606' +
    'bc0331b80603cd31890ee503891ee703893ee9038936eb038926e303a1c30389c189c289e389c6bfde02ff2ee9038cc8' +
    '3b06c3037505c606dc03016802029da1df0389c18b16e1038b1ee3038b36dd03bf0703ff2ee503fafb3b26e303750c80' +
    '3edc03017505c606bd03311e07c70609040040a1c503a3fd03c70605040b00c7060104b503a1c303a31104b80003bb21' +
    '0031c966bfed030000cd31b8004ccd215589e55053068e46108b5e0e26c747feadde26c747fcadde26c747faadde26c7' +
    '47f8adde26c747f6adde26c747f4adde26c747f2adde26c747f0addeb809008b1ed503b9f200cd31c606db0301075b58' +
    '5dcb52544d484f53542e545854004d532d444f53003030303030303030300d0a11223300000000000000000000000000' +
    '000000000000007856000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000');
  let got;
  try { const out = runProbe(hex, 799, 'RTMHOST.COM').vfs.readFile('\\RTMHOST.TXT'); got = out && new TextDecoder().decode(out).trim(); }
  catch (e) { got = e.message; }
  eq('DPMI: RTM\'s host services (V M I G P F D N R)', got, '111111111'); }

// ---- MIRAGE-LINUX (src/linux.js): static i386 ELF programs, system calls answered in JS ---------
// The oracle is a real kernel: `docker run --platform linux/386 i386/debian` on the same binaries.
const runLinux = (hex, argv) => {
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
  lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), argv);
  for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
  return { out: new TextDecoder().decode(Uint8Array.from(lx.stdout)), status: lx.done ? lx.status : -1 };
};
// tools/linux/hello.asm: the initial stack (argc, argv) and write/exit. Docker: "argc=3\n/w/HELLO\na\nbc\n", 42.
{ const hex = (                                         // nasm -f bin tools/linux/hello.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408b7000000b7000000070000000010000089e6ad89c50430a2b4800408' +
    'b9af800408ba07000000e8330000004d7824ad89c131d2803c1100740342ebf7e81d000000b9b6800408ba01000000e8' +
    '0e000000ebd9b801000000bb2a000000cd80b804000000bb01000000cd80c3617267633d3f0a0a');
  const r = runLinux(hex, ['/w/HELLO', 'a', 'bc']);
  eq('linux: argv on the initial stack, write and exit', JSON.stringify(r), JSON.stringify({ out: 'argc=3\n/w/HELLO\na\nbc\n', status: 42 })); }
// tools/linux/fpu80.asm: an 80-bit store to the stack at BFFFxxxxh, far above physical memory, under
// paging. Docker: 3. MIRAGE masked the linear address to the size of RAM: SIGSEGV, 139.
{ const hex = (                                         // nasm -f bin tools/linux/fpu80.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040873000000730000000500000000100000d9e8d9e8dcc0dec1db7c24e0' +
    'db6c24e0db5c24f88b5c24f8b801000000cd80');
  eq('linux: FSTP TBYTE under paging stores at the linear address', runLinux(hex, ['/w/FPU80']).status, 3); }
// tools/linux/fileio.asm: open(O_CREAT), write, lseek, read, fstat64 on the in-memory file system.
// Docker: "cde6", status 3 (the descriptor).
{ const hex = (                                         // nasm -f bin tools/linux/fileio.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408f0000000001100000700000000100000b805000000bbdb800408b942' +
    '000000baa4010000cd8089c7b80400000089fbb9e6800408ba06000000cd80b81300000089fbb90200000031d2cd80b8' +
    '0300000089fbb9ec800408ba03000000cd80b8c500000089fbb900900408cd80a02c9004080430a2ef800408b8040000' +
    '00bb01000000b9ec800408ba04000000cd80b80100000089fbcd8066696c65696f2e746d70006162636465663f3f3f3f');
  eq('linux: a file is created, written, sought, read back and stat-ed', JSON.stringify(runLinux(hex, ['/w/FILEIO'])), JSON.stringify({ out: 'cde6', status: 3 })); }
// tools/linux/sigabrt.asm: a write 2 MiB below ESP (the stack grows on demand), then tkill(SIGABRT).
// Docker: 134. MIRAGE had 256 KiB of stack (139) and no tkill.
{ const hex = (                                         // nasm -f bin tools/linux/sigabrt.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004087a0000007a0000000500000000100000c684240000e0ff01b8140000' +
    '00cd8089c3b8ee000000b906000000cd80b80100000031dbcd80');
  eq('linux: the stack grows on demand, and SIGABRT to oneself ends with 134', runLinux(hex, ['/w/SIGABRT']).status, 134); }
// tools/linux/ud2.asm: Docker 132 (SIGILL). MIRAGE threw "unimplemented opcode 0x0f 0x0b".
{ const hex = (                                         // nasm -f bin tools/linux/ud2.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408560000005600000005000000001000000f0b');
  let got; try { got = runLinux(hex, ['/w/UD2']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: an invalid opcode is SIGILL', got, 132); }
// tools/linux/pipewait.asm: two processes at once — the child reads a pipe before its parent writes
// it and waits for the byte. Docker: 88. One process at a time, the child read EOF and exited 0.
{ const hex = (                                         // nasm -f bin tools/linux/pipewait.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408cb000000db0000000700000000100000b82a000000bbcb800408cd80' +
    'b802000000cd8085c07525b8030000008b1dcb800408b9d3800408ba01000000cd800fb61dd3800408b801000000cd80' +
    'b8040000008b1dcf800408b9ca800408ba01000000cd80b872000000bbffffffffb9d780040831d231f6cd800fb61dd8' +
    '800408b801000000cd805800000000000000000000000000000000');
  let got; try { got = runLinux(hex, ['/w/PIPEWAIT']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: a child waits on a pipe its parent writes later (two processes at once)', got, 88); }
// tools/linux/dsp.asm: /dev/dsp set up as OSS programs do — rate, format, stereo, GETOSPACE's geometry,
// a write. 31 when all hold; with no /dev/dsp the open failed and it was 0.
{ const hex = (                                         // nasm -f bin tools/linux/dsp.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004083301000047110000070000000010000031ffb805000000bb1e810408' +
    'b901000000cd8085c00f8898000000a333810408b9025004c0ba27810408e88d000000813d27810408112b0000750383' +
    'cf01b9055004c0ba2b810408e86f000000833d2b81040810750383cf02b9035004c0ba2f810408e854000000b90c5010' +
    '80ba37810408e845000000833d3b81040810750383cf04813d3f81040800100000750383cf08b8040000008b1d338104' +
    '08b947810408ba00100000cd803d00100000750383cf1089fbb801000000cd80b8360000008b1d33810408cd80c32f64' +
    '65762f64737000112b00001000000001000000');
  let got; try { got = runLinux(hex, ['/w/DSP']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: /dev/dsp takes OSS rate, format, stereo, answers GETOSPACE, plays a write', got, 31); }
// The page's mouse on /dev/mouse, as a Microsoft serial mouse: 01LRYYXX, X's low six bits, Y's — decoded
// the way SVGAlib's ms handler does (dx = (b0 & 3) << 6 | b1, dy = (b0 & 0Ch) << 4 | b2, signed bytes).
// Nothing fed it: SVGAlib programs (Quake's aim) had no mouse in the page.
{ let got;
  try { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.mouseInput(5, -3, 1); lx.mouseInput(200, 0, 2);
    const p = lx.mouseIn, dec = (i) => [((p[i] & 3) << 6 | p[i + 1]) << 24 >> 24, ((p[i] & 0x0c) << 4 | p[i + 2]) << 24 >> 24, (p[i] >> 5) & 1, (p[i] >> 4) & 1, (p[i] >> 6) & 1];
    got = [dec(0), dec(3), dec(6)].map((x) => x.join(',')).join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: the mouse as Microsoft serial packets, a large move split', got, '5,-3,1,0,1 127,0,0,1,1 73,0,0,1,1'); }
// ...and on /dev/input/mice as Linux's mousedev gives it to gpm and X: PS/2 packets — 08h set, buttons in
// bits 0-1, the signs in bits 4-5, then dX and dY with Y UP.
{ let got;
  try { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.mouseInput(5, -3, 1); lx.mouseInput(-2, 4, 2);
    got = lx.miceIn.map((b) => b.toString(16)).join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: /dev/input/mice as PS/2 packets, Y up', got, '9 5 3 3a fe fc'); }
// tools/linux/fb.asm: /dev/fb0 as fbset, fbsplash and Xfbdev use it — its two screen infos, an mmap of the
// card's framebuffer, a pixel written there and read back. 63 when all hold; with no /dev/fb0, 0.
{ const hex = (                                         // nasm -f bin tools/linux/fb.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004085f0100004b020000070000000010000031ffb805000000bb56810408' +
    'b902000000cd8085c00f88de000000a35f810408b8360000008b1d5f810408b900460000ba67810408cd80813d678104' +
    '0880020000750383cf01813d6b810408e0010000750383cf02833d7f81040820750383cf04b8360000008b1d5f810408' +
    'b902460000ba07820408cd80813d33820408000a0000750383cf08b8c000000031dbb900c01200ba03000000be010000' +
    '0055bd00000000578b3d5f810408cd805f5d3d00f0ffff774483cf10c74004ff00ff00b8130000008b1d5f810408b904' +
    '00000031d2cd80b8030000008b1d5f810408b963810408ba04000000cd80813d63810408ff00ff00750383cf2089fbb8' +
    '01000000cd802f6465762f66623000');
  let got;
  try { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc);   // a machine with its card
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/FB']);
    for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
    got = lx.done ? lx.status : -1;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: /dev/fb0 — screen infos, mmap onto the card, a pixel read back', got, 63); }
// src/hle/fxmesa.js: libMesaGL.so.2 for the 3dfx games (GLQuake 0.97, Quake II's ref_gl.so) -- fxMesa's
// full screen at a Glide resolution (7: 640x480, 15: 400x300), Glide's SST_GAMMA, the swap paced at sixty a second, and the
// names they find it by (libGL.so for ref_gl's dlopen) with OpenGL's entry points beside fxMesa's.
{ let got;
  try { const { fxmesa } = await import('../src/hle/fxmesa.js'), { gl } = await import('../src/hle/gl.js'), { traceBackend } = await import('../src/hle/trace.js');
    const lib = fxmesa(gl()), be = traceBackend(); let t = 1;
    const x = { backend: be, alloc: () => 0x1000, w32: () => {}, lx: { mono: () => t, getenv: (n) => (n === 'SST_GAMMA' ? '1.6' : null) }, waitUntil: () => 'wait' };
    const call = (n, ...a) => lib.fns[n][1](x, ...a), modes = [];
    call('fxMesaCreateContext', 0, 7, 0, 0); modes.push(`${be.mode.w}x${be.mode.h}${be.mode.opengl ? 'gl' : ''}`);
    call('fxMesaCreateContext', 0, 15, 0, 0); modes.push(`${be.mode.w}x${be.mode.h}`);
    const s1 = call('fxMesaSwapBuffers'); t += 0.001; const s2 = call('fxMesaSwapBuffers'); t += 0.02; const s3 = call('fxMesaSwapBuffers');
    got = [...modes, be.gamma, s1, s2, s3, be.frames, lib.soname, lib.links.includes('libGL.so'), !!lib.fns.glVertex3f, !!lib.fns.fxMesaMakeCurrent].join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('hle: fxMesa -- Glide resolutions, a paced swap, libMesaGL.so.2 as libGL.so', got, '640x480gl 400x300 1.6 0 wait 0 2 libMesaGL.so.2 true true true'); }
// lx.getenv for the libraries made in JavaScript: the environment as the process changed it, through the
// __environ its ELF defines (.dynsym) -- Quake II's ref_gl putenvs SST_GAMMA and Glide read it there.
// An ELF of three sections (null, .dynsym, .dynstr) whose __environ is at 0x9000; the array it points
// to holds "A=1" and "SST_GAMMA=1.6".
{ let got;
  try { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.prepareSpace(); lx.mapRange(0x9000, 0xa000, true);
    const elf = new Uint8Array(0x200), v = new DataView(elf.buffer);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]); v.setUint16(16, 2, true);
    v.setUint32(32, 0x100, true); v.setUint16(46, 40, true); v.setUint16(48, 3, true);
    const sh = (i, type, off, size, link) => { const b = 0x100 + 40 * i; v.setUint32(b + 4, type, true); v.setUint32(b + 16, off, true); v.setUint32(b + 20, size, true); v.setUint32(b + 24, link, true); };
    sh(1, 11, 0x80, 32, 2); sh(2, 3, 0x40, 16, 0);
    elf.set([...Buffer.from('\0__environ\0')], 0x40);
    v.setUint32(0x90, 1, true); v.setUint32(0x94, 0x9000, true); v.setUint16(0x9e, 5, true);   // symbol 1: name 1, value, shndx 5
    lx.elfMaps = [{ at: 0, data: elf }];
    const put = (va, bytes) => lx.wrBytes(va, bytes);
    const wr32 = (va, x) => put(va, Uint8Array.of(x & 255, (x >> 8) & 255, (x >> 16) & 255, x >>> 24));
    wr32(0x9000, 0x9010); wr32(0x9010, 0x9100); wr32(0x9014, 0x9110); wr32(0x9018, 0);
    put(0x9100, Uint8Array.from(Buffer.from('A=1\0'))); put(0x9110, Uint8Array.from(Buffer.from('SST_GAMMA=1.6\0')));
    got = [lx.symbol('__environ').toString(16), lx.getenv('SST_GAMMA'), lx.getenv('B')].join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: lx.getenv -- the environment through the ELF\'s __environ', got, '9000 1.6 '); }
// src/wise.js: a Wise installer read without running it (Half-Life's Uplink demo, hluplink.exe) -- after
// the stub's last section, raw deflate streams each followed by a CRC: the script, then the files, whose
// offsets the script gives from where the first file's stream begins. A synthetic one: a PE header of one
// section, a script naming two files (and a stray "%" that is no entry), the files.
{ let got;
  try { const { unwise, wiseLayer } = await import('../src/wise.js'), z = await import('zlib');
    const crc = new Uint8Array(4), d1 = z.deflateRawSync(Buffer.from('hello')), d2 = z.deflateRawSync(Buffer.from('world!!'));
    const entry = (name, start, end, size) => { const e = new Uint8Array(43 + name.length + 1), v = new DataView(e.buffer);
      v.setUint32(3, start, true); v.setUint32(7, end, true); v.setUint32(15, size, true); e.set(Buffer.from(name), 43); return e; };
    const script = Buffer.concat([Buffer.from('%TEMP% noise\0'), entry('%MAINDIR%\\a.txt', 0, d1.length + 4, 5), entry('%MAINDIR%\\sub\\b.txt', d1.length + 4, d1.length + d2.length + 8, 7)]);
    const ds = z.deflateRawSync(script), head = new Uint8Array(0x80), hv = new DataView(head.buffer);
    head.set([0x4d, 0x5a]); hv.setUint32(0x3c, 0x40, true); head.set([0x50, 0x45], 0x40); hv.setUint16(0x46, 1, true); hv.setUint16(0x54, 0, true);
    hv.setUint32(0x58 + 16, 0x80, true); hv.setUint32(0x58 + 20, 0, true);   // one section: 80h bytes from 0
    const exe = new Uint8Array(Buffer.concat([head, ds, crc, d1, crc, d2, crc]));
    const files = await unwise(exe), layer = await wiseLayer(exe, { wise: 'x', into: '/hl' });
    got = [files.map((f) => `${f.path}=${new TextDecoder().decode(f.bytes)}`).join(','), layer.map((f) => f.to).join(',')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('wise: an installer\'s files from its script, without running it', got, '%MAINDIR%\\a.txt=hello,%MAINDIR%\\sub\\b.txt=world!! /hl/a.txt,/hl/sub/b.txt'); }
// src/didi.js: Epic MegaGames' installer (Jazz Jackrabbit 2's shareware, JAZZ2SWF.EXE) -- after the stub,
// "DiDi", then a record per file whose blocks (a table of their sizes, each a CRC and deflate bytes) are
// pieces of ONE zlib stream running across files, a new stream at a group's first file. A synthetic one:
// a.txt (20000 bytes, two blocks) and HTML\\b.txt in one stream -- b's bytes backreferencing a's -- and
// c.txt in a second.
{ let got;
  try { const { undidi, didiLayer } = await import('../src/didi.js'), z = await import('zlib');
    const A = Buffer.from('0123456789abcdef'.repeat(1250)), B = Buffer.from('0123456789abcdef'.repeat(3) + '!'), C = Buffer.from('second stream');
    const s1 = z.deflateSync(Buffer.concat([A, B])), s2 = z.deflateSync(C), cut = s1.length >> 1, cut2 = s1.length - 3;
    const rec = (name, size, blocks) => {
      const table = Buffer.alloc(2 * blocks.length), body = blocks.map((d) => Buffer.concat([Buffer.alloc(4), d]));
      body.forEach((d, i) => table.writeUInt16LE(d.length, 2 * i));
      const data = Buffer.concat([table, ...body]), h = Buffer.alloc(30);
      h.write('FILE'); h.writeUInt32LE(size, 4); h.writeUInt32LE(data.length, 8); h.writeUInt16LE(name.length, 28);
      return Buffer.concat([h, Buffer.from(name), data]);
    };
    const head = Buffer.alloc(0x80); head.write('MZ'); head.writeUInt32LE(0x40, 0x3c); head.write('PE', 0x40); head.writeUInt16LE(1, 0x46);
    head.writeUInt32LE(0x80, 0x58 + 16);                                        // one section: 80h bytes from 0
    const didi = Buffer.alloc(40); didi.write('DiDi');
    const exe = new Uint8Array(Buffer.concat([head, didi, rec('a.txt', A.length, [s1.subarray(0, cut), s1.subarray(cut, cut2)]),
      rec('HTML\\b.txt', B.length, [s1.subarray(cut2)]), rec('c.txt', C.length, [s2])]));
    const files = undidi(exe), layer = didiLayer(exe, { didi: 'x', into: '/jj2' });
    got = [files.map((f) => `${f.path}=${f.bytes.length}`).join(','), new TextDecoder().decode(files[1].bytes.slice(-1)), new TextDecoder().decode(files[2].bytes), layer.map((f) => f.to).join(',')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('didi: an Epic installer\'s files, one zlib stream across them', got, 'a.txt=20000,HTML\\b.txt=49,c.txt=13 ! second stream /jj2/a.txt,/jj2/HTML/b.txt,/jj2/c.txt'); }
// src/win32/avi.js: an AVI as MCI's video plays it -- RIFF AVI, its 8-bit stream's palette, its RLE8 frames
// drawn over the one before (a run, literal bytes padded to a word, a jump, a line's end), a palette change,
// its PCM sound put end to end. Half-Life's intro is one. A synthetic 6 x 2 one: frame 1 a run of 3 and 3
// literal bytes, then a jump to the second line; frame 2 changes one pixel of the first line only.
{ let got;
  try { const { parseAvi, decodeFrame } = await import('../src/win32/avi.js');
    const ck = (id, body) => { const b = new Uint8Array(8 + body.length + (body.length & 1)); b.set(new TextEncoder().encode(id)); new DataView(b.buffer).setUint32(4, body.length, true); b.set(body, 8); return b; };
    const list = (t, ...parts) => ck('LIST', Uint8Array.from([...new TextEncoder().encode(t), ...parts.flatMap((p) => [...p])]));
    const u32 = (...v) => { const b = new Uint8Array(4 * v.length), d = new DataView(b.buffer); v.forEach((n, i) => d.setUint32(4 * i, n, true)); return b; };
    const avih = ck('avih', u32(40000, 0, 0, 0, 2, 0, 1, 0, 6, 2, 0, 0, 0, 0));
    const bih = new Uint8Array(40 + 8), bv = new DataView(bih.buffer);
    bv.setUint32(0, 40, true); bv.setInt32(4, 6, true); bv.setInt32(8, 2, true); bv.setUint16(12, 1, true); bv.setUint16(14, 8, true); bv.setUint32(16, 1, true); bv.setUint32(32, 2, true);
    bih.set([0x00, 0x00, 0xff, 0, 0xff, 0x00, 0x00, 0], 40);                                  // colours 0 red, 1 blue
    const vstrl = list('strl', ck('strh', Uint8Array.from([...new TextEncoder().encode('vidsmrle'), ...new Uint8Array(48)])), ck('strf', bih));
    const astrl = list('strl', ck('strh', Uint8Array.from([...new TextEncoder().encode('auds'), ...new Uint8Array(52)])), ck('strf', Uint8Array.of(1, 0, 1, 0, 0x22, 0x56, 0, 0, 0x22, 0x56, 0, 0, 1, 0, 8, 0)));
    // RLE8 rows are bottom-up: the DIB's first row is the picture's last.
    const f1 = Uint8Array.of(3, 1, 0, 3, 0, 1, 0, 0, 0, 0, 6, 1, 0, 1);              // bottom: 1 1 1 0 1 0; end of line; top: 1 x6; end
    const f2 = Uint8Array.of(0, 2, 2, 1, 1, 0, 0, 1);                                 // jump to (2, 1) -- the top line -- one pixel of 0; end
    const movi = list('movi', ck('00dc', f1), ck('01wb', Uint8Array.of(10, 20)), ck('00pc', Uint8Array.of(1, 1, 0, 0, 0x11, 0x22, 0x33, 0)), ck('00dc', f2), ck('01wb', Uint8Array.of(30)));
    const riff = ck('RIFF', Uint8Array.from([...new TextEncoder().encode('AVI '), ...list('hdrl', avih, vstrl, astrl), ...movi]));
    const a = parseAvi(riff), idx = new Uint8Array(12), pal = a.palette.slice();
    for (const f of a.frames) decodeFrame(f, idx, a.w, a.h, pal);
    got = [a.w, a.h, a.codec, a.frames.map((f) => f.kind).join(''), [...idx].join(''), pal[0].toString(16), pal[1].toString(16), [...a.audio.data].join('.')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('avi: RIFF AVI, RLE8 over the frame before, a palette change, its PCM', got, '6 2 rle8 dcpcdc 110111111010 ff0000 112233 10.20.30'); }
// tools/linux/lazymap.asm: anonymous memory larger than the machine (Quake II's hunks) -- 32 MiB mmapped on
// a 16 MiB machine, its ends written and read back, mprotect and write() on pages never touched, munmap.
// 31 when all hold; committed whole at mmap, it ran out of physical memory.
{ const hex = (
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004080b0100000b010000070000000010000031ff57b8c000000031dbb900' +
    '000002ba03000000be22000000bfffffffff31edcd805f3d00f0ffff0f878000000083cf0189c5c7450078563412c785' +
    'fcffff01f0debc9a817d0078563412750f81bdfcffff01f0debc9a750383cf02b87d0000008d9d00001000b900100000' +
    'ba01000000cd8085c0750383cf04b804000000bb010000008d8d00002000ba04000000cd8083f804750383cf08b85b00' +
    '000089ebb900000002cd8085c0750383cf1089fbb801000000cd80');
  let got;
  try { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/LAZYMAP']);
    for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
    got = lx.done ? lx.status : -1;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: anonymous mmap larger than memory, committed page by page', got, 31); }
// tools/linux/oldcalls.asm: libc5's calls — creat with a mode kept (0755: ld's output runs), fcntl 55 with
// FD_CLOEXEC, getdents 141 and readdir 89. 15; Docker (qemu-user on this host) 7, lacking readdir.
{ const hex = (                                         // nasm -f bin tools/linux/oldcalls.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004085f010000c7110000070000000010000031ffb83c000000bb12000000' +
    'cd80b808000000bb59810408b9ed010000cd80a35f810408b86a000000bb59810408b967810408cd800fb7056f810408' +
    '25ff0100003ded010000750383cf01b8370000008b1d5f810408b902000000ba01000000cd80b8370000008b1d5f8104' +
    '08b901000000cd8083f801750383cf02b805000000bb5d810408b900000100cd80a363810408b88d0000008b1d638104' +
    '08b9c7810408ba00100000cd8085c07e23bec78104088d90c781040839d673d6817e0a542e5800750383cf040fb74608' +
    '01c6ebe8b805000000bb5d810408b900000100cd8089c3b859000000b9c7810408ba01000000cd8083f801750383cf08' +
    '89fbb801000000cd80542e58002e00');
  let got; try { got = runLinux(hex, ['/w/OLDCALLS']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: creat keeps its mode, fcntl 55, getdents 141, readdir 89 (libc5)', got, 15); }
// tools/linux/unixsock.asm: a Unix stream socket between two processes, as X uses one — bind to an
// abstract name, listen, fork; the child connects and writes "hi" before the parent accepts; the parent
// reads it, then the end. Docker: 3. MIRAGE had no sockets.
{ const hex = (                                         // nasm -f bin tools/linux/unixsock.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408f001000014020000070000000010000031ffc705f881040801000000' +
    'c705fc81040801000000c7050082040800000000b866000000bb01000000b9f8810408cd80a3f0810408a3f8810408c7' +
    '05fc810408e3810408c705008204080b000000b866000000bb02000000b9f8810408cd80c705fc81040801000000b866' +
    '000000bb04000000b9f8810408cd80b802000000cd8085c07577c705f881040801000000c705fc81040801000000c705' +
    '0082040800000000b866000000bb01000000b9f8810408cd8089c6a3f8810408c705fc810408e3810408c70500820408' +
    '0b000000b866000000bb03000000b9f8810408cd80b80400000089f3b9ee810408ba02000000cd80b80100000031dbcd' +
    '80a1f0810408a3f8810408c705fc81040800000000c7050082040800000000b866000000bb05000000b9f8810408cd80' +
    'a3f4810408b8030000008b1df4810408b910820408ba02000000cd8066813d108204086869750383cf01b8030000008b' +
    '1df4810408b910820408ba02000000cd8085c0750383cf02b872000000bbffffffff31c931d231f6cd8089fbb8010000' +
    '00cd800100006d69726167652d786869');
  let got; try { got = runLinux(hex, ['/w/UNIXSOCK']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: a Unix socket between two processes (bind, listen, connect, accept, the end)', got, 3); }
// tools/linux/xcalls.asm: what XFree86 3.3 and Xlib asked beyond sockets — link (X's lock file), and on a
// socket ioctl FIONBIO and FIONREAD. Docker: 7. MIRAGE had no link and answered ENOTTY ("Not a typewriter").
{ const hex = (                                         // nasm -f bin tools/linux/xcalls.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004085a010000e6010000070000000010000031ffb808000000bb52810408' +
    'b9a4010000cd80b809000000bb52810408b956810408cd80b86a000000bb56810408b95a810408cd8066833d64810408' +
    '02750383cf01c705ba81040801000000c705be81040801000000c705c281040800000000c705c6810408d2810408b866' +
    '000000bb08000000b9ba810408cd80c705da81040801000000b8360000008b1dd2810408b921540000bada810408cd80' +
    'b8030000008b1dd2810408b9e2810408ba01000000cd8083f8f5750383cf02b8040000008b1dd6810408b952810408ba' +
    '01000000cd80b8360000008b1dd2810408b91b540000bade810408cd80833dde81040801750383cf0489fbb801000000' +
    'cd804c2e41004c2e4200');
  let got; try { got = runLinux(hex, ['/w/XCALLS']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: link, and FIONBIO/FIONREAD on a socket (X11)', got, 7); }
// tools/linux/shm.asm: System V shared memory between two processes (MIT-SHM's X picture): a child
// attaches and writes, the parent attaches and reads it back, IPC_STAT gives the size. 3; MIRAGE had no ipc.
{ const hex = (                                         // nasm -f bin tools/linux/shm.asm (its file part)
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004080f01000057010000070000000010000031ffb875000000bb17000000' +
    '31c9ba00100000be80030000cd80a30f810408b802000000cd8085c07514e869000000c7005a5a5a5ab80100000031db' +
    'cd80b872000000bbffffffff31c931d231f6cd80e84300000081385a5a5a5a750383cf01b875000000bb180000008b0d' +
    '0f810408ba0200000031f657bf17810408cd805f813d2781040800100000750383cf0289fbb801000000cd80b8750000' +
    '00bb150000008b0d0f81040831d2be138104085731ffcd805fa113810408c3');
  let got; try { got = runLinux(hex, ['/w/SHM']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: System V shared memory between two processes (ipc SHMGET/SHMAT/SHMCTL)', got, 3); }
// The translation memo (src/recompiler.js _memoGet): blocks kept across reset() under paging, reused only
// where memory holds exactly their bytes. Two programs loaded in turn at the same address (rmw.asm, 84;
// mprotect.asm, 42), then the first again: it reuses its blocks (memoHits), and neither gets the other's.
// make ran cc1 once per DOOM file, retranslating it each time: building DOOM went 45% faster.
{ let got;
  try { const memo = new Map();
    const A = (                                         // nasm -f bin tools/linux/rmw.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004087b0000007b0000000500000000100000b9e8030000c74424f8150000' +
    '00d16424f88b4424f8014424f84975e98b5c24f8b801000000cd80'), B = (                                         // nasm -f bin tools/linux/mprotect.asm
    '7f454c46010101000000000000000000020003000100000054800408340000000000000000000000340020000100000000' +
    '000000010000000000000000800408008004088a0000008a0000000500000000100000b87d000000bb00800408b9001000' +
    '00ba07000000cd8085c07510c605768004082ab300b801000000cd80bb01000000b801000000cd80');
    // one machine per program (a fresh exec), all sharing one memo: only the bytes can tell them apart
    const runOne = (hex, name) => { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc); mc.rec.memo = memo;
      lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), [name]); for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000); return [lx.status, mc.rec.stats.memoHits]; };
    const [s1] = runOne(A, '/w/RMW'), [s2] = runOne(B, '/w/MPROTECT'), [s3, hits] = runOne(A, '/w/RMW');
    got = [s1, s2, s3, hits > 0].join();
  } catch (e) { got = e.message.slice(0, 60); }
  eq('recompiler: the memo reuses a program\'s blocks after reset, never another program\'s', got, '84,42,84,true'); }
// tools/linux/mprotect.asm: mprotect makes the text writable and the program patches it, as Quake's
// Sys_MakeCodeWriteable does. Docker: 42. MIRAGE answered 0, left the page read-only: SIGSEGV, 139.
{ const hex = (                                         // nasm -f bin tools/linux/mprotect.asm
    '7f454c46010101000000000000000000020003000100000054800408340000000000000000000000340020000100000000' +
    '000000010000000000000000800408008004088a0000008a0000000500000000100000b87d000000bb00800408b9001000' +
    '00ba07000000cd8085c07510c605768004082ab300b801000000cd80bb01000000b801000000cd80');
  let got; try { got = runLinux(hex, ['/w/MPROTECT']).status; } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: mprotect makes the code writable, and the program patches itself', got, 42); }
// tools/linux/rmw.asm: read-modify-write on the stack through the paged fast path. Docker: 84.
{ const hex = (                                         // nasm -f bin tools/linux/rmw.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004087b0000007b0000000500000000100000b9e8030000c74424f8150000' +
    '00d16424f88b4424f8014424f84975e98b5c24f8b801000000cd80');
  eq('linux: read-modify-write through the paged fast path', runLinux(hex, ['/w/RMW']).status, 84); }
// tools/linux/symlink.asm: a PIE (ET_DYN) loaded at a base of the kernel's choosing, a symbolic link
// made, opened through and read with readlink. Docker: "ok t.b\n", 7.
{ const hex = (                                         // nasm -f bin tools/linux/symlink.asm
    '7f454c460101010000000000000000000300030001000000540000003400000000000000000000003400200001000000' +
    '00000000010000000000000000000000000000002b0100002b0100000700000000100000e8000000005d81ed59000000' +
    'b8050000008d9d09010000b941000000baa4010000cd8089c3b8040000008d8d11010000ba02000000cd80b806000000' +
    'cd80b8530000008d9d090100008d8d0d010000cd80b8050000008d9d0d01000031c9cd8089c3b8030000008d8d130100' +
    '00ba02000000cd80b8550000008d9d0d0100008d8d16010000ba10000000cd808d5004c68428160100000ab804000000' +
    'bb010000008d8d13010000cd80b801000000bb07000000cd80742e6200742e6c006f6b3f3f2000000000000000000000' +
    '0000000000000000000000');
  let got; try { got = JSON.stringify(runLinux(hex, ['/w/SYMLINK'])); } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: a PIE runs, and a symbolic link is followed and read', got, JSON.stringify({ out: 'ok t.b\n', status: 7 })); }
// tools/linux/aout.asm: an a.out ZMAGIC program (text at address 0, argv and envp passed as pointers),
// the format of id's Linux DOOM. No current kernel or qemu-user loads a.out: binfmt_aout.c is the
// reference. "abc", 2.
{ const hex = (                                         // nasm -f bin tools/linux/aout.asm
    '0b0164002a04000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000008b2c248b7424048b4e0431d2803c1100740342ebf7b804000000bb01000000cd' +
    '80b80100000089ebcd80');
  let got; try { got = JSON.stringify(runLinux(hex, ['/w/AOUT', 'abc'])); } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: an a.out ZMAGIC program runs at address 0 with its argv pointer', got, JSON.stringify({ out: 'abc', status: 2 })); }
// tools/linux/ioperm.asm: ioperm opens a port in the TSS's I/O bitmap, which IN/OUT at CPL 3 consult
// whatever IOPL is (then iopl(0), then OUT). Linux: status 5; without a TSS, #GP and 139.
{ const hex = (                                         // nasm -f bin tools/linux/ioperm.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040883000000830000000500000000100000b865000000bb81000000b901' +
    '000000ba01000000cd80b86e00000031dbcd80b05ae681b801000000bb05000000cd80');
  eq('linux: a port opened by ioperm stays open under IOPL 0', runLinux(hex, ['/w/IOPERM']).status, 5); }
// tools/linux/fork.asm: fork, a child that writes and exits 3, a parent that waits for it with wait4.
// Docker: "child\nparent\n", status 13. MIRAGE-LINUX had no fork.
{ const hex = (                                         // nasm -f bin tools/linux/fork.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408d6000000d60000000700000000100000b802000000cd8085c07522b8' +
    '04000000bb01000000b9c5800408ba06000000cd80b801000000bb03000000cd80b872000000bbffffffffb9d2800408' +
    '31d231f6cd80b804000000bb01000000b9cb800408ba07000000cd808b1dd2800408c1eb0881e3ff00000083c30ab801' +
    '000000cd806368696c640a706172656e740a00000000');
  eq('linux: fork, the child runs and exits, the parent waits and reads its status', JSON.stringify(runLinux(hex, ['/w/FORK'])), JSON.stringify({ out: 'child\nparent\n', status: 13 })); }
// tools/linux/signals.asm: signals reach a program's handlers, as i386 Linux delivers them — the frame
// and sigreturn (registers kept), alarm + pause (EINTR), SIGCHLD in wait4 with SA_RESTART (run again),
// a blocked signal pending until unblocked. Docker i386/debian: "sig: YYYY". MIRAGE kept handlers
// without ever calling them, and SIGUSR1 ended the program (signal 10).
{ const hex = (                                         // nasm -f bin tools/linux/signals.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408c9030000c90300000700000000100000c705898304083f830408c705' +
    '8d83040800000004c705918304086f830408c7059583040800000000c7059983040800000000b8ae000000bb0a000000' +
    'b98983040831d2be08000000cd80b814000000cd80a39d830408bb11111111be22222222bf33333333bd44444444538b' +
    '1d9d830408b90a000000b825000000cd805bba4e00000083f800752e833db98304080a752581fb11111111751d81fe22' +
    '222222751581ff33333333750d81fd444444447505ba59000000881584830408c7058983040851830408c7058d830408' +
    '00000004c705918304086f830408c7059583040800000000c7059983040800000000b8ae000000bb0e000000b9898304' +
    '0831d2be08000000cd80b81b000000bb01000000cd80b81d000000cd80ba4e00000083f8fc750e833dbd8304080e7505' +
    'ba59000000881585830408c705898304085b830408c7058d83040800000014c705918304086f830408c7059583040800' +
    '000000c7059983040800000000b8ae000000bb11000000b98983040831d2be08000000cd80b802000000cd8085c0751a' +
    'b8a2000000bb7783040831c9cd80b801000000bb03000000cd80a3a1830408b872000000bbffffffffb9a583040831d2' +
    '31f6cd80ba4e0000003b05a1830408751a813da583040800030000750e833dc1830408117505ba590000008815868304' +
    '08c7058983040865830408c7058d83040800000004c705918304086f830408c7059583040800000000c7059983040800' +
    '000000b8ae000000bb0c000000b98983040831d2be08000000cd80c705a983040800080000c705ad83040800000000b8' +
    'af00000031dbb9a983040831d2be08000000cd80b8250000008b1d9d830408b90c000000cd808b2dc5830408b8b00000' +
    '00bbb1830408b908000000cd808b3db1830408b8af000000bb01000000b9a983040831d2be08000000cd80ba4e000000' +
    '85ed751681ff00080000750e833dc58304080c7505ba59000000881587830408b804000000bb01000000b97f830408ba' +
    '0a000000cd80b80100000031dbcd808b442404a3b983040831db31f631ff31edc38b442404a3bd830408c38b442404a3' +
    'c1830408c38b442404a3c5830408c358b877000000cd800000000080f0fa027369673a203f3f3f3f0a00000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000');
  eq('linux: signals to handlers — sigreturn, EINTR, SA_RESTART, a blocked signal', JSON.stringify(runLinux(hex, ['/w/SIGNALS'])), JSON.stringify({ out: 'sig: YYYY\n', status: 0 })); }
// tools/linux/sleeps.asm: nanosleep, select and poll wait for their timeout (by gettimeofday), and a
// zero timeout does not wait. Docker i386/debian: "sleeps: YYYY". MIRAGE answered at once: NNNY —
// XFree86's main loop, selecting with a timeout, spun some 90 000 times a second.
{ const hex = (                                         // nasm -f bin tools/linux/sleeps.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408c6020000c60200000700000000100000b84e000000bb9682040831c9' +
    'cd80b8a2000000bb8182040831c9cd80a3ae820408b84e000000bb9e82040831c9cd80a19e8204082b059682040869c0' +
    '40420f000305a28204082b059a820408b24e833dae8204080075093de09304007c02b259881591820408b84e000000bb' +
    '9682040831c9cd80c705a682040800000000c705aa820408400d0300b88e00000031db31c931d231f6bfa6820408cd80' +
    'a3ae820408b84e000000bb9e82040831c9cd80a19e8204082b059682040869c040420f000305a28204082b059a820408' +
    'b24e833dae8204080075093d400d03007c02b259881592820408b82a000000bbb2820408cd80b84e000000bb96820408' +
    '31c9cd80a1b2820408a3ba820408c705be82040801000000b8a8000000bbba820408b901000000ba64000000cd80a3ae' +
    '820408b84e000000bb9e82040831c9cd80a19e8204082b059682040869c040420f000305a28204082b059a820408b24e' +
    '833dae8204080075093da08601007c02b259881593820408b84e000000bb9682040831c9cd808b0db2820408b8010000' +
    '00d3e0a3c2820408c705a682040800000000c705aa82040800000000b88e0000008b1db282040843b9c282040831d231' +
    'f6bfa6820408cd80a3ae820408b84e000000bb9e82040831c9cd80a19e8204082b059682040869c040420f000305a282' +
    '04082b059a820408b24e833dae8204080075093d50c300007d02b259881594820408b804000000bb01000000b9898204' +
    '08ba0d000000cd80b80100000031dbcd800000000000a3e111736c656570733a203f3f3f3f0a00000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000000000000000');
  eq('linux: nanosleep, select and poll wait for their timeouts', JSON.stringify(runLinux(hex, ['/w/SLEEPS'])), JSON.stringify({ out: 'sleeps: YYYY\n', status: 0 }));
  // A wait taken by moving the guest's clock ends the slice: whoever runs the machine sees the time go
  // by. One runSlice stops after the first sleep (300 ms), where it ran all three, and a 1K intro paced
  // at sixty frames a second played its three minutes before tools/linux/run.mjs looked at the clock.
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
  lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/SLEEPS']);
  mc.runSlice(200000);
  eq('linux: a wait that moves the clock ends the slice', Math.round(lx.mono() * 10) / 10, 0.3); }
// tools/linux/procs.asm: one process ends another, as busybox `timeout` does — a sleeping child killed,
// the killer's memory still its own; a child that never makes a system call preempted and killed after
// 50 ms; a child's exit ending its parent's wait at once, another child waiting 100 s in a select.
// Docker i386/debian: "procs: YYY". MIRAGE cleared the killed one's addresses in the running process's
// page table, switched processes only in system calls, and counted an exit as one more wait (the
// select's turn then took the clock to its timeout: X's screen saver, 600 s, in a shell starting twm).
{ const hex = (                                         // nasm -f bin tools/linux/procs.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040841020000410200000700000000100000b802000000cd8085c07517b8' +
    'a2000000bb0682040831c9cd80b80100000031dbcd80a32e820408b8250000008b1d2e820408b90f000000cd80c70532' +
    '820408341200008b1d2e820408b8720000008d0d3282040831d231f6cd80b24ea13282040883e07f83f80f7502b25988' +
    '153d820408b802000000cd8085c07502ebfea32e820408b8a2000000bb0e82040831c9cd80b8250000008b1d2e820408' +
    'b909000000cd808b1d2e820408b8720000008d0d3282040831d231f6cd80b24ea13282040883e07f83f8097502b25988' +
    '153e820408b84e000000bb1e82040831c9cd80b802000000cd8085c07516b88e00000031db31c931d231f6bf06820408' +
    'cd80eb26a32e820408b802000000cd8085c0751fb8a2000000bb1682040831c9cd80b9404b4c004975fdb80100000031' +
    'dbcd8089c3b8720000008d0d3282040831d231f6cd80b84e000000bb2682040831c9cd80b24ea1268204082b051e8204' +
    '0883f80a7d02b25988153f820408b8250000008b1d2e820408b909000000cd808b1d2e820408b8720000008d0d328204' +
    '0831d231f6cd80b804000000bb01000000b936820408ba0b000000cd80b80100000031dbcd8064000000000000000000' +
    '000080f0fa02010000000000000000000000000000000000000000000000000000000000000070726f63733a203f3f3f' +
    '0a');
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);   // a 20 ms quantum spun: more slices than runLinux's
  lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/PROCS']);
  for (let i = 0; i < 4000 && !lx.done; i++) mc.runSlice(20000);
  const out = new TextDecoder().decode(Uint8Array.from(lx.stdout)) || (lx.done ? `signal ${lx.signal}` : 'still running');
  eq('linux: a process kills another, a sleeper or one that never makes a system call; an exit ends a wait', out, 'procs: YYY\n'); }
// tools/linux/pty.asm: pseudo-terminals as xterm uses them — Unix98's /dev/ptmx and /dev/pts/N (Docker
// i386/debian answers the same five), echo and ONLCR through the line discipline, the window size, EIO
// on the master once the slave is closed; and the BSD pairs /dev/ptyp0 /dev/ttyp0 of libc5 (a real
// kernel has none any more: "-"; MIRAGE has them, xterm 3.3 opens them).
{ const hex = (                                         // nasm -f bin tools/linux/pty.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408f1030000f10300000700000000100000fcb805000000bb49830408b9' +
    '02010000cd80a39c830408c605aa8304082d85c00f88f6010000b8360000008b1d9c830408b930540480ba98830408cd' +
    '80b8360000008b1d9c830408b931540440ba94830408cd80a1988304080430a25c830408b805000000bb53830408b902' +
    '010000cd80a3a0830408b24e85c07802b2598815aa830408b8040000008b1d9c830408b974830408ba03000000cd80b8' +
    '030000008b1da0830408b9b1830408ba40000000cd80ba4e00000083f8037518beb1830408bf74830408b903000000f3' +
    'a67505ba590000008815a4830408b8030000008b1d9c830408b9b1830408ba40000000cd80ba4e00000083f8047518be' +
    'b1830408bf77830408b904000000f3a67505ba590000008a15a4830408803da4830408597404b24eeb1939d2b24ebeb1' +
    '830408bf77830408b904000000f3a67502b2598815ab830408b8040000008b1da0830408b97b830408ba03000000cd80' +
    'b8030000008b1d9c830408b9b1830408ba40000000cd80ba4e00000083f8047518beb1830408bf7e830408b904000000' +
    'f3a67505ba590000008815ac830408b8360000008b1d9c830408b914540000ba84830408cd80c7058c83040800000000' +
    'b8360000008b1da0830408b913540000ba8c830408cd80b24e813d8c8304081e0064007502b2598815ad830408b80600' +
    '00008b1da0830408cd80b8030000008b1d9c830408b9b1830408ba40000000cd80b24e83f8fb7502b2598815ae830408' +
    'c605af8304082db805000000bb5e830408b902010000cd80a39c83040885c00f8895000000b805000000bb69830408b9' +
    '02010000cd80a3a0830408b8040000008b1d9c830408b982830408ba02000000cd80b8030000008b1da0830408b9b183' +
    '0408ba40000000cd80ba4e00000083f8027518beb1830408bf82830408b902000000f3a67505ba590000008815a48304' +
    '08b805000000bb5e830408b902010000cd80b24e83f8fb750b803da4830408597502b2598815af830408b804000000bb' +
    '01000000b9a5830408ba0c000000cd80b80100000031dbcd802f6465762f70746d78002f6465762f7074732f3f002f64' +
    '65762f7074797030002f6465762f74747970300068690a68690d0a6f6b0a6f6b0d0a780a1e0064000000000000000000' +
    '0000000000000000000000000000000000000000007074793a203f3f3f3f3f3f0a000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00');
  eq('linux: pseudo-terminals, Unix98 and BSD', JSON.stringify(runLinux(hex, ['/w/PTY'])), JSON.stringify({ out: 'pty: YYYYYY\n', status: 0 })); }
// The user's name inside a Linux image (lx.setUser): a page's visitor's choice, `oasis run`'s host login.
// Cleaned to a login name, first in /etc/passwd on uid 0 (getpwuid(0) answers it: XBoing greeted
// "Anonymous?" with no passwd at all), the image's own entries kept after it.
{ let got;
  try { const lx = installLinux(new Machine({ memSize: 16 << 20, cpu: '686' }));
    lx.addFile('/etc/passwd', new TextEncoder().encode('root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1::/:\n'));
    const n = lx.setUser('Max Power!');
    got = n + ' | ' + new TextDecoder().decode(lx.readFile('/etc/passwd')).trim().split('\n').join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: the user\'s name, first in /etc/passwd on uid 0', got, 'maxpower | maxpower:x:0:0:maxpower:/root:/bin/sh | root:x:0:0:root:/root:/bin/sh | daemon:x:1:1::/:'); }
// tools/linux/tick.asm: a select of 35 us sleeps as the kernel's clock allows — some 35 us on a
// modern one (Docker i386/debian: "tick: 00", MIRAGE's default), 10 to 20 ms on Linux 2.0's ticks
// (HZ 100, fs/select.c), which an image of 1997 asks for with machine.hz: XBoing paced its frames on
// it and ran several times too fast without.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/tick.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004080d0100000d0100000700000000100000b84e000000bbf480040831c9' +
    'cd80b88e00000031db31c931d231f6bfec800408cd80b84e000000bbfc80040831c9cd80a1fc8004082b05f480040869' +
    'c040420f000305008104082b05f880040831d2b9e8030000f7f183f8637605b86300000031d2b90a000000f7f1043080' +
    'c230a20a81040888150b810408b804000000bb01000000b904810408ba09000000cd80b80100000031dbcd8000000000' +
    '23000000000000000000000000000000000000007469636b3a203f3f0a');
    const run = (hz) => { const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc); lx.hz = hz;
      lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/TICK']); for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
      return new TextDecoder().decode(Uint8Array.from(lx.stdout)).trim(); };
    const a = run(0), b = run(100), ms = +b.slice(6);
    got = `${a} | ${ms >= 10 && ms <= 20 ? 'tick: 10-20' : b}`;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('linux: timeouts to the microsecond, or in 1997\'s clock ticks (machine.hz 100)', got, 'tick: 00 | tick: 10-20'); }
// tools/linux/fbgrad.asm: /dev/fb0 at the size a program needs (lx.setFb, an image's machine.fb, the
// Linux page's choice for a dropped program) — the 256-byte intros of the 2020s draw for one size,
// 1024x768 for Outline 2021's xorchitecture. The program reads the size, maps the framebuffer and
// paints a gradient: its corners on the card, and a size the card has no mode for refused.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/fbgrad.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408be010000620200000700000000100000b805000000bba7810408b902' +
    '000000cd8085c00f8813010000a3be810408b8360000008b1dbe810408b900460000bac2810408cd8085c00f88ef0000' +
    '00a1c28104080faf05c6810408c1e00289c1b8c000000031dbba03000000be010000008b3dbe8104085531edcd805d3d' +
    '00f0ffff0f87b600000089c731db31c989c869c0ff00000031d28b35c28104084ef7f6c1e0105089d869c0ff00000031' +
    'd28b35c68104084ef7f6c1e0085a09d085c9741a85db74168b15c28104084a39d1740b8b15c68104084a39d37505b8ff' +
    '000000ab413b0dc281040872a3433b1dc68104087298a1c2810408bfb4810408e847000000a1c6810408bfb9810408e8' +
    '38000000b804000000bb01000000b9b0810408ba0e000000cd80833c24017407b81d000000cd80b80100000031dbcd80' +
    'b801000000bb01000000cd8083c703b904000000be0a00000031d2f7f680c23088174f4975f3c32f6465762f66623000' +
    '66623a203f3f3f3f783f3f3f3f0a');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc); lx.setFb(1024, 768);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/FBGRAD']);
    for (let i = 0; i < 400 && !lx.done; i++) mc.runSlice(20000);
    const px = (x, y) => (mc.mem.dv.getUint32(mc.vbeFbBase + (y * 1024 + x) * 4, true) & 0xffffff).toString(16);
    let refused = 'accepted'; try { lx.setFb(1920, 1080); } catch { refused = 'refused'; }   // 8 MiB: this card has 4
    const mc2 = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc2, { vram: 8 }); const lx2 = installLinux(mc2); lx2.setFb(1920, 1080);
    lx2.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/FBGRAD']);
    for (let i = 0; i < 4000 && !lx2.done; i++) mc2.runSlice(20000);
    refused += ' / ' + new TextDecoder().decode(Uint8Array.from(lx2.stdout)).trim();
    got = [new TextDecoder().decode(Uint8Array.from(lx.stdout)).trim(), px(512, 1), px(1022, 766), px(0, 0), refused].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: /dev/fb0 at 1024x768 for a program that draws for it, 1920x1080 on a card of 8 MiB', got, 'fb: 1024x0768 | 7f0000 | fefe00 | ff | refused / fb: 1920x1080'); }
// tools/linux/timerfd.asm: a timer read as a descriptor (timerfd_create/settime/gettime, a read that
// waits for the expiry) and pwrite64 — what Outline 2021's xorchitecture paces and draws its frames
// with. Docker i386/debian: "tfd: YYY"; MIRAGE had neither (ENOSYS).
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/timerfd.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040862020000620200000700000000100000b84e000000bb2d82040831c9' +
    'cd80b842010000bb0100000031c9cd80a33d820408b8450100008b1d3d82040831c9ba0182040831f6cd80c605618204' +
    '0859bf03000000b8030000008b1d3d820408b945820408ba08000000cd8083f8087509833d45820408017407c6056182' +
    '04084e4f75d1b84e000000bb3582040831c9cd80a1358204082b052d82040869c040420f000305398204082b05318204' +
    '083d60ea00007d07c605618204084ea061820408a229820408b8460100008b1d3d820408b94d820408cd80b24e833d4d' +
    '82040800750e813d51820408002d31017502b25988152a820408b805000000bb11820408b942020000baa4010000cd80' +
    'a341820408b8040000008b1d41820408b91e820408ba04000000cd80b8b50000008b1d41820408b922820408ba020000' +
    '00be0200000031ffcd80b8130000008b1d4182040831c9ba01000000cd80b24e83f804752bb8b40000008b1d41820408' +
    'b95d820408ba0400000031f631ffcd80b24e813d5d820408616258597502b25988152b820408b80a000000bb11820408' +
    'cd80b804000000bb01000000b924820408ba09000000cd80b80100000031dbcd8000000000002d310100000000002d31' +
    '012f746d702f7466642e747874006162636458597466643a203f3f3f0a00000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000000000');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc); lx.mkdir('/tmp');
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/TIMERFD']);
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = new TextDecoder().decode(Uint8Array.from(lx.stdout)) || (lx.done ? `status ${lx.status}` : 'still running');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: timerfd and pwrite64', got, 'tfd: YYY\n'); }
// An ELF header with EI_CLASS and EI_DATA left 0, as sizecoded intros lay their header over them
// (xorchitecture): the kernel checks the magic, e_type, EM_386 and the program header's size, not those
// (fs/binfmt_elf.c) — hello.asm with bytes 4 and 5 cleared runs. MIRAGE refused it: "not ELF32".
{ const hex = (                                         // nasm -f bin tools/linux/hello.asm, e_ident[4..5] = 0
    '7f454c460000010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408b7000000b7000000070000000010000089e6ad89c50430a2b4800408' +
    'b9af800408ba07000000e8330000004d7824ad89c131d2803c1100740342ebf7e81d000000b9b6800408ba01000000e8' +
    '0e000000ebd9b801000000bb2a000000cd80b804000000bb01000000cd80c3617267633d3f0a0a');
  let r; try { r = runLinux(hex, ['/w/HELLO']).status; } catch (e) { r = e.message.slice(0, 60); }
  eq('linux: an ELF header whose class and byte order are 0 runs, as the kernel runs it', r, 42);
  // ...and e_machine EM_486 (6), which elf_check_arch_ia32 takes as EM_386 (Outline 2026's 64-byte Sea
  // of Holes lays its header over it): MIRAGE answered "not an i386 program".
  const h486 = hex.slice(0, 36) + '06' + hex.slice(38);
  try { r = runLinux(h486, ['/w/HELLO']).status; } catch (e) { r = e.message.slice(0, 60); }
  eq('linux: an ELF of e_machine EM_486 runs, as the kernel runs it', r, 42); }
// tools/linux/avx.asm: the VEX-encoded instructions (AVX, AVX2, BMI2) the Linux 256-byte intros of
// Outline 2021-2023 are made of — VMOVDQU on YMM, VPADDUSB, VPSHUFD, VMOVD, VPMOVZXBD, VPSRAVD, VPBROADCASTB, VBROADCASTSS, SARX —
// and SSE2's MOVD, on known values; the expected lines are Docker i386/debian's, byte for byte.
{ const hex = (                                         // nasm -f bin tools/linux/avx.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040868020000180300000700000000100000c5fe6f0500820408c5fe6f0d' +
    '20820408c5fddcd1c5fe7f1588820408b920000000e82d010000c5f9dcd9c5fe7f1d88820408b920000000e817010000' +
    'c5f970e01bc5fa7f2588820408b910000000e800010000b8efcdab89c5f96ee8c5fe7f2d88820408b920000000e8e500' +
    '0000c5f97ec3891d88820408b904000000e8d1000000660f6ef0c5fe6f3500820408660f6ef0c5fe7f3588820408b920' +
    '000000e8af000000660f7e0588820408b904000000e89d000000c4e27d313d40820408c5fe7f3d88820408b920000000' +
    'e882000000c5fe6f0d48820408c4e27546d7c5fe7f1588820408b920000000e863000000c4e27d78d8c4e27d781d3082' +
    '0408c5fe7f1d88820408b920000000e843000000c4e27d181d60820408c5fe7f1d88820408b920000000e828000000ba' +
    '34120080b924000000c4e272f7f2893588820408b904000000e809000000b80100000031dbcd80be88820408bfc88204' +
    '080fb606c0e8048a80ea810408aa0fb606240f8a80ea810408aa46e2e4b00aaa89fa81eac8820408b804000000bb0100' +
    '0000b9c8820408cd80c330313233343536373839616263646566909090909090000102030405060708090a0b0c0d0e0f' +
    '101112131415161718191a1b1c1d1ef08080808080808080808080808080808020202020202020202020202020202020' +
    '00011f2004c803109cffffff9cffffff9cffffff9cffffffffffff7fffffffff4000000000000080');
  let got; try { got = runLinux(hex, ['/w/AVX']).out; } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: AVX/AVX2/BMI2 under VEX, as Docker i386 computes them', got,
    '808182838485868788898a8b8c8d8e8f303132333435363738393a3b3c3d3eff\n808182838485868788898a8b8c8d8e8f00000000000000000000000000000000\n0c0d0e0f08090a0b0405060700010203\nefcdab8900000000000000000000000000000000000000000000000000000000\n00010203\n09000000000000000000000000000000101112131415161718191a1b1c1d1ef0\n00010203\n00000000010000001f0000002000000004000000c80000000300000010000000\n9cffffffceffffffffffffffffffffffffffff07ffffffff080000000080ffff\n2020202020202020202020202020202020202020202020202020202020202020\n4000000040000000400000004000000040000000400000004000000040000000\n230100f8\n'); }
// tools/linux/cvt.asm: SSE's CVTTSS2SI (truncated), CVTSS2SI (to nearest even) and CVTSI2SS, the
// integer indefinite for 1e10 and a NaN — Retrospection's Linux port (2010) converts its samples so; the
// expected lines are Docker i386/debian's.
{ const hex = (                                         // nasm -f bin tools/linux/cvt.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408f2000000020100000700000000100000beca800408bf06000000f30f' +
    '2c06e82a000000f30f2d06e82100000083c6044f75e8b8f9fffffff30f2ac0660f7ec0e809000000b80100000031dbcd' +
    '8060bff2800408b908000000c1c00489c283e20f8a92e2800408881747e2edc6070ab804000000bb01000000b9f28004' +
    '08ba09000000cd8061c300002040000020c000006040cdcc6cc0f90215500000c07f3031323334353637383961626364' +
    '6566');
  let got; try { got = runLinux(hex, ['/w/CVT']).out; } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: CVTTSS2SI, CVTSS2SI and CVTSI2SS, as Docker i386 computes them', got,
    '00000002\n00000002\nfffffffe\nfffffffe\n00000003\n00000004\nfffffffd\nfffffffc\n80000000\n80000000\n80000000\n80000000\nc0e00000\n'); }
// tools/linux/fistind.asm: FIST and FISTP of a value their integer cannot hold store the integer
// indefinite and raise IE; they wrapped (Docker i386 printed 0x80000000 where MIRAGE stored 1.5e11's low
// 32 bits). The limits that fit first, IE clear; a quadword overflow and IE set; then, IE cleared by FNCLEX
// (a no-op until then), the word and doubleword overflows, a NaN, and IE set again. Under paging, the
// recompiler's inline stores.
{ const hex = (                                         // nasm -f bin tools/linux/fistind.asm
    '7f454c4601010100000000000000000002000300010000005480040834000000000000000000000034002000010000000000000001000000' +
    '000000000080040800800408130200002b02000007000000001000009bdbe3dd05b3810408db1d13820408a113820408e80d010000dd05bb' +
    '810408db1d13820408a113820408e8f7000000dd05c3810408df1d138204080fbf0513820408e8df000000dd05cb810408df1513820408dd' +
    'd80fbf0513820408e8c5000000dd05d3810408df3d13820408a117820408e8af000000a113820408e8a5000000dfe083e001e89b000000dd' +
    '05fb810408df3d13820408a117820408e885000000a113820408e87b000000dfe083e001e871000000dbe2dd05db810408db1d13820408a1' +
    '13820408e859000000dd05e3810408db1513820408ddd8a113820408e841000000dd05eb810408df1d138204080fbf0513820408e8290000' +
    '00dd05f3810408db1d13820408a113820408e813000000dfe083e001e809000000b80100000031dbcd8060bf1b820408b908000000c1c004' +
    '89c283e20f8a9203820408881747e2edc6070ab804000000bb01000000b91b820408ba09000000cd8061c3000000000000e0c19a99d9ffff' +
    'ffdf41000000000000e0c000000000c0ffdf40000000000000e0c30000002e59764142000000c00b5ae6c1000000000088e3400000000000' +
    '00f87f003d9160e458e14330313233343536373839616263646566');
  let got; try { got = runLinux(hex, ['/w/FISTIND']).out; } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: FIST/FISTP out of range store the integer indefinite and raise IE, as Docker i386', got,
    '80000000\n7fffffff\nffff8000\n00007fff\n80000000\n00000000\n00000000\n80000000\n00000000\n00000001\n80000000\n80000000\nffff8000\n80000000\n00000001\n'); }
// tools/linux/x87mem.asm: what a 4K intro's synthesizer does, under paging (every Linux and Win32
// program is paged) -- x87 on memory operands, push and pop, lodsb, a call through a pointer, a push from
// memory, pushad and popad, then a block that branches back to itself a thousand times: 55, Docker i386's exit status --
// and none of the slow paths the recompiler now avoids for Valleyball (Bluflame, 2009): no cpu.fpuMem
// call (x87 on memory inline under paging), no cpu.push32/pop32 and no memory helper read for its stack,
// its lodsb and its indirect call (a flat 32-bit stack inline; the helpers probe the fast tables first),
// the loop that branches to itself dispatched a few times rather than a thousand (now an inner loop of
// the block before it, not dispatched at all), and the block directory dense
// (grown on demand it fell into V8's dictionary elements: a hash lookup per dispatch).
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/x87mem.asm
    '7f454c4601010100000000000000000002000300010000005480040834000000000000000000000034002000010000000000000001000000' +
    '000000000080040800800408ca000000081000000700000000100000b9e803000051beba800408acff15b28004086061ff35c280040858d9' +
    '05b6800408dc0dba800408da05c2800408d91d00900408d90500900408d80dc6800408db1d0490040859e2bdb9e80300004975fd8b1d0490' +
    '0408b801000000cd80c3b18004080000c03f00000000000004400a00000000008040');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    let fpuMem = 0, walks = 0, stack = 0, reads = 0;
    const fm = mc.cpu.fpuMem; mc.cpu.fpuMem = (...a) => { fpuMem++; return fm(...a); };
    for (const k of ['push32', 'pop32']) { const f = mc.cpu[k].bind(mc.cpu); mc.cpu[k] = (...a) => { stack++; return f(...a); }; }
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/X87MEM']);
    const xl = mc.mem.xlat.bind(mc.mem); mc.mem.xlat = (...a) => { walks++; return xl(...a); };   // a few fill the tables
    mc.rec.profiling = true;
    let compiling = 0;                                                  // the recompiler reads the code itself
    const cmp = mc.rec._compile.bind(mc.rec); mc.rec._compile = (...a) => { compiling++; try { return cmp(...a); } finally { compiling--; } };
    for (const k of ['r8', 'r32']) { const f = mc.mem[k].bind(mc.mem); mc.mem[k] = (...a) => { if (!compiling) reads++; return f(...a); }; }
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done && lx.status, fpuMem, walks < 50, stack, reads < 50, (mc.rec.heat.get(0x080480a1) || 0) < 10, mc.rec.blockPages.length === 1 << 20].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: a synthesizer\'s loops under paging with no slow path (55, as Docker i386)', got, '55 0 true 0 true true true'); }
// tools/linux/sideexit.asm: three loops in one block, the first starting past the block's head, the
// next closed by LOOP, the last branching forward past one instruction. Under paging each turns
// inside the block, opened at its target, and a taken forward branch leaves by a side exit, which
// gives back the instructions it skipped: 218 as Docker i386 exits, after 2 + 3 * 1000 + 1 + 50 * 2
// + 1 + 750 * 5 + 250 * 6 + 3 = 8357 instructions, the block dispatched once and neither the first
// two loops nor the fall-through a block.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/sideexit.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004088500000085000000050000000010000031d2b9e803000083c2034975' +
    'fab93200000083c202e2fbb9e8030000f6c103750383c207424975f489d3b801000000cd80');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/SIDEEXIT']);
    mc.rec.profiling = true;
    const c0 = mc.cpu.cycles;
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done && lx.status, mc.cpu.cycles - c0, mc.rec.heat.get(0x08048054), mc.rec.heat.has(0x0804805b), mc.rec.heat.has(0x08048066), mc.rec.heat.has(0x08048075)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: loops inside a block, one closed by LOOP, a forward branch leaving it by a side exit (218, as Docker i386)', got, '218 8357 1 false false false'); }
// tools/linux/skip.asm: Elevated's synthesizer (RGBA & TBC, 2009), an operator's x87 operation and an
// oscillator's waveform picked by `dec eax; jnz next` chains whose skipped instructions pop the stack, two
// of them to one target. Under paging each skipped run stays inside the block, `if(taken){..}else{..}`,
// the x87 top read again where the paths meet, and the loop around them too: 41 as Docker i386 exits,
// 762 instructions (taken, a skip gives back those it jumped over), the whole program one dispatch.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/skip.asm
    '7f454c4601010100000000000000000002000300010000005480040834000000000000000000000034002000010000000000000001000000' +
    '000000000080040800800408ad000000ad0000000500000000100000d9e8b92000000089c883e00340d905a9800408487502ddd8487502de' +
    'c1487502dee9487502dec989c883e00140d9c048750cd9eedff1ddd8d9e87202d9e0dec1e2c550db1c245b89d8c1e81031c3b801000000cd' +
    '8000004040');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/SKIP']);
    mc.rec.profiling = true;
    const c0 = mc.cpu.cycles;
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done && lx.status, mc.cpu.cycles - c0, mc.rec.heat.size].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: x87 operations picked by forward branches, skipped inside the block (41, as Docker i386)', got, '41 762 1'); }
// tools/linux/skipud.asm: XSAVE (0F AE /4, not translated) inside a run a short forward branch always
// skips. Kept inside the block as a skip, it made the recompiler refuse the whole block: KolibriOS's
// kernel stopped there ("unimplemented opcode 0x0f ae /4"). The block now ends before it.
{ let got;
  try { const hex = '7f454c46010101000000000000000000020003000100000054800408340000000000000000000000340020000100000000000000010000000000000000800408008004086900000069000000050000000010000031c085c074030fae20bb07000000b801000000cd80';
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/SKIPUD']);
    for (let i = 0; i < 50 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done, lx.status].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: an instruction not translated, inside a run a forward branch skips, ends the block before it', got, 'true 7'); }
// The derail detector reads code through the page tables. A 4 MiB page (PDE.PS with CR4.PSE) has no
// page table: read as one, KolibriOS's kernel looked like "a run of zero bytes" and was reported derailed.
{ const mc = new Machine({ memSize: 16 << 20, cpu: '586' }), m = mc.mem;
  m.w32(0x1000 + (0x80000000 >>> 22) * 4, 0x00400083);                // 80000000h -> 400000h, one 4 MiB page
  m.u8.set([0x55, 0x89, 0xe5], 0x400000 + 0x21688);                   // push ebp; mov ebp, esp
  new DataView(m.u8.buffer).setUint32(0x400000 + 0x21 * 4, 0x00900001, true);                             // the page's own bytes, read as a page table, say: present, at an empty frame
  mc.cpu.cr3 = 0x1000; mc.cpu.cr4 = 0x10; mc.cpu.cr0 |= 0x80000001; m.paged = true;
  eq('the derail detector reads a 4 MiB page as the code it holds', allZero(m, 0x80021688), false); }
// tools/linux/follow.asm: a loop that calls a subroutine and jumps over an instruction. Under paging
// a direct CALL or JMP to the head's page goes on in the same block, so neither the subroutine nor
// the jump's target begins one, nor the return address its RET goes back to (unless the subroutine
// moved it); the subroutine rewritten, the blocks that followed into it go (16, as Docker i386 exits),
// and a block that rewrote itself gives back what it did not run: 18016 instructions, as many as
// without following.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/follow.asm
    '7f454c4601010100000000000000000002000300010000005d8004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004089f0000009f000000070000000010000083c203c383042406c331d231' +
    'f6b9e8030000e8e9ffffffeb0681c2e8030000e8e0ffffff81c2e80300004975e54683fe027409c6055680040807ebd1' +
    '89d381e3ff000000b801000000cd80');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/FOLLOW']);
    mc.rec.profiling = true;
    const c0 = mc.cpu.cycles;
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done && lx.status, mc.cpu.cycles - c0, mc.rec.heat.has(0x08048073), mc.rec.heat.has(0x08048054), mc.rec.heat.has(0x0804806b)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: a direct CALL and JMP followed in their block, RET back into it, rewritten code evicted (16, as Docker i386)', got, '16 18016 false false false'); }
// tools/linux/faulteip.asm: the EIP a page fault reports from the middle of a block whose other
// accesses took the paged fast path (where the store of EIP moved to the helpers' slow path): the
// SIGSEGV handler exits with the faulting instruction's distance from _start, 37, as Docker i386.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/faulteip.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408ab000000002000000700000000100000b8ae000000bb0b000000b997' +
    '80040831d2be08000000cd80be009004088b0689460483c0018b1d10000000b801000000cd808b5c244081eb54800408' +
    'b801000000cd808680040800000000000000000000000000000000');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/FAULTEIP']);
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = lx.done && lx.status;
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: a page fault in a block reports its own instruction (37, as Docker i386)', got, 37); }
// tools/linux/fxcache.asm: the x87 stack as a block keeps it, its top and the values it holds -- a
// loop one push deeper each turn that reads what was there before it, one that reads nothing from
// before it, FXCH, FINCSTP/FDECSTP, and an FCMOV through src/fpu.js between held values: 253, as
// Docker i386 exits.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/fxcache.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408cd0000000810000007000000001000009bdbe3d9e8d9eeb904000000' +
    'd8c1d9c04975f9dec1dec1dec1dec1dec1db1d00900408b903000000d9e84975fbdec1dec1db1d08900408db05c58004' +
    '08db05c9800408d9c9d9f7d9f6f9dac1d8c1ddd9db1d04900408a1009004086bd80a031d04900408031d08900408b801' +
    '000000cd800300000005000000');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/FXCACHE']);
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = lx.done && lx.status;
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: the x87 stack kept in the block, its loops and helpers (253, as Docker i386)', got, 253); }
// tools/linux/mmx.asm: every MMX instruction on fixed operands (saturations, signs, PMADDWD's
// wrap, counts past the element and a 2^32 quadword count), MOVD/MOVQ in and out of memory and
// registers, EMMS: 103 lines of 64-bit results, which Docker i386 prints identically (their MD5).
// The CPUID MMX bit (EDX 23) is the 'pentiummmx' profile's alone. Heaven Seven (Exceed, 2000) wants it.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/mmx.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408f0080000004000000700000000100000bf00a004080f6f05d0880408' +
    '0f6f0dd88804080ffcc1e8170800000f6f05d08804080ffc05d8880408e8040800000f6f05d08804080f6f0dd8880408' +
    '0ffdc1e8ee0700000f6f05d08804080ffd05d8880408e8db0700000f6f05d08804080f6f0dd88804080ffec1e8c50700' +
    '000f6f05d08804080ffe05d8880408e8b20700000f6f05d08804080f6f0dd88804080ff8c1e89c0700000f6f05d08804' +
    '080ff805d8880408e8890700000f6f05d08804080f6f0dd88804080ff9c1e8730700000f6f05d08804080ff905d88804' +
    '08e8600700000f6f05d08804080f6f0dd88804080ffac1e84a0700000f6f05d08804080ffa05d8880408e8370700000f' +
    '6f05d08804080f6f0dd88804080fecc1e8210700000f6f05d08804080fec05d8880408e80e0700000f6f05d08804080f' +
    '6f0dd88804080fedc1e8f80600000f6f05d08804080fed05d8880408e8e50600000f6f05d08804080f6f0dd88804080f' +
    'e8c1e8cf0600000f6f05d08804080fe805d8880408e8bc0600000f6f05d08804080f6f0dd88804080fe9c1e8a6060000' +
    '0f6f05d08804080fe905d8880408e8930600000f6f05d08804080f6f0dd88804080fdcc1e87d0600000f6f05d0880408' +
    '0fdc05d8880408e86a0600000f6f05d08804080f6f0dd88804080fddc1e8540600000f6f05d08804080fdd05d8880408' +
    'e8410600000f6f05d08804080f6f0dd88804080fd8c1e82b0600000f6f05d08804080fd805d8880408e8180600000f6f' +
    '05d08804080f6f0dd88804080fd9c1e8020600000f6f05d08804080fd905d8880408e8ef0500000f6f05d08804080f6f' +
    '0dd88804080fd5c1e8d90500000f6f05d08804080fd505d8880408e8c60500000f6f05d08804080f6f0dd88804080fe5' +
    'c1e8b00500000f6f05d08804080fe505d8880408e89d0500000f6f05d08804080f6f0dd88804080ff5c1e8870500000f' +
    '6f05d08804080ff505d8880408e8740500000f6f05d08804080f6f0dd88804080fdbc1e85e0500000f6f05d08804080f' +
    'db05d8880408e84b0500000f6f05d08804080f6f0dd88804080fdfc1e8350500000f6f05d08804080fdf05d8880408e8' +
    '220500000f6f05d08804080f6f0dd88804080febc1e80c0500000f6f05d08804080feb05d8880408e8f90400000f6f05' +
    'd08804080f6f0dd88804080fefc1e8e30400000f6f05d08804080fef05d8880408e8d00400000f6f05d08804080f6f0d' +
    'd88804080f74c1e8ba0400000f6f05d08804080f7405d8880408e8a70400000f6f05d08804080f6f0dd88804080f75c1' +
    'e8910400000f6f05d08804080f7505d8880408e87e0400000f6f05d08804080f6f0dd88804080f76c1e8680400000f6f' +
    '05d08804080f7605d8880408e8550400000f6f05d08804080f6f0dd88804080f64c1e83f0400000f6f05d08804080f64' +
    '05d8880408e82c0400000f6f05d08804080f6f0dd88804080f65c1e8160400000f6f05d08804080f6505d8880408e803' +
    '0400000f6f05d08804080f6f0dd88804080f66c1e8ed0300000f6f05d08804080f6605d8880408e8da0300000f6f05d0' +
    '8804080f6f0dd88804080f63c1e8c40300000f6f05d08804080f6305d8880408e8b10300000f6f05d08804080f6f0dd8' +
    '8804080f6bc1e89b0300000f6f05d08804080f6b05d8880408e8880300000f6f05d08804080f6f0dd88804080f67c1e8' +
    '720300000f6f05d08804080f6705d8880408e85f0300000f6f05d08804080f6f0dd88804080f60c1e8490300000f6f05' +
    'd08804080f6005d8880408e8360300000f6f05d08804080f6f0dd88804080f61c1e8200300000f6f05d08804080f6105' +
    'd8880408e80d0300000f6f05d08804080f6f0dd88804080f62c1e8f70200000f6f05d08804080f6205d8880408e8e402' +
    '00000f6f05d08804080f6f0dd88804080f68c1e8ce0200000f6f05d08804080f6805d8880408e8bb0200000f6f05d088' +
    '04080f6f0dd88804080f69c1e8a50200000f6f05d08804080f6905d8880408e8920200000f6f05d08804080f6f0dd888' +
    '04080f6ac1e87c0200000f6f05d08804080f6a05d8880408e8690200000f6f05d08804080f6f0de08804080ff1c1e853' +
    '0200000f6f05d08804080ff105e8880408e8400200000f6f05d08804080f6f0de08804080ff2c1e82a0200000f6f05d0' +
    '8804080ff205e8880408e8170200000f6f05d08804080f6f0de08804080ff3c1e8010200000f6f05d08804080ff305e8' +
    '880408e8ee0100000f6f05d08804080f6f0de08804080fd1c1e8d80100000f6f05d08804080fd105e8880408e8c50100' +
    '000f6f05d08804080f6f0de08804080fd2c1e8af0100000f6f05d08804080fd205e8880408e89c0100000f6f05d08804' +
    '080f6f0de08804080fd3c1e8860100000f6f05d08804080fd305e8880408e8730100000f6f05d08804080f6f0de08804' +
    '080fe1c1e85d0100000f6f05d08804080fe105e8880408e84a0100000f6f05d08804080f6f0de08804080fe2c1e83401' +
    '00000f6f05d08804080fe205e8880408e8210100000f6f05d08804080f71f003e8110100000f6f05d08804080f72f005' +
    'e8010100000f6f05d08804080f73f00de8f10000000f6f05d08804080f71d002e8e10000000f6f05d08804080f72d01f' +
    'e8d10000000f6f05d08804080f73d028e8c10000000f6f05d08804080f71e009e8b10000000f6f05d08804080f72e021' +
    'e8a10000000f6f05d08804080f71f010e8910000000f6f05d08804080f73d040e881000000b8efcdab890f6ec0e87400' +
    '00000f6e05dc880408e8680000000f6f15d08804080f7ed0a3009004080f6e0500900408e84d0000000f6f1dd8880408' +
    '0f7f1d009004080f6f0500900408e8330000000f6f25d08804080f6fc4e8240000000f7789fa81ea00a00408b900a004' +
    '08bb01000000b804000000cd80b80100000031dbcd800f7f0500900408a104900408e80f000000a100900408e8050000' +
    '00c6070a47c3b908000000c1c00489c283e20f8a92bf880408881747e2edc33031323334353637383961626364656690' +
    '0201feffff7f01800080008001ff807f04000000000000000100000001000000');
    let out = '';
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc, { onOutput: (fd, b) => { out += new TextDecoder().decode(b); } });
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/MMX']);
    for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
    const { createHash } = await import('crypto');
    const bit = (cpu) => { const c = new Machine({ memSize: 1 << 20, cpu }).cpu; c.reg[0] = 1; c.cpuid(); return (c.reg[2] >>> 23) & 1; };
    got = [out.split('\n').length - 1, createHash('md5').update(out).digest('hex'), bit('pentiummmx'), bit('686'), bit('586')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('MMX: every instruction as Docker i386 computes it; CPUID says MMX on pentiummmx alone', got, '103 36e93d3e88184161fd64b5679a9fb01f 1 0 0'); }
// tools/linux/mmxsse.asm: the integer instructions SSE added to the MMX registers -- PMINUB, PMAXUB,
// PAVGB, PAVGW, PMULHUW, PMINSW, PMAXSW, PSADBW from a register and from memory, PSHUFW in four orders,
// PINSRW, PEXTRW, PMOVMSKB, MOVNTQ: 39 lines, as Docker i386 prints them (their MD5). .kkrieger
// (farbrausch, 2004) builds its textures with PMAXSW and stopped on it (#UD).
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/mmxsse.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408c0030000004000000700000000100000bf00a004080f6f05a0830408' +
    '0f6f0da88304080fdac1e8e80200000f6f05a08304080fda05a8830408e8d50200000f6f05a88304080fda05a0830408' +
    'e8c20200000f6f05a08304080f6f0da88304080fdec1e8ac0200000f6f05a08304080fde05a8830408e8990200000f6f' +
    '05a88304080fde05a0830408e8860200000f6f05a08304080f6f0da88304080fe0c1e8700200000f6f05a08304080fe0' +
    '05a8830408e85d0200000f6f05a88304080fe005a0830408e84a0200000f6f05a08304080f6f0da88304080fe3c1e834' +
    '0200000f6f05a08304080fe305a8830408e8210200000f6f05a88304080fe305a0830408e80e0200000f6f05a0830408' +
    '0f6f0da88304080fe4c1e8f80100000f6f05a08304080fe405a8830408e8e50100000f6f05a88304080fe405a0830408' +
    'e8d20100000f6f05a08304080f6f0da88304080feac1e8bc0100000f6f05a08304080fea05a8830408e8a90100000f6f' +
    '05a88304080fea05a0830408e8960100000f6f05a08304080f6f0da88304080feec1e8800100000f6f05a08304080fee' +
    '05a8830408e86d0100000f6f05a88304080fee05a0830408e85a0100000f6f05a08304080f6f0da88304080ff6c1e844' +
    '0100000f6f05a08304080ff605a8830408e8310100000f6f05a88304080ff605a0830408e81e0100000f7005a0830408' +
    '1be8110100000f6f0da88304080f70c11be8010100000f7005a0830408e4e8f40000000f6f0da88304080f70c1e4e8e4' +
    '0000000f7005a083040800e8d70000000f6f0da88304080f70c100e8c70000000f7005a083040893e8ba0000000f6f0d' +
    'a88304080f70c193e8aa0000000f6f05a0830408b8785634120fc4c002e8950000000f6f05a08304080fc405aa830408' +
    '03e8810000000f6f0da88304080fc5c1010f6ec0e86e0000000fc5c1030f6ec0e8620000000f6f0da88304080fd7c10f' +
    '6ec0e8500000000f6f0da08304080fd7c10f6ec0e83e0000000f6f0da88304080fe70d089004080f6f0508900408e824' +
    '0000000f7789fa81ea00a00408b900a00408bb01000000b804000000cd80b80100000031dbcd800f7f0500900408a104' +
    '900408e80f000000a100900408e805000000c6070a47c3b908000000c1c00489c283e20f8a9290830408881747e2edc3' +
    '303132333435363738396162636465660201feffff7f01800080008001ff807f04000000000000000100000001000000');
    let out = '';
    const mc = new Machine({ memSize: 16 << 20, cpu: 'pentium3' }), lx = installLinux(mc, { onOutput: (fd, b) => { out += new TextDecoder().decode(b); } });
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/MMXSSE']);
    for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
    const { createHash } = await import('crypto');
    got = [out.split('\n').length - 1, createHash('md5').update(out).digest('hex')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('MMX with SSE: PMAXSW and the other integer additions as Docker i386 computes them', got, '39 b9e5b8c27f62c01835f6db8c0636cf15'); }
// tools/linux/sse.asm: SSE and SSE2 on fixed operands -- arithmetic, logic, compares, conversions,
// shuffles, unpacks, shifts and moves in single and double precision and on integers, with NaNs
// (propagated quiet, the default one negative), signed zeros, ties to even and the integer
// indefinite, infinity times zero -- then COMISS and its kin's flags and MXCSR: 327 lines, which Docker i386 prints
// identically (their MD5). CPUID says SSE on 'pentium3' and 'pentium4', SSE2 on 'pentium4' alone.
// yes we can (Still, 2009) is compiled for SSE: MULSS was the first it reached.
{ let got;
  try { const b64 = (                                  // nasm -f bin tools/linux/sse.asm, deflated
    'ddkNcFRXFQfwu7tvyTbZsJuwm/BNpmNtacs3iJWpZCqIDFW6EGA3JJuQ4tphoKSUwU7VZhFHiAyWVkdLm0gyjtZxKgZlImgd9oRKKbZOyketIh' +
    'OgIz3aaQlZsHxYVu49d/PO7r3uDNn3/u93zn3v7nsvj2zbwoe/6PF4RP7lFT4h1+rSTmC2cF+zRY3Iq2GddgLyX88EqiyRb2EhDouMEwjd4093' +
    'yLfy3R1OIBuKA/5gnBA6zobifpljm5sN0wbAxzhtIFpnoQnABzlNEJ1soUnASk6TRG+NNWkj4PtjGW0ketJCmwBf5bSJ6C8sNAb4HKcxot+y0O' +
    'WAKU6XE11mocsA53G6jOjdBpUTUMHS/PGPMWAjILJUH/1pEzYBHmapPvZXTBgD/BFL9ZFvM+FywA0s1cddb8I6wAUsrSM4w4QrAMexdAXBgAlX' +
    'Ag6NdtOVBAdGGzAC+AZLIwR7TRgF7GJplOCu0eaHWA+4ZTT7EOuJtljoasAlnK4mOtdCLwLWcHqRaNDc0z4QeLXajfuUFHi+2kI9eNygHuy1US' +
    '/uNagXd9qoDzcb1IfNNurgYoM6OMdG/TjRoH4stdERmK0qpiNwoMpCS/CYQUvwQJX5EcjZ6qhin0F+urZT2EW4R192T7C00S9TTFLUQ7BLwy+x' +
    'tFF5nGN2bAKcxNIm6hg0OzYB/ifqpk3U8b1ocUd1a3zTjbP5vTwYLe6paLcbZ/P7ucvS9fb4W3hXvactlq5NgEt4V72vc42u6qSuYXGfqhAYtF' +
    'EfXo0UUx+ej1iog8cN6mCvjZbgXoOW4M6IOQNxwM0RNgNxmoHmiDkDccDFETYDcf35W7omACfyrgnqWmrpmgDMjmJdE9R1YJRxWEnAN1iapJ69' +
    'o4yzKgnYxdKk/vzNjg2AX2dpA3Vca3ZsAPwKSxuo4zyzYxzwLpbq2aw0O8YB/1vppnou/1VpdEwAnmSpnslMpdExAfhLlup5/LHZMQa4laUx6v' +
    'i42TEGGGdpjDoupChDsF8PPY2lCb9McTxF/QwmAUewNEkwW8E7ZvSEn2Vpg3rD4xXFQ6tHlt+6sXxkUT33UnaO6GCHExiSc77DjYdCcb/McbOF' +
    '3h6/kdMGoostNAE4k9ME0YkWmgQs4TRJNBs2aSPgP8KMNhI9ZqFNgPs5bSLaaaExwO9yGiO6yaApOVmr3TiVn6xFFtoAOJ1TPVnjLTQB6OdUT9' +
    'blkEmTgH8PMaon66iFNgL+mlM9WS9ZaBPgdzjVk9VqoTHABKd6shZaaB3gVE7riI610BWAPk5XEL000qQrAd8dyehKoq9Z6CrAX3G6iugeC40A' +
    'fpvTCNHHLTQKuIrTKNEvjDTPrHrA+0eyM6ue6GhL13pAD++q6YflJr0I+E45oxeJ9pUbD0e3x3+FpfpBdo+l51Hw4Fbe9Khq6sH1FiwfJes47l' +
    'PYi/PLzTmQv6LvLmeTQNjBSgpFp8Ln8hf4zeBwLC9wmeP7Qd5XbwLsDxbcC2SOrwaLu6rT+2duLE9v1fU5o6uiTwcLrgTVNWXpGgdcyrvGqes8' +
    'S9c44KeCBbcN1TUcNGcgAXi9jM1Agrr+s8ycgQTgX8oK7rGq6+/LzK5JwJ/yrknq+qylaxLwqbKC27HqurbMnIEY4JfL2AzEqOsDZeYMxADvLC' +
    'u4baiuIykLU9eaTn03/Lh0OJZ3Q5nje5TVuFTt65tuLPdV0YOlfAemd+qbfHdpwU1e5riLslrq+oga8AzgFjdOhc74ZY4tFjoAuITTAaJzLfQD' +
    'wBpOPyAatNBLgFfvYPQS0fN3mPQW4HFObxHttdAbgHs5vUF0p4WeAtzM6SmizRZ6E3AxpzeJzrHQTwAncvoJ0VILvQ6YDTB6nehAwKSnAY9xep' +
    'roAQtNAXZymiLabqFXADdxeoVo0kKbARdx2kx0loWuARzP6RqiAQttAbxcwmgL0bMlJl0HeJTTdUR/Y6HrAV/idD3R7Ra6AbCV0w1EGyy0Fcbh' +
    'Am5blR2H03i4qd+HEwuqm1V+ArCEuxP+VjlQdgSvPefDCyPM2guAf+buAtX+rqB20Ic/t9QOAT7L3RDVfoNnT/T7cJ2l9m3A5dy9TbXzC2rP+X' +
    'CqpfY8YDV356nWV1A76MMhv1l7GfCMn7nLVPs6z57s92GvpfYk4F7uTlLtzoLaQR8+banNAj7KXZZqlxbUvuvDzxcE13w4xQ2yoTA9f4wpGID+' +
    'NBMG9LrxUChMzzQfOZzSA0UY8K8srqSmr7GoiqL9DtuZSv38z7Mqytqd4v0JVQI+aaZVgI0OO55naJzFjnk8zwDOVLG6RIZHfKdc9AyvyqOUqx' +
    'hgcrIWUdVuVFStVUcD8k3zv/n+Dx8KVUSdHjl8RTSo3jdSxcuqIkpXa5vqmcp320nb6Ijaoh7ZriIa0eVyFR9zSSpUocvvofKHfezg1Qih+6L6' +
    'IBW4z1f8WHrwdECIRzpD02BGBmvdzTMyMtTfGVC8m6rSxVWl7mZdlVb/Z/TysXjVVFl1yls41lSq+qO3+K8BBVU/cTfrKvWnge3e4mddXZWiXf' +
    'yau12WpULT6GxbSvlgx/CD1HCdGm6au53qptJTVbW3+AGscLyPPcPb8+OpugGPEEOh+/1pecGeUCtTaOVPaiU8Ia1OnSlH8ICmO+TWlzVVKy9q' +
    'uiNP2zXdLbd+U1O1slHT3Xma1PQFuTWmqVpZoOkLeTpLUzVRn9ZUrYzRlG4BU45gQNMu2eimIKpWPhJEu/JdzwohDl3P5XLDD3/3Av5QsIfBe+' +
    'l3W1oI8bo6a9OThAjto/N43wR58XXLH/j8sOgqEPKq65Y/sNXe41poH4b2Dbbf2Ppv+X3cIfnjD/Kru4OOEOKt9EG5POPMW+lQhV/sdwLdwf23' +
    'z8wHhRDdAbk0Sy45cmmyXJIEJwkhjpaULjrSgRG1WLMofpc8J9Cf33IoIISAjNPet+1C6HvPr+twAjuqF1348Mj0GTNnzZ7zmbmffWBNy6Nrv5' +
    'rarV5CZOYLUZOhLxSPPSRE7Xz5zaIQtbUbK7d9TohMmxBpnalXrUd05fLfQAqRbtOLOe0EZSrXNdd07s28uEe+Dun1QC19l3lF9xjU+WCbsL7y' +
    'eVjv7521uTZP2uu5lXtq5ezKXC7X5sndHjct0oO5XM4nhHAsXTxG4tTqd903qNfPHRZC9Hx/cNxDefk/');
    const { inflateRawSync } = await import('zlib');
    let out = '';
    const mc = new Machine({ memSize: 16 << 20, cpu: 'pentium4' }), lx = installLinux(mc, { onOutput: (fd, b) => { out += new TextDecoder().decode(b); } });
    lx.load(new Uint8Array(inflateRawSync(Buffer.from(b64, 'base64'))), ['/SSE']);
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    const { createHash } = await import('crypto');
    const bits = (cpu) => { const c = new Machine({ memSize: 1 << 20, cpu }).cpu; c.reg[0] = 1; c.cpuid(); return ((c.reg[2] >>> 25) & 3).toString(2).padStart(2, '0'); };
    got = [out.split('\n').length - 1, createHash('md5').update(out).digest('hex'), bits('pentium4'), bits('pentium3'), bits('686')].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('SSE: every instruction as Docker i386 computes it; CPUID says SSE on pentium3 and 4, SSE2 on pentium4', got, '327 1b56ec01dd414cd0ebc0eb572a890e1b 11 01 00'); }
// tools/linux/repstr.asm: REP STOS and REP MOVS under paging -- bytes, words, dwords, across page
// boundaries, at an odd address, backwards, copies overlapping either way -- give Docker i386's
// checksum, and the forward ones run a page at a time, not through a memory helper an element
// (Valleyball's synthesizer clears its buffers with `rep stosw`: a sixth of its time went there).
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/repstr.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040848010000004000000700000000100000fcbff19f0408b834120000b9' +
    '2c01000066f3abbf0094040831c0b9c8000000f3abbf00af0408b05ab903020000f3aabf10b00408b8efcdab89b94d00' +
    '0000f3abfdbf10a80408b847470000b92800000066f3abfcbef09f0408bf00b80408b941000000f3a5be10b00408bf13' +
    'b00408b901010000f3a4be10af0408bf08af0408b99000000066f3a5be00900408b9000c000031dbad6bdb1f01c3e2f8' +
    'bf3f810408b908000000c1c30489d883e00f8a802f810408880747e2edc6070ab804000000bb01000000b93f810408ba' +
    '09000000cd80b80100000031dbcd8030313233343536373839616263646566000000000000000000');
    let out = '';
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc, { onOutput: (fd, b) => { out += new TextDecoder().decode(b); } });
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/REPSTR']);
    let helper = 0;
    for (const k of ['w8', 'w16', 'w32']) { const f = mc.mem[k].bind(mc.mem); mc.mem[k] = (...a) => { helper++; return f(...a); }; }
    for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
    got = [out.trim(), lx.done && lx.status, helper < 200].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: REP STOS and REP MOVS under paging, a page at a time (Docker i386\'s checksum)', got, 'c294c573 0 true'); }
// The branch-free 32-bit flag setters (cpu.setAdd32, setSub32, setLogic32, setInc32, setDec32) against
// the generic ones at 32 bits, on edge values and random ones, the flags they start from random too.
{ const { CPU } = await import('../src/cpu.js');
  const c = new CPU({ u8: new Uint8Array(16) }), g = new CPU({ u8: new Uint8Array(16) });
  const edge = [0, 1, 2, 0x0f, 0x10, 0x7f, 0x80, 0xff, 0x7fffffff, 0x80000000, 0x80000001, 0xfffffffe, 0xffffffff];
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % 3 === 0 ? edge[seed % edge.length] : (Math.imul(seed, 2654435761) >>> 0); };
  let bad = 0;
  for (let i = 0; i < 200000; i++) {
    const a = rnd(), b = rnd(), f0 = rnd() & 0xffff, same = (k, x, y) => { if (c.flags !== g.flags && bad++ < 3) console.log(k, x, y, c.flags.toString(16), g.flags.toString(16)); };
    c.flags = g.flags = f0; g.setAdd(a, b, (a + b) >>> 0, 32); c.setAdd32(a, b, (a + b) >>> 0); same('add', a, b);
    c.flags = g.flags = f0; g.setSub(a, b, (a - b) >>> 0, 32); c.setSub32(a, b, (a - b) >>> 0); same('sub', a, b);
    c.flags = g.flags = f0; g.setLogic((a & b) >>> 0, 32); c.setLogic32((a & b) >>> 0); same('logic', a, b);
    c.flags = g.flags = f0; g.setAdd(a, 1, (a + 1) >>> 0, 32, false); c.setInc32(a, (a + 1) >>> 0); same('inc', a, 1);
    c.flags = g.flags = f0; g.setSub(a, 1, (a - 1) >>> 0, 32, false); c.setDec32(a, (a - 1) >>> 0); same('dec', a, 1);
  }
  eq('cpu: the 32-bit flag setters give the generic ones\' flags', bad, 0); }
// tools/linux/fbwrite.asm: writes to /dev/fb0 as fb_write takes them, on a 1280x720 framebuffer (any
// 32-bit size the card holds: Outline 2026's Sea of Holes asks for it) — a count of BE570E00h answered
// with the frame's size (attraction & decay's pwrite64), a buffer running into an unmapped page written
// up to it, nothing left at the end ENOSPC. The kernel is the oracle; MIRAGE answered EFAULT, EFAULT, 0.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/fbwrite.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408b7010000630200000700000000100000b805000000bba5810408b902' +
    '000000cd80a3b7810408b8360000008b1db7810408b900460000bac3810408cd80a1c38104080faf05c7810408c1e002' +
    'a3bb81040889c181c100200000b8c000000031dbba03000000be22000000bfffffffff5531edcd805da3bf810408b8b5' +
    '0000008b1db78104088b0dbf810408ba000e57be31f631ffcd80b24e3b05bb8104087502b2598815b3810408b85b0000' +
    '008b1dbf810408031dbb81040881c300100000b900100000cd80b8130000008b1db781040831c931d2cd80b804000000' +
    '8b1db78104088b0dbf810408030dbb810408ba00200000cd80b24e3d001000007502b2598815b4810408b8130000008b' +
    '1db78104088b0dbb81040831d2cd80b8040000008b1db78104088b0dbf810408ba10000000cd80b24e83f8e47502b259' +
    '8815b5810408b804000000bb01000000b9ae810408ba09000000cd80b80100000031dbcd802f6465762f666230006662' +
    '773a203f3f3f0a');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc); lx.setFb(1280, 720);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/FBWRITE']);
    for (let i = 0; i < 400 && !lx.done; i++) mc.runSlice(20000);
    got = new TextDecoder().decode(Uint8Array.from(lx.stdout)) || (lx.done ? `signal ${lx.signal}` : 'still running');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: writes to /dev/fb0 as fb_write takes them, at 1280x720', got, 'fbw: YYY\n'); }
// The ELF loader maps the FILE by pages, as elf_map does: from p_offset - pageoff(p_vaddr), at
// p_vaddr's page. hello.asm with p_offset D44h and p_vaddr 08048D44h (Sea of Holes' header gives an
// offset past its own 64 bytes): the page at 08048000h holds the file all the same, and it runs.
{ const hex = (                                         // nasm -f bin tools/linux/hello.asm; its PT_LOAD at D44h / 08048D44h
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408b7000000b7000000070000000010000089e6ad89c50430a2b4800408' +
    'b9af800408ba07000000e8330000004d7824ad89c131d2803c1100740342ebf7e81d000000b9b6800408ba01000000e8' +
    '0e000000ebd9b801000000bb2a000000cd80b804000000bb01000000cd80c3617267633d3f0a0a').replace(
    '01000000000000000080040800800408b7000000', '01000000440d0000448d0408448d0408b7000000');
  let r; try { r = runLinux(hex, ['/w/HELLO']).status; } catch (e) { r = e.message.slice(0, 60); }
  eq('linux: a PT_LOAD whose p_offset lies past the file maps the file by pages, as the kernel does', r, 42); }
// src/bunzip2.js: bzip2 as the bzip2 command writes it (YOLP's Linux intros are .tar.bz2 on their
// authors' site, and a browser has no bzip2). Two streams in a row, made by `bzip2 -9` and `bzip2`:
// "MIRAGE bzip2 " 300 times, 300 a's (the first run-length coding), every byte value three times over
// (a full byte map), then "second stream". Held against the command's input, byte for byte; a block's
// CRC is checked by the decoder itself.
{ let got;
  try { const { bunzip2 } = await import('../src/bunzip2.js');
    const bz = Uint8Array.from((
    '425a6839314159265359dc84ed8900048e7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
    'ffffffc001ae0204bfffd55540098132698009809a6000000984c0009800000000000006801180000000001304c0264c' +
    '00000018268930004c0004c0000000000000000000000000000000000000000000000000000000049800260002600000' +
    '0000000000000000000000000000000000000000000000000000daaa51a069a1a0c464068d03269a341934d00320d0d0' +
    '34c4c401a006834340c8d000d068000d0006991a0683119006990680d1a00640686809940a09070e8442bec86459177e' +
    '08c2328d2368e23afc51e47df9240fcd21489231a46a29e540a89522a655073481095c920425561b0ab9582b2568ad8d' +
    'a40d706f2ba3815e2be388e25808348109588b18e4399641d0b28d43a9662ce5a0b496a2d63ea4084ada5b8761dc7948' +
    '1095c0b88f09021278181731e920425751e4702e8da0842576190bb9782f230481095e87a190bd8f63e0fa3497c1f87f' +
    '200be97e2fe3a0cecf3e580186049fa4084b0460cc2102614a110a90212c3988312628c598c31a4100212c718f320644' +
    '833243b99332832a4084a10ca99632e660cc90a5348633466c87338674cf19f6398f64191649936519565900cbb30ccb' +
    '34cdb38ceb3ccfbfa7f6d0342d1346d234ad334ed4352d5356d635ad735ed8362d9366da36adb36edc372dd376de37ad' +
    'f37ee0382e1386e238ae338ee4392ff1ca72dcc735ce7fae7ba0e8ba4e9ba8eabacff9d7761ffbb2ed3b6ee3baef3bef' +
    '03c2f13c6f23caf33cef43d2f53d6f63daf73def83e2f93e6fa3ea814120d0108857d90cfb8bb9229c28486e4276c480' +
    '425a6839314159265359f09397fb000005118040002e039c0020003100d34d0401a3255b0e20f24878bb9229c2848784' +
    '9cbfd8').match(/../g), (x) => parseInt(x, 16));
    const want = [...new TextEncoder().encode('MIRAGE bzip2 '.repeat(300) + 'a'.repeat(300))];
    for (let r = 0; r < 3; r++) for (let i = 0; i < 256; i++) want.push((i * 7 + r) & 255);
    want.push(...new TextEncoder().encode('second stream'));
    const out = bunzip2(bz);
    got = out.length === want.length && out.every((b, i) => b === want[i]) ? 'same' : `${out.length} bytes, want ${want.length}`;
    bz[60] ^= 1; try { bunzip2(bz); got += ', a changed byte unnoticed'; } catch (e) { got += ', ' + (/CRC|Huffman|bad|ends|overflow|selector|pointer/.test(e.message) ? 'a changed byte refused' : e.message); }
  } catch (e) { got = e.message.slice(0, 80); }
  eq('bunzip2: two streams as the bzip2 command made them; a changed byte refused', got, 'same, a changed byte refused'); }
// src/hle: libraries made in JavaScript (ROADMAP O9). makeSharedObject's library, read back as an ELF:
// each function found by DT_HASH as ld.so finds it, and by walking DT_SYMTAB with the 1K intros' own
// hash (h * 33 ^ c, Metatunnel 2009), at a stub that traps with its id. And tools/linux/hlecall.asm
// calls two stubs with an int and a float, an int and a double: the JavaScript gets them, and its
// answers come back in EAX (the exit status, 133).
{ let got;
  try { const { makeSharedObject, HLE_BASE } = await import('../src/hle/elfso.js');
    const names = ['SDL_Init', 'glCreateShader', 'glColor4ubv', 'glRecti', 'SDL_GL_SwapBuffers'];
    const so = makeSharedObject('libT.so.1', names, 10), dv = new DataView(so.buffer);
    const dyn = {}; for (let o = dv.getUint32(32 + 52 + 4, true); dv.getInt32(o, true); o += 8) dyn[dv.getInt32(o, true)] = dv.getUint32(o + 4, true);
    const name = (i) => { let s = '', o = dyn[5] + dv.getUint32(dyn[6] + 16 * i, true); while (so[o]) s += String.fromCharCode(so[o++]); return s; };
    const stub = (i) => { const v = dv.getUint32(dyn[6] + 16 * i + 4, true); return so[v] === 0xb8 && so[v + 5] === 0xcd && so[v + 6] === 0x80 && so[v + 7] === 0xc3 ? dv.getUint32(v + 1, true) - HLE_BASE : -1; };
    const sysv = (s) => { let h = 0; for (const c of s) { h = ((h << 4) + c.charCodeAt(0)) >>> 0; const g = h & 0xf0000000; if (g) h ^= g >>> 24; h &= ~g >>> 0; } return h >>> 0; };
    const byHash = (s) => { const nb = dv.getUint32(dyn[4], true); for (let i = dv.getUint32(dyn[4] + 8 + 4 * (sysv(s) % nb), true); i; i = dv.getUint32(dyn[4] + 8 + 4 * nb + 4 * i, true)) if (name(i) === s) return i; return 0; };
    const djb = (s) => { let h = 0; for (const c of s) h = (Math.imul(h, 33) ^ c.charCodeAt(0)) >>> 0; return h; };
    const byWalk = (s) => { for (let i = 0; i < dv.getUint32(dyn[4] + 4, true); i++) if (djb(name(i)) === djb(s)) return i; return 0; };
    const ok = names.every((s, k) => stub(byHash(s)) === 10 + k && stub(byWalk(s)) === 10 + k);
    const { installHLE } = await import('../src/hle/index.js');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc), seen = [];
    installHLE(lx, mc.mem, mc.cpu, [{ soname: 'libT.so.1', fns: {
      f0: ['if', (x, i, f) => { seen.push(i, f); return i + Math.round(f * 100); }],
      f1: ['id', (x, i, d) => { seen.push(i, d); return i + Math.round(d * 1000); }] } }], {});
    const hex = (
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '00000000010000000000000000800408008004089500000095000000050000000010000068db0f49406a07e825000000' +
    '83c40889c668fb21094068182d44546afee81700000083c40c01f00fb6d8b801000000cd80b800000048cd80c3b80100' +
    '0048cd80c3');
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/w/HLECALL']);
    for (let i = 0; i < 50 && !lx.done; i++) mc.runSlice(20000);
    got = [ok, lx.status, seen.map((v) => +v.toFixed(5)).join(',')].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: a library made in JavaScript, found as ld.so and the 1K intros find it, called with ints, floats and doubles', got, 'true | 133 | 7,3.14159,-2,3.14159'); }
// A void function returns what the stub left in EAX, nonzero, as lenny's libgl1-mesa-glx 7.0.3 leaves a
// context pointer there after glColor4ubv: Metatunnel draws glRecti(-eax, -eax, eax, eax) with it, and
// with 0 (libgl1-mesa-swx11's) draws nothing. A function that returns a value returns it.
{ let got;
  try { const { installHLE } = await import('../src/hle/index.js'), { HLE_BASE } = await import('../src/hle/elfso.js');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    installHLE(lx, mc.mem, mc.cpu, [{ soname: 'libT.so.1', fns: { n: ['', () => 5], v: ['', () => {}] } }], {});
    got = [lx.hle(0), lx.hle(1) === HLE_BASE + 1].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: a void function leaves EAX nonzero, a function with a value returns it', got, '5 true'); }
// src/hle/asound.js: libasound's simple PCM playback onto the /dev/dsp card (Retrospection 2009 plays
// through it): snd_pcm_open hands a handle, snd_pcm_set_params sets the card's rate, format and channels,
// snd_pcm_writei plays frames -- 16-bit as they are, floats as 16 bits. And SDL_GetError is a pointer to
// "", not a string (it returned the JavaScript string itself).
{ let got;
  try { const { asound } = await import('../src/hle/asound.js'), { sdl12 } = await import('../src/hle/sdl12.js'), { guestMemory } = await import('../src/hle/memory.js');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from('7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000000000000100000000000000008004080080040858000000580000000500000000100000b801000000cd80'.match(/../g), (x) => parseInt(x, 16)), ['/w/T']);
    const x = { ...guestMemory(lx, mc.mem), lx }, f = asound().fns, pp = lx.alloc(4), buf = lx.alloc(32);
    const open = f.snd_pcm_open[1](x, pp, 0, 0, 0), h = x.r32(pp);
    const set = f.snd_pcm_set_params[1](x, h, 2, 3, 2, 22050, 1, 500000), card = `${lx.dsp.rate}/${lx.dsp.fmt}/${lx.dsp.ch}`;
    [1000, -1000, 32767, -32768].forEach((v, i) => x.w16(buf + 2 * i, v));
    const n16 = f.snd_pcm_writei[1](x, h, buf, 2), s16 = mc.dsp.drain().samples.join(',');
    f.snd_pcm_set_params[1](x, h, 14, 3, 1, 8000, 1, 500000);
    const fv = new DataView(new ArrayBuffer(8)); fv.setFloat32(0, 0.5, true); fv.setFloat32(4, -2, true); x.write(buf, new Uint8Array(fv.buffer));
    const nf = f.snd_pcm_writei[1](x, h, buf, 2), sf = mc.dsp.drain().samples.join(',');
    const e = sdl12().fns.SDL_GetError[1](x);
    got = [open, h !== 0, set, card, n16, s16, nf, sf, typeof e, x.r8(e)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: libasound plays S16 and float frames on the /dev/dsp card; SDL_GetError is a pointer to ""', got, '0 true 0 22050/16/2 2 1000,-1000,32767,-32768 2 16384,16384,-32767,-32767 number 0'); }
// MIRAGE-WIN32 (src/win32): tools/win32/pebwalk.asm finds ExitProcess as Crinkler's header finds what it
// imports -- fs:[30h] to the PEB, its loader data, the load-order list (exe, ntdll, kernel32), kernel32's
// export directory -- and calls it with 42; the loader has bound its import of lz32.dll's ordinal 4.
// opengl32.dll's ordinals are XP's (Crinkler's /RANGE imports by them: Stripped, 2009); msvcrt's cos
// returns its double on the x87 stack, as cdecl does.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const hex = (
    '4d5a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000040000000504500004c010100000000000000000000000000e00002010b01000000020000' +
    '000000000000000000100000001000000000000000004000001000000002000004000000000000000400000000000000' +
    '002000000002000000000000030000000000100000100000000010000010000000000000100000000000000000000000' +
    '6a1000002800000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000002e7465787400000000100000001000000002000000020000' +
    '000000000000000000000000200000e00000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000064a1300000008b400c8b400c8b008b00' +
    '8b58188b433c8b54037801da8b4a188b6a2001dd4978368b748d0001debf5e10400051b90c000000f3a65975e78b4224' +
    '01d80fb704488b721c01de8b048601d8833d9a1040000074046a2affd0cc4578697450726f6365737300921000000000' +
    '000000000000a21000009a10000000000000000000000000000000000000000000000400008000000000040000800000' +
    '00006c7a33322e646c6c');
    const exe = new Uint8Array(1024); exe.set(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const apis = win32Apis(), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: traceBackend() });
    for (let i = 0; i < 50 && !lx.done; i++) mc.runSlice(20000);
    const ogl = apis.find((d) => d.dll === 'opengl32.dll').fns, ord = (n) => (ogl[n][2] || {}).ordinal;
    const cos = apis.find((d) => d.dll === 'msvcrt.dll').fns.cos[1](x, Math.PI), top = mc.cpu.fst[mc.cpu.ftop];
    got = [lx.done && lx.status, ord('GlmfBeginGlsBlock'), ord('glAccum'), ord('glViewport'), ord('wglCreateContext'), ord('wglUseFontOutlinesW'), cos.st0].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a PE walks the PEB to kernel32\'s exports as Crinkler does; opengl32\'s ordinals as XP\'s; a double returned in ST0', got, '42 1 7 343 346 368 -1'); }
// tools/win32/tinyhdr.asm: a PE as Crinkler's /TINYHEADER lays one out -- no section, alignment 4, the
// code in the headers, SizeOfImage past the file -- is mapped flat, as Windows maps an image whose
// section alignment is below the page's: it reads a byte past SizeOfHeaders (42) and one past the
// file (0) and exits with their sum. Absolute Territory (Prismbeings, 2017) is such an image.
{ let got, fcw;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const exe = Uint8Array.from((                       // nasm -f bin tools/win32/tinyhdr.asm
    '4d5a0000504500004c010000000000000000000000000000600002010b0100000000000000000000000000007c000000' +
    '000000000000000000004000040000000400000004000000000000000400000000000000000001004000000000000000' +
    '0300000000001000001000000000100000100000000000000000000064a1300000008b400c8b400c8b008b008b58188b' +
    '433c8b54037801da8b4a188b6a2001dd49783c8b748d0001debfe000400051b90c000000f3a65975e78b422401d80fb7' +
    '04488b721c01de8b048601d80fb60dec0040000fb615ed01400001d151ffd0cc4578697450726f63657373002a').match(/../g), (x) => parseInt(x, 16));
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    loadPE(lx, mc.mem, mc.cpu, exe, { apis: win32Apis(), backend: traceBackend() });
    fcw = mc.cpu.fcw;
    for (let i = 0; i < 50 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done, lx.signal ? 'fault' : lx.status].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a /TINYHEADER image is mapped flat, the whole file at its base', got, 'true 42');
  eq('win32: a process starts with the x87 at 53 bits (control word 027Fh, which MSVC\'s CRT keeps)', fcw, 0x27f); }
// tools/linux/thread.asm: two threads of one address space (lx.spawnThread: SDL_CreateThread's, Win32's
// CreateThread's). The main thread spins on a flag with no system call -- the clock's preemption gives
// the thread its turn --, the thread sets it to 42 and exit(0)s alone (freeing the shared pages would
// fault the spin), the main thread exits with the flag.
{ let got;
  try { const hex = (                                   // nasm -f bin tools/linux/thread.asm
    '7f454c4601010100000000000000000002000300010000005480040834000000000000000000000034002000010000000000000001000000' +
    '000000000080040800800408790000007d1000000700000000100000a17980040885c074f789c3b801000000cd80c705798004082a000000' +
    'b80100000031dbcd80');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/THREAD']);
    const tid = lx.spawnThread({ eip: 0x08048066, esp: 0x08049070 });
    for (let i = 0; i < 400 && !lx.done; i++) mc.runSlice(20000);
    got = [lx.done && lx.status, lx.signal, lx.threadExits.get(tid)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('linux: a thread shares its process\'s memory, is preempted to, and exits alone', got, '42 0 0'); }
// Direct3D 9 (src/win32/d3d9.js): Direct3DCreate9's object is a vtable of d3d9.dll's stubs in IDirect3D9's
// order (CreateDevice the 17th); a windowed device of size 0 takes its window's and says so in the
// parameters; D3DXCompileShader's bytecode is PRISM's blob (ps_2_0's version token, a comment holding
// 'PRSM', the end token), handed whole to CreatePixelShader; a vertex buffer's locked bytes reach the
// model at the unlock; a texture is its handle to the model, not its height (cdak, 2010: a 1280x720
// render target handed on as handle 720), and its locked level reaches the model whole at the unlock;
// D3DXMatrixPerspectiveFovLH is d3dx9math.h's.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const be = traceBackend(), apis = win32Apis(), { x, win } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: be });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1];
    const d3d = fn('d3d9.dll', 'Direct3DCreate9')(x, 32), mod = win.modules.get('d3d9.dll');
    const wired = x.r32(x.r32(d3d) + 16 * 4) === mod.exports.get('IDirect3D9::CreateDevice');
    const pp = x.win.heapAlloc(56), ppDev = x.win.heapAlloc(4); x.write(pp, new Uint8Array(56)); x.w32(pp + 32, 1);
    fn('d3d9.dll', 'IDirect3D9::CreateDevice')(x, d3d, 0, 1, 0, 0x40, pp, ppDev);
    const dev = x.r32(ppDev), size = `${x.r32(pp)}x${x.r32(pp + 4)}`;
    const src = 'float4 main():COLOR{return 1;}', ps = x.win.heapAlloc(64), prof = x.win.heapAlloc(16), ent = x.win.heapAlloc(8), ppBuf = x.win.heapAlloc(4), ppPS = x.win.heapAlloc(4);
    x.write(ps, new TextEncoder().encode(src)); x.write(prof, new TextEncoder().encode('ps_2_0\0')); x.write(ent, new TextEncoder().encode('main\0'));
    fn('d3dx9_37.dll', 'D3DXCompileShader')(x, ps, src.length, 0, 0, ent, prof, 0, ppBuf, 0, 0);
    const code = fn('d3d9.dll', 'ID3DXBuffer::GetBufferPointer')(x, x.r32(ppBuf));
    fn('d3d9.dll', 'IDirect3DDevice9::CreatePixelShader')(x, dev, code, ppPS);
    const toks = be.d3d.device.last.createPixelShader[0], size4 = fn('d3d9.dll', 'ID3DXBuffer::GetBufferSize')(x, x.r32(ppBuf)) / 4;
    const blob = [x.r32(code).toString(16), x.r32(code + 8).toString(16), toks.length === size4, toks[toks.length - 1].toString(16)].join(',');
    const ppVB = x.win.heapAlloc(4), ppData = x.win.heapAlloc(4);
    fn('d3d9.dll', 'IDirect3DDevice9::CreateVertexBuffer')(x, dev, 64, 0, 0x44, 0, ppVB, 0);
    fn('d3d9.dll', 'IDirect3DVertexBuffer9::Lock')(x, x.r32(ppVB), 16, 8, ppData, 0);
    x.write(x.r32(ppData), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    fn('d3d9.dll', 'IDirect3DVertexBuffer9::Unlock')(x, x.r32(ppVB));
    const [, off, bytes] = be.d3d.device.last.bufferWrite;
    const ppTex = x.win.heapAlloc(4), lr = x.win.heapAlloc(8);
    fn('d3d9.dll', 'IDirect3DDevice9::CreateTexture')(x, dev, 64, 32, 1, 0, 21, 1, ppTex, 0);
    fn('d3d9.dll', 'IDirect3DDevice9::SetTexture')(x, dev, 0, x.r32(ppTex));
    fn('d3d9.dll', 'IDirect3DTexture9::LockRect')(x, x.r32(ppTex), 0, lr, 0, 0);
    fn('d3d9.dll', 'IDirect3DTexture9::UnlockRect')(x, x.r32(ppTex), 0);
    const tw = be.d3d.device.last.textureWrite, tex = [be.d3d.device.last.setTexture[1], tw[0], x.r32(lr), tw[3].length, tw[4]].join(' ');
    const m = x.win.heapAlloc(64); fn('d3dx9_37.dll', 'D3DXMatrixPerspectiveFovLH')(x, m, Math.PI / 2, 2, 1, 3);
    got = [wired, size, blob, off, bytes.join(''), tex, [0, 5, 10, 11, 14].map((i) => +x.f32(m + 4 * i).toFixed(3)).join(' ')].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: Direct3D 9 objects, D3DXCompileShader\'s blob, a vertex buffer\'s lock, D3DX\'s perspective', got, 'true | 640x480 | ffff0200,4d535250,true,ffff | 16 | 12345678 | 3 3 256 8192 256 | 0.5 1 1.5 1 -1.5'); }
// D3DX's meshes (src/win32/d3d9.js; Wine's d3dx9_36 as the oracle), as Elevated (2009) makes its terrain:
// D3DXCreatePolygon's square (side 2: corners at sqrt 2 from the centre, the first at +y; faces fanned from
// the centre; adjacency across the spokes), cloned to 32-bit indices, cut by D3DXTessellateNPatches into
// 2 segments an edge (16 faces of 6 points each, flat, the normal kept), drawn by DrawSubset as one
// indexed triangle list; D3DXFillTexture calling a function of the program for each texel's centre — here
// one that returns its x, so a 2x2 R16F texture holds 0.25 and 0.75 as float16.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const be = traceBackend(), apis = win32Apis(), { x, win } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: be });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1], d9 = (n) => fn('d3d9.dll', n), dx = (n) => fn('d3dx9_33.dll', n);
    const pp = x.win.heapAlloc(56), pp4 = () => x.win.heapAlloc(4); x.write(pp, new Uint8Array(56)); x.w32(pp + 32, 1);
    const ppDev = pp4(); d9('IDirect3D9::CreateDevice')(x, d9('Direct3DCreate9')(x, 32), 0, 1, 0, 0x40, pp, ppDev);
    const dev = x.r32(ppDev), ppM = pp4(), ppAdj = pp4(), pl = pp4();
    dx('D3DXCreatePolygon')(x, dev, 2, 4, ppM, ppAdj);
    const m = x.r32(ppM); d9('ID3DXMesh::LockVertexBuffer')(x, m, 0, pl);
    const v = (p, i, k) => +x.f32(x.r32(p) + 24 * i + 4 * k).toFixed(3) + 0;
    const poly = [v(pl, 1, 0), v(pl, 1, 1), v(pl, 2, 0), v(pl, 2, 1), v(pl, 3, 5)].join(' ');
    d9('ID3DXMesh::LockIndexBuffer')(x, m, 0, pl); const idx = Array.from({ length: 12 }, (_, i) => x.r16(x.r32(pl) + 2 * i)).join('');
    const adj = d9('ID3DXBuffer::GetBufferPointer')(x, x.r32(ppAdj)), adjs = Array.from({ length: 6 }, (_, i) => x.r32(adj + 4 * i) | 0).join(' ');
    d9('ID3DXMesh::CloneMeshFVF')(x, m, 1, 0x12, dev, ppM);
    const c = x.r32(ppM); d9('ID3DXMesh::LockIndexBuffer')(x, c, 0, pl); const wide = x.r32(x.r32(pl) + 4 * 11);
    dx('D3DXTessellateNPatches')(x, c, 0, 2, 0, ppM, 0);
    const t = x.r32(ppM); d9('ID3DXMesh::LockVertexBuffer')(x, t, 0, pl);
    const tess = [d9('ID3DXMesh::GetNumFaces')(x, t), d9('ID3DXMesh::GetNumVertices')(x, t), v(pl, 1, 0), v(pl, 1, 1), v(pl, 1, 5)].join(' ');
    d9('ID3DXMesh::DrawSubset')(x, t, 0);
    const draw = be.d3d.device.last.drawIndexedPrimitive.join(' ');
    const ppTex = pp4(); d9('IDirect3DDevice9::CreateTexture')(x, dev, 2, 2, 1, 0, 111, 1, ppTex, 0);
    // the program: D3DXFillTexture(tex, f, 0), then exit with what it returned; f(out, coord, size, data): out.x = coord.x
    const code = x.win.heapAlloc(64), f = code + 32, fill = win.load('d3dx9_33.dll').exports.get('D3DXFillTexture');
    const b32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
    x.write(code, Uint8Array.from([0x6a, 0, 0x68, ...b32(f), 0x68, ...b32(x.r32(ppTex)), 0xb8, ...b32(fill), 0xff, 0xd0, 0x89, 0xc3, 0xb8, 1, 0, 0, 0, 0xcd, 0x80]));
    x.write(f, Uint8Array.from([0x8b, 0x44, 0x24, 0x04, 0x8b, 0x4c, 0x24, 0x08, 0x8b, 0x11, 0x89, 0x10, 0xc2, 0x10, 0x00]));
    mc.cpu.eip = code;
    for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
    const tw = be.d3d.device.last.textureWrite, texels = [lx.done && lx.status, [...tw[3]].map((b) => b.toString(16)).join(' '), tw[4]].join(' ');
    got = [poly, idx, adjs, wide, tess, draw, texels].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: D3DX meshes — a polygon, a 32-bit clone, N-patches, DrawSubset; D3DXFillTexture calling the program', got,
    '0 1.414 -1.414 0 1 | 012023034041 | 3 -1 1 0 -1 2 | 1 | 16 24 -0.707 0 1 | 4 0 0 24 0 16 | 0 0 34 0 3a 0 34 0 3a 4'); }
// d3dx9_NN.dll numbers its exports as Microsoft's does, its version's names in ASCII order from 1 (Wine's
// .spec lists): Crinkler's /RANGE imports by ordinal, and Stiletto (2009) called D3DXAssembleShader where it
// meant D3DXCreateSkinInfoFVF. And D3DX's mesh tools as Wine's: GenerateAdjacency finds D3DXCreatePolygon's
// own adjacency, D3DXComputeNormals the square's +z, UpdateSkinnedMesh moves a vertex by its bone's matrix
// (weight 1, translated by (1, 2, 3)) and leaves one no bone holds at zero.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const be = traceBackend(), apis = win32Apis(), { x, win } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: be });
    const ord = (v, n) => { const d = win.load(`d3dx9_${v}.dll`); return [...d.byOrdinal].find(([, a]) => a === d.exports.get(n))[0]; };
    const ords = [[24, 'D3DXCreateSkinInfoFVF'], [33, 'D3DXCreateSkinInfoFVF'], [42, 'D3DXCreateSkinInfoFVF'], [33, 'D3DXAssembleShader'], [33, 'D3DXComputeNormals']].map(([v, n]) => ord(v, n)).join(' ');
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1], d9 = (n) => fn('d3d9.dll', n), dx = (n) => fn('d3dx9_33.dll', n);
    const pp = x.win.heapAlloc(56), pp4 = () => x.win.heapAlloc(4); x.write(pp, new Uint8Array(56)); x.w32(pp + 32, 1);
    const ppDev = pp4(); d9('IDirect3D9::CreateDevice')(x, d9('Direct3DCreate9')(x, 32), 0, 1, 0, 0x40, pp, ppDev);
    const dev = x.r32(ppDev), ppM = pp4(), ppAdj = pp4(), pl = pp4(), adj = x.win.heapAlloc(48);
    dx('D3DXCreatePolygon')(x, dev, 2, 4, ppM, ppAdj);
    const m = x.r32(ppM); d9('ID3DXMesh::GenerateAdjacency')(x, m, 0, adj);
    const same = Array.from({ length: 12 }, (_, i) => x.r32(adj + 4 * i) === x.r32(d9('ID3DXBuffer::GetBufferPointer')(x, x.r32(ppAdj)) + 4 * i)).every(Boolean);
    d9('ID3DXMesh::LockVertexBuffer')(x, m, 0, pl); const vb = x.r32(pl);
    for (let v = 0; v < 5; v++) x.write(vb + 24 * v + 12, new Uint8Array(12));
    dx('D3DXComputeNormals')(x, m, adj);
    const nz = [x.f32(vb + 24 * 2 + 12), x.f32(vb + 24 * 2 + 16), x.f32(vb + 24 * 2 + 20)].map((v) => +v.toFixed(3) + 0).join(',');
    const ppS = pp4(), vs = x.win.heapAlloc(4), ws = x.win.heapAlloc(4), mat = x.win.heapAlloc(64), dst = x.win.heapAlloc(5 * 24);
    dx('D3DXCreateSkinInfoFVF')(x, 5, 0x12, 1, ppS); const sk = x.r32(ppS);
    x.w32(vs, 1); x.write(ws, new Uint8Array(Float32Array.of(1).buffer)); d9('ID3DXSkinInfo::SetBoneInfluence')(x, sk, 0, 1, vs, ws);
    x.write(mat, new Uint8Array(Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1).buffer));
    d9('ID3DXSkinInfo::UpdateSkinnedMesh')(x, sk, mat, 0, vb, dst);
    const sv = (v) => [0, 1, 2, 3, 4, 5].map((k) => +x.f32(dst + 24 * v + 4 * k).toFixed(3) + 0).join(',');
    got = [ords, same, nz, sv(1), sv(0), d9('ID3DXSkinInfo::GetNumBones')(x, sk)].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: d3dx9 exports numbered as Microsoft\'s; GenerateAdjacency, D3DXComputeNormals, a skin\'s UpdateSkinnedMesh as Wine\'s', got,
    '84 87 86 1 26 | true | 0,0,1 | 1,3.414,3,0,0,1 | 0,0,0,0,0,0 | 1'); }
// D3DXCreateText (src/win32/textmesh.js, Wine's algorithm) from a font gdi32 selects, read by truetype.js:
// a TrueType font made here, an em of 1000 and a cell of 1000 (so a pixel an em unit). 'A' a 600-unit
// square with a 200-unit square hole: two outlines of four corners, eight triangles between them, each
// corner twice on the sides; its face covers 0.36 - 0.04 em². 'B' a square of quadratic splines that
// starts off the curve (it starts at its last point): GGO_NATIVE's line-free contour of four splines; cut
// to a deviation of 0.05 em, each is two halves whose control points Wine keeps, the points between on
// straight runs merged away: an octagon of 0.36 - 4 x 0.01125 em². The glyph metrics in ems; Direct3D's
// default light (white, +z), enabled (128, as Wine's wined3d).
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const { parseTrueType } = await import('../src/win32/truetype.js');
    const glyf = (contours) => {                                     // a simple glyph: flags and coordinates as words
      const pts = contours.flat(), b = [];
      const w16 = (v) => b.push((v >> 8) & 255, v & 255);
      w16(contours.length); [0, 0, 600, 600].forEach(w16);
      let e = -1; for (const c of contours) w16(e += c.length);
      w16(0); for (const q of pts) b.push(q[2] ? 1 : 0);
      for (const k of [0, 1]) { let last = 0; for (const q of pts) { w16(q[k] - last); last = q[k]; } }
      if (b.length & 1) b.push(0);
      return b;
    };
    const gA = glyf([[[0, 0, 1], [0, 600, 1], [600, 600, 1], [600, 0, 1]], [[200, 200, 1], [400, 200, 1], [400, 400, 1], [200, 400, 1]]]);
    const gB = glyf([[[0, 0, 0], [0, 300, 1], [0, 600, 0], [300, 600, 1], [600, 600, 0], [600, 300, 1], [600, 0, 0], [300, 0, 1]]]);
    const be16 = (...v) => v.flatMap((n) => [(n >> 8) & 255, n & 255]);
    const head = new Array(54).fill(0); head.splice(18, 2, ...be16(1000));
    const os2 = new Array(78).fill(0); os2.splice(74, 4, ...be16(800, 200));
    const hhea = new Array(36).fill(0); hhea.splice(34, 2, ...be16(3));
    const tables = { head, maxp: [0, 0, 0x50, 0, ...be16(3)], hhea, 'OS/2': os2, hmtx: be16(500, 0, 700, 0, 650, 0),
      cmap: [...be16(0, 1, 3, 1, 0, 12), ...be16(4, 32, 0, 4, 0, 0, 0, 0x42, 0xffff, 0, 0x41, 0xffff, (1 - 0x41) & 0xffff, 1, 0, 0)],
      loca: be16(0, 0, gA.length / 2, (gA.length + gB.length) / 2), glyf: [...gA, ...gB] };
    const names = Object.keys(tables), ttf = [...be16(1, 0, names.length, 0, 0, 0)];
    let at = 12 + 16 * names.length;
    for (const n of names) { ttf.push(...[...n].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...be16(at >>> 16, at & 0xffff, 0, tables[n].length)); at += tables[n].length; }
    for (const n of names) ttf.push(...tables[n]);
    const font = Uint8Array.from(ttf), B = parseTrueType(font).glyph(0x42, 1000);
    const native = B.contours.map((c) => c.start.join(',') + ' ' + c.curves.map((cv) => (cv.spline ? 'q' : 'l') + cv.pts.length).join('')).join(' ');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const be = traceBackend(), apis = win32Apis({ fonts: { tiny: font } }), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: be });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1], d9 = (n) => fn('d3d9.dll', n), gdi = (n) => fn('gdi32.dll', n);
    const pp = x.win.heapAlloc(56), pp4 = () => x.win.heapAlloc(4); x.write(pp, new Uint8Array(56)); x.w32(pp + 32, 1);
    const ppDev = pp4(); d9('IDirect3D9::CreateDevice')(x, d9('Direct3DCreate9')(x, 32), 0, 1, 0, 0x40, pp, ppDev);
    const dev = x.r32(ppDev), lf = x.win.heapAlloc(60), text = x.win.heapAlloc(4), ppM = pp4(), gm = x.win.heapAlloc(48), pl = pp4();
    x.write(lf, new Uint8Array(60)); x.write(lf + 28, new TextEncoder().encode('TINY\0')); x.write(text, new TextEncoder().encode('AB\0'));
    const dc = gdi('CreateCompatibleDC')(x, 0); gdi('SelectObject')(x, dc, gdi('CreateFontIndirectA')(x, lf));
    fn('d3dx9_33.dll', 'D3DXCreateTextA')(x, dev, dc, text, 0.05, 0, ppM, 0, gm);
    const m = x.r32(ppM), nf = d9('ID3DXMesh::GetNumFaces')(x, m), nv = d9('ID3DXMesh::GetNumVertices')(x, m);
    d9('ID3DXMesh::LockVertexBuffer')(x, m, 0, pl); const vb = x.r32(pl);
    d9('ID3DXMesh::LockIndexBuffer')(x, m, 0, pl); const ib = x.r32(pl);
    // the area of the faces facing +z at z = 0 left of x = 0.65 ('A'), and right of it ('B')
    let aA = 0, aB = 0;
    for (let f = 0; f < nf; f++) {
      const P = [0, 1, 2].map((k) => { const v = vb + 24 * x.r16(ib + 6 * f + 2 * k); return [x.f32(v), x.f32(v + 4), x.f32(v + 8), x.f32(v + 20)]; });
      if (P.some((q) => q[3] !== 1 || q[2] !== 0)) continue;
      const a = ((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2;
      if (P[0][0] < 0.65) aA += a; else aB += a;
    }
    const metrics = [0, 1, 2, 3, 4, 6, 10].map((k) => +x.f32(gm + 4 * k).toFixed(3)).join(',');
    const light = x.win.heapAlloc(104), on = pp4();
    d9('IDirect3DDevice9::LightEnable')(x, dev, 3, 1); d9('IDirect3DDevice9::GetLight')(x, dev, 3, light); d9('IDirect3DDevice9::GetLightEnable')(x, dev, 3, on);
    const def = [x.r32(light), x.f32(light + 4), x.f32(light + 72), x.r32(on)].join(',');
    got = [native, nv, nf, +aA.toFixed(4) / 2, +aB.toFixed(3) / 2, metrics, def].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: D3DXCreateText from a TrueType font gdi32 selects: GGO_NATIVE\'s contours, Wine\'s outlines, triangles and sides', got,
    '300,0 q2q2q2q2 | 82 | 60 | 0.32 | 0.315 | 0.6,0.6,0,0.6,0.7,0.6,0.65 | 3,1,1,128'); }
// What the 4K intros of 2005-2008 met (2026-11-06). dx8vb.dll's exports numbered as Microsoft's (Wine's
// .spec order): Polystreptikum finds VB_D3DXVec3Add by hash and takes the 104 functions after it by ordinal,
// the last VB_D3DXVec3CatmullRom; its CatmullRom as D3DX's, a length on the x87 stack. ID3DXMatrixStack as
// Wine's (Atrium): ScaleLocal after TranslateLocal scales first; Translate multiplies on the right; Pop.
// D3DXCreateBox as Wine's: corner 6 of a 2x4x6 box at (1, 2, 3) with +y's normal, face 1 (2, 3, 0).
// MultiplyTransform as wined3d: pMatrix x the state's, so a scaling leaves the translation alone. A DIB
// section's pixels are the program's memory: TextOutA's opaque background lands there, the pixel the
// program wrote outside it stays. DrawPrimitiveUP of XYZ vertices 16 bytes apart (luxo4k) reaches the model
// packed at 12. "Times" is Times New Roman (FontSubstitutes): its metrics, not the no-font guess.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    // a TrueType font of one empty glyph: an em of 1000, ascent 900, descent 300, every character 700 wide
    const be16 = (...v) => v.flatMap((n) => [(n >> 8) & 255, n & 255]);
    const head = new Array(54).fill(0); head.splice(18, 2, ...be16(1000));
    const os2 = new Array(78).fill(0); os2.splice(74, 4, ...be16(900, 300));
    const hhea = new Array(36).fill(0); hhea.splice(34, 2, ...be16(1));
    const tables = { head, maxp: [0, 0, 0x50, 0, ...be16(1)], hhea, 'OS/2': os2, hmtx: be16(700, 0),
      cmap: [...be16(0, 1, 3, 1, 0, 12), ...be16(4, 24, 0, 2, 2, 0, 0, 0xffff, 0, 0xffff, 1, 0)], loca: be16(0, 0), glyf: [] };
    const names = Object.keys(tables), ttf = [...be16(1, 0, names.length, 0, 0, 0)];
    let at = 12 + 16 * names.length;
    for (const n of names) { ttf.push(...[...n].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...be16(at >>> 16, at & 0xffff, 0, tables[n].length)); at += tables[n].length; }
    for (const n of names) ttf.push(...tables[n]);
    const be = traceBackend(), apis = win32Apis({ fonts: { 'times new roman': Uint8Array.from(ttf) } }), { x, win } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: be });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1], d9 = (n) => fn('d3d9.dll', n), dx = (n) => fn('d3dx9_24.dll', n), vb = (n) => fn('dx8vb.dll', n), gdi = (n) => fn('gdi32.dll', n);
    const dxvb = win.load('dx8vb'), ord = (n) => [...dxvb.byOrdinal].find(([, a]) => a === dxvb.exports.get(n))[0];
    const ords = ['VB_D3DXVec3Add', 'VB_D3DXVec3CatmullRom', 'DllGetClassObject'].map(ord).join(' ');
    const fl = (p, ...v) => x.write(p, new Uint8Array(Float32Array.from(v).buffer)), rf = (p, n) => Array.from({ length: n }, (_, i) => +x.f32(p + 4 * i).toFixed(3) + 0);
    const P = x.win.heapAlloc(16 * 4); [0, 1, 2, 3].forEach((i) => fl(P + 16 * i, i, 2 * i, 0));
    const out = x.win.heapAlloc(16); vb('VB_D3DXVec3CatmullRom')(x, out, P, P + 16, P + 32, P + 48, 0.5);
    fl(P, 3, 4, 0); const len = vb('VB_D3DXVec3Length')(x, P).st0;
    const pp = x.win.heapAlloc(56), pp4 = () => x.win.heapAlloc(4); x.write(pp, new Uint8Array(56)); x.w32(pp + 32, 1);
    const ppDev = pp4(); d9('IDirect3D9::CreateDevice')(x, d9('Direct3DCreate9')(x, 32), 0, 1, 0, 0x40, pp, ppDev); const dev = x.r32(ppDev);
    const ppS = pp4(); dx('D3DXCreateMatrixStack')(x, 0, ppS); const S = x.r32(ppS), ms = (n, ...a) => d9(`ID3DXMatrixStack::${n}`)(x, S, ...a);
    ms('TranslateLocal', 1, 2, 3); ms('ScaleLocal', 2, 2, 2);
    const t1 = rf(ms('GetTop'), 16).filter((_, i) => i === 0 || i >= 12).join(',');
    ms('Push'); ms('Translate', 10, 0, 0); const t2 = rf(ms('GetTop') + 48, 3).join(','); ms('Pop'); const t3 = rf(ms('GetTop') + 48, 3).join(',');
    const ppM = pp4(), pl = pp4(); dx('D3DXCreateBox')(x, dev, 2, 4, 6, ppM, 0); const box = x.r32(ppM);
    d9('ID3DXMesh::LockVertexBuffer')(x, box, 0, pl); const corner = rf(x.r32(pl) + 24 * 6, 6).join(',');
    d9('ID3DXMesh::LockIndexBuffer')(x, box, 0, pl); const face1 = [3, 4, 5].map((k) => x.r16(x.r32(pl) + 2 * k)).join(',');
    const boxN = [d9('ID3DXMesh::GetNumVertices')(x, box), d9('ID3DXMesh::GetNumFaces')(x, box)].join(' ');
    const m = x.win.heapAlloc(64); fl(m, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1); d9('IDirect3DDevice9::SetTransform')(x, dev, 256, m);
    fl(m, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1); d9('IDirect3DDevice9::MultiplyTransform')(x, dev, 256, m);
    d9('IDirect3DDevice9::GetTransform')(x, dev, 256, m); const world = rf(m, 16).filter((_, i) => i === 0 || i === 12).join(',');
    // a 32-bit top-down DIB section, 32x20; the program writes pixel (30, 10), then text at (2, 1) on red
    const bmi = x.win.heapAlloc(40); x.write(bmi, new Uint8Array(40)); x.w32(bmi, 40); x.w32(bmi + 4, 32); x.w32(bmi + 8, -20); x.w16(bmi + 12, 1); x.w16(bmi + 14, 32);
    const ppBits = pp4(), hbm = gdi('CreateDIBSection')(x, 0, bmi, 0, ppBits, 0, 0), bits = x.r32(ppBits), dc = gdi('CreateCompatibleDC')(x, 0);
    x.w32(bits + 4 * (10 * 32 + 30), 0x123456); gdi('SelectObject')(x, dc, hbm); gdi('SetBkColor')(x, dc, 0x0000ff);
    const txt = x.win.heapAlloc(4); x.write(txt, new TextEncoder().encode('AB\0'));
    gdi('TextOutA')(x, dc, 2, 1, txt, 2);
    const px = (X, Y) => x.r32(bits + 4 * (Y * 32 + X)).toString(16);
    const dib = [px(2, 1), px(1, 1), px(30, 10)].join(',');
    fl(P, 0, 0, 0, 9, 1, 0, 0, 9, 0, 1, 0, 9); d9('IDirect3DDevice9::SetFVF')(x, dev, 2); d9('IDirect3DDevice9::DrawPrimitiveUP')(x, dev, 4, 1, P, 16);
    const [, , vtx, vstride] = be.d3d.device.last.drawPrimitiveUP, up = `${vtx.length}/${vstride} ${new Float32Array(vtx.slice().buffer)[3]}`;
    const lf = x.win.heapAlloc(60); x.write(lf, new Uint8Array(60)); x.w32(lf, -10); x.write(lf + 28, new TextEncoder().encode('Times\0'));
    const dc2 = gdi('CreateCompatibleDC')(x, 0); gdi('SelectObject')(x, dc2, gdi('CreateFontIndirectA')(x, lf));
    const size = x.win.heapAlloc(8); gdi('GetTextExtentPoint32A')(x, dc2, txt, 2, size);
    got = [ords, rf(out, 3).join(','), +len.toFixed(3), t1, t2, t3, boxN, corner, face1, world, dib, up, x.r32(size), x.r32(size + 4)].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: dx8vb.dll\'s ordinals and math, ID3DXMatrixStack, D3DXCreateBox, MultiplyTransform, a DIB section\'s text, "Times"', got,
    '19 122 137 | 1.5,3,0 | 5 | 2,1,2,3,1 | 11,2,3 | 1,2,3 | 24 12 | 1,2,3,0,1,0 | 2,3,0 | 2,1 | ff0000,0,123456 | 36/12 1 | 14 | 12'); }
// SwapBuffers with one frame in flight: while the page has not taken the last frame (backend.swapReady),
// the swap waits and presents nothing; once taken, it presents. Without it Absolute Territory (2017),
// one rectangle of 38 ms of GPU a frame, swapped sixty times a guest second and starved the page.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    let swaps = 0, ready = false;
    const apis = win32Apis(), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: { swap() { swaps++; }, swapReady: () => ready } });
    const swap = apis.find((d) => d.dll === 'gdi32.dll').fns.SwapBuffers[1];
    mc.cpu.cycles += mc.cyclesPerSecond || 1e8;                      // a second in: past any sixtieth
    const held = swap(x, 0) === lx.BLOCK, n0 = swaps;
    ready = true; const r = swap(x, 0);
    got = [held, n0, r, swaps].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: SwapBuffers waits while the page has not taken the last frame, then presents', got, 'true 0 1 1'); }
// WinQuake (id Software, 1997) on MIRAGE-WIN32: what it needed, each answered as Windows answers it.
// The context comes from tools/win32/tinyhdr.asm's image (the test above); the functions are called
// as the program's stubs call them.
{ const w32 = async (args = '', opts = {}) => {
    const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const exe = Uint8Array.from((
    '4d5a0000504500004c010000000000000000000000000000600002010b0100000000000000000000000000007c000000' +
    '000000000000000000004000040000000400000004000000000000000400000000000000000001004000000000000000' +
    '0300000000001000001000000000100000100000000000000000000064a1300000008b400c8b400c8b008b008b58188b' +
    '433c8b54037801da8b4a188b6a2001dd49783c8b748d0001debfe000400051b90c000000f3a65975e78b422401d80fb7' +
    '04488b721c01de8b048601d80fb60dec0040000fb615ed01400001d151ffd0cc4578697450726f63657373002a').match(/../g), (v) => parseInt(v, 16));
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc);
    const apis = win32Apis(opts), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, args, backend: traceBackend() });
    const fn = (dll, name) => { const f = apis.find((d) => d.dll === dll).fns[name][1]; return (...a) => f(x, ...a); };
    const str = (t) => { const b = new TextEncoder().encode(t + '\0'), p = x.win.heapAlloc(b.length); x.write(p, b); return p; };
    return { mc, lx, x, apis, fn, str };
  };
  let got;
  // VirtualAlloc's regions are not the heap's: the C runtime's 4 MiB reserve and the game's 16 MiB from
  // HeapAlloc both began at 10000000h, and Quake's zone was overwritten ("Z_CheckHeap").
  try { const { fn, x } = await w32(), va = fn('kernel32.dll', 'VirtualAlloc')(0, 0x400000, 0x2000, 4), heap = x.r32(x.win.peb + 0x18);
    const big = fn('kernel32.dll', 'HeapAlloc')(heap, 0, 0x1000000);
    got = String(va + 0x400000 <= big || big + 0x1000000 <= va);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: VirtualAlloc\'s region and a 16 MiB HeapAlloc do not overlap', got, 'true');
  // The command line: the program's path quoted, then its arguments (WinQuake's -dibonly).
  try { const { fn, x } = await w32('-dibonly -nosound'); got = x.str(fn('kernel32.dll', 'GetCommandLineA')(), 64); } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: GetCommandLineA gives the arguments after the quoted path', got, '"C:\\intro.exe" -dibonly -nosound');
  // An 8-bit DIB section, its colour table set, stretched into the window: on the card's framebuffer.
  try { const { mc, fn, x } = await w32(), g = (n) => fn('gdi32.dll', n);
    fn('user32.dll', 'CreateWindowExA')(0, 0, 0, 0, 0, 0, 320, 200);   // no frame: a 320x200 client area
    const bmi = x.win.heapAlloc(40 + 1024); x.write(bmi, new Uint8Array(1064)); x.w32(bmi, 40); x.w32(bmi + 4, 160); x.w32(bmi + 8, -100); x.w16(bmi + 12, 1); x.w16(bmi + 14, 8);
    const pp = x.win.heapAlloc(4), dc = g('CreateCompatibleDC')(0), hbm = g('CreateDIBSection')(dc, bmi, 0, pp, 0, 0);
    g('SelectObject')(dc, hbm);
    const q = x.win.heapAlloc(4); x.w32(q, 0x123456); g('SetDIBColorTable')(dc, 5, 1, q);
    const bits = x.r32(pp); x.write(bits + 160 * 10 + 20, Uint8Array.of(5));   // pixel (20, 10): index 5
    g('StretchBlt')(0x1001, 0, 0, 320, 200, dc, 0, 0, 160, 100, 0xcc0020);
    const fb = (X, Y) => new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + mc.vbeFbBase + (Y * 320 + X) * 4, 1)[0];
    got = [hbm ? 'dib' : 'none', mc.vbe && `${mc.vbe.width}x${mc.vbe.height}`, fb(40, 20).toString(16), fb(41, 21).toString(16), fb(42, 20)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: an 8-bit DIB section, its colour table set, stretched to the window reaches the framebuffer', got, 'dib 320x200 123456 123456 0');
  // Winsock on a network with nobody on it: it starts (Quake II stops otherwise, even to play alone),
  // a socket is made, nothing arrives (WSAEWOULDBLOCK), the machine's name is 127.0.0.1.
  try { const { fn, str, x } = await w32(), w = (n) => fn('wsock32.dll', n), wd = x.win.heapAlloc(400), buf = x.win.heapAlloc(64);
    const start = w('WSAStartup')(0x101, wd), sock = w('socket')(2, 2, 17), rx = w('recvfrom')(sock, buf, 64, 0, 0, 0), err = w('WSAGetLastError')();
    const he = w('gethostbyname')(str('mirage')), ip = [...x.bytes(x.r32(x.r32(he + 12)), 4)].join('.');
    got = [start, x.r16(wd).toString(16), sock > 0, rx, err, ip, w('htons')(0x1234).toString(16), w('inet_addr')(str('1.2.3.4')).toString(16)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: wsock32 on an empty network: WSAStartup 1.1, a socket, recvfrom WSAEWOULDBLOCK, 127.0.0.1, htons, inet_addr', got, '0 101 true -1 10035 127.0.0.1 3412 4030201');
  // A DLL of the program's own, from its disk (Quake II's ref_soft.dll, gamex86.dll), made here: linked
  // for 10000000h, mapped at 50000000h with its HIGHLOW relocation applied, its DllMain entered by
  // LoadLibraryA (DLL_PROCESS_ATTACH, returning into user32's stub), its export found by GetProcAddress.
  try {
    const d = new Uint8Array(0x2000), dv = new DataView(d.buffer), put = (o, t) => d.set(new TextEncoder().encode(t + '\0'), o);
    d[0] = 0x4d; d[1] = 0x5a; dv.setUint32(0x3c, 0x40, true); dv.setUint32(0x40, 0x4550, true);
    dv.setUint16(0x44, 0x14c, true); dv.setUint16(0x46, 1, true); dv.setUint16(0x54, 0xe0, true); dv.setUint16(0x56, 0x2102, true);
    const o = 0x58; dv.setUint16(o, 0x10b, true); dv.setUint32(o + 16, 0x1000, true); dv.setUint32(o + 28, 0x10000000, true);
    dv.setUint32(o + 32, 0x1000, true); dv.setUint32(o + 36, 0x200, true); dv.setUint32(o + 56, 0x2000, true); dv.setUint32(o + 60, 0x400, true);
    dv.setUint32(o + 92, 16, true); dv.setUint32(o + 96, 0x1200, true); dv.setUint32(o + 100, 0x60, true); dv.setUint32(o + 96 + 40, 0x1300, true); dv.setUint32(o + 100 + 40, 12, true);
    const sec = o + 0xe0; put(sec, '.text'); dv.setUint32(sec + 8, 0x1000, true); dv.setUint32(sec + 12, 0x1000, true); dv.setUint32(sec + 16, 0x1000, true); dv.setUint32(sec + 20, 0x400, true); dv.setUint32(sec + 36, 0xe0000020, true);
    const t = 0x400;                                                   // file offset of RVA 1000h
    d.set([0xb8, 1, 0, 0, 0, 0xc2, 12, 0], t);                         // DllMain: mov eax, 1; ret 12
    d.set([0xa1, 0, 0x11, 0, 0x10, 0xc3], t + 0x10);                   // GetAnswer: mov eax, [10001100h]; ret
    dv.setUint32(t + 0x100, 42, true);
    const e = t + 0x200; dv.setUint32(e + 12, 0x1240, true); dv.setUint32(e + 16, 1, true); dv.setUint32(e + 20, 1, true); dv.setUint32(e + 24, 1, true);
    dv.setUint32(e + 28, 0x1228, true); dv.setUint32(e + 32, 0x1230, true); dv.setUint32(e + 36, 0x1238, true);
    dv.setUint32(e + 0x28, 0x1010, true); dv.setUint32(e + 0x30, 0x1250, true); dv.setUint16(e + 0x38, 0, true); put(e + 0x40, 't.dll'); put(e + 0x50, 'GetAnswer');
    const r = t + 0x300; dv.setUint32(r, 0x1000, true); dv.setUint32(r + 4, 12, true); dv.setUint16(r + 8, 0x3000 | 0x11, true);
    const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const exe = Uint8Array.from((
    '4d5a0000504500004c010000000000000000000000000000600002010b0100000000000000000000000000007c000000' +
    '000000000000000000004000040000000400000004000000000000000400000000000000000001004000000000000000' +
    '0300000000001000001000000000100000100000000000000000000064a1300000008b400c8b400c8b008b008b58188b' +
    '433c8b54037801da8b4a188b6a2001dd49783c8b748d0001debfe000400051b90c000000f3a65975e78b422401d80fb7' +
    '04488b721c01de8b048601d80fb60dec0040000fb615ed01400001d151ffd0cc4578697450726f63657373002a').match(/../g), (v) => parseInt(v, 16));
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc);
    const apis = win32Apis({ files: { 't.dll': d } }), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis, backend: traceBackend() });
    const k = (n) => apis.find((m) => m.dll === 'kernel32.dll').fns[n][1], nm = x.win.heapAlloc(16); x.write(nm, new TextEncoder().encode('t.dll\0'));
    k('LoadLibraryA')(x, nm);
    const base = x.win.modules.get('t.dll').base, entered = mc.cpu.eip === base + 0x1000, args = [1, 2, 3].map((i) => x.r32((mc.cpu.reg[4] >>> 0) + 4 * i).toString(16));
    const gn = x.win.heapAlloc(16); x.write(gn, new TextEncoder().encode('GetAnswer\0'));
    const fnAt = k('GetProcAddress')(x, base, gn);
    got = [base.toString(16), entered, args.join(','), (fnAt - base).toString(16), (x.r32(base + 0x1011) - base).toString(16)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a DLL from the program\'s disk: relocated to 50000000h, DllMain entered (hinst, 1, 0), its export found', got, '50000000 true 50000000,1,0 1010 1100');
  // A key: WM_KEYDOWN with the scancode in lParam's bits 16-23 (WinQuake's MapKey), then
  // DispatchMessageA enters the window's procedure with its four arguments, returning into the stub.
  try { const { mc, fn, x, apis, str } = await w32(), u = (n) => fn('user32.dll', n);
    const wc = x.win.heapAlloc(40); x.write(wc, new Uint8Array(40)); x.w32(wc + 4, 0x401234); x.w32(wc + 36, str('WinQuake'));
    u('RegisterClassA')(wc); u('CreateWindowExA')(0, str('winquake'), 0, 0, 0, 0, 320, 200);
    apis.input.key(true, 0x1e);
    const m = x.win.heapAlloc(28), had = u('PeekMessageA')(m, 0, 0, 0, 1), ret = mc.cpu.eip;
    const lp = x.r32(m + 12), sp0 = mc.cpu.reg[4] >>> 0;
    u('DispatchMessageA')(m);
    const sp = mc.cpu.reg[4] >>> 0;
    got = [had, x.r32(m + 4).toString(16), x.r32(m + 8).toString(16), ((lp >> 16) & 255).toString(16), mc.cpu.eip.toString(16), x.r32(sp) === ret, x.r32(sp + 8).toString(16), sp0 - sp].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a key posts WM_KEYDOWN (scancode in lParam); DispatchMessageA enters the window procedure', got, '1 100 41 1e 401234 true 100 20');
  // The C runtime's start-up: XP's version, code page 1252's conversions, the C locale's comparisons.
  try { const { fn, x, str } = await w32(), k = (n) => fn('kernel32.dll', n);
    const vi = x.win.heapAlloc(148); x.w32(vi, 148); k('GetVersionExA')(vi);
    const wbuf = x.win.heapAlloc(16), n = k('MultiByteToWideChar')(1252, 0, str('Qu'), -1, wbuf, 8);
    got = [x.r32(vi + 4), x.r32(vi + 8), x.r32(vi + 12), n, x.r16(wbuf + 2).toString(16), k('CompareStringA')(0, 1, str('ID1'), -1, str('id1'), -1), k('GetACP')()].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: GetVersionExA (XP), MultiByteToWideChar, CompareStringA ignoring case, GetACP', got, '5 1 2600 3 75 2 1252');
  // The window's size follows SetWindowPos and its style: WinQuake's vid_mode 2 resizes a framed window
  // to 806x625 (800x600 inside), its full-screen modes make it a popup with no frame.
  try { const { fn, x } = await w32(), u = (n) => fn('user32.dll', n), r = x.win.heapAlloc(16);
    const client = () => { u('GetClientRect')(0x10010, r); return `${x.r32(r + 8)}x${x.r32(r + 12)}`; };
    u('CreateWindowExA')(0, 0, 0, 0xcf0000, 0, 0, 326, 265); const a = client();
    u('SetWindowPos')(0x10010, 0, 0, 0, 806, 625, 0x184); const b = client();
    u('SetWindowPos')(0x10010, 0, 0, 0, 0, 0, 0x163); const c = client();             // SWP_NOSIZE: unchanged
    u('SetWindowLongA')(0x10010, -16, 0x80000000); u('SetWindowPos')(0x10010, 0, 0, 0, 640, 480, 0x104);
    got = [a, b, c, client()].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: the client area follows SetWindowPos (not with SWP_NOSIZE) and the style SetWindowLongA sets', got, '320x240 800x600 800x600 640x480');
  // Sent messages: CreateWindowExA enters the window procedure with WM_NCCREATE, WM_CREATE (its
  // CREATESTRUCT from its own arguments), WM_SIZE and WM_MOVE, each returning into user32's stub,
  // and after the last returns to its caller with the window's handle, its 48 bytes of arguments taken.
  try { const { mc, fn, x, apis, str } = await w32(), u = (n) => fn('user32.dll', n), c = mc.cpu;
    const wc = x.win.heapAlloc(40); x.write(wc, new Uint8Array(40)); x.w32(wc + 4, 0x401234); x.w32(wc + 36, str('Q'));
    u('RegisterClassA')(wc);
    const sp0 = ((c.reg[4] >>> 0) - 0x100) & ~3, args = [0, str('q'), 0, 0xcf0000, 0, 0, 326, 265, 0, 0, 0x400000, 0x5150];
    x.w32(sp0, 0x401000); args.forEach((v, i) => x.w32(sp0 + 4 + 4 * i, v)); c.reg[4] = sp0;
    u('CreateWindowExA')(...args);
    const back = apis.find((d) => d.dll === 'user32.dll').fns.mirageReturn[1], seen = [];
    let eax = 0;
    for (let i = 0; i < 6 && c.eip === 0x401234; i++) {
      const sp = c.reg[4] >>> 0, msg = x.r32(sp + 8), lp = x.r32(sp + 16);
      seen.push(msg.toString(16) + (msg === 1 ? '/' + x.r32(lp).toString(16) : msg === 5 ? '/' + (lp >>> 16) : ''));
      c.reg[4] = sp + 20; c.reg[0] = 0; eax = back(x);                  // the procedure's ret 16, into the stub
    }
    got = [seen.join(','), c.eip.toString(16), eax.toString(16), (c.reg[4] >>> 0) - sp0].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: CreateWindowExA sends WM_NCCREATE, WM_CREATE (CREATESTRUCT), WM_SIZE, WM_MOVE, then returns the window', got, '81,1/5150,5/240,3 401000 10010 52');
  // The window manager (src/win32/wm.js): a captioned window is drawn framed on a 1024x768 desktop --
  // the classic blue, its caption's gradient, its client area at its place on the screen -- and an
  // 8-bit section stretched into it lands there; a popup is the screen alone (the intros, unchanged).
  try { const { mc, fn, x } = await w32(), u = (n) => fn('user32.dll', n), g = (n) => fn('gdi32.dll', n);
    u('CreateWindowExA')(0, 0, 0, 0x00cf0000, 100, 50, 326, 265); u('ShowWindow')(0x10010, 1);
    const bmi = x.win.heapAlloc(1064); x.write(bmi, new Uint8Array(1064)); x.w32(bmi, 40); x.w32(bmi + 4, 320); x.w32(bmi + 8, -240); x.w16(bmi + 12, 1); x.w16(bmi + 14, 8);
    const pp = x.win.heapAlloc(4), dc = g('CreateCompatibleDC')(0), hbm = g('CreateDIBSection')(dc, bmi, 0, pp, 0, 0); g('SelectObject')(dc, hbm);
    const q = x.win.heapAlloc(4); x.w32(q, 0x123456); g('SetDIBColorTable')(dc, 7, 1, q); x.write(x.r32(pp), new Uint8Array(320 * 240).fill(7));
    g('BitBlt')(0x1001, 0, 0, 320, 240, dc, 0, 0, 0xcc0020);
    const fb = (X, Y) => new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + mc.vbeFbBase + (Y * 1024 + X) * 4, 1)[0].toString(16);
    got = [`${mc.vbe.width}x${mc.vbe.height}`, fb(0, 0), fb(103, 55), fb(103, 72), fb(422, 311), fb(423, 72)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32 wm: a captioned window on the 1024x768 desktop, its caption, its client area at (103, 72)', got, '1024x768 3a6ea5 a246a 123456 123456 d4d0c8');
  // Dragging the caption moves it; the move reaches the program as WM_MOVE at its next PeekMessage,
  // before it can look (WinQuake puts its window back where it remembers it otherwise). The close
  // button posts WM_CLOSE; a mode only tested (CDS_TEST) changes nothing.
  try { const { fn, x, apis } = await w32(), u = (n) => fn('user32.dll', n), i = apis.input, r = x.win.heapAlloc(16), m = x.win.heapAlloc(28);
    u('CreateWindowExA')(0, 0, 0, 0x00cf0000, 0, 0, 326, 265); u('ShowWindow')(0x10010, 1);
    const rect = () => { u('GetWindowRect')(0x10010, r); return [x.r32(r), x.r32(r + 4)].join(','); };
    i.mouseAt(98, 10); i.mouseButton(0, true); i.mouseAt(398, 210); i.mouseButton(0, false);
    const before = rect(); u('PeekMessageA')(m, 0, 0, 0, 1); const after = rect();
    i.mouseAt(313, 10); i.mouseButton(0, true); i.mouseButton(0, false);           // the close button, where the window was
    i.mouseAt(613, 210); i.mouseButton(0, true); i.mouseButton(0, false);          // ... and where it is
    const closes = []; while (u('PeekMessageA')(m, 0, 0, 0, 1)) closes.push(x.r32(m + 4).toString(16));
    const dm = x.win.heapAlloc(156); x.write(dm, new Uint8Array(156)); x.w32(dm + 108, 640); x.w32(dm + 112, 480);
    u('ChangeDisplaySettingsA')(dm, 6);
    got = [before, after, closes.join('/'), apis.wm.clientRect() ? 'framed' : 'full'].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32 wm: a caption drag moves the window at the next PeekMessage; the close button posts WM_CLOSE; CDS_TEST changes nothing', got, '0,0 300,200 10 framed');
  // GLQuake (1997): opengl32's entry points it imports beyond the intros', read from the stack as their
  // C signatures say (PRISM's gl.js does the work), comctl32's InitCommonControls by ordinal 17.
  try { const { apis } = await w32(), ogl = apis.find((d) => d.dll === 'opengl32.dll').fns, cc = apis.find((d) => d.dll === 'comctl32.dll').fns;
    got = [...['glAlphaFunc', 'glTexEnvf', 'glDepthRange', 'glTexSubImage2D', 'glReadPixels'].map((n) => ogl[n][0]), cc.InitCommonControls[2].ordinal, typeof ogl.wglGetCurrentDC[1]].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: GLQuake\'s GL entry points and signatures, InitCommonControls (ordinal 17)', got, 'uf uuf dd uiiiiiuup iiiiuup 17 function');
  // Quake II's OpenGL: a new video mode re-creates the window and the context, and the GL surface takes
  // the new size at wglMakeCurrent (it kept 640x480 while the game drew 800x600); wglSwapBuffers is
  // opengl32's own name for SwapBuffers; glDeleteTextures and glScissor read from the stack.
  try { const { fn, x, apis } = await w32(), sizes = [];
    x.backend.setVideoMode = (w, h) => sizes.push(`${w}x${h}`);
    const u = (n) => fn('user32.dll', n), o = (n) => fn('opengl32.dll', n), ogl = apis.find((d) => d.dll === 'opengl32.dll').fns;
    u('CreateWindowExA')(0, 0, 0, 0x80000000, 0, 0, 640, 480); o('wglMakeCurrent')(0x1001, 0x10000); o('wglMakeCurrent')(0x1001, 0x10000);
    u('CreateWindowExA')(0, 0, 0, 0x80000000, 0, 0, 800, 600); o('wglMakeCurrent')(0x1001, 0x10000);
    got = [sizes.join(','), typeof ogl.wglSwapBuffers[1], ogl.glDeleteTextures[0], ogl.glScissor[0]].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: the GL surface follows a new video mode at wglMakeCurrent; wglSwapBuffers; glDeleteTextures, glScissor', got, '640x480,800x600 function ip iiii');
  // Half-Life's launcher (1999, MFC): its settings in a registry in memory -- a key made then opened by
  // another spelling, a value written and read back (asked its size first), one missing, the subkeys listed.
  try { const { fn, x, str } = await w32(), a = (n) => fn('advapi32.dll', n), out = x.win.heapAlloc(64), r = [];
    r.push(a('RegCreateKeyExA')(0x80000002, str('Software\\Valve\\Half-Life'), 0, 0, 0, 0x20006, 0, out, out + 4), x.r32(out + 4));
    const hk = x.r32(out); r.push(a('RegSetValueExA')(hk, str('Name'), 0, 1, str('Gordon'), 7)); a('RegCloseKey')(hk);
    r.push(a('RegOpenKeyExA')(0x80000002, str('SOFTWARE\\valve\\half-life'), 0, 1, out));
    const h2 = x.r32(out); x.w32(out + 8, 0); r.push(a('RegQueryValueExA')(h2, str('name'), 0, out + 12, 0, out + 8), x.r32(out + 8));
    r.push(a('RegQueryValueExA')(h2, str('Name'), 0, out + 12, out + 16, out + 8), x.str(out + 16), a('RegQueryValueExA')(h2, str('Gone'), 0, 0, 0, 0));
    r.push(a('RegCreateKeyExA')(0x80000002, str('Software\\Valve\\Half-Life'), 0, 0, 0, 0, 0, out, out + 4), x.r32(out + 4), a('RegOpenKeyExA')(0x80000002, str('Software\\Nobody'), 0, 1, out));
    a('RegOpenKeyExA')(0x80000002, str('Software'), 0, 1, out); x.w32(out + 8, 32); r.push(a('RegEnumKeyExA')(x.r32(out), 0, out + 16, out + 8, 0, 0, 0, 0), x.str(out + 16), a('RegEnumKeyExA')(x.r32(out), 1, out + 16, out + 8, 0, 0, 0, 0));
    got = r.join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a registry in memory -- keys made and opened, values set and read, subkeys listed', got, '0 1 0 0 0 7 0 Gordon 2 0 2 2 0 valve 259');
  // WaitForSingleObject on an event: a second definition answering 0 had replaced the real one, so every
  // wait returned at once and the launcher's sound thread spun, starving the game's.
  try { const { fn } = await w32(), k = (n) => fn('kernel32.dll', n), ev = k('CreateEventA')(0, 0, 0, 0), r = [k('WaitForSingleObject')(ev, 0)];
    k('SetEvent')(ev); r.push(k('WaitForSingleObject')(ev, 0), k('WaitForSingleObject')(ev, 0)); got = r.map((v) => v.toString(16)).join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: WaitForSingleObject waits for an event, auto-reset once taken', got, '102 0 102');
  // Windows besides the main one: a child control by its id (MFC subclasses through GetDlgItem: a made-up
  // handle per id fell on the dialog's own), its parent and class; the queue filtered by window and range.
  try { const { fn, x, str } = await w32(), u = (n) => fn('user32.dll', n), m = x.win.heapAlloc(28);
    const main = u('CreateWindowExA')(0, 0, 0, 0x00cf0000, 0, 0, 320, 200, 0, 0);
    const btn = u('CreateWindowExA')(0, 0, str('OK'), 0x50000000, 10, 20, 80, 24, main, 7);   // a class without procedure: made at once
    u('PostMessageA')(main, 0x400, 1, 2); u('PostMessageA')(btn, 0x111, 3, 4);
    const r = [u('GetDlgItem')(main, 7) === btn, u('GetDlgItem')(main, 8), u('GetParent')(btn) === main];
    const t = x.win.heapAlloc(16); u('GetWindowTextA')(btn, t, 16); r.push(x.str(t));
    r.push(u('PeekMessageA')(m, btn, 0, 0, 1), x.r32(m + 4).toString(16), u('PeekMessageA')(m, 0, 0x111, 0x111, 1), u('PeekMessageA')(m, 0, 0x400, 0x400, 1), x.r32(m + 4).toString(16), x.r32(m) === main);
    got = r.join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: child windows -- GetDlgItem by id, GetParent, their text; PeekMessage by window and range', got, 'true 0 true OK 1 111 0 1 400 true');
  // Menus: a bar attached to the main window takes 19 pixels of its client area, the window's own
  // rectangle kept (Minesweeper sizes its window for it); an item found by command inside its popup,
  // checked and greyed, its previous state given back; a popup by position.
  try { const { fn, x, str } = await w32(), u = (n) => fn('user32.dll', n), rc = x.win.heapAlloc(16), r = [];
    const main = u('CreateWindowExA')(0, 0, 0, 0x00cf0000, 0, 0, 320, 240, 0, 0);
    u('GetClientRect')(main, rc); const h0 = x.r32(rc + 12);
    const bar = u('CreateMenu')(), pop = u('CreatePopupMenu')();
    u('AppendMenuA')(pop, 0, 101, str('&Beginner')); u('AppendMenuA')(pop, 0x800, 0, 0); u('AppendMenuA')(pop, 0, 102, str('E&xit'));
    u('AppendMenuA')(bar, 0x10, pop, str('&Game')); u('SetMenu')(main, bar);
    u('GetClientRect')(main, rc); r.push(h0 - x.r32(rc + 12));
    r.push(u('CheckMenuItem')(bar, 101, 8), u('GetMenuState')(bar, 101, 0) & 8, u('CheckMenuItem')(bar, 101, 0), u('EnableMenuItem')(bar, 102, 1), u('GetMenuState')(pop, 2, 0x400) & 3);
    r.push(u('GetSubMenu')(bar, 0) === pop, u('GetMenuItemCount')(pop), u('CheckMenuItem')(bar, 999, 8));
    got = r.join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a menu bar takes its 19 pixels; items by command in their popups, checked and greyed', got, '19 0 8 8 0 1 true 3 -1');
  // SetROP2's R2_WHITE (16): a line drawn white whatever the pen -- Minesweeper's raised edges, black before.
  try { const { mc, fn } = await w32(), g = (n) => fn('gdi32.dll', n);
    fn('user32.dll', 'CreateWindowExA')(0, 0, 0, 0, 0, 0, 320, 200);
    g('SetROP2')(0x1001, 16); g('MoveToEx')(0x1001, 0, 5, 0); g('LineTo')(0x1001, 10, 5);
    const fb = (X, Y) => new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + mc.vbeFbBase + (Y * 320 + X) * 4, 1)[0];
    got = (fb(3, 5) & 0xffffff).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: SetROP2 R2_WHITE draws a line white whatever the pen', got, 'ffffff');
  // MCI's video: an .avi on the program's disk opened by a command string, its device id by its alias,
  // and played to its end at once -- MM_MCINOTIFY, MCI_NOTIFY_SUCCESSFUL, posted to the callback window
  // (Half-Life's launcher waits for it, and stopped on its error box when the open failed).
  try { const { fn, x, str } = await w32('', { files: { 'intro.avi': new Uint8Array(64) } }), w = (n) => fn('winmm.dll', n), m = x.win.heapAlloc(28);
    const main = fn('user32.dll', 'CreateWindowExA')(0, 0, 0, 0, 0, 0, 320, 200, 0, 0);
    const r = [w('mciSendStringA')(str('open intro.avi type AVIVideo alias v wait'), 0, 0, 0), w('mciGetDeviceIDA')(str('v')) > 0,
      w('mciSendStringA')(str('play v notify'), 0, 0, main), fn('user32.dll', 'PeekMessageA')(m, 0, 0, 0, 1), x.r32(m + 4).toString(16), x.r32(m + 8),
      w('mciSendStringA')(str('open none.avi alias n'), 0, 0, 0)];
    got = r.join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: MCI opens a video on the disk and notifies its end', got, '0 true 0 1 3b9 1 263');
  // DrawTextA with DT_WORDBREAK measures (DT_CALCRECT) the lines the words fill: Half-Life's message box
  // drew its 105 characters on one line, out of its 320 pixels.
  try { const { fn, x, str } = await w32(), u = (n) => fn('user32.dll', n), r = x.win.heapAlloc(16), hdc = 0x1001;
    const h = (fmt, w) => { x.w32(r, 0); x.w32(r + 4, 0); x.w32(r + 8, w); x.w32(r + 12, 100); return u('DrawTextA')(hdc, str('aaaa bbbb cccc'), -1, r, fmt); };
    const one = h(0x400, 200), three = h(0x410, 40);
    got = [three / one, x.r32(r + 8) <= 40].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: DrawTextA DT_WORDBREAK wraps at the rectangle\'s width', got, '3 true');
  // A dialog's keyboard: Enter is IDOK, Escape IDCANCEL, each a WM_COMMAND posted to it; other keys not its.
  try { const { fn, x, str } = await w32(), u = (n) => fn('user32.dll', n), m = x.win.heapAlloc(28), q = x.win.heapAlloc(28);
    const main = u('CreateWindowExA')(0, 0, 0, 0x00cf0000, 0, 0, 320, 200, 0, 0), btn = u('CreateWindowExA')(0, 0, 0, 0x50000000, 0, 0, 8, 8, main, 1);
    const key = (vk) => { x.w32(m, btn); x.w32(m + 4, 0x100); x.w32(m + 8, vk); return u('IsDialogMessageA')(main, m); };
    const r = [key(0x0d), key(0x41), key(0x1b)];
    while (u('PeekMessageA')(q, 0, 0x111, 0x111, 1)) r.push(x.r32(q + 8));
    got = r.join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: IsDialogMessageA -- Enter posts IDOK, Escape IDCANCEL', got, '1 0 1 1 2');
  // The console's output (GetStdHandle(STD_OUTPUT_HANDLE), WriteFile): the process's stdout -- a Visual C++
  // console program's printf.
  try { const { fn, x, lx, str } = await w32(), k = (n) => fn('kernel32.dll', n), seen = [];
    lx.onOutput = (fd, b) => seen.push(fd + ':' + new TextDecoder().decode(b));
    const done = x.win.heapAlloc(4); k('WriteFile')(k('GetStdHandle')(-11), str('hi'), 2, done, 0); k('WriteFile')(k('GetStdHandle')(-12), str('err'), 3, done, 0);
    got = seen.join(' ') + ' ' + x.r32(done);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: WriteFile to the console reaches stdout and stderr', got, '1:hi 2:err 3');
  // C: has directories (Abuse's art/, lisp/): a file by its path, ".." resolved, by its base name alone
  // as before; a directory's attributes; FindFirstFileA in one directory.
  try { const { fn, str, x } = await w32('', { files: { 'art/a.spe': Uint8Array.of(1, 2, 3), 'lisp/b.lsp': Uint8Array.of(9), 'top.txt': Uint8Array.of(7) } }), k = (n) => fn('kernel32.dll', n);
    const open = (p) => ((k('CreateFileA')(str(p), 0x80000000, 1, 0, 3, 0x80, 0) >>> 0) !== 0xffffffff ? 1 : 0), fd = x.win.heapAlloc(320);
    const attrs = ['C:\\art', 'C:\\sfx', 'C:\\art\\a.spe'].map((p) => k('GetFileAttributesA')(str(p)) >>> 0);
    k('FindFirstFileA')(str('C:\\lisp\\*'), fd);
    got = [open('C:\\art\\a.spe'), open('art/../art/a.spe'), open('a.spe'), ...attrs, x.str(fd + 44)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: C: has directories -- a file by its path, a directory\'s attributes, FindFirstFileA in one', got, '1 1 1 16 4294967295 32 b.lsp');
  // The program's environment (entry.env: SDL's hints), by any case; a message-only window (HWND_MESSAGE:
  // SDL 2's helper, made first) is never the main one; GetUpdateRect says what is due a WM_PAINT --
  // SDL validates its window only then, and a WM_PAINT never validated came back forever.
  try { const { fn, str, x } = await w32('', { env: { SDL_RENDER_DRIVER: 'software' } }), k = (n) => fn('kernel32.dll', n), u = (n) => fn('user32.dll', n);
    const buf = x.win.heapAlloc(32), n1 = k('GetEnvironmentVariableA')(str('sdl_render_driver'), buf, 32), v = x.str(buf), n2 = k('GetEnvironmentVariableA')(str('NOPE'), buf, 32);
    u('CreateWindowExA')(0, 0x1234, 0, 0, -0x80000000, -0x80000000, -0x80000000, -0x80000000, 0xfffffffd, 0, 0x400000, 0);
    const main = u('CreateWindowExA')(0, str('game'), str('t'), 0x10cf0000, 0, 0, 320, 240, 0, 0, 0x400000, 0);
    const active = u('GetActiveWindow')() === main, pop = u('CreateWindowExA')(0, 0x1235, 0, 0x80000000, 10, 10, 50, 40, 0, 0, 0x400000, 0), r = x.win.heapAlloc(16);
    u('ShowWindow')(pop, 5);
    const due = u('GetUpdateRect')(pop, r, 0), wh = [x.r32(r + 8), x.r32(r + 12)];
    u('ValidateRect')(pop, 0);
    got = [n1, v, n2, active, due, ...wh, u('GetUpdateRect')(pop, r, 0)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: the program\'s environment; a message-only window is not the main one; GetUpdateRect', got, '8 software 0 true 1 50 40 0');
  // The Universal C Runtime (src/win32/ucrt.js): printf's conversions (flags, width, precision, %lld, %g),
  // __stdio_common_vsprintf's seven arguments -- the options are 64 bits, the va_list comes last: with
  // one too few every %s read a stray pointer ("Abuse version (null)") -- C99's snprintf length when it
  // does not fit, and scanf.
  try { const { apis, x, str } = await w32(), { cprintf, cscanf } = await import('../src/win32/ucrt.js');
    const ap = x.win.heapAlloc(64), dv = new DataView(new ArrayBuffer(8)), dbl = (p, v) => { dv.setFloat64(0, v, true); x.w32(p, dv.getUint32(0, true)); x.w32(p + 4, dv.getUint32(4, true)); };
    x.w32(ap, -5); dbl(ap + 4, Math.PI); x.w32(ap + 12, 0); x.w32(ap + 16, 256); x.w32(ap + 20, str('abc')); x.w32(ap + 24, 255); dbl(ap + 28, 0.0001); dbl(ap + 36, 1e20);
    const s = cprintf(x, '%+04d|%8.3f|%lld|%-5s|%#x|%g|%g', ap);
    const f = apis.find((d) => d.dll === 'ucrtbase.dll').fns.__stdio_common_vsprintf, buf = x.win.heapAlloc(16), ap2 = x.win.heapAlloc(8);
    x.w32(ap2, 12345); x.w32(ap2 + 4, 678);
    const n = f[1](x, 2, 0, buf, 6, str('%d-%d'), 0, ap2);
    const out = x.win.heapAlloc(16), ap3 = x.win.heapAlloc(12); x.w32(ap3, out); x.w32(ap3 + 4, out + 4); x.w32(ap3 + 8, out + 8);
    const k = cscanf(x, ' 42 x3.5 abc', '%d x%f %s', ap3);
    got = [s, f[0].length, n, x.str(buf), k, x.r32(out), x.f32(out + 4), x.str(out + 8)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: the UCRT\'s printf and scanf, __stdio_common_vsprintf\'s arguments', got, '-005|   3.142|1099511627776|abc  |0xff|0.0001|1e+20 7 9 12345 3 42 3.5 abc');
  // A module's string table (RT_STRING): its resource directory, type, name, language, read from the
  // image in memory -- Half-Life's launcher takes every label of its menus there.
  try { const { fn, x } = await w32(), base = x.win.heapAlloc(0x400), w = (o, v) => x.w32(base + o, v), w16 = (o, v) => x.w16(base + o, v);
    x.write(base, new Uint8Array(0x400)); w(0x3c, 0x40); w(0x40 + 24 + 96 + 16, 0x100);
    const dir = (o, id, sub) => { w16(o + 14, 1); w(o + 16, id); w(o + 20, sub); };
    dir(0x100, 6, 0x80000018); dir(0x118, 2, 0x80000030); dir(0x130, 0x409, 0x48);   // RT_STRING, block 2 (ids 16-31), a language
    w(0x148, 0x200); w(0x14c, 0x40);
    w16(0x200, 0); w16(0x202, 5); 'Hello'.split('').forEach((c, i) => w16(0x204 + 2 * i, c.charCodeAt(0)));   // id 16 empty, id 17 "Hello"
    const buf = x.win.heapAlloc(32), n = fn('user32.dll', 'LoadStringA')(base, 17, buf, 32), m = fn('user32.dll', 'LoadStringA')(base, 40, buf + 16, 16);
    got = [n, x.str(buf), m].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: LoadStringA reads the module\'s RT_STRING table', got, '5 Hello 0');
  // DirectDraw (src/win32/ddraw.js): an 8-bit display mode, a palette, a primary surface with a back
  // buffer; a pixel drawn into the back buffer reaches the screen at Flip, in the palette's colour; a
  // copy with a source colour key leaves the key's pixels alone; a palette changed shows at once.
  try { const { mc, x, apis } = await w32(), dd = apis.find((d) => d.dll === 'ddraw.dll').fns, call = (n, ...a) => dd[n][1](x, ...a);
    const pp = x.win.heapAlloc(4); call('DirectDrawCreate', 0, pp, 0); const ddo = x.r32(pp);
    call('IDirectDraw::SetCooperativeLevel', ddo, 0x10010, 0x11); call('IDirectDraw::SetDisplayMode', ddo, 320, 200, 8);
    const pe = x.win.heapAlloc(1024); x.write(pe, new Uint8Array(1024)); x.w32(pe + 4 * 5, 0x00563412);   // entry 5: red 12h, green 34h, blue 56h
    call('IDirectDraw::CreatePalette', ddo, 0x44, pe, pp, 0); const pal = x.r32(pp);
    const d = x.win.heapAlloc(108); x.write(d, new Uint8Array(108)); x.w32(d, 108); x.w32(d + 4, 0x21); x.w32(d + 20, 1); x.w32(d + 104, 0x218);   // CAPS | BACKBUFFERCOUNT; PRIMARY | FLIP | COMPLEX
    call('IDirectDraw::CreateSurface', ddo, d, pp, 0); const prim = x.r32(pp);
    const caps = x.win.heapAlloc(4); x.w32(caps, 4); call('IDirectDrawSurface::GetAttachedSurface', prim, caps, pp); const back = x.r32(pp);
    call('IDirectDrawSurface::SetPalette', prim, pal);
    call('IDirectDrawSurface::Lock', back, 0, d, 1, 0); const bits = x.r32(d + 36), pitch = x.r32(d + 16);
    x.write(bits + 10 * pitch + 20, Uint8Array.of(5)); call('IDirectDrawSurface::Unlock', back, 0);
    call('IDirectDrawSurface::Flip', prim, 0, 1);
    const fb = (X, Y) => new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + mc.vbeFbBase + (Y * mc.vbe.width + X) * 4, 1)[0].toString(16);
    const a = [mc.vbe.width + 'x' + mc.vbe.height, pitch, fb(20, 10)];
    // A 2x1 sprite, key 7, onto the primary: its pixel 7 leaves the screen's pixel as it was.
    const sd = x.win.heapAlloc(108); x.write(sd, new Uint8Array(108)); x.w32(sd, 108); x.w32(sd + 4, 7); x.w32(sd + 8, 1); x.w32(sd + 12, 2); x.w32(sd + 104, 0x40);
    call('IDirectDraw::CreateSurface', ddo, sd, pp, 0); const spr = x.r32(pp);
    call('IDirectDrawSurface::Lock', spr, 0, sd, 1, 0); x.write(x.r32(sd + 36), Uint8Array.of(7, 5)); call('IDirectDrawSurface::Unlock', spr, 0);
    const ck = x.win.heapAlloc(8); x.w32(ck, 7); x.w32(ck + 4, 7); call('IDirectDrawSurface::SetColorKey', spr, 8, ck);
    call('IDirectDrawSurface::BltFast', prim, 19, 11, spr, 0, 1);
    x.w32(pe, 0x00ffffff); call('IDirectDrawPalette::SetEntries', pal, 0, 0, 1, pe);   // entry 0 white: the screen's 0s turn white at once
    got = [...a, fb(19, 11), fb(20, 11), fb(0, 0)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: DirectDraw 8-bit: Flip shows the back buffer in the palette\'s colours, a colour key, SetEntries at once', got, '320x200 320 123456 ffffff 123456 ffffff');
  // A surface's DC (Cave Story, 2004, draws its pictures and its text on its surfaces so): in a 16-bit
  // mode, SetPixel through GetDC writes the surface's 5:6:5 and GetPixel reads it back as a COLORREF;
  // a second GetDC before ReleaseDC is refused. With no mode set, the display is the desktop's.
  try { const { x, apis, fn } = await w32(), dd = apis.find((d) => d.dll === 'ddraw.dll').fns, call = (n, ...a) => dd[n][1](x, ...a);
    const pp = x.win.heapAlloc(4); call('DirectDrawCreate', 0, pp, 0); const ddo = x.r32(pp);
    const dm = x.win.heapAlloc(108); x.w32(dm, 108); call('IDirectDraw::GetDisplayMode', ddo, dm);
    const desk = [x.r32(dm + 12), x.r32(dm + 8), x.r32(dm + 84)].join('x');
    call('IDirectDraw::SetDisplayMode', ddo, 640, 480, 16);
    const d = x.win.heapAlloc(108); x.write(d, new Uint8Array(108)); x.w32(d, 108); x.w32(d + 4, 7); x.w32(d + 8, 2); x.w32(d + 12, 4); x.w32(d + 104, 0x40);
    call('IDirectDraw::CreateSurface', ddo, d, pp, 0); const sf = x.r32(pp);
    call('IDirectDrawSurface::GetDC', sf, pp); const dc = x.r32(pp), again = call('IDirectDrawSurface::GetDC', sf, pp) >>> 0;
    fn('gdi32.dll', 'SetPixel')(dc, 1, 0, 0x0000ff); fn('gdi32.dll', 'SetPixel')(dc, 2, 1, 0xff0000);
    const back = fn('gdi32.dll', 'GetPixel')(dc, 1, 0).toString(16);
    call('IDirectDrawSurface::ReleaseDC', sf, dc);
    call('IDirectDrawSurface::Lock', sf, 0, d, 1, 0); const bits = x.r32(d + 36), pitch = x.r32(d + 16);
    got = [desk, again.toString(16), back, x.r16(bits + 2).toString(16), x.r16(bits + pitch + 4).toString(16)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: DirectDraw surface GetDC: GDI pixels in 5:6:5 and back; the desktop\'s mode before any is set', got, '1024x768x32 8876021c ff f800 1f');
  // LoadImageA(LR_LOADFROMFILE): a .bmp of the program's disk (Cave Story's .pbm pictures) as a bitmap.
  try { const bmp = new Uint8Array(54 + 8), v = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]); v.setUint32(2, bmp.length, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true); v.setInt32(18, 2, true); v.setInt32(22, 1, true);
    v.setUint16(26, 1, true); v.setUint16(28, 24, true); bmp.set([0x30, 0x20, 0x10, 0xff, 0xee, 0xdd], 54);   // two pixels, BGR
    const { x, fn, str } = await w32('', { files: { 'pic.pbm': bmp } }), h = fn('user32.dll', 'LoadImageA')(0, str('data\\pic.pbm'), 0, 0, 0, 0x2010);
    const bm = x.win.heapAlloc(24); fn('gdi32.dll', 'GetObjectA')(h, 24, bm);
    got = [h !== 0, x.r32(bm + 4), x.r32(bm + 8)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: LoadImageA reads a .bmp file of the program\'s disk', got, 'true 2 1');
  // DirectInput on a machine without a controller (Cave Story does not start without the object):
  // DirectInputCreateA gives one, EnumDevices lists nothing, CreateDevice finds nothing.
  try { const { x, apis } = await w32(), di = apis.find((d) => d.dll === 'dinput.dll').fns, call = (n, ...a) => di[n][1](x, ...a);
    const pp = x.win.heapAlloc(4), r = call('DirectInputCreateA', 0x400000, 0x500, pp, 0), o = x.r32(pp);
    got = [r, o !== 0, call('IDirectInputA::EnumDevices', o, 4, 0x1234, 0, 1), (call('IDirectInputA::CreateDevice', o, 0, pp, 0) >>> 0).toString(16), x.r32(pp)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: dinput, no controller: an object, no devices', got, '0 true 0 80040154 0');
  // shlwapi's PathRemoveFileSpecA, kernel32's GetFileSize and SystemTimeToFileTime, and VerQueryValueA's
  // root block (VS_FIXEDFILEINFO at 40, after L"VS_VERSION_INFO").
  try { const { x, fn, str } = await w32('', { files: { 'f.dat': new Uint8Array(1234) } }), k = (n) => fn('kernel32.dll', n);
    const p1 = str('C:\\dir\\Doukutsu.exe'), p2 = str('C:\\a.exe'); fn('shlwapi.dll', 'PathRemoveFileSpecA')(p1); fn('shlwapi.dll', 'PathRemoveFileSpecA')(p2);
    const h = k('CreateFileA')(str('f.dat'), 0x80000000, 1, 0, 3, 0x80, 0), hi = x.win.heapAlloc(4), size = k('GetFileSize')(h, hi);
    const t = x.win.heapAlloc(16); x.write(t, Uint8Array.of(0xd4, 7, 12, 0, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0));   // 2004-12-01 00:00 (a Wednesday)
    const ft = x.win.heapAlloc(8); k('SystemTimeToFileTime')(t, ft);
    const blk = x.win.heapAlloc(96); x.write(blk, new Uint8Array(96)); x.w16(blk, 92); x.w16(blk + 2, 52);
    const pv = x.win.heapAlloc(8), q = fn('version.dll', 'VerQueryValueA')(blk, str('\\'), pv, pv + 4);
    got = [x.str(p1), x.str(p2), size, x.r32(hi), (x.r32(ft + 4) * 4294967296 + x.r32(ft)).toString(16), q, x.r32(pv) - blk, x.r32(pv + 4)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: PathRemoveFileSpecA, GetFileSize, SystemTimeToFileTime, VerQueryValueA "\\"', got, 'C:\\dir C:\\ 1234 0 1c4d738b3544000 1 40 52');
  // A Japanese system (machine.codepage 932): GetACP, Shift-JIS lead bytes, MultiByteToWideChar of
  // "あい", and text measured by characters, not bytes -- two of them, a DEFAULT_CHARSET font's.
  try { const { x, fn, str } = await w32('', { codepage: 932 }), k = (n) => fn('kernel32.dll', n);
    const cp = x.win.heapAlloc(20); k('GetCPInfo')(0, cp);
    const s = x.win.heapAlloc(8); x.write(s, Uint8Array.of(0x82, 0xa0, 0x82, 0xa2, 0)); const w = x.win.heapAlloc(16), n = k('MultiByteToWideChar')(0, 0, s, 4, w, 8);
    const dc = fn('gdi32.dll', 'CreateCompatibleDC')(0), f = fn('gdi32.dll', 'CreateFontA')(-20, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 1, str(''));
    fn('gdi32.dll', 'SelectObject')(dc, f); const sz = x.win.heapAlloc(8); fn('gdi32.dll', 'GetTextExtentPoint32A')(dc, s, 4, sz);
    got = [k('GetACP')(), x.r32(cp), [...x.bytes(cp + 6, 4)].map((b) => b.toString(16)).join('-'), n, x.r16(w).toString(16), x.r16(w + 2).toString(16), x.r32(sz)].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: code page 932: GetACP, Shift-JIS lead bytes, MultiByteToWideChar, text by characters', got, '932 2 81-9f-e0-fc 2 3042 3044 20'); }
// A sleep is its thread's: two threads asleep at once each wake at their own time (src/hle/index.js) --
// Cave Story's main loop and its multimedia timer, which shared one deadline and spun.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024), v = new DataView(exe.buffer); exe.set([0x4d, 0x5a]); v.setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0], 0x40); v.setUint16(0x54, 0xe0, true); v.setUint16(0x58, 0x10b, true);
    v.setUint32(0x58 + 28, 0x400000, true); v.setUint32(0x58 + 56, 0x1000, true); v.setUint32(0x58 + 60, 0x200, true);
    const { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis: win32Apis(), backend: traceBackend() }), BLOCK = lx.BLOCK, at = (t) => { mc.cpu.cycles = Math.round(t * 1e8); };
    at(1); lx.pid = 1; const a1 = x.sleep(0.5) === BLOCK; lx.pid = 2; lx.wake = null; const b1 = x.sleep(0.001) === BLOCK;
    at(1.002); lx.wake = null; const b2 = x.sleep(0.001); lx.pid = 1; lx.wake = null; const a2 = x.sleep(0.5) === BLOCK;
    at(1.5); lx.wake = null; const a3 = x.sleep(0.5);
    got = [a1, b1, b2, a2, a3].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: x.sleep keeps each thread\'s deadline', got, 'true true 0 true 0'); }

// A PE made here, for the tests below: one section at RVA 1000h (code at 0, data from 400h, the import
// tables from 600h, the exports from A00h), its imports [{ dll, names }], its exports { name: offset },
// a TLS template. `code(at)` gets the addresses: at.iat['dll!name'], at.d(offset) the section's VAs.
const mkPE = ({ base = 0x400000, dll = false, entry = 0, imports = [], exports = null, name = 't.dll', tls = null, code }) => {
  const b = new Uint8Array(0x1200), v = new DataView(b.buffer), S = 0x200, va = (off) => base + 0x1000 + off, rva = (off) => 0x1000 + off;
  const at = { iat: {}, d: va };
  // The imports: descriptors, then each DLL's lookup table, address table and names.
  let p = 0x600 + 20 * (imports.length + 1);
  const desc = [];
  for (const im of imports) {
    const ilt = p; p += 4 * (im.names.length + 1); const iat = p; p += 4 * (im.names.length + 1);
    const dn = p; b.set(new TextEncoder().encode(im.dll + '\0'), S + p); p += im.dll.length + 1;
    im.names.forEach((n, i) => { const hn = p; b.set(new TextEncoder().encode('\0\0' + n + '\0'), S + p); p += n.length + 3; v.setUint32(S + ilt + 4 * i, rva(hn), true); v.setUint32(S + iat + 4 * i, rva(hn), true); at.iat[`${im.dll}!${n}`] = va(iat + 4 * i); });
    desc.push([rva(ilt), rva(dn), rva(iat)]);
  }
  desc.forEach(([ilt, dn, iat], i) => { v.setUint32(S + 0x600 + 20 * i, ilt, true); v.setUint32(S + 0x600 + 20 * i + 12, dn, true); v.setUint32(S + 0x600 + 20 * i + 16, iat, true); });
  if (exports) {                                                     // one name, one function each
    const names = Object.keys(exports), e = 0xa00, f = e + 40, nm = f + 4 * names.length, od = nm + 4 * names.length;
    let s = od + 2 * names.length;
    v.setUint32(S + e + 12, rva(s), true); b.set(new TextEncoder().encode(name + '\0'), S + s); s += name.length + 1;
    v.setUint32(S + e + 16, 1, true); v.setUint32(S + e + 20, names.length, true); v.setUint32(S + e + 24, names.length, true);
    v.setUint32(S + e + 28, rva(f), true); v.setUint32(S + e + 32, rva(nm), true); v.setUint32(S + e + 36, rva(od), true);
    names.forEach((n, i) => { v.setUint32(S + f + 4 * i, rva(exports[n]), true); v.setUint32(S + nm + 4 * i, rva(s), true); v.setUint16(S + od + 2 * i, i, true); b.set(new TextEncoder().encode(n + '\0'), S + s); s += n.length + 1; });
  }
  if (tls) {                                                         // the template at 4F0h, the directory at 480h, the index at 404h
    b.set(tls, S + 0x4f0); [va(0x4f0), va(0x4f0 + tls.length), va(0x404), va(0x40c), 0, 0].forEach((w, i) => v.setUint32(S + 0x480 + 4 * i, w, true));
  }
  b.set(code(at), S);
  // The headers: MZ, PE, i386, one section; PE32's optional header and its directories.
  b.set([0x4d, 0x5a]); v.setUint32(0x3c, 0x40, true); b.set([0x50, 0x45], 0x40);
  v.setUint16(0x44, 0x14c, true); v.setUint16(0x46, 1, true); v.setUint16(0x54, 0xe0, true); v.setUint16(0x56, dll ? 0x2102 : 0x102, true);
  const o = 0x58;
  v.setUint16(o, 0x10b, true); v.setUint32(o + 16, rva(entry), true); v.setUint32(o + 28, base, true); v.setUint32(o + 32, 0x1000, true); v.setUint32(o + 36, 0x200, true);
  v.setUint16(o + 48, 4, true); v.setUint32(o + 56, 0x2000, true); v.setUint32(o + 60, 0x200, true); v.setUint16(o + 68, 3, true);
  v.setUint32(o + 72, 0x100000, true); v.setUint32(o + 76, 0x1000, true); v.setUint32(o + 80, 0x100000, true); v.setUint32(o + 84, 0x1000, true); v.setUint32(o + 92, 16, true);
  if (exports) { v.setUint32(o + 96, rva(0xa00), true); v.setUint32(o + 100, 0x200, true); }
  if (imports.length) { v.setUint32(o + 104, rva(0x600), true); v.setUint32(o + 108, 20 * (imports.length + 1), true); }
  if (tls) { v.setUint32(o + 96 + 8 * 9, rva(0x480), true); v.setUint32(o + 100 + 8 * 9, 24, true); }
  const sh = o + 0xe0;
  b.set(new TextEncoder().encode('.text'), sh); v.setUint32(sh + 8, 0x1000, true); v.setUint32(sh + 12, 0x1000, true); v.setUint32(sh + 16, 0x1000, true); v.setUint32(sh + 20, S, true); v.setUint32(sh + 36, 0xe0000060, true);
  return b;
};
const le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const runPE = async (exe, readFile) => {
  const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
  const mc = new Machine({ memSize: 64 << 20, cpu: '686' }); installBIOS(mc); const lx = installLinux(mc);
  loadPE(lx, mc.mem, mc.cpu, exe, { apis: win32Apis(), readFile, backend: traceBackend() });
  for (let i = 0; i < 200 && !lx.done; i++) mc.runSlice(20000);
  return lx.done ? lx.status : 'running';
};
// A DLL the program imports (Abuse's SDL2.dll) is initialized before the program's entry point -- its
// DllMain(DLL_PROCESS_ATTACH) here sets a flag its export returns: run when first LoadLibrary'd, inside
// one of its own functions, SDL2's C runtime set a new stack cookie under frames that had saved the old
// one (__report_gsfailure, 0xC0000409). And static TLS: the program reads its __declspec(thread) value
// through fs:[2Ch] and its index, as Visual C++'s thread-safe statics do. 100 * flag + the TLS value.
{ let got;
  try {
    const lib = mkPE({ base: 0x50000000, dll: true, exports: { f: 0x20 }, code: (at) => Uint8Array.from([
      0xc7, 0x05, ...le(at.d(0x400)), 1, 0, 0, 0, 0xb8, 1, 0, 0, 0, 0xc2, 0x0c, 0x00,          // DllMain: flag = 1; return TRUE
      ...new Array(0x20 - 17).fill(0x90), 0xa1, ...le(at.d(0x400)), 0xc3]) });                  // f: return flag
    const exe = mkPE({ imports: [{ dll: 't.dll', names: ['f'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], tls: Uint8Array.of(42, 0, 0, 0), code: (at) => Uint8Array.from([
      0x64, 0xa1, 0x2c, 0, 0, 0, 0x8b, 0x0d, ...le(at.d(0x404)), 0x8b, 0x04, 0x88, 0x8b, 0x18,   // ebx = [ThreadLocalStoragePointer[_tls_index]]
      0xff, 0x15, ...le(at.iat['t.dll!f']), 0x6b, 0xc0, 0x64, 0x01, 0xd8,                          // eax = f() * 100 + ebx
      0x50, 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4]) });
    got = String(await runPE(exe, (k) => (k.toLowerCase() === 't.dll' ? lib : null)));
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: an imported DLL\'s DllMain runs before the entry point; static TLS through fs:[2Ch]', got, '142'); }
// SetWindowPos that sizes the main window sends WM_WINDOWPOSCHANGED, then WM_SIZE, as Windows does: SDL 2
// takes a new size from the first (its fullscreen-desktop window kept a 640x480 framebuffer otherwise).
// The window procedure logs the messages; the exit code (a byte) is the first after SetWindowPos plus
// twice the second: 47h + 2 * 5.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'user32.dll', names: ['RegisterClassA', 'CreateWindowExA', 'SetWindowPos'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const wc = at.d(0x440), cls = at.d(0x470), hwnd = at.d(0x478), log = at.d(0x410), cnt = at.d(0x430), proc = at.d(0x200);
      const main = [0x68, ...le(wc), 0xff, 0x15, ...le(at.iat['user32.dll!RegisterClassA']),
        0x6a, 0, 0x68, ...le(0x400000), 0x6a, 0, 0x6a, 0, 0x68, ...le(200), 0x68, ...le(300), 0x6a, 0, 0x6a, 0, 0x68, ...le(0xcf0000), 0x6a, 0, 0x68, ...le(cls), 0x6a, 0,
        0xff, 0x15, ...le(at.iat['user32.dll!CreateWindowExA']), 0xa3, ...le(hwnd), 0xc7, 0x05, ...le(cnt), 0, 0, 0, 0,
        0x6a, 0x14, 0x68, ...le(400), 0x68, ...le(500), 0x6a, 10, 0x6a, 10, 0x6a, 0, 0xff, 0x35, ...le(hwnd), 0xff, 0x15, ...le(at.iat['user32.dll!SetWindowPos']),
        0xa1, ...le(log + 4), 0x01, 0xc0, 0x03, 0x05, ...le(log), 0x50, 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4];
      const wndproc = [0x8b, 0x44, 0x24, 0x08, 0x8b, 0x0d, ...le(cnt), 0x83, 0xe1, 0x07, 0x89, 0x04, 0x8d, ...le(log), 0xff, 0x05, ...le(cnt), 0x31, 0xc0, 0xc2, 0x10, 0x00];
      const img = new Uint8Array(0x500); img.set(main); img.set(wndproc, 0x200);
      img.set(le(proc), 0x444); img.set(le(cls), 0x464); img.set(new TextEncoder().encode('wpc\0'), 0x470);   // WNDCLASSA: lpfnWndProc, lpszClassName
      return img;
    } });
    got = (await runPE(exe)).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: SetWindowPos sends WM_WINDOWPOSCHANGED, then WM_SIZE', got, '51'); }
// WH_KEYBOARD: a key message GetMessage takes from the queue goes to the program's hook first, with its key
// (Jazz Jackrabbit 2 reads its keyboard so; installed and never called, its menus took no key). The hook
// keeps its wParam; the exit code is it: 41h, the A key.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'user32.dll', names: ['SetWindowsHookExA', 'PostMessageA', 'GetMessageA'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const msg = at.d(0x440), log = at.d(0x410), proc = at.d(0x200);
      const main = [0x6a, 0, 0x6a, 0, 0x68, ...le(proc), 0x6a, 2, 0xff, 0x15, ...le(at.iat['user32.dll!SetWindowsHookExA']),
        0x68, ...le(0x1e0001), 0x6a, 0x41, 0x68, ...le(0x100), 0x6a, 0, 0xff, 0x15, ...le(at.iat['user32.dll!PostMessageA']),
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...le(msg), 0xff, 0x15, ...le(at.iat['user32.dll!GetMessageA']),
        0xff, 0x35, ...le(log), 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4];
      const hook = [0x8b, 0x44, 0x24, 0x08, 0xa3, ...le(log), 0x31, 0xc0, 0xc2, 0x0c, 0x00];
      const img = new Uint8Array(0x500); img.set(main); img.set(hook, 0x200);
      return img;
    } });
    got = (await runPE(exe)).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: WH_KEYBOARD -- GetMessage hands a key message to the hook first', got, '41'); }
// SendMessage gives the caller what the window procedure returned: the return stub (mirageReturn) set EAX
// to its own number before it trapped, so every sent message's result was that number (a dialog's
// procedure "handled" everything, and DefWindowProc never ran for it). The procedure returns 42h for
// WM_USER; the exit code is SendMessage's result.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'user32.dll', names: ['RegisterClassA', 'CreateWindowExA', 'SendMessageA'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const wc = at.d(0x440), cls = at.d(0x470), proc = at.d(0x200);
      const main = [0x68, ...le(wc), 0xff, 0x15, ...le(at.iat['user32.dll!RegisterClassA']),
        0x6a, 0, 0x68, ...le(0x400000), 0x6a, 0, 0x6a, 0, 0x68, ...le(200), 0x68, ...le(300), 0x6a, 0, 0x6a, 0, 0x68, ...le(0xcf0000), 0x6a, 0, 0x68, ...le(cls), 0x6a, 0,
        0xff, 0x15, ...le(at.iat['user32.dll!CreateWindowExA']),
        0x6a, 0, 0x6a, 0, 0x68, ...le(0x400), 0x50, 0xff, 0x15, ...le(at.iat['user32.dll!SendMessageA']),
        0x50, 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4];
      const wndproc = [0x8b, 0x44, 0x24, 0x08, 0x3d, ...le(0x400), 0x75, 0x08, 0xb8, ...le(0x42), 0xc2, 0x10, 0x00, 0x31, 0xc0, 0xc2, 0x10, 0x00];
      const img = new Uint8Array(0x500); img.set(main); img.set(wndproc, 0x200);
      img.set(le(proc), 0x444); img.set(le(cls), 0x464); img.set(new TextEncoder().encode('smc\0'), 0x470);
      return img;
    } });
    got = (await runPE(exe)).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: SendMessage gives back what the window procedure returned', got, '42'); }
// A modal dialog box: DialogBoxIndirectParamA on a template in memory, its procedure ending it with 2Ah
// on WM_INITDIALOG; DialogBox returns that once its loop has run -- modalLoop, called on DialogBox's own
// frame from the result of the sequence that made the dialog: a send within a send's result, which
// found no return address on the stack while mirageReturn took the frame off first. The exit code is
// DialogBox's result.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'user32.dll', names: ['DialogBoxIndirectParamA', 'EndDialog'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const tpl = at.d(0x440), proc = at.d(0x200);
      const main = [0x6a, 0, 0x68, ...le(proc), 0x6a, 0, 0x68, ...le(tpl), 0x6a, 0, 0xff, 0x15, ...le(at.iat['user32.dll!DialogBoxIndirectParamA']),
        0x50, 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4];
      // cmp dword [esp+8], WM_INITDIALOG / jne +20 / EndDialog(hdlg, 2Ah) / mov eax, 1 / ret 16 / xor eax, eax / ret 16
      const dlgproc = [0x81, 0x7c, 0x24, 0x08, ...le(0x110), 0x75, 0x14, 0x6a, 0x2a, 0xff, 0x74, 0x24, 0x08, 0xff, 0x15, ...le(at.iat['user32.dll!EndDialog']),
        0xb8, ...le(1), 0xc2, 0x10, 0x00, 0x31, 0xc0, 0xc2, 0x10, 0x00];
      const img = new Uint8Array(0x500); img.set(main); img.set(dlgproc, 0x200);
      // DLGTEMPLATE: WS_POPUP | WS_VISIBLE, no controls, at (10, 10), 100 x 50 units; no menu, class or title.
      img.set([...le(0x90000000), 0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 100, 0, 50, 0, 0, 0, 0, 0, 0, 0], 0x440);
      return img;
    } });
    got = (await runPE(exe)).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: DialogBoxIndirectParamA runs its modal loop and returns EndDialog\'s result', got, '2a'); }
// SetTimer: WM_TIMER when it is due and nothing else is queued, its TIMERPROC called by DispatchMessage
// (Minesweeper's clock never ran). A thread's timer of 50 ms; the loop takes and dispatches until the
// procedure has counted three; the exit code is the count.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'user32.dll', names: ['SetTimer', 'GetMessageA', 'DispatchMessageA'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const msg = at.d(0x440), cnt = at.d(0x410), proc = at.d(0x200);
      const main = [0x68, ...le(proc), 0x6a, 50, 0x6a, 0, 0x6a, 0, 0xff, 0x15, ...le(at.iat['user32.dll!SetTimer'])];
      const loop = main.length;
      main.push(0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...le(msg), 0xff, 0x15, ...le(at.iat['user32.dll!GetMessageA']),
        0x68, ...le(msg), 0xff, 0x15, ...le(at.iat['user32.dll!DispatchMessageA']), 0x83, 0x3d, ...le(cnt), 3, 0x7c, 0);
      main[main.length - 1] = (loop - main.length) & 255;
      main.push(0xff, 0x35, ...le(cnt), 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4);
      const tproc = [0xff, 0x05, ...le(cnt), 0xc2, 0x10, 0x00];
      const img = new Uint8Array(0x500); img.set(main); img.set(tproc, 0x200);
      return img;
    } });
    got = String(await runPE(exe));
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: SetTimer -- WM_TIMER when due, its TIMERPROC called by DispatchMessage', got, '3'); }
// msvcrt's DATA exports: _acmdln, the command line, a variable the program reads where its import points
// (a Visual C++ 6 program's start-up) -- the exit code its first character, the quote round its path.
{ let got;
  try {
    const exe = mkPE({ imports: [{ dll: 'msvcrt.dll', names: ['_acmdln'] }, { dll: 'kernel32.dll', names: ['ExitProcess'] }], code: (at) => {
      const main = [0xa1, ...le(at.iat['msvcrt.dll!_acmdln']), 0x8b, 0x00, 0x0f, 0xb6, 0x00, 0x50, 0xff, 0x15, ...le(at.iat['kernel32.dll!ExitProcess']), 0xf4];
      const img = new Uint8Array(0x500); img.set(main); return img;
    } });
    got = (await runPE(exe)).toString(16);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: msvcrt.dll\'s _acmdln, a DATA export, the command line', got, '22'); }
// A wait that is asked again with a new deadline once the old one has passed (GetMessage, 10 ms at a time
// while nothing comes) takes the new one: the old, kept, gave the clock nowhere to go, and an idle window
// waited two cycles at a time -- Minesweeper's 5 s, 500 million calls.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { traceBackend } = await import('../src/hle/trace.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024), v = new DataView(exe.buffer); exe.set([0x4d, 0x5a]); v.setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0], 0x40); v.setUint16(0x54, 0xe0, true); v.setUint16(0x58, 0x10b, true);
    v.setUint32(0x58 + 28, 0x400000, true); v.setUint32(0x58 + 56, 0x1000, true); v.setUint32(0x58 + 60, 0x200, true);
    const { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis: win32Apis(), backend: traceBackend() }), at = (t) => { mc.cpu.cycles = Math.round(t * 1e8); };
    at(1); lx.wake = null; x.waitUntil(1.01); at(1.02); x.waitUntil(1.03);
    got = String(lx.wake);
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: a wait asked again after its deadline takes the new one', got, '1.03'); }
// Sound from a thread. waveOut (src/win32): a buffer written, THEN filled -- a 4K intro's synthesizer
// fills it while it plays -- is heard with what it holds when played; the position is the guest's clock
// at the format's rate. SDL's audio (src/hle/sdl12.js): the audio loop calls the program's callback, a
// few instructions that fill the buffer with 1234h, and its samples reach the card. A header still
// playing is not unprepared: Retrospection's thread waits on that, and wrote four times too fast.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    const pe = [0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1]; exe.set(pe, 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const apis = win32Apis(), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis }), wm = apis.find((d) => d.dll === 'winmm.dll').fns;
    const wfx = x.win.heapAlloc(18), ph = x.win.heapAlloc(4), hdr = x.win.heapAlloc(32), data = x.win.heapAlloc(44100 * 4), mmt = x.win.heapAlloc(12);
    x.w16(wfx, 1); x.w16(wfx + 2, 2); x.w32(wfx + 4, 44100); x.w32(wfx + 8, 44100 * 4); x.w16(wfx + 12, 4); x.w16(wfx + 14, 16);
    x.w32(hdr, data); x.w32(hdr + 4, 44100 * 4);
    wm.waveOutOpen[1](x, ph, 0xffffffff, wfx, 0, 0, 0); wm.waveOutPrepareHeader[1](x, x.r32(ph), hdr, 32); wm.waveOutWrite[1](x, x.r32(ph), hdr, 32);
    for (let i = 0; i < 44100 * 2; i++) x.w16(data + i * 2, 1000);   // filled after the write
    mc.cpu.cycles += (mc.cyclesPerSecond || 1e8) / 2;                // half a second of the guest's clock
    x.w32(mmt, 4); wm.waveOutGetPosition[1](x, x.r32(ph), mmt, 12);
    const w = mc.dsp.drain();
    // Unprepared while it plays, it is refused (WAVERR_STILLPLAYING, 33); played out, let go.
    const busy = wm.waveOutUnprepareHeader[1](x, x.r32(ph), hdr, 32);
    mc.cpu.cycles += (mc.cyclesPerSecond || 1e8) * 0.6;
    const freed = wm.waveOutUnprepareHeader[1](x, x.r32(ph), hdr, 32);
    const wave = [x.r32(mmt + 4), w.samples.length, w.samples.every((v) => v === 1000), busy, freed].join(' ');
    // SDL: a callback of x86 (mov edi,[esp+8]; mov ecx,[esp+12]; shr ecx,1; mov ax,1234h; rep stosw; ret)
    const { sdl12 } = await import('../src/hle/sdl12.js'), { hleDispatch } = await import('../src/hle/index.js');
    const mc2 = new Machine({ memSize: 16 << 20, cpu: '686' }), lx2 = installLinux(mc2);
    lx2.load(Uint8Array.from('7f454c4601010100000000000000000002000300010000005480040834000000000000000000000034002000010000000000000001000000000000000080040800800408790000007d1000000700000000100000a17980040885c074f789c3b801000000cd80c705798004082a000000b80100000031dbcd80'.match(/../g), (v) => parseInt(v, 16)), ['/THREAD']);
    const lib = sdl12(), x2 = hleDispatch(lx2, mc2.mem, mc2.cpu, Object.entries(lib.fns).map(([name, [sig, fn]]) => ({ name, sig, fn })), {});
    const cb = x2.alloc(32), spec = x2.alloc(24);
    x2.write(cb, Uint8Array.of(0x8b, 0x7c, 0x24, 0x08, 0x8b, 0x4c, 0x24, 0x0c, 0xd1, 0xe9, 0x66, 0xb8, 0x34, 0x12, 0xf3, 0x66, 0xab, 0xc3));
    x2.w32(spec, 22050); x2.w16(spec + 4, 0x8010); x2.w8(spec + 6, 1); x2.w16(spec + 8, 256); x2.w32(spec + 16, cb);
    lib.fns.SDL_OpenAudio[1](x2, spec, 0); lib.fns.SDL_PauseAudio[1](x2, 0);
    for (let i = 0; i < 100; i++) mc2.runSlice(20000);
    const s = mc2.dsp.drain();
    got = [wave, s.rate, s.samples.length > 0 && s.samples.slice(512).every((v) => v === 0x1234)].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('sound from a thread: waveOut plays a buffer filled after its write; SDL\'s audio loop calls the callback', got, '88200 44100 true 33 0 | 22050 | true'); }
// A looped waveOut header (WHDR_BEGINLOOP | WHDR_ENDLOOP, dwLoops): its bytes play again and again and
// the position goes on through the loops, as Wine's winmm. cdak (2010) streams its music through a
// 32 KiB ring looped 0xFFFFFFFF times and times its pictures by the position: capped at the ring's
// end, its clock stopped a fifth of a second in.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const apis = win32Apis(), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis }), wm = apis.find((d) => d.dll === 'winmm.dll').fns;
    const wfx = x.win.heapAlloc(18), ph = x.win.heapAlloc(4), hdr = x.win.heapAlloc(32), data = x.win.heapAlloc(8), mmt = x.win.heapAlloc(12);
    x.w16(wfx, 1); x.w16(wfx + 2, 2); x.w32(wfx + 4, 44100); x.w32(wfx + 8, 44100 * 4); x.w16(wfx + 12, 4); x.w16(wfx + 14, 16);
    [100, 100, 200, 200].forEach((v, i) => x.w16(data + 2 * i, v));    // two stereo frames
    x.w32(hdr, data); x.w32(hdr + 4, 8); x.w32(hdr + 16, 0xc); x.w32(hdr + 20, 0xffffffff);
    wm.waveOutOpen[1](x, ph, 0xffffffff, wfx, 0, 0, 0); wm.waveOutPrepareHeader[1](x, x.r32(ph), hdr, 32); wm.waveOutWrite[1](x, x.r32(ph), hdr, 32);
    mc.cpu.cycles += (mc.cyclesPerSecond || 1e8) / 2;
    x.w32(mmt, 4); wm.waveOutGetPosition[1](x, x.r32(ph), mmt, 12);
    const w = mc.dsp.drain();
    got = [x.r32(mmt + 4), w.samples.length, w.samples.every((v, i) => v === ((i >> 1) & 1 ? 200 : 100)), x.r32(hdr + 16) & 1].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: a looped waveOut header plays its bytes over and the position counts through the loops', got, '88200 44100 true 0'); }
// Stiletto (RGBA, 2010) reads its instruments from XP's drivers/gm.dls (OpenFile, SetFilePointer,
// ReadFile) and plays its song with sndPlaySoundA(SND_MEMORY | SND_ASYNC). Without OpenFile its
// import walk landed on CloseHandle, the "open" returned 1 and its camera never moved; when no name
// opens, it runs off the end of its list. gm.dls opens as XP's size in zeros; the WAV plays from memory.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js');
    const mc = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(mc);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const apis = win32Apis(), { x } = loadPE(lx, mc.mem, mc.cpu, exe, { apis });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1], k32 = (n) => fn('kernel32.dll', n);
    const name = x.win.heapAlloc(32), of = x.win.heapAlloc(136), buf = x.win.heapAlloc(8), nr = x.win.heapAlloc(4);
    x.write(name, new TextEncoder().encode('drivers/gm.dls\0')); x.write(buf, new Uint8Array(8).fill(0xaa));
    const h = k32('OpenFile')(x, name, of, 0);
    const at = k32('SetFilePointer')(x, h, 3440656, 0, 0), ok = k32('ReadFile')(x, h, buf, 8, nr, 0);
    x.write(name, new TextEncoder().encode('nothere.dat\0'));
    const miss = k32('OpenFile')(x, name, of, 0) | 0, err = x.r16(of + 2);
    // a 16-bit stereo WAV of two frames, looped: what the mixer hears is its data chunk
    const wav = x.win.heapAlloc(52), dv = new DataView(new ArrayBuffer(52));
    [[0, 0x46464952], [4, 44], [8, 0x45564157], [12, 0x20746d66], [16, 16], [36, 0x61746164], [40, 8]].forEach(([a, v]) => dv.setUint32(a, v, true));
    [[20, 1], [22, 2], [32, 4], [34, 16]].forEach(([a, v]) => dv.setUint16(a, v, true)); dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 4, true);
    [300, 300, 400, 400].forEach((v, i) => dv.setInt16(44 + 2 * i, v, true));
    x.write(wav, new Uint8Array(dv.buffer));
    const played = fn('winmm.dll', 'sndPlaySoundA')(x, wav, 4 | 1 | 8);
    mc.cpu.cycles += (mc.cyclesPerSecond || 1e8) / 2;
    const w = mc.dsp.drain();
    got = [h > 0, at, ok, x.r32(nr), x.r32(buf + 4).toString(16), miss, err, played, w.samples.length, w.samples.every((v, i) => v === ((i >> 1) & 1 ? 400 : 300))].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('win32: OpenFile reads XP\'s gm.dls as zeros; sndPlaySoundA plays a WAV from memory', got, 'true 3440656 1 4 aaaaaaaa -1 2 1 44100 true'); }
// General MIDI (src/midi.js). DOS: the MPU-401 at 330h acknowledges UART mode (3Fh) with FEh, then a
// program change and a note on written to 330h sound in the synthesizer, at the machine's clock --
// Difúze (2010) plays its music so. Win32: Photon Race 2 (2008) writes a .mid (CreateFileA, WriteFile),
// opens it with MCI as a "sequencer" and plays it; a Standard MIDI File's tempo change moves the
// times of what follows. Before, the MPU-401 did not answer and mciSendCommandA did not exist.
{ let got;
  try { const { loadPE } = await import('../src/win32/index.js'), { win32Apis } = await import('../src/win32/api.js'), { parseSMF } = await import('../src/midi.js');
    const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc);
    const io = (port, v) => mc.ioWrite(port, 1, v);
    io(0x331, 0x3f);
    const st = mc.ioRead(0x331, 1), ack = mc.ioRead(0x330, 1);
    mc.midi.capture = true;
    io(0x330, 0xc0); io(0x330, 0x00); io(0x330, 0x90); io(0x330, 60); io(0x330, 100);
    mc.cpu.cycles += 18.2065 * mc.pitBase / 10;                     // a tenth of a second
    mc.midi.render();
    const dos = mc.midi.drain().samples.filter((v) => v !== 0).length > 1000;
    // A two-track SMF: 96 ticks a quarter; tempo 500000 us, then 250000 at tick 96; notes at 0, 96 and 192.
    const vlq = (n) => (n < 128 ? [n] : [0x80 | (n >> 7), n & 0x7f]);
    const trk = (ev) => { const b = ev.flat(); return [0x4d, 0x54, 0x72, 0x6b, 0, 0, b.length >> 8, b.length & 255, ...b]; };
    const smf = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 0, 96,
      ...trk([[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], [...vlq(96), 0xff, 0x51, 3, 0x03, 0xd0, 0x90], [0, 0xff, 0x2f, 0]]),
      ...trk([[0, 0x90, 60, 100], [...vlq(96), 0x90, 64, 100], [...vlq(96), 0x80, 64, 0], [0, 0xff, 0x2f, 0]])]);
    const times = parseSMF(smf).map((e) => e.t.toFixed(2)).join(',');
    const m2 = new Machine({ memSize: 64 << 20, cpu: '686' }), lx = installLinux(m2);
    const exe = new Uint8Array(1024); exe.set([0x4d, 0x5a]); new DataView(exe.buffer).setUint32(0x3c, 0x40, true);
    exe.set([0x50, 0x45, 0, 0, 0x4c, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xe0, 0, 2, 1], 0x40);
    const o = new DataView(exe.buffer, 0x58); o.setUint16(0, 0x10b, true); o.setUint32(28, 0x400000, true); o.setUint32(32, 0x1000, true); o.setUint32(36, 0x200, true); o.setUint32(56, 0x2000, true); o.setUint32(60, 0x200, true);
    const apis = win32Apis(), { x } = loadPE(lx, m2.mem, m2.cpu, exe, { apis });
    const fn = (dll, n) => apis.find((d) => d.dll === dll).fns[n][1];
    const name = x.win.heapAlloc(32), buf = x.win.heapAlloc(smf.length), nw = x.win.heapAlloc(4), parms = x.win.heapAlloc(20), type = x.win.heapAlloc(16);
    x.write(name, new TextEncoder().encode('C:\\TEMP\\SONG.MID\0')); x.write(buf, smf); x.write(type, new TextEncoder().encode('sequencer\0'));
    const h = fn('kernel32.dll', 'CreateFileA')(x, name, 0x40000000, 0, 0, 2, 0, 0);
    fn('kernel32.dll', 'WriteFile')(x, h, buf, smf.length, nw, 0);
    x.write(parms, new Uint8Array(20)); x.w32(parms + 8, type); x.w32(parms + 12, name);
    const open = fn('winmm.dll', 'mciSendCommandA')(x, 0, 0x803, 0x2200, parms), dev = x.r32(parms + 4);
    const play = fn('winmm.dll', 'mciSendCommandA')(x, dev, 0x806, 0, 0);
    const playing = lx.midi().playing();
    got = [ack.toString(16), st.toString(16), dos, times, open, dev, play, playing].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('midi: the MPU-401 answers UART mode and sounds; an SMF\'s tempo is followed; MCI plays a written .mid', got, 'fe 0 true 0.00,0.50,0.75 0 1 0 true'); }
// tools/linux/lsroot.asm: the entries of / by getdents64 — the host's root merged with what MIRAGE-LINUX
// makes itself. On a host root of etc and var: . .. dev tmp (ours) etc var = 6. Docker's whole root: 22.
// MIRAGE listed / without the host's entries (ls / showed bin dev etc lib proc root tmp usr).
{ const hex = (                                         // nasm -f bin tools/linux/lsroot.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '0000000001000000000000000080040800800408a3000000002000000700000000100000b805000000bba1800408b900' +
    '000100cd8089c731edb8dc00000089fbb900900408ba00100000cd8085c07e18be009004088d9000900408450fb74e10' +
    '01ce39d672f5ebd1b80100000089ebcd802f00');
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
  const dirs = { '/': ['etc', 'var'], '/etc': [], '/var': [] };
  lx.host = { lstat: (q) => (dirs[q] ? { type: 'dir' } : null), list: (q) => dirs[q] || [], read: () => null };
  lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/LSROOT']);
  for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
  eq('linux: / lists the host root merged with its own directories', lx.status, 6); }
// lx.changes: what an OASIS `run` layer keeps of a run (tools/oasis.mjs) — tools/linux/commit.asm over a
// host tree of /keep, /mod, /old. A file only read is the host's still; one appended to, one made, a
// link, a directory and a removal are the run's. (/tmp is MIRAGE-LINUX's own, absent from this host.)
{ let got; try { const hex = (                          // nasm -f bin tools/linux/commit.asm
    '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000' +
    '000000000100000000000000008004080080040830010000400100000700000000100000b805000000bb0e81040831c9' +
    'cd8089c3b803000000b930810408ba01000000cd80b806000000cd80b805000000bb14810408b901040000cd8089c3b8' +
    '04000000b92d810408ba01000000cd80b806000000cd80b80a000000bb19810408cd80b805000000bb1e810408b94100' +
    '0000baa0010000cd8089c3b804000000b92e810408ba02000000cd80b806000000cd80b853000000bb1e810408b92381' +
    '0408cd80b827000000bb28810408b9c0010000cd80b80100000031dbcd802f6b656570002f6d6f64002f6f6c64002f6e' +
    '6577002f6c6e6b002f64697200216869');
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
  const host = { '/keep': 'kk', '/mod': 'mm', '/old': 'oo' }, enc = (x) => Uint8Array.from(x, (c) => c.charCodeAt(0));
  lx.host = { lstat: (q) => (q === '/' ? { type: 'dir' } : host[q] ? { type: 'file', size: 2, mode: 0o100644 } : null),
    list: (q) => (q === '/' ? Object.keys(host).map((k) => k.slice(1)) : []), read: (q) => enc(host[q]) };
  lx.load(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)), ['/COMMIT']);
  for (let i = 0; i < 100 && !lx.done; i++) mc.runSlice(20000);
  const c = lx.changes(), dec = (b) => String.fromCharCode(...b);
  got = [lx.status, c.files.map((f) => `${f.path}=${dec(f.bytes)}:${(f.mode ?? 0).toString(8)}`).join(','), c.links.map((l) => `${l.path}->${l.target}`).join(','),
    c.dirs.map((x) => `${x.path}:${(x.mode ?? 0).toString(8)}`).join(','), c.removed.join(',')].join(' ');
  } catch (e) { got = e.message; }
  eq('linux: a run\'s changes over the host tree, as an OASIS run layer keeps them', got, '0 /mod=mm!:644,/new=hi:640 /lnk->/new /tmp:0,/dir:700 /old'); }
// The console's line discipline (n_tty with the default termios: ICANON ECHO ICRNL, OPOST ONLCR): a
// line is edited — Backspace erases — and handed over at Enter, its echo on the screen.
{ const lx = installLinux(new Machine({ memSize: 16 << 20, cpu: '686' })), echoed = [];
  lx.onOutput = (fd, b) => echoed.push(...b);
  lx.tty.kbMode = 1;
  let got; try { lx.keyScancodes([0x1e, 0x9e, 0x30, 0xb0, 0x0e, 0x8e, 0x2e, 0xae]); const before = lx.ttyIn.length;   // a b BS c
    lx.keyScancodes([0x1c, 0x9c]);                                       // Enter
    got = `${before} ${String.fromCharCode(...lx.ttyIn).replace('\n', '|')} ${String.fromCharCode(...echoed).replace(/\x08/g, '<').replace('\r\n', '|')}`;
  } catch (e) { got = e.message; }
  eq('linux: a console line is edited and handed over at Enter, with its echo', got, '0 ac| ab< <c|'); }
// src/vtconsole.js: the tty's text on the VGA text screen — CR LF, a CSI cursor position, SGR colour.
{ const { VtConsole } = await import('../src/vtconsole.js');
  const u8 = new Uint8Array(0xc0000), vga = { crtc: new Uint8Array(32), startAddr: () => 0 }, vt = new VtConsole(u8, vga);
  vt.write([...'ab\r\ncd\x1b[3;5H\x1b[31mX\x1b[0m'].map((c) => c.charCodeAt(0)));
  const at = (r, c) => String.fromCharCode(u8[0xb8000 + (r * 80 + c) * 2]) + u8[0xb8000 + (r * 80 + c) * 2 + 1].toString(16);
  // The cursor is where the VGA draws it from, CRTC 0Eh/0Fh: row 2, column 5 is location 165.
  eq('linux: the VGA text console places text, moves the cursor, colours', [at(0, 0), at(1, 1), at(2, 4), u8[0x450], u8[0x451], (vga.crtc[0x0e] << 8) | vga.crtc[0x0f]].join(' '), 'a7 d7 X4 5 2 165'); }
// The console's keyboard modes, as the kernel delivers keys (drivers/tty/vt/keyboard.c): K_MEDIUMRAW gives
// keycodes — an ordinary key's scancode, the kernel's number for an E0 key (Up 103), bit 7 on release —
// which is what SVGAlib reads for id's Linux DOOM; K_XLATE gives characters; K_RAW the scancodes.
{ const lx = installLinux(new Machine({ memSize: 16 << 20, cpu: '686' })), keys = [0xe0, 0x48, 0xe0, 0xc8, 0x1e, 0x9e];
  lx.tty.termios = new Uint8Array(36);                                  // raw: no ICANON, no ECHO, no ICRNL
  let got; try { got = [2, 1, 0].map((mode) => { lx.tty.kbMode = mode; lx.ttyIn.length = 0; lx.keyScancodes(keys); return lx.ttyIn.join(','); }).join(' / '); } catch (e) { got = e.message; }
  eq('linux: keys reach the console as keycodes, characters or scancodes by its mode', got, '103,231,30,158 / 27,91,65,97 / 224,72,224,200,30,158'); }

// ---- OASIS: tools/oasis.mjs's own tar reader ---------------------------------------------------------
// Images are unpacked from Debian packages, idgames tarballs and `docker export` without the host's tar,
// which on macOS dropped Debian's empty directories (/etc/apt/keyrings): an empty directory, a file, a
// symbolic link and a GNU long name must all come through as the archive has them.
{ const { untar } = await import('./oasis.mjs');
  const fsm = await import('fs'), osm = await import('os'), pm = await import('path');
  const hdr = (name, type, size = 0, link = '') => { const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0, 'latin1'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write(type, 156); h.write(link, 157);
    h.write('        ', 148); let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return h; };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - b.length % 512) % 512)]);
  const long = 'deep/' + 'x'.repeat(120) + '.txt';
  const tar = Buffer.concat([hdr('etc/apt/keyrings/', '5'), hdr('etc/hello.txt', '0', 3), pad(Buffer.from('hi\n')),
    hdr('bin', '2', 0, 'usr/bin'), hdr('././@LongLink', 'L', long.length + 1), pad(Buffer.from(long + '\0')), hdr('ignored', '0', 2), pad(Buffer.from('ok')), Buffer.alloc(1024)]);
  const dir = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'oasis-test-'));
  let got;
  try {
    untar(tar, dir);
    got = [fsm.existsSync(pm.join(dir, 'etc/apt/keyrings')), fsm.readFileSync(pm.join(dir, 'etc/hello.txt'), 'utf8'),
      fsm.readlinkSync(pm.join(dir, 'bin')), fsm.readFileSync(pm.join(dir, long), 'utf8')];
  } catch (e) { got = e.message.slice(0, 60); }
  fsm.rmSync(dir, { recursive: true, force: true });
  eq('oasis: tar keeps an empty directory, a file, a symbolic link and a long name', JSON.stringify(got), JSON.stringify([true, 'hi\n', 'usr/bin', 'ok'])); }

// ---- LHA (src/lha.js): id's quake106.zip keeps its game in an LHA self-extractor -----------------------
// Built here bit by bit, with no third-party data: a -lh5- stream of two blocks, each with one-symbol
// tables (n = 0) — 'M', then a match of length 4 at distance 1 — and a -lh0- (stored) file, behind a
// few bytes of "self-extractor" the reader must skip. Checked against bsdtar on resource.1 (16 files).
{ let got;
  try { const { unlha } = await import('../src/lha.js');
    const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    for (const c of [77, 256 + 1]) { put(1, 16); put(0, 5); put(0, 5); put(0, 9); put(c, 9); put(0, 4); put(0, 4); }
    while (bits.length % 8) bits.push(0);
    const lh5 = []; for (let i = 0; i < bits.length; i += 8) lh5.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const entry = (method, name, data, orig) => { const n = [...name].map((c) => c.charCodeAt(0));
      const le = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
      return [22 + n.length, 0, ...[...method].map((c) => c.charCodeAt(0)), ...le(data.length), ...le(orig), 0, 0, 0, 0, 0x20, 0, n.length, ...n, 0, 0, ...data]; };
    const arc = Uint8Array.from([0x4d, 0x5a, 1, 2, 3, ...entry('-lh5-', 'ID1\\M.TXT', lh5, 5), ...entry('-lh0-', 'HI.TXT', [104, 105], 2), 0]);
    got = unlha(arc).map((f) => f.path + '=' + new TextDecoder().decode(f.bytes)).join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('LHA: -lh5- blocks with a literal and a match, a stored file, after a self-extractor', got, 'ID1/M.TXT=MMMMM HI.TXT=hi'); }

// ---- OASIS: the busybox layer links every applet the binary lists (tools/oasis.mjs) ------------------
// A Linux with no distribution (linux/doom-mini): one static busybox, linked as `busybox --install -s`
// would, its applet list taken from the binary itself run on MIRAGE-LINUX. tools/linux/applets.asm
// stands in for busybox: it lists ls, busybox and cat.
{ let got; const fsm = await import('fs'), osm = await import('os'), pm = await import('path');
  const tmp = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'oasis-bb-')); let layerDir = null;
  try { const { linuxRoot } = await import('./oasis.mjs');
    const hex = '7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000000000000100000000000000008004080080040882000000820000000500000000100000b804000000bb01000000b973800408ba0f000000cd80b80100000031dbcd806c730a62757379626f780a6361740a';
    fsm.writeFileSync(pm.join(tmp, 'busybox'), Buffer.from(hex, 'hex'));
    const root = await linuxRoot({ layers: [{ busybox: pm.join(tmp, 'busybox') }] }); layerDir = root.dirs[0];
    const bin = pm.join(layerDir, 'bin');
    got = fsm.readdirSync(bin).sort().map((n) => n + (fsm.lstatSync(pm.join(bin, n)).isSymbolicLink() ? '->' + fsm.readlinkSync(pm.join(bin, n)) : '')).join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  fsm.rmSync(tmp, { recursive: true, force: true }); if (layerDir) fsm.rmSync(layerDir, { recursive: true, force: true });
  eq('oasis: a busybox layer links each applet the binary lists', got, 'busybox cat->busybox ls->busybox'); }

// ---- OASIS in a page: the tree built from the layers with no server (src/oasis-layers.js) ------------
// A tar (gzipped) and a .deb made here, a file, links and a directory, as buildTree reads them; then a
// run layer's cached result that removes a file. Paths differing only in case stay apart, as on Linux:
// unpacked on macOS's disk, xbase's /etc/X11/Xserver (a file) and /etc/X11/xserver/ (a directory)
// overwrote each other, and XFree86 lost its SecurityPolicy.
{ let got;
  try { const { buildTree, tarWrite, sha256 } = await import('../src/oasis-layers.js');
    const enc = new TextEncoder(), gz = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const tar = await gz(tarWrite([{ path: 'etc/X11/Xserver', type: 'file', mode: 0o644, data: enc.encode('XF86_NONE') },
      { path: 'etc/X11/xserver', type: 'dir', mode: 0o755 }, { path: 'etc/X11/xserver/SecurityPolicy', type: 'file', mode: 0o644, data: enc.encode('policy') },
      { path: 'bin/tool', type: 'file', mode: 0o755, data: enc.encode('#!') }, { path: 'bin/old', type: 'file', mode: 0o644, data: enc.encode('x') }]));
    const dataTar = await gz(tarWrite([{ path: './usr/lib/libz.so.1', type: 'file', mode: 0o644, data: enc.encode('elf') }]));
    const ar = (name, data) => { const h = enc.encode((name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n')); return [...h, ...data, ...(data.length & 1 ? [10] : [])]; };
    const deb = Uint8Array.from([...enc.encode('!<arch>\n'), ...ar('debian-binary', enc.encode('2.0\n')), ...ar('data.tar.gz', dataTar)]);
    const files = { 'https://archive.debian.org/x.tar.gz': tar, 'https://archive.debian.org/z.deb': deb, 'oasis/files/f': enc.encode('conf') };
    const layers = [{ tar: 'https://archive.debian.org/x.tar.gz' }, { deb: 'https://archive.debian.org/z.deb' }, { file: 'oasis/files/f', to: '/etc/f.conf' },
      { links: { '/usr/lib/libz.so': 'libz.so.1' } }, { mkdir: ['/tmp'] }, { run: 'rm /bin/old' }];
    let chain = ''; for (const l of layers) chain = await sha256(chain + JSON.stringify(l));
    const cached = { ['run-' + chain.slice(0, 16)]: tarWrite([{ path: 'built', type: 'file', mode: 0o644, data: enc.encode('made') }, { path: '.oasis-gone', type: 'file', data: enc.encode('["/bin/old"]') }]) };
    const tree = await buildTree({ layers }, { fetchBytes: async (s) => files[s], cache: { get: async (k) => cached[k] || null, put: async () => {} } });
    const h = tree.host(), dec = (p) => { const b = h.read(p); return b ? new TextDecoder().decode(b) : null; };
    got = [dec('/etc/X11/Xserver'), dec('/etc/X11/xserver/SecurityPolicy'), (h.lstat('/bin/tool').mode & 0o777).toString(8), dec('/usr/lib/libz.so.1'), dec('/etc/f.conf'),
      h.lstat('/usr/lib/libz.so').target, h.lstat('/tmp').type, dec('/built'), h.lstat('/bin/old'), h.list('/bin').join()].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('oasis in a page: tar, deb, file, links, mkdir, a run layer, case kept apart', got, 'XF86_NONE policy 755 elf conf libz.so.1 dir made  tool'); }
// The relay a page reads Debian's and idgames' archives through: only the hosts the images use, so it
// is no open proxy — and those hosts are every one oasis/images/ names.
{ let got;
  try { const { relayTarget, OASIS_HOSTS } = await import('../src/oasis-hosts.js'); const fsm = await import('fs'), pm = await import('path');
    const used = new Set(); const walk = (dir) => { for (const f of fsm.readdirSync(dir)) { const q = pm.join(dir, f); if (fsm.statSync(q).isDirectory()) walk(q); else if (f.endsWith('.json')) for (const m of fsm.readFileSync(q, 'utf8').matchAll(/"(https?:\/\/[^"]+)"/g)) used.add(m[1]); } };
    walk(new URL('../oasis/images', import.meta.url).pathname);
    const urls = JSON.parse(fsm.readFileSync(new URL('../examples/manifest.json', import.meta.url), 'utf8')).filter((e) => e.url).map((e) => e.url);   // examples fetched at their source
    got = [relayTarget('http://archive.debian.org/debian/x.deb') !== null, relayTarget('https://example.com/x'), relayTarget('https://archive.debian.org:8080/x'),
      relayTarget('https://u:p@busybox.net/x'), relayTarget('file:///etc/passwd'), [...used].every((u) => relayTarget(u) !== null),
      urls.every((u) => relayTarget(u) !== null), relayTarget('https://raw.githubusercontent.com/someone/else/main/x'),
      relayTarget('https://ftp.scene.org/elsewhere/x'), OASIS_HOSTS.every((h) => [...used, ...urls].some((u) => (u.split('://')[1] || '').startsWith(h)))].map(String).join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('oasis-fetch relays only the hosts the images and examples use, and every one of them', got, 'true null null null null true true null null true');
  // An archive.org item an entry names, where the archive redirects: a storage server of either
  // datacentre (ia...us, dn...ca), a file in a ZIP through view_archive.php; another item, or another
  // host with the item's path, refused.
  try { const { relayTarget } = await import('../src/oasis-hosts.js');
    got = ['https://ia600805.us.archive.org/7/items/official-jj-2/OfficialJJ2.zip', 'https://dn710401.ca.archive.org/0/items/official-jj-2/x.zip',
      'https://ia600805.us.archive.org/view_archive.php?archive=/7/items/official-jj-2/OfficialJJ2.zip&file=a', 'https://dn710401.ca.archive.org/0/items/someone-else/x.zip',
      'https://evil.example/0/items/official-jj-2/x.zip'].map((u) => relayTarget(u) !== null).join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('oasis-fetch: an archive.org item\'s storage servers, either datacentre', got, 'true true true false false'); }
// A `zip` layer with `files`: the members it names, each put where it says (an intro's dropper out of
// its party archive, oasis/images/linux/ribbon-2009.json); a member that is not there is said so.
{ let got;
  try { const { buildTree } = await import('../src/oasis-layers.js'), enc = new TextEncoder();
    const zipOf = (entries) => {                                    // stored entries, a central directory, its end
      const loc = [], cen = []; let off = 0;
      for (const [name, data] of entries) {
        const n = enc.encode(name), h = new Uint8Array(30 + n.length), d = new DataView(h.buffer);
        d.setUint32(0, 0x04034b50, true); d.setUint32(18, data.length, true); d.setUint32(22, data.length, true); d.setUint16(26, n.length, true); h.set(n, 30);
        const c = new Uint8Array(46 + n.length), e = new DataView(c.buffer);
        e.setUint32(0, 0x02014b50, true); e.setUint32(20, data.length, true); e.setUint32(24, data.length, true); e.setUint16(28, n.length, true); e.setUint32(42, off, true); c.set(n, 46);
        loc.push(h, data); cen.push(c); off += h.length + data.length;
      }
      const cs = cen.reduce((a, c) => a + c.length, 0), end = new Uint8Array(22), v = new DataView(end.buffer);
      v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true); v.setUint32(12, cs, true); v.setUint32(16, off, true);
      const out = new Uint8Array(off + cs + 22); let p = 0; for (const b of [...loc, ...cen, end]) { out.set(b, p); p += b.length; } return out;
    };
    const zip = zipOf([['party/linux/intro_640x480.i386', enc.encode('a=/tmp/I')], ['party/windows/intro.exe', enc.encode('MZ')]]);
    const io = { fetchBytes: async () => zip };
    const h = (await buildTree({ layers: [{ zip: 'https://ftp.scene.org/pub/x.zip', files: { 'party/linux/intro_640x480.i386': '/intro/intro.i386' } }] }, io)).host();
    let missing = 'none'; try { await buildTree({ layers: [{ zip: 'https://ftp.scene.org/pub/x.zip', files: { 'party/nope': '/x' } }] }, io); } catch (e) { missing = e.message; }
    got = [new TextDecoder().decode(h.read('/intro/intro.i386')), h.list('/').join(), missing].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('oasis in a page: a zip layer with files takes the members it names, to where it says', got, 'a=/tmp/I | intro | oasis: party/nope is not in https://ftp.scene.org/pub/x.zip'); }
// src/hle/prism-gl.js: the M PRISM's gl.js reads guest memory through -- u8 by index across a page
// boundary, slice and set, the DataView-like dv in every width (glCallLists reads GL_BYTE names with getInt8), cstr and intern.
{ let got;
  try { const { prismM } = await import('../src/hle/prism-gl.js');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from('7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000000000000100000000000000008004080080040858000000580000000500000000100000b801000000cd80'.match(/../g), (x) => parseInt(x, 16)), ['/w/T']);
    const M = prismM(lx, mc.mem), p = lx.alloc(0x3000), edge = ((p + 0x1000) & ~0xfff) - 2;
    M.u8.set([1, 2, 3, 4], edge); M.u8[edge + 8] = 5;
    M.mod.dv.setFloat64(edge, 1.5, true); const f64 = M.mod.dv.getFloat64(edge, true);
    M.mod.dv.setInt16(p, -2, true); M.mod.dv.setFloat32(p + 4, 0.25, true);
    const s = M.mod.intern([...new TextEncoder().encode('gl'), 0]);
    got = [Array.from(M.u8.slice(edge + 8, edge + 9)), f64, M.mod.dv.getInt16(p, true), M.mod.dv.getUint16(p, true), M.mod.dv.getFloat32(p + 4, true), M.cstr(s), M.rt.malloc(8) > 0, (M.mod.dv.setInt8(p + 8, -3), M.mod.dv.getInt8(p + 8))].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: PRISM\'s M over a Linux guest: u8 across a page, dv, cstr, intern, malloc', got, '5 1.5 -2 65534 0.25 gl true -3'); }
// MIRAGE's GL table to PRISM's gl.js: the framebuffer objects (Hartverdrahtet renders to a texture) and
// every immediate-mode spelling (Paradistance's glTexCoord3iv), the uniform vectors and matrices
// (kindernoiser's glUniform4fv), Waillee's glCreateShaderProgramv and D-Four's raster position, display
// lists, glGetFloatv and vertex arrays have their signatures here and their implementations there, and
// nothing here is missing there.
{ let got;
  try { const { prismM } = await import('../src/hle/prism-gl.js'), { gl } = await import('../src/hle/gl.js');
    const { installGL } = await import('../vendor/prism/src/env/gl.js');
    const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
    lx.load(Uint8Array.from('7f454c460101010000000000000000000200030001000000548004083400000000000000000000003400200001000000000000000100000000000000008004080080040858000000580000000500000000100000b801000000cd80'.match(/../g), (x) => parseInt(x, 16)), ['/w/T']);
    const M = prismM(lx, mc.mem); installGL(M);
    const fns = gl().fns, names = [];
    for (const ext of ['', 'EXT']) for (const f of ['GenFramebuffers', 'DeleteFramebuffers', 'BindFramebuffer', 'FramebufferTexture2D', 'CheckFramebufferStatus',
      'GenRenderbuffers', 'DeleteRenderbuffers', 'BindRenderbuffer', 'RenderbufferStorage', 'FramebufferRenderbuffer', 'GenerateMipmap', 'BlitFramebuffer']) names.push(`gl${f}${ext}`);
    names.push('glTexCoord3iv', 'glVertex4dv', 'glNormal3b', 'glMultiTexCoord2fARB', 'glMultiTexCoord4sv', 'glClientActiveTexture',
      'glUniform4fv', 'glUniform2iARB', 'glUniformMatrix4fv', 'glGetString', 'glGetIntegerv',
      'glCreateShaderProgramv', 'glRasterPos2f', 'glRasterPos4dv', 'glListBase', 'glCallLists', 'glGetFloatv', 'glEnableClientState', 'glVertexPointer', 'glDrawElements');
    got = [names.filter((n) => !fns[n] || !M.rt[n]).join(' ') || 'all',
      Object.keys(fns).filter((n) => !M.rt[n] && !n.startsWith('glX')).join(' ') || 'none'].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('hle: MIRAGE\'s GL table to PRISM\'s: framebuffer objects, every immediate-mode spelling, the uniform vectors; nothing missing', got, 'all | none'); }

// ---- OASIS: a `run` layer's removals hide the layers below (tools/oasis.mjs hostOver) ----------------
// A build that deletes a file must not see it come back from the layer under it: the run layer's
// .oasis-gone lists /x, so /x and /x/y are gone, /k stays, and the bookkeeping files are not listed.
{ let got; const fsm = await import('fs'), osm = await import('os'), pm = await import('path');
  const tmp = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'oasis-gone-'));
  try { const { hostOver } = await import('./oasis.mjs');
    const lo = pm.join(tmp, 'lo'), hi = pm.join(tmp, 'hi');
    fsm.mkdirSync(pm.join(lo, 'x'), { recursive: true }); fsm.writeFileSync(pm.join(lo, 'x', 'y'), 'y'); fsm.writeFileSync(pm.join(lo, 'k'), 'k');
    fsm.mkdirSync(hi); fsm.writeFileSync(pm.join(hi, '.oasis-gone'), JSON.stringify(['/x'])); fsm.writeFileSync(pm.join(hi, '.oasis-done'), '{}');
    const h = hostOver({ dirs: [lo, hi], files: new Map(), links: new Map(), mkdirs: new Set() });
    got = [h.list('/').sort().join(','), h.lstat('/x'), h.lstat('/x/y'), h.lstat('/k').type].join(' ');
  } catch (e) { got = e.message.slice(0, 80); }
  fsm.rmSync(tmp, { recursive: true, force: true });
  eq('oasis: a run layer\'s removals hide what the layers below have there', got, 'k   file'); }

// ---- OASIS: a DOS image's zip layer as the C: directory (tools/oasis.mjs dosDir) -----------------------
// `oasis run dos/<image> --terminal` threw "unzip is not a function or its return value is not
// iterable": dosDir iterated src/zip.js's unzip as if it were synchronous and read f.name / f.data,
// where it is async and gives { path, bytes }. A stored ZIP built here: GAME/RUN.BAT holds "hi".
{ let got; const fsm = await import('fs'), osm = await import('os'), pm = await import('path');
  const tmp = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'oasis-dos-'));
  try { const { dosDir } = await import('./oasis.mjs');
    const name = [...'game/run.bat'].map((c) => c.charCodeAt(0)), data = [104, 105];
    const le16 = (v) => [v & 255, v >> 8], le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    const crc = (() => { let c = ~0; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; })();
    const loc = [...le32(0x04034b50), ...le16(10), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(crc), ...le32(2), ...le32(2), ...le16(name.length), 0, 0, ...name, ...data];
    const cen = [...le32(0x02014b50), ...le16(20), ...le16(10), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(crc), ...le32(2), ...le32(2), ...le16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(0), ...name];
    const eocd = [...le32(0x06054b50), 0, 0, 0, 0, 1, 0, 1, 0, ...le32(cen.length), ...le32(loc.length), 0, 0];
    fsm.writeFileSync(pm.join(tmp, 'g.zip'), Uint8Array.from([...loc, ...cen, ...eocd]));
    const dir = await dosDir({ layers: [{ zip: pm.join(tmp, 'g.zip') }] });
    got = fsm.readFileSync(pm.join(dir, 'GAME', 'RUN.BAT'), 'utf8'); fsm.rmSync(dir, { recursive: true, force: true });
  } catch (e) { got = e.message.slice(0, 80); }
  fsm.rmSync(tmp, { recursive: true, force: true });
  eq('oasis: a DOS image\'s zip layer becomes the C: directory, names upper-cased', got, 'hi'); }

// oasis.html and the machines page read the images from oasis/index.json, which a static host can serve:
// it must say what oasis/images/ holds. `node tools/oasis.mjs index` writes it again.
{ const { indexText } = await import('./oasis.mjs'); const fsm = await import('fs');
  let got; try { got = fsm.readFileSync(new URL('../oasis/index.json', import.meta.url), 'utf8') === indexText(); } catch (e) { got = e.message.slice(0, 60); }
  eq('oasis: oasis/index.json lists oasis/images/ (node tools/oasis.mjs index)', got, true); }

// ---- in the browser a tick that comes while IF is clear is taken at the next STI -------------------------
// The browser delivers ticks off the wall clock (timerAuto off). One that came with IF clear was kept
// only until the next tick, and lost unless IF happened to be set just then: CWSDPMI runs with IF clear
// most of the time, and Liquid War's Allegro timer got none of its ticks. A PIC keeps the request.
{ const mc = new Machine({ memSize: 1 << 20 }); const cpu = mc.cpu; installBIOS(mc);
  mc.timerAuto = false;
  mc.mem.blit(0x2000, Uint8Array.from([0xfe, 0x06, 0x00, 0x30, 0xb0, 0x20, 0xe6, 0x20, 0xcf]));   // inc byte [3000h] / EOI / iret
  mc.setVector(8, 0x0200, 0);
  mc.mem.blit(0x1000, Uint8Array.from([0xfb, 0x90, 0x90, 0xeb, 0xfe]));   // sti / nop / nop / jmp $
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.setSeg(DS, 0); cpu.flags &= ~0x200;
  mc.tickTimer();                                                          // IF clear: latched
  mc.runSlice(20);
  eq('a tick that came with IF clear runs its handler once IF is set', mc.mem.r8(0x3000), 1); }

// ---- the PIT: a reprogrammed counter 0 raises IRQ 0 at the rate it was given ------------------------
// tools/pitrate.asm -dDIVIDER=11932 (100 Hz) counts INT 8 over 70 vertical retraces. DOSBox-X: 100
// (and 291 for 4096, 37 for 32768). MIRAGE took the reload for a number of cycles, right while pitBase
// was 65536 and 2.79x too fast since it is 182584: 278 here, DOOM's 104.6 Hz timer at 291.
{ const hex = (                                         // nasm -f bin -dDIVIDER=11932 tools/pitrate.asm, 195 bytes
    'b80835cd21891ead018c06af01b80825ba9601cd21fab034e643b89c2ee64088e0e640fbb94600bada03eca80875fbec' +
    'a80874fbe2f4fab034e64330c0e640e6401eb80825c516ad01cd211ffbb43c31c9bab101cd21721f89c3beb901a1ab01' +
    'e81900a1a901e81300b440b90a00bab901cd21b43ecd21b8004ccd2151b90400c1c00450240f04303c39760204078804' +
    '4658e2ec59c32eff06a90175052eff06ab0150b020e62058cf00000000000000004f55542e5458540030303030303030' +
    '300d0a');
  const out = runProbe(hex, 195, 'PITRATE.COM').vfs.readFile('\\OUT.TXT');
  const n = out ? parseInt(new TextDecoder().decode(out).trim(), 16) : -1;
  eq('PIT: counter 0 programmed for 100 Hz raises IRQ 0 about 100 times a second (DOSBox-X: 100)', n >= 97 && n <= 103 ? 'ok' : n, 'ok'); }

// Divisor 2128, 561 Hz: Keen 4's rate. DOSBox-X counts 560; MIRAGE's floor of pitBase>>4 gave 290, and
// Keen 4 ran at half speed (Wolf3D, ~700 Hz, at 0.4). The floor is pitBase>>6 now, about 1165 Hz.
{ const hex = (                                         // nasm -f bin -dDIVIDER=2128 tools/pitrate.asm, 195 bytes
    'b80835cd21891ead018c06af01b80825ba9601cd21fab034e643b85008e64088e0e640fbb94600bada03eca80875fbec' +
    'a80874fbe2f4fab034e64330c0e640e6401eb80825c516ad01cd211ffbb43c31c9bab101cd21721f89c3beb901a1ab01' +
    'e81900a1a901e81300b440b90a00bab901cd21b43ecd21b8004ccd2151b90400c1c00450240f04303c39760204078804' +
    '4658e2ec59c32eff06a90175052eff06ab0150b020e62058cf00000000000000004f55542e5458540030303030303030' +
    '300d0a');
  const out = runProbe(hex, 195, 'PITRATE.COM').vfs.readFile('\\OUT.TXT');
  const n = out ? parseInt(new TextDecoder().decode(out).trim(), 16) : -1;
  eq('PIT: 561 Hz asked, about 561 delivered (DOSBox-X: 560), not capped at 291', n >= 550 && n <= 570 ? 'ok' : n, 'ok'); }

// ---- the Sound Blaster plays its DMA at the rate it was set, then raises IRQ 7 (src/sb.js) ------
// tools/sbprobe.asm: 11111 bytes at 11111 Hz, single cycle. DOSBox-X: DSP 4.05, the IRQ after 12h
// ticks (one second), and at tick 9 the count reads 1737h, about half. MIRAGE plays from the first
// cycle and reads 15F3h — what 9 ticks of 11111 Hz leave of 11111 bytes; DOSBox-X starts ~30 ms late.
{ const hex = (                                         // nasm -f bin tools/sbprobe.asm, 395 bytes
    'b80f35cd21891e63028c066502b80f25ba1302cd21e421247fe621ba2602b001eeb96400ece2fd30c0eee80b01b0e1e8' +
    'fa00e80301a26702e8fd00a26802b0d1e8e900b040e8e400b0a6e8df00fab005e60ae60cb049e60b30c0e602e602b001' +
    'e683b8662be60388e0e603b001e60afbb014e8b700b066e8b200b02be8ad0031c08ec0268b1e6c0426a16c0429d8803e' +
    '6c0200752483f8097517833e6a02007510e60ce40388c4e40386c4a36a02b8090083f85b72d2b8ff00a269021ec51663' +
    '02b80f25cd211fba6e02e87800a06702e87700a06802e87100ba7302e86600a06902e86500ba7b02e85a00a06b02e859' +
    '00a06a02e85300ba8202e84800a06d02043088c2b402cd21ba8802e83700b8004ccd215052ba2e02ec2ec6066c02012e' +
    'c6066d0201b020e6205a58cf50ba2c02eca88075fb58eec3ba2e02eca88074fbba2a02ecc3b409cd21c350c0e804e803' +
    '0058240f04303c397602040788c2b402cd21c300000000000000000000004453503d24205449434b533d242048414c46' +
    '3d242041434b3d240d0a24');
  const { mc } = runProbe(hex, 395, 'SBPROBE.COM', 16 << 20, 40000);
  let line = ''; for (let r = 0; r < 25; r++) { let t = ''; for (let i = 0; i < 80; i++) { const ch = mc.mem.u8[0xb8000 + (r * 80 + i) * 2]; t += ch >= 32 ? String.fromCharCode(ch) : ' '; } if (t.includes('DSP=')) line = t.trim(); }
  eq('Sound Blaster: version 4.05, DMA consumed at the set rate, IRQ 7 after a second', line, 'DSP=0405 TICKS=12 HALF=15F3 ACK=1'); }

// ---- MIRAGE_RTC=hostdate: a headless machine starts on the host's date (src/rtc.js) -------------------
// The default is 1990-01-01 08:00, reproducible; Damn Small Linux's tar then called every file of its
// CD "in the future". With hostdate the clock starts at the host's instant and runs on guest time.
{ let got; const was = process.env.MIRAGE_RTC;
  try { process.env.MIRAGE_RTC = 'hostdate'; const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
    got = Math.abs(mc.rtc.now().getTime() - Date.now()) < 60000;
  } catch (e) { got = e.message; } finally { if (was === undefined) delete process.env.MIRAGE_RTC; else process.env.MIRAGE_RTC = was; }
  eq('RTC: MIRAGE_RTC=hostdate starts the clock at the host\'s date and time', got, true); }

// ---- the SB16's ASP/CSP commands take their arguments, and 0Fh answers (src/sb.js) --------------
// Windows 95's SB16 driver sends 04 FC, 04 FA, 0F 83 and waits for 0F's answer at its logo. Measured
// with tools/cspprobe.asm: QEMU -device sb16 and DOSBox-X both answer 00 to 0F 83 and nothing to 04;
// QEMU reads back what 0E wrote. Before: 04's argument FC ran as a command, 0F never answered.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
    const o = (p, v) => mc.ioWrite(p, 1, v), i = (p) => mc.ioRead(p, 1), dsp = (...b) => b.forEach((v) => o(0x22c, v));
    const rd = () => (i(0x22e) & 0x80 ? i(0x22a) : -1);
    o(0x226, 1); o(0x226, 0); rd();
    dsp(0x04, 0xfc); dsp(0x04, 0xfa); dsp(0x0f, 0x83); const r83 = rd();
    dsp(0x0e, 0x34, 0x56); dsp(0x0f, 0x34); const r34 = rd();
    dsp(0x05, 0x12, 0x34); dsp(0xe1); got = [r83, r34, rd(), rd(), rd()];
  } catch (e) { got = e.message; }
  eq('Sound Blaster ASP: 0F 83 answers 00, 0E/0F keep a register, 04/05 take their arguments', JSON.stringify(got), JSON.stringify([0, 0x56, 4, 5, -1])); }

// ---- the SB16 raises the IRQ its mixer register 80h selects (src/sb.js) ---------------------------
// Windows 95's driver writes 80h = 02h (IRQ 5); the card kept raising IRQ 7 and the startup sound
// waited for ever. DOSBox-X, QEMU and ALSA agree: 80h selects the IRQ, 81h the DMA channels.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
    const o = (p, v) => mc.ioWrite(p, 1, v), irq = () => { const m = mc.irqPendingMask & 0xa0; mc.irqPendingMask = 0; return m; };
    o(0x226, 1); o(0x226, 0); irq();
    o(0x22c, 0xf2); const before = irq();                                  // after a reset: IRQ 7
    o(0x224, 0x80); o(0x225, 0x02); o(0x22c, 0xf2); got = [before, irq()];
  } catch (e) { got = e.message; }
  eq('Sound Blaster: IRQ 7 after reset, IRQ 5 once mixer 80h selects it', JSON.stringify(got), JSON.stringify([0x80, 0x20])); }

// ---- VBE 4F03h in text mode answers the standard mode (tools/vbecur.asm) -----------------------------
// QEMU's SeaVGABIOS and DOSBox-X both give BX=0003h; MIRAGE gave 0, and GRUB 2 then asked 4F01h for
// mode 0 and stopped with "can't get mode info" (HelenOS).
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
    cpu.ax = 0x0003; mc.intHandlers[0x10](cpu, mc); cpu.ax = 0x4f03; cpu.bx = 0x1234; mc.intHandlers[0x10](cpu, mc);
    got = [cpu.ax & 0xffff, cpu.bx & 0xffff].map((x) => x.toString(16)).join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('VBE 4F03h in text mode: the standard mode 03h', got, '4f 3'); }

// ---- VBE 4F08h and an undefined VBE function (tools/vbefull.asm) --------------------------------------
// The real Cirrus GD5446 BIOS, DOSBox-X and SeaVGABIOS all answer 4F08h get with BH=6, and 4FFFh with
// AL != 4Fh (not supported). MIRAGE answered 014Fh to both.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu, i10 = () => mc.intHandlers[0x10](cpu, mc);
    cpu.ax = 0x4f08; cpu.bx = 0x0001; i10(); const dac = [cpu.ax & 0xffff, (cpu.bx >> 8) & 0xff];
    cpu.ax = 0x4fff; i10(); got = [...dac, cpu.ax & 0xff].map((x) => x.toString(16)).join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('VBE: 4F08h get answers a 6-bit DAC, 4FFFh is not a supported function', got, '4f 6 ff'); }

// ---- the Cirrus Logic CL-GD5446 (src/cirrus.js) as tools/cirprobe.asm sees it --------------------------
// The real CL-GD5436/46 BIOS 1.25 under QEMU -device cirrus-vga answers U 12 12 0F 12 1E 31 27,
// I B8 98 04 21 2D, D 00 A1 FF, C 2A 2A 3F 11 22 33, B 5A 5A 5A: the extensions unlocked by the BIOS,
// the 5446's part ID, the hidden DAC behind four reads of 3C6h, the cursor's colours apart from the
// palette, the A000 window banked in 4 KiB and 16 KiB units and in two halves. Then an 800x600x8
// mode as XFree86 3.3's clgd5446 driver programs it, which the renderer must draw at that size.
{ let got;
  try { const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc, { vga: 'cirrus' }); const cpu = mc.cpu;
    const o = (p, v) => mc.ioWrite(p, 1, v), i = (p) => mc.ioRead(p, 1), hx = (a) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const sr = (n, v) => { o(0x3c4, n); if (v !== undefined) o(0x3c5, v); return i(0x3c5); }, grw = (n, v) => { o(0x3ce, n); o(0x3cf, v); };
    const crw = (n, v) => { o(0x3d4, n); o(0x3d5, v); };
    cpu.ax = 0x0003; mc.intHandlers[0x10](cpu, mc);
    const U = [sr(6), sr(6, 0x12), sr(6, 0), sr(6, 0x12)]; o(0x3c4, 0x1e); U.push(i(0x3c4)); o(0x3ce, 0x31); U.push(i(0x3ce)); o(0x3d4, 0x27); U.push(i(0x3d4));
    const I = [i(0x3d5), sr(0x0f), sr(0x15), sr(0x17), sr(0x1f)];
    const dac4 = () => { i(0x3c8); for (let k = 0; k < 4; k++) i(0x3c6); };
    dac4(); const D = [i(0x3c6)]; dac4(); o(0x3c6, 0xa1); dac4(); D.push(i(0x3c6)); i(0x3c8); D.push(i(0x3c6)); dac4(); o(0x3c6, 0);
    const s12 = sr(0x12); sr(0x12, s12 | 2); o(0x3c8, 0x0f); o(0x3c9, 0x11); o(0x3c9, 0x22); o(0x3c9, 0x33); sr(0x12, s12 & ~2);
    o(0x3c7, 0x0f); const C = [i(0x3c9), i(0x3c9), i(0x3c9)]; sr(0x12, s12 | 2); o(0x3c7, 0x0f); C.push(i(0x3c9), i(0x3c9), i(0x3c9)); sr(0x12, s12);
    cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc); sr(7, sr(7) | 1);
    grw(0x0b, 0); grw(0x09, 0x10); mc.mem.w8(0xa0000, 0x5a); grw(0x09, 0x0f); const B = [mc.mem.r8(0xa1000)];
    grw(0x0b, 0x20); grw(0x09, 0x04); B.push(mc.mem.r8(0xa0000)); grw(0x0b, 0x01); grw(0x09, 0); grw(0x0a, 0x10); B.push(mc.mem.r8(0xa8000));
    // 800x600: 100 character clocks, 600 lines (VDE 257h: CR12 57h, CR07 bit 6 its bit 9), offset 100 (800 bytes).
    grw(0x0b, 0); crw(0x11, 0); crw(0x01, 0x63); crw(0x12, 0x57); crw(0x07, 0x50); crw(0x13, 100); crw(0x1b, 0x02);
    const v = mc.vbe;
    got = [hx(U), hx(I), hx(D), hx(C), hx(B), v ? `${v.width}x${v.height}x${v.bpp}/${v.pitch}` : 'no mode'].join(' | ');
  } catch (e) { got = e.message.slice(0, 80); }
  eq('Cirrus GD5446: unlock, ID, hidden DAC, cursor colours, banking, an 800x600 mode (the real BIOS\'s answers)', got,
    '12 12 0f 12 1e 31 27 | b8 98 04 21 2d | 00 a1 ff | 2a 2a 3f 11 22 33 | 5a 5a 5a | 800x600x8/800'); }

// The Cirrus's 16 KiB banks reach the whole 4 MB: XFree86 3.3 writes its hardware cursor's pattern to
// the last 16 KiB (bank FFh at 16 KiB, GRB bit 5). A bank number masked to 7 bits (as MIRAGE had it,
// QEMU has no mask) put it at 2 MB - 16 KiB, and the X pointer never showed.
{ let got;
  try { const mc = new Machine({ memSize: 16 << 20 }); installBIOS(mc, { vga: 'cirrus' }); const cpu = mc.cpu, o = (p, v) => mc.ioWrite(p, 1, v);
    cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);
    o(0x3c4, 7); o(0x3c5, mc.ioRead(0x3c5, 1) | 1); o(0x3ce, 0x0b); o(0x3cf, 0x20); o(0x3ce, 0x09); o(0x3cf, 0xff);
    mc.mem.w8(0xa0000 + 0x3f00, 0xa5);
    got = mc.mem.u8[(mc.vbeFbBase + mc.vbeFbBytes - 0x4000 + 0x3f00) >>> 0].toString(16);
  } catch (e) { got = e.message.slice(0, 60); }
  eq('Cirrus GD5446: a 16 KiB bank reaches the last 16 KiB of 4 MB (the hardware cursor)', got, 'a5'); }

// ---- 3DAh bit 0 is each line's horizontal blank too, not the vertical blank alone ---------------------
// VGA's documentation (display disabled: horizontal OR vertical blank), DOSBox (it models the line) and
// QEMU (it toggles the bit at every read) agree. SVGAlib waits for bit 0 before each DAC write: with the
// vertical blank alone a palette took a third of a second, DOOM's pickup flashes several seconds.
// Over one mode-13h frame, bit 0 rises once per line shown (400 of 449: in the vertical blank it stays up).
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
    cpu.ax = 0x0013; mc.intHandlers[0x10](cpu, mc);
    let rises = 0, prev = mc.ioRead(0x3da, 1) & 1; const start = cpu.cycles, period = Math.round((mc.pitBase || mc.pitReload) / 3.845);
    for (let k = 1; k <= 449 * 16; k++) { cpu.cycles = start + Math.floor(k * period / (449 * 16)); const b = mc.ioRead(0x3da, 1) & 1; if (b && !prev) rises++; prev = b; }
    got = rises >= 398 && rises <= 402 ? 'per line' : `${rises} rises`;
  } catch (e) { got = e.message.slice(0, 60); }
  eq('VGA 3DAh bit 0: the horizontal blank of every line', got, 'per line'); }

// ---- PIT channel 2 in mode 0: OUT (port 61h bit 5) low until the count runs out with GATE high ----------
// GRUB 2 calibrates its TSC this way. The free-running square wave answered high at once: GRUB
// measured no time, and the menu countdowns of HelenOS and Sortix stood still at 8 s. 8254 datasheet,
// QEMU's i8254.c: mode 0's OUT goes low with the control word and high at terminal count; a low GATE
// pauses the count. The count runs at counter 0's clock, pitBase cycles to 65536 ticks: 100 ticks are
// some 279 cycles (at one tick a cycle Linux 2.2 measured a 1193 kHz processor; see counter 0 below).
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const o = (p, v) => mc.ioWrite(p, 1, v), b5 = () => (mc.ioRead(0x61, 1) >> 5) & 1;
    const tick = mc.pitBase / 65536;
    mc.cpu.cycles = 1000;
    o(0x61, 0); o(0x43, 0xb0); o(0x42, 100); o(0x42, 0);        // GATE low, ch2 mode 0 LSB/MSB, count 100
    mc.cpu.cycles += 500; const paused = b5();                  // GATE low: no counting
    o(0x61, 1); const atStart = b5();
    mc.cpu.cycles += Math.round(60 * tick); const mid = b5();   // 60 ticks: not yet
    mc.cpu.cycles += Math.round(60 * tick); got = [paused, atStart, mid, b5()];
  } catch (e) { got = e.message.slice(0, 60); }
  eq('PIT channel 2, mode 0: OUT low, held by GATE, high at terminal count', JSON.stringify(got), '[0,0,0,1]'); }

// ---- PIT counter 0 read back in phase with the INT 8 it drives -----------------------------------------
// Linux 2.2's timer interrupt latches counter 0 at once and takes a count of LATCH or more for a lost
// configuration ("probable hardware bug: clock timer configuration lost - probably a VIA686a"). Counted
// from the write in exact ticks, the count drifted from the ticks, which are scheduled in whole cycles:
// after 2000 periods of LATCH = 11932 (100 Hz) it read some 40 ticks off, at LATCH or not yet reloaded,
// and BasicLinux's console filled with the message. Headless the count follows the schedule: just
// after a tick it is a little under LATCH, just before the next a little over 0.
{ let got;
  try { const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const o = (p, v) => mc.ioWrite(p, 1, v);
    const rd = () => { o(0x43, 0x00); const lo = mc.ioRead(0x40, 1); return lo | (mc.ioRead(0x40, 1) << 8); };
    o(0x43, 0x34); o(0x40, 11932 & 0xff); o(0x40, 11932 >> 8);
    for (let k = 0; k < 2000; k++) mc.nextTimerCycle += mc.pitReload;   // what serviceTimer does at each tick
    const tick = mc.nextTimerCycle - mc.pitReload;
    mc.cpu.cycles = tick + 30; const after = rd();
    mc.cpu.cycles = mc.nextTimerCycle - 1; const before = rd();
    got = [after >= 11932 - 12 && after <= 11931, before >= 1 && before <= 3].join(' ');
  } catch (e) { got = e.message.slice(0, 60); }
  eq('PIT counter 0: read back in phase with its INT 8 schedule (Linux 2.2\'s timer check)', got, 'true true'); }

// ---- an IRQ nobody claimed is acknowledged by the BIOS, as SeaBIOS's default handler does --------
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const cpu = mc.cpu;
  cpu.setSeg(CS, 0x100); cpu.eip = 0; cpu.setSeg(SS, 0x300); cpu.sp = 0x1000; cpu.flags |= 0x200;
  mc.mem.blit(0x1000, Uint8Array.from([0x90, 0x90, 0x90, 0xf4]));
  mc.raiseIRQ(3);
  let steps = 0; while (!cpu.halted && steps++ < 20) mc.runSlice(1);
  eq('an unclaimed IRQ 3 is not left in service at the PIC', mc.pic.master.isr & 0x08, 0); }

// ---- sound: the mixer turns the speaker and the Sound Blaster into samples (src/audio.js) ---------
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const audio = installAudio(mc);
  const sec = 18.2065 * mc.pitBase, o = (p, v) => mc.ioWrite(p, 1, v);
  const hz = (buf, rate) => { let zc = 0; for (let i = 2; i < buf.length; i += 2) if ((buf[i - 2] < 0) !== (buf[i] < 0)) zc++; return zc / 2 / (buf.length / 2 / rate); };
  audio.pull(44100);
  // PIT channel 2 at 1193182 / 2712 = 440 Hz, gate and data bit on, for one machine second.
  o(0x43, 0xb6); o(0x42, 2712 & 0xff); o(0x42, 2712 >> 8); o(0x61, 3);
  mc.cpu.cycles += Math.round(sec);
  const beep = audio.pull(44100);
  eq('the speaker plays channel 2 at its frequency (440 Hz, within 1%)', Math.abs(hz(beep, 44100) - 440) < 4.4, true);
  o(0x61, 0); mc.cpu.cycles += Math.round(sec / 10); audio.pull(44100);
  mc.cpu.cycles += Math.round(sec / 10);
  eq('...and is silent once the gate closes', Math.max(...audio.pull(44100).map(Math.abs)) < 0.01, true);
  // The card: 8-bit auto-init at 8000 Hz over a buffer of a 500 Hz square wave (8 samples up, 8 down).
  for (let i = 0; i < 4096; i++) mc.mem.u8[0x20000 + i] = (i & 8) ? 0xe0 : 0x20;
  o(0x0a, 5); o(0x0c, 0); o(0x0b, 0x59); o(0x02, 0); o(0x02, 0); o(0x83, 2); o(0x03, 0xff); o(0x03, 0x0f); o(0x0a, 1);
  const dsp = (v) => o(0x22c, v);
  o(0x226, 1); o(0x226, 0); dsp(0xd1); dsp(0x40); dsp(256 - 125); dsp(0x48); dsp(0xff); dsp(0x07); dsp(0x1c);
  const parts = [];                                   // a frame at a time, as the page pulls
  for (let i = 0; i < 100; i++) { mc.cpu.cycles += Math.round(sec / 100); mc.sbPoll(); const p = audio.pull(44100); if (i >= 50) parts.push(...p); }
  const card = Float32Array.from(parts);
  eq('the Sound Blaster\'s DMA comes out at its own frequency (500 Hz, within 2%)', Math.abs(hz(card, 44100) - 500) < 10, true);
  // The SB Pro's stereo bit is not an SB16's: with mixer 0Eh bit 1 set, the same bytes still play
  // mono, as DOSBox-X's SB16 plays them (Unreal's "SoundBlaster Pro stereo" recorded there: L = R).
  // As stereo they came out at half the pitch, alternate bytes to each side.
  o(0x224, 0x0e); o(0x225, 0x02); dsp(0x1c);
  const st = [];
  for (let i = 0; i < 60; i++) { mc.cpu.cycles += Math.round(sec / 100); mc.sbPoll(); const p = audio.pull(44100); if (i >= 20) st.push(...p); }
  eq('...and the SB Pro stereo bit leaves it mono, at the same pitch', Math.abs(hz(Float32Array.from(st), 44100) - 500) < 10, true);
  // An SB16 plays with its speaker off: D1h/D3h have no effect on it (DOSBox-X, QEMU). DOOM's DMX
  // starts its DMA without D1h, and its sound effects were silent.
  o(0x224, 0x0e); o(0x225, 0); o(0x226, 1); o(0x226, 0); dsp(0xd3); dsp(0x40); dsp(256 - 125); dsp(0x48); dsp(0xff); dsp(0x07); dsp(0x1c);
  const off = [];
  for (let i = 0; i < 60; i++) { mc.cpu.cycles += Math.round(sec / 100); mc.sbPoll(); const p = audio.pull(44100); if (i >= 20) off.push(...p); }
  eq('...and plays with the speaker off, as an SB16 does', Math.abs(hz(Float32Array.from(off), 44100) - 500) < 10, true); }

// ---- in the browser the card keeps up with a guest that runs ahead of the wall clock -----------------
// Unreal waits for the IRQ of a short test transfer in a counted loop. In the browser the card ran on
// the wall clock alone, the guest ran its loop faster than that, and Unreal answered "Selected sound
// card not found". The card's time is now the wall clock or the instructions run, whichever is
// further (as the OPL's timers): here the wall clock stands still while the CPU runs.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
  let wall = 1000; mc.wallClockMs = () => wall; mc.cyclesPerSecond = 50e6;
  const o = (p, v) => mc.ioWrite(p, 1, v), dsp = (v) => o(0x22c, v);
  o(0x0a, 5); o(0x0c, 0); o(0x0b, 0x49); o(0x02, 0); o(0x02, 0); o(0x83, 2); o(0x03, 15); o(0x03, 0); o(0x0a, 1);
  o(0x226, 1); o(0x226, 0); dsp(0x40); dsp(256 - 125); dsp(0x14); dsp(15); dsp(0);   // 16 bytes at 8000 Hz: 2 ms
  mc.cpu.cycles += 0.01 * 50e6;                                            // 10 ms of instructions, no wall time
  mc.sbPoll();
  eq('SB: the end-of-block IRQ comes when the guest has run long enough, wall clock or not', (mc.irqPendingMask >> 7) & 1, 1); }

// ---- the OPL3 plays FM (src/opl.js) ---------------------------------------------------------------
// tools/oplnotes.asm recorded here and on DOSBox-X's Nuked-OPL3 (tools/audio-compare.mjs): 16 sections
// each, same durations, pitch within the FFT's 3 Hz; Dune's AdLib music: loudness envelopes
// correlated 0.96 over 40 s. Here: one carrier, F-number 144h, block 4 = 245.8 Hz, at full level.
{ const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc); const audio = installAudio(mc);
  const sec = 18.2065 * mc.pitBase, w = (r, v) => { mc.ioWrite(0x388, 1, r); mc.ioWrite(0x389, 1, v); };
  const hz = (buf, rate) => { let zc = 0; for (let i = 2; i < buf.length; i += 2) if ((buf[i - 2] < 0) !== (buf[i] < 0)) zc++; return zc / 2 / (buf.length / 2 / rate); };
  audio.pull(44100);
  w(0x20, 0x21); w(0x23, 0x21); w(0x60, 0xf0); w(0x63, 0xf0); w(0x80, 0x0f); w(0x83, 0x0f);
  w(0x40, 0x3f); w(0x43, 0x00); w(0xc0, 0x01); w(0xa0, 0x44); w(0xb0, 0x31);
  const parts = [];
  for (let i = 0; i < 50; i++) { mc.cpu.cycles += Math.round(sec / 50); const p = audio.pull(44100); if (i >= 10) parts.push(...p); }
  const tone = Float32Array.from(parts);
  eq('the OPL plays F-number 144h, block 4 at 245.8 Hz (within 1%)', Math.abs(hz(tone, 44100) - 245.8) < 2.5, true);
  w(0xb0, 0x11);                                                   // key off: RR 15 releases at once
  for (let i = 0; i < 5; i++) { mc.cpu.cycles += Math.round(sec / 50); audio.pull(44100); }
  mc.cpu.cycles += Math.round(sec / 50);
  eq('...and falls silent after key-off', Math.max(...audio.pull(44100).map(Math.abs)) < 0.01, true); }

// ---- the OPL3, sample for sample: Nuked-OPL3's output for the same register writes ---------------
// tools/oplnotes.asm's 988509 samples (20 s: sine, FM, envelopes, feedback, all eight waveforms,
// vibrato and tremolo, the five drums, OPL3 stereo, four operators), its register writes logged at
// their sample positions by tools/opl-compare.mjs, rendered by Nuked-OPL3 outside the repository:
// SHA-256 of the int16 stereo stream below. Ours must be the same stream, to the bit.
{ const log = (
    '1,1,32;4,4,96;7,189,0;10924,32,33;10927,35,33;10929,96,240;10932,99,240;10935,128,15;10938,131,1' +
    '5;10941,64,63;10944,67,0;10946,192,1;10949,160,68;10952,176,49;60076,176,17;84652,64,20;84655,19' +
    '2,0;84658,176,49;133804,176,17;158380,64,63;158383,192,1;158386,35,1;158389,99,101;158391,131,5;' +
    '158394,176,49;256684,176,17;305836,32,33;305839,35,33;305842,96,240;305845,99,240;305848,128,15;' +
    '305851,131,15;305853,64,0;305856,67,0;305859,192,15;305862,176,49;354989,176,17;379565,64,63;379' +
    '567,192,1;379570,227,1;379573,176,49;404141,176,17;415063,227,2;415066,176,49;439639,176,17;4505' +
    '62,227,3;450565,176,49;475138,176,17;486061,227,0;486064,189,192;486067,35,225;486069,176,49;584' +
    '365,176,17;608941,189,0;608944,35,33;608947,48,1;608950,51,1;608952,80,16;608955,83,0;608958,112' +
    ',246;608961,115,246;608964,144,6;608967,147,6;608970,49,1;608972,50,1;608975,52,1;608978,53,1;60' +
    '8981,81,0;608984,82,0;608987,84,0;608989,85,0;608992,113,246;608995,114,246;608998,116,246;60900' +
    '1,117,246;609004,145,6;609006,146,6;609009,148,6;609012,149,6;609015,166,87;609018,182,9;609021,' +
    '167,87;609024,183,9;609026,168,87;609029,184,9;609032,198,0;609035,189,48;622595,189,32;622597,1' +
    '89,40;636248,189,32;636251,189,36;649901,189,32;649904,189,34;663555,189,32;663557,189,33;677208' +
    ',189,0;701784,261,1;701787,32,33;701790,35,33;701793,96,240;701795,99,240;701798,128,15;701801,1' +
    '31,15;701804,64,63;701807,67,0;701810,192,17;701812,176,49;726360,176,17;737283,192,33;737286,17' +
    '6,49;761859,176,17;772782,192,49;772784,227,4;772787,176,49;797358,176,17;808280,227,5;808283,17' +
    '6,49;832856,176,17;843779,227,6;843782,176,49;868355,176,17;879278,227,7;879281,176,49;903854,17' +
    '6,17;914777,227,0;914779,260,1;914782,40,33;914785,43,33;914788,72,24;914791,75,0;914794,104,240' +
    ';914796,107,240;914799,136,15;914802,139,15;914805,64,24;914808,192,48;914811,195,48;914813,176,' +
    '49;963929,176,17;988505,260,0;988508,261,0');
  const chip = createOPL(), out = [0, 0], buf = new Int16Array(988509 * 2);
  let pos = 0;
  const gen = (until) => { for (; pos < until; pos++) { chip.sample(out); buf[pos * 2] = out[0]; buf[pos * 2 + 1] = out[1]; } };
  for (const w of log.split(';')) { const [t, r, v] = w.split(',').map(Number); gen(t); chip.write(r >> 8, r & 0xff, v); }
  gen(988509);
  const sha = createHash('sha256').update(Buffer.from(buf.buffer)).digest('hex').slice(0, 16);
  eq('OPL3: tools/oplnotes.asm renders bit for bit as Nuked-OPL3 does', sha, '02264c24e625b726'); }

// The browser's clock (machine.wallClockMs): performance.now() moves in 100 µs steps there, and the
// machine runs part of each animation frame only. Unreal (Future Crew, 1992) times a frame with PIT
// counter 0 between two retraces, twice, and wants the two within 32 clocks, or it sets its timer to
// 65536 and runs at 18 frames a second; and its frames wait on retraces it must not miss. With a clock
// of 100 µs steps, 2 µs a port read (100 cycles at 50 M a second), and the machine idle 4 ms of each
// 16: the count a frame takes (17045 clocks, 1193182 / 70) twice alike within Unreal's 32 tries, and the
// 70 retraces of a second.
{ let got;
  const pn = performance.now;
  try {
    const mc = new Machine({ memSize: 1 << 20 }); installBIOS(mc);
    let us = 0;
    performance.now = () => Math.floor(us / 100) / 10;
    mc.timerAuto = false; mc.wallClockMs = () => performance.now();
    const rd = (p) => { us += 2; mc.cpu.cycles += 100; if (us % 16000 >= 12000) us += 4000; return mc.ioRead(p, 1); };
    const calib = () => {
      mc.ioWrite(0x43, 1, 0x30); mc.ioWrite(0x40, 1, 0xff); mc.ioWrite(0x40, 1, 0xff);
      while (rd(0x3da) & 8);
      while (!(rd(0x3da) & 8));
      mc.ioWrite(0x43, 1, 0); const lo = rd(0x40); return 0xffff - ((rd(0x40) << 8) | lo);
    };
    let a = 0, b = 0, tries = 0;                        // as Unreal: up to 32 tries
    do { a = calib(); b = calib(); } while (Math.abs(a - b) > 32 && ++tries < 32);
    let edges = 0, last = 0; const end = us + 1e6;
    while (us < end) { const v = rd(0x3da) & 8; if (v && !last) edges++; last = v; }
    got = [tries < 32, Math.abs(a - 17045) < 40 ? 'ok' : a, edges >= 70 && edges <= 71].join(' ');
  } catch (e) { got = e.message.slice(0, 80); } finally { performance.now = pn; }
  eq('browser clock: a frame timed by PIT counter 0 between retraces, and every retrace seen (Unreal)', got, 'true ok true'); }

console.log(`\nmirage recompiler: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
