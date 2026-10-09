# MIRAGE — The recompiler (`src/recompiler.js`)

How x86 machine code becomes JavaScript and runs. Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Translating a block: `translate(linStart, ip0, maxOps, d)`

`translate` decodes x86 forward from a linear address and appends JavaScript **source strings** to
an array, until a terminator or `maxOps` instructions (192 by default, `MIRAGE_MAXOPS`). `d` is the
code segment's D bit (16- or 32-bit defaults). The body is compiled with `new Function('cpu', …)`.

The body opens by binding hot state to locals:

```js
var r=cpu.reg, m=cpu.mem, sb=cpu.base, u8=m.u8, cp=m.codePage;   // + st, dv when the block uses the FPU
```

Each instruction then appends statements that read and write `r[i]`, `u8[a]` and the rest directly.
The block object it returns:

```js
{ fn, linStart, linEnd, ip0, ipEnd, count, term, usesFPU, canFault, kind, epoch, ph0, ph1, … }
// count: instructions retired, added to cpu.cycles after the block runs
// kind:  0 = an ordinary block, 2 = a fused region (second tier, off)
// epoch, ph0, ph1: the address space it was compiled in (see "Under paging")
```

A block ends at a control transfer, at `maxOps`, one instruction after STI (the interrupt shadow),
or after an instruction that wrote into its own code (see below). Jumps within the same segment
record their targets in `term` instead of returning directly, so the second tier can follow them.

**Instructions emitted as calls.** Anything rare or long — segment loads with descriptor checks,
far transfers between privilege levels, task switches, CPUID, CMPXCHG8B, most x87 control
instructions — is emitted as a call into `cpu.js` or `fpu.js`. The common integer, memory, stack
and x87 arithmetic paths are emitted inline, and so are string instructions, as a loop (REP
included), through the memory object's accessors.

**BIOS and DOS entry points.** A few fixed addresses in the F000 segment hold a one-byte stub (`CF`
or `CB`). When a block would start there, `translate` returns a one-instruction block that calls the
JavaScript service instead: a BIOS interrupt called *inline* (a far call to its vector), the XMS
driver entry, the DPMI mode switch and its callbacks. The stub byte is checked first, so a program
that overwrites the address with its own code gets its own code.

## Running blocks: `run(machine, maxBlocks)`

The dispatch loop. Per block: deliver a pending interrupt if IF is set, compute the linear address
of `CS:EIP`, find the block, run it, add its count to `cpu.cycles`.

- **The cache** is a page table without hashing: `blockPages[lin >>> 12][(lin & 0xfff) | d << 12]`,
  so the same address compiled for a 16-bit and a 32-bit segment are two entries. A slot reached
  from a different `CS:IP` with the same linear address is recompiled, because jump targets inside
  the block are baked in from `ip0`.
- **The trap flag.** With TF set, each instruction is translated alone, uncached, run, and followed
  by INT 1. Copy protections that decrypt the next instruction in their single-step handler see the
  bytes they just wrote.
- **The size cap.** When the emitted source exceeds the cap (16 MiB, 64 MiB under paging,
  `MIRAGE_CODE_CAP`), the cache is dropped and the slice ends.
- **A derail.** A block of 64 instructions or more made entirely of zero bytes means the guest is
  executing empty memory; it is reported once, with the recent block trail (`src/derail.js`).
  `MIRAGE_DERAIL_STOP=1` turns the report into a fault.

`stepOne()` translates and runs one instruction without touching the cache. It is the path of the
conformance harnesses.

## Flags

Flags are kept materialised in `cpu.flags`. Two things keep that cheap:

1. **Conditions are inlined.** Jcc, SETcc and CMOVcc test flag bits directly:
   `JZ → (cpu.flags&64)`, `JL → ((cpu.flags>>>7^cpu.flags>>>11)&1)`.
2. **Dead flags are not computed.** A liveness pass over the block's instructions removes a
   flag-setting call whose flags are all overwritten before anything reads them. The flags live at
   the end of a block are always *all* of them. The table of what each instruction defines and uses
   describes MIRAGE's implementation, not the architecture: MUL is modelled as defining CF and OF
   only, because our implementation leaves SF, ZF and PF as they were, and a later PUSHF would see
   them. A reader missing from the table is the one unsafe error; the golden test is what catches it.
   `MIRAGE_NOSTRIP=1` disables the pass. `stepOne` never strips (its live-out is everything), which
   makes the conformance path exact by construction — and blind to strip bugs.

## Memory access

How a memory access is emitted is chosen by a strategy (`src/mem-strategy.js`), selected
separately for reads and writes (`MIRAGE_MEM_READ`, `MIRAGE_MEM_WRITE`). Without paging the default
emits a direct typed-array access, masked to the address space (the A20 wrap included); under
paging the `paged` strategy goes through the software TLB. Every strategy must give identical
results; golden and conformance are run for each.

Emitted inline with each access:

- **Planar video.** An access to A000h in a 16-colour planar mode is routed to `vga.js`.
- **Self-modifying code.** A write checks the page's code flag and calls the invalidator.
- **Segment limit and write protection.** In protected mode, an offset outside the segment raises
  #GP or #SS, and a write through a read-only segment raises #GP (`MIRAGE_SEGLIM=0`,
  `MIRAGE_SEGWP=0` turn them off for measurement). A block translated in real or virtual-8086 mode
  carries no limit check at all, since none can fire there; it is marked `real`, and the dispatch
  loop retranslates it if it is reached with PE set and VM clear. A block whose LMSW may set PE is
  translated with the checks (`MIRAGE_NOREALSPEC=1` emits them everywhere).
- **LOCK.** A LOCK prefix on an instruction that cannot be locked is #UD (`MIRAGE_LOCKUD=0`).

The x87 is emitted inline against a local copy of the stack top, written back at every block exit;
rare instructions call `fpu.js`. `MIRAGE_NOFPUINLINE=1` makes every x87 instruction a call.

## Self-modifying code

Every 4 KiB page a block was compiled from is marked. A guest write to a marked page calls
`invalidate(addr, len)`, which evicts only the blocks whose byte range the write overlaps. Three
filters keep that cheap, because most writes into a code page touch data:

1. per group of 256 pages, the lowest and highest byte any block covers on each page;
2. per page, a count of blocks covering each 16-byte chunk;
3. only then, the set of blocks on the page.

**A block that rewrites its own later bytes.** The cache entry is evicted at once, but the block is
already running. After each instruction that writes memory, the block checks `cpu.smcSelf` — set
when the eviction hit the running block — and returns, so execution resumes at the next instruction
from freshly translated code.

## Under paging

When paging is on, the recompiler switches to the paged memory strategy and drops the cache, and it
does so again whenever paging is switched on or off, or CR4.PSE changes while it is on.

- **Page faults.** A memory access that cannot be translated throws `PageFault` from inside the
  block. Every instruction stores its own EIP first under paging, so `run` catches the fault, sets
  CR2 and delivers #PF with EIP at the faulting instruction. Restart is approximate: side effects
  the instruction had already committed are not undone. Demand paging faults on the access itself,
  which is the case that matters.
- **Address spaces.** A CR3 load does not drop the cache. It increments `epoch`; a block compiled in
  an older epoch is checked the next time it is reached: if its first and last pages still map to
  the physical frames it was compiled from (`ph0`, `ph1`), it is kept, otherwise evicted. This is
  what keeps process switches cheap (`MIRAGE_NOD8=1` restores dropping the cache).
- **INVLPG** refreshes the TLB entry and invalidates the blocks on that page.

A change of the A20 mask drops the cache and ends the slice as well, because `run` keeps the mask
in a local for the whole slice.

## The second tier (off)

`_promote` can fuse a hot block and its statically reachable successors (up to 24 blocks and 384
instructions) into one function, a `for(;;){switch(_e){…}}` that runs a loop without returning to
the dispatcher. It is **off**: a region can run an unbounded amount of work in one slice, and some
games ran slower or derailed with it. `MIRAGE_TIER2=1` turns it on for work on it.

What it guarantees when on: identical results to the first tier (the `fuzz-region` test runs
thousands of random programs both ways), the same slice budget, a bail-out when a timer tick falls
due and IF is set, and eviction when its code is written.

## Switches

All read once at start-up from the environment, all off by default unless stated.

| Switch | Effect |
|---|---|
| `MIRAGE_MAXOPS` | instructions per block (192) |
| `MIRAGE_CODE_CAP` | the size cap of the cache, in bytes |
| `MIRAGE_TIER2=1` | the second tier |
| `MIRAGE_NOSTRIP=1` | compute every flag |
| `MIRAGE_NOFPUINLINE=1` | every x87 instruction as a call |
| `MIRAGE_MEM_READ`, `MIRAGE_MEM_WRITE` | the memory strategy |
| `MIRAGE_SEGLIM=0`, `MIRAGE_SEGWP=0`, `MIRAGE_LOCKUD=0` | turn off the limit, write-protection and LOCK checks |
| `MIRAGE_NOREALSPEC=1` | emit the limit checks in real-mode blocks too |
| `MIRAGE_NOD8=1` | drop the cache on every CR3 load |
| `MIRAGE_SEGIP=1` | record the instruction that loaded each segment, for diagnosis |
| `MIRAGE_DERAIL_STOP=1` | stop on a derail |

An optimisation with a switch must pass the gates with the switch both on and off.

## When editing

- The emitter builds strings: a syntax error appears when the block is first compiled, not when the
  file loads. Run the program that exercises the path.
- Anything that moves *when* an interrupt is delivered — block length, terminators, cycle counting
  — shifts the timer-paced intros (`256bytef`, `intoanew`, `memories`). Re-bless their golden
  fingerprints only after looking at the frames.
- Emitted code must not depend on anything that can change during a slice without ending it (the
  A20 mask, paging, the cache arrays): `run` keeps them in locals.
