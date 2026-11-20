// x86c.mjs — a static recompiler from 16-bit real-mode x86 to C, for PRISM to compile (ROADMAP:
// "Static recompilation, x86 to C, compiled by PRISM"). A feasibility spike: it is as small as the
// two targets allow (intros/tube.com and intros/lattice.com), and it REFUSES BY NAME everything it
// does not model, rather than guessing.
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
//   * each instruction is one C statement or a few; the blocks are emitted STRUCTURED (for(;;) loops,
//     if/else joined at the post-dominator, no label -- emitStructured), because a label makes PRISM
//     emit its goto state machine (a switch dispatch per jump: tube 1.7x slower); gotos remain the
//     fallback for a graph that does not structure;
//   * the flags are computed exactly as the SDM (and MIRAGE's recompiler) defines them, but only the
//     ones some later instruction can read: a backward liveness pass over the instruction graph
//     drops every dead flag, and refuses if an UNDEFINED flag (OF after a multi-bit shift, SF after
//     MUL...) could be read, since then the C would have to copy MIRAGE's choice for it;
//   * the hardware goes through a platform layer of four names (tools/recomp/rc.h): MEM, rc_in, rc_out,
//     rc_int. Under PRISM they are its DOS environment -- outportb/inportb (src/env/ports.js, the VGA
//     DAC src/env/vgadac.js) and __dpmi_int (src/env/go32.js); natively, tools/recomp/native/rc_sdl.c.
//     The same generated C builds for both, so a difference between them is PRISM's, not the
//     translator's.
//
// What it assumes, and checks where it can: the code is static (no instruction it translates is
// written at run time -- lattice keeps its clock in the immediate of `mov dx,3C8h` and stores FISTP
// results over `mov al,13h / int 10h`, but those run once, before; checked only by the frames
// matching), code and data may overlap (both read constants out of their own instructions: the
// image is loaded into guest memory as well as translated), DF stays 0, 16-bit operand and address
// size only (a 66h/67h prefix is refused), and RET only ever returns into the PSP's INT 20h (no CALL).

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800, ALL = CF | PF | AF | ZF | SF | OF;
const FNAME = { [CF]: 'fC', [PF]: 'fP', [AF]: 'fA', [ZF]: 'fZ', [SF]: 'fS', [OF]: 'fO' };
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const SREG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];
const hex = (n, w = 4) => n.toString(16).padStart(w, '0');

export class Refused extends Error {}
const refuse = (ip, what) => { throw new Refused(`${hex(ip)}: ${what}`); };

/** Decode one instruction at `ip` of the code segment image `m` (a 64 KB Uint8Array). */
function decode(m, ip0) {
  let ip = ip0;
  const b8 = () => m[ip++ & 0xffff];
  const s8 = () => (b8() << 24) >> 24;
  const w16 = () => b8() | (b8() << 8);
  let seg = null, rep = null;
  let op;
  for (;;) {
    op = b8();
    if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { seg = (op >> 3) & 3; continue; }
    if (op === 0x64 || op === 0x65) { seg = op - 0x60; continue; }
    if (op === 0xf3 || op === 0xf2) { rep = op; continue; }
    if (op === 0x66 || op === 0x67) refuse(ip0, '32-bit operand or address size prefix');
    if (op === 0xf0) refuse(ip0, 'LOCK');
    break;
  }
  const I = { ip: ip0, op, seg, rep };
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
    return { reg, rm, isReg: false, seg: s, ea: e, text: `[${SREG[s]}:${ea ?? ''}${disp ? (disp < 0 ? '-' : '+') + Math.abs(disp).toString(16) : ''}]` };
  };
  I.modrm = modrm;
  I.b8 = b8; I.s8 = s8; I.w16 = w16;
  return { I, end: () => ip, b8, s8, w16, modrm };
}

// ---------------------------------------------------------------------------------------------
// C fragments for operands
const r8get = (r) => (r < 4 ? `(${R16[r]}&0xff)` : `(${R16[r - 4]}>>8)`);
const r8set = (r, v) => (r < 4 ? `${R16[r]}=(${R16[r]}&0xff00)|(${v});` : `${R16[r - 4]}=(${R16[r - 4]}&0xff)|((${v})<<8);`);
const segb = (s) => `${SREG[s]}b`;

/** An operand: { get, set(v), pre } where `pre` computes the linear address into `ta` once. */
function operand(mr, w) {
  if (mr.isReg) {
    if (w === 8) return { pre: '', get: r8get(mr.rm), set: (v) => r8set(mr.rm, v), text: ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'][mr.rm] };
    return { pre: '', get: R16[mr.rm], set: (v) => `${R16[mr.rm]}=${v};`, text: R16[mr.rm] };
  }
  const pre = `ta=${segb(mr.seg)}+${mr.ea};`;
  if (w === 8) return { pre, get: 'MEM[ta]', set: (v) => `MEM[ta]=${v};`, text: `byte ${mr.text}`, mem: true };
  return { pre, get: 'RW(ta)', set: (v) => `RW(ta)=${v};`, text: `word ${mr.text}`, mem: true };
}
const regOp = (r, w) => operand({ isReg: true, rm: r }, w);
const immOp = (v) => ({ pre: '', get: `${v}`, set: null, text: `0x${v.toString(16)}`, imm: v });

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
  const name = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'test'][kind];
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
function shift(ip, kind, w, d, count, live) {
  const M = w === 8 ? 0xff : 0xffff, top = w - 1;
  const name = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'][kind];
  if (kind === 6) kind = 4;
  const sx = w === 8 ? 't0<<24>>24' : 't0<<16>>16';
  if (count === 'cl') {
    // A count of zero changes nothing, flags included, so the flags it may set are also USED:
    // whatever was live after it was already live before it.
    let c = `t3=cx&0x1f;if(t3){${d.pre}t0=${d.get};`;
    let def;
    if (kind === 0 || kind === 1) {
      c += `t1=t3&${top};t2=${kind === 0 ? `((t0<<t1)|(t0>>(${w}-t1)))&${M}` : `((t0>>t1)|(t0<<(${w}-t1)))&${M}`};`;
      if (live & CF) c += kind === 0 ? 'fC=t2&1;' : `fC=t2>>${top};`;
      def = CF | OF;
      if (live & OF) refuse(ip, `${name} by CL: OF is defined only for a count of 1, and is read`);
    } else if (kind === 2 && w === 8) {
      c += 't1=t3%9;t2=(fC<<8)|t0;t2=((t2<<t1)|(t2>>(9-t1)))&0x1ff;fC=t2>>8;t2&=0xff;';
      def = CF | OF;
      if (live & OF) refuse(ip, 'rcl by CL: OF read');
    } else refuse(ip, `${name} ${w}-bit by CL`);
    c += d.set('t2') + '}';
    return { c, def: 0, maybe: def, undef: 0, use: kind === 2 ? CF : 0, text: `${name} ${d.text},cl` };
  }
  const n = count & 0x1f;
  if (n === 0) return { c: '', def: 0, undef: 0, use: 0 };
  let c = d.pre + `t0=${d.get};`;
  let def = 0, undef = 0;
  if (kind === 4 || kind === 5 || kind === 7) {
    if (n >= w) refuse(ip, `${name} by ${n}, not below the operand width`);
    if (kind === 4) {
      c += `t2=(t0<<${n})&${M};`;
      if (live & (CF | OF)) c += `fC=(t0>>${w - n})&1;`;
      if (n === 1 && (live & OF)) c += `fO=(t2>>${top})^fC;`;
    } else if (kind === 5) {
      c += `t2=t0>>${n};`;
      if (live & CF) c += `fC=(t0>>${n - 1})&1;`;
      if (n === 1 && (live & OF)) c += `fO=t0>>${top};`;
    } else {
      c += `t1=${sx};t2=(t1>>${n})&${M};`;
      if (live & CF) c += `fC=(t1>>${n - 1})&1;`;
      if (n === 1 && (live & OF)) c += 'fO=0;';
    }
    c += szp('t2', w, live);
    def = CF | ZF | SF | PF | (n === 1 ? OF : 0);
    undef = AF | (n === 1 ? 0 : OF);
  } else if (kind === 0 || kind === 1) {
    const r = n & top;
    c += `t2=${kind === 0 ? `((t0<<${r})|(t0>>${w - r}))&${M}` : `((t0>>${r})|(t0<<${w - r}))&${M}`};`;
    if (live & CF) c += kind === 0 ? 'fC=t2&1;' : `fC=t2>>${top};`;
    def = CF | (n === 1 ? OF : 0); undef = n === 1 ? 0 : OF;
    if (n === 1 && (live & OF)) c += kind === 0 ? `fO=(t2>>${top})^(t2&1);` : `fO=((t2>>${top})^(t2>>${top - 1}))&1;`;
  } else refuse(ip, `${name} by an immediate`);
  c += d.set('t2');
  return { c, def, undef, use: 0, text: `${name} ${d.text},${n}` };
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

/**
 * Translate one instruction. Returns a record: its length, successors, flag use/def/undefined, its
 * x87 stack effect, and `gen(live, top)` producing the C for the flags live after it and the stack
 * top in force before it.
 */
function translateInsn(m, ip0) {
  const { I, end, b8, s8, w16, modrm } = decode(m, ip0);
  const op = I.op;
  const R = { ip: ip0, use: 0, def: 0, maybe: 0, undef: 0, succ: null, fpu: null, text: '', kind: 'op' };
  let gen = null;
  const set = (o) => Object.assign(R, o);
  const fixed = (res) => { set({ use: res.use || 0, def: res.def || 0, maybe: res.maybe || 0, undef: res.undef || 0 }); };

  if (op < 0x40 && (op & 7) < 6) {                                   // ALU forms
    const kind = op >> 3, form = op & 7, w = form & 1 ? 16 : 8;
    let d, s;
    if (form < 4) {
      const mr = modrm();
      const rm = operand(mr, w), rg = regOp(mr.reg, w);
      [d, s] = form & 2 ? [rg, rm] : [rm, rg];
      if (form & 2 && rm.mem) { d = { ...rg }; s = rm; }
    } else { d = regOp(0, w); s = immOp(w === 8 ? b8() : w16()); }
    R.text = `${['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'][kind]} ${d.text},${s.text}`;
    gen = (live) => alu(kind, w, d, s, live);
  } else if (op === 0x06 || op === 0x0e || op === 0x16 || op === 0x1e) {
    const s = op >> 3; R.text = `push ${SREG[s]}`;
    gen = () => ({ c: `sp=(sp-2)&0xffff;RW(ssb+sp)=${SREG[s]};` });
  } else if (op === 0x07 || op === 0x17 || op === 0x1f) {
    const s = op >> 3; R.text = `pop ${SREG[s]}`;
    gen = () => ({ c: `${SREG[s]}=RW(ssb+sp);${SREG[s]}b=${SREG[s]}<<4;sp=(sp+2)&0xffff;` });
  } else if (op >= 0x40 && op <= 0x4f) {
    const r = op & 7, inc = op < 0x48; R.text = `${inc ? 'inc' : 'dec'} ${R16[r]}`;
    R.def = OF | SF | ZF | AF | PF;
    gen = (live) => incdec(inc, regOp(r, 16), 16, live);
  } else if (op >= 0x50 && op <= 0x57) {
    const r = op & 7; R.text = `push ${R16[r]}`;
    if (r === 4) refuse(ip0, 'push sp');
    gen = () => ({ c: `sp=(sp-2)&0xffff;RW(ssb+sp)=${R16[r]};` });
  } else if (op >= 0x58 && op <= 0x5f) {
    const r = op & 7; R.text = `pop ${R16[r]}`;
    if (r === 4) refuse(ip0, 'pop sp');
    gen = () => ({ c: `${R16[r]}=RW(ssb+sp);sp=(sp+2)&0xffff;` });
  } else if (op === 0x68 || op === 0x6a) {
    const v = op === 0x68 ? w16() : s8() & 0xffff; R.text = `push 0x${v.toString(16)}`;
    gen = () => ({ c: `sp=(sp-2)&0xffff;RW(ssb+sp)=${v};` });
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
      gen = () => ({ c: `sp=(sp-2)&0xffff;RW(ssb+sp)=${SREG[s]};` });
    } else if (op2 === 0xa1 || op2 === 0xa9) {
      const s = op2 === 0xa1 ? 4 : 5; R.text = `pop ${SREG[s]}`;
      gen = () => ({ c: `${SREG[s]}=RW(ssb+sp);${SREG[s]}b=${SREG[s]}<<4;sp=(sp+2)&0xffff;` });
    } else refuse(ip0, `0F ${hex(op2, 2)}`);
  } else if (op === 0x80 || op === 0x81 || op === 0x83) {
    const w = op === 0x80 ? 8 : 16; const mr = modrm(); const d = operand(mr, w);
    const v = op === 0x81 ? w16() : op === 0x83 ? s8() & 0xffff : b8();
    R.text = `${['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'][mr.reg]} ${d.text},0x${v.toString(16)}`;
    gen = (live) => alu(mr.reg, w, d, immOp(v), live);
  } else if (op === 0x84 || op === 0x85 || op === 0xa8 || op === 0xa9) {
    const w = op & 1 ? 16 : 8; let d, s;
    if (op < 0xa8) { const mr = modrm(); d = operand(mr, w); s = regOp(mr.reg, w); } else { d = regOp(0, w); s = immOp(w === 8 ? b8() : w16()); }
    R.text = `test ${d.text},${s.text}`;
    gen = (live) => alu(8, w, d, s, live);
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
  } else if (op === 0x90) {
    R.text = 'nop'; gen = () => ({ c: '' });
  } else if (op === 0x98) {
    R.text = 'cbw'; gen = () => ({ c: 'ax=(ax<<24>>24)&0xffff;' });
  } else if (op === 0x99) {
    R.text = 'cwd'; gen = () => ({ c: 'dx=(ax&0x8000)?0xffff:0;' });
  } else if (op === 0x9e) {
    R.text = 'sahf'; R.def = CF | PF | AF | ZF | SF;
    gen = (live) => ({ c: (live & CF ? 'fC=(ax>>8)&1;' : '') + (live & PF ? 'fP=(ax>>10)&1;' : '') + (live & AF ? 'fA=(ax>>12)&1;' : '') + (live & ZF ? 'fZ=(ax>>14)&1;' : '') + (live & SF ? 'fS=ax>>15;' : '') });
  } else if (op === 0x9f) {
    R.text = 'lahf'; R.use = CF | PF | AF | ZF | SF;
    gen = () => ({ c: 'ax=(ax&0xff)|((fS<<7|fZ<<6|fA<<4|fP<<2|2|fC)<<8);' });
  } else if (op === 0xa4 || op === 0xa5 || op === 0xaa || op === 0xab || op === 0xac || op === 0xad) {
    const w = op & 1 ? 16 : 8, n = w / 8, src = segb(I.seg ?? 3);
    const name = { 0xa4: 'movs', 0xaa: 'stos', 0xac: 'lods' }[op & 0xfe] + (w === 8 ? 'b' : 'w');
    R.text = (I.rep ? 'rep ' : '') + (I.seg !== null && I.seg !== 3 ? `${SREG[I.seg]} ` : '') + name;
    const RD = w === 8 ? 'MEM' : 'RW';
    const one = {
      movs: `${RD}[esb+di]=${RD}[${src}+si];si=(si+${n})&0xffff;di=(di+${n})&0xffff;`,
      stos: `${RD}[esb+di]=${w === 8 ? '(ax&0xff)' : 'ax'};di=(di+${n})&0xffff;`,
      lods: `${w === 8 ? r8set(0, `MEM[${src}+si]`) : `ax=RW(${src}+si);`}si=(si+${n})&0xffff;`,
    }[name.slice(0, 4)].replace(/RW\[([^\]]+)\]/g, 'RW($1)');
    if (!I.rep) gen = () => ({ c: one });
    else if (name.startsWith('lods')) refuse(ip0, 'rep lods');
    else if (name === 'movsw' || name === 'movsb') {
      // A fast path when neither index wraps and the copy cannot read what it wrote (memmove agrees
      // with the word-by-word copy then); the word-by-word loop otherwise.
      gen = () => ({ c: `if(cx){t0=cx*${n};if(si+t0<=0x10000&&di+t0<=0x10000&&(esb+di<=${src}+si||esb+di>=${src}+si+t0)){memmove(MEM+esb+di,MEM+${src}+si,t0);si=(si+t0)&0xffff;di=(di+t0)&0xffff;cx=0;}else{do{${one}cx=cx-1;}while(cx);}}` });
    } else gen = () => ({ c: `while(cx){${one}cx=cx-1;}` });
  } else if (op >= 0xb0 && op <= 0xb7) {
    const v = b8(); R.text = `mov ${['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'][op & 7]},0x${v.toString(16)}`;
    gen = () => ({ c: r8set(op & 7, v) });
  } else if (op >= 0xb8 && op <= 0xbf) {
    const v = w16(); R.text = `mov ${R16[op & 7]},0x${v.toString(16)}`;
    gen = () => ({ c: `${R16[op & 7]}=${v};` });
  } else if (op === 0xc0 || op === 0xc1 || op === 0xd0 || op === 0xd1 || op === 0xd2 || op === 0xd3) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w);
    const count = op <= 0xc1 ? b8() : op <= 0xd1 ? 1 : 'cl';
    const probe = shift(ip0, mr.reg, w, d, count, 0);
    R.text = probe.text;
    gen = (live) => shift(ip0, mr.reg, w, d, count, live);
  } else if (op === 0xc6 || op === 0xc7) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w); const v = w === 8 ? b8() : w16();
    R.text = `mov ${d.text},0x${v.toString(16)}`;
    gen = () => ({ c: d.pre + d.set(v) });
  } else if (op === 0xc3) {
    R.text = 'ret'; R.kind = 'ret';
  } else if (op === 0xcd) {
    const n = b8(); R.text = `int 0x${n.toString(16)}`;
    if (n === 0x20) R.kind = 'exit';
    else if (n === 0x10) {
      // The BIOS through the platform layer (rc.h: __dpmi_int under PRISM), every register in and out. Its flags are not modelled:
      // the interrupt is treated as leaving them as they were, which the liveness pass makes safe
      // only because both intros redefine them before reading them (an INT neither uses nor defines).
      gen = () => ({ c: 'rg.ax=ax;rg.bx=bx;rg.cx=cx;rg.dx=dx;rg.si=si;rg.di=di;rg.bp=bp;rg.es=es;rg.ds=ds;'
        + 'rc_int(0x10,&rg);ax=rg.ax;bx=rg.bx;cx=rg.cx;dx=rg.dx;si=rg.si;di=rg.di;bp=rg.bp;' });
    } else if (n === 0x21) {
      R.kind = 'int21';
    } else refuse(ip0, `int 0x${n.toString(16)}`);
  } else if (op === 0xe2 || op === 0xe3) {
    const rel = s8(); const t = (end() + rel) & 0xffff;
    R.text = `${op === 0xe2 ? 'loop' : 'jcxz'} ${hex(t)}`; R.kind = op === 0xe2 ? 'loop' : 'jcxz'; R.target = t;
  } else if (op === 0xe4 || op === 0xec) {
    const port = op === 0xe4 ? `${b8()}` : 'dx'; R.text = `in al,${op === 0xe4 ? '0x' + (+port).toString(16) : 'dx'}`; R.io = true;
    gen = () => ({ c: `rc_ic=ic+ICK;${r8set(0, `rc_in(${port})`)}` });
  } else if (op === 0xe6 || op === 0xee) {
    const port = op === 0xe6 ? `${b8()}` : 'dx'; R.text = `out ${op === 0xe6 ? '0x' + (+port).toString(16) : 'dx'},al`;
    gen = () => ({ c: `rc_out(${port},ax&0xff);` });
  } else if (op === 0xe9 || op === 0xeb) {
    const rel = op === 0xe9 ? (w16() << 16) >> 16 : s8(); const t = (end() + rel) & 0xffff;
    R.text = `jmp ${hex(t)}`; R.kind = 'jmp'; R.target = t;
  } else if (op === 0xf6 || op === 0xf7) {
    const w = op & 1 ? 16 : 8; const mr = modrm(); const d = operand(mr, w);
    const name = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'][mr.reg];
    if (mr.reg <= 1) {
      const v = w === 8 ? b8() : w16(); R.text = `test ${d.text},0x${v.toString(16)}`;
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
    } else if (mr.reg === 4 && w === 8) {
      R.text = `mul ${d.text}`;
      gen = (live) => ({ c: `${d.pre}ax=(ax&0xff)*${d.get};${live & (CF | OF) ? 'fC=fO=(ax>>8)!=0;' : ''}`, def: CF | OF, undef: SF | ZF | AF | PF });
    } else refuse(ip0, `${name} ${w}-bit`);
  } else if (op === 0xfe || op === 0xff) {
    const w = op === 0xfe ? 8 : 16; const mr = modrm(); const d = operand(mr, w);
    if (mr.reg > 1) refuse(ip0, `${hex(op, 2)} /${mr.reg}`);
    R.text = `${mr.reg ? 'dec' : 'inc'} ${d.text}`;
    gen = (live) => incdec(!mr.reg, d, w, live);
  } else if (op === 0xf8 || op === 0xf9) {
    R.text = op === 0xf8 ? 'clc' : 'stc'; gen = () => ({ c: `fC=${op & 1};`, def: CF });
  } else if (op === 0xfc) {
    R.text = 'cld'; gen = () => ({ c: '' });
  } else if (op === 0xfd) {
    refuse(ip0, 'std (DF is modelled as constant 0)');
  } else if (op >= 0xd8 && op <= 0xdf) {
    return fpuInsn(m, ip0, I, end, modrm, R);
  } else refuse(ip0, `opcode ${hex(op, 2)}`);

  R.len = (end() - ip0) & 0xffff;
  if (gen) {
    const probe = gen(0);
    R.def = probe.def ?? R.def; R.undef = probe.undef ?? R.undef; R.use = probe.use ?? R.use; R.maybe = probe.maybe ?? R.maybe;
    R.gen = gen;
  }
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
  const P = (top, i) => `p${(top + i) & 7}`;
  const fdiv = (x, y) => `(${y}==0&&${x}!=0&&${x}==${x}?fsw|=4:0);`;
  const ari = (reg, x, y) => [`${x}+${y}`, `${x}*${y}`, null, null, `${x}-${y}`, `${y}-${x}`, `${x}/${y}`, `${y}/${x}`][reg];
  const divCheck = (reg, x, y) => (reg === 6 ? fdiv(x, y) : reg === 7 ? fdiv(y, x) : '');
  let delta = 0, text = '', gen;
  if (!mr.isReg) {
    const a = `ta=${segb(mr.seg)}+${mr.ea};`;
    const memText = mr.text;
    if (op === 0xdf && mr.reg === 0) { delta = -1; text = `fild word ${memText}`; gen = (t) => `${a}${P(t, -1)}=(double)RS(ta);`; }
    else if (op === 0xdf && mr.reg === 3) { delta = 1; text = `fistp word ${memText}`; gen = (t) => `${a}t0=fi16(${P(t, 0)});if(t0>0xffff){fsw|=1;t0=0x8000;}RW(ta)=t0&0xffff;`; }
    else if (op === 0xdf && mr.reg === 2) { text = `fist word ${memText}`; gen = (t) => `${a}t0=fi16(${P(t, 0)});if(t0>0xffff){fsw|=1;t0=0x8000;}RW(ta)=t0&0xffff;`; }
    else if (op === 0xd9 && mr.reg === 0) { delta = -1; text = `fld dword ${memText}`; gen = (t) => `${a}${P(t, -1)}=(double)RF(ta);`; }
    else if (op === 0xd9 && (mr.reg === 2 || mr.reg === 3)) { delta = mr.reg === 3 ? 1 : 0; text = `fst${mr.reg === 3 ? 'p' : ''} dword ${memText}`; gen = (t) => `${a}RF(ta)=(float)${P(t, 0)};`; }
    else if (op === 0xd8 || op === 0xde) {
      const load = op === 0xd8 ? '(double)RF(ta)' : '(double)RS(ta)';
      const nm = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'][mr.reg];
      text = `${op === 0xde ? 'fi' + nm.slice(1) : nm} ${op === 0xd8 ? 'dword' : 'word'} ${memText}`;
      if (mr.reg === 2 || mr.reg === 3) {
        delta = mr.reg === 3 ? 1 : 0;
        gen = (t) => `${a}d0=${load};d1=${P(t, 0)};fsw&=~0x4500;if(d0!=d0||d1!=d1)fsw|=0x4500;else if(d1<d0)fsw|=0x100;else if(d1==d0)fsw|=0x4000;`;
      } else gen = (t) => `${a}d0=${load};${divCheck(mr.reg, P(t, 0), 'd0')}${P(t, 0)}=${ari(mr.reg, P(t, 0), 'd0')};`;
    } else refuse(ip0, `x87 ${hex(op, 2)} /${mr.reg} memory`);
  } else {
    const b = 0xc0 | (mr.reg << 3) | mr.rm, i = mr.rm;
    if (op === 0xd9 && b < 0xc8) { delta = -1; text = `fld st${i}`; gen = (t) => `${P(t, -1)}=${P(t, i)};`; }
    else if (op === 0xd9 && b < 0xd0) { text = `fxch st${i}`; gen = (t) => `d0=${P(t, 0)};${P(t, 0)}=${P(t, i)};${P(t, i)}=d0;`; }
    else if (op === 0xd9 && FCONST[b] !== undefined) { delta = -1; text = `fld const ${hex(b, 2)}`; gen = (t) => `${P(t, -1)}=${lit(FCONST[b])};`; }
    else if (op === 0xd9 && b === 0xe0) { text = 'fchs'; gen = (t) => `${P(t, 0)}=-${P(t, 0)};`; }
    else if (op === 0xd9 && b === 0xe1) { text = 'fabs'; gen = (t) => `${P(t, 0)}=fabs(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xf3) { delta = 1; text = 'fpatan'; gen = (t) => `${P(t, 1)}=atan2(${P(t, 1)},${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xfa) { text = 'fsqrt'; gen = (t) => `${P(t, 0)}=sqrt(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xfb) { delta = -1; text = 'fsincos'; gen = (t) => `d0=${P(t, 0)};${trig('d0')}${P(t, 0)}=sin(d0);${P(t, -1)}=cos(d0);`; }
    else if (op === 0xd9 && b === 0xfe) { text = 'fsin'; gen = (t) => `${trig(P(t, 0))}${P(t, 0)}=sin(${P(t, 0)});`; }
    else if (op === 0xd9 && b === 0xff) { text = 'fcos'; gen = (t) => `${trig(P(t, 0))}${P(t, 0)}=cos(${P(t, 0)});`; }
    else if (op === 0xd8) {
      const nm = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'][mr.reg]; text = `${nm} st0,st${i}`;
      if (mr.reg === 2 || mr.reg === 3) refuse(ip0, 'fcom st(i)');
      gen = (t) => `d0=${P(t, 0)};d1=${P(t, i)};${divCheck(mr.reg, 'd0', 'd1')}${P(t, 0)}=${ari(mr.reg, 'd0', 'd1')};`;
    } else if (op === 0xdc || op === 0xde) {
      // To ST(i), the "reversed" encodings exactly as MIRAGE's arithE(reg, ST0, STi) reads them.
      if (mr.reg === 2 || mr.reg === 3) refuse(ip0, 'fcom st(i) (DC/DE)');
      const nm = ['fadd', 'fmul', '', '', 'fsubr', 'fsub', 'fdivr', 'fdiv'][mr.reg];
      delta = op === 0xde ? 1 : 0; text = `${nm}${op === 0xde ? 'p' : ''} st${i},st0`;
      gen = (t) => `d0=${P(t, 0)};d1=${P(t, i)};${divCheck(mr.reg, 'd0', 'd1')}${P(t, i)}=${ari(mr.reg, 'd0', 'd1')};`;
    } else if (op === 0xdb && b === 0xe3) {
      text = 'fninit'; R.fninit = true; gen = () => 'fsw=0;p0=p1=p2=p3=p4=p5=p6=p7=0;';
    } else if (op === 0xdf && b === 0xe0) {
      text = 'fnstsw ax'; gen = (t) => `ax=(fsw&0x47ff)|${t << 11};`;
    } else refuse(ip0, `x87 ${hex(op, 2)} ${hex(b, 2)}`);
  }
  R.text = text; R.fpu = delta; R.gen = (live, top) => ({ c: gen(top) });
  return R;
}
// C2 = out of range, as MIRAGE's ftrigCC. Two compares rather than fabs(): every libm call PRISM
// emits is M.rt.<name>(...), a property load the engine cannot inline through (tools/recomp/run.mjs).
const trig = (x) => `fsw=(fsw&~0x600)|((${x})>=9223372036854775808.0||(${x})<=-9223372036854775808.0?0x400:0);`;

// ---------------------------------------------------------------------------------------------

/**
 * Translate a .COM image. `state` is the entry state (registers in x86 order, segments, flags) as
 * MIRAGE's DOS loader leaves it. Returns { c, insns, blocks, report }.
 */
export function translateCom(com, state, { count = true, name = 'prog', structured = true } = {}) {
  structureRefused = null;
  const cs = state.seg[1];
  const m = new Uint8Array(0x10000);
  m.set(com, 0x100);
  // 1. Discovery: every instruction reachable from the entry along static edges.
  const insns = new Map();
  const work = [state.eip];
  while (work.length) {
    const ip = work.pop();
    if (insns.has(ip)) continue;
    const R = translateInsn(m, ip);
    insns.set(ip, R);
    const next = (ip + R.len) & 0xffff;
    if (R.kind === 'op') R.succ = [next];
    else if (R.kind === 'jcc' || R.kind === 'loop' || R.kind === 'jcxz') R.succ = [next, R.target];
    else if (R.kind === 'jmp') R.succ = [R.target];
    else R.succ = [];        // ret, exit, int21: leave the program
    work.push(...R.succ);
  }
  // Every edge must land on an instruction boundary: code that jumps into the middle of another
  // instruction would need two decodings of the same bytes.
  const starts = [...insns.keys()].sort((a, b) => a - b);
  for (let k = 0; k + 1 < starts.length; k++) {
    const a = insns.get(starts[k]);
    if (starts[k] + a.len > starts[k + 1]) refuse(starts[k], `overlaps the instruction at ${hex(starts[k + 1])}`);
  }
  // 2. Flag liveness, backward to a fixed point. A conditional ("maybe") definition is a use.
  const liveIn = new Map(starts.map((ip) => [ip, 0]));
  const liveOut = new Map(starts.map((ip) => [ip, 0]));
  for (let changed = true; changed;) {
    changed = false;
    for (let k = starts.length - 1; k >= 0; k--) {
      const R = insns.get(starts[k]);
      let out = 0;
      for (const s of R.succ) out |= liveIn.get(s);
      const inn = R.use | R.maybe | (out & ~R.def);
      if (out !== liveOut.get(R.ip) || inn !== liveIn.get(R.ip)) { liveOut.set(R.ip, out); liveIn.set(R.ip, inn); changed = true; }
    }
  }
  for (const ip of starts) {
    const R = insns.get(ip);
    if (liveOut.get(ip) & R.undef) refuse(ip, `${R.text} leaves a flag undefined (mask ${hex(R.undef & liveOut.get(ip), 3)}) that a later instruction reads`);
  }
  // 3. The x87 stack top, forward. A path that has not run FNINIT yet has an unknown top (null); two
  // paths that disagree give a conflict (-1). Either is fine where no x87 instruction reads it before
  // the next FNINIT (lattice's pixel loop re-enters its head with three values left on the stack and
  // resets it there); an x87 instruction that meets one is refused.
  const top = new Map();
  const fw = [[state.eip, null]];
  while (fw.length) {
    const [ip, t] = fw.pop();
    const R = insns.get(ip);
    let tin = t;
    if (top.has(ip)) {
      const was = top.get(ip);
      if (was === t || was === -1) continue;
      tin = -1;
    }
    top.set(ip, tin);
    let tout = tin;
    if (R.fninit) tout = 0;
    else if (R.fpu !== null) {
      if (tin === null || tin < 0) refuse(ip, tin === null ? 'x87 use before FNINIT: the stack top is unknown' : 'the x87 stack top differs between the paths that reach this instruction');
      tout = (tin + R.fpu) & 7;
    }
    for (const s of R.succ) fw.push([s, tout]);
  }
  // 4. Basic blocks: leaders are the entry, every branch target, and what follows a branch.
  const leaders = new Set([state.eip]);
  for (const ip of starts) {
    const R = insns.get(ip);
    if (R.kind !== 'op') { for (const s of R.succ) leaders.add(s); leaders.add((ip + R.len) & 0xffff); }
  }
  // 5. The blocks: from a leader to the next leader or the first control transfer, each with its C
  // and its terminator { kind: 'cond', cond, taken, fall } | { kind: 'go', to } | { kind: 'exit', c }.
  const blocks = new Map();
  const ioSites = new Map();   // IN instruction -> its block and its index there (MIRAGE counts per block)
  for (let k = 0; k < starts.length; k++) {
    const ip = starts[k];
    if (!leaders.has(ip)) continue;
    const blk = [];
    for (let j = k; ; j++) {
      const R = insns.get(starts[j]);
      blk.push(R);
      if (R.kind !== 'op' || j + 1 >= starts.length || leaders.has(starts[j + 1]) || starts[j + 1] !== ((R.ip + R.len) & 0xffff)) break;
    }
    const lines = [];
    if (count) lines.push(`ic+=${blk.length};`);
    let term = null;
    blk.forEach((R, n) => {
      let c = R.gen ? R.gen(liveOut.get(R.ip), top.get(R.ip)).c : '';
      c = c.replace('ICK', `${n - blk.length}`);   // the instructions of this block not yet retired
      if (R.io) ioSites.set(R.ip, { block: ip, index: n });
      const fall = (R.ip + R.len) & 0xffff;
      if (R.kind === 'jcc') term = { kind: 'cond', cond: R.cond, taken: R.target, fall };
      else if (R.kind === 'jmp') term = { kind: 'go', to: R.target };
      else if (R.kind === 'loop') { c = 'cx=(cx-1)&0xffff;'; term = { kind: 'cond', cond: 'cx', taken: R.target, fall }; }
      else if (R.kind === 'jcxz') term = { kind: 'cond', cond: '!cx', taken: R.target, fall };
      else if (R.kind === 'ret') term = { kind: 'exit', c: 't0=RW(ssb+sp);sp=(sp+2)&0xffff;if(t0==0)return 0;printf("ret to %04x: no such return site\\n",t0);return 3;' };
      else if (R.kind === 'exit') term = { kind: 'exit', c: 'return 0;' };
      else if (R.kind === 'int21') term = { kind: 'exit', c: 'if((ax>>8)==0x4c)return 0;printf("int 21h ah=%02x\\n",ax>>8);return 3;' };
      else if (R === blk[blk.length - 1]) term = { kind: 'go', to: fall };
      lines.push(`${c}${' '.repeat(Math.max(1, 72 - c.length))}/* ${hex(R.ip)} ${R.text} */`);
    });
    const succ = term.kind === 'cond' ? [term.taken, term.fall] : term.kind === 'go' ? [term.to] : [];
    blocks.set(ip, { ip, lines, term, succ, n: blk.length });
  }
  let body = null, mode = 'goto';
  if (structured) {
    try { body = emitStructured(blocks, state.eip); mode = 'structured'; } catch (e) { if (!(e instanceof Refused)) throw e; structureRefused = e.message; }
  }
  if (!body) body = emitGotos(blocks, state.eip);
  const c = cSource({ name, state, image: Array.from(com), body });
  return { c, insns, starts, leaders, nBlocks: blocks.size, liveOut, top, ioSites, mode, structureRefused };
}
let structureRefused = null;

/** Every block a top-level label, every edge a goto: PRISM emits it as its goto state machine. */
function emitGotos(blocks, entry) {
  const out = [`goto L_${hex(entry)};`];
  const order = [...blocks.keys()].sort((a, b) => a - b);
  order.forEach((ip, k) => {
    const b = blocks.get(ip), next = order[k + 1];
    out.push(`L_${hex(ip)}:`, ...b.lines.map((l) => `  ${l}`));
    const t = b.term;
    if (t.kind === 'cond') out.push(`  if(${t.cond})goto L_${hex(t.taken)};${t.fall === next ? '' : `goto L_${hex(t.fall)};`}`);
    else if (t.kind === 'go') { if (t.to !== next) out.push(`  goto L_${hex(t.to)};`); }
    else out.push(`  ${t.c}`);
  });
  return out;
}

/**
 * Structured C: loops as for(;;) with continue/break, two-way branches as if/else joined at their
 * immediate post-dominator. No label survives, so PRISM emits real JavaScript loops instead of its
 * goto state machine (src/backend/emit.js: a label must be top-level, and one nested in a loop sends
 * the whole function through flatten.js). Refuses -- and the caller falls back to gotos -- on what
 * this does not cover: an irreducible graph, a loop with two exit targets, an exit from an inner loop
 * straight out of an outer one, or a block reached twice.
 */
function emitStructured(blocks, entry) {
  const ids = [...blocks.keys()];
  // Dominators (iterative, over the blocks reachable from the entry).
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
  // Natural loops, one per header; every retreating edge must be a back edge (reducible).
  const loops = new Map();
  const index = new Map(rpo.map((b, i) => [b, i]));
  for (const u of rpo) for (const h of blocks.get(u).succ) {
    if (index.get(h) > index.get(u)) continue;
    if (!dom.get(u).has(h)) refuse(u, 'irreducible control flow');
    const L = loops.get(h) ?? { header: h, body: new Set([h]) };
    const st = [u];
    while (st.length) { const x = st.pop(); if (!L.body.has(x)) { L.body.add(x); st.push(...preds.get(x)); } }
    loops.set(h, L);
  }
  for (const L of loops.values()) {
    const ex = new Set();
    for (const b of L.body) for (const s of blocks.get(b).succ) if (!L.body.has(s)) ex.add(s);
    if (ex.size > 1) refuse(L.header, `loop with ${ex.size} exit targets`);
    L.follow = ex.size ? [...ex][0] : null;
    L.parent = null;
  }
  // Nesting: the innermost enclosing loop of each loop and block.
  const sorted = [...loops.values()].sort((a, b) => a.body.size - b.body.size);
  const loopOf = new Map();
  for (const b of ids) loopOf.set(b, sorted.find((L) => L.body.has(b)) ?? null);
  for (const L of sorted) L.parent = sorted.find((M) => M !== L && M.body.size > L.body.size && M.body.has(L.header)) ?? null;
  for (const L of sorted) for (const M of sorted) if (L !== M && L.body.has(M.header) && ![...M.body].every((x) => L.body.has(x))) refuse(M.header, 'loops not nested');

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
  const ind = (d) => '  '.repeat(d);
  function edge(s, ctx, stop, d) {
    if (ctx.L && s === ctx.L.header) { out.push(`${ind(d)}continue;`); return; }
    if (ctx.L && s === ctx.L.follow) { out.push(`${ind(d)}break;`); return; }
    if (ctx.L && !ctx.L.body.has(s)) refuse(s, 'an exit from an inner loop past its follow');
    if (stop.has(s)) return;
    region(s, ctx, stop, d);
  }
  function region(n, ctx, stop, d) {
    while (n !== null && !stop.has(n)) {
      const M = loops.get(n);
      if (M && M !== ctx.L && !ctx.inHeader) {
        if (M.parent !== ctx.L) refuse(n, 'a loop entered from outside its parent');
        out.push(`${ind(d)}for (;;) {  /* loop ${hex(n)} */`);
        region(n, { L: M, inHeader: true }, new Set(), d + 1);
        out.push(`${ind(d)}}`);
        if (M.follow === null) return;
        if (ctx.L && M.follow === ctx.L.header) { out.push(`${ind(d)}continue;`); return; }
        if (ctx.L && M.follow === ctx.L.follow) { out.push(`${ind(d)}break;`); return; }
        n = M.follow;
        continue;
      }
      ctx = { L: ctx.L, inHeader: false };
      if (emitted.has(n)) refuse(n, 'a block reached twice');
      emitted.add(n);
      const b = blocks.get(n);
      out.push(`${ind(d)}/* ${hex(n)} */`, ...b.lines.map((l) => ind(d) + l));
      const t = b.term;
      if (t.kind === 'exit') { out.push(ind(d) + t.c); return; }
      if (t.kind === 'go') {
        const s = t.to;
        if ((ctx.L && (s === ctx.L.header || s === ctx.L.follow)) || stop.has(s)) { edge(s, ctx, stop, d); return; }
        n = s; continue;
      }
      const m = regionIpdom(ctx.L).get(n);
      const join = m >= 0 ? m : null;
      const st2 = join === null ? stop : new Set([...stop, join]);
      const arm = (s) => { const at = out.length; edge(s, ctx, st2, d + 1); return out.splice(at); };
      const a = arm(t.taken), e = arm(t.fall);
      if (a.length) {
        out.push(`${ind(d)}if (${t.cond}) {`, ...a);
        out.push(e.length ? `${ind(d)}} else {` : `${ind(d)}}`);
        if (e.length) out.push(...e, `${ind(d)}}`);
      } else if (e.length) out.push(`${ind(d)}if (!(${t.cond})) {`, ...e, `${ind(d)}}`);
      n = join;
    }
  }
  region(entry, { L: null, inHeader: false }, new Set(), 0);
  for (const b of ids) if (!emitted.has(b)) refuse(b, 'a block the structured walk never reached');
  return out;
}

/**
 * The C file. One source for two platforms, chosen when it is compiled (tools/recomp/rc.h):
 * RC_PRISM, PRISM's DJGPP environment, where guest memory is the image's own first megabyte; or the
 * native runtime (tools/recomp/native/rc_sdl.c, clang + SDL2), where it is an array.
 */
function cSource({ name, state, image, body }) {
  const r = state.reg;
  const rows = [];
  for (let k = 0; k < image.length; k += 16) rows.push('  ' + image.slice(k, k + 16).map((b) => `0x${hex(b, 2)}`).join(',') + ',');
  const par = Array.from({ length: 256 }, (_, v) => { let p = 1; for (let x = v; x; x >>= 1) p ^= x & 1; return p; });
  return `/* ${name}: statically recompiled from x86 by MIRAGE tools/recomp/x86c.mjs. Do not edit. */
#include "rc.h"

static const unsigned char IMAGE[${image.length}] = {
${rows.join('\n')}
};
static const unsigned char PAR[256] = { ${par.join(',')} };
double rc_ic;                 /* the instruction count at the last IN, for the harness */

/* FIST m16 under RC=nearest, as MIRAGE's src/fpu.js toInt + toIntN: ties to even, and a value that
   does not fit (or NaN) answers 0x18000 so the caller stores the integer indefinite and raises IE. */
static int fi16(double x) {
  double fl = floor(x), d = x - fl, r = d < 0.5 ? fl : d > 0.5 ? fl + 1 : (fmod(fl, 2.0) == 0 ? fl : fl + 1);
  if (r >= -32768.0 && r < 32768.0) return (int)r;
  return 0x18000;
}

int rc_main(void) {
  int ax = ${r[0]}, cx = ${r[1]}, dx = ${r[2]}, bx = ${r[3]}, sp = ${r[4]}, bp = ${r[5]}, si = ${r[6]}, di = ${r[7]};
  int es = ${state.seg[0]}, cs = ${state.seg[1]}, ss = ${state.seg[2]}, ds = ${state.seg[3]}, fs = ${state.seg[4]}, gs = ${state.seg[5]};
  int esb = es << 4, csb = cs << 4, ssb = ss << 4, dsb = ds << 4, fsb = fs << 4, gsb = gs << 4;
  int fC = ${state.flags & 1}, fP = ${(state.flags >> 2) & 1}, fA = ${(state.flags >> 4) & 1}, fZ = ${(state.flags >> 6) & 1}, fS = ${(state.flags >> 7) & 1}, fO = ${(state.flags >> 11) & 1};
  double p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0, d0, d1;
  int fsw = 0, ta, t0, t1, t2, t3;
  double ic = 0;
  rc_regs rg;
  (void)cs; (void)csb; (void)fsb; (void)gsb; (void)fP; (void)fA; (void)fO; (void)t1; (void)t3; (void)d1; (void)rg; (void)ta;
  /* The PSP's INT 20h, the image at 100h, and the zero word DOS pushes for a RET to reach it. */
  memset(MEM + csb, 0, 0x100);
  MEM[csb] = 0xcd; MEM[csb + 1] = 0x20;
  memcpy(MEM + csb + 0x100, IMAGE, sizeof IMAGE);
  RW(ssb + sp) = 0;
${body.map((l) => `  ${l}`).join('\n')}
  return 0;
}
RC_ENTRY
`;
}
