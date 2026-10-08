# Booting a real DOS kernel — the investigation

> Moved here unchanged from `docs/COMPAT.md`, where it was written as the work went. A record of
> what was tried and found at the time, not a description of the present state.

## Booting a real DOS kernel

**FreeDOS 1.4 BOOTS TO ITS SHELL (2026-08-22).** `boot/FREEDOS14.IMG` reaches FreeCom 0.86 and its
installer prompt — *"Welcome to the FreeDOS 1.4 installation program … Do you want to proceed [Y,N]?"*
It took one engine fix, found by reading the kernel rather than guessing:

- The kernel loads **byte-perfect** (all 46,485 bytes of `KERNEL.SYS` identical to the file extracted
  from the FAT12 image at `0060:0000`) and its relocation stub — strip the 32-byte header by copying
  the image down a segment, then `xor ax,ax / jmp ax` — also works. Both verified byte-for-byte, so
  the boot sector and INT 13h were never the problem.
- **Stage two is a self-modifying decompressor.** It rewrites the immediate of its own
  `add ax,0x0005` from inside the executing block, then `sub byte [cs:si+0x12],0x10` / `jnc 0xa`
  loops back to an address that is *mid-instruction* on the first pass (`a9 b5 80` is
  `test ax,0x80b5`; entering at 0x0a gives `b5 80` = `mov ch,0x80`).
- **The bug was ours.** The G6 self-modification guard `return`ed from **inside the write emitter** —
  the middle of an instruction — so `cpu.setSub` never ran and the `jnc` read a stale carry. It
  looped where it should have fallen through, and the second pass's segment arithmetic put the copy's
  destination past 1 MiB; with A20 closed it wrapped into low memory and the kernel overwrote its own
  code. The guard now records at the write and fires at the **instruction boundary**, which is also
  where the resume address is correct. ⚠️ Keep the `cpu.smcSelf` condition on the recording side:
  dropping it aborts on any write to a code page, not just self-modification, and moves 12 goldens.

**And this delivers the second oracle ROADMAP G1 wanted.** Reading the MCB chain a real DOS kernel
builds for itself:

    MCB 0x0281 'M' owner=0x0008 size=0x430    (16.8 KiB)   kernel
    MCB 0x06b2 'M' owner=0x0008 size=0xa4d    (41.2 KiB)   kernel
    MCB 0x1100 'M' owner=0x0000 size=0x6                   free
    MCB 0x1107 'M' owner=0x1108 size=0x1193   (70.3 KiB)   <- first PROGRAM, PSP 0x1108
    MCB 0x229b 'M' owner=0x22c8 size=0x2b
    MCB 0x22c7 'M' owner=0x22c8 size=0x7cb7   (498.9 KiB)
    MCB 0x9f7f 'Z' owner=0x1108 size=0x80

So FreeDOS puts the first program at **PSP 0x1108**, and dosbox-x puts a `.COM` at **0x0814**. Ours is
**0x0100**. Two independent oracles now agree on the shape of the answer: a real DOS places the first
program far above where we do, and the guest gets 29–66 KiB of conventional memory it should not have.

**Where `win /3` stops now, measured 2026-08-22 (after #PF and the linear-address fix).** It is
*running*: WIN386 loads its TSS (`TR=0x18`), remaps the PIC (timer IRQs arrive on vector 0x20, 92 of
them in a run), and services its own page faults through its stub table at linear 0x80005ee4
(`pusha / mov esi,0x38 / jmp common` — 0x38/4 = 14, the #PF entry). 387 exceptions in a run, against
39,634,604 before. No fault reported.

It stops because **seven pages fault forever**:

    0xc0010000 x90   0xf000e000 x86   0xf000d000 x85   0xf000f000 x82   0xf000c000 x50

`0xC0000000` is where a **recursive page-directory mapping** lives — the alias a VMM gives itself so
it can edit its own page tables — and `PDE#768` is simply never created: only PDE#0 and PDE#512 are
present in CR3's directory. `0xF000c000`-`0xF000f000` is the ROM window the first V86 machine needs.
So Windows' own #PF handler runs, cannot satisfy the fault, and re-takes it.

Delivery itself checks out, which is worth recording so it is not re-suspected: the 0x38 stub has no
`sub esp,4` where its neighbours (0x3c, …) do — the standard "this vector pushes an error code"
convention — so the frame we push is the shape it expects, and CR2 and the error code follow the
architecture (bit 0 present, bit 1 write, bit 2 user).

**Followed further, 2026-08-22 — those seven pages were a CONSEQUENCE, and both causes are fixed.**
Windows never wrote to its own page directory (every write landing in CR3's page was watched: zero),
so it was not failing to map its recursive alias — it never tried. Reading its own dispatcher gave
the chain:

    80005fc2  call 0x80005d34             ; one CALL stub per vector
    80005d34  pusha
    80005d35  mov esi,[esp+0x20]          ; = the CALL's return address
    80005d39  sub esi,0x80005ec7          ; ...minus the table base
    80005d3f  shr esi,1                   ; = the vector as a table offset
    80005e0f  call dword [esi+0x80013a9c] ; dispatch

`esi` was 0x3fffd09c, i.e. `[esp+0x20]` read **0xFFFFFFFF**, so Windows dispatched through a wild
pointer — and *that* is what touched 0xC0010B38 and the 0xF000c000 window. Two defects, both about
width and both general:

1. **`ENTER`/`LEAVE` were hard-wired to the 16-bit form.** The operand size decides the width of
   everything they touch; at 32 bits `ENTER` pushes EBP and sets EBP, not BP. Windows opens a frame
   with `enter 0xa8,0`, so it pushed two bytes instead of four and left ESP odd — every frame read
   downstream was two bytes off.
2. **The stack helpers masked a LINEAR address.** `push16/pop16/push32/pop32` (and `csip`) applied
   `mem.mask`, which is the PHYSICAL RAM/A20 wrap. Windows' kernel stack is at linear 0x800131e8;
   with A20 closed that became 0x131e8, so **every push landed in low memory and every pop read
   zeros** — hence the 0 return address. Same bug class as the recompiler's, in the CPU's own
   helpers.

**Result: zero page faults**, from 495 on seven phantom pages. `win /3` now runs with TR loaded, the
PIC remapped, 194 timer interrupts serviced, and stops later on a #GP cascade at `34c0:80006224` —
a segment that looks real-mode, so the next thing to look at is the first V86 transition.

**The stale block, found and fixed 2026-08-22 — `invalidate()` used a SIGNED shift.** With the page
faults gone, `win /3` died in a #GP cascade, and printing the emitted source of the block it was
running settled what that was:

    block ip0 = 0x80006366, linStart..linEnd = 0x80006366..0x80006368
    emitted: cpu.softInt(32, …)      i.e. it decoded `CD 20` = INT 20h
    memory there now reads:          ff 15 c0 34 01 80 = call dword [0x800134c0]

Measured rather than guessed, in two steps. First, the physical frame behind that linear page **never
changed** (0x105000 throughout) while the bytes went from `cd 20` to `ff 15` — so it was a write, not
a remap, and only 2 `setCR3` calls happened all run. Second, every write reaching that frame came
through the **same** linear page it executes at, `codePage[0x80006]` was set, and `_dirty` fired on
0x80006366. Everything upstream worked.

`Recompiler.invalidate` then did `for (let p = addr >> 12; …)`. **`>>`, not `>>>`**: a linear address
at or above 2 GiB is negative as a signed int32, so the page number was negative and the lookup
missed every time. The same trap was in five more places in `memory.js`'s write and bulk-copy paths.

**Result: `win /3` completes its enhanced-mode initialisation** and exits with Windows' own diagnostic
instead of a derail — *"ERROR: Cannot install the 386 enhanced mode Expanded Memory driver."* With
`ems: false` it says the same of XMS, so what it wants next is for **V86MMGR to take over the
real-mode memory driver**, which is a named feature rather than a bug.

**Where `win /3` stops now (2026-08-22, after the invalidation fix): the V86MMGR takeover.** It runs
its whole enhanced-mode initialisation and exits cleanly with Windows' own diagnostic. Three
measurements bound the problem:

| Configuration | What Windows says |
|---|---|
| `xms: true, ems: true` (default) | *"ERROR: Cannot install the 386 enhanced mode Expanded Memory driver."* |
| `xms: true, ems: false` | *"ERROR: Cannot install the 386 enhanced mode XMS driver."* |
| `xms: false` (with or without EMS) | *"Missing HIMEM.SYS; install HIMEM.SYS from your Windows Setup disks."* |

So HIMEM is mandatory — enhanced mode will not start without XMS — and whichever memory driver is
present, the **takeover** is what fails. The INT 2Fh trail ends `4300 / 4310 / 4310 / 1606`: it finds
the XMS driver, asks twice for its entry point, and then broadcasts 1606h (Windows exiting). **It
never calls that entry point** — no XMS call reaches our dispatch at all — so it is failing before
the call, at the point where it wants the driver's real-mode CODE to map into each VM.

That is the crux: ours is a JS service behind a guarded `f000:100` stub, not 8086 code sitting in
low memory, and V86MMGR's whole job is to virtualise a real driver. Making this work means either
providing a genuine real-mode XMS/EMS driver image for it to take over, or answering the takeover
protocol (INT 2Fh AX=1605h participation and the V86 API entry) directly. It is a feature, not a bug.

## Booting a real DOS kernel

**FreeDOS 1.4, re-measured 2026-08-22 — the loader is exonerated; the derail is in the kernel's
second stage.** `boot/FREEDOS14.IMG` boots, loads and relocates its kernel correctly, then walks off
into empty memory. Each step was checked against the image itself rather than inferred:

- **The kernel loads byte-perfect.** Comparing memory at 0x600 against `KERNEL.SYS` extracted from
  the FAT12 image, all **46,485 bytes are identical** at the moment control reaches `0060:0000`. The
  boot sector's cluster walk and our INT 13h are correct (114 reads).
- **The relocation stub works.** `0060:0000` is a 32-byte header (`eb 1b` + "CONFIG"); `jmp 0x1d`
  goes to `jmp 0xb573`, the last code in the file, which strips that header by copying the image
  down one segment-and-a-bit (`es = cs - 2`, `rep movsb` of 0xb573 bytes from `ds:1` to `es:1`,
  arranged so the copy ends 31 bytes short of the stub itself) and then `xor ax,ax / jmp ax` — into
  what is now linear 0x600. Checked afterwards: 0x600 holds `b9 7f 5a be fc b4 …`, exactly file
  offset 0x20. Correct.
- **The derail is right after that**, and stage two is now read: it is a **self-modifying
  decompression loop**.

        0000  mov cx,0x5a7f
        0003  mov si,0xb4fc / mov di,si / push ds
        0009  a9 b5 80          test ax,0x80b5      <- 0x0a is INSIDE this: `b5 80` = mov ch,0x80
        000c  mov ax,cs / add ax,0x0005 / mov ds,ax / add ax,0x723 / mov es,ax
        0018  std / rep movsw
        001b  cld
        001c  sub byte [cs:si+0x12],0x10            <- rewrites the immediate at 0x0f-0x10, IN THIS BLOCK
        0021  jnc 0xa                               <- loops back to the OVERLAPPING instruction

  So each pass rewrites the high byte of its own `add ax,0x0005` and re-enters at an address that is
  mid-instruction on the first pass — the G6 class, plus overlapping decode. Sixteen passes bring
  that byte back to 0x00.

  **What we measured at the failure:** `si=0xfffe`, `cx=0`, **`ds=0xf065`, `es=0xf788`**. So the copy's
  destination is `0xF788:0xb4fc` = linear **0x102D7C, past 1 MiB** — and **A20 is closed** (FreeDOS
  never touches port 0x92, 0x64 or 0x60 before this; the only port traffic in the whole run is 4530
  reads of 0x100, which is post-derail noise). The write therefore wraps into low memory and the
  kernel overwrites its own code: `[0x61b]` reads **0x00**, which is exactly why the block at `60:1b`
  decoded 0x180 bytes of nothing and walked.

  ⚠️ **Not yet determined, and the whole question:** whether that segment sequence is what real
  hardware produces — in which case the wrap is intended and A20 is the thing to look at — or whether
  our re-translation after the self-modification hands back a STALE immediate, in which case the
  0xF005 is ours. Stepping the first two passes and printing the immediate at 0x610 each time
  separates them.

It is also **slow**: 160 M cycles in 45 s, against ~125 M cycles/s on Wolf3D. Worth a look on its own.


**FreeDOS 1.4 boots** to its `A:\>` prompt, verified interactively (`tools/run-boot.mjs
boot/FREEDOS14.IMG 9000000 4e,0d`), with no unimplemented INT vector and no unhandled port along
the way. Its INT 21h behaviour is the DOS oracle's reference (`tools/dos-oracle.mjs`).

**MS-DOS 6.22 does not**, and the failure is fully traced — though not yet root-caused. The chain,
from the end backwards:

1. `0070:07C9  2E FF 1E 0E 00   call far [cs:000E]` jumps to `0009:F00B`. That is not code: it is
   inside the interrupt vector table, where the low word of vector 29h (`62 07`) decodes as `BOUND`
   and raises INT 5 — about 9M times per run, which is what the unhandled-INT counter reported.
2. The pointer at `CS:000E` is zero in the on-disk IO.SYS, so it is written at runtime. The writer is
   `02CC:067D`, a run of `mov es:[di+8],dh` / `[di+0Ch],bh` / `[di+0Eh],cx` / `[di+10h],ah` /
   `[di+11h],al` — building a device-driver header through `ES:DI`.
3. It runs with **DI = 0xFFFF**. Every effective address wraps, so instead of filling a header
   somewhere else the five writes land at 0x707-0x710 — inside IO.SYS's own first 16 bytes, right on
   top of the far pointer at CS:000E. `CX=0x0B40` supplies its low word and `AX=0xF009` the rest,
   which is exactly the `0009:F00B` we jump to.
4. DI = 0xFFFF is the **terminator of a device-driver chain**. `02CC:04DB` walks it —
   `cmp es:[di+5],al` / `je found` / `les di,es:[di]` / `cmp di,0FFFFh` / `jne` — and falls out the
   bottom into `stc; ret`. The STC and the CF do propagate correctly (verified by single-stepping);
   the caller simply carries on and dereferences DI anyway, at `02CC:0606 test es:[di+23h],5`.
5. The search is for a node whose attribute high byte is 0. **The chain has exactly one node**, at
   70:03B2, attributes 0x4041 (a block device). At this point in a real boot IO.SYS has installed its
   resident drivers; one node means most of that installation did not happen or did not link.

So the root cause is upstream in IO.SYS's own initialisation, and step 5 is where to pick it up.

Traced further, the truncation is deliberate: at `70:1BB4`, `c7 05 ff ff` = `mov word [di],0FFFFh`
writes the terminator into node 0x3B2 itself, whose `next` pointer had been 0x0416 a moment earlier.
So 0x3B2 is very likely the *last* node of the chain, and the search that fails starts from the wrong
end — the DOS chain head is the NUL device inside SysVars, not an arbitrary node. Where the search's
starting DI comes from is the next thing to establish.

**DOSBox-X boots this same image**, and its log shows the identical BIOS-level probe pattern we see —
"Disk 1 not active", "Disk 2 not active", `INT15 ax=4101` unknown. Our answers on those paths are
therefore not the differentiator, which is consistent with the refutations below. It also means a
reference exists: the next step is a **differential trace against DOSBox-X**, not more solo forward
reasoning, which is where this investigation stopped converging.

Three hypotheses tested and **refuted**, recorded so they are not re-tried:

* *Missing INT 14h/17h.* IO.SYS installs its AUX and PRN drivers unconditionally and called both,
  and neither had a handler — the audit's T1.1 shape exactly (CF set, registers untouched, which a
  caller reading AH as a status byte takes for success). Both are implemented now. No change.
* *INT 13h answering wrongly for the drives MS-DOS probes.* It calls AH=08 and AH=02 with
  DL = FC, FD, FE, FF. Our INT 13h fails all four with 80h, which is correct — and DOSBox-X fails
  them too.
* *AH=08 returning a null diskette parameter table.* It answered `ES:DI = 0000:0000`, a null pointer
  dressed as an answer. It now returns a real 11-byte table, with INT 1Eh pointing at the same one.
  Correct on its own merits; no effect on the derail.

Still unhandled during that boot: INT 15h x2.
