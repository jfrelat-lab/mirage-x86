// recompiler.js — the dynamic x86→JavaScript compiler.
//
// It decodes one *basic block* (straight-line code up to the first control
// transfer) starting at a linear CS:IP, emits a JavaScript function body that
// mutates CPU state directly, compiles it with `new Function`, and caches it by
// (linear address, ip). The browser's own JIT then optimises the hot blocks —
// a two-tier JIT. Self-modifying code is handled by invalidating cached blocks
// whose page is written (see Memory.onCodeWrite).
//
// Generated code preamble aliases: r = reg file, m = memory, sb = segment bases.
// Every block ends by writing cpu.eip (and, on far transfers, the segments) and
// returning. The machine loop then fetches the next block.

import { CF, ZF, DF, OF, IF, TF, CS, SS, DS, ES, FS, GS } from './cpu.js';

const MAXOPS = 192;               // cap basic-block length
const MM_PLACEHOLDER = '__MM__';  // replaced with the memory mask literal

export class Recompiler {
  constructor(cpu) {
    this.cpu = cpu;
    this.mem = cpu.mem;
    this.MM = this.mem.mask;
    this.cache = new Map();        // key -> block
    this.pageBlocks = new Map();   // page -> Set(key)
    this.heat = new Map();         // key -> exec count (for the JIT heatmap)
    this.profiling = false;        // gate heat tracking off the hot path
    this.stats = { compiles: 0, exec: 0 };
    this.mem.onCodeWrite = (page) => this.invalidatePage(page);
  }

  invalidatePage(page) {
    const set = this.pageBlocks.get(page);
    if (!set) return;
    for (const key of set) { this.cache.delete(key); this.heat.delete(key); }
    set.clear();
    this.mem.codePage[page] = 0;   // re-marked when the page is translated again
  }

  reset() { this.cache.clear(); this.pageBlocks.clear(); this.heat.clear(); }

  /** Run exactly one basic block from the current CS:IP. Returns its length. */
  step() {
    const cpu = this.cpu;
    const ip0 = cpu.eip & 0xffff;
    const lin = (cpu.base[CS] + ip0) & this.MM;
    const key = lin + ip0 * 0x1000000;   // distinguish CS:IP aliases of one linear addr
    let blk = this.cache.get(key);
    if (!blk) blk = this._compile(key, lin, ip0);
    if (this.profiling) this.heat.set(key, (this.heat.get(key) || 0) + 1);
    this.stats.exec++;
    blk.fn(cpu);
    cpu.cycles += blk.count;
    return blk.count;
  }

  _compile(key, lin, ip0) {
    const blk = this.translate(lin, ip0);
    this.cache.set(key, blk);
    const first = blk.linStart >>> 12, last = (blk.linEnd - 1) >>> 12;
    for (let p = first; p <= last; p++) {
      this.mem.markCodePage(p);
      let s = this.pageBlocks.get(p);
      if (!s) { s = new Set(); this.pageBlocks.set(p, s); }
      s.add(key);
    }
    this.stats.compiles++;
    return blk;
  }

  /** Execute exactly one instruction, uncached — used by the conformance harness
   *  and the (future) step debugger. Does not pollute the block cache. */
  stepOne() {
    const cpu = this.cpu;
    const ip0 = cpu.eip & 0xffff;
    const lin = (cpu.base[CS] + ip0) & this.MM;
    const blk = this.translate(lin, ip0, 1);
    blk.fn(cpu);
    cpu.cycles += blk.count;
    return blk;
  }

  // -------------------------------------------------------------------------
  translate(linStart, ip0, maxOps = MAXOPS) {
    const mem = this.mem, MM = this.MM;
    const out = ['var t;'];
    const P = (s) => out.push(s);
    let ip = ip0, ended = false, tmp = 0, count = 0;
    const NT = () => '_' + (tmp++);

    // ---- byte fetch (decode-time reads from memory) ----
    const f8 = () => { const b = mem.r8((linStart - ip0 + ip) & MM); ip = (ip + 1) & 0xffff; return b; };
    const f16 = () => { const w = mem.r16((linStart - ip0 + ip) & MM); ip = (ip + 2) & 0xffff; return w; };
    const fs8 = () => { const b = f8(); return b < 128 ? b : b - 256; };

    // ---- operand-size / segment-override / rep prefixes ----
    let opsize, segOv, rep;
    const M = (sz) => sz === 8 ? '&0xff' : sz === 16 ? '&0xffff' : '>>>0';

    // ---- register operand source/sink as JS expressions ----
    const rR = (i, sz) => sz === 8 ? (i < 4 ? `(r[${i}]&0xff)` : `((r[${i - 4}]>>>8)&0xff)`)
      : sz === 16 ? `(r[${i}]&0xffff)` : `(r[${i}]>>>0)`;
    const rW = (i, sz, v) => sz === 8
      ? (i < 4 ? `r[${i}]=(r[${i}]&~0xff)|((${v})&0xff);` : `r[${i - 4}]=(r[${i - 4}]&~0xff00)|(((${v})&0xff)<<8);`)
      : sz === 16 ? `r[${i}]=(r[${i}]&~0xffff)|((${v})&0xffff);` : `r[${i}]=(${v})>>>0;`;

    // ---- ModR/M ----
    const lin = (seg, off) => `((sb[${seg}]+${off})&${MM})`;
    const modrm = () => {
      const b = f8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
      if (mod === 3) return { isReg: true, reg, rm };
      let base, seg = DS;
      switch (rm) {
        case 0: base = '((r[3]&0xffff)+(r[6]&0xffff))'; break;
        case 1: base = '((r[3]&0xffff)+(r[7]&0xffff))'; break;
        case 2: base = '((r[5]&0xffff)+(r[6]&0xffff))'; seg = SS; break;
        case 3: base = '((r[5]&0xffff)+(r[7]&0xffff))'; seg = SS; break;
        case 4: base = '(r[6]&0xffff)'; break;
        case 5: base = '(r[7]&0xffff)'; break;
        case 6: if (mod === 0) { base = '(' + f16() + ')'; } else { base = '(r[5]&0xffff)'; seg = SS; } break;
        case 7: base = '(r[3]&0xffff)'; break;
      }
      let disp = 0;
      if (mod === 1) disp = fs8(); else if (mod === 2) disp = f16();
      const off = disp ? `((${base}+(${disp}))&0xffff)` : `((${base})&0xffff)`;
      if (segOv >= 0) seg = segOv;
      return { isReg: false, reg, rm, seg, off };
    };
    const memAddr = (o) => { if (o._t === undefined) { o._t = NT(); P(`var ${o._t}=${lin(o.seg, o.off)};`); } return o._t; };
    const rmR = (o, sz) => o.isReg ? rR(o.rm, sz) : (sz === 8 ? `m.r8(${memAddr(o)})` : sz === 16 ? `m.r16(${memAddr(o)})` : `m.r32(${memAddr(o)})`);
    const rmW = (o, sz, v) => o.isReg ? rW(o.rm, sz, v) : (sz === 8 ? `m.w8(${memAddr(o)},(${v})&0xff);` : sz === 16 ? `m.w16(${memAddr(o)},(${v})&0xffff);` : `m.w32(${memAddr(o)},(${v})>>>0);`);

    // ---- ALU emit (dst read expr, dst write fn|null, src expr, size) ----
    const alu = (op, dRead, dWrite, src, sz) => {
      const a = NT(), b = NT(), rr = NT();
      P(`var ${a}=(${dRead})${M(sz)},${b}=(${src})${M(sz)};`);
      switch (op) {
        case 'add': P(`var ${rr}=(${a}+${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setAdd(${a},${b},${rr},${sz});`); break;
        case 'or': P(`var ${rr}=(${a}|${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setLogic(${rr},${sz});`); break;
        case 'and': P(`var ${rr}=(${a}&${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setLogic(${rr},${sz});`); break;
        case 'xor': P(`var ${rr}=(${a}^${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setLogic(${rr},${sz});`); break;
        case 'sub': P(`var ${rr}=(${a}-${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setSub(${a},${b},${rr},${sz});`); break;
        case 'cmp': P(`var ${rr}=(${a}-${b})${M(sz)};`); P(`cpu.setSub(${a},${b},${rr},${sz});`); break;
        case 'test': P(`var ${rr}=(${a}&${b})${M(sz)};`); P(`cpu.setLogic(${rr},${sz});`); break;
        case 'adc': { const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}+${b}+${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setAdc(${a},${b},${c},${rr},${sz});`); break; }
        case 'sbb': { const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}-${b}-${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); P(`cpu.setSbb(${a},${b},${c},${rr},${sz});`); break; }
      }
    };
    const ALUNAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];

    // ---- block terminators ----
    const endJmp = (target) => { P(`cpu.eip=${target}&0xffff;`); P('return;'); ended = true; };
    const endJcc = (cc, target, next) => { P(`cpu.eip=cpu.cond(${cc})?(${target}&0xffff):${next};`); P('return;'); ended = true; };

    // ===================== main decode loop =====================
    while (!ended && count < maxOps) {
      opsize = 16; segOv = -1; rep = 0;
      // prefixes
      let op = f8();
      for (; ;) {
        if (op === 0x66) { opsize = 32; op = f8(); }
        else if (op === 0x67) { op = f8(); }                       // addr-size (16-bit only in v1)
        else if (op === 0x2e) { segOv = CS; op = f8(); }
        else if (op === 0x36) { segOv = SS; op = f8(); }
        else if (op === 0x3e) { segOv = DS; op = f8(); }
        else if (op === 0x26) { segOv = ES; op = f8(); }
        else if (op === 0x64) { segOv = FS; op = f8(); }
        else if (op === 0x65) { segOv = GS; op = f8(); }
        else if (op === 0xf0) { op = f8(); }                       // LOCK (ignored)
        else if (op === 0xf2) { rep = 0xf2; op = f8(); }
        else if (op === 0xf3) { rep = 0xf3; op = f8(); }
        else break;
      }
      const sz = opsize;
      count++;

      // ----- ALU 0x00..0x3D regular grid -----
      if (op < 0x40 && (op & 7) < 6 && (op >> 3) < 8 && ALUNAMES[op >> 3] !== undefined && (op & 0xc7) !== 0x06 && (op & 0xc7) !== 0x07) {
        const name = ALUNAMES[op >> 3], form = op & 7;
        if (form === 0) { const o = modrm(); alu(name, rmR(o, 8), v => rmW(o, 8, v), rR(o.reg, 8), 8); }
        else if (form === 1) { const o = modrm(); alu(name, rmR(o, sz), v => rmW(o, sz, v), rR(o.reg, sz), sz); }
        else if (form === 2) { const o = modrm(); alu(name, rR(o.reg, 8), v => rW(o.reg, 8, v), rmR(o, 8), 8); }
        else if (form === 3) { const o = modrm(); alu(name, rR(o.reg, sz), v => rW(o.reg, sz, v), rmR(o, sz), sz); }
        else if (form === 4) { const i = f8(); alu(name, rR(0, 8), v => rW(0, 8, v), '' + i, 8); }
        else { const i = sz === 16 ? f16() : (f16() | (f16() << 16)); alu(name, rR(0, sz), v => rW(0, sz, v), '' + (i >>> 0), sz); }
        continue;
      }

      switch (op) {
        // ---- segment push/pop ----
        case 0x06: P(`cpu.push16(cpu.seg[${ES}]);`); break;
        case 0x07: P(`cpu.setSeg(${ES},cpu.pop16());`); break;
        case 0x0e: P(`cpu.push16(cpu.seg[${CS}]);`); break;
        case 0x16: P(`cpu.push16(cpu.seg[${SS}]);`); break;
        case 0x17: P(`cpu.setSeg(${SS},cpu.pop16());`); break;
        case 0x1e: P(`cpu.push16(cpu.seg[${DS}]);`); break;
        case 0x1f: P(`cpu.setSeg(${DS},cpu.pop16());`); break;

        // ---- BCD adjust ----
        case 0x27: P('cpu.daa();'); break;
        case 0x2f: P('cpu.das();'); break;
        case 0x37: P('cpu.aaa();'); break;
        case 0x3f: P('cpu.aas();'); break;

        // ---- INC/DEC reg16 ----
        case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}+1)${M(sz)};${rW(i, sz, rr)}cpu.setAdd(${a},1,${rr},${sz},false);`); break;
        }
        case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}-1)${M(sz)};${rW(i, sz, rr)}cpu.setSub(${a},1,${rr},${sz},false);`); break;
        }

        // ---- PUSH/POP reg ----
        case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
          P(sz === 32 ? `cpu.push32(${rR(op & 7, 32)});` : `cpu.push16(${rR(op & 7, 16)});`); break;
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
          P(sz === 32 ? rW(op & 7, 32, 'cpu.pop32()') : rW(op & 7, 16, 'cpu.pop16()')); break;

        case 0x60: // PUSHA
          P('var _sp=cpu.sp;cpu.push16(r[0]);cpu.push16(r[1]);cpu.push16(r[2]);cpu.push16(r[3]);cpu.push16(_sp);cpu.push16(r[5]);cpu.push16(r[6]);cpu.push16(r[7]);'); break;
        case 0x61: // POPA
          P(`${rW(7, 16, 'cpu.pop16()')}${rW(6, 16, 'cpu.pop16()')}${rW(5, 16, 'cpu.pop16()')}cpu.pop16();${rW(3, 16, 'cpu.pop16()')}${rW(2, 16, 'cpu.pop16()')}${rW(1, 16, 'cpu.pop16()')}${rW(0, 16, 'cpu.pop16()')}`); break;

        case 0x68: { const i = sz === 16 ? f16() : (f16() | (f16() << 16)); P(`cpu.push16(${i & 0xffff});`); break; } // PUSH Iz (16-bit stack)
        case 0x6a: P(`cpu.push16(${fs8()}&0xffff);`); break;                          // PUSH Ib (sign-extended)
        case 0x69: { const o = modrm(); const s = rmR(o, sz); const i = sz === 16 ? f16() : (f16() | (f16() << 16)); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6b: { const o = modrm(); const s = rmR(o, sz); const i = fs8(); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6c: emitStr('ins', 8); break;                                            // INSB
        case 0x6d: emitStr('ins', sz); break;                                           // INSW/D
        case 0x6e: emitStr('outs', 8); break;                                           // OUTSB
        case 0x6f: emitStr('outs', sz); break;                                          // OUTSW/D

        // ---- Jcc rel8 ----
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
          const rel = fs8(); endJcc(op & 0xf, (ip + rel) & 0xffff, ip); break;
        }

        // ---- group1: ALU Eb/Ev, imm ----
        case 0x80: case 0x82: { const o = modrm(); const i = f8(); const n = ALUNAMES[o.reg]; alu(n, rmR(o, 8), v => rmW(o, 8, v), '' + i, 8); break; }
        case 0x81: { const o = modrm(); const i = sz === 16 ? f16() : (f16() | (f16() << 16)); const n = ALUNAMES[o.reg]; alu(n, rmR(o, sz), v => rmW(o, sz, v), '' + (i >>> 0), sz); break; }
        case 0x83: { const o = modrm(); const i = fs8(); const n = ALUNAMES[o.reg]; alu(n, rmR(o, sz), v => rmW(o, sz, v), '(' + i + ')', sz); break; }

        // ---- TEST / XCHG / MOV (reg/rm) ----
        case 0x84: { const o = modrm(); alu('test', rmR(o, 8), null, rR(o.reg, 8), 8); break; }
        case 0x85: { const o = modrm(); alu('test', rmR(o, sz), null, rR(o.reg, sz), sz); break; }
        case 0x86: { const o = modrm(); const tA = NT(); P(`var ${tA}=${rmR(o, 8)};${rmW(o, 8, rR(o.reg, 8))}${rW(o.reg, 8, tA)}`); break; }
        case 0x87: { const o = modrm(); const tA = NT(); P(`var ${tA}=${rmR(o, sz)};${rmW(o, sz, rR(o.reg, sz))}${rW(o.reg, sz, tA)}`); break; }
        case 0x88: { const o = modrm(); P(rmW(o, 8, rR(o.reg, 8))); break; }
        case 0x89: { const o = modrm(); P(rmW(o, sz, rR(o.reg, sz))); break; }
        case 0x8a: { const o = modrm(); P(rW(o.reg, 8, rmR(o, 8))); break; }
        case 0x8b: { const o = modrm(); P(rW(o.reg, sz, rmR(o, sz))); break; }
        case 0x8c: { const o = modrm(); P(rmW(o, 16, `cpu.seg[${o.reg}]`)); break; }   // MOV Ew,Sw
        case 0x8d: { const o = modrm(); P(rW(o.reg, sz, '(' + o.off + ')')); break; }   // LEA
        case 0x8e: { const o = modrm(); P(`cpu.setSeg(${o.reg},${rmR(o, 16)});`); break; } // MOV Sw,Ew
        case 0x8f: { const o = modrm(); P(rmW(o, 16, 'cpu.pop16()')); break; }          // POP Ev

        case 0x90: break;                                                               // NOP
        case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {  // XCHG eAX,reg
          const i = op & 7, tA = NT(); P(`var ${tA}=${rR(0, sz)};${rW(0, sz, rR(i, sz))}${rW(i, sz, tA)}`); break;
        }
        case 0x98: P(`r[0]=(r[0]&~0xffff)|((((r[0]&0xff)<<24>>24))&0xffff);`); break;    // CBW
        case 0x99: P(`r[2]=(r[2]&~0xffff)|((r[0]&0x8000)?0xffff:0);`); break;            // CWD
        case 0x9a: { const o = f16(), s = f16(); P(`cpu.push16(cpu.seg[${CS}]);cpu.push16(${ip});cpu.setSeg(${CS},${s});`); endJmp('' + o); break; } // CALLF ptr
        case 0x9b: break;                                                               // WAIT
        case 0x9c: P('cpu.push16(cpu.flags&0xffff);'); break;                           // PUSHF
        case 0x9d: P('cpu.flags=(cpu.pop16()&0xfd5)|2;'); break;                         // POPF
        case 0x9e: P('cpu.flags=(cpu.flags&~0xff)|(((r[0]>>>8)&0xd5))|2;'); break;       // SAHF
        case 0x9f: P('r[0]=(r[0]&~0xff00)|((((cpu.flags&0xd5)|2)&0xff)<<8);'); break;    // LAHF

        // ---- MOV AL/eAX <-> moffs ----
        case 0xa0: { const d = f16(); P(rW(0, 8, `m.r8(${lin(segOv >= 0 ? segOv : DS, d)})`)); break; }
        case 0xa1: { const d = f16(); P(rW(0, sz, sz === 16 ? `m.r16(${lin(segOv >= 0 ? segOv : DS, d)})` : `m.r32(${lin(segOv >= 0 ? segOv : DS, d)})`)); break; }
        case 0xa2: { const d = f16(); P(`m.w8(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 8)});`); break; }
        case 0xa3: { const d = f16(); P(sz === 16 ? `m.w16(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 16)});` : `m.w32(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 32)});`); break; }

        // ---- string ops ----
        case 0xa4: emitStr('movs', 8); break;
        case 0xa5: emitStr('movs', sz); break;
        case 0xa6: emitStr('cmps', 8); break;
        case 0xa7: emitStr('cmps', sz); break;
        case 0xaa: emitStr('stos', 8); break;
        case 0xab: emitStr('stos', sz); break;
        case 0xac: emitStr('lods', 8); break;
        case 0xad: emitStr('lods', sz); break;
        case 0xae: emitStr('scas', 8); break;
        case 0xaf: emitStr('scas', sz); break;

        case 0xa8: { const i = f8(); alu('test', rR(0, 8), null, '' + i, 8); break; }
        case 0xa9: { const i = sz === 16 ? f16() : (f16() | (f16() << 16)); alu('test', rR(0, sz), null, '' + (i >>> 0), sz); break; }

        // ---- MOV reg, imm ----
        case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
          P(rW(op & 7, 8, '' + f8())); break;
        case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
          P(rW(op & 7, sz, '' + (sz === 16 ? f16() : ((f16() | (f16() << 16)) >>> 0)))); break;

        // ---- group2 shifts ----
        case 0xc0: { const o = modrm(); const c = f8(); emitShift(o, 8, '' + (c & 0x1f)); break; }
        case 0xc1: { const o = modrm(); const c = f8(); emitShift(o, sz, '' + (c & 0x1f)); break; }
        case 0xd0: { const o = modrm(); emitShift(o, 8, '1'); break; }
        case 0xd1: { const o = modrm(); emitShift(o, sz, '1'); break; }
        case 0xd2: { const o = modrm(); emitShift(o, 8, '(r[1]&0xff)'); break; }
        case 0xd3: { const o = modrm(); emitShift(o, sz, '(r[1]&0xff)'); break; }

        case 0xc2: { const n = f16(); P(`cpu.eip=cpu.pop16();r[4]=(r[4]&~0xffff)|((cpu.sp+${n})&0xffff);`); P('return;'); ended = true; break; } // RET imm
        case 0xc3: P('cpu.eip=cpu.pop16();'); P('return;'); ended = true; break;        // RET
        case 0xc4: { const o = modrm(); const a = memAddr(o); P(`${rW(o.reg, 16, `m.r16(${a})`)}cpu.setSeg(${ES},m.r16((${a}+2)&${MM}));`); break; } // LES
        case 0xc5: { const o = modrm(); const a = memAddr(o); P(`${rW(o.reg, 16, `m.r16(${a})`)}cpu.setSeg(${DS},m.r16((${a}+2)&${MM}));`); break; } // LDS
        case 0xc6: { const o = modrm(); const i = f8(); P(rmW(o, 8, '' + i)); break; }
        case 0xc7: { const o = modrm(); const i = sz === 16 ? f16() : ((f16() | (f16() << 16)) >>> 0); P(rmW(o, sz, '' + i)); break; }
        case 0xc8: { const szv = f16(); f8(); P(`cpu.push16(r[5]);r[5]=(r[5]&~0xffff)|cpu.sp;r[4]=(r[4]&~0xffff)|((cpu.sp-${szv})&0xffff);`); break; } // ENTER (level 0)
        case 0xc9: P('r[4]=(r[4]&~0xffff)|r[5]&0xffff;r[5]=(r[5]&~0xffff)|cpu.pop16();'); break; // LEAVE
        case 0xca: { const n = f16(); P(`cpu.eip=cpu.pop16();cpu.setSeg(${CS},cpu.pop16());r[4]=(r[4]&~0xffff)|((cpu.sp+${n})&0xffff);`); P('return;'); ended = true; break; } // RETF imm
        case 0xcb: P(`cpu.eip=cpu.pop16();cpu.setSeg(${CS},cpu.pop16());`); P('return;'); ended = true; break; // RETF

        case 0xcc: P(`cpu.eip=${ip};cpu.swInt(3);`); P('return;'); ended = true; break; // INT3
        case 0xcd: { const n = f8(); P(`cpu.eip=${ip};cpu.swInt(${n});`); P('return;'); ended = true; break; } // INT n
        case 0xce: P(`if(cpu.flags&${OF}){cpu.eip=${ip};cpu.swInt(4);return;}cpu.eip=${ip};`); P('return;'); ended = true; break; // INTO
        case 0xcf: P('cpu.eip=cpu.pop16();cpu.setSeg(' + CS + ',cpu.pop16());cpu.flags=(cpu.pop16()&0xfd5)|2;'); P('return;'); ended = true; break; // IRET

        case 0xd4: P(`cpu.aam(${f8()});`); break; // AAM
        case 0xd5: P(`cpu.aad(${f8()});`); break; // AAD
        case 0xd7: P(`r[0]=(r[0]&~0xff)|m.r8(${lin(segOv >= 0 ? segOv : DS, '((r[3]+ (r[0]&0xff))&0xffff)')});`); break; // XLAT

        // ---- x87 FPU (D8-DF): dispatch to the coprocessor ----
        case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf: {
          const o = modrm();
          if (o.isReg) P(`cpu.fpuReg(${op},${o.reg},${o.rm});`);
          else P(`cpu.fpuMem(${op},${o.reg},${memAddr(o)});`);
          break;
        }

        // ---- LOOP / JCXZ ----
        case 0xe0: { const rel = fs8(); P('r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); P(`cpu.eip=((r[1]&0xffff)!==0&&!(cpu.flags&${ZF}))?${(ip + rel) & 0xffff}:${ip};`); P('return;'); ended = true; break; }
        case 0xe1: { const rel = fs8(); P('r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); P(`cpu.eip=((r[1]&0xffff)!==0&&(cpu.flags&${ZF}))?${(ip + rel) & 0xffff}:${ip};`); P('return;'); ended = true; break; }
        case 0xe2: { const rel = fs8(); P('r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); P(`cpu.eip=((r[1]&0xffff)!==0)?${(ip + rel) & 0xffff}:${ip};`); P('return;'); ended = true; break; }
        case 0xe3: { const rel = fs8(); P(`cpu.eip=((r[1]&0xffff)===0)?${(ip + rel) & 0xffff}:${ip};`); P('return;'); ended = true; break; }

        // ---- IN / OUT ----
        case 0xe4: { const p = f8(); P(rW(0, 8, `cpu.ioRead(${p},1)`)); break; }
        case 0xe5: { const p = f8(); P(rW(0, sz, `cpu.ioRead(${p},${sz / 8})`)); break; }
        case 0xe6: { const p = f8(); P(`cpu.ioWrite(${p},1,${rR(0, 8)});`); break; }
        case 0xe7: { const p = f8(); P(`cpu.ioWrite(${p},${sz / 8},${rR(0, sz)});`); break; }
        case 0xec: P(rW(0, 8, 'cpu.ioRead(r[2]&0xffff,1)')); break;
        case 0xed: P(rW(0, sz, `cpu.ioRead(r[2]&0xffff,${sz / 8})`)); break;
        case 0xee: P(`cpu.ioWrite(r[2]&0xffff,1,${rR(0, 8)});`); break;
        case 0xef: P(`cpu.ioWrite(r[2]&0xffff,${sz / 8},${rR(0, sz)});`); break;

        // ---- CALL / JMP ----
        case 0xe8: { const rel = sz === 16 ? f16() : (f16() | (f16() << 16)); const tgt = (ip + (rel << 16 >> 16)) & 0xffff; P(`cpu.push16(${ip});`); endJmp('' + tgt); break; } // CALL rel
        case 0xe9: { const rel = sz === 16 ? f16() : (f16() | (f16() << 16)); endJmp('' + ((ip + (rel << 16 >> 16)) & 0xffff)); break; } // JMP rel
        case 0xea: { const o = f16(), s = f16(); P(`cpu.setSeg(${CS},${s});`); endJmp('' + o); break; } // JMPF ptr
        case 0xeb: { const rel = fs8(); endJmp('' + ((ip + rel) & 0xffff)); break; }    // JMP rel8

        case 0xf4: P('cpu.halted=true;'); P(`cpu.eip=${ip};`); P('return;'); ended = true; break; // HLT
        case 0xf5: P(`cpu.flags^=${CF};`); break;                                       // CMC
        case 0xf6: emitGroup3(8); break;
        case 0xf7: emitGroup3(sz); break;
        case 0xf8: P(`cpu.flags&=~${CF};`); break;                                      // CLC
        case 0xf9: P(`cpu.flags|=${CF};`); break;                                       // STC
        case 0xfa: P(`cpu.flags&=~${IF};`); break;                                      // CLI
        case 0xfb: P(`cpu.flags|=${IF};`); break;                                       // STI
        case 0xfc: P(`cpu.flags&=~${DF};`); break;                                      // CLD
        case 0xfd: P(`cpu.flags|=${DF};`); break;                                       // STD
        case 0xfe: { const o = modrm(); const a = NT(), rr = NT(); if (o.reg === 0) P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}+1)&0xff;${rmW(o, 8, rr)}cpu.setAdd(${a},1,${rr},8,false);`); else P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}-1)&0xff;${rmW(o, 8, rr)}cpu.setSub(${a},1,${rr},8,false);`); break; }
        case 0xff: emitGroup5(sz); break;

        case 0x0f: { decode0F(sz); break; }

        default:
          throw new Error('mirage: unimplemented opcode 0x' + op.toString(16).padStart(2, '0') + ' at ' + ((linStart - ip0 + ip - 1) & MM).toString(16));
      }
    }

    if (!ended) P(`cpu.eip=${ip};`);

    const body = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base;\n' + out.join('\n');
    const fn = new Function('cpu', body);
    return { fn, linStart, linEnd: (linStart - ip0 + ip) & MM, ip0, ipEnd: ip, count, body };

    // ===================== nested emit helpers =====================
    function emitShift(o, size, cnt) {
      const ops = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
      const fn = ops[o.reg];
      P(rmW(o, size, `cpu.${fn}(${rmR(o, size)},${cnt},${size})`));
    }

    function emitGroup3(size) {
      const o = modrm();
      switch (o.reg) {
        case 0: case 1: { const i = size === 8 ? f8() : (size === 16 ? f16() : (f16() | (f16() << 16))); alu('test', rmR(o, size), null, '' + (i >>> 0), size); break; }
        case 2: P(rmW(o, size, `(~${rmR(o, size)})`)); break;                            // NOT
        case 3: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, size)};var ${rr}=(0-${a})${M(size)};${rmW(o, size, rr)}cpu.setSub(0,${a},${rr},${size});`); break; } // NEG
        case 4: P(`cpu.${size === 8 ? 'mul8' : 'mul16'}(${rmR(o, size)});`); break;      // MUL
        case 5: P(`cpu.${size === 8 ? 'imul8' : 'imul16'}(${rmR(o, size)});`); break;    // IMUL
        case 6: P(`cpu.${size === 8 ? 'div8' : 'div16'}(${rmR(o, size)});`); break;      // DIV
        case 7: P(`cpu.${size === 8 ? 'idiv8' : 'idiv16'}(${rmR(o, size)});`); break;    // IDIV
      }
    }

    function emitGroup5(sz) {
      const o = modrm();
      switch (o.reg) {
        case 0: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}+1)${M(sz)};${rmW(o, sz, rr)}cpu.setAdd(${a},1,${rr},${sz},false);`); break; }
        case 1: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}-1)${M(sz)};${rmW(o, sz, rr)}cpu.setSub(${a},1,${rr},${sz},false);`); break; }
        case 2: { const tg = NT(); P(`var ${tg}=${rmR(o, 16)};cpu.push16(${ip});cpu.eip=${tg};`); P('return;'); ended = true; break; } // CALL Ev
        case 3: { const a = memAddr(o); P(`cpu.push16(cpu.seg[${CS}]);cpu.push16(${ip});var _o=m.r16(${a});cpu.setSeg(${CS},m.r16((${a}+2)&${MM}));cpu.eip=_o;`); P('return;'); ended = true; break; } // CALLF
        case 4: { const tg = NT(); P(`var ${tg}=${rmR(o, 16)};cpu.eip=${tg};`); P('return;'); ended = true; break; } // JMP Ev
        case 5: { const a = memAddr(o); P(`var _o=m.r16(${a});cpu.setSeg(${CS},m.r16((${a}+2)&${MM}));cpu.eip=_o;`); P('return;'); ended = true; break; } // JMPF
        case 6: P(`cpu.push16(${rmR(o, 16)});`); break;                                  // PUSH Ev
      }
    }

    function emitStr(kind, size) {
      const step = size / 8;
      const srcSeg = segOv >= 0 ? segOv : DS;
      const w = size === 8 ? 'r8' : size === 16 ? 'r16' : 'r32';
      const ww = size === 8 ? 'w8' : size === 16 ? 'w16' : 'w32';
      P(`var _d=(cpu.flags&${DF})?-${step}:${step};`);
      const loop = (body, cond) => {
        if (rep) {
          P('var _c=r[1]&0xffff;');
          P('while(_c>0){');
          P(body);
          P('_c--;');
          if (cond) P(cond);
          P('}');
          P('r[1]=(r[1]&~0xffff)|_c;');
        } else { P(body); }
      };
      const SI = `((sb[${srcSeg}]+(r[6]&0xffff))&${MM})`;
      const DI = `((sb[${ES}]+(r[7]&0xffff))&${MM})`;
      const adv = `r[6]=(r[6]&~0xffff)|((r[6]+_d)&0xffff);r[7]=(r[7]&~0xffff)|((r[7]+_d)&0xffff);`;
      const advDI = `r[7]=(r[7]&~0xffff)|((r[7]+_d)&0xffff);`;
      const advSI = `r[6]=(r[6]&~0xffff)|((r[6]+_d)&0xffff);`;
      if (kind === 'movs') loop(`m.${ww}(${DI},m.${w}(${SI}));${adv}`);
      else if (kind === 'stos') loop(`m.${ww}(${DI},${rR(0, size)});${advDI}`);
      else if (kind === 'lods') loop(`${rW(0, size, `m.${w}(${SI})`)}${advSI}`);
      else if (kind === 'cmps') loop(`var _x=m.${w}(${SI}),_y=m.${w}(${DI});cpu.setSub(_x,_y,(_x-_y)${M(size)},${size});${adv}`, rep === 0xf3 ? `if(!(cpu.flags&${ZF}))break;` : `if(cpu.flags&${ZF})break;`);
      else if (kind === 'scas') loop(`var _y=m.${w}(${DI});var _x=${rR(0, size)};cpu.setSub(_x,_y,(_x-_y)${M(size)},${size});${advDI}`, rep === 0xf3 ? `if(!(cpu.flags&${ZF}))break;` : `if(cpu.flags&${ZF})break;`);
      else if (kind === 'ins') loop(`m.${ww}(${DI},cpu.ioRead(r[2]&0xffff,${step}));${advDI}`);
      else if (kind === 'outs') loop(`cpu.ioWrite(r[2]&0xffff,${step},m.${w}(${SI}));${advSI}`);
    }

    function decode0F(sz) {
      const op2 = f8();
      // near Jcc rel16/32
      if (op2 >= 0x80 && op2 <= 0x8f) { const rel = sz === 16 ? f16() : (f16() | (f16() << 16)); endJcc(op2 & 0xf, (ip + (rel << 16 >> 16)) & 0xffff, ip); return; }
      // SETcc Eb
      if (op2 >= 0x90 && op2 <= 0x9f) { const o = modrm(); P(rmW(o, 8, `cpu.cond(${op2 & 0xf})?1:0`)); return; }
      // BTx Ev,Gv (reg bit offset) and group 0F BA Ev,imm8
      const bt = (o, kind, bitExpr) => {
        const b = NT(), v = NT();
        P(`var ${b}=(${bitExpr})&${sz - 1};var ${v}=${rmR(o, sz)};`);
        P(`cpu.flags=(cpu.flags&~${CF})|((${v}>>>${b})&1);`);
        if (kind === 'bts') P(rmW(o, sz, `(${v}|(1<<${b}))`));
        else if (kind === 'btr') P(rmW(o, sz, `(${v}&~(1<<${b}))`));
        else if (kind === 'btc') P(rmW(o, sz, `(${v}^(1<<${b}))`));
      };
      switch (op2) {
        case 0x1f: modrm(); return;                                                     // multi-byte NOP
        case 0xa3: { const o = modrm(); bt(o, 'bt', rR(o.reg, sz)); return; }            // BT
        case 0xab: { const o = modrm(); bt(o, 'bts', rR(o.reg, sz)); return; }           // BTS
        case 0xb3: { const o = modrm(); bt(o, 'btr', rR(o.reg, sz)); return; }           // BTR
        case 0xbb: { const o = modrm(); bt(o, 'btc', rR(o.reg, sz)); return; }           // BTC
        case 0xba: { const o = modrm(); const imm = f8(); bt(o, ['bt', 'bt', 'bt', 'bt', 'bt', 'bts', 'btr', 'btc'][o.reg], '' + imm); return; }
        case 0xbc: { const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)}${M(sz)};`); P(`if(${s}===0){cpu.flags|=${ZF};}else{cpu.flags&=~${ZF};${rW(o.reg, sz, `(31-Math.clz32(${s}&-${s}))`)}}`); return; } // BSF
        case 0xbd: { const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)}${M(sz)};`); P(`if(${s}===0){cpu.flags|=${ZF};}else{cpu.flags&=~${ZF};${rW(o.reg, sz, `(31-Math.clz32(${s}))`)}}`); return; } // BSR
        case 0xa4: { const o = modrm(); const c = f8(); P(rmW(o, sz, `cpu.shld(${rmR(o, sz)},${rR(o.reg, sz)},${c & 31},${sz})`)); return; } // SHLD imm
        case 0xa5: { const o = modrm(); P(rmW(o, sz, `cpu.shld(${rmR(o, sz)},${rR(o.reg, sz)},(r[1]&0xff),${sz})`)); return; }              // SHLD CL
        case 0xac: { const o = modrm(); const c = f8(); P(rmW(o, sz, `cpu.shrd(${rmR(o, sz)},${rR(o.reg, sz)},${c & 31},${sz})`)); return; } // SHRD imm
        case 0xad: { const o = modrm(); P(rmW(o, sz, `cpu.shrd(${rmR(o, sz)},${rR(o.reg, sz)},(r[1]&0xff),${sz})`)); return; }              // SHRD CL
        case 0xaf: { const o = modrm(); P(`cpu.imul16x(${rR(o.reg, sz)},${rmR(o, sz)},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); return; } // IMUL Gv,Ev
        case 0xb0: case 0xb1: { const o = modrm(); const size = op2 === 0xb0 ? 8 : sz; const d = NT(), a = NT(), rr = NT(); P(`var ${d}=${rmR(o, size)},${a}=${rR(0, size)};var ${rr}=(${a}-${d})${M(size)};cpu.setSub(${a},${d},${rr},${size});if(${a}===${d}){${rmW(o, size, rR(o.reg, size))}}else{${rW(0, size, d)}}`); return; } // CMPXCHG
        case 0xb6: { const o = modrm(); P(rW(o.reg, sz, `(${rmR(o, 8)}&0xff)`)); return; } // MOVZX r,Eb
        case 0xb7: { const o = modrm(); P(rW(o.reg, sz, `(${rmR(o, 16)}&0xffff)`)); return; } // MOVZX r,Ew
        case 0xbe: { const o = modrm(); P(rW(o.reg, sz, `((${rmR(o, 8)})<<24>>24)`)); return; } // MOVSX r,Eb
        case 0xbf: { const o = modrm(); P(rW(o.reg, sz, `((${rmR(o, 16)})<<16>>16)`)); return; } // MOVSX r,Ew
        case 0xc0: case 0xc1: { const o = modrm(); const size = op2 === 0xc0 ? 8 : sz; const d = NT(), s = NT(), rr = NT(); P(`var ${d}=${rmR(o, size)},${s}=${rR(o.reg, size)};var ${rr}=(${d}+${s})${M(size)};${rW(o.reg, size, d)}${rmW(o, size, rr)}cpu.setAdd(${d},${s},${rr},${size});`); return; } // XADD
        default:
          throw new Error('mirage: unimplemented opcode 0x0f 0x' + op2.toString(16).padStart(2, '0'));
      }
    }
  }
}
