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

import { CF, PF, AF, ZF, SF, DF, OF, IF, TF, CS, SS, DS, ES, FS, GS } from './cpu.js';

const MAXOPS = 192;               // cap basic-block length
const MM_PLACEHOLDER = '__MM__';  // replaced with the memory mask literal

// Debug kill switch: MIRAGE_NOFPUINLINE=1 falls back to the cpu.fpuMem/fpuReg runtime
// dispatch instead of emitting each x87 op inline. Browser-safe (no `process`).
const NOFPUINLINE = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOFPUINLINE);
// MIRAGE_NOSTRIP=1 disables the dead-flag elimination (debug / differential gate).
const NOSTRIP = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSTRIP);

// Abstract flag-liveness bit set (NOT the EFLAGS register layout) for the dead-flag pass:
// which of the 6 arithmetic flags an instruction defines / uses. Full ALU ops def all 6;
// INC/DEC def all-but-carry (they preserve CF).
const lC = 1, lP = 2, lA = 4, lZ = 8, lS = 16, lO = 32, lALL = 63, lNOC = lALL & ~lC;

export class Recompiler {
  constructor(cpu) {
    this.cpu = cpu;
    this.mem = cpu.mem;
    this.MM = this.mem.mask;
    // Block lookup: a 2-level page array (blockPages[lin>>>12][lin&0xfff] -> block)
    // rather than a Map — pure integer indexing on the hot dispatch path, no hashing
    // (V8's Map always routes through FindOrderedHashMapEntry even for SMI keys).
    this.blockPages = [];          // page -> Array(4096) of block | undefined
    this.pageBlocks = new Map();   // page -> Set(lin) — for SMC invalidation sweeps
    this.heat = new Map();         // lin -> exec count (for the JIT heatmap)
    this.profiling = false;        // gate heat tracking off the hot path
    this.stats = { compiles: 0, exec: 0, invalidations: 0 };
    this.mem.onCodeWrite = (addr, len) => this.invalidate(addr, len);
  }

  /** Self-modifying-code: invalidate only the cached blocks whose byte range the
   *  write [addr, addr+len) actually overlaps — not the whole 4 KiB page. This is
   *  what keeps demos that stash variables in their code page (tube, darnit) from
   *  recompiling every block on every write. */
  invalidate(addr, len) {
    const end = addr + len;
    for (let p = addr >> 12; p <= (end - 1) >> 12; p++) {
      const set = this.pageBlocks.get(p);
      if (!set) continue;
      for (const lin of set) {
        const pg = this.blockPages[lin >>> 12];
        const blk = pg !== undefined ? pg[lin & 0xfff] : undefined;
        if (!blk) { set.delete(lin); continue; }              // stale entry
        if (blk.linStart < end && addr < blk.linEnd) this._evict(blk, lin);
      }
      if (set.size === 0) this.mem.codePage[p] = 0;            // page no longer holds code
    }
  }

  _evict(blk, lin) {
    const pg = this.blockPages[lin >>> 12]; if (pg !== undefined) pg[lin & 0xfff] = undefined;
    this.heat.delete(lin);
    this.stats.invalidations++;
    for (let p = blk.linStart >>> 12; p <= (blk.linEnd - 1) >>> 12; p++) {
      const s = this.pageBlocks.get(p); if (s) s.delete(lin);
    }
  }

  reset() { this.blockPages = []; this.pageBlocks.clear(); this.heat.clear(); }

  /** Run exactly one basic block from the current CS:IP. Returns its length. */
  step() {
    const cpu = this.cpu;
    const ip0 = cpu.eip & 0xffff;
    const lin = (cpu.base[CS] + ip0) & this.MM;
    // O(1) array index, no hashing. blk.ip0 guards the rare case of one linear addr
    // reached via different CS:IP (the emitted jump targets bake in ip0).
    const page = this.blockPages[lin >>> 12];
    let blk = page !== undefined ? page[lin & 0xfff] : undefined;
    if (blk === undefined || blk.ip0 !== ip0) blk = this._compile(lin, ip0);
    if (this.profiling) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
    this.stats.exec++;
    blk.fn(cpu);
    cpu.cycles += blk.count;
    return blk.count;
  }

  /** Fused dispatch loop: run up to maxBlocks blocks with the try/catch
   *  hoisted out of the per-block path and stats.exec accumulated once — this is the
   *  hot loop (puls was ~20% here). halted/blocked are still checked every iteration:
   *  an INT handler inside blk.fn can set machine.blocked via machine.block(), and it
   *  must be honoured before the next block dispatches (same order as the old loop).
   *  step() stays for single-block callers (tests, conformance stepOne is separate). */
  run(machine, maxBlocks) {
    const cpu = this.cpu, MM = this.MM, pages = this.blockPages, prof = this.profiling;
    let n = 0;
    try {
      while (n < maxBlocks && !cpu.halted && !machine.blocked) {
        const ip0 = cpu.eip & 0xffff, lin = (cpu.base[CS] + ip0) & MM;
        const page = pages[lin >>> 12];
        let blk = page !== undefined ? page[lin & 0xfff] : undefined;
        if (blk === undefined || blk.ip0 !== ip0) blk = this._compile(lin, ip0);
        if (prof) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
        blk.fn(cpu);
        cpu.cycles += blk.count;
        n++;
      }
    } catch (e) {
      this.stats.exec += n;
      if (machine.onError) { machine.onError(e); return n; }
      throw e;
    }
    this.stats.exec += n;
    return n;
  }

  _compile(lin, ip0) {
    const blk = this.translate(lin, ip0);
    const pg = lin >>> 12;
    let page = this.blockPages[pg];
    if (page === undefined) page = this.blockPages[pg] = new Array(4096);
    page[lin & 0xfff] = blk;
    const first = blk.linStart >>> 12, last = (blk.linEnd - 1) >>> 12;
    for (let p = first; p <= last; p++) {
      this.mem.markCodePage(p);
      let s = this.pageBlocks.get(p);
      if (!s) { s = new Set(); this.pageBlocks.set(p, s); }
      s.add(lin);
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
    let ip = ip0, ended = false, tmp = 0, count = 0, usesFPU = false;
    const NT = () => '_' + (tmp++);

    // ---- dead-flag pass bookkeeping ----
    // One record per decoded instruction: `flagIdx` = out[] index of its strippable
    // flag-setting call (or -1), `def`/`use` = abstract flag masks. `cur` is the record
    // for the instruction being decoded. PFLAG emits a strippable flag call and tags it.
    // Default use=0 (transparent): only flag READERS set `cur.use` (enumerated below);
    // a forgotten reader is the one unsafe case, so the golden A/B gate covers it.
    const instrs = [];
    let cur = { flagIdx: -1, def: 0, use: 0 };
    const PFLAG = (stmt, def) => { cur.flagIdx = out.length; cur.def |= def; out.push(stmt); };

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
    // Direct typed-array memory access: u8[]/dv reads and writes inline instead
    // of m.r8/w8 calls. Addresses from memAddr are already &MM-masked; composed lanes mask
    // a+1.. (they escape MM only at the very top of RAM, but that wraps and is reachable).
    // memRead: little-endian compose. memW keeps the SMC dirty check (shared, never open-coded).
    const memRead = (a, sz) => sz === 8 ? `u8[${a}]`
      : sz === 16 ? `(u8[${a}]|(u8[(${a}+1)&${MM}]<<8))`
        : `((u8[${a}]|(u8[(${a}+1)&${MM}]<<8)|(u8[(${a}+2)&${MM}]<<16)|(u8[(${a}+3)&${MM}]<<24))>>>0)`;
    const memW = (a, sz, v) => {
      if (sz === 8) return `u8[${a}]=(${v});if(cp[${a}>>>12]!==0)m._dirty(${a},1);`;
      const t = NT();
      if (sz === 16) return `var ${t}=(${v});u8[${a}]=${t};u8[(${a}+1)&${MM}]=${t}>>>8;if(cp[${a}>>>12]|cp[((${a}+1)&${MM})>>>12])m._dirty(${a},2);`;
      return `var ${t}=(${v});u8[${a}]=${t};u8[(${a}+1)&${MM}]=${t}>>>8;u8[(${a}+2)&${MM}]=${t}>>>16;u8[(${a}+3)&${MM}]=${t}>>>24;if(cp[${a}>>>12]|cp[((${a}+3)&${MM})>>>12])m._dirty(${a},4);`;
    };
    const rmR = (o, sz) => o.isReg ? rR(o.rm, sz) : memRead(memAddr(o), sz);
    const rmW = (o, sz, v) => o.isReg ? rW(o.rm, sz, v) : memW(memAddr(o), sz, v);

    // ---- ALU emit (dst read expr, dst write fn|null, src expr, size) ----
    const alu = (op, dRead, dWrite, src, sz) => {
      const a = NT(), b = NT(), rr = NT();
      P(`var ${a}=(${dRead})${M(sz)},${b}=(${src})${M(sz)};`);
      switch (op) {
        case 'add': P(`var ${rr}=(${a}+${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setAdd(${a},${b},${rr},${sz});`, lALL); break;
        case 'or': P(`var ${rr}=(${a}|${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic(${rr},${sz});`, lALL); break;
        case 'and': P(`var ${rr}=(${a}&${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic(${rr},${sz});`, lALL); break;
        case 'xor': P(`var ${rr}=(${a}^${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setLogic(${rr},${sz});`, lALL); break;
        case 'sub': P(`var ${rr}=(${a}-${b})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setSub(${a},${b},${rr},${sz});`, lALL); break;
        case 'cmp': P(`var ${rr}=(${a}-${b})${M(sz)};`); PFLAG(`cpu.setSub(${a},${b},${rr},${sz});`, lALL); break;
        case 'test': P(`var ${rr}=(${a}&${b})${M(sz)};`); PFLAG(`cpu.setLogic(${rr},${sz});`, lALL); break;
        case 'adc': { cur.use |= lC; const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}+${b}+${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setAdc(${a},${b},${c},${rr},${sz});`, lALL); break; }
        case 'sbb': { cur.use |= lC; const c = NT(); P(`var ${c}=cpu.flags&1;var ${rr}=(${a}-${b}-${c})${M(sz)};`); if (dWrite) P(dWrite(rr)); PFLAG(`cpu.setSbb(${a},${b},${c},${rr},${sz});`, lALL); break; }
      }
    };
    const ALUNAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];

    // ---- condition codes as inline bit-tests (replaces the cpu.cond(cc) call) ----
    // cc 0..15 = O NO B AE Z NZ BE A S NS P NP L GE LE G. `sfNeOf` = (SF!=OF).
    const sfNeOf = `((cpu.flags>>>7^cpu.flags>>>11)&1)`;
    const condExpr = (cc) => {
      switch (cc) {
        case 0x0: return `(cpu.flags&${OF})`;              case 0x1: return `!(cpu.flags&${OF})`;
        case 0x2: return `(cpu.flags&${CF})`;              case 0x3: return `!(cpu.flags&${CF})`;
        case 0x4: return `(cpu.flags&${ZF})`;              case 0x5: return `!(cpu.flags&${ZF})`;
        case 0x6: return `(cpu.flags&${CF | ZF})`;         case 0x7: return `!(cpu.flags&${CF | ZF})`;
        case 0x8: return `(cpu.flags&${SF})`;              case 0x9: return `!(cpu.flags&${SF})`;
        case 0xa: return `(cpu.flags&${PF})`;              case 0xb: return `!(cpu.flags&${PF})`;
        case 0xc: return sfNeOf;                           case 0xd: return `!${sfNeOf}`;
        case 0xe: return `((cpu.flags&${ZF})||${sfNeOf})`; case 0xf: return `(!(cpu.flags&${ZF})&&!${sfNeOf})`;
      }
    };

    // ---- block terminators ----
    const endJmp = (target) => { P(`cpu.eip=${target}&0xffff;`); P('return;'); ended = true; };
    const endJcc = (cc, target, next) => { P(`cpu.eip=${condExpr(cc)}?(${target}&0xffff):${next};`); P('return;'); ended = true; };

    // ---- x87 stack-expression helpers (used by emitFPUReg/emitFPUMem below) ----
    // ST(i) as an lvalue/rvalue string; fpush/FPOP mutate cpu.ftop directly (no mirror).
    const STe = (i) => i === 0 ? 'st[cpu.ftop]' : `st[(cpu.ftop+${i})&7]`;
    const setSTe = (i, v) => i === 0 ? `st[cpu.ftop]=${v};` : `st[(cpu.ftop+${i})&7]=${v};`;
    const fpush = (v) => { const t = NT(); P(`var ${t}=${v};cpu.ftop=(cpu.ftop-1)&7;st[cpu.ftop]=${t};`); };
    const FPOP = 'cpu.ftop=(cpu.ftop+1)&7;';
    const arithE = (rg, x, y) => rg === 0 ? `${x}+${y}` : rg === 1 ? `${x}*${y}` : rg === 4 ? `${x}-${y}`
      : rg === 5 ? `${y}-${x}` : rg === 6 ? `${x}/${y}` : rg === 7 ? `${y}/${x}` : x;   // 2/3 = compare (returns x)

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
      cur = { flagIdx: -1, def: 0, use: 0 };   // fresh dead-flag record for this instruction
      instrs.push(cur);

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
        case 0x27: cur.use |= lC | lA; P('cpu.daa();'); break;
        case 0x2f: cur.use |= lC | lA; P('cpu.das();'); break;
        case 0x37: cur.use |= lC | lA; P('cpu.aaa();'); break;
        case 0x3f: cur.use |= lC | lA; P('cpu.aas();'); break;

        // ---- INC/DEC reg16 ----
        case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}+1)${M(sz)};${rW(i, sz, rr)}`); PFLAG(`cpu.setAdd(${a},1,${rr},${sz},false);`, lNOC); break;
        }
        case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: {
          const i = op & 7, a = NT(), rr = NT();
          P(`var ${a}=${rR(i, sz)};var ${rr}=(${a}-1)${M(sz)};${rW(i, sz, rr)}`); PFLAG(`cpu.setSub(${a},1,${rr},${sz},false);`, lNOC); break;
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
        case 0x9c: cur.use |= lALL; P('cpu.push16(cpu.flags&0xffff);'); break;          // PUSHF (reads all)
        case 0x9d: P('cpu.flags=(cpu.pop16()&0xfd5)|2;'); break;                         // POPF
        case 0x9e: P('cpu.flags=(cpu.flags&~0xff)|(((r[0]>>>8)&0xd5))|2;'); break;       // SAHF
        case 0x9f: cur.use |= lC | lP | lA | lZ | lS; P('r[0]=(r[0]&~0xff00)|((((cpu.flags&0xd5)|2)&0xff)<<8);'); break; // LAHF (reads CPAZS)

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

        case 0xd4: cur.use |= lALL; P(`cpu.aam(${f8()});`); break; // AAM (may fault mid-block → barrier)
        case 0xd5: P(`cpu.aad(${f8()});`); break; // AAD
        case 0xd6: cur.use |= lC; P(`r[0]=(r[0]&~0xff)|((cpu.flags&${CF})?0xff:0);`); break; // SALC (reads CF)
        case 0xd7: P(`r[0]=(r[0]&~0xff)|m.r8(${lin(segOv >= 0 ? segOv : DS, '((r[3]+ (r[0]&0xff))&0xffff)')});`); break; // XLAT

        // ---- x87 FPU (D8-DF): emit the specific op inline ----
        case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf: {
          const o = modrm();
          if (NOFPUINLINE) {                          // A/B fallback: runtime dispatch
            if (o.isReg) P(`cpu.fpuReg(${op},${o.reg},${o.rm});`);
            else P(`cpu.fpuMem(${op},${o.reg},${memAddr(o)});`);
          } else {
            usesFPU = true;
            if (o.isReg) emitFPUReg(op, o.reg, o.rm);
            else emitFPUMem(op, o.reg, o);
          }
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
        case 0xf5: cur.use |= lC; P(`cpu.flags^=${CF};`); break;                        // CMC (reads CF)
        case 0xf6: emitGroup3(8); break;
        case 0xf7: emitGroup3(sz); break;
        case 0xf8: P(`cpu.flags&=~${CF};`); break;                                      // CLC
        case 0xf9: P(`cpu.flags|=${CF};`); break;                                       // STC
        case 0xfa: P(`cpu.flags&=~${IF};`); break;                                      // CLI
        case 0xfb: P(`cpu.flags|=${IF};`); break;                                       // STI
        case 0xfc: P(`cpu.flags&=~${DF};`); break;                                      // CLD
        case 0xfd: P(`cpu.flags|=${DF};`); break;                                       // STD
        case 0xfe: { const o = modrm(); const a = NT(), rr = NT(); if (o.reg === 0) { P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}+1)&0xff;${rmW(o, 8, rr)}`); PFLAG(`cpu.setAdd(${a},1,${rr},8,false);`, lNOC); } else { P(`var ${a}=${rmR(o, 8)};var ${rr}=(${a}-1)&0xff;${rmW(o, 8, rr)}`); PFLAG(`cpu.setSub(${a},1,${rr},8,false);`, lNOC); } break; }
        case 0xff: emitGroup5(sz); break;

        case 0x0f: { decode0F(sz); break; }

        default:
          throw new Error('mirage: unimplemented opcode 0x' + op.toString(16).padStart(2, '0') + ' at ' + ((linStart - ip0 + ip - 1) & MM).toString(16));
      }
    }

    if (!ended) P(`cpu.eip=${ip};`);

    // ---- dead-flag elimination ----
    // Backward liveness over the block's instructions: strip a flag-setting call whose
    // defined flags are ALL dead at that point. Live-out of the block is ALL 6 flags —
    // the next block (or an external reader between slices) may consume them — so the
    // last flag writer never strips; only intermediate dead ones do (e.g. address-math
    // ADDs feeding nothing before the block-final CMP+Jcc). stepOne compiles a single
    // instruction, so live is always ALL and nothing is ever stripped → the conformance
    // path is byte-identical by construction.
    if (!NOSTRIP) {
      let live = lALL;
      for (let i = instrs.length - 1; i >= 0; i--) {
        const n = instrs[i];
        if (n.flagIdx >= 0 && (n.def & live) === 0) out[n.flagIdx] = '';
        live = (live & ~n.def) | n.use;
      }
    }

    const pre = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;' + (usesFPU ? 'var st=cpu.fst,dv=m.dv;' : '');
    const body = pre + '\n' + out.join('\n');
    const fn = new Function('cpu', body);
    return { fn, linStart, linEnd: (linStart - ip0 + ip) & MM, ip0, ipEnd: ip, count, body };

    // ===================== nested emit helpers =====================

    // ---- x87 inline emission ---------------------------------------------------
    // Mirrors src/fpu.js exactly, but with op/reg/rm known at compile time we emit the
    // one operation's JS directly instead of the giant runtime switch. Uses the block
    // aliases `st` (cpu.fst) and `dv` (m.dv); cpu.ftop stays on the object (no local
    // mirror) so it is always correct at every block exit with no flush. Anything not
    // explicitly recognised routes to the cpu.fpuMem/fpuReg fallback (= today's code),
    // which is also the safety net for future opcodes. `cpu.fcmp`/`cpu.f2i` are the
    // shared compare / round-to-int helpers exported from fpu.js. (The string helpers
    // STe/setSTe/fpush/FPOP/arithE are defined before the decode loop.)
    function emitFPUMem(op, reg, o) {
      const a = memAddr(o);
      const fb = () => P(`cpu.fpuMem(${op},${reg},${a});`);
      const smc = (len) => `if(cp[${a}>>>12]|cp[((${a}+${len - 1})&${MM})>>>12])m._dirty(${a},${len});`;
      switch (op) {
        case 0xd9:                                                   // f32 load/store + control
          if (reg === 0) return fpush(`dv.getFloat32(${a},true)`);           // FLD m32
          if (reg === 2) return P(`dv.setFloat32(${a},st[cpu.ftop],true);${smc(4)}`);        // FST m32
          if (reg === 3) return P(`dv.setFloat32(${a},st[cpu.ftop],true);${smc(4)}${FPOP}`); // FSTP m32
          if (reg === 7) return P(`m.w16(${a},0x037f);`);                    // FNSTCW (w16 does SMC)
          return fb();
        case 0xdd:                                                   // f64 load/store
          if (reg === 0) return fpush(`dv.getFloat64(${a},true)`);           // FLD m64
          if (reg === 2) return P(`dv.setFloat64(${a},st[cpu.ftop],true);${smc(8)}`);        // FST m64
          if (reg === 3) return P(`dv.setFloat64(${a},st[cpu.ftop],true);${smc(8)}${FPOP}`); // FSTP m64
          if (reg === 7) return P(`m.w16(${a},((cpu.fsw&0x47ff)|((cpu.ftop&7)<<11)));`);      // FNSTSW m16
          return fb();
        case 0xdb:                                                   // i32 load/store
          if (reg === 0) return fpush(`dv.getInt32(${a},true)`);             // FILD m32
          if (reg === 2) return P(`m.w32(${a},cpu.f2i(st[cpu.ftop])>>>0);`);            // FIST m32
          if (reg === 3) return P(`m.w32(${a},cpu.f2i(st[cpu.ftop])>>>0);${FPOP}`);     // FISTP m32
          return fb();
        case 0xdf:                                                   // i16 load/store
          if (reg === 0) return fpush(`dv.getInt16(${a},true)`);             // FILD m16
          if (reg === 2) return P(`m.w16(${a},cpu.f2i(st[cpu.ftop])&0xffff);`);         // FIST m16
          if (reg === 3) return P(`m.w16(${a},cpu.f2i(st[cpu.ftop])&0xffff);${FPOP}`);  // FISTP m16
          return fb();
      }
      // arithmetic with a memory source: D8=f32, DC=f64, DA=i32, DE=i16
      const vexpr = op === 0xd8 ? `dv.getFloat32(${a},true)` : op === 0xdc ? `dv.getFloat64(${a},true)`
        : op === 0xda ? `dv.getInt32(${a},true)` : `dv.getInt16(${a},true)`;
      const vt = NT(), xt = NT();
      P(`var ${vt}=${vexpr},${xt}=st[cpu.ftop];`);
      if (reg === 2) return P(`cpu.fcmp(${xt},${vt});`);                     // FCOM
      if (reg === 3) return P(`cpu.fcmp(${xt},${vt});${FPOP}`);             // FCOMP
      return P(setSTe(0, arithE(reg, xt, vt)));                             // FADD/FMUL/FSUB/FSUBR/FDIV/FDIVR
    }

    function emitFPUReg(op, reg, rm) {
      const b = 0xc0 | (reg << 3) | rm;
      const fb = () => P(`cpu.fpuReg(${op},${reg},${rm});`);
      switch (op) {
        case 0xd9:
          if (b < 0xc8) return fpush(STe(rm));                              // FLD ST(i) (pre-push read)
          if (b < 0xd0) { const t = NT(); P(`var ${t}=st[cpu.ftop];${setSTe(0, STe(rm))}${setSTe(rm, t)}`); return; } // FXCH
          switch (b) {
            case 0xe0: return P(setSTe(0, '-st[cpu.ftop]'));                // FCHS
            case 0xe1: return P(setSTe(0, 'Math.abs(st[cpu.ftop])'));       // FABS
            case 0xe5: return;                                             // FXAM (cc omitted, as fpu.js)
            case 0xe8: return fpush('1');                                  // FLD1
            case 0xe9: return fpush('Math.log2(10)');                      // FLDL2T
            case 0xea: return fpush('Math.LOG2E');                         // FLDL2E
            case 0xeb: return fpush('Math.PI');                            // FLDPI
            case 0xec: return fpush('Math.log10(2)');                      // FLDLG2
            case 0xed: return fpush('Math.LN2');                           // FLDLN2
            case 0xee: return fpush('0');                                  // FLDZ
            case 0xf0: return P(setSTe(0, 'Math.pow(2,st[cpu.ftop])-1'));   // F2XM1
            case 0xf1: P(setSTe(1, `${STe(1)}*Math.log2(st[cpu.ftop])`)); return P(FPOP); // FYL2X
            case 0xf2: P(setSTe(0, 'Math.tan(st[cpu.ftop])')); return fpush('1');         // FPTAN
            case 0xf3: P(setSTe(1, `Math.atan2(${STe(1)},st[cpu.ftop])`)); return P(FPOP); // FPATAN
            case 0xf4: { const x = NT(); P(`var ${x}=st[cpu.ftop];${setSTe(0, `${x}-Math.trunc(${x})`)}`); return fpush(`Math.trunc(${x})`); } // FXTRACT-ish
            case 0xf8: return P(setSTe(0, `st[cpu.ftop]%${STe(1)}`));       // FPREM
            case 0xfa: return P(setSTe(0, 'Math.sqrt(st[cpu.ftop])'));      // FSQRT
            case 0xfb: { const x = NT(); P(`var ${x}=st[cpu.ftop];${setSTe(0, `Math.sin(${x})`)}`); return fpush(`Math.cos(${x})`); } // FSINCOS
            case 0xfc: return P(setSTe(0, 'cpu.f2i(st[cpu.ftop])'));        // FRNDINT
            case 0xfd: return P(setSTe(0, `st[cpu.ftop]*Math.pow(2,Math.trunc(${STe(1)}))`)); // FSCALE
            case 0xfe: return P(setSTe(0, 'Math.sin(st[cpu.ftop])'));       // FSIN
            case 0xff: return P(setSTe(0, 'Math.cos(st[cpu.ftop])'));       // FCOS
          }
          return fb();
        case 0xd8: {                                                       // arith with ST(i), result to ST(0)
          const xt = NT(), yt = NT();
          P(`var ${xt}=st[cpu.ftop],${yt}=${STe(rm)};`);
          P(setSTe(0, arithE(reg, xt, yt)));
          if (reg === 2 || reg === 3) P(`cpu.fcmp(${xt},${yt});`);
          if (reg === 3) P(FPOP);
          return;
        }
        case 0xdc:                                                         // arith to ST(i) (reversed quirk)
          if (reg === 2 || reg === 3) { P(`cpu.fcmp(st[cpu.ftop],${STe(rm)});`); if (reg === 3) P(FPOP); return; }
          return P(setSTe(rm, arithE(reg, 'st[cpu.ftop]', STe(rm))));
        case 0xde:                                                         // arith to ST(i) + pop (faddp etc.)
          if (b === 0xd9) { P(`cpu.fcmp(st[cpu.ftop],${STe(1)});`); P(FPOP); return P(FPOP); } // FCOMPP
          P(setSTe(rm, arithE(reg, 'st[cpu.ftop]', STe(rm)))); return P(FPOP);
        case 0xdd:
          if (b < 0xc8) return;                                            // FFREE ST(i)
          if (b < 0xd8) return P(setSTe(rm, 'st[cpu.ftop]'));              // FST ST(i)
          if (b < 0xe0) { P(setSTe(rm, 'st[cpu.ftop]')); return P(FPOP); } // FSTP ST(i)
          P(`cpu.fcmp(st[cpu.ftop],${STe(rm)});`); if (b >= 0xe8) P(FPOP); return; // FUCOM/FUCOMP
        case 0xdf:
          if (b === 0xe0) return P(`r[0]=(r[0]&~0xffff)|(((cpu.fsw&0x47ff)|((cpu.ftop&7)<<11))&0xffff);`); // FNSTSW AX
          return fb();
        default:                                                           // DA/DB reg forms: rare → fallback
          return fb();
      }
    }

    function emitShift(o, size, cnt) {
      const rot = o.reg;   // 0 rol,1 ror,2 rcl,3 rcr,4/6 shl,5 shr,7 sar
      if (rot === 2 || rot === 3) cur.use |= lC;   // RCL/RCR rotate through carry — read CF
      // Inline the logical/arithmetic shifts with a COMPILE-TIME count (C0/C1/D0/D1) for
      // 8/16-bit — the hot forms. Mirrors cpu.shl/shr/sar exactly; setShiftResult is a
      // strippable PFLAG (def CF/OF/PF/ZF/SF, AF preserved). CL-count (D2/D3, runtime c==0
      // branch), rotates, and 32-bit keep the helper call.
      const isShift = rot === 4 || rot === 5 || rot === 6 || rot === 7;
      if (isShift && size !== 32 && /^\d+$/.test(cnt)) {
        const C = Number(cnt) & 0x1f;
        if (C === 0) return;   // shift by 0: value and flags unchanged (byte-exact no-op)
        const mask = size === 8 ? 0xff : 0xffff, msb = size - 1;
        const v = NT(), res = NT(), cf = NT(), of = NT();
        if (rot === 5) {                                   // SHR
          P(`var ${v}=(${rmR(o, size)})&${mask};var ${res}=(${v}>>>${C})&${mask};`);
          P(rmW(o, size, res));
          P(`var ${cf}=(${v}>>>${C - 1})&1;var ${of}=${C === 1 ? `((${v}>>>${msb})&1)` : '0'};`);
        } else if (rot === 7) {                            // SAR
          const sv = NT();
          P(`var ${v}=(${rmR(o, size)})&${mask};var ${sv}=((${v}&${1 << msb})?(${v}|${~mask}):${v})|0;var ${res}=(${sv}>>${C})&${mask};`);
          P(rmW(o, size, res));
          P(`var ${cf}=(${sv}>>${C - 1})&1;var ${of}=0;`);
        } else {                                           // SHL (rot 4 or 6)
          P(`var ${v}=(${rmR(o, size)})&${mask};var ${res}=(${v}<<${C})&${mask};`);
          P(rmW(o, size, res));
          P(`var ${cf}=${C <= size ? `((${v}>>>${size - C})&1)` : '0'};var ${of}=${C === 1 ? `(((${res}>>>${msb})&1)^${cf})` : '0'};`);
        }
        PFLAG(`cpu.setShiftResult(${res},${size},!!${cf},!!${of});`, lC | lP | lZ | lS | lO);
        return;
      }
      const ops = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
      P(rmW(o, size, `cpu.${ops[rot]}(${rmR(o, size)},${cnt},${size})`));
    }

    function emitGroup3(size) {
      const o = modrm();
      switch (o.reg) {
        case 0: case 1: { const i = size === 8 ? f8() : (size === 16 ? f16() : (f16() | (f16() << 16))); alu('test', rmR(o, size), null, '' + (i >>> 0), size); break; }
        case 2: P(rmW(o, size, `(~${rmR(o, size)})`)); break;                            // NOT
        case 3: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, size)};var ${rr}=(0-${a})${M(size)};${rmW(o, size, rr)}`); PFLAG(`cpu.setSub(0,${a},${rr},${size});`, lALL); break; } // NEG
        case 4:                                                                         // MUL
          if (size === 16) { const s = NT(), p = NT(), hi = NT();
            P(`var ${s}=(${rmR(o, 16)})&0xffff;var ${p}=(r[0]&0xffff)*${s};var ${hi}=(${p}/65536)&0xffff;r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|${hi};`);
            PFLAG(`cpu.setShiftResult(0,16,${hi}!==0,${hi}!==0,false);`, lC | lO);
          } else P(`cpu.${size === 8 ? 'mul8' : 'mul16'}(${rmR(o, size)});`);   // 8-bit; 32-bit (66h) → mul16 as before
          break;
        case 5:                                                                         // IMUL
          if (size === 16) { const s = NT(), a = NT(), p = NT();
            P(`var ${s}=((${rmR(o, 16)})<<16)>>16;var ${a}=((r[0]&0xffff)<<16)>>16;var ${p}=${a}*${s};r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|((${p}>>16)&0xffff);`);
            PFLAG(`cpu.setShiftResult(0,16,(${p}<-32768||${p}>32767),(${p}<-32768||${p}>32767),false);`, lC | lO);
          } else P(`cpu.${size === 8 ? 'imul8' : 'imul16'}(${rmR(o, size)});`);
          break;
        case 6: cur.use |= lALL; P(`cpu.${size === 8 ? 'div8' : 'div16'}(${rmR(o, size)});`); break;   // DIV (may fault → barrier)
        case 7: cur.use |= lALL; P(`cpu.${size === 8 ? 'idiv8' : 'idiv16'}(${rmR(o, size)});`); break; // IDIV (may fault → barrier)
      }
    }

    function emitGroup5(sz) {
      const o = modrm();
      switch (o.reg) {
        case 0: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}+1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(`cpu.setAdd(${a},1,${rr},${sz},false);`, lNOC); break; }
        case 1: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}-1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(`cpu.setSub(${a},1,${rr},${sz},false);`, lNOC); break; }
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
      if (op2 >= 0x90 && op2 <= 0x9f) { cur.use |= lALL; const o = modrm(); P(rmW(o, 8, `${condExpr(op2 & 0xf)}?1:0`)); return; }
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
        case 0x31: P('cpu.reg[0]=(cpu.cycles>>>0);cpu.reg[2]=(Math.floor(cpu.cycles/4294967296))>>>0;'); return; // RDTSC → EDX:EAX
        case 0xa0: P(`cpu.push16(cpu.seg[${FS}]);`); return;                            // PUSH FS
        case 0xa1: P(`cpu.setSeg(${FS},cpu.pop16());`); return;                         // POP FS
        case 0xa8: P(`cpu.push16(cpu.seg[${GS}]);`); return;                            // PUSH GS
        case 0xa9: P(`cpu.setSeg(${GS},cpu.pop16());`); return;                         // POP GS
        case 0xa3: { const o = modrm(); bt(o, 'bt', rR(o.reg, sz)); return; }            // BT
        case 0xab: { const o = modrm(); bt(o, 'bts', rR(o.reg, sz)); return; }           // BTS
        case 0xb3: { const o = modrm(); bt(o, 'btr', rR(o.reg, sz)); return; }           // BTR
        case 0xbb: { const o = modrm(); bt(o, 'btc', rR(o.reg, sz)); return; }           // BTC
        case 0xba: { const o = modrm(); const imm = f8(); bt(o, ['bt', 'bt', 'bt', 'bt', 'bt', 'bts', 'btr', 'btc'][o.reg], '' + imm); return; }
        case 0xb2: { const o = modrm(); const a = memAddr(o); P(`${rW(o.reg, 16, `m.r16(${a})`)}cpu.setSeg(${SS},m.r16((${a}+2)&${MM}));`); return; } // LSS
        case 0xb4: { const o = modrm(); const a = memAddr(o); P(`${rW(o.reg, 16, `m.r16(${a})`)}cpu.setSeg(${FS},m.r16((${a}+2)&${MM}));`); return; } // LFS
        case 0xb5: { const o = modrm(); const a = memAddr(o); P(`${rW(o.reg, 16, `m.r16(${a})`)}cpu.setSeg(${GS},m.r16((${a}+2)&${MM}));`); return; } // LGS
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
