// x86-de-cases.mjs — #DE (INT 0): WHICH divisions fault.
//
// Nothing in this suite reached the divide error before. The 8088 and 80386 vectors record one
// instruction's register/memory effect, so "this should have FAULTED" is outside what they express,
// and the overflow conditions are the easy ones to get wrong: a quotient that does not fit faults
// just as a zero divisor does, and IDIV has the asymmetric -32768 / -1 case that overflows because
// +32768 is not representable.
//
// ⚠️ Unicorn is an oracle for WHETHER these fault, not for what happens next: it raises the
// exception to the embedder (UC_ERR_EXCEPTION) instead of dispatching through the real-mode IVT. An
// earlier version of this file installed an IVT handler and read back the pushed frame; every
// faulting case came back as an oracle `error`, which the gate SKIPS — six cases that would have
// reported green without running. So `fault: 0` says "the oracle must have raised an exception here,
// and MIRAGE must raise INT 0", and the harness fails the case if either half is missing.
// What DOS then does with an unhandled INT 00h is a separate question with a separate oracle: a real
// DOS kernel (tools/dos-oracle.mjs) and DOSBox-X.

const d = (n, code, fault) => ({ n, code, regs: { ebx: 0 }, ...(fault !== undefined ? { fault } : {}) });

export const DE_CASES = [
  // ---- zero divisors ----
  d('div cx by zero', [0xb8, 0x01, 0x00, 0x31, 0xd2, 0x31, 0xc9, 0xf7, 0xf1], 0),
  d('div cl by zero', [0xb8, 0x01, 0x00, 0xb1, 0x00, 0xf6, 0xf1], 0),
  d('idiv cx by zero', [0xb8, 0x01, 0x00, 0x31, 0xd2, 0x31, 0xc9, 0xf7, 0xf9], 0),

  // ---- quotient does not fit: a fault too, and the one an implementation forgets ----
  d('div overflow: FFFF:FFFF / 1', [0xb8, 0xff, 0xff, 0xba, 0xff, 0xff, 0xb9, 0x01, 0x00, 0xf7, 0xf1], 0),
  d('div8 overflow: 0100h / 1', [0xb8, 0x00, 0x01, 0xb1, 0x01, 0xf6, 0xf1], 0),
  d('idiv overflow: -32768 / -1', [0xb8, 0x00, 0x80, 0xba, 0xff, 0xff, 0xb9, 0xff, 0xff, 0xf7, 0xf9], 0),
  d('idiv8 overflow: -128 / -1', [0xb8, 0x80, 0xff, 0xb1, 0xff, 0xf6, 0xf9], 0),

  // ---- the boundaries that must NOT fault, so the condition is not merely "always" ----
  d('div at the limit: FFFE:FFFF / FFFF', [0xb8, 0xff, 0xff, 0xba, 0xfe, 0xff, 0xb9, 0xff, 0xff, 0xf7, 0xf1]),
  d('div8 at the limit: 00FFh / 1', [0xb8, 0xff, 0x00, 0xb1, 0x01, 0xf6, 0xf1]),
  d('idiv at the limit: 32767 / 1', [0xb8, 0xff, 0x7f, 0x31, 0xd2, 0xb9, 0x01, 0x00, 0xf7, 0xf9]),
  d('idiv -32768 / 1', [0xb8, 0x00, 0x80, 0xba, 0xff, 0xff, 0xb9, 0x01, 0x00, 0xf7, 0xf9]),
  d('plain div 10 / 2', [0xb8, 0x0a, 0x00, 0x31, 0xd2, 0xb9, 0x02, 0x00, 0xf7, 0xf1]),
  d('plain idiv -10 / 3', [0xb8, 0xf6, 0xff, 0xba, 0xff, 0xff, 0xb9, 0x03, 0x00, 0xf7, 0xf9]),
];
