// x86c.mjs — a static recompiler from 16-bit real-mode x86 to C, for PRISM to compile (ROADMAP:
// "Static recompilation, x86 to C, compiled by PRISM"). It translates what MIRAGE's DOS intros use
// and REFUSES BY NAME everything it does not model, rather than guessing.
//
// The shape of the output:
//   * the machine state is C locals of rc_main(): the eight 16-bit registers as ints kept in 0..0xFFFF,
//     the segment registers with their bases (seg << 4) beside them, the six arithmetic flags as 0/1
//     ints, and the x87 stack as eight doubles named by PHYSICAL register -- the translator proves the
//     stack top is the same at every instruction on every path (it refuses otherwise), so ST(i) is a
//     fixed local and no top-of-stack arithmetic survives into the C;
//   * guest memory is MEM[seg*16+off]. Under PRISM that is the PC's first megabyte of its DJGPP image
//     itself (the low megabyte is reserved, __djgpp_conventional_base is 0, src/env/go32.js), so mode
//     13h's A000:0000 is PRISM's own 0xA0000 -- a flat array, not PRISM's 16-bit far-pointer model,
//     because the guest's segments are values in registers, not C pointer types;
//   * the program is a graph of NODES, an instruction in a call context: a near CALL is INLINED (its
//     callee's instructions are new nodes under a context naming the return address), so a RET is an
//     ordinary edge back to the instruction after its CALL, checked at run time against the word it
//     pops. Recursion, and a CALL or JMP through a register or memory, are refused;
//   * the blocks are emitted STRUCTURED (for(;;) loops, if/else joined at the post-dominator, no label
//     -- emitStructured), because a label makes PRISM emit its goto state machine (a switch dispatch
//     per jump: tube 1.7x slower); gotos remain the fallback for a graph that does not structure;
//   * the flags are computed exactly as the SDM (and MIRAGE's recompiler) defines them, but only the
//     ones some later instruction can read: a backward liveness pass over the node graph drops every
//     dead flag, and refuses if an UNDEFINED flag (OF after a multi-bit shift, SF after MUL...) could
//     be read, since then the C would have to copy MIRAGE's choice for it;
//   * the hardware goes through a platform layer (tools/recomp/rc.h): MEM, rc_inp, rc_out, rc_bios,
//     rc_sync. The same generated C builds for PRISM and natively, so a difference between them is
//     PRISM's, not the translator's;
//   * every frame point (a read of port 60h, an INT 16h, or -- in a program that never polls -- the
//     head of its main loop) checks that the code it translated is still there: the bytes of every
//     instruction that can run more than once (a block on a cycle) are compared with the image. A
//     program that rewrites them stops with the addresses (exit 4), never runs stale code silently.
//     An instruction IMMEDIATE the program rewrites on purpose (a variable kept in the code, a 256-byte
//     intro's favourite trick) can be declared volatile (`volatile` option): it is then read from
//     guest memory each time, and the guard leaves it out.
//
//   * where the static form fails it falls back, saying so: an x87 stack top that differs between
//     paths (puls pushes in a loop whose count is data) is kept in F[(ft+i)&7] instead (fpuDyn); a
//     shift by CL whose zero count would pass an undefined flag through is taken as defining them,
//     and a zero count that would then matter stops the program (optimisticShift); a program whose
//     code is not in its file is translated from a SNAPSHOT of MIRAGE's machine before its first
//     frame point (`snapshot`, tools/recomp/oracle.mjs), its RETs into callers from before the
//     snapshot checked against the return addresses on that stack.
//
// What it assumes and checks: code and data may overlap (the image is loaded into guest memory as
// well as translated); DF is followed statically (POPF of DF=1 stops the program); 16-bit address
// size (67h is refused); a 66h operand is a subset (mov, ALU, shifts, mul/div, string moves) on a
// second local per register for the upper half; no interrupt is delivered (a program that installs
// a handler is refused, tools/recomp/common.mjs).

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800, ALL = CF | PF | AF | ZF | SF | OF;
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8N = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const SREG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];
const ALUN = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const hex = (n, w = 4) => n.toString(16).padStart(w, '0');
const fmtI = (v) => (typeof v === 'number' ? `0x${v.toString(16)}` : 'imm@code');

export class Refused extends Error {}
const refuse = (ip, what) => { throw new Refused(`${hex(ip)}: ${what}`); };

/**
 * Decode helpers for one instruction at `ip0` of the code segment image `m` (a 64 KB Uint8Array).
 * `vol` is the set of code offsets declared volatile: an immediate read there becomes a C expression
 * reading guest memory; any other volatile byte (an opcode, a ModRM, a displacement, a branch
 * offset) is refused.
 */
function decode(m, ip0, vol) {
  let ip = ip0;
  const fixed = () => { if (vol && vol.has(ip & 0xffff)) refuse(ip0, `self-modifying code: the byte at ${hex(ip & 0xffff)} is rewritten and is not an immediate`); };
  const b8 = () => { fixed(); return m[ip++ & 0xffff]; };
  const s8 = () => (b8() << 24) >> 24;
  const w16 = () => b8() | (b8() << 8);
  // Immediates: a number, or (volatile) a C expression of the guest's own byte or word.
  const isVol = (a, n) => vol && (vol.has(a & 0xffff) || (n === 2 && vol.has((a + 1) & 0xffff)));
  const i8 = () => { const a = ip & 0xffff; if (isVol(a, 1)) { ip++; return `MEM[csb+${a}]`; } return b8(); };
  const si8 = () => { const a = ip & 0xffff; if (isVol(a, 1)) { ip++; return `(((MEM[csb+${a}]<<24)>>24)&0xffff)`; } return s8() & 0xffff; };
  const i16 = () => { const a = ip & 0xffff; if (isVol(a, 2)) { ip += 2; return `RW(csb+${a})`; } return w16(); };
  let seg = null, rep = null, o32 = false;
  let op;
  for (;;) {
    op = b8();
    if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { seg = (op >> 3) & 3; continue; }
    if (op === 0x64 || op === 0x65) { seg = op - 0x60; continue; }
    if (op === 0xf3 || op === 0xf2) { rep = op; continue; }
    if (op === 0x66) { o32 = true; continue; }
    if (op === 0x67) refuse(ip0, '32-bit address size prefix');
    if (op === 0xf0) refuse(ip0, 'LOCK');
    break;
  }
  const I = { ip: ip0, op, seg, rep, o32 };
  I.w16 = () => w16();
  const i32 = () => { const a = ip & 0xffff; if (isVol(a, 2) || isVol(a + 2, 2)) refuse(ip0, 'a volatile 32-bit immediate'); return (w16() | (w16() << 16)) >>> 0; };
  I.i32 = i32;
  // ModRM, 16-bit addressing: the effective address as a C expression and its default segment.
  const modrm = () => {
    const x = b8(), mod = x >> 6, reg = (x >> 3) & 7, rm = x & 7;
    if (mod === 3) return { reg, rm, isReg: true };
    const BASE = ['bx+si', 'bx+di', 'bp+si', 'bp+di', 'si', 'di', 'bp', 'bx'];
    let ea, dseg = (rm === 2 || rm === 3 || rm === 6) ? 2 : 3;
    let disp = 0;
    if (mod === 0 && rm === 6) { ea = null; disp = w16(); dseg = 3; }
    else { ea = BASE[rm]; if (mod === 1) disp = s8(); else if (mod === 2) disp = (w16() << 16) >> 16; }
    const s = seg ?? dseg;
    const e = ea === null ? `${disp}` : disp ? `((${ea}${disp < 0 ? '-' : '+'}${Math.abs(disp)})&0xffff)` : (ea.includes('+') ? `((${ea})&0xffff)` : ea);
    // The same address plus k (the high word of a far pointer, the next byte): wraps in the segment.
    const plus = (k) => (ea === null ? `${(disp + k) & 0xffff}` : `((${ea}${disp + k < 0 ? '-' : '+'}${Math.abs(disp + k)})&0xffff)`);
    return { reg, rm, isReg: false, seg: s, ea: e, plus, text: `[${SREG[s]}:${ea ?? ''}${disp ? (disp < 0 ? '-' : '+') + Math.abs(disp).toString(16) : ''}]` };
  };
  return { I, end: () => ip, b8, s8, w16, i8, si8, i16, i32: I.i32, modrm };
}

// ---------------------------------------------------------------------------------------------
// C fragments for operands
const r8get = (r) => (r < 4 ? `(${R16[r]}&0xff)` : `(${R16[r - 4]}>>8)`);
const r8set = (r, v) => (r < 4 ? `${R16[r]}=(${R16[r]}&0xff00)|(${v});` : `${R16[r - 4]}=(${R16[r - 4]}&0xff)|((${v})<<8);`);
const segb = (s) => `${SREG[s]}b`;
const sx8 = (e) => `((${e})<<24>>24)`;
const sx16 = (e) => `((${e})<<16>>16)`;

/** An operand: { get, set(v), pre } where `pre` computes the linear address into `ta` once. */
function operand(mr, w) {
  if (mr.isReg) {
    if (w === 8) return { pre: '', get: r8get(mr.rm), set: (v) => r8set(mr.rm, v), text: R8N[mr.rm] };
    return { pre: '', get: R16[mr.rm], set: (v) => `${R16[mr.rm]}=${v};`, text: R16[mr.rm] };
  }
  const pre = `ta=${segb(mr.seg)}+${mr.ea};`;
  if (w === 8) return { pre, get: 'MEM[ta]', set: (v) => `MEM[ta]=${v};`, text: `byte ${mr.text}`, mem: true };
  return { pre, get: 'RW(ta)', set: (v) => `RW(ta)=${v};`, text: `word ${mr.text}`, mem: true };
}
const regOp = (r, w) => operand({ isReg: true, rm: r }, w);
const immOp = (v) => ({ pre: '', get: `${v}`, set: null, text: fmtI(v), imm: v });
const exprOp = (e) => ({ pre: '', get: e, set: null, text: e });

/** SZP from a masked result held in `res`. */
function szp(res, w, live) {
  let c = '';
  if (live & ZF) c += `fZ=(${res}==0);`;
  if (live & SF) c += `fS=${res}>>${w - 1};`;
  if (live & PF) c += `fP=PAR[${res}&0xff];`;
  return c;
}

/** The ALU group: add or adc sbb and sub xor cmp (index = the ModRM /reg or opcode>>3), and test. */
function alu(kind, w, d, s, live) {
  const M = w === 8 ? 0xff : 0xffff, top = w - 1;
  const store = kind !== 7 && kind !== 8;
  const opch = { 1: '|', 4: '&', 6: '^', 8: '&' }[kind];
  let c = d.pre + (s.pre && s.pre !== d.pre ? s.pre : '');
  if (s.mem && d.mem) throw new Error('two memory operands');
  if (opch) {
    if (!(live & (ZF | SF | PF))) {
      if (store) c += d.set(`${d.get}${opch}${s.get}`);
      if (live & CF) c += 'fC=0;';
      if (live & OF) c += 'fO=0;';
      return { c, def: CF | OF | ZF | SF | PF, undef: AF };
    }
    c += `t2=${d.get}${opch}${s.get};`;
    if (live & CF) c += 'fC=0;';
    if (live & OF) c += 'fO=0;';
    c += szp('t2', w, live);
    if (store) c += d.set('t2');
    return { c, def: CF | OF | ZF | SF | PF, undef: AF, use: 0 };
  }
  const add = kind === 0 || kind === 2;
  const cin = kind === 2 || kind === 3;
  const use = cin ? CF : 0;
  if (!(live & ALL)) {
    if (store) c += d.set(`(${d.get}${add ? '+' : '-'}${s.get}${cin ? (add ? '+fC' : '-fC') : ''})&${M}`);
    return { c, def: ALL, undef: 0, use };
  }
  c += `t0=${d.get};t1=${s.get};t2=t0${add ? '+' : '-'}t1${cin ? (add ? '+fC' : '-fC') : ''};`;
  if (live & CF) c += add ? `fC=t2>>${w};` : 'fC=(t2<0);';
  c += `t2&=${M};`;
  if (live & OF) c += add ? `fO=((t0^t2)&(t1^t2))>>${top}&1;` : `fO=((t0^t1)&(t0^t2))>>${top}&1;`;
  if (live & AF) c += 'fA=((t0^t1^t2)>>4)&1;';
  c += szp('t2', w, live);
  if (store) c += d.set('t2');
  return { c, def: ALL, undef: 0, use };
}

/** Shifts and rotates: kind = /reg (rol ror rcl rcr shl shr sal sar), count an immediate or 'cl'. */
function shift(ip, kind, w, d, count, live, optimistic = false) {
  const M = w === 8 ? 0xff : 0xffff, top = w - 1;
  const name = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'][kind];
  if (kind === 6) kind = 4;
  const sx = w === 8 ? 't0<<24>>24' : 't0<<16>>16';
  // The body for a count in t3 (1..31), leaving the result in t2 and the live flags set; `n` is the
  // count when it is a constant.
  const body = (n) => {
    let c = '', def = 0, undef = 0;
    const N = n ?? 't3';
    if (kind === 0 || kind === 1) {
      c += n !== undefined ? `t1=${n & top};` : `t1=t3&${top};`;
      c += `t2=${kind === 0 ? `((t0<<t1)|(t0>>(${w}-t1)))&${M}` : `((t0>>t1)|(t0<<(${w}-t1)))&${M}`};`;
      if (live & CF) c += kind === 0 ? 'fC=t2&1;' : `fC=t2>>${top};`;
      if (live & OF) c += kind === 0 ? `fO=(t2>>${top})^(t2&1);` : `fO=((t2>>${top})^(t2>>${top - 1}))&1;`;
      def = CF | OF; undef = 0;
      if (n !== 1) { def = CF; undef = OF; }
    } else if (kind === 2 || kind === 3) {
      // Through the carry: a (w+1)-bit rotate of CF:value.
      c += n !== undefined ? `t1=${n % (w + 1)};` : `t1=t3%${w + 1};`;
      c += `t2=(fC<<${w})|t0;t2=${kind === 2 ? `((t2<<t1)|(t2>>(${w + 1}-t1)))` : `((t2>>t1)|(t2<<(${w + 1}-t1)))`}&${(M << 1) | 1};fC=t2>>${w};t2&=${M};`;
      if (live & OF) c += kind === 2 ? `fO=(t2>>${top})^fC;` : `fO=((t2>>${top})^(t2>>${top - 1}))&1;`;
      def = CF | OF; undef = 0;
      if (n !== 1) { def = CF; undef = OF; }
    } else {
      if (kind === 4) {
        c += `t2=(t0<<${N})&${M};`;
        if (live & CF) c += `fC=(t0>>(${w}-${N}))&1;`;
        if (live & OF) c += `fO=(t2>>${top})^((t0>>(${w}-${N}))&1);`;
      } else if (kind === 5) {
        c += `t2=t0>>${N};`;
        if (live & CF) c += `fC=(t0>>(${N}-1))&1;`;
        if (live & OF) c += `fO=t0>>${top};`;
      } else {
        c += `t1=${sx};t2=(t1>>${N})&${M};`;
        if (live & CF) c += `fC=(t1>>(${N}-1))&1;`;
        if (live & OF) c += 'fO=0;';
      }
      c += szp('t2', w, live);
      def = CF | ZF | SF | PF | OF; undef = AF;
      if (n !== 1) { def &= ~OF; undef |= OF; }
    }
    return { c, def, undef };
  };
  if (count === 'cl') {
    // A count of zero changes nothing, flags included: the flags it may set are "maybe" defined
    // (a use), and the ones undefined for a count above 1 are refused if read.
    const b = body();
    if (live & b.undef) refuse(ip, `${name} by CL leaves ${hex(live & b.undef, 3)} undefined for a count above 1, and it is read`);
    let c = `t3=cx&0x1f;if(t3){${d.pre}t0=${d.get};`;
    if (kind >= 4 && (live & CF)) c += `if(t3>=${w}){printf("${hex(ip)}: ${name} by %d: CF undefined\\n",t3);return 5;}`;
    if (kind >= 4) c += `if(t3>=${w}){t2=${kind === 7 ? `((${sx})>>15)&${M}` : '0'};${szp('t2', w, live)}}else{${b.c}}`;
    else c += b.c;
    c += d.set('t2') + '}';
    const use = kind === 2 || kind === 3 ? CF : 0;
    // OPTIMISTIC (translateCom retries with it when the plain form makes an undefined flag readable):
    // the flags are taken as defined, and a count of zero that would pass live flags through stops
    // the program instead -- the translation did not keep them.
    if (optimistic) {
      const pass = live & (b.def | b.undef) & ~use;
      if (pass) c += `else{printf("${hex(ip)}: ${name} by CL=0 passes flags the translation did not keep\\n");return 5;}`;
      return { c, def: b.def | b.undef, maybe: 0, undef: 0, use, text: `${name} ${d.text},cl` };
    }
    return { c, def: 0, maybe: b.def | b.undef, undef: 0, use, text: `${name} ${d.text},cl` };
  }
  const n = count & 0x1f;
  if (n === 0) return { c: '', def: 0, undef: 0, use: 0, text: `${name} ${d.text},0` };
  if ((kind === 4 || kind === 5 || kind === 7) && n >= w) refuse(ip, `${name} by ${n}, not below the operand width`);
  const b = body(n);
  return { c: d.pre + `t0=${d.get};` + b.c + d.set('t2'), def: b.def, undef: b.undef, use: kind === 2 || kind === 3 ? CF : 0, text: `${name} ${d.text},${n}` };
}

/** SHLD/SHRD r/m16, r16, imm8|CL. */
function dshift(ip, left, d, s, count, live) {
  const name = left ? 'shld' : 'shrd';
  const body = (N) => {
    let c = left ? `t2=((t0<<${N})|(t1>>(16-${N})))&0xffff;` : `t2=((t0>>${N})|(t1<<(16-${N})))&0xffff;`;
    if (live & CF) c += left ? `fC=(t0>>(16-${N}))&1;` : `fC=(t0>>(${N}-1))&1;`;
    if (live & OF) c += 'fO=((t2^t0)>>15)&1;';
    return c + szp('t2', 16, live);
  };
  if (count === 'cl') {
    if (live & (OF | AF)) refuse(ip, `${name} by CL: OF/AF read`);
    const far = `t4=t3-16;t2=${left ? '((t1<<t4)|(t1>>(16-t4)))' : '((t1>>t4)|(t1<<(16-t4)))'}&0xffff;${live & CF ? (left ? 'fC=(t1>>(16-t4))&1;' : 'fC=(t1>>(t4-1))&1;') : ''}${szp('t2', 16, live)}`;
    return { c: `t3=cx&0x1f;if(t3){${d.pre}t0=${d.get};t1=${s.get};if(t3>16){${far}}else{${body('t3')}}${d.set('t2')}}`,
      def: 0, maybe: CF | OF | ZF | SF | PF | AF, undef: 0, use: 0, text: `${name} ${d.text},${s.text},cl` };
  }
  const n = count & 0x1f;
  if (n === 0) return { c: '', def: 0, use: 0, undef: 0, text: `${name} ${d.text},${s.text},0` };
  if (n > 16) {
    // Undefined in Intel's manual; MIRAGE's DOS CPU takes the Pentium's way (src/cpu.js shd16, not
    // P6: common.mjs checks the profile): dst:src:src, the source rotated by count-16, OF clear.
    const k = n - 16;
    let c = `${d.pre}t1=${s.get};t2=${left ? `((t1<<${k})|(t1>>${16 - k}))` : `((t1>>${k})|(t1<<${16 - k}))`}&0xffff;`;
    if (live & CF) c += left ? `fC=(t1>>${16 - k})&1;` : `fC=(t1>>${k - 1})&1;`;
    if (live & OF) c += 'fO=0;';
    return { c: c + szp('t2', 16, live) + d.set('t2'), def: CF | OF | ZF | SF | PF, undef: AF, use: 0, text: `${name} ${d.text},${s.text},${n}` };
  }
  return { c: `${d.pre}t0=${d.get};t1=${s.get};${body(n)}${d.set('t2')}`, def: CF | ZF | SF | PF | (n === 1 ? OF : 0), undef: AF | (n === 1 ? 0 : OF), use: 0, text: `${name} ${d.text},${s.text},${n}` };
}

const COND = [
  ['fO', '!fO'], ['fC', '!fC'], ['fZ', '!fZ'], ['(fC|fZ)', '!(fC|fZ)'],
  ['fS', '!fS'], ['fP', '!fP'], ['(fS!=fO)', '(fS==fO)'], ['(fZ|(fS!=fO))', '!(fZ|(fS!=fO))'],
];
const CUSE = [OF, CF, ZF, CF | ZF, SF, PF, SF | OF, ZF | SF | OF];
const CNAME = ['o', 'no', 'c', 'nc', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

// x87 constants as the exact doubles MIRAGE pushes (src/recompiler.js emitFPUReg).
const FCONST = { 0xe8: 1, 0xe9: Math.log2(10), 0xea: Math.LOG2E, 0xeb: Math.PI, 0xec: Math.log10(2), 0xed: Math.LN2, 0xee: 0 };
const lit = (x) => { const s = String(x); return /[.e]/.test(s) ? s : `${s}.0`; };

const push16 = (v) => `sp=(sp-2)&0xffff;RW(ssb+sp)=${v};`;
const pop16 = (dst) => `${dst}=RW(ssb+sp);sp=(sp+2)&0xffff;`;
const de = (ip) => `{printf("${hex(ip)}: divide error\\n");return 5;}`;

/**
 * Translate one instruction. Returns a record: its length, its kind (op, jcc, jmp, call, ret, loop,
 * jcxz, exit), flag use/def/undefined, its x87 stack effect, and `gen(live, top)` producing the C
 * for the flags live after it and the stack top in force before it.
 */
function translateInsn(m, ip0, vol, entryFlags, opts = {}) {
  const { I, end, b8, s8, w16, i8, si8, i16, i32, modrm } = decode(m, ip0, vol);
  const op = I.op;
  const R = { ip: ip0, use: 0, def: 0, maybe: 0, undef: 0, fpu: null, text: '', kind: 'op' };
  let gen = null;

  if (I.o32) return op32(m, ip0, I, end, modrm, R, { b8, s8, i32 });
  if (op < 0x40 && (op & 7) < 6) {                                   // ALU forms
    const kind = op >> 3, form = op & 7, w = form & 1 ? 16 : 8;
    let d, s;
    if (form < 4) {
      const mr = modrm();
      const rm = operand(mr, w), rg = regOp(mr.reg, w);
      [d, s] = form & 2 ? [rg, rm] : [rm, rg];
    } else { d = regOp(0, w); s = immOp(w === 8 ? i8() : i16()); }
    R.text = `${ALUN[kind]} ${d.text},${s.text}`;
    gen = (live) => alu(kind, w, d, s, live);
  } else if (op === 0x06 || op === 0x0e || op === 0x16 || op === 0x1e) {
    const s = op >> 3; R.text = `push ${SREG[s]}`;
    gen = () => ({ c: push16(SREG[s]) });
  } else if (op === 0x07 || op === 0x17 || op === 0x1f) {
    const s = op >> 3; R.text = `pop ${SREG[s]}`;
    gen = () => ({ c: `${SREG[s]}=RW(ssb+sp);${SREG[s]}b=${SREG[s]}<<4;sp=(sp+2)&0xffff;` });
  } else if (op === 0x27 || op === 0x2f) {
    // DAA/DAS as src/cpu.js computes them for the CPU profile (bcdAdjustsAX: the 386's thresholds).
    const bx = !!opts.platform?.bcdAX, das = op === 0x2f;
    R.text = das ? 'das' : 'daa';
    gen = (live) => ({ c: `t0=ax&0xff;t1=t0;t2=0;t3=0;if((t1&15)>9||fA){${das ? `t4=t1<6;t1=(t1-6)&0xff;t3=1;${bx ? 'if(fC||t4)t2=1;' : ''}` : 't4=t1+6;t1=t4&0xff;t2=(fC||t4>0xff);t3=1;'}}`
      + `if(t0>${bx ? '0x99' : '(fA?0x9f:0x99)'}||fC){t1=(t1${das ? '-' : '+'}0x60)&0xff;t2=1;}ax=(ax&0xff00)|t1;fC=t2;fA=t3;${szp('t1', 8, live)}`,
      use: CF | AF, def: CF | AF | ZF | SF | PF | OF, undef: OF });
  } else if (op === 0x37 || op === 0x3f) {
    const bx = !!opts.platform?.bcdAX, aas = op === 0x3f;
    R.text = aas ? 'aas' : 'aaa';
    const adj = bx ? `ax=(ax${aas ? '-' : '+'}0x106)&0xffff;` : `ax=(((ax&0xff00)|((ax${aas ? '-' : '+'}6)&0xff))${aas ? '-' : '+'}0x100)&0xffff;`;
    gen = () => ({ c: `if((ax&15)>9||fA){${adj}fA=fC=1;}else fA=fC=0;ax&=0xff0f;`, use: AF, def: ALL, undef: OF | SF | ZF | PF });
  } else if (op >= 0x40 && op <= 0x4f) {
    const r = op & 7, inc = op < 0x48; R.text = `${inc ? 'inc' : 'dec'} ${R16[r]}`;
    gen = (live) => incdec(inc, regOp(r, 16), 16, live);
  } else if (op >= 0x50 && op <= 0x57) {
    const r = op & 7; R.text = `push ${R16[r]}`;
    // PUSH SP stores the value SP had before the push (286 and later, as MIRAGE).
    gen = () => ({ c: r === 4 ? 't0=sp;' + push16('t0') : push16(R16[r]) });
  } else if (op >= 0x58 && op <= 0x5f) {
    const r = op & 7; R.text = `pop ${R16[r]}`;
    gen = () => ({ c: r === 4 ? 'sp=RW(ssb+sp);' : pop16(R16[r]) });
  } else if (op === 0x60) {
    R.text = 'pusha';
    gen = () => ({ c: `t0=sp;${push16('ax')}${push16('cx')}${push16('dx')}${push16('bx')}${push16('t0')}${push16('bp')}${push16('si')}${push16('di')}` });
  } else if (op === 0x61) {
    R.text = 'popa';
    gen = () => ({ c: `${pop16('di')}${pop16('si')}${pop16('bp')}sp=(sp+2)&0xffff;${pop16('bx')}${pop16('dx')}${pop16('cx')}${pop16('ax')}` });
  } else if (op === 0x68 || op === 0x6a) {
    const v = op === 0x68 ? i16() : si8(); R.text = `push ${fmtI(v)}`;
    gen = () => ({ c: push16(v) });
  } else if (op === 0x69 || op === 0x6b) {
    const mr = modrm(); const s = operand(mr, 16); const v = op === 0x69 ? i16() : si8();
    R.text = `imul ${R16[mr.reg]},${s.text},${fmtI(v)}`;
    gen = (live) => ({ c: `${s.pre}t2=${sx16(s.get)}*${sx16(v)};${R16[mr.reg]}=t2&0xffff;${live & (CF | OF) ? 'fC=fO=(t2!=((t2<<16)>>16));' : ''}`, def: CF | OF, undef: SF | ZF | AF | PF });
  } else if (op >= 0x70 && op <= 0x7f) {
    const rel = s8(); const t = (end() + rel) & 0xffff; const cc = op & 15;
    R.text = `j${CNAME[cc]} ${hex(t)}`; R.use = CUSE[cc >> 1]; R.kind = 'jcc'; R.target = t; R.cond = COND[cc >> 1][cc & 1];
  } else if (op === 0x0f) {
    const op2 = b8();
    if (op2 >= 0x80 && op2 <= 0x8f) {
      const rel = (w16() << 16) >> 16; const t = (end() + rel) & 0xffff; const cc = op2 & 15;
      R.text = `j${CNAME[cc]} ${hex(t)}`; R.use = CUSE[cc >> 1]; R.kind = 'jcc'; R.target = t; R.cond = COND[cc >> 1][cc & 1];
    } else if (op2 === 0xa0 || op2 === 0xa8) {
      const s = op2 === 0xa0 ? 4 : 5; R.text = `push ${SREG[s]}`;
      gen = () => ({ c: push16(SREG[s]) });
    } else if (op2 === 0xa1 || op2 === 0xa9) {
      const s = op2 === 0xa1 ? 4 : 5; R.text = `pop ${SREG[s]}`;
      gen = () => ({ c: `${SREG[s]}=RW(ssb+sp);${SREG[s]}b=${SREG[s]}<<4;sp=(sp+2)&0xffff;` });
    } else if (op2 === 0xa4 || op2 === 0xa5 || op2 === 0xac || op2 === 0xad) {
      const mr = modrm(); const d = operand(mr, 16), s = regOp(mr.reg, 16);
      const count = op2 & 1 ? 'cl' : b8();
      const left = op2 < 0xa8;
      R.text = dshift(ip0, left, d, s, count, 0).text;
      gen = (live) => dshift(ip0, left, d, s, count, live);
    } else if (op2 === 0x31) {
      // RDTSC: MIRAGE's time stamp is cpu.cycles, the instructions retired before this one.
      R.text = 'rdtsc'; R.io = true;
      gen = () => ({ c: 'rc_ic=ic+ICK;d0=fmod(rc_ic,4294967296.0);ax=(int)fmod(d0,65536.0);axh=(int)floor(d0/65536.0);d0=floor(rc_ic/4294967296.0);dx=(int)fmod(d0,65536.0);dxh=(int)floor(d0/65536.0);' });
    } else if (op2 === 0xa3 || op2 === 0xab || op2 === 0xb3 || op2 === 0xbb || op2 === 0xba) {
      // BT/BTS/BTR/BTC: CF is the bit; OF SF AF PF are undefined (a read is refused), ZF kept.
      const mr = modrm();
      let kind, bit;
      if (op2 === 0xba) { if (mr.reg < 4) refuse(ip0, `0F BA /${mr.reg}`); kind = mr.reg - 4; bit = b8(); }
      else { kind = { 0xa3: 0, 0xab: 1, 0xb3: 2, 0xbb: 3 }[op2]; bit = R16[mr.reg]; }
      const nm = ['bt', 'bts', 'btr', 'btc'][kind];
      R.text = `${nm} ${mr.isReg ? R16[mr.rm] : mr.text},${typeof bit === 'number' ? bit : bit}`;
      const upd = (v, b) => [null, `(${v})|(1<<${b})`, `(${v})&~(1<<${b})`, `(${v})^(1<<${b})`][kind];
      gen = () => {
        let c;
        if (mr.isReg) {
          const r = R16[mr.rm];
          c = `t1=(${bit})&15;fC=(${r}>>t1)&1;${kind ? `${r}=(${upd(r, 't1')})&0xffff;` : ''}`;
        } else if (typeof bit === 'number') {
          const k = bit & 15;
          c = `ta=${segb(mr.seg)}+${mr.plus(k >> 3)};fC=(MEM[ta]>>${k & 7})&1;${kind ? `MEM[ta]=(${upd('MEM[ta]', k & 7)})&0xff;` : ''}`;
        } else {
          c = `t1=${sx16(bit)};ta=${segb(mr.seg)}+((${mr.ea}+(t1>>3))&0xffff);t1&=7;fC=(MEM[ta]>>t1)&1;${kind ? `MEM[ta]=(${upd('MEM[ta]', 't1')})&0xff;` : ''}`;
        }
        return { c, def: CF | OF | SF | AF | PF, undef: OF | SF | AF | PF };
      };
    } else if (op2 === 0xc0 || op2 === 0xc1) {
      const w = op2 & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w), r = regOp(mr.reg, w);
      R.text = `xadd ${d.text},${r.text}`;
      gen = (live) => { const a = alu(0, w, { ...exprOp('t4'), set: () => '' }, exprOp('t5'), live); return { c: `${d.pre}t4=${d.get};t5=${r.get};${a.c}${r.set('t4')}${d.set(`(t4+t5)&${w === 8 ? 0xff : 0xffff}`)}`, def: ALL }; };
    } else if (op2 === 0xbc || op2 === 0xbd) {
      // BSF/BSR: ZF says the source was zero, and then the destination is kept (as MIRAGE and the
      // hardware do); the other flags are undefined.
      const mr = modrm(); const s = operand(mr, 16); const fwd = op2 === 0xbc;
      R.text = `${fwd ? 'bsf' : 'bsr'} ${R16[mr.reg]},${s.text}`;
      gen = () => ({ c: `${s.pre}t0=${s.get};fZ=(t0==0);if(t0){t1=${fwd ? '0;while(!((t0>>t1)&1))t1++' : '15;while(!((t0>>t1)&1))t1--'};${R16[mr.reg]}=t1;}`, def: ZF | CF | OF | SF | AF | PF, undef: CF | OF | SF | AF | PF });
    } else if (op2 === 0xaf) {
      const mr = modrm(); const s = operand(mr, 16);
      R.text = `imul ${R16[mr.reg]},${s.text}`;
      gen = (live) => ({ c: `${s.pre}t2=${sx16(s.get)}*${sx16(R16[mr.reg])};${R16[mr.reg]}=t2&0xffff;${live & (CF | OF) ? 'fC=fO=(t2!=((t2<<16)>>16));' : ''}`, def: CF | OF, undef: SF | ZF | AF | PF });
    } else if (op2 === 0xb6 || op2 === 0xb7 || op2 === 0xbe || op2 === 0xbf) {
      const mr = modrm(); const w = op2 & 1 ? 16 : 8; const s = operand(mr, w);
      R.text = `mov${op2 < 0xb8 ? 'zx' : 'sx'} ${R16[mr.reg]},${s.text}`;
      gen = () => ({ c: `${s.pre}${R16[mr.reg]}=${op2 < 0xb8 || w === 16 ? s.get : `${sx8(s.get)}&0xffff`};` });
    } else if (op2 === 0xb2 || op2 === 0xb4 || op2 === 0xb5) {
      const mr = modrm(); if (mr.isReg) refuse(ip0, 'lss/lfs/lgs with a register operand');
      const sr = { 0xb2: 2, 0xb4: 4, 0xb5: 5 }[op2];
      R.text = `l${SREG[sr]} ${R16[mr.reg]},${mr.text}`;
      gen = () => ({ c: `t0=RW(${segb(mr.seg)}+${mr.ea});${SREG[sr]}=RW(${segb(mr.seg)}+${mr.plus(2)});${SREG[sr]}b=${SREG[sr]}<<4;${R16[mr.reg]}=t0;` });
    } else refuse(ip0, `0F ${hex(op2, 2)}`);
  } else if (op === 0x80 || op === 0x81 || op === 0x82 || op === 0x83) {
    const w = op === 0x81 || op === 0x83 ? 16 : 8; const mr = modrm(); const d = operand(mr, w);
    const v = op === 0x81 ? i16() : op === 0x83 ? si8() : i8();
    R.text = `${ALUN[mr.reg]} ${d.text},${fmtI(v)}`;
    gen = (live) => alu(mr.reg, w, d, immOp(v), live);
  } else if (op === 0x84 || op === 0x85 || op === 0xa8 || op === 0xa9) {
    const w = op & 1 ? 16 : 8; let d, s;
    if (op < 0xa8) { const mr = modrm(); d = operand(mr, w); s = regOp(mr.reg, w); } else { d = regOp(0, w); s = immOp(w === 8 ? i8() : i16()); }
    R.text = `test ${d.text},${s.text}`;
    gen = (live) => alu(8, w, d, s, live);
  } else if (op === 0x86 || op === 0x87) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const a = operand(mr, w), b = regOp(mr.reg, w);
    R.text = `xchg ${a.text},${b.text}`;
    gen = () => ({ c: `${a.pre}t0=${a.get};t1=${b.get};${a.set('t1')}${b.set('t0')}` });
  } else if (op >= 0x88 && op <= 0x8b) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const rm = operand(mr, w), rg = regOp(mr.reg, w);
    const [d, s] = op & 2 ? [rg, rm] : [rm, rg];
    R.text = `mov ${d.text},${s.text}`;
    gen = () => ({ c: rm.pre + d.set(s.get) });
  } else if (op === 0x8c) {
    const mr = modrm(); const d = operand(mr, 16); R.text = `mov ${d.text},${SREG[mr.reg]}`;
    gen = () => ({ c: d.pre + d.set(SREG[mr.reg]) });
  } else if (op === 0x8e) {
    const mr = modrm(); const s = operand(mr, 16); R.text = `mov ${SREG[mr.reg]},${s.text}`;
    if (mr.reg === 1) refuse(ip0, 'mov cs');
    gen = () => ({ c: `${s.pre}${SREG[mr.reg]}=${s.get};${SREG[mr.reg]}b=${SREG[mr.reg]}<<4;` });
  } else if (op === 0x8d) {
    const mr = modrm(); if (mr.isReg) refuse(ip0, 'lea with a register operand');
    R.text = `lea ${R16[mr.reg]},${mr.text}`;
    gen = () => ({ c: `${R16[mr.reg]}=${mr.ea}${/^-?\d+$/.test(mr.ea) ? '&0xffff' : ''};` });
  } else if (op === 0x8f) {
    const mr = modrm(); if (mr.reg) refuse(ip0, `8F /${mr.reg}`);
    const d = operand(mr, 16); R.text = `pop ${d.text}`;
    // The address is computed with SP already incremented (SDM POP).
    gen = () => ({ c: `t0=RW(ssb+sp);sp=(sp+2)&0xffff;${d.pre}${d.set('t0')}` });
  } else if (op === 0x90) {
    R.text = 'nop'; gen = () => ({ c: '' });
  } else if (op >= 0x91 && op <= 0x97) {
    const r = R16[op & 7]; R.text = `xchg ax,${r}`;
    gen = () => ({ c: `t0=ax;ax=${r};${r}=t0;` });
  } else if (op === 0x98) {
    R.text = 'cbw'; gen = () => ({ c: 'ax=(ax<<24>>24)&0xffff;' });
  } else if (op === 0x99) {
    R.text = 'cwd'; gen = () => ({ c: 'dx=(ax&0x8000)?0xffff:0;' });
  } else if (op === 0x9b) {
    R.text = 'fwait'; gen = () => ({ c: '' });
  } else if (op === 0x9c) {
    // The flags word: the arithmetic flags, and the rest as the program found them (IF, bit 1).
    R.text = 'pushf'; R.use = ALL;
    gen = () => ({ c: push16(`(fO<<11)|(fS<<7)|(fZ<<6)|(fA<<4)|(fP<<2)|fC|${entryFlags & ~ALL & 0xffff}`), use: ALL });
  } else if (op === 0x9d) {
    R.text = 'popf';
    gen = () => ({ c: `t0=RW(ssb+sp);sp=(sp+2)&0xffff;if(t0&0x500){printf("${hex(ip0)}: popf sets DF or TF\\n");return 5;}fC=t0&1;fP=(t0>>2)&1;fA=(t0>>4)&1;fZ=(t0>>6)&1;fS=(t0>>7)&1;fO=(t0>>11)&1;`, def: ALL });
  } else if (op === 0x9e) {
    R.text = 'sahf';
    gen = (live) => ({ c: (live & CF ? 'fC=(ax>>8)&1;' : '') + (live & PF ? 'fP=(ax>>10)&1;' : '') + (live & AF ? 'fA=(ax>>12)&1;' : '') + (live & ZF ? 'fZ=(ax>>14)&1;' : '') + (live & SF ? 'fS=ax>>15;' : ''), def: CF | PF | AF | ZF | SF });
  } else if (op === 0x9f) {
    R.text = 'lahf';
    gen = () => ({ c: 'ax=(ax&0xff)|((fS<<7|fZ<<6|fA<<4|fP<<2|2|fC)<<8);', use: CF | PF | AF | ZF | SF });
  } else if (op >= 0xa0 && op <= 0xa3) {
    const w = op & 1 ? 16 : 8, a = w16(), s = I.seg ?? 3;
    const mem = w === 8 ? `MEM[${segb(s)}+${a}]` : `RW(${segb(s)}+${a})`;
    R.text = op < 0xa2 ? `mov ${w === 8 ? 'al' : 'ax'},[${hex(a)}]` : `mov [${hex(a)}],${w === 8 ? 'al' : 'ax'}`;
    gen = () => ({ c: op < 0xa2 ? (w === 8 ? r8set(0, mem) : `ax=${mem};`) : `${mem}=${w === 8 ? '(ax&0xff)' : 'ax'};` });
  } else if ([0xa4, 0xa5, 0xaa, 0xab, 0xac, 0xad, 0x6e, 0x6f].includes(op)) {
    // String moves. DF is known statically (the forward pass of translateCom); `df` is its value here.
    const w = op & 1 ? 16 : 8, n = w / 8, src = segb(I.seg ?? 3);
    const name = { 0xa4: 'movs', 0xaa: 'stos', 0xac: 'lods', 0x6e: 'outs' }[op & 0xfe] + (w === 8 ? 'b' : 'w');
    R.text = (I.rep ? 'rep ' : '') + (I.seg !== null && I.seg !== 3 ? `${SREG[I.seg]} ` : '') + name;
    R.string = true;
    const RD = w === 8 ? 'MEM' : 'RW';
    const oneOf = (df) => {
      const st = (r) => `${r}=(${r}${df ? '-' : '+'}${n})&0xffff;`;
      return {
        movs: `${RD}[esb+di]=${RD}[${src}+si];${st('si')}${st('di')}`,
        stos: `${RD}[esb+di]=${w === 8 ? '(ax&0xff)' : 'ax'};${st('di')}`,
        lods: `${w === 8 ? r8set(0, `MEM[${src}+si]`) : `ax=RW(${src}+si);`}${st('si')}`,
        outs: `${w === 8 ? `rc_outp(dx,MEM[${src}+si]);` : `t0=RW(${src}+si);rc_outp(dx,t0&0xff);rc_outp(dx+1,t0>>8);`}${st('si')}`,
      }[name.slice(0, 4)].replace(/RW\[([^\]]+)\]/g, 'RW($1)');
    };
    if (!I.rep) gen = (l, t, df) => ({ c: oneOf(df) });
    else if (name.startsWith('lods')) refuse(ip0, 'rep lods');
    else if (name === 'movsw' || name === 'movsb') {
      // A fast path when neither index wraps and the copy cannot read what it wrote (memmove agrees
      // with the word-by-word copy then); the word-by-word loop otherwise, and always when DF=1.
      gen = (l, t, df) => ({ c: df ? `while(cx){${oneOf(1)}cx=cx-1;}`
        : `if(cx){t0=cx*${n};if(si+t0<=0x10000&&di+t0<=0x10000&&(esb+di<=${src}+si||esb+di>=${src}+si+t0)){memmove(MEM+esb+di,MEM+${src}+si,t0);si=(si+t0)&0xffff;di=(di+t0)&0xffff;cx=0;}else{do{${oneOf(0)}cx=cx-1;}while(cx);}}` });
    } else if (name === 'stosb') {
      gen = (l, t, df) => ({ c: df ? `while(cx){${oneOf(1)}cx=cx-1;}` : `if(cx){if(di+cx<=0x10000){memset(MEM+esb+di,ax&0xff,cx);di=(di+cx)&0xffff;cx=0;}else{do{${oneOf(0)}cx=cx-1;}while(cx);}}` });
    } else gen = (l, t, df) => ({ c: `while(cx){${oneOf(df)}cx=cx-1;}` });
  } else if ([0xa6, 0xa7, 0xae, 0xaf].includes(op)) {
    // CMPS/SCAS: a compare (SUB's flags), the index(es) stepped; REPE/REPNE stop on ZF.
    const w = op & 1 ? 16 : 8, n = w / 8, src = segb(I.seg ?? 3);
    const scas = op >= 0xae;
    const name = (scas ? 'scas' : 'cmps') + (w === 8 ? 'b' : 'w');
    R.text = (I.rep ? (I.rep === 0xf3 ? 'repe ' : 'repne ') : '') + name;
    R.string = true;
    const RDf = (a) => (w === 8 ? `MEM[${a}]` : `RW(${a})`);
    const a = scas ? (w === 8 ? '(ax&0xff)' : 'ax') : RDf(`${src}+si`);
    const b = RDf('esb+di');
    const step = (df) => `${scas ? '' : `si=(si${df ? '-' : '+'}${n})&0xffff;`}di=(di${df ? '-' : '+'}${n})&0xffff;`;
    if (!I.rep) gen = (live, t, df) => { const r = alu(7, w, exprOp('t4'), exprOp('t5'), live); return { c: `t4=${a};t5=${b};${step(df)}${r.c}`, def: ALL }; };
    else {
      gen = (live, t, df) => {
        const r = alu(7, w, exprOp('t4'), exprOp('t5'), live | ZF);
        return { c: `while(cx){t4=${a};t5=${b};${step(df)}cx=cx-1;${r.c}if(${I.rep === 0xf3 ? '!fZ' : 'fZ'})break;}`, def: 0, maybe: ALL };
      };
    }
  } else if (op >= 0xb0 && op <= 0xb7) {
    const v = i8(); R.text = `mov ${R8N[op & 7]},${fmtI(v)}`;
    gen = () => ({ c: r8set(op & 7, v) });
  } else if (op >= 0xb8 && op <= 0xbf) {
    const v = i16(); R.text = `mov ${R16[op & 7]},${fmtI(v)}`;
    gen = () => ({ c: `${R16[op & 7]}=${v};` });
  } else if (op === 0xc0 || op === 0xc1 || op === 0xd0 || op === 0xd1 || op === 0xd2 || op === 0xd3) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w);
    const count = op <= 0xc1 ? b8() : op <= 0xd1 ? 1 : 'cl';
    R.text = shift(ip0, mr.reg, w, d, count, 0, opts.optimisticShift).text;
    gen = (live) => shift(ip0, mr.reg, w, d, count, live, opts.optimisticShift);
  } else if (op === 0xc2 || op === 0xc3) {
    R.imm = op === 0xc2 ? w16() : 0;
    R.text = op === 0xc2 ? `ret ${R.imm}` : 'ret'; R.kind = 'ret';
  } else if (op === 0xc4 || op === 0xc5) {
    const mr = modrm(); if (mr.isReg) refuse(ip0, `${op === 0xc4 ? 'les' : 'lds'} with a register operand`);
    const sr = op === 0xc4 ? 0 : 3;
    R.text = `l${SREG[sr]} ${R16[mr.reg]},${mr.text}`;
    gen = () => ({ c: `t0=RW(${segb(mr.seg)}+${mr.ea});${SREG[sr]}=RW(${segb(mr.seg)}+${mr.plus(2)});${SREG[sr]}b=${SREG[sr]}<<4;${R16[mr.reg]}=t0;` });
  } else if (op === 0xc6 || op === 0xc7) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w); const v = w === 8 ? i8() : i16();
    R.text = `mov ${d.text},${fmtI(v)}`;
    gen = () => ({ c: d.pre + d.set(v) });
  } else if (op === 0xc9) {
    R.text = 'leave'; gen = () => ({ c: `sp=bp;${pop16('bp')}` });
  } else if (op === 0xcd) {
    const n = b8(); R.text = `int 0x${n.toString(16)}`;
    if (n === 0x20) R.kind = 'exit';
    else if (n === 0x21 && ((m[(ip0 - 2) & 0xffff] === 0xb4 && m[(ip0 - 1) & 0xffff] === 0x4c) || (m[(ip0 - 3) & 0xffff] === 0xb8 && m[(ip0 - 1) & 0xffff] === 0x4c))) {
      // MOV AH,4Ch (or AX,4Cxx) just before: the program's exit, with nothing after it to translate --
      // checked at run time, since a jump could land on the INT itself.
      R.kind = 'exit21';
    } else if (n === 0x10 || n === 0x12 || n === 0x16 || n === 0x21) {
      // Through the platform layer (rc.h rc_bios), every register in and out. INT 16h reports a key
      // in ZF (it sets or keeps it: a use and a definition); INT 10h's flags are not modelled -- an
      // INT that neither uses nor defines them, so a flag read after it comes from before it. INT
      // 21h AH=4Ch is the program's exit.
      R.io = n === 0x16;
      gen = () => ({ c: `${n === 0x21 ? 'if((ax>>8)==0x4c)return 0;' : ''}rg.ax=ax;rg.bx=bx;rg.cx=cx;rg.dx=dx;rg.si=si;rg.di=di;rg.bp=bp;rg.es=es;rg.ds=ds;rg.flags=${n === 0x16 ? 'fZ<<6' : '0'};`
        + `${n === 0x16 ? 'rc_ic=ic+ICK;if(rc_guard(csb))return 4;' : ''}if((t0=rc_bios(0x${n.toString(16)},&rg))){printf("${hex(ip0)}: int ${hex(n, 2)}h ax=%04x not modelled\\n",ax);return 3;}`
        + `ax=rg.ax;bx=rg.bx;cx=rg.cx;dx=rg.dx;si=rg.si;di=rg.di;bp=rg.bp;${n === 0x16 ? 'fZ=(rg.flags>>6)&1;' : ''}`, use: n === 0x16 ? ZF : 0 });
    } else refuse(ip0, `int 0x${n.toString(16)}`);
  } else if (op === 0xd4 || op === 0xd5) {
    const v = b8(); R.text = `${op === 0xd4 ? 'aam' : 'aad'} ${v}`;
    if (op === 0xd4 && v === 0) refuse(ip0, 'aam 0 (divide error)');
    gen = (live) => ({ c: (op === 0xd4 ? `t0=ax&0xff;t2=t0%${v};ax=((t0/${v})<<8)|t2;` : `t2=((ax&0xff)+(ax>>8)*${v})&0xff;ax=t2;`) + szp('t2', 8, live),
      def: ZF | SF | PF, undef: CF | OF | AF });
  } else if (op === 0xd6) {
    R.text = 'salc'; gen = () => ({ c: r8set(0, 'fC?0xff:0'), use: CF });
  } else if (op === 0xd7) {
    const s = segb(I.seg ?? 3); R.text = 'xlat';
    gen = () => ({ c: r8set(0, `MEM[${s}+((bx+(ax&0xff))&0xffff)]`) });
  } else if (op >= 0xe0 && op <= 0xe3) {
    const rel = s8(); const t = (end() + rel) & 0xffff;
    const nm = ['loopnz', 'loopz', 'loop', 'jcxz'][op - 0xe0];
    R.text = `${nm} ${hex(t)}`; R.kind = op === 0xe3 ? 'jcxz' : 'loop'; R.target = t;
    R.cond = ['(cx&&!fZ)', '(cx&&fZ)', 'cx', '!cx'][op - 0xe0];
    if (op < 0xe2) R.use = ZF;
  } else if (op === 0xe4 || op === 0xec || op === 0xe5 || op === 0xed) {
    const w = op & 1 ? 16 : 8;
    const port = op < 0xe8 ? `${b8()}` : 'dx'; R.text = `in ${w === 8 ? 'al' : 'ax'},${op < 0xe8 ? '0x' + (+port).toString(16) : 'dx'}`; R.io = true;
    const frame = port === 'dx' ? 'if(dx==0x60&&rc_guard(csb))return 4;' : +port === 0x60 ? 'if(rc_guard(csb))return 4;' : '';
    gen = () => ({ c: `rc_ic=ic+ICK;${frame}${w === 8 ? r8set(0, `rc_inp(${port})`) : `t0=rc_inp(${port});ax=t0|(rc_inp((${port})+1)<<8);`}` });
  } else if (op === 0xe6 || op === 0xee || op === 0xe7 || op === 0xef) {
    const w = op & 1 ? 16 : 8;
    const port = op < 0xe8 ? `${b8()}` : 'dx'; R.text = `out ${op < 0xe8 ? '0x' + (+port).toString(16) : 'dx'},${w === 8 ? 'al' : 'ax'}`;
    // A word OUT is the two bytes to the port and the next (MIRAGE's port table: the 16-bit write of
    // 3C8h is index then data).
    const pit = port === 'dx' || +port === 0x40 || +port === 0x43 ? 'rc_ic=ic+ICK;' : '';
    gen = () => ({ c: pit + (w === 8 ? `rc_outp(${port},ax&0xff);` : `rc_outp(${port},ax&0xff);rc_outp((${port})+1,ax>>8);`) });
  } else if (op === 0xe8) {
    const rel = (w16() << 16) >> 16; const t = (end() + rel) & 0xffff;
    R.text = `call ${hex(t)}`; R.kind = 'call'; R.target = t;
  } else if (op === 0xe9 || op === 0xeb) {
    const rel = op === 0xe9 ? (w16() << 16) >> 16 : s8(); const t = (end() + rel) & 0xffff;
    R.text = `jmp ${hex(t)}`; R.kind = 'jmp'; R.target = t;
  } else if (op === 0xf5) {
    R.text = 'cmc'; gen = () => ({ c: 'fC^=1;', use: CF, def: CF });
  } else if (op === 0xf6 || op === 0xf7) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w);
    const name = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'][mr.reg];
    if (mr.reg <= 1) {
      const v = w === 8 ? i8() : i16(); R.text = `test ${d.text},${fmtI(v)}`;
      gen = (live) => alu(8, w, d, immOp(v), live);
    } else if (mr.reg === 2) {
      R.text = `not ${d.text}`; gen = () => ({ c: d.pre + d.set(`(~${d.get})&${w === 8 ? 0xff : 0xffff}`) });
    } else if (mr.reg === 3) {
      R.text = `neg ${d.text}`;
      gen = (live) => {
        let c = d.pre + `t0=${d.get};t2=(-t0)&${w === 8 ? 0xff : 0xffff};`;
        if (live & CF) c += 'fC=(t0!=0);';
        if (live & OF) c += `fO=(t0==${w === 8 ? 0x80 : 0x8000});`;
        if (live & AF) c += 'fA=((t0^t2)>>4)&1;';
        return { c: c + szp('t2', w, live) + d.set('t2'), def: ALL };
      };
    } else {
      R.text = `${name} ${d.text}`;
      const U = { def: ALL, undef: SF | ZF | AF | PF };
      if (mr.reg === 4 && w === 8) gen = (live) => ({ c: `${d.pre}ax=(ax&0xff)*${d.get};${live & (CF | OF) ? 'fC=fO=(ax>>8)!=0;' : ''}`, ...U, def: CF | OF });
      else if (mr.reg === 4) gen = (live) => ({ c: `${d.pre}ux=(unsigned)ax*(unsigned)${d.get};ax=ux&0xffff;dx=ux>>16;${live & (CF | OF) ? 'fC=fO=(dx!=0);' : ''}`, ...U, def: CF | OF });
      else if (mr.reg === 5 && w === 8) gen = (live) => ({ c: `${d.pre}t2=${sx8('ax')}*${sx8(d.get)};ax=t2&0xffff;${live & (CF | OF) ? 'fC=fO=(t2!=((t2<<24)>>24));' : ''}`, ...U, def: CF | OF });
      else if (mr.reg === 5) gen = (live) => ({ c: `${d.pre}t2=${sx16('ax')}*${sx16(d.get)};ax=t2&0xffff;dx=(t2>>16)&0xffff;${live & (CF | OF) ? 'fC=fO=(t2!=((t2<<16)>>16));' : ''}`, ...U, def: CF | OF });
      // DIV/IDIV: a quotient that does not fit, or a zero divisor, is #DE -- MIRAGE would run the
      // program's INT 0; the C stops instead (exit 5). The flags are undefined after them.
      else if (mr.reg === 6 && w === 8) gen = () => ({ c: `${d.pre}t1=${d.get};if(!t1||ax/t1>0xff)${de(ip0)}t0=ax/t1;ax=t0|((ax%t1)<<8);`, def: ALL, undef: ALL });
      else if (mr.reg === 6) gen = () => ({ c: `${d.pre}t1=${d.get};ux=((unsigned)dx<<16)|ax;if(!t1||ux/t1>0xffff)${de(ip0)}ax=ux/t1;dx=ux%t1;`, def: ALL, undef: ALL });
      else if (w === 8) gen = () => ({ c: `${d.pre}t1=${sx8(d.get)};t3=${sx16('ax')};if(!t1)${de(ip0)}t0=t3/t1;if(t0>127||t0<-128)${de(ip0)}ax=(t0&0xff)|((t3%t1)&0xff)<<8;`, def: ALL, undef: ALL });
      else gen = () => ({ c: `${d.pre}t1=${sx16(d.get)};t3=(int)(((unsigned)dx<<16)|ax);if(!t1||(t1==-1&&t3==(int)0x80000000u))${de(ip0)}t0=t3/t1;if(t0>32767||t0<-32768)${de(ip0)}ax=t0&0xffff;dx=(t3%t1)&0xffff;`, def: ALL, undef: ALL });
    }
  } else if (op === 0xfe || op === 0xff) {
    const w = op === 0xfe ? 8 : 16; const mr = modrm();
    if (mr.reg === 6 && w === 16) {
      const d = operand(mr, 16); R.text = `push ${d.text}`;
      gen = () => ({ c: `${d.pre}t0=${d.get};${push16('t0')}` });
    } else if (mr.reg > 1) refuse(ip0, `${hex(op, 2)} /${mr.reg} (${['', '', 'call', 'call far', 'jmp', 'jmp far', 'push', ''][mr.reg]} through a register or memory)`);
    else {
      const d = operand(mr, w);
      R.text = `${mr.reg ? 'dec' : 'inc'} ${d.text}`;
      gen = (live) => incdec(!mr.reg, d, w, live);
    }
  } else if (op === 0xf8 || op === 0xf9) {
    R.text = op === 0xf8 ? 'clc' : 'stc'; gen = () => ({ c: `fC=${op & 1};`, def: CF });
  } else if (op === 0xfa || op === 0xfb) {
    // No interrupt is delivered to a recompiled program (the oracle runs MIRAGE without its timer).
    R.text = op === 0xfa ? 'cli' : 'sti'; gen = () => ({ c: '' });
  } else if (op === 0xfc || op === 0xfd) {
    // DF is followed statically (translateCom), so CLD and STD cost nothing at run time.
    R.text = op === 0xfc ? 'cld' : 'std'; R.setDf = op & 1; gen = () => ({ c: '' });
  } else if (op >= 0xd8 && op <= 0xdf) {
    return fpuInsn(m, ip0, I, end, modrm, R);
  } else refuse(ip0, `opcode ${hex(op, 2)}`);

  R.len = (end() - ip0) & 0xffff;
  if (gen) {
    const probe = gen(0, 0);
    R.def = probe.def ?? R.def; R.undef = probe.undef ?? R.undef; R.use = probe.use ?? R.use; R.maybe = probe.maybe ?? R.maybe;
    R.gen = gen;
  }
  return R;
}

/**
 * The 66h-prefixed (32-bit operand) subset. A 32-bit register is its 16-bit local and a second local
 * for the upper half (axh..dih): 16-bit code never touches the upper halves, so it costs nothing
 * where it is not used. ESP is refused (the stack is SS:SP).
 */
const R32 = (r) => { if (r === 4) throw new Refused('esp'); return { get: `(((unsigned)${R16[r]}h<<16)|(unsigned)${R16[r]})`, set: (v) => `u0=${v};${R16[r]}=u0&0xffff;${R16[r]}h=u0>>16;`, text: `e${R16[r]}` }; };
function operand32(mr) {
  if (mr.isReg) return { pre: '', ...R32(mr.rm) };
  return { pre: `ta=${segb(mr.seg)}+${mr.ea};`, get: '((unsigned)RL(ta))', set: (v) => `RL(ta)=(int)(${v});`, text: `dword ${mr.text}`, mem: true };
}
function alu32(kind, d, s, live) {
  const store = kind !== 7 && kind !== 8;
  const opch = { 1: '|', 4: '&', 6: '^', 8: '&' }[kind];
  let c = d.pre + (s.pre && s.pre !== d.pre ? s.pre : '');
  const z = (r) => (live & ZF ? `fZ=(${r}==0);` : '') + (live & SF ? `fS=${r}>>31;` : '') + (live & PF ? `fP=PAR[${r}&0xff];` : '');
  if (opch) {
    c += `u2=${d.get}${opch}${s.get};${live & CF ? 'fC=0;' : ''}${live & OF ? 'fO=0;' : ''}${z('u2')}`;
    return { c: c + (store ? d.set('u2') : ''), def: CF | OF | ZF | SF | PF, undef: AF };
  }
  const add = kind === 0 || kind === 2, cin = kind === 2 || kind === 3;
  c += `u0=${d.get};u1=${s.get};u2=u0${add ? '+' : '-'}u1${cin ? (add ? '+fC' : '-fC') : ''};`;
  if (live & CF) c += add ? (cin ? 'fC=(u2<u0||(fC&&u2==u0));' : 'fC=(u2<u0);') : (cin ? 'fC=(u0<u1||(fC&&u0==u1));' : 'fC=(u0<u1);');
  if (live & OF) c += add ? 'fO=((u0^u2)&(u1^u2))>>31;' : 'fO=((u0^u1)&(u0^u2))>>31;';
  if (live & AF) c += 'fA=((u0^u1^u2)>>4)&1;';
  c += z('u2');
  return { c: c + (store ? d.set('u2') : ''), def: ALL, undef: 0, use: cin ? CF : 0 };
}
function op32(m, ip0, I, end, modrm, R, { b8, s8, i32 }) {
  const op = I.op;
  let gen = null;
  try {
    if (op < 0x40 && (op & 7) < 6 && (op & 1)) {
      const kind = op >> 3, form = op & 7;
      let d, s;
      if (form < 4) { const mr = modrm(); const rm = operand32(mr), rg = { pre: '', ...R32(mr.reg) }; [d, s] = form & 2 ? [rg, rm] : [rm, rg]; }
      else { d = { pre: '', ...R32(0) }; const v = i32(); s = { pre: '', get: `${v}u`, text: `0x${v.toString(16)}` }; }
      R.text = `${ALUN[kind]} ${d.text},${s.text}`;
      gen = (live) => alu32(kind, d, s, live);
    } else if (op === 0x81 || op === 0x83) {
      const mr = modrm(); const d = operand32(mr); const v = op === 0x81 ? i32() : (s8() >>> 0);
      R.text = `${ALUN[mr.reg]} ${d.text},0x${v.toString(16)}`;
      gen = (live) => alu32(mr.reg, d, { pre: '', get: `${v}u` }, live);
    } else if (op === 0x89 || op === 0x8b) {
      const mr = modrm(); const rm = operand32(mr), rg = R32(mr.reg);
      R.text = op === 0x89 ? `mov ${rm.text},${rg.text}` : `mov ${rg.text},${rm.text}`;
      gen = () => ({ c: rm.pre + (op === 0x89 ? rm.set(rg.get) : rg.set(rm.get)) });
    } else if (op >= 0xb8 && op <= 0xbf) {
      const v = i32(); const r = R32(op & 7); R.text = `mov ${r.text},0x${v.toString(16)}`;
      gen = () => ({ c: r.set(`${v}u`) });
    } else if (op === 0xc7) {
      const mr = modrm(); const d = operand32(mr); const v = i32(); R.text = `mov ${d.text},0x${v.toString(16)}`;
      gen = () => ({ c: d.pre + d.set(`${v}u`) });
    } else if (op >= 0x40 && op <= 0x4f) {
      const r = R32(op & 7), inc = op < 0x48; R.text = `${inc ? 'inc' : 'dec'} ${r.text}`;
      gen = (live) => {
        let c = `u0=${r.get};u2=u0${inc ? '+' : '-'}1u;`;
        if (live & OF) c += `fO=(u2==${inc ? '0x80000000u' : '0x7fffffffu'});`;
        if (live & AF) c += `fA=((u2&0xf)==${inc ? 0 : 0xf});`;
        if (live & ZF) c += 'fZ=(u2==0);';
        if (live & SF) c += 'fS=u2>>31;';
        if (live & PF) c += 'fP=PAR[u2&0xff];';
        return { c: c + r.set('u2'), def: OF | SF | ZF | AF | PF };
      };
    } else if (op >= 0x50 && op <= 0x57) {
      const r = R32(op & 7); R.text = `push ${r.text}`;
      gen = () => ({ c: `u0=${r.get};sp=(sp-4)&0xffff;RW(ssb+sp)=u0&0xffff;RW(ssb+((sp+2)&0xffff))=u0>>16;` });
    } else if (op >= 0x58 && op <= 0x5f) {
      const r = R32(op & 7); R.text = `pop ${r.text}`;
      gen = () => ({ c: `u1=RW(ssb+sp)|((unsigned)RW(ssb+((sp+2)&0xffff))<<16);sp=(sp+4)&0xffff;${r.set('u1')}` });
    } else if (op === 0x68) {
      const v = i32(); R.text = `push 0x${v.toString(16)}`;
      gen = () => ({ c: `sp=(sp-4)&0xffff;RW(ssb+sp)=${v & 0xffff};RW(ssb+((sp+2)&0xffff))=${v >>> 16};` });
    } else if (op === 0xc1 || op === 0xd1) {
      const mr = modrm(); const d = operand32(mr); const n = (op === 0xc1 ? b8() : 1) & 31;
      if (![0, 1, 4, 5, 7].includes(mr.reg)) refuse(ip0, `32-bit ${['rol', 'ror', 'rcl', 'rcr', '', '', 'sal'][mr.reg]}`);
      const nm = { 0: 'rol', 1: 'ror', 4: 'shl', 5: 'shr', 7: 'sar' }[mr.reg];
      R.text = `${nm} ${d.text},${n}`;
      gen = (live) => {
        if (!n) return { c: '' };
        let c = `${d.pre}u0=${d.get};`;
        if (mr.reg < 2) {
          c += mr.reg === 0 ? `u2=(u0<<${n})|(u0>>${32 - n});` : `u2=(u0>>${n})|(u0<<${32 - n});`;
          if (live & CF) c += mr.reg === 0 ? 'fC=u2&1;' : 'fC=u2>>31;';
          if (live & OF) c += mr.reg === 0 ? 'fO=(u2>>31)^(u2&1);' : 'fO=((u2>>31)^(u2>>30))&1;';
          return { c: c + d.set('u2'), def: CF | (n === 1 ? OF : 0), undef: n === 1 ? 0 : OF };
        }
        if (mr.reg === 4) c += `u2=u0<<${n};${live & CF ? `fC=(u0>>${32 - n})&1;` : ''}`;
        else if (mr.reg === 5) c += `u2=u0>>${n};${live & CF ? `fC=(u0>>${n - 1})&1;` : ''}`;
        else c += `u2=(unsigned)((int)u0>>${n});${live & CF ? `fC=((int)u0>>${n - 1})&1;` : ''}`;
        if (live & OF) c += mr.reg === 4 ? `fO=(u2>>31)^((u0>>${32 - n})&1);` : mr.reg === 5 ? 'fO=u0>>31;' : 'fO=0;';
        c += (live & ZF ? 'fZ=(u2==0);' : '') + (live & SF ? 'fS=u2>>31;' : '') + (live & PF ? 'fP=PAR[u2&0xff];' : '');
        return { c: c + d.set('u2'), def: CF | ZF | SF | PF | (n === 1 ? OF : 0), undef: AF | (n === 1 ? 0 : OF) };
      };
    } else if (op === 0x0f) {
      const op2 = b8();
      if (op2 === 0xb6 || op2 === 0xb7 || op2 === 0xbe || op2 === 0xbf) {
        const mr = modrm(); const w = op2 & 1 ? 16 : 8; const s = operand(mr, w); const r = R32(mr.reg);
        R.text = `mov${op2 < 0xb8 ? 'zx' : 'sx'} ${r.text},${s.text}`;
        gen = () => ({ c: s.pre + r.set(op2 < 0xb8 ? `(unsigned)${s.get}` : `(unsigned)${w === 8 ? sx8(s.get) : sx16(s.get)}`) });
      } else if (op2 === 0xa4 || op2 === 0xac) {
        const mr = modrm(); const d = operand32(mr), r = R32(mr.reg); const n = b8() & 31; const left = op2 === 0xa4;
        R.text = `${left ? 'shld' : 'shrd'} ${d.text},${r.text},${n}`;
        gen = (live) => {
          if (!n) return { c: '' };
          let c = `${d.pre}u0=${d.get};u1=${r.get};u2=${left ? `(u0<<${n})|(u1>>${32 - n})` : `(u0>>${n})|(u1<<${32 - n})`};`;
          if (live & CF) c += left ? `fC=(u0>>${32 - n})&1;` : `fC=(u0>>${n - 1})&1;`;
          if (live & OF) c += 'fO=((u2^u0)>>31)&1;';
          c += (live & ZF ? 'fZ=(u2==0);' : '') + (live & SF ? 'fS=u2>>31;' : '') + (live & PF ? 'fP=PAR[u2&0xff];' : '');
          return { c: c + d.set('u2'), def: CF | ZF | SF | PF | (n === 1 ? OF : 0), undef: AF | (n === 1 ? 0 : OF) };
        };
      } else if (op2 === 0xaf) {
        const mr = modrm(); const s = operand32(mr), r = R32(mr.reg);
        R.text = `imul ${r.text},${s.text}`;
        gen = (live) => ({ c: `${s.pre}q0=(long long)(int)${s.get}*(long long)(int)${r.get};${r.set('(unsigned)q0')}${live & (CF | OF) ? 'fC=fO=(q0!=(long long)(int)q0);' : ''}`, def: CF | OF, undef: SF | ZF | AF | PF });
      } else refuse(ip0, `32-bit operand: 0F ${hex(op2, 2)}`);
    } else if (op === 0xf7) {
      // 32-bit NOT NEG MUL IMUL DIV IDIV, the 64-bit products and dividends in long long.
      const mr = modrm(); const d = operand32(mr); const eax = R32(0), edx = R32(2);
      const nm = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'][mr.reg];
      R.text = `${nm} ${d.text}`;
      if (mr.reg <= 1) { const v = i32(); R.text += `,0x${v.toString(16)}`; gen = (live) => alu32(8, d, { pre: '', get: `${v}u` }, live); }
      else if (mr.reg === 2) gen = () => ({ c: d.pre + d.set(`~${d.get}`) });
      else if (mr.reg === 3) gen = (live) => {
        let c = `${d.pre}u0=${d.get};u2=0u-u0;`;
        if (live & CF) c += 'fC=(u0!=0);';
        if (live & OF) c += 'fO=(u0==0x80000000u);';
        if (live & AF) c += 'fA=((u0^u2)>>4)&1;';
        c += (live & ZF ? 'fZ=(u2==0);' : '') + (live & SF ? 'fS=u2>>31;' : '') + (live & PF ? 'fP=PAR[u2&0xff];' : '');
        return { c: c + d.set('u2'), def: ALL };
      };
      else if (mr.reg === 4) gen = (live) => ({ c: `${d.pre}q1=(unsigned long long)${eax.get}*(unsigned long long)${d.get};${eax.set('(unsigned)q1')}${edx.set('(unsigned)(q1>>32)')}${live & (CF | OF) ? 'fC=fO=((q1>>32)!=0);' : ''}`, def: ALL, undef: SF | ZF | AF | PF });
      else if (mr.reg === 5) gen = (live) => ({ c: `${d.pre}q0=(long long)(int)${eax.get}*(long long)(int)${d.get};${eax.set('(unsigned)q0')}${edx.set('(unsigned)((unsigned long long)q0>>32)')}${live & (CF | OF) ? 'fC=fO=(q0!=(long long)(int)q0);' : ''}`, def: ALL, undef: SF | ZF | AF | PF });
      else if (mr.reg === 6) gen = () => ({ c: `${d.pre}u0=${d.get};q1=((unsigned long long)${edx.get}<<32)|${eax.get};if(!u0||q1/u0>0xffffffffull)${de(ip0)}u1=(unsigned)(q1/u0);u2=(unsigned)(q1%u0);${eax.set('u1')}${edx.set('u2')}`, def: ALL, undef: ALL });
      else gen = () => ({ c: `${d.pre}q2=(long long)(int)${d.get};q0=(long long)(((unsigned long long)${edx.get}<<32)|${eax.get});if(!q2||(q2==-1&&q0==(-9223372036854775807LL-1)))${de(ip0)}q3=q0/q2;if(q3>2147483647LL||q3<-2147483648LL)${de(ip0)}${eax.set('(unsigned)q3')}${edx.set('(unsigned)(q0%q2)')}`, def: ALL, undef: ALL });
    } else if (op === 0x69 || op === 0x6b) {
      const mr = modrm(); const s = operand32(mr), r = R32(mr.reg); const v = op === 0x69 ? i32() : (s8() >>> 0);
      R.text = `imul ${r.text},${s.text},0x${v.toString(16)}`;
      gen = (live) => ({ c: `${s.pre}q0=(long long)(int)${s.get}*(long long)(int)${v}u;${r.set('(unsigned)q0')}${live & (CF | OF) ? 'fC=fO=(q0!=(long long)(int)q0);' : ''}`, def: CF | OF, undef: SF | ZF | AF | PF });
    } else if (op === 0xa1 || op === 0xa3) {
      const a = I.w16 ? I.w16() : null; const sg = segb(I.seg ?? 3); const eax = R32(0);
      R.text = op === 0xa1 ? `mov eax,[${hex(a)}]` : `mov [${hex(a)}],eax`;
      gen = () => ({ c: op === 0xa1 ? eax.set(`(unsigned)RL(${sg}+${a})`) : `RL(${sg}+${a})=(int)${eax.get};` });
    } else if (op === 0x99 || op === 0x98) {
      R.text = op === 0x99 ? 'cdq' : 'cwde';
      gen = () => ({ c: op === 0x99 ? 'dx=dxh=(axh&0x8000)?0xffff:0;' : 'axh=(ax&0x8000)?0xffff:0;' });
    } else if (op === 0xff) {
      const mr = modrm(); const d = operand32(mr);
      if (mr.reg === 6) { R.text = `push ${d.text}`; gen = () => ({ c: `${d.pre}u0=${d.get};sp=(sp-4)&0xffff;RW(ssb+sp)=u0&0xffff;RW(ssb+((sp+2)&0xffff))=u0>>16;` }); }
      else if (mr.reg <= 1) {
        const inc = mr.reg === 0; R.text = `${inc ? 'inc' : 'dec'} ${d.text}`;
        gen = (live) => {
          let c = `${d.pre}u0=${d.get};u2=u0${inc ? '+' : '-'}1u;`;
          if (live & OF) c += `fO=(u2==${inc ? '0x80000000u' : '0x7fffffffu'});`;
          if (live & AF) c += `fA=((u2&0xf)==${inc ? 0 : 0xf});`;
          c += (live & ZF ? 'fZ=(u2==0);' : '') + (live & SF ? 'fS=u2>>31;' : '') + (live & PF ? 'fP=PAR[u2&0xff];' : '');
          return { c: c + d.set('u2'), def: OF | SF | ZF | AF | PF };
        };
      } else refuse(ip0, `32-bit FF /${mr.reg}`);
    } else if (op === 0xa5 || op === 0xab || op === 0xad) {
      // MOVSD/STOSD/LODSD (a 66h string move in 16-bit addressing: SI/DI step by 4).
      const src = segb(I.seg ?? 3), nm = { 0xa5: 'movsd', 0xab: 'stosd', 0xad: 'lodsd' }[op];
      R.text = (I.rep ? 'rep ' : '') + nm; R.string = true;
      if (I.rep && op === 0xad) refuse(ip0, 'rep lodsd');
      const eax = R32(0);
      const one = (df) => {
        const st = (r) => `${r}=(${r}${df ? '-' : '+'}4)&0xffff;`;
        return op === 0xa5 ? `RL(esb+di)=RL(${src}+si);${st('si')}${st('di')}` : op === 0xab ? `RL(esb+di)=(int)${eax.get};${st('di')}` : `${eax.set(`(unsigned)RL(${src}+si)`)}${st('si')}`;
      };
      gen = (l, t, df) => ({ c: I.rep ? `while(cx){${one(df)}cx=cx-1;}` : one(df) });
    } else refuse(ip0, `32-bit operand: opcode ${hex(op, 2)}`);
  } catch (e) { if (e instanceof Refused && e.message === 'esp') refuse(ip0, '32-bit ESP'); throw e; }
  R.len = (end() - ip0) & 0xffff;
  const probe = gen(0, 0);
  R.def = probe.def ?? 0; R.undef = probe.undef ?? 0; R.use = probe.use ?? 0; R.maybe = 0;
  R.gen = gen;
  R.o32 = true;
  return R;
}

function incdec(inc, d, w, live) {
  const M = w === 8 ? 0xff : 0xffff, s = w === 8 ? 0x80 : 0x8000;
  let c = d.pre;
  if (!(live & ALL)) return { c: c + d.set(`(${d.get}${inc ? '+' : '-'}1)&${M}`), def: OF | SF | ZF | AF | PF };
  c += `t2=(${d.get}${inc ? '+' : '-'}1)&${M};`;
  if (live & OF) c += `fO=(t2==${inc ? s : s - 1});`;
  if (live & AF) c += `fA=((t2&0xf)==${inc ? 0 : 0xf});`;
  return { c: c + szp('t2', w, live) + d.set('t2'), def: OF | SF | ZF | AF | PF };
}

/** The x87 subset, on physical registers p0..p7 (the stack top `top` is static). */
function fpuInsn(m, ip0, I, end, modrm, R) {
  const op = I.op;
  const mr = modrm();
  R.len = (end() - ip0) & 0xffff;
  // ST(i): a fixed local when the top is static, F[(ft+i)&7] when it is not (fpuDyn).
  const P = (top, i) => (top === 'dyn' ? `F[(ft+${i})&7]` : `p${(top + i) & 7}`);
  const T11 = (t) => (t === 'dyn' ? '(ft<<11)' : R.tadj ? `(((${t}+tadj)&7)<<11)` : `${t << 11}`);
  const fdiv = (x, y) => `(${y}==0&&${x}!=0&&${x}==${x}?fsw|=4:0);`;
  const ari = (reg, x, y) => [`${x}+${y}`, `${x}*${y}`, null, null, `${x}-${y}`, `${y}-${x}`, `${x}/${y}`, `${y}/${x}`][reg];
  const divCheck = (reg, x, y) => (reg === 6 ? fdiv(x, y) : reg === 7 ? fdiv(y, x) : '');
  const setcc = (a, b) => `d0=${b};d1=${a};fsw&=~0x4500;if(d0!=d0||d1!=d1)fsw|=0x4500;else if(d1<d0)fsw|=0x100;else if(d1==d0)fsw|=0x4000;`;
  let delta = 0, text = '', gen;
  if (!mr.isReg) {
    const a = `ta=${segb(mr.seg)}+${mr.ea};`;
    const mt = mr.text;
    // FIST/FISTP under the control word's rounding (fround, as src/fpu.js toInt); a value that does
    // not fit stores the integer indefinite and raises IE.
    const fist = (t, bits) => (bits === 16
      ? `${a}t0=fi16(${P(t, 0)},fcw);if(t0>0xffff){fsw|=1;t0=0x8000;}RW(ta)=t0&0xffff;`
      : `${a}d0=fround(${P(t, 0)},fcw);if(d0>=-2147483648.0&&d0<2147483648.0)RL(ta)=(int)d0;else{fsw|=1;RL(ta)=(int)0x80000000u;}`);
    if (op === 0xdf && mr.reg === 0) { delta = -1; text = `fild word ${mt}`; gen = (t) => `${a}${P(t, -1)}=(double)RS(ta);`; }
    else if (op === 0xdf && (mr.reg === 2 || mr.reg === 3)) { delta = mr.reg === 3 ? 1 : 0; text = `fist${mr.reg === 3 ? 'p' : ''} word ${mt}`; gen = (t) => fist(t, 16); }
    else if (op === 0xdb && mr.reg === 0) { delta = -1; text = `fild dword ${mt}`; gen = (t) => `${a}${P(t, -1)}=(double)RL(ta);`; }
    else if (op === 0xdb && (mr.reg === 2 || mr.reg === 3)) { delta = mr.reg === 3 ? 1 : 0; text = `fist${mr.reg === 3 ? 'p' : ''} dword ${mt}`; gen = (t) => fist(t, 32); }
    else if (op === 0xd9 && mr.reg === 0) { delta = -1; text = `fld dword ${mt}`; gen = (t) => `${a}${P(t, -1)}=(double)RF(ta);`; }
    else if (op === 0xd9 && (mr.reg === 2 || mr.reg === 3)) { delta = mr.reg === 3 ? 1 : 0; text = `fst${mr.reg === 3 ? 'p' : ''} dword ${mt}`; gen = (t) => `${a}RF(ta)=(float)${P(t, 0)};`; }
    else if (op === 0xdd && mr.reg === 0) { delta = -1; text = `fld qword ${mt}`; gen = (t) => `${a}${P(t, -1)}=RD(ta);`; }
    else if (op === 0xdd && (mr.reg === 2 || mr.reg === 3)) { delta = mr.reg === 3 ? 1 : 0; text = `fst${mr.reg === 3 ? 'p' : ''} qword ${mt}`; gen = (t) => `${a}RD(ta)=${P(t, 0)};`; }
    else if (op === 0xd9 && mr.reg === 5) { text = `fldcw ${mt}`; gen = () => `${a}fcw=RW(ta);if((fcw&0x300)!=0x300&&(fcw&0x300)!=0x200){printf("${hex(ip0)}: fldcw: precision control %x\\n",(fcw>>8)&3);return 5;}`; }
    else if (op === 0xd9 && mr.reg === 7) { text = `fnstcw ${mt}`; gen = () => `${a}RW(ta)=fcw;`; }
    else if (op === 0xdd && mr.reg === 7) { text = `fnstsw ${mt}`; gen = (t) => `${a}RW(ta)=(fsw&0x47ff)|${T11(t)};`; }
    else if (op === 0xd8 || op === 0xde || op === 0xda || op === 0xdc) {
      const load = { 0xd8: '(double)RF(ta)', 0xde: '(double)RS(ta)', 0xda: '(double)RL(ta)', 0xdc: 'RD(ta)' }[op];
      const nm = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'][mr.reg];
      text = `${op === 0xde || op === 0xda ? 'fi' + nm.slice(1) : nm} ${{ 0xd8: 'dword', 0xde: 'word', 0xda: 'dword', 0xdc: 'qword' }[op]} ${mt}`;
      if (mr.reg === 2 || mr.reg === 3) {
        delta = mr.reg === 3 ? 1 : 0;
        gen = (t) => `${a}${setcc(P(t, 0), load)}`;
      } else gen = (t) => `${a}d0=${load};${divCheck(mr.reg, P(t, 0), 'd0')}${P(t, 0)}=${ari(mr.reg, P(t, 0), 'd0')};`;
    } else refuse(ip0, `x87 ${hex(op, 2)} /${mr.reg} memory`);
  } else {
    const b = 0xc0 | (mr.reg << 3) | mr.rm, i = mr.rm;
    if (op === 0xd9 && b < 0xc8) { delta = -1; text = `fld st${i}`; gen = (t) => `${P(t, -1)}=${P(t, i)};`; }
    else if (op === 0xd9 && b < 0xd0) { text = `fxch st${i}`; gen = (t) => `d0=${P(t, 0)};${P(t, 0)}=${P(t, i)};${P(t, i)}=d0;`; }
    else if (op === 0xd9 && b === 0xd0) { text = 'fnop'; gen = () => ''; }
    else if (op === 0xd9 && FCONST[b] !== undefined) { delta = -1; text = `fld const ${hex(b, 2)}`; gen = (t) => `${P(t, -1)}=${lit(FCONST[b])};`; }
    else if (op === 0xd9 && b === 0xe0) { text = 'fchs'; gen = (t) => `${P(t, 0)}=-${P(t, 0)};`; }
    else if (op === 0xd9 && b === 0xe1) { text = 'fabs'; gen = (t) => `${P(t, 0)}=fabs(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xe4) { text = 'ftst'; gen = (t) => setcc(P(t, 0), '0.0'); }
    else if (op === 0xd9 && b === 0xf0) { text = 'f2xm1'; gen = (t) => `${P(t, 0)}=expm1(${P(t, 0)}*0.6931471805599453);`; }
    else if (op === 0xd9 && b === 0xf1) { delta = 1; text = 'fyl2x'; gen = (t) => `${P(t, 1)}=${P(t, 1)}*log2(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xf2) { delta = -1; text = 'fptan'; gen = (t) => `${trig(P(t, 0))}${P(t, 0)}=tan(${P(t, 0)});${P(t, -1)}=1.0;`; }
    else if (op === 0xd9 && b === 0xf3) { delta = 1; text = 'fpatan'; gen = (t) => `${P(t, 1)}=atan2(${P(t, 1)},${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xfa) { text = 'fsqrt'; gen = (t) => `${P(t, 0)}=sqrt(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xfb) { delta = -1; text = 'fsincos'; gen = (t) => `d0=${P(t, 0)};${trig('d0')}${P(t, 0)}=sin(d0);${P(t, -1)}=cos(d0);`; }
    else if (op === 0xd9 && b === 0xfc) { text = 'frndint'; gen = (t) => `${P(t, 0)}=fround(${P(t, 0)},fcw);`; }
    else if (op === 0xd9 && b === 0xfd) { text = 'fscale'; gen = (t) => `${P(t, 0)}=${P(t, 0)}*pow(2.0,trunc(${P(t, 1)}));`; }
    else if (op === 0xd9 && b === 0xfe) { text = 'fsin'; gen = (t) => `${trig(P(t, 0))}${P(t, 0)}=sin(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xff) { text = 'fcos'; gen = (t) => `${trig(P(t, 0))}${P(t, 0)}=cos(${P(t, 0)});`; }
    else if (op === 0xd8) {
      const nm = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'][mr.reg]; text = `${nm} st0,st${i}`;
      if (mr.reg === 2 || mr.reg === 3) { delta = mr.reg === 3 ? 1 : 0; gen = (t) => setcc(P(t, 0), P(t, i)); }
      else gen = (t) => `d0=${P(t, 0)};d1=${P(t, i)};${divCheck(mr.reg, 'd0', 'd1')}${P(t, 0)}=${ari(mr.reg, 'd0', 'd1')};`;
    } else if (op === 0xde && b === 0xd9) {
      delta = 2; text = 'fcompp'; gen = (t) => setcc(P(t, 0), P(t, 1));
    } else if (op === 0xdc || op === 0xde) {
      // To ST(i), the "reversed" encodings exactly as MIRAGE's arithE(reg, ST0, STi) reads them.
      if (mr.reg === 2 || mr.reg === 3) {
        if (op === 0xde) refuse(ip0, `x87 de ${hex(b, 2)}`);
        delta = mr.reg === 3 ? 1 : 0; text = `fcom${mr.reg === 3 ? 'p' : ''} st${i}`; gen = (t) => setcc(P(t, 0), P(t, i));
      } else {
        const nm = ['fadd', 'fmul', '', '', 'fsubr', 'fsub', 'fdivr', 'fdiv'][mr.reg];
        delta = op === 0xde ? 1 : 0; text = `${nm}${op === 0xde ? 'p' : ''} st${i},st0`;
        gen = (t) => `d0=${P(t, 0)};d1=${P(t, i)};${divCheck(mr.reg, 'd0', 'd1')}${P(t, i)}=${ari(mr.reg, 'd0', 'd1')};`;
      }
    } else if (op === 0xdd && b >= 0xd0 && b < 0xe0) {
      delta = b >= 0xd8 ? 1 : 0; text = `fst${b >= 0xd8 ? 'p' : ''} st${i}`; gen = (t) => `${P(t, i)}=${P(t, 0)};`;
    } else if (op === 0xdd && b >= 0xe0 && b < 0xf0) {
      delta = b >= 0xe8 ? 1 : 0; text = `fucom${b >= 0xe8 ? 'p' : ''} st${i}`; gen = (t) => setcc(P(t, 0), P(t, i));
    } else if (op === 0xda && b === 0xe9) {
      delta = 2; text = 'fucompp'; gen = (t) => setcc(P(t, 0), P(t, 1));
    } else if (op === 0xdf && b < 0xc8) {
      delta = 1; text = `ffreep st${i}`; gen = () => '';
    } else if (op === 0xdb && b === 0xe3) {
      text = 'fninit'; R.fninit = true; gen = (t) => (t === 'dyn' ? 'fsw=0;fcw=0x37f;ft=0;F[0]=F[1]=F[2]=F[3]=F[4]=F[5]=F[6]=F[7]=0;' : `fsw=0;fcw=0x37f;p0=p1=p2=p3=p4=p5=p6=p7=0;${R.tadj ? 'tadj=0;' : ''}`);
    } else if (op === 0xdb && b === 0xe2) {
      text = 'fnclex'; gen = () => 'fsw&=~0xff;';
    } else if (op === 0xdf && b === 0xe0) {
      text = 'fnstsw ax'; gen = (t) => `ax=(fsw&0x47ff)|${T11(t)};`;
    } else refuse(ip0, `x87 ${hex(op, 2)} ${hex(b, 2)}`);
  }
  R.text = text; R.fpu = delta; R.gen = (live, top) => ({ c: gen(top) + (top === 'dyn' && delta ? `ft=(ft+${delta})&7;` : '') });
  return R;
}
// C2 = out of range, as MIRAGE's ftrigCC. Two compares rather than fabs(), which PRISM once emitted as
// a call through its runtime object (tools/recomp/run.mjs).
const trig = (x) => `fsw=(fsw&~0x600)|((${x})>=9223372036854775808.0||(${x})<=-9223372036854775808.0?0x400:0);`;

// ---------------------------------------------------------------------------------------------

/**
 * Translate a .COM image. `state` is the entry state (registers in x86 order, segments, flags, and
 * the memory the program finds beside its image: ivt = linear 0..4FFh, psp) as MIRAGE's DOS loader
 * leaves it. Options: `volatile` (code offsets read as data), `platform` ({ beam, dac13 } from MIRAGE,
 * tools/recomp/oracle.mjs), `sync` ('auto': in a program with no frame point of its own, the head
 * of its outermost loop becomes one).
 */
export function translateCom(com, state, opts = {}) {
  const { count = true, name = 'prog', structured = true, volatile = null, platform = null, sync = 'auto', syncAt = null } = opts;
  // The code: the .COM image at 100h, or (a snapshot, tools/recomp/oracle.mjs) the whole code
  // segment as MIRAGE's memory held it at the snapshot.
  const snap = opts.snapshot ?? null;
  const m = new Uint8Array(0x10000);
  if (snap) for (let k = 0; k < 0x10000; k++) m[k] = snap.mem[(state.seg[1] * 16 + k) & 0xfffff];
  else m.set(com, 0x100);
  const imageStart = snap ? 0 : 0x100, imageEnd = snap ? 0x10000 : 0x100 + com.length;
  const vol = volatile && volatile.size ? volatile : null;
  // 1. Discovery: every node (instruction in a call context) reachable along static edges.
  const decoded = new Map();
  const dec = (ip) => {
    if (!decoded.has(ip)) {
      // Code outside the image is memory the program wrote at run time, or a path never taken (an
      // intro whose last LOOP falls off its end): reaching it stops the program.
      if (ip < imageStart || ip >= imageEnd) decoded.set(ip, { ip, len: 1, kind: 'outside', use: 0, def: 0, maybe: 0, undef: 0, fpu: null, text: 'outside the image' });
      else decoded.set(ip, translateInsn(m, ip, vol, state.flags, opts));
    }
    return decoded.get(ip);
  };
  const nodes = [];
  const byKey = new Map();
  const nodeOf = (ctx, ip) => {
    const k = `${ctx.join(',')}|${ip}`;
    let id = byKey.get(k);
    if (id === undefined) { id = nodes.length; byKey.set(k, id); nodes.push({ id, ip, ctx, R: null, succ: null }); work.push(id); }
    return id;
  };
  const work = [];
  const retCandidates = [];
  if (snap) {
    const ssb = state.seg[2] * 16, csb = state.seg[1] * 16;
    for (let k = 0; k < 32; k++) {
      const a = snap.mem[(ssb + ((state.reg[4] + 2 * k) & 0xffff)) & 0xfffff] | (snap.mem[(ssb + ((state.reg[4] + 2 * k + 1) & 0xffff)) & 0xfffff] << 8);
      const at = (x) => snap.mem[(csb + (x & 0xffff)) & 0xfffff];
      const afterCall = at(a - 3) === 0xe8 || (at(a - 2) === 0xff && ((at(a - 1) >> 3) & 7) === 2 && (at(a - 1) >> 6) === 3);
      if (afterCall && !retCandidates.includes(a)) retCandidates.push(a);
    }
  }
  const entry = nodeOf([], state.eip);
  while (work.length) {
    const N = nodes[work.pop()];
    const R = dec(N.ip);
    N.R = R;
    const next = (N.ip + R.len) & 0xffff;
    if (R.kind === 'op') N.succ = [nodeOf(N.ctx, next)];
    else if (R.kind === 'jcc' || R.kind === 'loop' || R.kind === 'jcxz') N.succ = [nodeOf(N.ctx, next), nodeOf(N.ctx, R.target)];
    else if (R.kind === 'jmp') N.succ = [nodeOf(N.ctx, R.target)];
    else if (R.kind === 'call') {
      if (N.ctx.includes(next)) refuse(N.ip, 'recursive call');
      if (N.ctx.length >= 8) refuse(N.ip, 'calls nested more than 8 deep');
      N.ret = next;
      N.succ = [nodeOf([...N.ctx, next], R.target)];
    } else if (R.kind === 'ret' && N.ctx.length) {
      N.ret = N.ctx[N.ctx.length - 1];
      N.succ = [nodeOf(N.ctx.slice(0, -1), N.ret)];
    } else if (R.kind === 'ret' && snap) {
      // A RET past every call this translation saw: in a snapshot, into a caller that called before
      // it. Its candidates are the words on the snapshot's stack that follow a near CALL; the C
      // compares the popped word with each, and any other stops the program.
      N.succ = retCandidates.map((a) => nodeOf([], a));
    } else N.succ = [];        // ret to the PSP, exit: leave the program
  }
    // Instructions may overlap (paralaxa jumps into the middle of one): each decoding is its own node,
  // and the guard covers the bytes of both.
  // 2. Flag liveness, backward to a fixed point. A conditional ("maybe") definition is a use.
  const liveIn = new Array(nodes.length).fill(0), liveOut = new Array(nodes.length).fill(0);
  for (let changed = true; changed;) {
    changed = false;
    for (let k = nodes.length - 1; k >= 0; k--) {
      const N = nodes[k], R = N.R;
      let out = 0;
      for (const s of N.succ) out |= liveIn[s];
      const inn = R.use | R.maybe | (out & ~R.def);
      if (out !== liveOut[k] || inn !== liveIn[k]) { liveOut[k] = out; liveIn[k] = inn; changed = true; }
    }
  }
  for (const N of nodes) {
    if (!(liveOut[N.id] & N.R.undef)) continue;
    if (!opts.optimisticShift && [...decoded.values()].some((R) => /,cl$/.test(R.text) && /^(rol|ror|rcl|rcr|shl|shr|sal|sar) /.test(R.text))) return translateCom(com, state, { ...opts, optimisticShift: true });
    refuse(N.ip, `${N.R.text} leaves a flag undefined (mask ${hex(N.R.undef & liveOut[N.id], 3)}) that a later instruction reads`);
  }
  // 3. The x87 stack top, forward. A path that has not run FNINIT yet has an unknown top (null); two
  // paths that disagree give a conflict (-1). Either is fine where no x87 instruction reads it before
  // the next FNINIT (lattice's pixel loop re-enters its head with three values left on the stack and
  // resets it there); an x87 instruction that meets one is refused.
  const top = new Map();
  // MIRAGE starts a program with the x87 reset (top 0, empty registers that read as 0).
  // ROTATION (fpuRot, the retry when an x87 instruction meets a conflict): where two paths bring
  // different tops, the second keeps the first one's, and its edge renames the eight registers
  // (a rotation: the x87 stack is a ring of eight) -- the stack stays static, the cost is on that edge.
  // TOP itself, which FNSTSW reports, is kept right by `tadj`, the rotations made since FNINIT.
  const rot = new Map();      // "from>to" -> [top the edge brings, top the node keeps]
  const fw = [[entry, state.ftop ?? null, -1]];
  while (fw.length) {
    const [id, t, from] = fw.pop();
    const N = nodes[id], R = N.R;
    if (opts.fpuDyn) { if (!top.has(id)) { top.set(id, 'dyn'); for (const s of N.succ) fw.push([s, 'dyn', id]); } continue; }
    let tin = t;
    if (top.has(id)) {
      const was = top.get(id);
      if (was === t || was === -1) continue;
      if (opts.fpuRot && typeof t === 'number' && typeof was === 'number') { rot.set(`${from}>${id}`, [t, was]); continue; }
      tin = -1;
    }
    top.set(id, tin);
    let tout = tin;
    if (R.fninit) tout = 0;
    else if (R.fpu !== null) {
      if ((tin === null || tin < 0) && !opts.fpuDyn && !opts.fpuRot && tin !== null) return translateCom(com, state, { ...opts, [process.env.RC_FPUDYN ? 'fpuDyn' : 'fpuRot']: true });
      if (tin === null || tin < 0) refuse(N.ip, tin === null ? 'x87 use before FNINIT: the stack top is unknown' : 'the x87 stack top differs between the paths that reach this instruction');
      tout = (tin + R.fpu) & 7;
    }
    for (const s of N.succ) fw.push([s, tout, id]);
  }
  if (rot.size) for (const N of nodes) if (N.R.fpu !== null || N.R.fninit) N.R.tadj = true;
  const rotCode = (from, to) => {
    const r = rot.get(`${from}>${to}`);
    if (!r) return '';
    const [tf, tt] = r;
    let c = '';
    for (let i = 0; i < 8; i++) c += `r${i}=p${(tf + i) & 7};`;
    for (let i = 0; i < 8; i++) c += `p${(tt + i) & 7}=r${i};`;
    return `${c}tadj=(tadj+${(tf - tt) & 7})&7;`;
  };
  // 3b. DF, forward, the same way: CLD and STD set it, everything else keeps it; a string
  // instruction where the paths disagree is refused. (POPF of DF=1 stops the program at run time.)
  const dfAt = new Map();
  const fd = [[entry, (state.flags >> 10) & 1]];
  while (fd.length) {
    const [id, f] = fd.pop();
    const N = nodes[id], R = N.R;
    let fin = f;
    if (dfAt.has(id)) { const was = dfAt.get(id); if (was === f || was === -1) continue; fin = -1; }
    dfAt.set(id, fin);
    if (R.string && fin < 0) refuse(N.ip, 'DF differs between the paths that reach this string instruction');
    const fout = R.setDf ?? fin;
    for (const s of N.succ) fd.push([s, fout]);
  }
  // 4. Basic blocks: leaders are the entry, every branch target, and what follows a branch.
  const leaders = new Set([entry]);
  const preds = new Array(nodes.length).fill(0);
  for (const N of nodes) for (const s of N.succ) preds[s]++;
  for (const N of nodes) {
    if (N.R.kind !== 'op') for (const s of N.succ) leaders.add(s);
    else if (preds[N.succ[0]] > 1) leaders.add(N.succ[0]);
  }
  for (const N of nodes) if (preds[N.id] !== 1 && N.id !== entry) leaders.add(N.id);
  const blocks = new Map();
  const frameIns = [];        // the instructions that are frame points (port 60h, INT 16h)
  for (const L of leaders) {
    const blk = [];
    for (let id = L; ;) {
      const N = nodes[id];
      blk.push(N);
      if (N.R.kind !== 'op' || leaders.has(N.succ[0])) break;
      id = N.succ[0];
    }
    blocks.set(L, { ip: nodes[L].ip, nodes: blk, n: blk.length, succ: blk[blk.length - 1].succ });
  }
  const inLoop = cyclicBlocks(blocks, (b) => blockSucc(blocks.get(b)));
  // The guard: the bytes of every instruction on a cycle, minus the volatile immediates.
  const guardSet = new Set();
  for (const [L, b] of blocks) if (inLoop.has(L)) for (const N of b.nodes) for (let k = 0; k < N.R.len; k++) { const a = (N.ip + k) & 0xffff; if (!vol || !vol.has(a)) guardSet.add(a); }
  // Frame points: a read of port 60h (or of DX) and INT 16h. A program with none gets one at the
  // head of its outermost loop (sync 'auto').
  for (const N of nodes) if (N.R.io && (/in a[lx],(0x60|dx)/.test(N.R.text) || N.R.text === 'int 0x16')) frameIns.push(N.ip);
  if (sync === 'auto' && !frameIns.length && syncAt === null) {
    const loops = findLoops(blocks, entry);
    const insnsOf = (L) => [...L.body].reduce((k, b) => k + blocks.get(b).n, 0);
    const outer = [...loops.values()].filter((L) => !L.parent).sort((a, b) => insnsOf(b) - insnsOf(a))[0];
    if (!outer) refuse(state.eip, 'no loop and no frame point');
    return translateCom(com, state, { ...opts, syncAt: outer.header });
  }
  const needIc = count || syncAt !== null || [...decoded.values()].some((R) => R.io);
  let synth = 0;
  const N_ip = (b) => b.ip;
  for (const [L, b] of [...blocks]) {
    const lines = [];
    if (L === syncAt) lines.push('rc_ic=ic;if(rc_guard(csb))return 4;if(rc_sync())return 0;      /* frame point: the head of the main loop */');
    if (needIc) lines.push(`ic+=${b.n};`);
    let term = null;
    b.nodes.forEach((N, k) => {
      const R = N.R;
      let c = R.gen ? R.gen(liveOut[N.id], top.get(N.id), dfAt.get(N.id)).c : '';
      c = c.replace('ICK', `${k - b.n}`);   // the instructions of this block not yet retired
      const last = k === b.n - 1;
      const [fall, taken] = N.succ;
      if (R.kind === 'jcc' || R.kind === 'jcxz') term = { kind: 'cond', cond: R.cond, taken, fall };
      else if (R.kind === 'loop') { c = 'cx=(cx-1)&0xffff;'; term = { kind: 'cond', cond: R.cond, taken, fall }; }
      else if (R.kind === 'jmp') term = { kind: 'go', to: N.succ[0] };
      else if (R.kind === 'call') { c = push16(N.ret); term = { kind: 'go', to: N.succ[0] }; }
      else if (R.kind === 'ret' && N.ctx.length) {
        c = `t0=RW(ssb+sp);sp=(sp+${2 + R.imm})&0xffff;if(t0!=${N.ret}){printf("${hex(N.ip)}: ret to %04x, not to its call\\n",t0);return 3;}`;
        term = { kind: 'go', to: N.succ[0] };
      } else if (R.kind === 'ret' && snap) {
        c = `t0=RW(ssb+sp);sp=(sp+${2 + R.imm})&0xffff;`;
        term = { kind: 'multi', cases: N.succ.map((id) => [nodes[id].ip, id]), fail: `if(t0==0)return 0;printf("${hex(N.ip)}: ret to %04x: no such return site\\n",t0);return 3;` };
      } else if (R.kind === 'ret') term = { kind: 'exit', c: 't0=RW(ssb+sp);sp=(sp+2)&0xffff;if(t0==0)return 0;printf("ret to %04x: no such return site\\n",t0);return 3;' };
      else if (R.kind === 'exit') term = { kind: 'exit', c: 'return 0;' };
      else if (R.kind === 'outside') { c = ''; term = { kind: 'exit', c: `printf("${hex(N.ip)}: reached code outside the image\\n");return 3;` }; }
      else if (R.kind === 'exit21') term = { kind: 'exit', c: `if((ax>>8)==0x4c)return 0;printf("${hex(N.ip)}: int 21h ah=%02x where the exit was expected\\n",ax>>8);return 3;` };
      else if (last) term = { kind: 'go', to: N.succ[0] };
      const tag = `${hex(N.ip)}${N.ctx.length ? `@${N.ctx.map((x) => hex(x)).join('/')}` : ''}`;
      lines.push(`${c}${' '.repeat(Math.max(1, 72 - c.length))}/* ${tag} ${R.text} */`);
    });
    b.lines = lines; b.term = term;
    if (rot.size) {
      const last = b.nodes[b.n - 1].id;
      if (term.kind === 'cond') { term.takenPre = rotCode(last, term.taken) || undefined; term.fallPre = rotCode(last, term.fall) || undefined; }
      else if (term.kind === 'go') term.toPre = rotCode(last, term.to) || undefined;
      else if (term.kind === 'multi' && term.cases.some(([, id]) => rotCode(last, id))) refuse(b.ip, 'an x87 rotation on a return to a caller from before the snapshot');
    }
    if (term.kind === 'multi') {
      // A multi-way branch as a chain of two-way ones: synthetic blocks `t0==A ? A : next`.
      let at = b;
      term.cases.forEach(([v, id], k) => {
        const nid = nodes.length + synth++;
        const last = k === term.cases.length - 1;
        at.term = { kind: 'cond', cond: `(t0==${v})`, taken: id, fall: nid };
        at.succ = blockSucc(at);
        const nb = { ip: N_ip(b), nodes: [], n: 0, lines: [], synthetic: true };
        blocks.set(nid, nb);
        at = nb;
        if (last) { nb.term = { kind: 'exit', c: term.fail }; nb.succ = []; }
      });
      if (!term.cases.length) { b.term = { kind: 'exit', c: term.fail }; b.succ = []; }
      continue;
    }
    b.succ = blockSucc(b);
  }
  let body = null, mode = 'goto', structureRefused = null;
  if (structured) {
    try { body = emitStructured(singleExitLoops(blocks, entry), entry); mode = 'structured'; } catch (e) { if (!(e instanceof Refused)) throw e; structureRefused = e.message; }
  }
  if (!body) body = emitGotos(blocks, entry);
  // No FLDCW anywhere: the rounding control is the reset's (nearest) for the whole run, so FIST and
  // FRNDINT round without consulting it (tube's two FISTPs a pixel: 3.7 -> 3.0 ms a frame in PRISM).
  if (![...decoded.values()].some((R) => /^fldcw/.test(R.text))) body = body.map((l) => l.replace(/fi16\(([^;]*?),fcw\)/g, 'fi16n($1)').replace(/fround\(([^;]*?),fcw\)/g, 'frnear($1)'));
  const c = cSource({ name, state, image: snap ? Array.from(m) : Array.from(com), base: imageStart, body, guard: [...guardSet].sort((a, b) => a - b), platform, needIc, snap });
  return { c, nodes, decoded, fpuRot: rot.size, fpuDyn: !!opts.fpuDyn, optimisticShift: !!opts.optimisticShift, nInsns: decoded.size, nNodes: nodes.length, nBlocks: blocks.size, mode, structureRefused, frameIns, syncAt: syncAt === null ? null : nodes[syncAt].ip, guardBytes: guardSet.size };
}

function blockSucc(b) {
  const t = b.term;
  if (!t) { const N = b.nodes[b.n - 1]; return N.succ; }
  return t.kind === 'cond' ? [t.taken, t.fall] : t.kind === 'go' ? [t.to] : [];
}

/** The blocks on a cycle (Tarjan's strongly connected components of size > 1, or a self-loop). */
function cyclicBlocks(blocks, succ) {
  const index = new Map(), low = new Map(), on = new Set(), st = [], out = new Set();
  let n = 0;
  const visit = (v) => {
    index.set(v, n); low.set(v, n); n++; st.push(v); on.add(v);
    for (const w of succ(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      for (let w; w !== v;) { w = st.pop(); on.delete(w); comp.push(w); }
      if (comp.length > 1 || succ(v).includes(v)) for (const w of comp) out.add(w);
    }
  };
  for (const v of blocks.keys()) if (!index.has(v)) visit(v);
  return out;
}

/** Every block a top-level label, every edge a goto: PRISM emits it as its goto state machine. */
function emitGotos(blocks, entry) {
  const out = [`goto L_${entry};`];
  const order = [...blocks.keys()].sort((a, b) => a - b);
  order.forEach((id, k) => {
    const b = blocks.get(id), next = order[k + 1];
    out.push(`L_${id}:`, ...b.lines.map((l) => `  ${l}`));
    const t = b.term;
    if (t.kind === 'cond') out.push(`  if(${t.cond}){${t.takenPre ?? ''}goto L_${t.taken};}${t.fallPre ?? ''}${t.fall === next && !t.fallPre ? '' : `goto L_${t.fall};`}`);
    else if (t.kind === 'go') { if (t.toPre) out.push(`  ${t.toPre}`); if (t.to !== next || t.toPre) out.push(`  goto L_${t.to};`); }
    else out.push(`  ${t.c}`);
  });
  return out;
}

/** Dominators, and the natural loops (one per header) of a reducible block graph. */
function findLoops(blocks, entry) {
  const ids = [...blocks.keys()];
  const ipOf = (b) => blocks.get(b).ip;
  const preds = new Map(ids.map((b) => [b, []]));
  for (const b of ids) for (const s of blocks.get(b).succ) preds.get(s).push(b);
  const rpo = []; const seen = new Set();
  const dfs = (b) => { seen.add(b); for (const s of blocks.get(b).succ) if (!seen.has(s)) dfs(s); rpo.unshift(b); };
  dfs(entry);
  const dom = new Map(rpo.map((b) => [b, b === entry ? new Set([b]) : new Set(rpo)]));
  for (let ch = true; ch;) {
    ch = false;
    for (const b of rpo) {
      if (b === entry) continue;
      let d = null;
      for (const p of preds.get(b)) { if (!dom.has(p)) continue; d = d ? new Set([...d].filter((x) => dom.get(p).has(x))) : new Set(dom.get(p)); }
      d.add(b);
      if (d.size !== dom.get(b).size) { dom.set(b, d); ch = true; }
    }
  }
  const loops = new Map();
  const index = new Map(rpo.map((b, i) => [b, i]));
  for (const u of rpo) for (const h of blocks.get(u).succ) {
    if (index.get(h) > index.get(u)) continue;
    if (!dom.get(u).has(h)) refuse(ipOf(u), 'irreducible control flow');
    const L = loops.get(h) ?? { header: h, body: new Set([h]) };
    const st = [u];
    while (st.length) { const x = st.pop(); if (!L.body.has(x)) { L.body.add(x); st.push(...preds.get(x)); } }
    loops.set(h, L);
  }
  const sorted = [...loops.values()].sort((a, b) => a.body.size - b.body.size);
  for (const L of sorted) L.parent = sorted.find((M) => M !== L && M.body.size > L.body.size && M.body.has(L.header)) ?? null;
  return loops;
}

/**
 * Structured C: loops as for(;;) with continue/break, two-way branches as if/else joined at their
 * immediate post-dominator. No label survives, so PRISM emits real JavaScript loops instead of its
 * goto state machine (src/backend/emit.js: a label must be top-level, and one nested in a loop sends
 * the whole function through flatten.js). Refuses -- and the caller falls back to gotos -- on what
 * this does not cover: an irreducible graph, a loop with two exit targets, an exit from an inner loop
 * straight out of an outer one, or a block reached twice.
 */
/**
 * A loop with several exit targets made a loop with one: every exit edge u->t goes through a block
 * setting xs=k, to one dispatch block after the loop (xs==1 ? t1 : xs==2 ? t2 : ...). Innermost loops
 * first; the dispatch belongs to the enclosing loop, which may then have several exits in its turn.
 * Works on a copy: the goto fallback keeps the original blocks.
 */
function singleExitLoops(orig, entry) {
  const blocks = new Map([...orig].map(([k, b]) => [k, { ...b, term: { ...b.term }, succ: [...b.succ] }]));
  let next = Math.max(...blocks.keys()) + 1;
  // The edge's own code (xs=k) rides on the terminator: takenPre / fallPre / toPre.
  const retarget = (b, from, to, pre) => {
    const t = b.term;
    if (t.kind === 'cond') { if (t.taken === from) { t.taken = to; t.takenPre = (t.takenPre ?? '') + pre; } if (t.fall === from) { t.fall = to; t.fallPre = (t.fallPre ?? '') + pre; } }
    else if (t.kind === 'go' && t.to === from) { t.to = to; t.toPre = (t.toPre ?? '') + pre; }
    b.succ = blockSucc(b);
  };
  for (let round = 0; round < 64; round++) {
    const loops = findLoops(blocks, entry);
    const multi = [...loops.values()].sort((a, b) => a.body.size - b.body.size).find((L) => {
      const ex = new Set();
      for (const b of L.body) for (const t of blocks.get(b).succ) if (!L.body.has(t)) ex.add(t);
      L.exits = [...ex];
      return ex.size > 1;
    });
    if (!multi) return blocks;
    const ip = blocks.get(multi.header).ip;
    const D = next++;
    multi.exits.forEach((t, k) => {
      for (const u of multi.body) {
        const b = blocks.get(u);
        if (!b.succ.includes(t)) continue;
        retarget(b, t, D, `xs=${k};`);
      }
    });
    // The dispatch: a chain of two-way blocks, the last exit the final else.
    let at = D;
    const X = multi.exits;
    for (let k = 0; k + 1 < X.length; k++) {
      const nx = k + 2 === X.length ? X[k + 1] : next++;
      blocks.set(at, { ip, nodes: [], n: 0, lines: [], term: { kind: 'cond', cond: `(xs==${k})`, taken: X[k], fall: nx }, succ: [X[k], nx], synthetic: true });
      at = nx;
    }
  }
  refuse(blocks.get(entry).ip, 'loops whose exits do not reduce to one');
}

function emitStructured(blocks, entry) {
  const ids = [...blocks.keys()];
  const ipOf = (b) => blocks.get(b).ip;
  const loops = findLoops(blocks, entry);
  for (const L of loops.values()) {
    const ex = new Set();
    for (const b of L.body) for (const s of blocks.get(b).succ) if (!L.body.has(s)) ex.add(s);
    if (ex.size > 1) refuse(ipOf(L.header), `loop with ${ex.size} exit targets`);
    L.follow = ex.size ? [...ex][0] : null;
  }
  // Nesting: the innermost enclosing loop of each loop and block.
  const sorted = [...loops.values()].sort((a, b) => a.body.size - b.body.size);
  const loopOf = new Map();
  for (const b of ids) loopOf.set(b, sorted.find((L) => L.body.has(b)) ?? null);
  for (const L of sorted) for (const M of sorted) if (L !== M && L.body.has(M.header) && ![...M.body].every((x) => L.body.has(x))) refuse(ipOf(M.header), 'loops not nested');

  // Post-dominators of a region (a loop body, or the top level), on its collapsed graph: an inner
  // loop is one node whose successor is its follow; an edge to the header is CONT, to the follow BRK.
  const CONT = -1, BRK = -2, END = -3;
  const ipdomCache = new Map();
  function regionIpdom(L) {
    if (ipdomCache.has(L)) return ipdomCache.get(L);
    const inR = (b) => (L ? L.body.has(b) : true);
    const node = (b) => { let M = loopOf.get(b); while (M && M.parent !== L) M = M.parent; return M && M !== L ? M.header : b; };
    const nodes = new Set(ids.filter((b) => inR(b) && node(b) === b));
    const succ = (n) => {
      const M = loops.get(n);
      const outs = M && M !== L ? (M.follow === null ? [] : [M.follow]) : blocks.get(n).succ;
      const r = outs.map((s) => (L && s === L.header ? CONT : L && !inR(s) ? BRK : node(s)));
      return r.length ? r : [END];
    };
    const all = [...nodes, CONT, BRK, END];
    const ps = new Map(all.map((n) => [n, nodes.has(n) ? new Set(all) : new Set([n])]));
    ps.set(END, new Set([END]));
    for (const s of [CONT, BRK]) ps.set(s, new Set([s, END]));
    for (let ch = true; ch;) {
      ch = false;
      for (const n of nodes) {
        let d = null;
        for (const s of succ(n)) d = d ? new Set([...d].filter((x) => ps.get(s).has(x))) : new Set(ps.get(s));
        d.add(n);
        if (d.size !== ps.get(n).size) { ps.set(n, d); ch = true; }
      }
    }
    // The immediate post-dominator: the strict post-dominator that every other one post-dominates.
    const ip = new Map();
    for (const n of nodes) {
      const strict = [...ps.get(n)].filter((x) => x !== n);
      ip.set(n, strict.find((x) => strict.every((y) => ps.get(x).has(y))));
    }
    ipdomCache.set(L, ip);
    return ip;
  }

  const out = [];
  const emitted = new Set();
  let dup = 0;
  const ind = (d) => '  '.repeat(d);
  function edge(s, ctx, stop, d) {
    if (ctx.L && s === ctx.L.header) { out.push(`${ind(d)}continue;`); return; }
    if (ctx.L && s === ctx.L.follow) { out.push(`${ind(d)}break;`); return; }
    if (ctx.L && !ctx.L.body.has(s)) refuse(ipOf(s), 'an exit from an inner loop past its follow');
    if (stop.has(s)) return;
    region(s, ctx, stop, d);
  }
  function region(n, ctx, stop, d) {
    while (n !== null && !stop.has(n)) {
      const M = loops.get(n);
      if (M && M !== ctx.L && !ctx.inHeader) {
        if (M.parent !== ctx.L) refuse(ipOf(n), 'a loop entered from outside its parent');
        out.push(`${ind(d)}for (;;) {  /* loop ${hex(ipOf(n))} */`);
        region(n, { L: M, inHeader: true }, new Set(), d + 1);
        out.push(`${ind(d)}}`);
        if (M.follow === null) return;
        if (ctx.L && M.follow === ctx.L.header) { out.push(`${ind(d)}continue;`); return; }
        if (ctx.L && M.follow === ctx.L.follow) { out.push(`${ind(d)}break;`); return; }
        n = M.follow;
        continue;
      }
      ctx = { L: ctx.L, inHeader: false };
      // A block reached on two paths that do not join before it (a post-dominator further on): emitted
      // again on the second -- tail duplication, bounded.
      if (emitted.has(n)) { dup += blocks.get(n).lines.length + 1; if (dup > 4000) refuse(ipOf(n), 'a block reached twice, too often to duplicate'); }
      emitted.add(n);
      const b = blocks.get(n);
      out.push(`${ind(d)}/* ${hex(b.ip)} */`, ...b.lines.map((l) => ind(d) + l));
      const t = b.term;
      if (t.kind === 'exit') { out.push(ind(d) + t.c); return; }
      if (t.kind === 'go') {
        const s = t.to;
        if (t.toPre) out.push(ind(d) + t.toPre);
        if ((ctx.L && (s === ctx.L.header || s === ctx.L.follow)) || stop.has(s)) { edge(s, ctx, stop, d); return; }
        n = s; continue;
      }
      const m = regionIpdom(ctx.L).get(n);
      const join = m >= 0 ? m : null;
      const st2 = join === null ? stop : new Set([...stop, join]);
      const arm = (s, pre) => { const at = out.length; if (pre) out.push(ind(d + 1) + pre); edge(s, ctx, st2, d + 1); return out.splice(at); };
      const a = arm(t.taken, t.takenPre), e = arm(t.fall, t.fallPre);
      if (a.length) {
        out.push(`${ind(d)}if (${t.cond}) {`, ...a);
        out.push(e.length ? `${ind(d)}} else {` : `${ind(d)}}`);
        if (e.length) out.push(...e, `${ind(d)}}`);
      } else if (e.length) out.push(`${ind(d)}if (!(${t.cond})) {`, ...e, `${ind(d)}}`);
      n = join;
    }
  }
  region(entry, { L: null, inHeader: false }, new Set(), 0);
  for (const b of ids) if (!emitted.has(b)) { if (process.env.RC_DEBUG) console.log('unreached', b, JSON.stringify(blocks.get(b).term), blocks.get(b).synthetic, [...blocks].filter(([k, x]) => x.succ.includes(b)).map(([k]) => k), out.join('\n')); refuse(ipOf(b), 'a block the structured walk never reached'); }
  return out;
}

/** A snapshot's memory as the runs of non-zero bytes (gaps under 32 zeros kept), in one hex string. */
function snapSpans(mem) {
  const spans = [];
  let k = 0;
  const end = 0xb0000;                        // the conventional megabyte and the VGA window
  while (k < end) {
    while (k < end && !mem[k]) k++;
    if (k >= end) break;
    let e = k, z = 0;
    while (e < end && z < 32) { if (mem[e]) z = 0; else z++; e++; }
    spans.push([k, e - z - k]);
    k = e;
  }
  return spans;
}
function snapData(snap) {
  const spans = snapSpans(snap.mem);
  let off = 0;
  const rows = [], table = [];
  for (const [a, l] of spans) {
    table.push(`{${a},${l},${off}}`);
    const hexs = Buffer.from(snap.mem.subarray(a, a + l)).toString('hex');
    for (let i = 0; i < hexs.length; i += 160) rows.push(`  "${hexs.slice(i, i + 160)}"`);
    off += l * 2;
  }
  return `/* The machine as MIRAGE held it at the snapshot (instruction ${snap.count}): ${spans.length} runs of memory. */
static const int SNAPSPAN[][3] = { ${table.join(',') || '{0,0,0}'} };
static const char SNAPHEX[] =
${rows.join('\n') || '  ""'};
static const unsigned char SNAPDAC[768] = {
${byteRows(snap.dac)}
};
static int rc_hex(int c) { return c <= '9' ? c - '0' : c - 'a' + 10; }
`;
}
function snapRestore(snap) {
  const p = snap.pit;
  return `  /* The machine at the snapshot: low memory, video memory, the DAC (index 0 after it), the PIT, mode ${hex(snap.mode, 2)}h. */
  {
    int k, i;
    memset(MEM, 0, 0xb0000);
    for (k = 0; k < (int)(sizeof SNAPSPAN / sizeof SNAPSPAN[0]); k++)
      for (i = 0; i < SNAPSPAN[k][1]; i++) MEM[SNAPSPAN[k][0] + i] = (unsigned char)(rc_hex(SNAPHEX[SNAPSPAN[k][2] + 2 * i]) * 16 + rc_hex(SNAPHEX[SNAPSPAN[k][2] + 2 * i + 1]));
    rc_setmode(0x${hex(snap.mode | 0x80, 2)});
    rc_out(0x3c8, 0);
    for (i = 0; i < 768; i++) rc_out(0x3c9, SNAPDAC[i]);
    rc_pitMode = ${p.mode}; rc_pitAccess = ${p.access}; rc_pitTicks = ${p.ticks}; rc_pitLoad = ${p.load}; rc_pitReadHi = ${p.readHi}; rc_pitHiNext = ${p.hiNext}; rc_pitLo = ${p.lo ?? 0};
  }
`;
}

const byteRows = (bytes) => {
  const rows = [];
  for (let k = 0; k < bytes.length; k += 16) rows.push('  ' + bytes.slice(k, k + 16).map((b) => `0x${hex(b, 2)}`).join(',') + ',');
  return rows.join('\n');
};

/**
 * The C file. One source for two platforms, chosen when it is compiled (tools/recomp/rc.h):
 * RC_PRISM, PRISM's DJGPP environment, where guest memory is the image's own first megabyte; or the
 * native runtime (tools/recomp/native/rc_sdl.c, clang + SDL2), where it is an array.
 */
function cSource({ name, state, image, base, body, guard, platform, needIc, snap }) {
  // A local is declared only if the body names it: PRISM keeps a function whose locals include an
  // array (F[8]) or a 64-bit integer differently (measured: tube 3.0 -> 3.7 ms a frame with both
  // declared and unused).
  const text = body.join('\n');
  const uses = (re) => re.test(text);
  const r = state.reg, hi = state.regHi ?? [0, 0, 0, 0, 0, 0, 0, 0];
  const par = Array.from({ length: 256 }, (_, v) => { let p = 1; for (let x = v; x; x >>= 1) p ^= x & 1; return p; });
  // The guard as runs [offset, length] over the image.
  const runs = [];
  for (const a of guard) { const l = runs[runs.length - 1]; if (l && l[0] + l[1] === a) l[1]++; else runs.push([a, 1]); }
  const beam = platform?.beam;
  const dac13 = platform?.dac13 ?? new Array(768).fill(0);
  const ivt = state.ivt ?? null, psp = state.psp ?? null;
  return `/* ${name}: statically recompiled from x86 by MIRAGE tools/recomp/x86c.mjs. Do not edit. */
#define RC_PITBASE ${platform?.pitBase ?? 182584}
${beam ? `#define RC_VPERIOD ${beam.period}
#define RC_CBLANK ${beam.cBlank}
#define RC_CRS ${beam.cRS}
#define RC_CRE ${beam.cRE}
#define RC_CLINE ${lit(beam.cLine)}
#define RC_CHD ${lit(beam.cHD)}
` : '#define RC_VPERIOD 1\n#define RC_CBLANK 0\n#define RC_CRS 0\n#define RC_CRE 0\n#define RC_CLINE 1.0\n#define RC_CHD 1.0\n'}#include "rc.h"

static const unsigned char IMAGE[${image.length}] = {
${byteRows(image)}
};
${ivt ? `static const unsigned char LOWMEM[${ivt.length}] = {\n${byteRows(ivt)}\n};\n` : ''}${psp ? `static const unsigned char PSP[256] = {\n${byteRows(psp)}\n};\n` : ''}${snap ? snapData(snap) : ''}${!snap && state.dac ? `static const unsigned char ENTRYDAC[768] = {\n${byteRows(state.dac)}\n};\n` : ''}const unsigned char RC_DAC13[768] = {
${byteRows(dac13)}
};
static const unsigned char PAR[256] = { ${par.join(',')} };
double rc_ic;

/* Rounding to an integer under the x87 control word (src/fpu.js toInt): nearest-even, down, up, or
   toward zero. FIST m16: a value that does not fit (or NaN) answers 0x18000 so the caller stores the
   integer indefinite and raises IE. */
static double fround(double x, int fcw) {
  double fl, d;
  switch ((fcw >> 10) & 3) {
    case 1: return floor(x);
    case 2: return ceil(x);
    case 3: return trunc(x);
  }
  fl = floor(x); d = x - fl;
  return d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fmod(fl, 2.0) == 0 ? fl : fl + 1);
}
static double frnear(double x) {
  double fl = floor(x), d = x - fl;
  return d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fmod(fl, 2.0) == 0 ? fl : fl + 1);
}
static int fi16n(double x) {
  double fl = floor(x), d = x - fl, r = d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fmod(fl, 2.0) == 0 ? fl : fl + 1);
  if (r >= -32768.0 && r < 32768.0) return (int)r;
  return 0x18000;
}
static int fi16(double x, int fcw) {
  double r = fround(x, fcw);
  if (r >= -32768.0 && r < 32768.0) return (int)r;
  return 0x18000;
}

/* The code this file was translated from, where it can run again: a program that rewrote it would
   run stale C, so a frame point checks it and the program stops (exit 4) with the addresses. */
static const unsigned short GUARD[][2] = { ${runs.length ? runs.map(([a, l]) => `{${a},${l}}`).join(',') : '{0,0}'} };
static int rc_guard(int csb) {
  int k, i, bad = 0;
  for (k = 0; k < ${runs.length}; k++)
    for (i = 0; i < GUARD[k][1]; i++)
      if (MEM[csb + GUARD[k][0] + i] != IMAGE[GUARD[k][0] + i - ${base}]) { printf("self-modified code at %04x\\n", GUARD[k][0] + i); bad++; }
  return bad;
}

int rc_main(void) {
  int ax = ${r[0]}, cx = ${r[1]}, dx = ${r[2]}, bx = ${r[3]}, sp = ${r[4]}, bp = ${r[5]}, si = ${r[6]}, di = ${r[7]};
  int es = ${state.seg[0]}, cs = ${state.seg[1]}, ss = ${state.seg[2]}, ds = ${state.seg[3]}, fs = ${state.seg[4]}, gs = ${state.seg[5]};
  int esb = es << 4, csb = cs << 4, ssb = ss << 4, dsb = ds << 4, fsb = fs << 4, gsb = gs << 4;
  int fC = ${state.flags & 1}, fP = ${(state.flags >> 2) & 1}, fA = ${(state.flags >> 4) & 1}, fZ = ${(state.flags >> 6) & 1}, fS = ${(state.flags >> 7) & 1}, fO = ${(state.flags >> 11) & 1};
  double ${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `p${k} = ${snap ? lit(snap.fpu.st[k]) : '0'}`).join(', ')}, d0, d1;
  int xs = 0;
${uses(/\btadj\b/) ? `  int tadj = 0;\n  double r0, r1, r2, r3, r4, r5, r6, r7;\n` : ''}
  int fsw = ${snap ? snap.fpu.fsw : 0}, fcw = ${snap ? snap.fpu.fcw : 0x37f}, ta, t0, t1, t2, t3, t4, t5;
  unsigned ux, u0, u1, u2;
${uses(/\bq[0-3]\b/) ? '  long long q0, q2, q3;\n  unsigned long long q1;\n' : ''}${uses(/\bF\[/) ? `  double F[8] = { ${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (snap ? lit(snap.fpu.st[k]) : '0')).join(', ')} };\n  int ft = ${snap ? snap.fpu.ftop : (state.ftop ?? 0)};\n` : ''}
  int axh = ${hi[0]}, cxh = ${hi[1]}, dxh = ${hi[2]}, bxh = ${hi[3]}, bph = ${hi[5]}, sih = ${hi[6]}, dih = ${hi[7]};
  double ic = ${snap ? snap.count : 0};
  rc_regs rg;
  (void)cs; (void)csb; (void)fsb; (void)gsb; (void)fP; (void)fA; (void)fO; (void)fC; (void)fS; (void)fZ; (void)t0; (void)t1; (void)t2; (void)t3; (void)t4; (void)t5; (void)d0; (void)d1;
  (void)rg; (void)ta; (void)ux; (void)fsw; (void)fcw; (void)ic; (void)esb; (void)dsb; (void)ssb; (void)xs; (void)fround; (void)fi16; (void)frnear; (void)fi16n; (void)rc_guard; (void)PAR;
  (void)es; (void)ss; (void)ds; (void)fs; (void)gs; (void)ax; (void)bx; (void)cx; (void)dx; (void)si; (void)di; (void)bp; (void)sp;
  (void)u0; (void)u1; (void)u2; ${uses(/\bF\[/) ? '(void)F; (void)ft; ' : ''}${uses(/\bq[0-3]\b/) ? '(void)q0; (void)q1; (void)q2; (void)q3; ' : ''}(void)axh; (void)cxh; (void)dxh; (void)bxh; (void)bph; (void)sih; (void)dih;
  (void)p0; (void)p1; (void)p2; (void)p3; (void)p4; (void)p5; (void)p6; (void)p7;
${snap ? snapRestore(snap) : `  /* What the program finds beside its image: ${ivt ? 'the interrupt table and BIOS data area as MIRAGE leaves them, ' : ''}its PSP${psp ? ' (DOS\'s)' : ' (INT 20h)'}, the image at 100h, and the zero word DOS pushes for a RET to reach it. */
${state.dac ? '  { int i; rc_out(0x3c8, 0); for (i = 0; i < 768; i++) rc_out(0x3c9, ENTRYDAC[i]); }   /* the DAC as MIRAGE\'s BIOS left it */\n' : ''}${ivt ? '  memcpy(MEM, LOWMEM, sizeof LOWMEM);\n' : ''}${psp ? '  memcpy(MEM + csb, PSP, 0x100);\n' : '  memset(MEM + csb, 0, 0x100);\n  MEM[csb] = 0xcd; MEM[csb + 1] = 0x20;\n'}  memcpy(MEM + csb + 0x100, IMAGE, sizeof IMAGE);
  RW(ssb + sp) = 0;
`}${needIc ? '' : '  /* no instruction count: nothing reads it */\n'}${body.map((l) => `  ${l}`).join('\n')}
  return 0;
}
RC_ENTRY
`;
}
