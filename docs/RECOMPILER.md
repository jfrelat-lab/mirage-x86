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

Without paging (DOS, Windows 3.x), a block ends at a control transfer, at `maxOps`, one instruction
after STI (the interrupt shadow), or after an instruction that wrote into its own code (see below).
Jumps within the same segment record their targets in `term` instead of returning directly, so the
second tier can follow them. Under paging (Linux and Win32 programs, the paged operating systems)
a block goes on through most control transfers: see [Longer blocks](#longer-blocks-under-paging).

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
of `CS:EIP`, find the block, run it, add its count to `cpu.cycles`. A block that loops on itself
turns inside its own function and comes back here when the loop ends, when the slice's block budget
is spent, or when interrupts are enabled (they are delivered between blocks).

- **The cache** is a page table without hashing: `blockPages[lin >>> 12][(lin & 0xfff) | d << 12]`,
  so the same address compiled for a 16-bit and a 32-bit segment are two entries. A slot reached
  from a different `CS:IP` with the same linear address is recompiled, because jump targets inside
  the block are baked in from `ip0`.
- **The trap flag.** With TF set, each instruction is translated alone, uncached, run, and followed
  by INT 1. Copy protections that decrypt the next instruction in their single-step handler see the
  bytes they just wrote. TF is looked at between blocks, so a POPF that sets it ends its block. A
  REP string instruction is one step, as in DOSBox-X; QEMU traps after each iteration
  (`tools/reptrap.asm`).
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

The x87 is emitted inline; rare instructions call `fpu.js`. `MIRAGE_NOFPUINLINE=1` makes every x87
instruction a call. Within a block the stack top is a local `F` plus a depth known at translation
time, so `ST(i)` is `st[(F+k)&7]` with `k` a constant, and a register's value once loaded or written
stays in a local for the reads that follow (write-through: `st[]` and `cpu.ftop` are always current
for a fault, an exit or a helper). `MIRAGE_NOFXCACHE=1` reads `cpu.ftop` at every access instead.

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
  block, with EIP at the faulting instruction: `run` catches it, sets CR2 and delivers #PF. EIP is
  stored only where it can be needed: not before an instruction that only moves registers and sets
  flags, and for one that touches memory through the paged fast path, only on the slow path of the
  probe (`(cpu.eip=X,m).r32(a)`), since the fast path cannot fault (`MIRAGE_NOLAZYEIP=1` stores it
  before every such instruction). Restart is approximate: side effects the instruction had already
  committed are not undone. Demand paging faults on the access itself, which is the case that
  matters.
- **Address spaces.** A CR3 load does not drop the cache. It increments `epoch`; a block compiled in
  an older epoch is checked the next time it is reached: if its first and last pages still map to
  the physical frames it was compiled from (`ph0`, `ph1`), it is kept, otherwise evicted. This is
  what keeps process switches cheap (`MIRAGE_NOD8=1` restores dropping the cache).
- **INVLPG** refreshes the TLB entry and invalidates the blocks on that page.

- **Flat segments.** A protected-mode segment of base 0 and limit 4 GiB can fail no limit check
  (Linux's, Win32's, a DOS extender's flat model), so its accesses are emitted without one; the block
  checks once, at its head, that the segments it relied on are still flat, and is translated again
  if not (`MIRAGE_NOFLATSPEC=1`). With a flat 32-bit stack, PUSH, POP, CALL and RET move it inline.
- **The translation memo.** A block's translation is kept by its bytes, its address and the state it
  depends on (code size, real or not, x87 precision, flat segments), so a program loaded again or a
  cache dropped for size recompiles nothing it has seen (`MIRAGE_NOMEMO=1`).

A change of the A20 mask drops the cache and ends the slice as well, because `run` keeps the mask
in a local for the whole slice.

## Longer blocks under paging

A JavaScript function call per block is the main cost of a dispatch loop, so under paging a block
keeps going through what would end it elsewhere. Each has its switch.

- **Side exits.** A forward conditional branch does not end the block: taken, it leaves
  (`if(cond){cpu.eip=T;…;return;}`, giving back the instructions it did not run from the count), and
  the block goes on after it (`MIRAGE_NOSIDEEXIT=1`).
- **Skips.** A forward conditional branch of 64 bytes or less is kept inside the block instead:
  `if(taken){cpu.cycles-=K}else{…}` around the instructions it jumps over, closed where it lands,
  the x87 top read again there. Skips nest; a block that ends or follows a jump inside an open skip
  is translated again without them. Elevated's synthesizer (`dec eax; jnz next` chains choosing an
  x87 operation) went from 6 to 19-35 instructions a dispatch (`MIRAGE_NOSKIP=1`).
- **Loops.** A backward branch to the block's head turns inside the function (the self-loop); one
  to an instruction inside the block opens a `for(;;)` there, and the block goes on after it. Both
  keep the dispatcher's accounting, a turn each (`MIRAGE_NOSELFLOOP=1`).
- **Followed jumps and calls.** A direct JMP or CALL to the block's page goes on at its target in
  the same block, up to four; a RET of a followed call goes on at the return address when the stack
  holds it, and leaves as a side exit otherwise (`MIRAGE_NOFOLLOW=1`).

Without paging none of these apply: the DOS golden runs, timed to the block, are what they were.

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
| `MIRAGE_NOSIDEEXIT=1`, `MIRAGE_NOSKIP=1`, `MIRAGE_NOSELFLOOP=1`, `MIRAGE_NOFOLLOW=1` | end the block at every branch, as without paging (see [Longer blocks](#longer-blocks-under-paging)) |
| `MIRAGE_NOFXCACHE=1` | read the x87 stack top from `cpu.ftop` at every access |
| `MIRAGE_NOLAZYEIP=1` | store EIP before every instruction that may fault |
| `MIRAGE_NOFLATSPEC=1` | emit the limit checks for flat segments too |
| `MIRAGE_NOMEMO=1` | no translation memo |
| `MIRAGE_NOLAZYTLB=1`, `MIRAGE_NOXTLB=1` | fill the fast page tables eagerly; no TLB in front of the page walk |
| `MIRAGE_KEEP_SRC=1` | keep each block's emitted source (for `tools/trace.js`) |
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
