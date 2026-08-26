# MIRAGE — Roadmap (candidate tasks to choose from)

North star: run **Dune (Cryo)** and **Second Reality** accurately, in pure JS, "précision et
vitesse". This is a menu, not a plan — pick what's next. Effort: **S** ≤ half a session, **M** ≈
one focused session, **L** = multi-session. Each notes what it unblocks. See [COMPAT.md](COMPAT.md)
for current status and [ARCHITECTURE.md](ARCHITECTURE.md)/[RECOMPILER.md](RECOMPILER.md) for how.

## A · Correctness & browser UX (small, high polish-per-hour)

| # | Task | Effort | Why / unblocks |
|---|---|---|---|
| A1 | ~~text attr reset on program return~~ **partly DONE** (`6553340`: `programReturned()` resets `bios.attr`=0x07). Still open: reset the *video mode* to text when the shell launches a program (so a program that doesn't set its own mode doesn't inherit the previous game's graphics mode). | S | The remaining half of the "stale mode across programs" class. Weigh vs keeping a demo's final frame visible → reset on *launch*, not exit. |
| A2 | ✅ **DONE** (`6553340`) — CATALOG uses INT 16h; the bug was the whole-screen INT 10h scroll (now windowed). Arrow input was fine. | — | done |
| A3 | ✅ **DONE** (`126c901`) — was CGA graphics-mode BIOS text (INT 10h teletype over mode 4). Front-end menus render + navigate. New general feature: CGA graphics-mode character output. | — | done |
| A4 | ✅ **DONE** (`c0c925c`) — GoT reprograms PIT counter 0 to ~140 Hz for the logo; MIRAGE ignored it (18.2 Hz) → ~7.7× slow. Fixed by honouring PIT reprogramming (same fix as A6). | — | done |
| A5 | **Extended-key (E0) scancodes** for arrows/navigation (currently mapped to bare XT codes) | S | Some later games distinguish grey arrows from the numpad; low risk to add behind the physical-code map. |
| A6 | ✅ **DONE** (`c0c925c`) — not compute-bound: Dune reprograms PIT counter 0 to ~200 Hz and is timer-paced; MIRAGE ignored PIT programming (18.2 Hz) → ~11× slow. Fixed by honouring counter-0 reprogramming (`setPitReload` + `ui.js` pacing; 0x3DA beam decoupled via `pitBase`). | — | done |

## B · Game compatibility features (the big levers)

| # | Task | Effort | Why / unblocks |
|---|---|---|---|
| B1 | ✅ **DONE** (`76d0e90`) — the browser's 16 MiB buffer had no 1 MiB address wrap (headless's 1 MiB did), so EXEPACK stubs' segment arithmetic broke → "Packed file is corrupt". Fixed by wrapping real-mode addresses at 1 MiB regardless of RAM (+ A20 gate on port 0x92). **Prince of Persia renders** its VGA title; unblocks all EXEPACK'd programs in-browser. | — | done |
| B2 | **Wolf3D PML memory manager** (`PML_GetPageBuffer: Purged main block`). ⚠️ **The "blocked on compile-bound slowness" diagnosis was WRONG — retracted 2026-08-09.** Measured with `tools/d6-profile.mjs`: Wolf3D executes **749 M cycles in 6 s (~125 Mcycles/s, full engine speed)** and spends **1.0%** of that in `new Function` and 98.5% executing. The old "0.05–0.13 Mblk/s, translate-per-block dominates" reading was almost certainly taken with **tier-2 on** — the default in Node until 2026-08-09, and documented as ~5× slower on exactly this title. So B2 does **not** depend on D5/D6. Current state (`node tools/run-game.mjs WOLF3DSW WOLF3D.EXE 4000`): mode 13h + Mode-X planar, **88185** non-zero plane bytes (was 88411 until the equipment word started announcing the FPU and pointing device this machine actually has — see COMPAT.md), no fault, stable — the signon screen, unchanged over 4000 ticks. The real blocker is PML itself and needs diagnosing on its own terms, likely with the co-sim. | M |
| B3 | ✅ **DONE** (`58cc60b`, `b3e41fa`) — LIM EMS 4.0 in `src/ems.js` behind an `ems` option (XMS was already there). The subtle half is **detection**: programs open the character device `EMMXXXX0` and check bit 7 of IOCTL 4400h; **nobody reads the INT 67h vector**. Both had to be added — a device-chain entry (`vfs.addDevice`, since static `deviceOf` cannot know which drivers a machine loaded) and bit 7 for handles above 4. Wolf3D's first divergence against the reference moved from file event #7 to #155. | — | done |
| B4 | **DPMI / protected mode** — *CPU side under way, measured by test386's POST sequence: **POST 8 → 20***. Landed 2026-08-09: CS.D in the block-cache key; GDT/LDT/IDT registers with a CR0.PE that really switches; `SS.B` stack width; `LLDT`; IDT gate dispatch (286/386 interrupt and trap gates) with `IRETD`; `IRET` across a privilege change (five-element frame); `ARPL`; and **guest paging** — CR3, the directory/table walk, and a software TLB built on the biased-offset page tables (`MOV CR3` previously discarded its operand, so every linear address was used as physical). Enabling paging switches the recompiler to the `paged` memory strategy, which is why that strategy exists. Real mode is untouched throughout: golden 22/22, conformance 555764/555764 after every step. ✅ **`#PF` DONE (2026-08-22).** A not-present page THROWS a `PageFault` out of `Memory.xlat()`, and
the recompiler's run loop catches it, sets CR2, and dispatches INT 14 with the error code (bit 0
present, bit 1 write, bit 2 user). The instruction is restartable because the paged strategy emits
`cpu.eip = <ipStart>` per instruction — only under that strategy, which the machine selects exactly
when paging is on, so nothing outside protected mode pays for it. ⚠️ Restart is approximate: side
effects a faulting instruction already committed are not undone. Demand paging faults on the access
itself, which is the case that matters; a `REP MOVS` straddling a missing page is not.

Three gaps surfaced immediately, each fixed and tested:
- **The descriptor-table limit was never checked.** A selector past the GDT/LDT limit read past the
  table instead of raising #GP(selector) — 0xff50 bytes past a 0x10f-byte GDT, in the case that
  found it.
- **Exception delivery could recurse without end.** #PF → load SS from an un-LTR'd TSS → #GP →
  repeat, which reached the host as a JS stack overflow. Delivery is depth-guarded now and reports
  what is faulting (TR, GDT, CR2) instead.
- **CPL was derived from `seg[CS] & 3`.** Between `mov cr0` and the far jump that reloads CS, the
  selector register still holds the REAL-MODE value, whose low two bits mean nothing. Windows 3.0
  sits there with CS = 0x13b, so CPL read 3 and the very next instruction — a far jump to its DPL-0
  code selector — was rejected with #GP(8), one instruction into protected mode. CPL is stored now,
  as it is on real hardware (it lives in the CS descriptor cache).

Two more found by following Windows past that point:
- **A faulted selector load moved CPL anyway.** `loadDescriptor` raises and returns, and `setSeg`
  then set `_cpl = sel & 3` from the selector it had just refused — putting the machine at ring 2
  out of nowhere.
- **Self-modification bookkeeping is LINEAR, and the paged write path used the PHYSICAL address.**
  `codePage` is filled from `blk.linStart` and the block cache is keyed by linear address, so under
  paging every self-modifying write tested the wrong page and reported the wrong one. That is
  precisely what an OS relocating code does.

✅ **The 1 MB wrap under paging is FIXED (2026-08-22)** — the item this roadmap had carried as
"unmeasured, separate" since 2026-08-19. A20 gates a PHYSICAL address line and the RAM-size wrap is
physical too, so applying either BEFORE the page walk truncates the guest's address space. Windows
3.0 runs its kernel at linear 0x80201b5e; with A20 closed we masked that to **0x1b5e** and decoded
whatever sat in low memory — the block that faulted had `ip0` 0x80201b5e and `linStart` 0x1b5e, and
the `call far [ds:esi]` it decoded out of the wrong bytes is where every #GP came from. Masking is
now tied to paging being OFF, at every dispatch site and in the emitted address arithmetic (`>>>0`,
not `& 0xffffffff`, which in JS yields a signed int32 and makes every address above 2 GiB negative).

⚠️ **And the subtle half:** `run()` hoists that decision into a local **once per slice**, because it
sits on the dispatch path. Turning paging on mid-slice therefore left the REST of that slice masking
— and cached those blocks under the masked key, so they were never re-looked-up. A paging change now
ends the slice. Windows enables paging and far-jumps to its 32-bit kernel in the same slice, so this
one line is the difference between 39,634,604 exceptions and 387.

**Result:** Windows 3.0 enhanced mode loads its TSS (`TR=0x18`), takes and SERVES real demand-paging
faults (295 in a run), and raises 387 exceptions instead of 39.6 million. Still stops before the
Program Manager.

⚠️ **A sizing limit, fixed only halfway:** `codePage` now covers the whole 4 GiB linear space (1 MiB
of flags), so code above installed RAM can be marked — `markCodePage` past the end of a typed array
is silently dropped, and Windows' kernel pages could not be marked at all, so no write to them was
ever reported. `rdOfs`/`wrOfs` are still sized from installed RAM: a miss there only costs the
(correct) helper path, so this is speed and coverage, not correctness.

⚠️ **Refuted, so nobody re-checks it:** the `66` prefix decode in a 32-bit code segment is CORRECT.
`66 b8 30 00 / 66 8e d0 / f4` decodes to exactly 8 bytes in a D=1 segment, asserted in `test.js`.
The mid-instruction EIP that suggested otherwise came from a stale block, not from the decoder.

Still not done: `#DF`, task switching, VME. **Windows 3.0 enhanced mode gets past the protected-mode
entry, takes real page faults, and no longer derails into its own exception handler; it still stops
before the Program Manager.**, privilege/type checks with `#GP`, call gates, TSS task switching. **⚠️ The call-gate blocker below is CLOSED — gates are implemented in `cpu.js` `farCall`, TSS stack
switch and parameter copying included. Re-measured 2026-08-19; the blocker has MOVED, and the
paragraph after it is kept only for the descriptor-decoding lesson.**

**Current blocker (2026-08-19): control is lost right after a jump to the PAGED ALIAS.** test386
reaches POST 0x20 and then faults with `unimplemented opcode 0x0f 0xe0 at linear 0x536` — which is
not an opcode problem at all: linear 0x536 is inside the IDT (IDTR base 0x400, limit 0x177), so the
guest is executing descriptors. The access bytes there read 8e/ee/ee/e6, i.e. 386 interrupt and trap
gates. Tracing block entries backwards, the guest walks upward through memory in ~0x180 steps from
about 0xeaaa until it lands in the IDT — it was already lost long before.

The transition is exact:

    #1040  00ab:00005616  base=000f0000   last legitimate block
    #1041  00d8:e00f4f6d  base=00000000   EIP = 0xE00F4F6D
    #1042  00d8:00005029  base=00000000   lost

0xE00F0000 is test386's deliberate high alias — its own source says so: `or edi,0xE00F0000 ; Make
sure that the offset is located on a valid 32-bit mapped address by mapping the high 16 bits`. And
our paging is RIGHT for it: measured at that instant, CR0=0x80000011 (PG=1, PE=1), CR3=0x1000,
PDE[896]=0x00004003 present, PTE[244]=0x000f4003 present → physical 0x000F4F6D, where the bytes are
`66 8c c8 66 83 e0 03` = `mov eax,cs / and eax,3 / cmp eax,0` — real code, a CPL check.

**✅ POST 20 CLEARED (`78c6a6f`, 2026-08-19) — a 32-bit code segment has a 32-bit EIP.** All three
dispatch sites in `recompiler.js` opened with `cpu.eip & 0xffff`, truncating EIP whatever CS.D said
(`ipAdd` inside `translate` had been width-aware all along; only entry was not). test386 jumps to its
paged alias 0xE00F4F6D — its own source explains why — and we dispatched 0x4F6D, decoded zeroed RAM
and walked memory into the IDT, where an access-byte pair surfaced as "unimplemented opcode 0x0f
0xe0". **POST 0x20 → 0x21**, fault gone, no bench cost (tube 118.41 ms → 117.93).

**✅ VIRTUAL-8086 MODE LANDED (2026-08-22) — POST 0x20 → 0x21 → 0x22.** The whole V86 section
passes; the test now stops in a later section at POST 0x0b. What it took, each step measured by the
POST counter and located with `LST=boot/test386.lst node tools/trace386.mjs`:

1. **`EFLAGS.VM` and a real CPL.** `cpu.cpl` is 3 in V86 whatever CS says — CS there is an 8086 value
   like 0xf000 whose low two bits are 0, so every `seg[CS] & 3` privilege check read ring 0 and
   sailed through. That one idiom was the bug behind HLT, CLI/STI and IN/OUT all working in V86;
   `recompiler.js` now emits a single shared `CPL_EXPR` so a fourth site cannot forget.
2. **Segment semantics.** `setSeg` treats a V86 selector as an 8086 value (base = sel << 4, limit
   0xffff, D = 0), which is what makes CS 0xf000 land on the ROM instead of GDT index 0x1e00.
3. **`IRETD` into V86** — the only way in short of a task switch. The frame is NINE dwords: the four
   data segments ride on it because no descriptor can describe an 8086 value. `switchToRing3V86_0`
   builds exactly that (`or [esp],0x20200` sets VM and IF, `and [esp],0xF0FFF` sets IOPL 0).
4. **Interrupt exit from V86**, pushing GS/FS/DS/ES/SS/ESP/EFLAGS/CS/EIP, clearing VM *before* the
   ring-0 SS is loaded, and nulling the 8086 data segments so their `sel << 4` bases do not survive
   into the monitor.
5. **The IOPL-sensitive set** — CLI, STI, PUSHF, POPF, INT n, IRET all trap at IOPL < 3. And POPF
   may not write VM, may not write IOPL below ring 0, and may not write IF when CPL > IOPL; the old
   one-line mask wrote all three.
6. **The TSS I/O permission bitmap.** IN/OUT used to raise #GP for *every* CPL > IOPL, so a port the
   bitmap PERMITS was refused as well. Base is a word at TSS+0x66, the map runs to the TSS limit, and
   a byte past that limit denies — which is how the minimum 386 TSS (limit 0x67) gets no I/O at all.
7. **Gate targets.** From V86 an interrupt gate must land in a NON-CONFORMING DPL-0 segment;
   anything else is #GP with that selector. test386 checks both halves separately.
8. **`IRET` saves the faulting EIP**, since it can now fault.

Not done, and each its own step: `#PF`, task switching (V86 via a task gate), VME, and the
sensitive-instruction *emulation* a real monitor does. Gates after: conformance 555764/555764,
golden 36/36, test.js 130/130 (15 new), bench tube 122.9 / memories 82.1 (both faster than the
pre-change run).

**Historical, kept for the diagnosis: the blocker as it read on 2026-08-19.** Traced with `SPIN_AFTER=0x21 SPIN=2 node
tools/trace386.mjs`, the test writes POST 0x21 and immediately does:

    00005628  EE            out dx, al               ; POST 0x21
    0000562B  E8FDD5FFFF    call switchToRing3V86_0  ; <- enter V86
    00005630  CD22          int 0x22

Measured at the transition: `CS` becomes 0xf000 with **base 0x00000000**, EIP = EDX = 0x5630. In V86
a segment register is a REAL-MODE value — base must be `CS << 4` = 0xF0000 — so the transfer itself is
right and only the segment semantics are wrong: we resolve 0xf000 as a selector (GDT index 0x1e00,
far past the limit) and get base 0. The guest then walks forward through the ROM, reaches the
copyright string at f000:0004 and spins there.

`grep -n "VM\b" src/cpu.js` finds nothing: **EFLAGS.VM is not modelled at all.** What POST 0x21 needs
is the mode itself — VM set by IRETD from ring 0, segment loads that take a real-mode base, CPL
forced to 3, and INT dispatch through the IDT with the IOPL/sensitive-instruction checks that make a
V86 monitor work. That is the feature, not a patch.

⚠️ An earlier revision of this entry blamed "the 1 MB wrap applied to linear addresses under paging".
That is a real design question — `lin = (base[CS] + ip0) & this.MM` does mask before any page walk —
but it is NOT what broke POST 20: with EIP intact, (0 + 0xE00F4F6D) & 0xFFFFF is 0x0F4F6D, exactly
what the walk resolves to. Kept below as its own unmeasured item.

**Unmeasured, separate: the 1 MB wrap under paging.** Single-stepped across the transition with the runner's own A20 wiring:

    A20=false  mem.mask=0x000fffff  rec.MM=0x000fffff  csD=1  CR0=0x80000011 (PE=1, PG=1)
    step 0  00d8:e00f4f6d  linear=0xe00f4f6d  masked=0x000f4f6d  bytes 66 8c c8 66 83   <- correct code
    step 1  00d8:00004f6f  linear=0x00004f6f                     bytes 00 00 00 00 00   <- EIP truncated

`recompiler.js` computes `lin = (cpu.base[CS] + ip0) & this.MM` and lives in that masked space: it
indexes the block cache by it, fetches the bytes from it, and the executed block writes EIP back from
it. So **every linear address above 1 MB loses its high bits**, and with it EIP. The block at the
alias decodes correctly only because 0xE00F4F6D & 0xFFFFF happens to equal its physical address; the
very next instruction lands at 0x4f6f in zeroed RAM, and the guest then walks upward through memory
until it reaches the IDT.

A20 gates address line 20 of the **physical** bus. Linear addresses are not subject to it: paging
translates linear → physical and *only then* does A20 mask bit 20. Masking the linear address before
the walk — which is exactly what real mode needs and what this code was written for — is wrong the
moment PG is set.

So the fix is not a one-liner: instruction fetch has to go linear → page walk → physical, and the
block cache is keyed on the masked linear today. Test386 is the gate for it, and note that A20 is
still CLOSED at this point in the test, so the two spaces genuinely differ.

⚠️ Measured twice: the first attempt stubbed port 0x92 to a no-op in an ad-hoc harness and would have
blamed the engine for the harness. `tools/run-test386.mjs:37` is the correct wiring — it calls
`setA20` and refreshes `rec.MM`. Reproduce with that, not with a hand-rolled machine.

**The historical call-gate analysis, kept for the descriptor-decoding lesson:** POST 20 spins on a `call far 0x013b:0`. The descriptor at GDT[0x138] reads `46 2d d0 00 00 ec 00 00`, and the access byte is the whole story: **0xec = 1110 1100 → P=1, DPL=3, S=0, type=0xC**. S=0 means a SYSTEM descriptor and type 0xC is a **386 call gate**, so the fields are not base/limit but **selector 0x00d0 : offset 0x00002d46** — which is exactly the `mov esi,0xd0` / `mov edi,0x2d46` the caller loads. We treat it as a code segment and jump to its "base" 0xd0, which still holds the real-mode IVT, and execute the vector table as code. test386 confirms the intent: `defGDTDesc RING0_GATE ; placeholder for a call gate used to switch to ring 0`, then `; Test call gates now` / `jmp testCallGateWithParameters`. So a far transfer must check S/type before using a descriptor, take selector:offset from a gate, and — when the target DPL is lower — switch stacks through the TSS and copy the gate's parameter dwords across. That also supplies `switchToRing0`, whose mechanism was unidentified until now. ⚠️ An earlier revision of this entry said the blocker was "a missing copy of the routine into low memory": that was wrong, from misreading the access byte as a code segment. Three further hypotheses were tested and refuted on this symptom (virtual-8086 mode, the TSS, paging), each of which still exposed a genuine missing feature. `node tools/trace386.mjs boot/test386.bin` locates the failing assertion; `SPIN_AFTER=<post>` arms its spin detector. | L |
| B5 | ✅ **DONE (browser)** (`92e4741`) — virtual CPU clock in `ui.js` (`VCPU_HZ` ≈ 8 MHz) caps guest cycles/wall-second; 0x3DA beam derived from it stays 70 Hz. Fixed raw-CPU-speed-bound code (Keen Vorticons menus flying by). Headless keeps its deterministic timing. Tunable constant. | — | done |
| B8 | ✅ **DONE (`5768976`, 2026-08-22).** The chain is now one block per program that is loaded — every frame on the EXEC stack, oldest first, then the running program, then the free remainder — with each block's MCB header in the paragraph BELOW the PSP it describes, as the parent's already was. Before that, EXEC put the child's PSP **on** the free block's header (so the header read as the child's first opcode, signature 0xCD) and wrote no MCB for the child at all; Windows 3.0's WIN386 walks the chain and refused with *"conventional memory is fragmented"*. ⚠️ Still to verify: whether Moktar's E.Zmiro protection is satisfied by it. | — | done |
| B9 | ✅ **DONE (2026-08-22)** — it was not a SCUMM timing divergence at all. Two defects, one per side of the "browser/headless disagree" report. **(1)** `machine.tickTimer` bumped the BDA tick 0040:006C on every PIT tick, so a title that reprograms counter 0 ran the DOS clock at ITS rate — Monkey Island programs 2521 (473 Hz) — and every tick-bounded capture stopped ~16x too early. 0040:006C is a SOFTWARE counter kept by the BIOS INT 8 handler; measured on dosbox-x with `tools/tickq.asm` and its own control (unmasked "ADVANCED", IRQ0 masked "FROZEN"). Moved to `bios.js`'s INT 8 hook, which is what a guest ISR chains to — Monkey now chains 24.8:1 against its own 26:1 divider. **(2)** `tools/shot.mjs` queued KEYS but never called `pumpKeyboard`, so its documented keys argument was inert and SCUMM sat on "Press ENTER to continue…" while the browser (`ui.js`, which pumps) went past. MI1 renders its title headless; MI2's "spins in a compute loop" entry was stale and is retracted. | — | done |
| B6 | ✅ **DONE (2026-08-22).** Mode X was already IMPLEMENTED — `vga.js` detects the Sequencer's memory-mode index 4 losing bit 3 (chain-4 off in mode 13h) and routes A000 through the plane logic; `video.js` has `_renderModeX()`. What was missing is the TEST, so a regression would have surfaced as "a game looks wrong" instead of a failing gate. `test.js` now pins both halves: the memory layout (a masked write reaches one plane and no other, reads come from the read-map-selected plane, a full mask writes four, and restoring chain-4 leaves the mode) and the RENDERER's mapping back (plane p at offset o is pixel x = o%stride*4 + p). Both halves verified by mutation — disabling the chain-4 detection fails 5 assertions, changing the renderer's `x>>2` to `x>>1` fails 2. | — | done |
| B7 | **Real audio** (SB/OPL FM synthesis, currently silent stubs) | L | Detection already passes; this is actual sound output. |

## C · Content — games & demos to add and try

| # | Task | Effort | Why |
|---|---|---|---|
| C1 | ⚠️ **Moktar staged + diagnosed** — `MOKTAR.COM` EXECs `GAME.TDT` (EXEC + HLT-wake added, `fae7ec1`); the child runs but its **E.Zmiro copy protection derails** (needs B8 MCB chain or a cracked release). Blues Brothers still to try. | — | mostly done |
| C2 | **Add Baby Jo (Loriciel)** | S | Another EGA title to widen coverage. |
| C3 | ✅ **DONE (2026-08-25, `25089c5`)** — Dune renders and ANIMATES its intro in the full `DUNEDEM ENG VGA ADL HIM 386` path (Cryo logo → desert → Feyd-Rautha and the Harkonnen guards). The 2026-08-22 conclusion recorded here ("a CPU-semantics bug in Dune's decompressor, the co-sim is the tool") was **half right and cost a pass**: it *was* a decompression corruption, but the cause was in MIRAGE's interrupt path, not in instruction semantics, so the co-sim would never have caught it. `biosCallback` carried a hardware handler's arithmetic flags back through the IRET; Dune's HSQ reader crosses an instruction boundary with the carry (`shr bp,1 / jnz / rcl cx,1`), so a timer tick there shortened a match by one byte and corrupted SHAI2.SQZ from output 0x3334 on — three sprite records at height 0, and a blitter with no `jcxz` looping 65536 times. New oracle `tools/hsq.mjs`. See COMPAT.md § *Dune (Cryo) — SOLVED*. | — | done |
| C5 | **Heretic, Hexen and Quake staged (2026-08-25)** — shareware/demo releases in `games/HERETIC`, `games/HEXEN`, `games/QUAKE`. Heretic was unpacked **by MIRAGE itself**: its DEICE installer (interactive — driven through `machine.keyQueue`) then PKSFX inflating 21 files, both exit code 0. Reach: **HEXEN 38.8 Mc still running** (furthest), **DOOM** exits 0 at 0.3 Mc, **HERETIC** derails at 0.06 Mc, **QUAKE** exits 255 with "Load error: no DOS memory". **Heretic, investigated 2026-08-25 — and INT 15h AH=BF is NOT the blocker** (retracting the first reading). DOS4GW's own real-mode INT 15h hook at `cde:7273` answers exactly two private functions, `AX=BF02` and `AX=BFDC`, and chains everything else. The program asks **`AX=BFDE`** — which appears as an immediate 11 times in the image, while `BFDC` appears zero times and **no code anywhere compares against BFDE** — so nothing handles it, on a real machine either, and `CF=1` is the correct answer. Confirmed behaviourally: DOS4GW carries on through 70+ blocks of healthy code after that failure. The DPMI host is also exonerated — a `0302` call to `f000:21` with `AX=4200` returns CF=0, and `realCallReturn` is spec-correct (harvest into the RMCS, restore the client's registers verbatim, clear CF). **What is left**: the derail starts immediately after the SECOND `0302` returns, inside DOS4GW's own low-memory code at `0024:73dc → 73e1 → 73ff`, which then walks forward through zeroed memory in constant 0x180 steps. | M | Next: disassemble 0024:73dc..7400 — DOS4GW's post-real-mode-call path. |
| C4 | **Add top-rated MS-DOS demos as test candidates** | S | See the sizecoding survey below. |
| C5 | ✅ **DONE (2026-07-20):** curated `intros/` — triaged all (24/28 rendered), added **dirojed, paralaxa, warp** (32b) + **symetrie** (256b) from Řrřola, removed dead `cantorus` (exits blank), added `tools/intros-manifest.mjs`, regenerated `intros/manifest.json` (→31). Chrome Revenge skipped (`0F 38`+VESA); BootChess skipped (boot sector, not DOS). `oktaeder` stays (golden fault-fingerprint; diagnosed 2026-08-22 — it needs an ODD PSP segment and PCI config space, and the reference derails on the same instruction: see COMPAT.md); `256b` sparse but golden-pinned; `pitman` is text. | S | done |

### pouet.net sizecoding survey — top MS-DOS by thumbs-up, per size tier (captured 2026-07-20)

Source: `prodlist.php?platform[]=MS-Dos&type[]=<tier>&order=thumbup`. pouet sorts by score and
filters by platform + size class (not exact bytes). **16b and 2K returned no entries.** Tiny tiers
(≤4K) are overwhelmingly **real-mode → runnable now**; the 64k/demo tier is the DPMI wall. ✅ = we
already have it. Verify each still runs before adding (some counts/ordering from the scrape were rough).

| Tier | Top candidates (group, year) |
|---|---|
| **32b** | Dírojed (Řrřola '07), matisse (orbitaldecay '10), Projektbeschreibung (Desire '18), FOSFOR (ind '07), fr-016:bytes (Farbrausch '01), persia (orbitaldecay '10), Klappquadrat (T$ '04) |
| **64b** | Into a New Era (Desire '18) ≈ our `intoanew` ✅, Voron (fsqrt '13), fr-0.1:constant evolution (Farbrausch '03), Tar (fsqrt '13), Essence 64b (Desire '19), Asahikawa (Ribbon '07), Sierpilbrot (Řrřola '07) |
| **128b** | Wolf128 (Red Sector Inc. '14), Mayan (RSI '14), Spongy (TBC '09), Mixér (Řrřola '07) — sparse tier |
| **256b** | tube ✅, Puls ✅, memories ✅, Neon Station (Digimind '08), Symetrie (Řrřola '07), Difúze (Řrřola '10) ✅ |
| **512b** | Mirrors Within (Digimind '07), BinLaden (3Dpoison '02), BootChess (RSI '15), AFLAtoxin ('09), zud ('02), Endless Theory (ALLien Senses '06) ≈ `endless` ✅, worm (Proxium '01) ✅, Cantorus (Titan '07) ✅ |
| **1K** | paleozoa (fsqrt '12, 107👍) ✅, Chrome Revenge (Abaddon '20), BURST MODE TRANSMISSION (Trilobit '08), moodscroll (xylem '21), QBLOVE (Abaddon '20) ✅, nibble (Flare '03) ✅, Paname (RSI '14) |
| **4K** | Omniscent (Sanction '97) ⚠️back-buffer, Animate (Schwartz '95), House At The Mountains (BITS '08), Forever Reality (7dUMP '23), Pitman (Tristar '04) ✅text, StarPort BBS (Future Crew '93), Heaven (NoooN '95) ⚠️exits, Void 3 (kolor '99) ⚠️key-wait, Mesha (Rhyme '98) ⚠️HLT |
| **64k / demo (DPMI tier — later)** | Heaven Seven (Exceed), Second Reality (Future Crew, north star), Moralhardcandy (Blasphemy) |

## D · Performance (the JIT ceiling — see the perf plan)

Current state: tier-2 region compiler shipped but **browser-OFF, Node-ON** (a fused region can run
unbounded work in one runSlice and hang the tab; ~5× slower on Wolf3D — see COMPAT). Post-fusion
profile says the next levers are flags and indirect calls, not register access. Cumulative vs
baseline: tube ×3.9, lattice ×3.9, plasma ×3.5, memories ×1.66.

| # | Task | Effort | Why |
|---|---|---|---|
| D1 | **Lazy flags** (defer/compute-only-the-consumed flag via liveness) | L | ~42% of puls is live-flag helpers the dead-flag pass can't strip; general win for all branch-heavy code. Riskiest, but now gated by fuzz-flags + fuzz-region + golden + conformance. |
| D2 | **Tier-2.5 indirect-call inline cache** (memories' per-pixel `call bx`) | M–L | The memories/Dune trajectory — ~18% dispatch that region fusion can't touch. |
| D3 | **Register→locals / x87-stack→locals promotion within regions** | M | Demoted by the profile but still real for tube's x87. |
| D4 | **Web Worker + SharedArrayBuffer** (Phase 4) | L | Smoothness/unthrottling from rAF + off-main-thread; needs COOP/COEP in serve.py. NOT raw single-thread speed. |
| D5 | **Internal IR backend** (x86→IR→JS) | L | The foundation D1–D3 ultimately want; big architectural step. |
| **Memory dispatch — three strategies implemented, measured, and REJECTED; default stays `inline`** (`src/mem-strategy.js`) | `MIRAGE_MEM_READ=inline|paged|shadow`, `MIRAGE_MEM_WRITE=inline|paged`, chosen independently. All pass test/dos-api/dos-oracle; paged/paged passes conformance 555764/555764 and golden 22/22. **Run-time result on real workloads** (`tools/memsweep.sh`, medians of 3, Mcycles/s, tube / memories / Wolf3D): baseline **188.3 / 181.9 / 476.5**; paged reads −0.9/−2.3/−1.6 %; paged writes −1.2/−0.9/+1.0 %; both −1.4/−1.7/−0.5 %; **shadow reads +0.1/−0.4/+1.2 %**. Everything is noise. **Why the synthetic 2.5–4× for `shadow` evaporated:** tools/memdispatch.mjs sets `m.planar = true` so the test is meaningful, but in real workloads `m.planar` is FALSE almost always (text, mode 13h, and even EGA games touch A000 for a minority of accesses), so today's `m.planar && …` short-circuits on one falsy property load. Removing a test that already costs nothing gains nothing. **And `shadow` is not merely useless, it is incorrect**: `demos/PLANAR.COM` mismatches (21/22 golden). Not an implementation bug — the documented hole. A read loads the four latches; an unconditional array read cannot, so latches are loaded at write time from the write address. Band 2 of that test (read and write the SAME address) passes; band 4 (`mov al,[es:si]` then `mov [es:di],0` — write-mode-1 latch copy ACROSS addresses) fails, and that is the standard EGA blit, not a corner case. This is very likely why no emulator does it. Paged remains the right structure for the day there is address TRANSLATION to do (protected mode/DPMI, EMS by redirection) and wins on volume today (Turbo Pascal 10.01→8.51 MB emitted, compile 295→263 ms) — but not on speed. Kept behind flags as measured dead ends so nobody re-derives them. | done |
| D6 | **Compile-bound startup — RE-SCOPED 2026-08-09 after measuring** (`tools/d6-profile.mjs`, `tools/d6-blocks.mjs`). The original premise — "the per-block `new Function` cost dominates big-program startup" — **is false as stated**: Wolf3D spends **1.0%** of its first 6 s in `new Function` (60 ms, 1915 blocks, 0.031 ms each) and **98.5% executing**. But Turbo Pascal spends **65%** there, so the cost is real and simply does not track block *count* — it tracks emitted **source volume**: 0.6 KB/block for Wolf3D, 10.7 KB for Turbo Pascal, whose 151 biggest blocks (15.8%) are **96.6% of 10 MB** of emitted JS. Capping block length does NOT help (maxOps 192→16 moved 10.0 MB to only 9.2 MB), because the cost is per-INSTRUCTION, not per-block. Of one 68.5 KB block, **~37 KB (54%) is the inlined memory path**: `m.planar&&(a>>>N)===N?m.vga.readByte(a):u8[a]` (19.3 KB), the matching write (10.8 KB) and the SMC dirty check (6.9 KB) — i.e. Phase 1.M buys run-time speed with compile-time volume. **So the work is not a tier-0 interpreter; it is a compact emission mode for cold blocks** (memory ops as short helper calls), re-translated to today's inline form once a block is hot — same tier-0/tier-1 split, entirely inside the emitter, no second execution engine. Both forms must be semantically identical: golden + conformance are the gate. | M |
| D7 | **Event-driven timing: PIC scheduler + in-block deadline safepoints + frame-anchored beam** — port DOSBox's model (RE'd 2026-08-03, see [DEVICES.md](DEVICES.md) *Known limitation — block-granular timing*). Three parts: (a) `pic.js` (cycle,handler) scheduler with a cached `nextEventCycle` min — **prototyped 2026-08-04, golden-neutral 21/21 + conformance 100 %**; (b) **emit a deadline safepoint inside tier-1 codegen** (blocks decrement/check a budget and return, as tier-2 regions already do) — ⚠️ do **not** bound blocks by re-translating: tried, catastrophically slow (a vsync-poll loop re-JITs per crossing; one `runSlice` never completed), reverted; (c) beam phase from a per-frame anchor instead of `cpu.cycles % vgaPeriod` — **done 2026-08-09** in the browser (`machine.wallClockMs`; headless keeps the cycle-derived period, so goldens are untouched). **(d) NEW, 2026-08-09 — the browser CPU throttle has a floor, same root cause:** `ui.js` accumulates its budget in *cycles* but spends it through `runSlice(n)`, whose `n` is a **block** budget, so it cannot stop more finely than one slice (20000 blocks). On a big-block program (`tube`, ~13 cycles/block) that floor is ~270k cycles/frame ≈ **13–16 M cycles/s whatever the setting** — measured: a 3 MHz cap delivered 13.2 M/s, an 8 MHz cap 15.3 M/s. On small-block programs the cap holds (`demos/CPUSPEED.COM` at 8 MHz → 8.8 M/s). The throttle is therefore weakest on exactly the heavy programs it exists to slow, and **any setting below ~16 MHz is fiction for them** — including "match DOSBox at 3 MHz". Same fix as (b). | L | **Mutualised timing infrastructure**, not a one-demo fix: lets us lift the ~291 Hz PIT cap that throttles **Wolf3D**'s ~700 Hz sound timer, makes **Dune/GoT/Alley Cat** timing exact rather than approximate, gives the seam for a future **PIC controller** (IMR/priority/EOI) needed by sound/mouse/serial IRQs, and makes 0x3DA-polling demos exact. ⚠️ Will shift 0x3DA-polling golden fingerprints (kaneda/difze/rv256/revitro) → per-intro `dosdiff` re-bless. **Does NOT fix Heaven** — measured 2026-08-04, Heaven derails at *every* block granularity (1…192), so its derail is not a timing-granularity bug; justify D7 on the titles above, not on Heaven. |

## G · Corpus conformance against DOSBox-X (opened 2026-08-19)

⚠️ **The reference capture used to WRITE INTO THE CORPUS** (fixed 2026-08-25). `dbxlog.sh`
mounted the game directory itself, so the DOSBox run left `HIGH.MR1` in MATHRESC, `GRAWAGA.CFG`
in PREHIST and a `TP*.$$$` in TURBOPAS. Every MIRAGE run afterwards then saw a directory the
reference never saw, and the diff reported our own tooling: MATHRESC read as diverging at file
event **48** for that reason alone, **98** once the artifact was gone. It mounts a copy now.
Removing the artifacts also un-masked a real defect — PREHIST needs `GRAWAGA.CFG` and without it
takes its first-run path, where we diverge at INT 21h #21 (dbx `44`, us `35`) after 16 events
instead of 415.

`tools/dbx-oracle.mjs --sweep` compares the file / video / INT 21h event streams of all 47 games
against real DOSBox-X. **36/51 are an exact prefix** (2026-08-25), up from 20 when the tool was calibrated. See
[TESTING.md](TESTING.md) for the six normalisation traps this cost and the two environmental
differences that are *not* defects.

| # | Task | Size | Notes |
|---|---|---|---|
| G1 | ✅ **DONE (2026-08-22)** — `PSP_SEG` 0x0100 → **0x0814**, the value `tools/regs.asm` measures from dosbox-x (identical across memsize 16/32 MiB and EMS/XMS on/off); a booted FreeDOS 1.4 kernel independently puts its first program at PSP 0x1108. We were handing every program ~29 KiB of conventional memory it would not have on a real machine. **A second pass, 2026-08-22, closed part of the gap** by asking DOS for the number the binary search
actually converges on rather than reasoning about it. `tools/mem.asm` shrinks its own block and reads
AH=48h/BX=FFFF (largest free block), PSP:0002 and CS. dosbox-x answers
**`96EA / 0814 / 9FFF`**; we answered `96EC / 0814 / 0914`. Three corrections, all measured:

- **The top of conventional memory is 0x9FFF, not 0xA000.**
- **The largest free block excludes the paragraph its own MCB header takes.** Ours reported the raw
  span — one more than our own MCB chain said, so the allocator and the chain disagreed with each other.
- **PSP:0002 is written ONCE, by the loader, from the block it hands over**, and AH=4Ah does not
  revise it: dosbox-x still reports 9FFF after the program shrinks to 0x100 paragraphs. We followed
  the shrink, reasoning that a program sizing its heap from a stale number would go wrong — the
  oracle says the stale number is what DOS gives. ⚠️ For an MZ the value is its own bounded block,
  not the top of memory; writing the top there is what an A/B showed costs Indy 3 six events.

All three fields now match dosbox-x exactly.

⚠️ **The predicted payoff was still too strong.** Measured against the DOSBox oracle, the INT 21h divergence **moves later but does not vanish**: Indy 3 #22 → **#26**, Monkey Island #7554 → **#7565**, Maniac Mansion **unchanged at #20** even after the memory-accounting corrections above (DOSBox still does one more AH=48 where we do AH=49, so our free-memory SIZE differs for another reason — the environment block's own MCB is the obvious candidate, since ours sits in the gap at 0x00c0 and costs the guest nothing). The file-event channels are unchanged. Three goldens moved and were re-blessed one at a time: `mars.exe` is **pixel-identical** (internal state only), `memories.com` goes from a near-blank 3-colour screen to a structured 7-colour one — plausibly more faithful for a 256b intro that reads its entry state, but **unverified**, because `dosdiff` cannot capture it (it hooks INT 8) — and `oktaeder.com` keeps a fault fingerprint, which it always was. ⚠️ **`memories` is no longer a comparable bench workload**: its execution path changed, so its 80.8 → 105.4 ms is a different computation, not a slower engine (`tube` is unchanged at 120.3 vs 122.1). | — | done |
| G2 | ✅ **WAS A MEASUREMENT BUG, fixed 2026-08-25** — the diagnosis recorded here ("the loader leaves the EXE handle open… we must open one") was wrong. DOSBox prints an open **two ways** — `FILES:file open command <mode> file X` and `FILES:Special file open command <mode> file X`, the second carrying a full path — and the parser matched only the first, so 240 opens across the 47 logs were silently dropped from the reference. Turbo Pascal opening its own EXE therefore read as MIRAGE inventing an open. The tell was there and went unread: the file channel diverged at event **2** while the int21 channel agreed on **200** calls, which no real extra `AH=3D` could produce. Fixing the regex takes TURBOPAS from 2 matching file events to **171/265** and MATHRESC from 10 to **48/124**, with no title regressing. | — | done |
| G3 | **The unexplained titles**: HOCUS, MATHRESC, MI2, MONKEY, POP, PREHIST, SKIORDIE, UNREAL — ~~PINBALL~~ ✅, ~~MYSTIC~~ ✅ and ~~TURBOPAS~~ ✅ are out. **TURBOPAS 2026-08-25: 2 → 171 → 259 of 265 file events, and Turbo Pascal 7.1 now renders its full IDE**, in three steps: G2's parser fix; `AH=43h`, a stub that reported every path as an existing file (TP probes `TURBO.REZ`, which is absent, and real DOS says so — including the empty-name open the reference shows); and **EMS `AH=47h`/`AH=48h`**, which returned success while keeping nothing. Save → remap → restore is the universal idiom, and without the restore TP kept reading through a window pointing at a borrowed page: "Fatal error: Disk or EMS I/O failure." The A/B that found it was `ems: false`, which rendered the whole IDE. MIRAGE now emits **265 file events, exactly DOSBox's count**. ⚠️ The one remaining divergence is the temp-file name (`TP0D2FBF.$$$` vs `TP00000D.$$$`): TP derives it from the clock, and DOSBox seeds the BIOS tick from the host time of day where we start at 0 — ENVIRONMENTAL, and seeding ours would make every run non-deterministic and break the goldens. | M | MATHRESC is now closest: 48/124. |
| G6 | ✅ **DONE (`d788e26`, 2026-08-22).** A block that modifies itself AHEAD of the PC used to carry on from the bytes captured at translation time — the whole in-place-decryptor class. The guard is emitted INSIDE the branch that already fired `m._dirty` (the `/*SMCABORT*/` marker in `mem-strategy.js`), so a write to a page holding no code costs nothing: the first version put the check on the write path outright and cost `memories` 5.5 %, over the ±3 % bar; this one costs 2.2 %. **Mystic Towers went from 1 to 48/48 exact.** | — | done |
| G5 | ✅ **NO LONGER REPRODUCES (re-measured 2026-08-25)** — `TOWERS.EXE` runs **448 M cycles without exiting** and prints its title screen ("Mystic Towers Release 1.11 … Detecting system status EMS. Looking for a mouse. . . found a mouse! No joystick"), where this entry recorded an exit at 0.16 M cycles printing nothing. `dbx-oracle --sweep` also rates MYSTIC an exact prefix (48/48). ⚠️ **Not** the 2026-08-25 interrupt-flag fix: an A/B with that fix disabled is byte-identical, so the cure came from an earlier change this session (G6's SMC guard and G1's PSP/free-memory corrections are the candidates) and was never noticed. Whatever remains of the title is a rendering question, not a crash. | — | done |
| G4 | **Baby Jo's split sprite.** The head sits 14.0 px right of the body, stable over 12 samples across 17000 ticks; the reference has one coherent sprite. NOT the renderer (the language-select screen is byte-identical), not the page flip (present in both pages), not staleness (erasing it brings it back in 200 slices). A value the guest computes. | M | Next step is the co-sim, now parameterised for it. |

## E · Tooling / infra

| # | Task | Effort | Why |
|---|---|---|---|
| E1 | Fold `tools/run-game.mjs` conveniences (auto-detect main EXE, screenshot PNG) | S | Faster headless game triage. |
| E2 | Extend `fuzz-region` to far transfers / multi-segment / call-return | S–M | Closes the class of tier-2 bugs that single-segment loop fuzzing misses. |

## F · Deferred capability gaps (found while testing, #57)

| # | Task | Effort | Why / what it unblocks |
|---|---|---|---|
| F1 | **`0F 38` three-byte opcode family + VESA** (INT 10h AH=4Fh, banked/linear framebuffer, hi-res modes) | L | **Chrome Revenge** (1K, Abaddon — arguably the best DOS 1K) faults on `0F 38` and draws in VESA 640×480; both are needed to run it. VESA also unlocks later hi-res demos/games. |
| F4 | ✅ **DONE** (`video quick wins`) — INT 10h **AH=0Ch/0Dh** (write/read pixel, mode 13h + planar + CGA), **AH=10h AL=03** (blink vs bright background) and **AL=17h** (read DAC block, the mirror of the existing AL=12h); text attribute **bit 7** honoured (blink *and* bright backgrounds); **cursor** hide/shape via AH=01 + AH=03 reporting the real shape; **read mode 1** (colour compare) in `vga.readByte`; the **CRTC is reloaded on mode set** (stale offset/start used to shear the next mode); ports **0x3BA** (mirrors 0x3DA — an unregistered read of 0xFF left bit 3 stuck, hanging any "wait for retrace to end" loop), **0x3C1**, **0x3C2/0x3CC**, **0x3C7**, and a real **0x3C6** pixel mask. | — | done |
| F3 | ✅ **DONE** (`7e1e162`) — **`0x67` address-size prefix**: 32-bit ModRM grid, **SIB** (scale/index/base), disp32, 32-bit base+index, SS default for ESP/EBP bases, and moffs32 for A0-A3. v1 consumed the prefix and decoded 16-bit anyway, so the instruction stream **desynchronised** (a 0x67 instruction is 1-5 bytes longer). Was the root cause of **Heaven**'s derail; it now runs past 70 M cycles and renders its animated vortex. `test.js` gained 11 targeted cases (each asserts the decoded *length* too — the 8088 conformance vectors can't reach 386 addressing). | — | done |
| F2 | ✅ **DONE** — **boot-sector mode** (`src/boot.js`): loads the sector at `0000:7C00` and sets up the INT 19h handoff (CS:IP=0000:7C00, SS:SP=0000:7C00, DL=drive, IF set), with no PSP and no `installDOS` at all. The 55 AA signature is required unless `strict:false` — silently booting a non-bootable image would look like a MIRAGE fault rather than a bad image. `tools/run-boot.mjs` is the headless runner (`PNG=out.png` dumps the mode-13h screen); `golden.js` pins a boot workload. **BootChess** (RSi, 512b) renders identically to the author's own Bochs reference. A single-sector prod needs no INT 13h — the BIOS has already read the whole program; multi-sector boot (a DOS kernel) is the next rung and does. Note DOSBox-X hands off with SS:SP=0030:0080: only DL is architecturally meaningful, so a sector that cares sets its own stack. | — | done |
| F2b | ✅ **DONE** — **INT 13h** (`src/disk.js`): AH=00/02/03/04/08/15 over attachable sector images, CHS decoding, geometry inferred for the standard floppy formats, and 80h "not ready" for an empty drive. `demos/bootload.asm` is a two-sector image whose first sector reads the second through INT 13h and jumps into it — the shape every real bootloader has, and the rung a DOS kernel needs. Next: a real 8259 (EOI is still `() => {}`) + D7 before a kernel can boot. | — | done |
| F2c | 🟡 **half done** — **8259A** (`src/pic.js`): IRR/ISR/IMR, fixed priority, EOI, ICW init, cascade; IRQ0/IRQ1 routed through it. Golden-neutral (22/22) because the *delivery point* is unchanged. The other half is **D7**: delivering at run-loop safepoints instead of from the device. Note the `pitBase>>4` (~291 Hz) INT 8 cap may now be redundant — in-service gating is the back-pressure it was standing in for — but that is a separate experiment. | M | in progress |
| F2d | ✅ **FreeDOS 1.4 BOOTS** — real kernel on our synthetic BIOS, verified interactively: boot sector → kernel → FreeCOM 0.86 → the installer's Y/N prompt → answered N → `A:\>`. **Zero unimplemented INT vectors and zero unhandled ports for the whole boot.** My predicted blockers (CMOS/RTC on 0x70/0x71, the FDC ports, INT 1Ah AH=02/04) were all wrong — none was touched. Notably this means **D7 is NOT a prerequisite for booting a kernel**: device-driven delivery is good enough. `node tools/run-boot.mjs boot/FREEDOS14.IMG 9000000 4e,0d`. It unlocked the HLE↔kernel differential oracle, `tools/dos-oracle.mjs`. | — | done |
| F3t | ✅ **test386.asm real-mode section passes** (`tools/run-test386.mjs`) — POST 0-6. Found 15 real engine defects the other CPU gates are structurally blind to: `MOV CS,r/m` not raising #UD, `swInt` assuming it owned the F000 segment, and the entire 0x66 family of control transfers and pointer loads moving 16 bits (`E8 E9 9A EA C2 C3 CA CB FF/2 FF/3 FF/4 C4 C5 0F B2 0F B4 0F B5`). Everything past POST 6 is protected mode — nothing more to learn here until **B4**. | — | done |
| F3v | ✅ **Real VGA BIOS as an oracle** (`tools/vga-rom.mjs`) — SeaVGABIOS loads at C000:0, inits with no fault, takes INT 10h, and drives our VGA with real mode-set code. It found that our mode set left the **CRTC at zero** (we only set the offset) and GC 5/6/7 at zero — invisible to our renderer, wrong for any program that reads the CRTC back to derive geometry, which is exactly what a Mode-X setup does. `vga.js` now loads the observed tables; all six modes match the ROM register-for-register. PCI probing (0xCF8) and the VBE DISPI probe (0x1CE) did not stop it. | — | done |
