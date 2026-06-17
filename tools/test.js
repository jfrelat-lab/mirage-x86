// test.js — headless correctness harness for the x86→JS recompiler.
//
// Each case is hand-encoded machine code (so we test the decoder against known
// bytes, not against an assembler we also wrote) run to a HLT, then we assert on
// architectural state. Run:  node tools/test.js
//
// This is the proof the dynamic recompiler is correct without a browser, and it
// doubles as a deterministic regression net for the engine.

import { Machine } from '../src/machine.js';
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

// ----------------------------------------------------------------------------
console.log(`\nmirage recompiler: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
else console.log('all green ✓');
