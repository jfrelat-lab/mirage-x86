// x86-cases.mjs — instruction-semantics cases checked against Unicorn (QEMU's TCG core) as the
// oracle. This exists because our two other gates structurally cannot see this class:
// `conformance.js` is real-8088 silicon but 16-bit-only (no 0x66/0x67, no 386 forms), and
// `golden.js` hashes demo framebuffers and cannot say *why* something differs.
//
// The point is that the expected values are **observed, not derived**. Hand-deriving them from the
// manuals is exactly how wrong tests get written (a LOOP rel8 that lands mid-instruction, a DOS
// sequence that skips a required step) — the oracle removes that failure mode.
//
// Each case: 16-bit real mode, CS=0x1000 DS=ES=0x2000 SS=0x3000, code at CS:0, a 256-byte scratch
// area at DS:0 pre-filled with a fixed pattern. We run the bytes, then compare all GP registers,
// the arithmetic flags, and the scratch area.
//
// `undef` lists flags the architecture leaves UNDEFINED for that instruction, so Unicorn's choice
// isn't held against us (same discipline as conformance.js). CF=1 PF=4 AF=0x10 ZF=0x40 SF=0x80
// OF=0x800.

export const SCRATCH_PATTERN = (i) => (i * 7 + 3) & 0xff;   // deterministic, non-trivial

export const CASES = [
  // ---- 0x67: 32-bit effective addresses (regression lock for the Heaven bug) ----
  { n: '67 LEA AX,[EAX+EAX*4]', code: [0x67, 0x8d, 0x04, 0x80], regs: { eax: 3 } },
  { n: '67 LEA AX,[EAX+EBX*8+16]', code: [0x67, 0x8d, 0x44, 0xd8, 0x10], regs: { eax: 0x20, ebx: 4 } },
  { n: '67 MOV AX,[EDI+0x10]', code: [0x67, 0x8b, 0x47, 0x10], regs: { edi: 0x20 } },
  { n: '67 MOV AX,[disp32]', code: [0x67, 0x8b, 0x04, 0x25, 0x30, 0x00, 0x00, 0x00], regs: {} },
  { n: '67 MOV AX,[ECX*4+0x20]', code: [0x67, 0x8b, 0x04, 0x8d, 0x20, 0x00, 0x00, 0x00], regs: { ecx: 2 } },
  { n: '67 MOV [EBX+ESI*2],AX', code: [0x67, 0x89, 0x04, 0x73], regs: { ebx: 0x40, esi: 4, eax: 0xbeef } },
  { n: '67 MOV AL,[moffs32]', code: [0x67, 0xa0, 0x11, 0x00, 0x00, 0x00], regs: {} },
  { n: '67 [EBP] defaults to SS', code: [0x67, 0x8b, 0x45, 0x00], regs: { ebp: 0x10 } },

  // ---- 0x66: operand size ----
  { n: '66 CWDE', code: [0x66, 0x98], regs: { eax: 0x00008001 } },
  { n: '66 CWDE (positive)', code: [0x66, 0x98], regs: { eax: 0x00007fff } },
  { n: '66 CDQ (negative)', code: [0x66, 0x99], regs: { eax: 0x80000000, edx: 0x1234 } },
  { n: '66 CDQ (positive)', code: [0x66, 0x99], regs: { eax: 0x7fffffff, edx: 0x1234 } },
  { n: 'CBW still 16-bit', code: [0x98], regs: { eax: 0x000000ff } },
  { n: 'CWD still 16-bit', code: [0x99], regs: { eax: 0x00008000, edx: 0 } },
  { n: '66 PUSHAD/POPAD round-trip', code: [0x66, 0x60, 0x66, 0x61], regs: { eax: 0xdeadbeef, esi: 0x11223344 } },
  { n: '66 PUSHFD/POPFD round-trip', code: [0x66, 0x9c, 0x66, 0x9d], regs: {} },
  { n: '66 PUSH/POP imm32', code: [0x66, 0x68, 0x78, 0x56, 0x34, 0x12, 0x66, 0x58], regs: {} },
  { n: '66 MOVZX EAX,BL', code: [0x66, 0x0f, 0xb6, 0xc3], regs: { ebx: 0x000000f0 } },
  { n: '66 MOVSX EAX,BL', code: [0x66, 0x0f, 0xbe, 0xc3], regs: { ebx: 0x000000f0 } },
  { n: '66 ADD EAX,EBX (carry out)', code: [0x66, 0x01, 0xd8], regs: { eax: 0xffffffff, ebx: 2 } },
  { n: '66 SHL EAX,cl', code: [0x66, 0xd3, 0xe0], regs: { eax: 0x00012345, ecx: 20 } },
  { n: '66 IMUL EAX,EBX', code: [0x66, 0x0f, 0xaf, 0xc3], regs: { eax: 0x00010001, ebx: 0x00010001 } },

  // ---- BT/BTS/BTR/BTC on MEMORY: the offset is a full signed bit-string index, not masked ----
  // (audit T0.5 — expected to FAIL until fixed; that failure is the harness proving itself)
  { n: 'BT [mem],AX bit 20', code: [0x0f, 0xa3, 0x06, 0x00, 0x00], regs: { eax: 20 } },
  { n: 'BT [mem],AX bit 100', code: [0x0f, 0xa3, 0x06, 0x00, 0x00], regs: { eax: 100 } },
  { n: 'BTS [mem],AX bit 33', code: [0x0f, 0xab, 0x06, 0x00, 0x00], regs: { eax: 33 } },
  { n: 'BTR [mem],AX bit 40', code: [0x0f, 0xb3, 0x06, 0x00, 0x00], regs: { eax: 40 } },
  { n: 'BTC [mem],AX bit 17', code: [0x0f, 0xbb, 0x06, 0x00, 0x00], regs: { eax: 17 } },
  { n: 'BT reg,AX still masks', code: [0x0f, 0xa3, 0xc3], regs: { eax: 17, ebx: 0xffff } },

  // ---- BCD (DAA/DAS/AAA/AAS) is deliberately NOT tested here ----
  // Unicorn is the WRONG oracle for these: it models the later-CPU algorithm, while the 8086/8088
  // uses a different high-adjust threshold (the `0x9F`-when-AF form). Verified 2026-08-04:
  // `node tools/conformance.js 27 2f 37 3f` is 40000/40000 against real 8088 silicon, while
  // Unicorn disagrees with both on e.g. DAA AL=0x9A AF=1. TomHarte is the stronger oracle and
  // already covers this opcode group — adding it here would only enshrine QEMU's variant.

  // ---- string ops, XLAT, LOOP under 0x67 (ESI/EDI/ECX/EBX vs SI/DI/CX/BX) ----
  { n: '67 REP MOVSB', code: [0x67, 0xf3, 0xa4], regs: { esi: 0x10, edi: 0x60, ecx: 4 } },
  { n: 'REP MOVSB 16-bit', code: [0xf3, 0xa4], regs: { esi: 0x10, edi: 0x60, ecx: 4 } },
  { n: '67 REP STOSW', code: [0x67, 0xf3, 0x66, 0xab], regs: { edi: 0x60, ecx: 3, eax: 0xa5a5a5a5 } },
  { n: '67 LODSB', code: [0x67, 0xac], regs: { esi: 0x12 } },
  { n: '67 XLAT', code: [0x67, 0xd7], regs: { ebx: 0x30, eax: 5 } },
  { n: 'XLAT 16-bit', code: [0xd7], regs: { ebx: 0x30, eax: 5 } },
  { n: '67 LOOP decrements ECX', code: [0x67, 0xe2, 0x00], regs: { ecx: 0x00010000 } },
  { n: 'LOOP decrements CX', code: [0xe2, 0x00], regs: { ecx: 0x00010000 } },
  { n: 'REP SCASB finds a match', code: [0xf2, 0xae], regs: { edi: 0x10, ecx: 8, eax: SCRATCH_PATTERN(0x12) } },
  { n: 'REP CMPSB', code: [0xf3, 0xa6], regs: { esi: 0x10, edi: 0x10, ecx: 6 } },

  // ---- shifts / rotates (flag corners) ----
  { n: 'SHL AX,1 overflow', code: [0xd1, 0xe0], regs: { eax: 0x4000 } },
  { n: 'SAR AX,cl=5', code: [0xd3, 0xf8], regs: { eax: 0x8000, ecx: 5 } },
  { n: 'ROL AL,1', code: [0xd0, 0xc0], regs: { eax: 0x80 } },
  { n: 'RCR AX,cl=3 with CF', code: [0xd3, 0xd8], regs: { eax: 0x0001, ecx: 3 }, flags: 0x01, undef: 0x800 },  // OF undefined for multi-bit rotates
  { n: 'SHLD AX,BX,4', code: [0x0f, 0xa4, 0xd8, 0x04], regs: { eax: 0x1234, ebx: 0xabcd }, undef: 0x800 },
  { n: 'SHRD AX,BX,4', code: [0x0f, 0xac, 0xd8, 0x04], regs: { eax: 0x1234, ebx: 0xabcd }, undef: 0x800 },

  // ---- misc ----
  { n: 'BSF AX,BX', code: [0x0f, 0xbc, 0xc3], regs: { ebx: 0x0180 }, undef: 0x8d4 },
  { n: 'BSR AX,BX', code: [0x0f, 0xbd, 0xc3], regs: { ebx: 0x0180 }, undef: 0x8d4 },
  { n: 'BSF AX,0 sets ZF', code: [0x0f, 0xbc, 0xc3], regs: { ebx: 0 }, undef: 0x8d4 },
  { n: 'XCHG AX,[mem]', code: [0x87, 0x06, 0x00, 0x00], regs: { eax: 0x1234 } },
  { n: 'XADD [mem],AX', code: [0x0f, 0xc1, 0x06, 0x00, 0x00], regs: { eax: 0x1111 } },
  { n: 'CMPXCHG [mem],BX (match)', code: [0x0f, 0xb1, 0x1e, 0x00, 0x00], regs: { eax: 0x0a03, ebx: 0x7777 } },
  { n: 'CMPXCHG [mem],BX (no match)', code: [0x0f, 0xb1, 0x1e, 0x00, 0x00], regs: { eax: 0x9999, ebx: 0x7777 } },
  { n: 'NEG AX', code: [0xf7, 0xd8], regs: { eax: 0x0001 } },
  { n: 'NEG AX zero', code: [0xf7, 0xd8], regs: { eax: 0x0000 } },
  { n: 'MUL BX', code: [0xf7, 0xe3], regs: { eax: 0x1234, ebx: 0x1000 }, undef: 0x8d4 },
  { n: 'IMUL BX negative', code: [0xf7, 0xeb], regs: { eax: 0xffff, ebx: 0x0002 }, undef: 0x8d4 },
  { n: 'DIV BX', code: [0xf7, 0xf3], regs: { eax: 0x0100, edx: 0x0000, ebx: 0x0007 }, undef: 0x8d5 },
  { n: 'AAM', code: [0xd4, 0x0a], regs: { eax: 0x004b }, undef: 0x811 },
  { n: 'AAD', code: [0xd5, 0x0a], regs: { eax: 0x0409 }, undef: 0x811 },
];
