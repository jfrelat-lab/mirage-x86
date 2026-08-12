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
import { resolveMemStrategy, memEmitters, memPrologue } from './mem-strategy.js';

// Which memory-dispatch emission to use; see mem-strategy.js. Default reproduces the previous
// emission character-for-character, so selecting it is provably a no-op.
const MEM_DEFAULT = resolveMemStrategy();

const NOSTRIP = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_NOSTRIP);
// The tier-2 region compiler fuses a hot block and its statically-reachable successors into one
// function (a switch-in-loop) so inter-block dispatch disappears on hot loops. It's byte-identical
// to tier-1 (golden + conformance + fuzz-region), but on real GAMES it has unresolved issues — a
// fused region can run unbounded work per slice (Cosmo's decompression hangs a single runSlice),
// Wolf3D runs ~5× slower, and Keen once derailed on a far-indirect pattern. So it stays a Node-only
// Wolf3D runs ~5× slower, and Keen once derailed on a far-indirect pattern.
//
// It is therefore OFF everywhere, opt-in via MIRAGE_TIER2=1 for perf work on it. It used to be ON
// by default in Node and off in the browser, which had a consequence worth spelling out: every
// headless perf number — tools/bench.js, the roadmap's targets — measured a configuration nobody
// ever ran. And the "unbounded work per slice" defect is not a corner case: intros/memories.com
// takes >300s for work tier-1 does in 8.5ms, a >30,000× cliff that made bench.js look hung.
// Turn it back on by default once regions carry an instruction budget and the game bugs are fixed.
const TIER2 = typeof process !== 'undefined' && !!(process.env && process.env.MIRAGE_TIER2);
const T2_HOT = 64;         // promote a block to a region after this many executions
const T2_MAXBLK = 24;      // cap region size in blocks
const T2_MAXINS = 384;     // cap region size in instructions
const T2_BLACKLIST = 3;    // stop re-forming a root after this many SMC evictions

// Abstract flag-liveness bit set (NOT the EFLAGS register layout) for the dead-flag pass:
// which of the 6 arithmetic flags an instruction defines / uses. Full ALU ops def all 6;
// INC/DEC def all-but-carry (they preserve CF).
const lC = 1, lP = 2, lA = 4, lZ = 8, lS = 16, lO = 32, lALL = 63, lNOC = lALL & ~lC;

// Condition code cc (0..15 = O NO B AE Z NZ BE A S NS P NP L GE LE G) as an inline
// boolean bit-test on cpu.flags — replaces the cpu.cond(cc) call. Shared by the block
// emitter (Jcc/SETcc) and the region compiler. sfNeOf = (SF != OF).
const _sfNeOf = `((cpu.flags>>>7^cpu.flags>>>11)&1)`;
function condExpr(cc) {
  switch (cc) {
    case 0x0: return `(cpu.flags&${OF})`;              case 0x1: return `!(cpu.flags&${OF})`;
    case 0x2: return `(cpu.flags&${CF})`;              case 0x3: return `!(cpu.flags&${CF})`;
    case 0x4: return `(cpu.flags&${ZF})`;              case 0x5: return `!(cpu.flags&${ZF})`;
    case 0x6: return `(cpu.flags&${CF | ZF})`;         case 0x7: return `!(cpu.flags&${CF | ZF})`;
    case 0x8: return `(cpu.flags&${SF})`;              case 0x9: return `!(cpu.flags&${SF})`;
    case 0xa: return `(cpu.flags&${PF})`;              case 0xb: return `!(cpu.flags&${PF})`;
    case 0xc: return _sfNeOf;                          case 0xd: return `!${_sfNeOf}`;
    case 0xe: return `((cpu.flags&${ZF})||${_sfNeOf})`; case 0xf: return `(!(cpu.flags&${ZF})&&!${_sfNeOf})`;
  }
}

export class Recompiler {
  constructor(cpu) {
    this.cpu = cpu;
    this.mem = cpu.mem;
    this.MM = this.mem.mask;
    this.memStrategy = MEM_DEFAULT;   // switched to `paged` when the guest enables paging
    // Block lookup: a 2-level page array (blockPages[lin>>>12][lin&0xfff] -> block)
    // rather than a Map — pure integer indexing on the hot dispatch path, no hashing
    // (V8's Map always routes through FindOrderedHashMapEntry even for SMI keys).
    // Indexed by (lin & 0xfff) | (csD << 12): the same bytes decode differently under a 16-bit and a
    // 32-bit code segment, so a block is only valid for the CS.D it was translated with.
    this.blockPages = [];          // page -> Array(8192) of block | undefined
    this.pageBlocks = new Map();   // page -> Set(lin) — for SMC invalidation sweeps
    // Per-page block-coverage bounds [pageLo, pageHi) — the min linStart / max linEnd of
    // any block touching a page. A write outside a page's bound can overlap no block, so
    // invalidate() skips the whole scan (the hot case for demos that write a data buffer
    // into a page that also holds code, e.g. tube's pixel buffer). Bounds only grow (an
    // eviction leaves them a safe over-approximation), so a stale-wide bound just falls
    // back to the full scan — never a missed invalidation.
    this.pageLo = [];
    this.pageHi = [];
    this.heat = new Map();         // lin -> exec count (for the JIT heatmap)
    this.profiling = false;        // gate heat tracking off the hot path
    this.stats = { compiles: 0, exec: 0, invalidations: 0, t2compiles: 0, t2evicts: 0 };
    this.t2evict = new Map();      // region root lin -> SMC-eviction count (for the blacklist)
    this.t2blacklist = new Set();  // roots that self-modify too much -> stay tier-1
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
      if (end <= this.pageLo[p] || addr >= this.pageHi[p]) continue;   // write outside all blocks on this page
      for (const lin of set) {
        const pg = this.blockPages[lin >>> 12];
        const blk = pg !== undefined ? (pg[lin & 0xfff] || pg[(lin & 0xfff) | 0x1000]) : undefined;
        if (!blk) { set.delete(lin); continue; }              // stale entry
        if (blk.ranges) { if (blk.ranges.some(([s, e]) => s < end && addr < e)) this._evictRegion(blk, lin); }
        else if (blk.linStart < end && addr < blk.linEnd) this._evict(blk, lin);
      }
      if (set.size === 0) this.mem.clearCodePage(p);            // page no longer holds code
    }
  }

  _evict(blk, lin) {
    const pg = this.blockPages[lin >>> 12];
    if (pg !== undefined) { pg[lin & 0xfff] = undefined; pg[(lin & 0xfff) | 0x1000] = undefined; }   // both CS.D variants
    this.heat.delete(lin);
    this.stats.invalidations++;
    for (let p = blk.linStart >>> 12; p <= (blk.linEnd - 1) >>> 12; p++) {
      const s = this.pageBlocks.get(p); if (s) s.delete(lin);
    }
  }

  reset() { this.blockPages = []; this.pageBlocks.clear(); this.heat.clear(); this.pageLo = []; this.pageHi = []; this.t2evict.clear(); this.t2blacklist.clear(); }

  // ===================== tier-2 region compiler =====================

  /** A hot block crossed T2_HOT: form a region rooted at it (the block plus its statically-
   *  reachable successors) and install one fused function in its place. Bails (staying tier-1)
   *  on a blacklisted root or a region too small to be worth it. */
  _promote(rootLin, rootIp0) {
    if (this.t2blacklist.has(rootLin)) return;
    // Derive the segment base from the ROOT's own identity, not the live cpu.base[CS]: the
    // root block may have just done a far transfer (CS changed) before this call, and using
    // the live base would walk successors in the wrong segment — pulling in blocks that merely
    // share the same IP offset (a CS:IP alias), whose fused code then derails the guest.
    const base = (rootLin - rootIp0) & this.MM;
    const byIp = new Map();     // ip -> tier-1 block (or null if unusable)
    const order = [];           // member ips, in discovery order
    const queue = [rootIp0];
    let ins = 0;
    while (queue.length && order.length < T2_MAXBLK && ins < T2_MAXINS) {
      const ip = queue.shift();
      if (byIp.has(ip)) continue;
      const blk = this._blockFor((base + ip) & this.MM, ip);
      if (!blk || blk.kind !== 0 || blk.canFault) { byIp.set(ip, null); continue; }   // absent/aliased/region/faulting → not a member
      byIp.set(ip, blk); order.push(ip); ins += blk.count;
      const t = blk.term;
      if (t.k === 'jmp') queue.push(t.t);
      else if (t.k === 'jcc' || t.k === 'loop' || t.k === 'jcxz') { queue.push(t.t, t.n); }
    }
    if (order.length < 2) return;   // one block fuses nothing — leave it tier-1
    this._installRegion(this._emitRegion(order, byIp, rootLin, rootIp0), rootLin);
  }

  /** Cached tier-1 block at (lin, ip0), compiling if absent; null if it's a region or the
   *  ip0 doesn't match (a CS:IP alias — can't be a region member). */
  _blockFor(lin, ip0) {
    const pg = this.blockPages[lin >>> 12];
    let blk = pg !== undefined ? pg[(lin & 0xfff) | (this.cpu.csD << 12)] : undefined;
    if (blk === undefined) blk = this._compile(lin, ip0);
    return blk.kind === 0 && blk.ip0 === ip0 ? blk : null;
  }

  /** Emit the fused region function: a `switch(_e)` over the member ips inside a `for(;;)`.
   *  An in-region edge is a local `_e=T;break` (re-dispatches the switch); an out-of-region
   *  edge (or an exit terminator) flushes retired-instruction count into cpu.cycles and
   *  returns. `_n` accumulates retired instructions; cpu.tbudget bounds a runaway loop. */
  _emitRegion(order, byIp, rootLin, rootIp0) {
    const members = new Set(order);
    let usesFPU = false;
    const ranges = [];
    // Budget: check-then-decrement, matching run()'s tier-1 loop (run B blocks for budget B),
    // so a region and tier-1 stop at exactly the same block boundary — same slice boundary,
    // same interrupt timing. cpu.cycles is bumped once per block AFTER its body (as tier-1's
    // run() does), so an in-block RDTSC reads the same count as tier-1. Byte-identical output.
    // `R.dead` is set by _evictRegion when a write invalidates this region mid-flight (SMC);
    // the guard stops the stale in-flight execution at the next iteration, bounding staleness
    // to one block like tier-1 (whose current block.fn also finishes after an eviction).
    // Safepoint: bail on the slice budget, or when a PIT tick is due AND interrupts are enabled.
    // The `&IF` is essential: run() only delivers the timer (and advances the deadline) with IF
    // set. Bailing on the deadline while IF is clear would return WITHOUT decrementing tbudget and
    // without run() being able to advance the deadline → an infinite no-progress bail loop (a game
    // running a hot loop under CLI past a due tick). With IF clear we keep running, bounded by
    // tbudget; the pending tick is delivered once the guest re-enables interrupts.
    const out = [`var _e=${rootIp0},dl=cpu.deadline;`, 'for(;;){', 'if(R.dead){cpu.eip=_e;return;}',
      `if(cpu.tbudget<=0||(cpu.cycles>=dl&&(cpu.flags&${IF}))){cpu.eip=_e;return;}`, 'cpu.tbudget--;', 'switch(_e){'];
    for (const ip of order) {
      const b = byIp.get(ip);
      if (b.usesFPU) usesFPU = true;
      ranges.push([b.linStart, b.linEnd]);
      out.push(`case ${ip}:{`);
      if (b.term.k === 'exit') out.push(`cpu.cycles+=${b.count};`, b.bodyOut.join('\n'), 'return;');
      else out.push(b.bodyOut.join('\n'), `cpu.cycles+=${b.count};`, this._edgeCode(b.term, members));
      out.push('}');
    }
    out.push('default:cpu.eip=_e;return;', '}}');
    const pre = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;' + memPrologue(this.memStrategy) + (usesFPU ? 'var st=cpu.fst,dv=m.dv;' : '');
    const body = pre + '\n' + out.join('\n');
    return { fn: new Function('cpu', 'R', body), kind: 2, ip0: rootIp0, count: 0, hot: -1, dead: 0, linStart: rootLin, linEnd: rootLin + 1, ranges, body };
  }

  /** The region-internal edge for a static terminator: an in-region target is a local jump
   *  (`_e=T;break`); an out-of-region target flushes cycles and returns to the dispatch loop. */
  _edgeCode(term, members) {
    const go = (ip) => members.has(ip) ? `_e=${ip};break;` : `cpu.eip=${ip};return;`;
    if (term.k === 'jmp') return go(term.t);
    const cond = term.k === 'jcc' ? condExpr(term.cc)
      : term.k === 'jcxz' ? (term.a32 ? '((r[1]>>>0)===0)' : '((r[1]&0xffff)===0)')
        : term.v === 0xe0 ? `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0&&!(cpu.flags&${ZF}))`
          : term.v === 0xe1 ? `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0&&(cpu.flags&${ZF}))`
            : `((${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'})!==0)`;
    return `if(${cond}){${go(term.t)}}else{${go(term.n)}}`;
  }

  _installRegion(region, rootLin) {
    const pg = rootLin >>> 12;
    let page = this.blockPages[pg]; if (page === undefined) page = this.blockPages[pg] = new Array(8192);
    page[(rootLin & 0xfff) | (this.cpu.csD << 12)] = region;    // replace the root's tier-1 block; constituents stay tier-1
    const pages = new Set();
    for (const [s, e] of region.ranges) for (let p = s >>> 12; p <= (e - 1) >>> 12; p++) pages.add(p);
    for (const p of pages) {
      this.mem.markCodePage(p);
      let set = this.pageBlocks.get(p); if (!set) { set = new Set(); this.pageBlocks.set(p, set); }
      set.add(rootLin);
      for (const [s, e] of region.ranges) {
        if (this.pageLo[p] === undefined || s < this.pageLo[p]) this.pageLo[p] = s;
        if (this.pageHi[p] === undefined || e > this.pageHi[p]) this.pageHi[p] = e;
      }
    }
    this.stats.t2compiles++;
  }

  _evictRegion(region, rootLin) {
    region.dead = 1;   // stop any in-flight execution of this region at its next iteration
    const pg = this.blockPages[rootLin >>> 12];
    if (pg !== undefined) { pg[rootLin & 0xfff] = undefined; pg[(rootLin & 0xfff) | 0x1000] = undefined; }
    this.stats.invalidations++; this.stats.t2evicts++;
    const pages = new Set();
    for (const [s, e] of region.ranges) for (let p = s >>> 12; p <= (e - 1) >>> 12; p++) pages.add(p);
    for (const p of pages) { const set = this.pageBlocks.get(p); if (set) set.delete(rootLin); }
    const c = (this.t2evict.get(rootLin) || 0) + 1; this.t2evict.set(rootLin, c);
    if (c >= T2_BLACKLIST) this.t2blacklist.add(rootLin);   // self-modifying loop → give up, stay tier-1
  }

  /** Run exactly one basic block from the current CS:IP. Returns its length. */
  step() {
    const cpu = this.cpu;
    const ip0 = cpu.eip & 0xffff;
    const lin = (cpu.base[CS] + ip0) & this.MM;
    // O(1) array index, no hashing. blk.ip0 guards the rare case of one linear addr
    // reached via different CS:IP (the emitted jump targets bake in ip0).
    const page = this.blockPages[lin >>> 12];
    let blk = page !== undefined ? page[(lin & 0xfff) | (this.cpu.csD << 12)] : undefined;
    if (blk === undefined || blk.ip0 !== ip0) blk = this._compile(lin, ip0);
    if (this.profiling) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
    this.stats.exec++;
    cpu.tbudget = 1 << 20;   // a region (if one is installed) self-bounds against this
    blk.fn(cpu, blk);
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
    // One shared block-execution budget: a tier-1 block costs 1, and a region decrements it
    // once per internal iteration (so a fused loop can't outrun the slice or hang the host).
    cpu.tbudget = maxBlocks;
    // A tier-2 region runs its loop internally without re-entering this dispatch loop, so it must
    // bail when a PIT tick comes due (else a timer-delay loop promoted to a region spins forever,
    // never letting INT 8 advance the counter it waits on). cpu.deadline is that bail threshold.
    cpu.deadline = machine.timerAuto ? machine.nextTimerCycle : Infinity;
    let n = 0;
    try {
      while (cpu.tbudget > 0 && !cpu.halted && !machine.blocked) {
        if (cpu.flags & IF) {                                                    // interrupts unmasked: service pending devices
          if (machine.hwIrqPending) machine.serviceHwInts();                     // queued keyboard IRQ
          if (machine.timerAuto && cpu.cycles >= machine.nextTimerCycle) machine.serviceTimer(); // PIT tick(s) due mid-slice
        }
        const ip0 = cpu.eip & 0xffff, lin = (cpu.base[CS] + ip0) & MM;
        // Trap Flag (hardware single-step): when TF is set, run exactly ONE instruction and
        // then fire INT 1. Uncached — each trapped instruction is freshly decoded, so a
        // self-modifying tracer (copy-protection decrypting code one step at a time inside
        // its INT-1 handler, e.g. Lemmings) sees the just-written bytes. swInt(1) clears TF
        // for the handler; its IRET restores TF and traps the next instruction in turn.
        if (cpu.flags & TF) {
          const blk = this.translate(lin, ip0, 1);
          blk.fn(cpu, blk);
          cpu.cycles += blk.count;
          cpu.tbudget--; n++;
          machine.swInt(1);
          continue;
        }
        const page = pages[lin >>> 12];
        let blk = page !== undefined ? page[(lin & 0xfff) | (cpu.csD << 12)] : undefined;
        if (blk === undefined || blk.ip0 !== ip0) blk = this._compile(lin, ip0);
        if (prof) this.heat.set(lin, (this.heat.get(lin) || 0) + 1);
        blk.fn(cpu, blk);
        cpu.cycles += blk.count;
        if (blk.kind === 0) { cpu.tbudget--; if (TIER2 && ++blk.hot === T2_HOT) this._promote(lin, ip0); }
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
    if (page === undefined) page = this.blockPages[pg] = new Array(8192);
    page[(lin & 0xfff) | (this.cpu.csD << 12)] = blk;
    const first = blk.linStart >>> 12, last = (blk.linEnd - 1) >>> 12;
    for (let p = first; p <= last; p++) {
      this.mem.markCodePage(p);
      let s = this.pageBlocks.get(p);
      if (!s) { s = new Set(); this.pageBlocks.set(p, s); }
      s.add(lin);
      if (this.pageLo[p] === undefined || blk.linStart < this.pageLo[p]) this.pageLo[p] = blk.linStart;
      if (this.pageHi[p] === undefined || blk.linEnd > this.pageHi[p]) this.pageHi[p] = blk.linEnd;
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
  translate(linStart, ip0, maxOps = MAXOPS, d = this.cpu.csD) {
    const mem = this.mem, MM = this.MM;
    // The CPU generation, read once per block. Every use below is a compile-time constant folded
    // into the emitted JS, so a profile costs nothing at run time — see src/cpu-profile.js.
    const PROF = this.cpu.profile, SHIFT_MASK = PROF.shiftCountMask;
    // Shared by LDS/LES/LSS/LFS/LGS: an offset at the effective address, then a 16-bit selector.
    // Its position depends on the operand size — +2 for a word offset, +4 for a dword.
    const loadPtr = (o, segIdx, size) => {
      const a = memAddr(o);
      return `${rW(o.reg, size, size === 16 ? `m.r16(${a})` : `m.r32(${a})>>>0`)}cpu.setSeg(${segIdx},m.r16((${a}+${size === 16 ? 2 : 4})&${MM}));`;
    };
    // BIOS service entry (f000:00..ff). Reached when a guest calls the ISR *inline* — reads the
    // vector from the IVT and far-JMP/CALLs f000:n instead of executing `INT n` (Secret Agent's
    // video probe does this: LDS BX,[0:40]; …; RETF into f000:10). The stub byte is 0xCF (IRET),
    // so a bare chain still no-ops; but here we run the JS handler first, then IRET, so an inline
    // BIOS call actually performs its service. Single-instruction "block".
    if (linStart === 0xf0200 && mem.u8[0xf0200] === 0xcb) {
      // DPMI mode-switch entry (f000:0200). The client FAR-CALLs it to be put into protected mode;
      // dpmiSwitch consumes the return address itself, because coming back means re-entering
      // through a SELECTOR — the one transition a RETF cannot express.
      const fn = new Function('cpu', 'cpu.dpmiSwitch();');
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'dpmi', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0 };
    }
    if (linStart === 0xf0100 && mem.u8[0xf0100] === 0xcb) {
      // XMS driver entry (f000:0100, marked with a 0xCB=RETF stub byte). A guest FAR-CALLs it with
      // AH=function (it got ES:BX from INT 2Fh AX=4310). Run the JS handler, then RETF (pop IP, pop
      // CS) back to the caller. The byte guard keeps the conformance harness (which overwrites the
      // address with real opcodes) from being hijacked.
      const fn = new Function('cpu', `cpu.xmsCall();cpu.eip=cpu.pop16();cpu.setSeg(${CS},cpu.pop16());`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: 'xms', term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0 };
    }
    if (linStart >= 0xf0000 && linStart < 0xf0100 && mem.u8[linStart] === 0xcf) {
      // Guard on the 0xCF stub byte: a real BIOS entry still holds its IRET stub, whereas the
      // conformance harness overwrites f000:xx with actual test opcodes — those must decode
      // normally, not be hijacked into a callback.
      const n = linStart - 0xf0000;
      const fn = new Function('cpu', `cpu.biosCallback(${n});`);
      return { fn, linStart, linEnd: linStart + 1, ip0, ipEnd: (ip0 + 1) & 0xffff, count: 1,
               body: `cpu.biosCallback(${n});`, term: { k: 'exit' }, bodyOut: [], usesFPU: false, canFault: false, hot: 0, kind: 0 };
    }
    const out = ['var t;'];
    const P = (s) => out.push(s);
    let ip = ip0, ended = false, tmp = 0, count = 0, usesFPU = false, canFault = false;
    const NT = () => '_' + (tmp++);

    // Terminator descriptor. Static, same-CS transfers (JMP rel / Jcc / LOOP / JCXZ) record
    // their target(s) here instead of emitting `cpu.eip=T;return` directly, so the region
    // compiler can follow those edges and rewire in-region ones to a local jump. Everything
    // else (RET/CALL/far/computed/INT/HLT/fall-through) is `exit`: it emits its own return
    // and ends any region. `t`/`n` are numeric target ips.
    let term = { k: 'exit' };

    // ---- dead-flag pass bookkeeping ----
    // One record per decoded instruction: `flagIdx` = out[] index of its strippable
    // flag-setting call (or -1), `def`/`use` = abstract flag masks. `cur` is the record
    // for the instruction being decoded. PFLAG emits a strippable flag call and tags it.
    // Default use=0 (transparent): only flag READERS set `cur.use` (enumerated below);
    // a forgotten reader is the one unsafe case, so the golden A/B gate covers it.
    const instrs = [];
    let cur = { flagIdx: -1, def: 0, use: 0 };
    const PFLAG = (stmt, def) => { cur.flagIdx = out.length; cur.def |= def; out.push(stmt); };

    // EIP is a full 32-bit offset in a 32-bit code segment; only a 16-bit segment wraps at 0xFFFF.
    // Masking it to 16 bits unconditionally — which every fetch and every relative target used to do
    // — silently truncates the moment EIP exceeds 0xFFFF. test386's FLAT section runs at linear
    // 0xe00f4f6d, so the first instruction was fetched correctly and every one after it was decoded
    // from the wrong address. `d` is the CS D bit, and the block cache is already keyed by it, so a
    // block compiled under one width is never reused under the other.
    const ipAdd = d ? (a, b) => (a + b) >>> 0 : (a, b) => (a + b) & 0xffff;

    // ---- byte fetch (decode-time reads from memory) ----
    const f8 = () => { const b = mem.r8((linStart - ip0 + ip) & MM); ip = ipAdd(ip, 1); return b; };
    const f16 = () => { const w = mem.r16((linStart - ip0 + ip) & MM); ip = ipAdd(ip, 2); return w; };
    const fs8 = () => { const b = f8(); return b < 128 ? b : b - 256; };
    const f32 = () => { const lo = f16(), hi = f16(); return (lo | (hi << 16)) >>> 0; };   // disp32 / moffs32 (0x67)

    // ---- operand-size / segment-override / rep prefixes ----
    let opsize, segOv, rep, addr32;
    const M = (sz) => sz === 8 ? '&0xff' : sz === 16 ? '&0xffff' : '>>>0';

    // ---- register operand source/sink as JS expressions ----
    const rR = (i, sz) => sz === 8 ? (i < 4 ? `(r[${i}]&0xff)` : `((r[${i - 4}]>>>8)&0xff)`)
      : sz === 16 ? `(r[${i}]&0xffff)` : `(r[${i}]>>>0)`;
    const rW = (i, sz, v) => sz === 8
      ? (i < 4 ? `r[${i}]=(r[${i}]&~0xff)|((${v})&0xff);` : `r[${i - 4}]=(r[${i - 4}]&~0xff00)|(((${v})&0xff)<<8);`)
      : sz === 16 ? `r[${i}]=(r[${i}]&~0xffff)|((${v})&0xffff);` : `r[${i}]=(${v})>>>0;`;

    // ---- ModR/M ----
    const lin = (seg, off) => `((sb[${seg}]+${off})&${MM})`;
    // 32-bit effective address (after a 0x67 prefix): the mod/rm grid is the 386 one — rm=100 means a
    // SIB byte follows, rm=101 with mod=0 means a bare disp32, and every other rm is a 32-bit register.
    // The default segment is SS when the BASE register is ESP or EBP, DS otherwise. Decoding this is
    // not optional: a 0x67 instruction is 1-5 bytes longer than its 16-bit lookalike, so skipping the
    // prefix (as v1 did) desynchronises the whole instruction stream — that is what derailed Heaven.
    const modrm32 = (mod, rm) => {
      let seg = DS, disp = 0; const parts = [];
      if (rm === 4) {                                     // SIB: scale(2) index(3) base(3)
        const sib = f8(), scale = sib >> 6, index = (sib >> 3) & 7, base = sib & 7;
        if (index !== 4) parts.push(scale ? `((r[${index}]>>>0)*${1 << scale})` : `(r[${index}]>>>0)`);
        if (base === 5 && mod === 0) disp = f32() | 0;     // no base register: disp32 follows
        else { parts.push(`(r[${base}]>>>0)`); if (base === 4 || base === 5) seg = SS; }
      } else if (rm === 5 && mod === 0) {
        disp = f32() | 0;                                  // bare disp32
      } else {
        parts.push(`(r[${rm}]>>>0)`);
        if (rm === 5) seg = SS;                            // [EBP]
      }
      if (mod === 1) disp += fs8(); else if (mod === 2) disp += f32() | 0;   // SIB is consumed BEFORE the disp
      if (disp) parts.push(`(${disp | 0})`);
      return { seg, off: `((${parts.length ? parts.join('+') : '0'})>>>0)` };
    };
    const modrm = () => {
      const b = f8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
      if (mod === 3) return { isReg: true, reg, rm };
      if (addr32) { const a = modrm32(mod, rm); return { isReg: false, reg, rm, seg: segOv >= 0 ? segOv : a.seg, off: a.off }; }
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
    // In EGA/VGA planar modes (m.planar), A000 access must go through the Sequencer/Graphics-
    // Controller plane logic, so route to m.r8/w8 etc. `m.planar` is false for text/mode-13h/
    // demos — a single predicted branch keeps the inline u8[] fast path unchanged there.
    // Route only ACTUAL A000 accesses (>>>16===0xA) through the plane logic — the inline
    // range check keeps every other access (stack/data/code, all of mode-13h) on the fast
    // u8[] path even while planar. `m.planar` is false for text/mode-13h/demos → short-circuit.
    const { memRead, memW } = memEmitters(this.memStrategy, MM, NT);
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

    // ---- block terminators ----
    const endJmp = (target) => { term = { k: 'jmp', t: +target }; ended = true; };
    const endJcc = (cc, target, next) => { term = { k: 'jcc', cc, t: +target, n: +next }; ended = true; };
    // Emit the tier-1 return form of the recorded terminator (byte-identical to the old
    // inline emission). The region compiler emits its own edge form from the same `term`.
    const emitTermReturn = () => {
      // term.t is already reduced to the code segment's width at decode time (see ipAdd), so the
      // old runtime `&0xffff` was redundant in 16-bit code and destructive in 32-bit code — it threw
      // away the top half of every branch target above 0xFFFF.
      if (term.k === 'jmp') P(`cpu.eip=${term.t};`);
      else if (term.k === 'jcc') P(`cpu.eip=${condExpr(term.cc)}?${term.t}:${term.n};`);
      else if (term.k === 'jcxz') P(`cpu.eip=(${term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)'}===0)?${term.t}:${term.n};`);
      else if (term.k === 'loop') {
        const cx = term.a32 ? '(r[1]>>>0)' : '(r[1]&0xffff)';                    // ECX under 0x67
        const c = term.v === 0xe0 ? `${cx}!==0&&!(cpu.flags&${ZF})`
          : term.v === 0xe1 ? `${cx}!==0&&(cpu.flags&${ZF})` : `${cx}!==0`;
        P(`cpu.eip=(${c})?${term.t}:${term.n};`);
      } else return;   // 'exit' — the block emitted its own return
      P('return;');
    };

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
      opsize = d ? 32 : 16; segOv = -1; rep = 0; addr32 = !!d;   // CS.D sets the defaults
      const ipStart = ip;                 // instruction start ip — fault return address (#BR etc.)
      // prefixes. Bounded: x86 caps an instruction at 15 bytes, so a longer prefix run is not
      // real code — it is garbage the tier-2 region walker speculatively reached (a Jcc/JMP
      // successor that lands in data). Without this cap the loop would consume prefix bytes
      // forever (wrapping the 64K segment), since `count` only advances past the prefixes.
      let op = f8(), pfx = 0;
      for (; pfx++ < 15;) {
        if (op === 0x66) { opsize = d ? 16 : 32; op = f8(); }        // operand-size: INVERTS the default
        else if (op === 0x67) { addr32 = !d; op = f8(); }           // address-size: inverts likewise
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
        case 0x06: P(sz === 16 ? `cpu.push16(cpu.seg[${ES}]);` : `cpu.push32(cpu.seg[${ES}]);`); break;
        case 0x07: P(sz === 16 ? `cpu.setSeg(${ES},cpu.pop16());` : `cpu.setSeg(${ES},cpu.pop32()&0xffff);`); break;
        // PUSH/POP of a segment register moves ONE STACK SLOT of the current operand size: 4 bytes
        // under a 32-bit operand size (0x66 in real mode, or a 32-bit code segment), 2 otherwise.
        // Only the low 16 bits are the selector; the rest is zero on push and discarded on pop.
        // test386 POST 9 asserts both the stored word AND the resulting ESP, which is what caught
        // this: emitting push16 unconditionally moved the stack by 2 where it owed 4.
        case 0x0e: P(sz === 16 ? `cpu.push16(cpu.seg[${CS}]);` : `cpu.push32(cpu.seg[${CS}]);`); break;
        case 0x16: P(sz === 16 ? `cpu.push16(cpu.seg[${SS}]);` : `cpu.push32(cpu.seg[${SS}]);`); break;
        case 0x17: P(sz === 16 ? `cpu.setSeg(${SS},cpu.pop16());` : `cpu.setSeg(${SS},cpu.pop32()&0xffff);`); break;
        case 0x1e: P(sz === 16 ? `cpu.push16(cpu.seg[${DS}]);` : `cpu.push32(cpu.seg[${DS}]);`); break;
        case 0x1f: P(sz === 16 ? `cpu.setSeg(${DS},cpu.pop16());` : `cpu.setSeg(${DS},cpu.pop32()&0xffff);`); break;

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
          // PUSH SP is the classic CPU-detection probe: an 8086/88 pushes SP *after* the decrement,
          // a 286+ pushes the value it had on entry. Every other register is unaffected.
          if ((op & 7) === 4 && sz === 16 && !PROF.pushSPOriginal) { P('cpu.push16((cpu.reg[4]-2)&0xffff);'); break; }
          P(sz === 32 ? `cpu.push32(${rR(op & 7, 32)});` : `cpu.push16(${rR(op & 7, 16)});`); break;
        case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f: {
          // Pop into a temp FIRST. A 16-bit write is emitted as `r[n]=(r[n]&~0xffff)|(expr&0xffff)`,
          // and JavaScript evaluates the left operand before calling expr — so `o16 pop sp` merged
          // the popped word into the ESP value from BEFORE the pop's own increment. With ESP at
          // 0x0001fffe the upper half stayed 0x0001 where the architecture gives 0x0002. Only SP is
          // affected (no other register aliases the stack pointer), and the low half is right either
          // way, so `cmp sp,imm` right after it still passes — the wrong ESP surfaces much later.
          // Sequencing also gives POP the defined behaviour of reading ESP after the increment.
          const t0 = NT();
          P(`var ${t0}=${sz === 32 ? 'cpu.pop32()' : 'cpu.pop16()'};`);
          P(rW(op & 7, sz, t0)); break;
        }

        case 0x60: // PUSHA / PUSHAD (66) — pushes the ORIGINAL SP/ESP, not the decremented one
          P(sz === 32
            // The pushed eSP is the ORIGINAL one, at the OPERAND width — SS.B chooses where the
            // pushes go, never what the value is. test386 POST 9 asserts exactly this.
            ? 'var _sp=cpu.reg[4]>>>0;cpu.push32(r[0]);cpu.push32(r[1]);cpu.push32(r[2]);cpu.push32(r[3]);cpu.push32(_sp);cpu.push32(r[5]);cpu.push32(r[6]);cpu.push32(r[7]);'
            : 'var _sp=cpu.sp;cpu.push16(r[0]);cpu.push16(r[1]);cpu.push16(r[2]);cpu.push16(r[3]);cpu.push16(_sp);cpu.push16(r[5]);cpu.push16(r[6]);cpu.push16(r[7]);'); break;
        case 0x61: // POPA / POPAD (66) — the pushed SP/ESP slot is discarded
          P(sz === 32
            ? `${rW(7, 32, 'cpu.pop32()')}${rW(6, 32, 'cpu.pop32()')}${rW(5, 32, 'cpu.pop32()')}cpu.pop32();${rW(3, 32, 'cpu.pop32()')}${rW(2, 32, 'cpu.pop32()')}${rW(1, 32, 'cpu.pop32()')}${rW(0, 32, 'cpu.pop32()')}`
            : `${rW(7, 16, 'cpu.pop16()')}${rW(6, 16, 'cpu.pop16()')}${rW(5, 16, 'cpu.pop16()')}cpu.pop16();${rW(3, 16, 'cpu.pop16()')}${rW(2, 16, 'cpu.pop16()')}${rW(1, 16, 'cpu.pop16()')}${rW(0, 16, 'cpu.pop16()')}`); break;
        case 0x62: {                                                                   // BOUND Gv,Ma → #BR (INT 5) if index ∉ [lower,upper] (signed)
          canFault = true; const o = modrm(); const a = memAddr(o);
          const rd = sz === 16 ? 'r16' : 'r32', sx = sz === 16 ? '<<16>>16' : '|0', d = sz >> 3;
          const idx = NT(), lo = NT(), hi = NT();
          P(`var ${idx}=(${rR(o.reg, sz)})${sx};var ${lo}=(m.${rd}(${a}))${sx};var ${hi}=(m.${rd}((${a}+${d})&${MM}))${sx};`);
          P(`if(${idx}<${lo}||${idx}>${hi}){cpu.eip=${ipStart};cpu.swInt(5);return;}`); break;
        }

        case 0x68: { const i = sz === 16 ? f16() : ((f16() | (f16() << 16)) >>> 0); P(sz === 32 ? `cpu.push32(${i});` : `cpu.push16(${i & 0xffff});`); break; } // PUSH Iz
        case 0x6a: { const v = fs8(); P(sz === 32 ? `cpu.push32(${v >>> 0});` : `cpu.push16(${v & 0xffff});`); break; } // PUSH Ib (sign-extended to opsize)
        case 0x69: { const o = modrm(); const s = rmR(o, sz); const i = sz === 16 ? f16() : (f16() | (f16() << 16)); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6b: { const o = modrm(); const s = rmR(o, sz); const i = fs8(); P(`cpu.imul16x(${s},${i},${sz});`); P(rW(o.reg, sz, 'cpu._mr')); break; }
        case 0x6c: emitStr('ins', 8); break;                                            // INSB
        case 0x6d: emitStr('ins', sz); break;                                           // INSW/D
        case 0x6e: emitStr('outs', 8); break;                                           // OUTSB
        case 0x6f: emitStr('outs', sz); break;                                          // OUTSW/D

        // ---- Jcc rel8 ----
        case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
          const rel = fs8(); endJcc(op & 0xf, ipAdd(ip, rel), ip); break;
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
        // ARPL r/m16, r16 — adjust the destination's RPL up to the source's, setting ZF when it had
        // to. Protected mode only: a 386 in real mode raises #UD on 0x63, and a CPU-detection
        // routine probing for it must get that answer, so the mode test is emitted rather than
        // assumed. (This is also the opcode games/TURBOPAS/TURBO.EXE faults on.)
        case 0x63: {
          const o = modrm(), d = NT(), sr = NT();
          canFault = true;
          P(`if(!(cpu.cr0&1)){cpu.eip=${ipStart};cpu.swInt(6);return;}`);
          P(`var ${d}=${rmR(o, 16)},${sr}=${rR(o.reg, 16)};`);
          P(`if((${d}&3)<(${sr}&3)){cpu.flags|=${ZF};${rmW(o, 16, `((${d}&~3)|(${sr}&3))`)}}else cpu.flags&=~${ZF};`);
          break;
        }
        case 0x8e: {                                                                    // MOV Sw,Ew
          const o = modrm();
          // reg=001 selects CS, and `MOV CS,r/m` does not exist — a real CPU raises #UD. We used to
          // execute it, which test386.asm catches: its POST-3 fault test expects INT 6 and got a
          // normal retirement. Nothing legitimate does this, but a CPU-detection routine probing an
          // instruction's existence via #UD gets the wrong answer, and the exception has to end the
          // block for the same reason DIV's #DE does — otherwise the terminator overwrites cpu.eip
          // and silently discards the interrupt on a stack that already holds an IRET frame.
          if (o.reg === 1) { canFault = true; P(`cpu.eip=${ipStart};cpu.swInt(6);return;`); ended = true; break; }
          P(`cpu.setSeg(${o.reg},${rmR(o, 16)});`); break;
        }
        // POP Ev moves one stack slot of the current operand size, like PUSH/POP sreg above.
        // POP Ev — same sequencing as POP r16 above, for the same two reasons: the destination may be
        // SP, and when the destination is memory based on ESP the effective address is defined to be
        // computed AFTER the pop's increment.
        case 0x8f: { const o = modrm(); const t0 = NT(); P(`var ${t0}=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()'};`); P(rmW(o, sz, t0)); break; }

        case 0x90: break;                                                               // NOP
        case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {  // XCHG eAX,reg
          const i = op & 7, tA = NT(); P(`var ${tA}=${rR(0, sz)};${rW(0, sz, rR(i, sz))}${rW(i, sz, tA)}`); break;
        }
        // CBW/CWD, or CWDE/CDQ under 0x66. `CDQ; IDIV ECX` is *the* signed 32-bit divide idiom, so
        // decoding these as their 16-bit forms silently produced garbage quotients.
        case 0x98: P(sz === 16 ? `r[0]=(r[0]&~0xffff)|((((r[0]&0xff)<<24>>24))&0xffff);`        // CBW  AL→AX
          : `r[0]=(((r[0]&0xffff)<<16>>16))>>>0;`); break;                                      // CWDE AX→EAX
        case 0x99: P(sz === 16 ? `r[2]=(r[2]&~0xffff)|((r[0]&0x8000)?0xffff:0);`                // CWD  AX→DX:AX
          : `r[2]=((r[0]&0x80000000)?0xffffffff:0)>>>0;`); break;                               // CDQ  EAX→EDX:EAX
        // The far pointer immediate is 4+2 bytes under 0x66, not 2+2 — reading only two would
        // DESYNCHRONISE the instruction stream, which is the same failure shape as the 0x67 bug that
        // derailed Heaven. test386's POST-5 far-call test is what surfaced it.
        // CALLF/JMPF must not assume the descriptor is a code segment: in protected mode it may be
        // a CALL GATE, whose fields are selector:offset rather than base/limit. cpu.farCall/farJmp
        // make that decision; real mode takes the same path and behaves as before.
        case 0x9a: { const o = sz === 16 ? f16() : (f16() | (f16() << 16)); const s = f16();
          P(`cpu.eip=${ip};cpu.farCall(${s},${o >>> 0},${sz === 32 ? 1 : 0},${ipStart});`); P('return;'); ended = true; break; } // CALLF ptr
        case 0x9b: break;                                                               // WAIT
        // PUSHF: an 8086/88 always reads bits 12-15 back as 1; a 286+ clears them in real mode.
        case 0x9c: cur.use |= lALL; P(sz === 32 ? 'cpu.push32(cpu.flags>>>0);'
          : `cpu.push16((cpu.flags${PROF.pushfSetsReserved ? '|0xf000' : ''})&0xffff);`); break;
        case 0x9d: P(sz === 32 ? 'cpu.flags=(cpu.pop32()&0x27fd5)|2;' : 'cpu.flags=(cpu.pop16()&0x7fd5)|2;'); break;         // POPF / POPFD (66; RF/VM not modelled)
        case 0x9e: P('cpu.flags=(cpu.flags&~0xff)|(((r[0]>>>8)&0xd5))|2;'); break;       // SAHF
        case 0x9f: cur.use |= lC | lP | lA | lZ | lS; P('r[0]=(r[0]&~0xff00)|((((cpu.flags&0xd5)|2)&0xff)<<8);'); break; // LAHF (reads CPAZS)

        // ---- MOV AL/eAX <-> moffs ----
        // moffs is a bare displacement: 2 bytes normally, 4 after a 0x67 prefix (else the stream desyncs).
        case 0xa0: { const d = addr32 ? f32() : f16(); P(rW(0, 8, `m.r8(${lin(segOv >= 0 ? segOv : DS, d)})`)); break; }
        case 0xa1: { const d = addr32 ? f32() : f16(); P(rW(0, sz, sz === 16 ? `m.r16(${lin(segOv >= 0 ? segOv : DS, d)})` : `m.r32(${lin(segOv >= 0 ? segOv : DS, d)})`)); break; }
        case 0xa2: { const d = addr32 ? f32() : f16(); P(`m.w8(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 8)});`); break; }
        case 0xa3: { const d = addr32 ? f32() : f16(); P(sz === 16 ? `m.w16(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 16)});` : `m.w32(${lin(segOv >= 0 ? segOv : DS, d)},${rR(0, 32)});`); break; }

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
        case 0xc0: { const o = modrm(); const c = f8(); emitShift(o, 8, '' + (c & SHIFT_MASK)); break; }   // the 286+ masks the count to 5 bits; an 8088 uses it in full
        case 0xc1: { const o = modrm(); const c = f8(); emitShift(o, sz, '' + (c & SHIFT_MASK)); break; }
        case 0xd0: { const o = modrm(); emitShift(o, 8, '1'); break; }
        case 0xd1: { const o = modrm(); emitShift(o, sz, '1'); break; }
        case 0xd2: { const o = modrm(); emitShift(o, 8, '(r[1]&0xff)'); break; }
        case 0xd3: { const o = modrm(); emitShift(o, sz, '(r[1]&0xff)'); break; }

        // RET pops what CALL pushed: 4 bytes under a 0x66 prefix, 2 without. The immediate form's
        // SP adjustment stays a 16-bit count either way.
        case 0xc2: { const n = f16(); P(`cpu.eip=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()>>>0'};cpu.spAdd(${n});`); P('return;'); ended = true; break; } // RET imm
        case 0xc3: P(`cpu.eip=${sz === 16 ? 'cpu.pop16()' : 'cpu.pop32()>>>0'};`); P('return;'); ended = true; break;        // RET
        // LDS/LES/LSS/LFS/LGS all load an offset followed by a 16-bit selector. Under 0x66 the offset
        // is a DWORD, so the selector sits at +4, not +2 — reading it at +2 loaded half the offset as
        // the segment. test386's POST-6 `o32 lss ebx,[es:di]` caught it; last of the T0.3 family.
        case 0xc4: { const o = modrm(); P(loadPtr(o, ES, sz)); break; } // LES
        case 0xc5: { const o = modrm(); P(loadPtr(o, DS, sz)); break; } // LDS
        case 0xc6: { const o = modrm(); const i = f8(); P(rmW(o, 8, '' + i)); break; }
        case 0xc7: { const o = modrm(); const i = sz === 16 ? f16() : ((f16() | (f16() << 16)) >>> 0); P(rmW(o, sz, '' + i)); break; }
        case 0xc8: {                                                                    // ENTER size,level (make stack frame)
          const szv = f16(), lvl = f8() & 0x1f; const ft = NT();
          P(`cpu.push16(r[5]);var ${ft}=cpu.stackPtr;`);                                       // push BP; frameTemp = SP
          for (let i = 1; i < lvl; i++) P(`r[5]=(r[5]&~0xffff)|((r[5]-2)&0xffff);cpu.push16(m.r16((sb[2]+(r[5]&0xffff))&${MM}));`); // copy nested frame pointers
          if (lvl > 0) P(`cpu.push16(${ft});`);
          P(`r[5]=(r[5]&~0xffff)|${ft};cpu.spAdd(-${szv});`);   // BP = frameTemp; SP -= size
          break;
        }
        case 0xc9: P('r[4]=(r[4]&~0xffff)|r[5]&0xffff;r[5]=(r[5]&~0xffff)|cpu.pop16();'); break; // LEAVE
        // RETF pops what CALLF pushed — two dwords under 0x66, two words without. The selector is
        // popped as a dword too and its upper half discarded.
        // farRet can now raise #GP on the target's privilege; that is a fault, so it needs the
        // instruction's own address for the saved EIP.
        case 0xca: { const n = f16(); P(`cpu.farRet(${sz === 32 ? 1 : 0},${n},${ipStart});`); P('return;'); ended = true; break; } // RETF imm
        case 0xcb: P(`cpu.farRet(${sz === 32 ? 1 : 0},0,${ipStart});`); P('return;'); ended = true; break; // RETF

        // INT3 / INT n / INTO are SOFTWARE interrupts: privilege-checked against the gate's DPL,
        // unlike the faults that also route through swInt. softInt takes both the next IP and the
        // instruction's own address, because #GP on the DPL check is a fault and must save the
        // latter.
        case 0xcc: P(`cpu.softInt(3,${ip},${ipStart});`); P('return;'); ended = true; break; // INT3
        case 0xcd: { const n = f8(); P(`cpu.softInt(${n},${ip},${ipStart});`); P('return;'); ended = true; break; } // INT n
        case 0xce: P(`if(cpu.flags&${OF}){cpu.softInt(4,${ip},${ipStart});return;}cpu.eip=${ip};`); P('return;'); ended = true; break; // INTO
        // IRET pops the frame at the OPERAND size: iretd (32-bit) pops EIP/CS/EFLAGS as dwords.
        // The frame was pushed at the gate's width, and a 32-bit gate is entered from 32-bit code,
        // so the two agree without needing to know which gate delivered us.
        case 0xcf: P(`cpu.iret(${sz === 32 ? 1 : 0});`); P('return;'); ended = true; break;

        case 0xd4: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.aam(${f8()}))return;`); break; // AAM (#DE on base 0 — abort the block)
        case 0xd5: P(`cpu.aad(${f8()});`); break; // AAD
        case 0xd6: cur.use |= lC; P(`r[0]=(r[0]&~0xff)|((cpu.flags&${CF})?0xff:0);`); break; // SALC (reads CF)
        case 0xd7: P(`r[0]=(r[0]&~0xff)|m.r8(${lin(segOv >= 0 ? segOv : DS, addr32 ? '(((r[3]>>>0)+(r[0]&0xff))>>>0)' : '((r[3]+ (r[0]&0xff))&0xffff)')});`); break; // XLAT (EBX under 0x67)

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
        case 0xe0: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); term = { k: 'loop', v: 0xe0, t: ipAdd(ip, rel), n: ip, a32: addr32 }; ended = true; break; }
        case 0xe1: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); term = { k: 'loop', v: 0xe1, t: ipAdd(ip, rel), n: ip, a32: addr32 }; ended = true; break; }
        case 0xe2: { const rel = fs8(); P(addr32 ? 'r[1]=(r[1]-1)>>>0;' : 'r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);'); term = { k: 'loop', v: 0xe2, t: ipAdd(ip, rel), n: ip, a32: addr32 }; ended = true; break; }
        case 0xe3: { const rel = fs8(); term = { k: 'jcxz', t: ipAdd(ip, rel), n: ip, a32: addr32 }; ended = true; break; }

        // ---- IN / OUT ----
        // IN/OUT are IOPL-sensitive: at CPL > IOPL they raise #GP(0) unless the TSS's I/O permission
        // bitmap allows the port. The bitmap is not modelled yet, so this is the strict reading —
        // which is what test386 asks for here (it clears IOPL, then expects `in al,0x64` to fault).
        case 0xe4: { const p = f8(); P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, 8, `cpu.ioRead(${p},1)`)); break; }
        case 0xe5: { const p = f8(); P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, sz, `cpu.ioRead(${p},${sz / 8})`)); break; }
        case 0xe6: { const p = f8(); P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(${p},1,${rR(0, 8)});`); break; }
        case 0xe7: { const p = f8(); P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(${p},${sz / 8},${rR(0, sz)});`); break; }
        case 0xec: P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, 8, 'cpu.ioRead(r[2]&0xffff,1)')); break;
        case 0xed: P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(rW(0, sz, `cpu.ioRead(r[2]&0xffff,${sz / 8})`)); break;
        case 0xee: P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(r[2]&0xffff,1,${rR(0, 8)});`); break;
        case 0xef: P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`); canFault = true; P(`cpu.ioWrite(r[2]&0xffff,${sz / 8},${rR(0, sz)});`); break;

        // ---- CALL / JMP ----
        // CALL/JMP rel under a 0x66 prefix take a 32-bit displacement AND, for CALL, push a 32-bit
        // return address — SP moves by 4, not 2. We read the 32-bit displacement but then
        // sign-extended it as if it were 16-bit and pushed 16 bits, so the stack was off by two for
        // the rest of the frame. Found by test386.asm's POST-5 `o32 call dword` check. The target
        // still masks to 16 bits: real mode's segment limit is 0xFFFF regardless of operand size.
        case 0xe8: {
          const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16));
          const tgt = ipAdd(ip, rel);
          P(sz === 16 ? `cpu.push16(${ip});` : `cpu.push32(${ip});`);
          P(`cpu.eip=${tgt};`); P('return;'); ended = true; break;
        }
        case 0xe9: { const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16)); endJmp('' + ipAdd(ip, rel)); break; } // JMP rel
        // EIP is set to the instruction's OWN address first: farJmp can now raise #GP on the
        // target's privilege, and that is a fault, so the saved EIP must point AT the JMP. On
        // success farJmp overwrites EIP anyway, so this costs nothing.
        case 0xea: { const o = sz === 16 ? f16() : (f16() | (f16() << 16)); const s = f16(); P(`cpu.eip=${ipStart};cpu.farJmp(${s},${o >>> 0});`); P('return;'); ended = true; break; } // JMPF ptr
        case 0xeb: { const rel = fs8(); endJmp('' + ipAdd(ip, rel)); break; }    // JMP rel8

        case 0xf4:                                                                      // HLT
          canFault = true;
          P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P('cpu.halted=true;'); P(`cpu.eip=${ip};`); P('return;'); ended = true; break;
        case 0xf5: cur.use |= lC; P(`cpu.flags^=${CF};`); break;                        // CMC (reads CF)
        case 0xf6: emitGroup3(8, ipStart); break;
        case 0xf7: emitGroup3(sz, ipStart); break;
        case 0xf8: P(`cpu.flags&=~${CF};`); break;                                      // CLC
        case 0xf9: P(`cpu.flags|=${CF};`); break;                                       // STC
        case 0xfa:                                                                      // CLI
          canFault = true;
          P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P(`cpu.flags&=~${IF};`); break;
        case 0xfb:                                                                      // STI
          canFault = true;
          P(`if((cpu.cr0&1)&&(cpu.seg[${CS}]&3)>((cpu.flags>>>12)&3)){cpu.eip=${ipStart};cpu.raise(13,0);return;}`);
          P(`cpu.flags|=${IF};`); break;
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

    // `bodyOut` is the block body WITHOUT its terminating branch (kept for the region
    // compiler, which re-emits the terminator from `term`); tier-1 then appends the
    // terminator's return form to get the standalone block function.
    const bodyOut = out.slice();
    emitTermReturn();
    const pre = 'var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;' + memPrologue(this.memStrategy) + (usesFPU ? 'var st=cpu.fst,dv=m.dv;' : '');
    const body = pre + '\n' + out.join('\n');
    const fn = new Function('cpu', body);
    return { fn, linStart, linEnd: (linStart - ip0 + ip) & MM, ip0, ipEnd: ip, count, body, term, bodyOut, usesFPU, canFault, hot: 0, kind: 0 };

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
      // The inline fast path assumes the count is smaller than the operand — under the 8088 profile
      // it need not be, and JS's own shift operators mask to 5 bits, so a count of 32 would become 0.
      // Counts at or above the width go to the helper, which handles them explicitly.
      const litC = /^\d+$/.test(cnt) ? (Number(cnt) & SHIFT_MASK) : -1;
      if (isShift && size !== 32 && litC >= 0 && litC < size) {
        const C = litC;
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

    function emitGroup3(size, ipStart) {
      const o = modrm();
      switch (o.reg) {
        case 0: case 1: { const i = size === 8 ? f8() : (size === 16 ? f16() : (f16() | (f16() << 16))); alu('test', rmR(o, size), null, '' + (i >>> 0), size); break; }
        case 2: P(rmW(o, size, `(~${rmR(o, size)})`)); break;                            // NOT
        case 3: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, size)};var ${rr}=(0-${a})${M(size)};${rmW(o, size, rr)}`); PFLAG(`cpu.setSub(0,${a},${rr},${size});`, lALL); break; } // NEG
        case 4:                                                                         // MUL
          if (size === 16) { const s = NT(), p = NT(), hi = NT();
            P(`var ${s}=(${rmR(o, 16)})&0xffff;var ${p}=(r[0]&0xffff)*${s};var ${hi}=(${p}/65536)&0xffff;r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|${hi};`);
            PFLAG(`cpu.setShiftResult(0,16,${hi}!==0,${hi}!==0,false);`, lC | lO);
          } else P(`cpu.${size === 8 ? 'mul8' : 'mul32'}(${rmR(o, size)});`);   // 8-bit or 32-bit (66h)
          break;
        case 5:                                                                         // IMUL
          if (size === 16) { const s = NT(), a = NT(), p = NT();
            P(`var ${s}=((${rmR(o, 16)})<<16)>>16;var ${a}=((r[0]&0xffff)<<16)>>16;var ${p}=${a}*${s};r[0]=(r[0]&~0xffff)|(${p}&0xffff);r[2]=(r[2]&~0xffff)|((${p}>>16)&0xffff);`);
            PFLAG(`cpu.setShiftResult(0,16,(${p}<-32768||${p}>32767),(${p}<-32768||${p}>32767),false);`, lC | lO);
          } else P(`cpu.${size === 8 ? 'imul8' : 'imul32'}(${rmR(o, size)});`);
          break;
        // DIV/IDIV can raise #DE. The helper vectors the ISR and returns true; we must set eip to the
        // FAULTING instruction first (a #DE is a fault, so that is the pushed return address) and then
        // stop the block — otherwise the rest of it runs and its terminator overwrites cpu.eip, silently
        // discarding the interrupt on a stack that already holds an IRET frame.
        case 6: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.${size === 8 ? 'div8' : size === 16 ? 'div16' : 'div32'}(${rmR(o, size)}))return;`); break;   // DIV
        case 7: cur.use |= lALL; canFault = true; P(`cpu.eip=${ipStart};if(cpu.${size === 8 ? 'idiv8' : size === 16 ? 'idiv16' : 'idiv32'}(${rmR(o, size)}))return;`); break; // IDIV
      }
    }

    function emitGroup5(sz) {
      const o = modrm();
      switch (o.reg) {
        case 0: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}+1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(`cpu.setAdd(${a},1,${rr},${sz},false);`, lNOC); break; }
        case 1: { const a = NT(), rr = NT(); P(`var ${a}=${rmR(o, sz)};var ${rr}=(${a}-1)${M(sz)};${rmW(o, sz, rr)}`); PFLAG(`cpu.setSub(${a},1,${rr},${sz},false);`, lNOC); break; }
        // Same 0x66 rule as CALL rel: the pushed return address is a dword and the target operand is
        // read at the prefixed size. `o32 call ebx` is test386's POST-5 %%rm32 case.
        case 2: { const tg = NT(); P(`var ${tg}=${rmR(o, sz)};${sz === 16 ? `cpu.push16(${ip});` : `cpu.push32(${ip});`}cpu.eip=${sz === 16 ? `${tg}&0xffff` : `${tg}>>>0`};`); P('return;'); ended = true; break; } // CALL Ev
        // CALLF under 0x66 pushes CS and a 32-bit return offset, and reads a 48-bit far pointer.
        case 3: { const a = memAddr(o);
          P(sz === 16 ? `cpu.push16(cpu.seg[${CS}]);cpu.push16(${ip});var _o=m.r16(${a});cpu.setSeg(${CS},m.r16((${a}+2)&${MM}));cpu.eip=_o;`
                      : `cpu.push32(cpu.seg[${CS}]);cpu.push32(${ip});var _o=m.r32(${a})>>>0;cpu.setSeg(${CS},m.r16((${a}+4)&${MM}));cpu.eip=_o>>>0;`);
          P('return;'); ended = true; break; } // CALLF
        case 4: { const tg = NT(); P(`var ${tg}=${rmR(o, sz)};cpu.eip=${sz === 16 ? `${tg}&0xffff` : `${tg}>>>0`};`); P('return;'); ended = true; break; } // JMP Ev
        case 5: { const a = memAddr(o); P(`var _o=m.r16(${a});cpu.setSeg(${CS},m.r16((${a}+2)&${MM}));cpu.eip=_o;`); P('return;'); ended = true; break; } // JMPF
        case 6: P(sz === 32 ? `cpu.push32(${rmR(o, 32)}>>>0);` : `cpu.push16(${rmR(o, 16)});`); break; // PUSH Ev (honour the operand-size prefix: 66 → push a dword)
      }
    }

    function emitStr(kind, size) {
      const step = size / 8;
      const srcSeg = segOv >= 0 ? segOv : DS;
      // 0x67 switches the string pointers/counter to ESI/EDI/ECX. `67 F3 A4` (REP MOVSB over 32-bit
      // pointers) is a standard 386 fast-copy; without this it silently used SI/DI/CX.
      const iR = (i) => addr32 ? `(r[${i}]>>>0)` : `(r[${i}]&0xffff)`;
      const iAdv = (i) => addr32 ? `r[${i}]=(r[${i}]+_d)>>>0;` : `r[${i}]=(r[${i}]&~0xffff)|((r[${i}]+_d)&0xffff);`;
      const w = size === 8 ? 'r8' : size === 16 ? 'r16' : 'r32';
      const ww = size === 8 ? 'w8' : size === 16 ? 'w16' : 'w32';
      P(`var _d=(cpu.flags&${DF})?-${step}:${step};`);
      const loop = (body, cond) => {
        if (rep) {
          P(`var _c=${iR(1)};`);
          P('while(_c>0){');
          P(body);
          P('_c--;');
          if (cond) P(cond);
          P('}');
          P(addr32 ? 'r[1]=_c>>>0;' : 'r[1]=(r[1]&~0xffff)|_c;');
        } else { P(body); }
      };
      const SI = `((sb[${srcSeg}]+${iR(6)})&${MM})`;
      const DI = `((sb[${ES}]+${iR(7)})&${MM})`;
      const adv = iAdv(6) + iAdv(7);
      const advDI = iAdv(7);
      const advSI = iAdv(6);
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
      if (op2 >= 0x80 && op2 <= 0x8f) { const rel = sz === 16 ? (f16() << 16 >> 16) : (f16() | (f16() << 16)); endJcc(op2 & 0xf, ipAdd(ip, rel), ip); return; }
      // CMOVcc Gv,Ev (P6+): reg = cond ? Ev : reg
      if (op2 >= 0x40 && op2 <= 0x4f) { cur.use |= lALL; const o = modrm(); const s = NT(); P(`var ${s}=${rmR(o, sz)};if(${condExpr(op2 & 0xf)}){${rW(o.reg, sz, s)}}`); return; }
      // SETcc Eb
      if (op2 >= 0x90 && op2 <= 0x9f) { cur.use |= lALL; const o = modrm(); P(rmW(o, 8, `${condExpr(op2 & 0xf)}?1:0`)); return; }
      // BSWAP r32 (0F C8+r): reverse the byte order of a 32-bit register (486+); flags untouched
      if (op2 >= 0xc8 && op2 <= 0xcf) { const r = op2 - 0xc8, b = NT(); P(`var ${b}=r[${r}]>>>0;r[${r}]=((${b}<<24)|((${b}&0xff00)<<8)|((${b}>>>8)&0xff00)|(${b}>>>24))>>>0;`); return; }
      // BTx Ev,Gv (reg bit offset) and group 0F BA Ev,imm8
      // BT/BTS/BTR/BTC. For a REGISTER destination the bit offset is masked to the operand width.
      // For MEMORY it is a **full signed bit-string index**: the byte accessed is base + (ofs>>3)
      // and the bit is ofs&7, so an offset of 100 reaches the 12th byte and a negative one reaches
      // backwards. Masking it (as this did) folded every access back into the first word — which is
      // exactly wrong for the bitmap scans these instructions exist for (allocators, collision masks).
      const bt = (o, kind, bitExpr) => {
        const b = NT(), v = NT();
        if (o.isReg) {
          P(`var ${b}=(${bitExpr})&${sz - 1};var ${v}=${rmR(o, sz)};`);
          P(`cpu.flags=(cpu.flags&~${CF})|((${v}>>>${b})&1);`);
          if (kind === 'bts') P(rmW(o, sz, `(${v}|(1<<${b}))`));
          else if (kind === 'btr') P(rmW(o, sz, `(${v}&~(1<<${b}))`));
          else if (kind === 'btc') P(rmW(o, sz, `(${v}^(1<<${b}))`));
          return;
        }
        const base = memAddr(o), ofs = NT(), ad = NT();
        P(`var ${ofs}=(${bitExpr})${sz === 16 ? '<<16>>16' : '|0'};`);      // signed bit index
        P(`var ${ad}=(${base}+(${ofs}>>3))&${MM};`);                        // arithmetic shift: floors
        P(`var ${b}=${ofs}&7;var ${v}=${memRead(ad, 8)};`);
        P(`cpu.flags=(cpu.flags&~${CF})|((${v}>>>${b})&1);`);
        if (kind === 'bts') P(memW(ad, 8, `(${v}|(1<<${b}))`));
        else if (kind === 'btr') P(memW(ad, 8, `(${v}&~(1<<${b}))`));
        else if (kind === 'btc') P(memW(ad, 8, `(${v}^(1<<${b}))`));
      };
// A privileged instruction outside ring 0 raises #GP(0). Emitted rather than assumed, because the
// same opcode is legal at CPL 0 and the check has to be made at run time. test386 arms an expected
// EX_GP (13) and falls into `jmp error` if the fault never arrives, which is how POST 20 fails.
      switch (op2) {
        case 0x00: {                                                                    // group 6: SLDT/STR/LLDT/LTR/VERR/VERW
          const o = modrm();
          if (o.reg === 0) { P(rmW(o, 16, 'cpu.ldtr.sel')); return; }                    // SLDT
          if (o.reg === 1) { P(rmW(o, 16, 'cpu.tr.sel')); return; }                       // STR
          if (o.reg === 2) { P(`cpu.loadLDT(${rmR(o, 16)});`); return; }                  // LLDT
          if (o.reg === 4 || o.reg === 5) { if (!o.isReg) memAddr(o); P(`cpu.flags|=${ZF};`); return; } // VERR/VERW → report the selector as accessible (ZF=1)
          if (o.reg === 3) { P(`cpu.loadTR(${rmR(o, 16)});`); return; }                  // LTR
          if (!o.isReg) memAddr(o);
          return;
        }
        // CLTS — clear CR0.TS (bit 3). A DOS extender issues it after a task switch so the next x87
        // instruction does not raise #NM. We do not model TS at all, so clearing it is exact.
        case 0x06: P('cpu.cr0&=~8;'); return;
        // LAR / LSL Gv,Ew — query a selector without loading it. ZF reports accessibility and the
        // destination is left untouched when it is not, so the helper returns -1 for "no" and the
        // emitted code tests that once.
        case 0x02: case 0x03: {
          const o = modrm(); const t = NT();
          P(`var ${t}=${op2 === 0x02 ? `cpu.larRights(${rmR(o, 16)},${sz === 32 ? 1 : 0})` : `cpu.lslLimit(${rmR(o, 16)})`};`);
          P(`if(${t}<0){cpu.flags&=~${ZF};}else{cpu.flags|=${ZF};${rW(o.reg, sz, t)}}`);
          return;
        }
        case 0x01: {                                                                    // group 7: SGDT/SIDT/SMSW/LGDT/LIDT/LMSW/INVLPG
          const o = modrm();
          if (o.reg === 4) { P(rmW(o, 16, `(cpu.cr0&0xffff)`)); return; }                // SMSW r/m16 → MSW
          if (o.reg === 6) { const s = NT(); P(`var ${s}=${rmR(o, 16)};cpu.setCR0((cpu.cr0&~0xf)|(${s}&0xf));`); return; } // LMSW: low 4 bits, PE included
          // SGDT/SIDT store a 6-byte pseudo-descriptor: 16-bit limit then 32-bit base.
          if (o.reg === 0 || o.reg === 1) {
            const a = memAddr(o), t = o.reg === 0 ? 'gdtr' : 'idtr';
            P(`m.w16(${a},cpu.${t}.limit&0xffff);m.w32((${a}+2)&${MM},cpu.${t}.base>>>0);`);
            return;
          }
          // LGDT/LIDT load it. Without a 0x66 prefix the base is truncated to 24 bits on a 386 —
          // that is architectural, not an approximation, and code that loads a table above 16 MiB
          // from a 16-bit segment relies on knowing it.
          if (o.reg === 2 || o.reg === 3) {
            const a = memAddr(o), t = o.reg === 2 ? 'gdtr' : 'idtr';
            P(`cpu.${t}.limit=m.r16(${a});cpu.${t}.base=(m.r32((${a}+2)&${MM})&${sz === 32 ? '0xffffffff' : '0xffffff'})>>>0;`);
            return;
          }
          if (!o.isReg) memAddr(o);                                                      // INVLPG → no-op (no paging yet)
          return;
        }
        case 0x20: { const o = modrm(); const src = o.reg === 0 ? '(cpu.cr0>>>0)' : o.reg === 2 ? '(cpu.cr2>>>0)' : o.reg === 3 ? '(cpu.cr3>>>0)' : '0';
          P(rW(o.rm, 32, src)); return; }                                               // MOV r32, CRn
        // MOV CRn, r32. CR0 bit 0 (PE) now really switches how selectors resolve, so this ends the
        // block: the very next instruction is normally the far jump that reloads CS, and the code
        // after it must be translated under the new CS.D.
        case 0x22: {
          const o = modrm();
          if (o.reg === 0) { P(`cpu.setCR0(${rR(o.rm, 32)});cpu.eip=${ip};`); P('return;'); ended = true; }
          else if (o.reg === 3) { P(`cpu.setCR3(${rR(o.rm, 32)});cpu.eip=${ip};`); P('return;'); ended = true; }
          else if (o.reg === 2) P(`cpu.cr2=${rR(o.rm, 32)}>>>0;`);
          else P(`${rR(o.rm, 32)};`);
          return;
        }
        case 0x21: { const o = modrm(); P(rW(o.rm, 32, '0')); return; }                 // MOV r32, DRn → 0 (no debug registers)
        case 0x23: { const o = modrm(); P(`${rR(o.rm, 32)};`); return; }                // MOV DRn, r32 → no-op
        case 0x1f: modrm(); return;                                                     // multi-byte NOP
        case 0x31: P('cpu.reg[0]=(cpu.cycles>>>0);cpu.reg[2]=(Math.floor(cpu.cycles/4294967296))>>>0;'); return; // RDTSC → EDX:EAX
        case 0xa0: P(sz === 16 ? `cpu.push16(cpu.seg[${FS}]);` : `cpu.push32(cpu.seg[${FS}]);`); return;   // PUSH FS
        case 0xa1: P(sz === 16 ? `cpu.setSeg(${FS},cpu.pop16());` : `cpu.setSeg(${FS},cpu.pop32()&0xffff);`); return;  // POP FS
        case 0xa8: P(sz === 16 ? `cpu.push16(cpu.seg[${GS}]);` : `cpu.push32(cpu.seg[${GS}]);`); return;   // PUSH GS
        case 0xa9: P(sz === 16 ? `cpu.setSeg(${GS},cpu.pop16());` : `cpu.setSeg(${GS},cpu.pop32()&0xffff);`); return;  // POP GS
        case 0xa3: { const o = modrm(); bt(o, 'bt', rR(o.reg, sz)); return; }            // BT
        case 0xab: { const o = modrm(); bt(o, 'bts', rR(o.reg, sz)); return; }           // BTS
        case 0xb3: { const o = modrm(); bt(o, 'btr', rR(o.reg, sz)); return; }           // BTR
        case 0xbb: { const o = modrm(); bt(o, 'btc', rR(o.reg, sz)); return; }           // BTC
        case 0xba: { const o = modrm(); const imm = f8(); bt(o, ['bt', 'bt', 'bt', 'bt', 'bt', 'bts', 'btr', 'btc'][o.reg], '' + imm); return; }
        case 0xb2: { const o = modrm(); P(loadPtr(o, SS, sz)); return; } // LSS
        case 0xb4: { const o = modrm(); P(loadPtr(o, FS, sz)); return; } // LFS
        case 0xb5: { const o = modrm(); P(loadPtr(o, GS, sz)); return; } // LGS
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
          throw new Error('mirage: unimplemented opcode 0x0f 0x' + op2.toString(16).padStart(2, '0') + ' at ' + ((linStart - ip0 + ip - 2) & MM).toString(16));
      }
    }
  }
}
