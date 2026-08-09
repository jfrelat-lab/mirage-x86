// x86-gen.mjs — GENERATE instruction cases instead of writing them by hand, and let Unicorn say
// what they should do.
//
// tools/x86-cases.mjs holds 86 cases I wrote, which means it tests what I thought of. The 0x67 bug
// that derailed Heaven for a week lived in a corner nobody thought of. The generator's whole point
// is that it does not think: it enumerates the ModRM/SIB/prefix grid mechanically and asks the
// oracle, so coverage stops depending on my imagination.
//
// Deterministic by construction — a seeded xorshift, no Math.random — so the same seed always
// yields the same cases and the committed expectations stay meaningful. Change the seed or the
// tables and you must re-capture.
//
//   node tools/test-x86-uc.mjs --capture     # regenerates expectations for hand + generated cases
//   GEN_SEED=12345 GEN_COUNT=800 node tools/test-x86-uc.mjs --capture
//
// Every generated case must be SAFE to run in the harness: it may not fault, may not touch memory
// outside the 256-byte scratch area, and may not depend on anything the comparison cannot see. The
// address-register clamping below is what buys that — see `clampAddrRegs`.

const GEN_SEED = Number(process.env.GEN_SEED || 0x1234abcd) >>> 0;
// 2000 by default. The gate only REPLAYS the committed expectations, so a bigger set costs almost
// nothing to run; only a refresh needs Python + Unicorn. Two other seeds at this size were tried and
// also passed clean, which is the evidence that the grid is genuinely covered rather than luckily so.
const GEN_COUNT = Number(process.env.GEN_COUNT || 2000);

/** xorshift32 — small, deterministic, good enough to spread a case set. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

// Opcode templates. `enc` is a LIST of alternative opcode byte-sequences — one is chosen per case —
// so a two-byte 0F opcode and a choice between the r/m,r and r,r/m directions do not get confused
// with each other (they did, and the generator emitted both bytes of a pair as one instruction).
// `undef` carries the architecturally-undefined flags forward, as in the hand-written cases.
const TEMPLATES = [
  // ALU r/m,r and r,r/m across the grid
  { n: 'ADD', enc: [[0x01], [0x03]], modrm: true },
  { n: 'OR',  enc: [[0x09], [0x0b]], modrm: true },
  { n: 'ADC', enc: [[0x11], [0x13]], modrm: true },
  { n: 'SBB', enc: [[0x19], [0x1b]], modrm: true },
  { n: 'AND', enc: [[0x21], [0x23]], modrm: true },
  { n: 'SUB', enc: [[0x29], [0x2b]], modrm: true },
  { n: 'XOR', enc: [[0x31], [0x33]], modrm: true },
  { n: 'CMP', enc: [[0x39], [0x3b]], modrm: true },
  { n: 'TEST', enc: [[0x85]], modrm: true },
  { n: 'MOV', enc: [[0x89], [0x8b]], modrm: true },
  { n: 'XCHG', enc: [[0x87]], modrm: true },
  { n: 'LEA', enc: [[0x8d]], modrm: true, memOnly: true },
  // group 1 with imm8 (sign-extended) and imm16/32
  { n: 'GRP1-imm8', enc: [[0x83]], modrm: true, imm: 1, regField: [0, 1, 2, 3, 4, 5, 6, 7] },
  { n: 'GRP1-imm', enc: [[0x81]], modrm: true, immW: true, regField: [0, 1, 2, 3, 4, 5, 6, 7] },
  // Shifts/rotates. OF is defined only for a count of 1 and AF is always undefined, so the
  // by-immediate form carries both — testing an undefined flag would be testing Unicorn's choice.
  { n: 'SHIFT-1', enc: [[0xd1]], modrm: true, regField: [0, 1, 2, 3, 4, 5, 7], undef: 0x10 },
  { n: 'SHIFT-imm', enc: [[0xc1]], modrm: true, imm: 1, regField: [0, 1, 2, 3, 4, 5, 7], undef: 0x810 },
  // 0F: the 386 additions — this is the family with no silicon oracle at all
  { n: 'MOVZX', enc: [[0x0f, 0xb7]], modrm: true },
  { n: 'MOVSX', enc: [[0x0f, 0xbf]], modrm: true },
  { n: 'BSF', enc: [[0x0f, 0xbc]], modrm: true, undef: 0x8d5 & ~0x40 },
  { n: 'BSR', enc: [[0x0f, 0xbd]], modrm: true, undef: 0x8d5 & ~0x40 },
  { n: 'BT',  enc: [[0x0f, 0xa3]], modrm: true, undef: 0x8d5 & ~0x01 },
  { n: 'BTS', enc: [[0x0f, 0xab]], modrm: true, undef: 0x8d5 & ~0x01 },
  { n: 'BTR', enc: [[0x0f, 0xb3]], modrm: true, undef: 0x8d5 & ~0x01 },
  { n: 'BTC', enc: [[0x0f, 0xbb]], modrm: true, undef: 0x8d5 & ~0x01 },
  { n: 'IMUL2', enc: [[0x0f, 0xaf]], modrm: true, undef: 0x8d5 & ~0x801 },
  // SHLD/SHRD: the result is architecturally UNDEFINED when the count exceeds the operand size, so
  // the count is constrained to 1..size-1 rather than compared against whatever Unicorn happens to
  // do. Without the constraint 16 of the first 686 generated cases "failed" on exactly that.
  { n: 'SHLD', enc: [[0x0f, 0xa4]], modrm: true, imm: 1, countLtSize: true, undef: 0x810 },
  { n: 'SHRD', enc: [[0x0f, 0xac]], modrm: true, imm: 1, countLtSize: true, undef: 0x810 },
  { n: 'XADD', enc: [[0x0f, 0xc1]], modrm: true },
  { n: 'CMPXCHG', enc: [[0x0f, 0xb1]], modrm: true },
  { n: 'SETcc', enc: [[0x0f, 0x90]], modrm: true, ccRange: 16, byteOp: true },
];

const SCRATCH = 256;
const SAFE_ADDR = 0xc0;      // keep every effective address below this, inside the scratch area

/**
 * Build a ModRM (and SIB/disp) for the requested address size, plus the list of registers used as
 * address components. Those get clamped so the effective address stays inside the scratch area —
 * without that a generated case would read or write outside it and the comparison would be noise.
 */
function encodeModRM(r, reg, addr32, wantMem) {
  const bytes = [];
  const addrRegs = [];
  if (!wantMem) {                                    // mod=11, register operand
    bytes.push(0xc0 | (reg << 3) | (r() & 7));
    return { bytes, addrRegs };
  }
  if (!addr32) {
    const rm = r() % 8;
    if (rm === 6) {                                  // disp16 only — no register involved
      const d = r() % SAFE_ADDR;
      bytes.push(0x06 | (reg << 3), d & 0xff, (d >> 8) & 0xff);
      return { bytes, addrRegs };
    }
    // [BX+SI] [BX+DI] [BP+SI] [BP+DI] [SI] [DI] — with a small disp8
    const d = r() % 0x20;
    bytes.push(0x40 | (reg << 3) | rm, d);
    for (const g of [['bx', 'si'], ['bx', 'di'], ['bp', 'si'], ['bp', 'di'], ['si'], ['di'], [], ['bx']][rm]) addrRegs.push(g);
    return { bytes, addrRegs };
  }
  // 32-bit addressing: exercise the SIB grid, which is where the 0x67 bug lived
  const useSIB = (r() % 3) !== 0;
  const d = r() % 0x40;
  if (!useSIB) {
    const rm = [0, 1, 2, 3, 6, 7][r() % 6];          // avoid rm=4 (SIB) and rm=5 (disp32 w/ no base)
    bytes.push(0x40 | (reg << 3) | rm, d);
    addrRegs.push(REG32[rm]);
    return { bytes, addrRegs };
  }
  const base = [0, 1, 2, 3, 6, 7][r() % 6];          // avoid ESP as base (it is the SIB escape)
  const index = [0, 1, 2, 3, 5, 6, 7][r() % 7];      // 4 = "no index"
  const scale = r() % 4;
  bytes.push(0x44 | (reg << 3), (scale << 6) | (index << 3) | base, d);
  addrRegs.push(REG32[base], REG32[index]);
  return { bytes, addrRegs };
}

/** Register values: interesting bit patterns, not uniform noise — corners are where bugs live. */
const INTERESTING = [0, 1, 2, 7, 0x0f, 0x10, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff,
                     0x1234, 0xabcd, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0xdeadbeef];

export function generateCases(seed = GEN_SEED, count = GEN_COUNT) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = TEMPLATES[r() % TEMPLATES.length];
    const op32 = (r() % 2) === 0;                     // 0x66 -> 32-bit operands
    const addr32 = (r() % 2) === 0;                   // 0x67 -> 32-bit addressing
    const wantMem = t.memOnly ? true : (r() % 2) === 0;

    const code = [];
    if (op32 && !t.byteOp) code.push(0x66);
    if (addr32) code.push(0x67);
    const ops = t.enc[r() % t.enc.length].slice();
    if (t.ccRange) ops[ops.length - 1] += r() % t.ccRange;   // SETcc: pick a condition
    code.push(...ops);

    const reg = t.regField ? t.regField[r() % t.regField.length] : (r() % 8);
    const { bytes, addrRegs } = encodeModRM(r, reg, addr32, wantMem);
    code.push(...bytes);
    if (t.imm) code.push(t.countLtSize ? 1 + (r() % (op32 ? 31 : 15)) : (r() % 40));
    if (t.immW) { const v = r(); code.push(v & 0xff, (v >> 8) & 0xff, ...(op32 ? [(v >> 16) & 0xff, (v >> 24) & 0xff] : [])); }

    // Register seed values, then clamp anything used to form an address.
    const regs = {};
    for (const name of REG32) regs[name] = INTERESTING[r() % INTERESTING.length];
    regs.esp = 0x1000;                                // the harness needs a usable stack
    clampAddrRegs(regs, addrRegs, r);

    out.push({
      n: `gen#${i} ${t.n}${op32 && !t.byteOp ? ' o32' : ''}${addr32 ? ' a32' : ''}${wantMem ? ' mem' : ' reg'}`,
      code, regs, ...(t.undef ? { undef: t.undef } : {}),
    });
  }
  return out;
}

/** Force every register that takes part in an effective address into a small, safe value. */
function clampAddrRegs(regs, addrRegs, r) {
  for (const g of addrRegs.flat()) {
    if (!g) continue;
    const key = g.length === 2 ? 'e' + g : g;         // 'bx' -> 'ebx'
    regs[key] = r() % 0x20;                           // scaled by at most 8 -> still inside scratch
  }
}
