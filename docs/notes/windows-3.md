# Windows 3.0 and 3.1 — the investigation

> Moved here unchanged from `docs/COMPAT.md`, where it was written as the work went. A record of
> what was tried and found at the time, not a description of the present state.

## Windows 3.0 (real / standard / 386 enhanced)

`tools/win30-install.mjs` builds a runnable tree from the four install floppies without SETUP (the
files are SZDD-compressed; `WIN.COM` is `WIN.CNF` + `VGALOGO.LGO` + `VGALOGO.RLE` concatenated).
Disks and tree live under `boot/`, gitignored.

| Mode | Where it gets |
|---|---|
| `win /r` (real) | ⭐ **BOOTS to the Program Manager (2026-09-15).** Title bar, `File / Options / Window / Help` menu, client area, then Windows idles on INT 2Fh. The last blocker was **`e_maxalloc = 0` putting the PSP in the wrong place** — see below. Before that, two defects found with the DOSBox-X INT 21h oracle: `syncSFT()` was called only from AH=52h, so the kernel — which reads the PSP's job file table DIRECTLY rather than asking DOS — found no handles and ran its five-open loop twice; and EMS AH=4Eh/58h named `ES`/`DS` without importing them, a `ReferenceError` that only fires once a guest reaches the page-map calls. ⚠️ **Retracted:** *"three `AH=48h` allocations where the reference makes one"* was read as our defect and "fixed" by handing an `e_maxalloc=0` program all of memory. The three calls were KERNEL's grow loop working correctly; the single call in the reference is the same loop finding nothing free, because on real DOS there IS nothing free — the program already owns the whole block. |
| `win` / `win /s` (standard) | opens `EMMXXXX0`, picks standard mode, EXECs `DOSX.EXE`, prints its own *"Cannot load Windows in standard mode; try running in real mode."* |
| **`win /3` (386 enhanced)** | **BOOTS** since 2026-08-22 — WIN386 enters protected mode with paging (CR0 = 0x80000011) and draws the **Windows 3.0 startup logo** in mode 0x12 (640x480x16 planar): the Microsoft wordmark, "Windows / Version 3.0", the 1985-1990 copyright line. Six defects had to go, five of them general engine bugs found by diffing our INT 21h stream against a `dosbox-x -debug -log-int21` capture of the same tree. See the list below. |

**How `win /3` got there — the five defects, in the order Windows hit them.** Each was found by
comparing our INT 21h sequence against DOSBox-X's for the same tree; the divergence point named the
bug every time. Only the last is Windows-specific.

1. **Virtual-8086 mode** (ROADMAP B4).
2. **#UD is a service the guest asks for.** The loader hooks INT 6 through DOS
   (`mov ax,2506h / int 21h`) and then executes `0f a6` *deliberately*. This is not a gap in our
   opcode coverage: the routine above it is the classic CPU identification ladder — the 8086 flags
   test, the 286 test, then `pushfd`/`popfd` on **EFLAGS.AC (bit 18)**, which only a 486 can set.
   We present as a 386, so Windows goes on to check for the **386 B1 stepping**, whose tell is that
   `XBTS` (`0f a6`) executes instead of faulting. Raising #UD is the *right* answer; throwing was not.
   (DOSBox presents as a 486, so it never runs this check — which is why the probe looked suspicious.)
3. **The MCB chain across EXEC.** The child's PSP was placed ON the free block's MCB header, and no
   MCB was written for the child's block at all, so the chain read as corrupt from there on:
   *"The conventional memory in your system is fragmented."*
4. **The carry flag was lost on a CHAINED return.** A program that hooks INT 21h and chains does not
   `int 21h` — it pushes a flags image and far-CALLs `f000:21`, returning through
   `machine.biosCallback`, which popped that frame and restored the caller's flags *verbatim*. A real
   ISR answers by writing the flags IMAGE on the stack, so every DOS error was invisible to a hooking
   program. WIN386 read AX=2 from a failed open as a file handle. **This one is not about Windows**:
   it is the ubiquitous TSR idiom, and it was silently wrong for every program using it.
5. **Multi-byte memory access ignored paging.** Only `r8`/`w8` translated; `r16`/`r32`/`w16`/`w32`
   did `a &= this.mask`, which treats a LINEAR address as physical — and `loadDescriptor` mixes
   `r16` and `r8`, so every descriptor load under paging was HALF translated. WIN386 puts its GDT at
   linear **0x8010011c**; we read the descriptor from physical 0x0010011c, got a 16-bit segment with
   base 0xc95e, and walked forward through memory in 0x180 steps until CS went null. `src/derail.js`
   named that walk on the first try. ⚠️ Watch the cost: `pagingOn` is a getter over two CR0 bits, and
   calling it per access cost **tube +6.3%, memories +12.2%** measured against HEAD back to back. It
   is a cached `mem.paged` flag now, kept in sync by `rebuildPageTables()`, and the bench is back on
   baseline.
6. **The environment's program path on EXEC.** After an environment block's terminating double NUL
   come a word 1 and the ASCIIZ full path of the program that owns it. DOS gives a child a *copy*
   ending in the CHILD's path; we handed over the parent's block — and WIN.COM appends `windir=` to
   that block in place, overwriting the word and the path outright. WIN386 **reopens itself** through
   that path to load its VxDs, and was opening a zero-length filename.


**How `win /r` got to the Program Manager — `e_maxalloc = 0` moves the IMAGE, not the PSP.**
KERNEL.EXE lays its global heap over exactly `PSP + 0x10 .. [PSP:0002]` (segment 1, `0x9260`:
`mov es,[0x18] / add ax,0x10 / mov cx,[es:2] / call GlobalInit`). Nothing else feeds that heap: the
loop at seg 1 `0xB50C` asks DOS for whatever is free and adds it, and on real DOS the answer is
"nothing", because the program already owns the whole block. So **where DOS puts the PSP decides how
much memory Windows has**, and we put it in the wrong place.

`placeProgram` read `e_maxalloc = 0` as "PSP high, at the top of memory". Measured against dosbox-x
with `tools/mzalloc.asm`, only CS moves:

    maxalloc=FFFF   PSP=0814 CS=0824  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000
    maxalloc=0000   PSP=0814 CS=9FA1  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000
    maxalloc=0000, KERNEL-sized image (68 KB)
                    PSP=0814 CS=8F21  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000

⚠️ **The probe was the thing that was wrong**, and its answer had been in this document as DOS's.
`mzalloc.asm` took its PSP as `CS - 0x10`. Under "image loaded high" that points into the middle of
the block, where memory is zero — so it reported `PSP=9F91 PSP0002=0000 MCB=- OWNER=0000 SIZE=0000`,
and those zeros were written up as "DOS hands over the whole region and loads the image as high as it
fits, leaving nothing free below". Half of that is true. The probe takes its PSP from ES at entry now.

With the PSP high, KERNEL's heap was `0x8F4C..0x9FFE` — **its own image, 67 KB**, three arenas, all
but one paragraph of it reserved at GlobalInit. The first `GlobalAlloc` (the module database, 1360
bytes, from seg 1 `0xA549`) returned 0; the caller at `0xA54C` does `mov es,ax` **without checking**,
wrote the database over the interrupt vector table, and the failure surfaced two returns later at seg
1 `0x9315` (`or ax,ax / jz`) as a deliberate **`ExitKernel(1)`** — whose own first far call is an
unapplied NE relocation, which is the `call far 0000:FFFF` at `905f:1822` that looked like a derail.
With the PSP at the block base the same heap runs `0x0850..0x9FFE` and that allocation returns
`0x0853`.

Three readings were tested and dropped on the way, recorded so they are not repeated: the module
database is not corrupted (KERNEL clears the `'M'` signature on purpose — `'M'` is FREE, absent is
allocated); the allocator's split at seg 1 `0x24E8` is correct and simply never ran; and KERNEL never
needed a *free* to make room — there is no first free in a healthy boot, the heap is born with the
whole block free below the image.

⚠️ **Open, measured, and left alone:** our load segment is 12 paragraphs higher than dosbox-x's
(`8F3D` vs `8F21` on the 68 KB probe, `9FAD` vs `9FA1` on the small one). dosbox-x sizes the image as
`e_cp * 512 - e_cparhdr * 16`, ignoring the partial last page that `e_cblp` describes; we honour
`e_cblp`. Nothing observed depends on it — the heap's bounds come from the PSP and `PSP:0002`, not
from where the image sits inside the block.


**MS-DOS 6.22, re-tested 2026-08-22 after the SMC fix — unchanged, and now named exactly.** It
prints *"Starting MS-DOS..."* and then derails; today's fixes, which unblocked FreeDOS, do not touch
it. The classifier reports it in one line:

    INT 05h re-raised 100000x at 0009:0013 (linear 0xa3) — INSIDE THE REAL-MODE IVT (vector 40)
    … 11 of those advance by exactly 0x180, so the decoder is walking forward through memory

and the first entry into non-code is earlier, at linear 0xf09b, *"in a run of zero bytes"*. Tracing
back gives the exact instruction:

    0070:07c9  push ax / push bx / mov ah,5 / call far [cs:0x000e]

The far pointer at `0070:000e` reads **0009:f00b** — linear 0xf09b, which is all zeros. So IO.SYS
calls through a dispatch slot that nothing has filled in. That is the same blocker as before, but it
is now a single named pointer rather than "derails in IO.SYS init", and the question is what should
install it.

Consequence for ROADMAP G1: **MS-DOS's own PSP cannot be measured here yet.** The two oracles that do
answer bracket it — dosbox-x's DOS puts a `.COM` at 0x0814, FreeDOS 1.4 puts the first program at
0x1108 — and MS-DOS 6.22's value depends on its CONFIG.SYS anyway. Ours is 0x0100 either way.

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
present, the **takeover** is what fails. The INT 2Fh trail is
`4300 / 4310 / 1600 / 1605 / 4300 / 4310 / 4310 / 1606`: it finds the XMS driver, asks for its entry
point, broadcasts 1605h (Windows starting) and then 1606h (Windows exiting).

⚠️ **Corrected 2026-09-09.** This paragraph used to say *"it never calls that entry point — no XMS
call reaches our dispatch at all"*. That is **false**, and it pointed the investigation at the wrong
place for two weeks. Measured with the committed runner `tools/win30.mjs`, **421 calls reach the XMS
entry**: version (`AH=00`) twice, query free (`AH=08`), **allocate the whole pool** (`AH=09`, 13248
KB), lock/unlock, a request for the HMA, a query of the A20 state, then **136 lock / move / unlock
cycles**, and finally a clean `AH=05`/`AH=06`/`AH=0A` (enable A20, disable, free the handle) before
Windows gives up. So the failure is in an ANSWER we give, not in reaching the driver. INT 67h is
never called at all, even in the configuration whose diagnostic names the Expanded Memory driver.

Two of those answers contradicted our own driver and are fixed (`2cd5825`) — **neither changes where
Windows stops**: `AH=01` (request HMA) returned 91h "HMA already in use" while `AH=00` reports DX=0,
"no HMA" (90h is the answer that matches), and `AH=07` (query A20) left BL untouched on its failure
answer, so Windows read the 91h left there by the HMA request as an A20 error code.

**Neither external oracle reproduces enhanced mode yet, so there is nothing to diff against.** Under
QEMU with FreeDOS + HimemX 3.34 (a real driver, entry at `029D:0620` against our HLE `F000:0100`) the
same tree fails *differently* — *"The conventional memory in your system is fragmented and Windows
cannot run in 386 enhanced mode"* — which is that image's own DOS layout, not this defect. Making
QEMU a reference here needs a cleaner boot image (MS-DOS + HIMEM.SYS from CONFIG.SYS); DOSBox-X,
which runs Windows 3.x enhanced mode on its own HLE XMS, is the cheaper route and is untried.

That is the crux: ours is a JS service behind a guarded `f000:100` stub, not 8086 code sitting in
low memory, and V86MMGR's whole job is to virtualise a real driver. Making this work means either
providing a genuine real-mode XMS/EMS driver image for it to take over, or answering the takeover
protocol (INT 2Fh AX=1605h participation and the V86 API entry) directly. It is a feature, not a bug.

**Maniac Mansion's residual divergence: the memory hypothesis is REFUTED (2026-08-22).** After the
accounting corrections our base map matches dosbox-x exactly, and the natural next thought — that the
environment block's own MCB pushes the program higher on a real DOS, leaving it less room — turned
out to be wrong. `tools/memx.asm` settles it by replicating MANIAC's exact profile: an MZ EXE with
`maxalloc=0xFFFF` that shrinks to 0x20a0 paragraphs, replays its first alloc/free cycles, and then
asks. Both sides answer, field for field:

    LARGEST-FREE-PARAS=774A   PSP=0814   DOSVER-AX=0005
    0x7000-FITS-AFTER-CYCLES=0001        PSP0002=9FFF

Identical. So the map, the DOS version and the allocator's behaviour under alloc/free churn are
indistinguishable, and 0x7000 fits on both — yet MANIAC's own search diverges at int21 event #20,
where DOSBox retries with a smaller request and we free after a success.

Two readings were tried and dropped on the way, both recorded so they are not repeated: the streams
do NOT diverge at "step 7 of the alloc sequence" (the oracle's index counts every AH, so #20 is the
21st INT 21h call — which is our free after the successful 0x7000, matching the sized log), and
DOSBox does not fragment its free list where we do not.

The shared prefix has now been diffed by VALUE, with `tools/ioc.asm`, and it turned up one real
defect — which did **not** explain the divergence. `AH=44h AL=00h` returns a handle's device
information word, and dosbox-x answers **0x80D3** for a character device: bit 0 stdin, bit 1 stdout,
bit 4 special, bit 6 not-at-EOF, bit 7 device. We answered a bare **0x0080** — a device that was
neither stdin nor stdout and was sitting at EOF — and 0 for a file where DOS gives its drive number.
Fixed and now matching. `AH=19h` (current drive = 2) and `AH=30h` (version = 5) already matched.

So every value in the prefix that can be compared now agrees, and Maniac's divergence was unmoved.

**What it reads outside DOS, measured too — and the chase is now CLOSED as refuted.** Logging its
non-INT-21h calls turns up exactly two, both INT 10h: `AX=1A00` (get display combination code) after
the 14-call prefix and immediately BEFORE the first allocation, and `AX=000D` (set mode 0Dh) much
later. `tools/dcc.asm` compares what those return, plus the equipment word and memory size:

|                 | dosbox-x | MIRAGE before | after |
|---|---|---|---|
| `1A00` → AX     | `001A`   | `1A1A`        | `001A` |
| `1A00` → BX     | `0008`   | `0008`        | `0008` |
| `INT 11h` equip | `4467`   | `0021`        | `0027` |
| `INT 12h` KiB   | `0280`   | `0280`        | `0280` |

Two real defects, both fixed: `1A00` returned the caller's own AH (necessarily 1Ah) alongside AL, an
answer no BIOS gives; and the equipment word claimed "has FPU" in its comment while bit 1 was clear,
with the pointing-device bit clear too, though we ship both. It still differs from dosbox-x on
purpose — that machine fits two floppies, two serial and one parallel port, and ours fits none.

**Neither moved the divergence, and Maniac never calls INT 11h at all.** Four hypotheses have now
been tested and refuted — the PSP segment, the memory accounting, the INT 21h prefix by value, and
the BIOS calls — each leaving a real fix behind. Our DOS answers match a real FreeDOS kernel on
3964/3964 comparable calls. Whatever makes MANIAC's allocation sizes differ is not any value it is
handed; the remaining possibility is memory it inspects directly, and that is a much larger search
than the return of a call.

**A behaviour change worth naming, 2026-08-22.** Setting the equipment word's coprocessor and
pointing-device bits (BDA 0x410, 0x0021 → 0x0027) moves **Wolf3D from 88411 to 88185 non-zero plane
bytes**. A/B'd on that word alone. It is the more faithful number: this machine ships an x87 and an
INT 33h mouse, and dosbox-x announces both too — Wolf3D simply draws differently once it knows. The
old figure appears in older notes; 88185 is current.

## Windows 3.1, standard mode (v86's `win31.img`, 2026-09-22)

`boot/WIN31HD.IMG` — hard disk 66/16/63, MS-DOS 5 + HIMEM + SMARTDRV, `win` in STANDARD mode, display
driver SVGA256.DRV. ⭐ **Reaches the Program Manager at 1024x768x256 in 180 s, and the frame is
identical to QEMU's: 0 of 786 432 pixels differ**, mouse cursor included.

It took seven defects, all of them protected-mode CPU or BIOS behaviour that nothing else in the
toolbox exercised. Each was found by catching the fault Windows' own DOS extender reported
("Standard Mode: Bad Fault in MS-DOS Extender ... EC=… IP=… CS=…") rather than by reading KERNEL:

| # | Defect | How Windows met it | Oracle |
|---|---|---|---|
| 1 | 286 TSS read as a 386 one (`d719226`) | inward stack switch through a 286 call gate loaded a null SS | 286 TSS layout |
| 2 | **LAR/LSL refused a NOT-PRESENT descriptor** (`4dd31a0`) | KERNEL asks "is this segment loaded?" with `lar` + `test ah,80h`; "discarded" became "invalid", the segment was never loaded, and `call far 0387:0b7e` ran into zeros | `tools/larprobe.asm`, QEMU = v86 |
| 3 | #UD ownership read from the real-mode IVT in protected mode (`f0e3581`) | DOSX installs a #UD handler via DPMI and then executes `0f ff` on purpose | IDT gate present |
| 4 | FF /3 and FF /5 bypassed `farCall`/`farJmp`, so CALL GATES were ignored (`a305cf7`) | `call far [cs:1408]` through selector 00D3, a 286 gate → #GP(00D0) | 386 manual; unit test |
| 5 | VERR/VERW were a stub that always said yes (`6042c3b`) | not on the path, found by the sweep below | `tools/pmprobe.asm`, QEMU = v86 |
| 6 | **A faulting far transfer was delivered as if the fault were DEFERRED** (`dcc0b5a`) | Windows demand-loads code through #NP; the frame saved the return IP, the handler's EIP was overwritten, ESP rewound on the handler stack → the handler ran from 0070:091e | unit test on all three encodings |
| 7 | VBE mode 105h missing (`93d9842`) | SVGA256.DRV sets 105h BY NUMBER, with no 4F00/4F01, and ignores the refusal | QEMU's 1024x768 frame |

**Why nothing caught these earlier** — the gap is structural. `realmode.flat` is real mode by
construction; the golden fingerprints are real-mode DOS; the Unicorn co-simulation builds no
descriptor tables; and test386, which does test protection, stops at POST 0x12 before that
section. `tools/larprobe.asm` and `tools/pmprobe.asm` start to close it: boot sectors that put a
matrix of cases over COM1 and run unchanged under QEMU, v86 and MIRAGE. Two independent CPU
implementations agreeing is the reference; pmprobe also refuted its own comment (VERR/VERW do NOT
require P=1).

**Capture caveat.** The BDA mode byte still reads 12h once a VBE mode is set; read `machine.vbe` and
its framebuffer, not the planes, or the desktop looks like red-and-black stripes.

**Excluded by `tools/diff-v86.mjs`**: the 1559 sectors read before the LAR derail were identical,
in order, to v86's — the divergence was a decision, not the disk.
