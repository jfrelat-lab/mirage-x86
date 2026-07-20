# MIRAGE — The Recompiler (`src/recompiler.js`)

The dynarec. It turns x86 basic blocks into JavaScript functions and runs them. ~1000 LOC,
the densest file in the project. Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Emitting a block: `translate(linStart, ip0, maxOps=192)`

Decodes x86 forward from a linear address, appending JavaScript **strings** to an `out[]`
array, until a terminator or `MAXOPS`. Then `new Function('cpu', body)` compiles it.

The emitted body opens with a preamble binding hot state to locals:
```js
var r=cpu.reg, m=cpu.mem, sb=cpu.base;      // + u8,cp,dv when the block needs them
```
Each instruction appends statements via `P(str)`. Reads/writes hit `r[i]`, `m.u8[addr]`, etc.
directly. The returned block object:
```js
{ fn, linStart, linEnd, ip0, ipEnd, count, body, term, bodyOut, usesFPU, canFault, hot, kind }
//  kind: 0 = tier-1 block, 2 = tier-2 region.  count = instructions retired (bumped into cpu.cycles).
```

**Terminators** end a block and are baked into the emitted tail:
- `jmp` → `cpu.eip=T`
- `jcc` → `if(cond){eip=T}else{eip=next}` — `cond` is emitted inline (see flags below)
- `jcxz`/`loop`/`loope`/`loopne` → their own condition forms
- RET/RETF/IRET/CALL/CALLF/JMPF/INT/INT3/INTO/HLT emit `cpu.eip=…; return;` directly (`ended=true`)

`stepOne()` is `translate(lin, ip0, 1)` — exactly one instruction, run uncached. It's the
conformance/debug path and is deliberately never affected by the block cache or tier-2.

## The block cache

Two-level page table, no hashing: `blockPages[lin>>12][lin&0xfff]`. A slot may be reached from
different `CS:IP` for the same linear address, so `blk.ip0` is re-checked and the block
recompiled on mismatch (emitted jump targets bake in `ip0`).

## Flags — the subtle part

x86 flags are expensive if computed eagerly. Two mechanisms keep them cheap:

1. **`cond(cc)` inlined** — Jcc/SETcc/CMOVcc emit direct flag-bit tests instead of a helper
   call, e.g. `JZ → (cpu.flags&64)`, `JL → ((cpu.flags>>>7^cpu.flags>>>11)&1)` (SF≠OF).

2. **Dead-flag elimination** (Phase 1.A, `MIRAGE_NOSTRIP` to disable) — a two-pass liveness
   scan over the block's instruction list drops `setAdd/setSub/setLogic/…` calls whose result
   flags are overwritten before any reader. **Live-out at end-of-block is always ALL** (the next
   block or an external reader may consume them). The def/use table is faithful to
   `cpu.js`'s *implementation*, not the architecture — e.g. MUL/IMUL are modelled as `def CO
   only` because our impl preserves S/Z/P/A (`setShiftResult(touchSZP=false)`); modelling them
   as "def SZP undefined" would let a stale-but-preserved producer be stripped and become
   visible to a later PUSHF. `stepOne` compiles one instruction → live-out=ALL → **never strips**,
   so the conformance path is byte-exact by construction (and thus blind to strip bugs — the
   golden PNG gate catches those instead).

Lazy/last-writer flags are **designed but deferred** (too many hand-audited materialization
points on the string emitter; belongs in a future IR).

## Inlined fast paths (Phase 1)

The recompiler open-codes what a naive emitter would call helpers for. Each is behind a
kill-switch env var (kept as permanent debug levers):

- **Memory** (`MIRAGE_NOMEMINLINE`): `m.r8/r16` → `u8[a]` / `(u8[a]|u8[(a+1)&MM]<<8)`; writes
  emit the value + the **SMC dirty check** inline: `u8[a]=v; if(cp[a>>>12])m._dirty(a,1)`.
  Composed lanes are **always masked** (`(a+1)&MM`) — the wrap at `a===MM` (FFFF:000F+1) is
  reachable and an unmasked `u8[MM+1]` would read `undefined`→0. Also inlines push/pop and
  `mul16` (8% of integer workloads by itself).
- **FPU** (`MIRAGE_NOFPUINLINE`): each x87 op emits specific JS against a local `ft` mirror of
  `ftop`, flushed to `cpu.ftop` at every block exit; rare ops (FLDENV/FSAVE/…) fall back to a
  `cpu.fpuMem/fpuReg` call. FPU stores emit the same SMC dirty check as integer stores.
- **A000 planar routing**: byte accesses to segment 0xA emit
  `if(m.planar&&(a>>>16)===10)m.vga.writeByte(a,v);else{…flat…}`.

## Self-modifying code (SMC)

`markCodePage(page)` flags every 4 KiB page a block was compiled from. Guest writes (both the
`memory.js` methods and the inlined emitted writes) check `codePage[addr>>12]` and call
`_dirty` → the recompiler invalidates the affected blocks (drops them from the page table so
they recompile). Demos that patch their own code (`tube`, `darnit`) rely on this. **Known gap
noted historically:** FPU stores through `dv.setFloat*` must carry the same check (they do, via
the inlined dirty check) — audit if you touch `fpu.js` emission.

## Tier-2 regions

A block promoted after `T2_HOT=64` executions (`_promote`) becomes a fused region via
`_emitRegion`: a walk collects the block plus statically-reachable successors (loop body),
bounded by `T2_MAXBLK=24` blocks / `T2_MAXINS=384` instructions, and emits:

```js
var r=cpu.reg,m=cpu.mem,sb=cpu.base,u8=m.u8,cp=m.codePage;   // + FPU locals if used
var _e=<rootIp>, dl=cpu.deadline;
for(;;){
  if(R.dead){cpu.eip=_e;return;}                              // SMC eviction guard
  if(cpu.tbudget<=0 || cpu.cycles>=dl){cpu.eip=_e;return;}    // slice budget OR PIT tick due
  cpu.tbudget--;
  switch(_e){
    case <ip>: { <block body>; cpu.cycles+=<count>; <edge> }  // edge: in-region → _e=T;break;  out → eip=T;return;
    ...
  }
}
```

Invariants that make regions safe:
- **Byte-identical to tier-1.** cpu.cycles is bumped per block after its body (as tier-1 does),
  so an in-block RDTSC reads the same count. The `fuzz-region` gate runs 20k random programs
  through region-mode `run()` vs tier-1 `stepOne()` and requires identical final state.
- **Budget parity.** `tbudget` is check-then-decrement, matching tier-1's per-block budget, so a
  region and tier-1 stop at the same block boundary → same slice boundary → same interrupt timing.
- **PIT delivery (`cpu.deadline`).** A region never re-enters the dispatch loop, so it must bail
  when a timer tick comes due — otherwise a timer-delay loop promoted to a region spins forever
  (this was Stryker's bug). `rec.run` sets `cpu.deadline = timerAuto ? nextTimerCycle : Infinity`
  per slice; `serviceTimer` advances it; the region bails at `cpu.cycles>=dl`, the run loop
  fires INT 8, the region re-enters. `dl` is hoisted to a local (refreshed each entry) so the
  check is free — bench stays within noise. **The deadline bail is gated on `&& (cpu.flags&IF)`**:
  run() only delivers the timer (and advances the deadline) with IF set, so bailing while IF is
  clear would return WITHOUT decrementing tbudget and WITHOUT run() being able to make progress →
  an infinite no-progress bail loop (a game running a hot loop under CLI past a due tick — this
  was God of Thunder's tier-2 hang). With IF clear the region keeps running, bounded by tbudget;
  the pending tick fires when the guest re-enables interrupts.
- **SMC eviction (`R.dead`/`cpu.tgen`).** A write into a region's page sets `R.dead`; the guard
  stops in-flight execution at the next iteration (staleness bounded to one block, like tier-1).
  3 evictions of a root → blacklist it (`T2_BLACKLIST`), stays tier-1 (auto-modifying intros).

`_installRegion` replaces the root's tier-1 slot with the region; constituent blocks stay
tier-1 (so a mid-region bail can dispatch them). `_evictRegion` undoes it.

## Env kill-switches (all default-on optimizations)

`MIRAGE_NOTIER2`, `MIRAGE_NOSTRIP`, `MIRAGE_NOMEMINLINE`, `MIRAGE_NOFPUINLINE`,
`MIRAGE_PITRELOAD=<cycles>` (PIT rate; default 65536). Every gate must pass with each switch
both on and off — the golden PNG gate is the only thing that catches multi-instruction strip
bugs (SST is single-instruction and never strips).

## Gotchas when editing

- The emitter builds **strings**; a syntax error surfaces as a `new Function` throw at first
  execution of that block, not at edit time. Test the specific program.
- `MAXOPS`, terminator handling, and cycle bookkeeping are load-bearing for interrupt timing —
  change with the `fuzz-region` + `golden` gates watching.
- Anything that changes *when* the timer/IRQ is delivered can shift timer-sensitive demos
  (256bytef/intoanew/memories) — that's a golden re-bless, not a bug, **if** you've verified the
  demos still render (side-by-side PNGs) and tier-1==tier-2.
