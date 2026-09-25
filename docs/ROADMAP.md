# MIRAGE — Roadmap (candidate tasks to choose from)

North star: run **Dune (Cryo)** and **Second Reality** accurately, in pure JS, "précision et
vitesse". This is a menu, not a plan — pick what's next. Effort: **S** ≤ half a session, **M** ≈
one focused session, **L** = multi-session. Each notes what it unblocks. See [COMPAT.md](COMPAT.md)
for current status and [ARCHITECTURE.md](ARCHITECTURE.md)/[RECOMPILER.md](RECOMPILER.md) for how.

## H · v86 image catalogue & independent BIOS oracles — ⭐ CURRENT FRONT (updated 2026-09-25)

Images live in `boot/v86/` (gitignored), fetched from `https://i.copy.sh/`. MIRAGE's disk is INT 13h
only, so BIOS-disk systems are in reach; IDE/ATAPI/CD-only systems are not.

**Oracle rule.** QEMU, v86 and `tools/vga-rom.mjs` all run SeaBIOS/SeaVGABIOS: ONE lineage, not three.
DOSBox-X is the second (HLE BIOS). Where the lineages AGREE, that is the portable contract and MIRAGE
follows it; where they DISAGREE it is a vendor choice, documented, and MIRAGE keeps SeaBIOS unless a
program depends on the other. RBIL (delorie mirror; ctyme refuses connections) is the documentary
check. The THIRD lineage is a vendor ROM: the Cirrus CL-GD5446 VGA BIOS 1.25 (Cirrus Logic + Quadtel)
on QEMU (H1). `tools/int10gfx.asm` is the probe (boot sector on QEMU/MIRAGE/Cirrus, `-DCOM` on
DOSBox-X, all on COM1; `tools/v86/i10all.sh` + `tools/v86/cirrusboot.mjs`). **Cirrus = DOSBox-X on
every line** but the GC index after AH=06h (Cirrus 1Eh, an extended register; DOSBox-X 01h). So on
the two points SeaBIOS and DOSBox-X disputed, both lineages independent of SeaBIOS agree against it,
and MIRAGE now follows them: (T5/T8) the read map is left as the program set it — SeaBIOS resets it
to 0; (T7/T10) AH=00h returns AL UNCHANGED for every mode, bit 7 included — SeaBIOS's 30h/3Fh/20h is
the Phoenix/AMI convention (RBIL). GC index 01h after a glyph (both agree), 04h after a scroll (they
disagree → SeaBIOS kept). MIRAGE = Cirrus except that one byte.

| # | Task | Effort | State / next step |
|---|---|---|---|
| H1 | ✅ **DONE — third BIOS lineage: real Cirrus VGA ROM on QEMU** | — | `boot/roms/5446bv.vbi` from GitHub `86Box/roms` `video/cirruslogic/` (never committed; QEMU's own `vgabios-cirrus.bin` is SeaVGABIOS). `-device cirrus-vga,romfile=`: the ROM is at C0000 byte for byte, INT 10h → C000:3620, and the banner "CL-GD5436/46 PCI VGA BIOS Version 1.25" is on screen ~73 ms after power-on, before SeaBIOS's own mode 3 clears it (positive control). Arbitration above. Golden re-blessed for the four intros that read AX after `int 10h` (intoanew, kaneda, memories, omniscent): intoanew vs DOSBox-X at 60 ticks 17.7% → 73.2%. kaneda (palette entry 0 black in DOSBox-X, AL-coloured here: likely `shrd` with count > 16) and memories (`mov dl,45h` assumes DH=01, i.e. a PSP below 0200h as in DOSBox; ours is 0814h, so its INT 1Ch handler lands at 0845h) are broken either way — separate defects. The same ROM also initialises INSIDE MIRAGE via `tools/vga-rom.mjs`, mode 13h register-identical. |
| H2 | **Boot images vs DOSBox-X** (pillman, invaders, bootdino, floppybird, hello-v86, bootlogo) | S | Ready, never run: `bootcom.asm` loads sector 1 via DOSBox-X's own INT 13h and jumps to 7C00 with the resident grabber underneath (`-DCGA` for bootlogo). Vs QEMU they already match up to animation timing (hello-v86 0 px, bootlogo 3 px). |
| H3 | **xcom144: HDPMI32 client derails** at `00af:2b915` in zeros | M | XCOM486.EXE = DJGPP go32 stub + COFF **packed with UPX 3.91**; the code at the derail is what the decompressor should have produced. QEMU at 45 s: same CS 00AF base 111000 but limit `006bffff` (MIRAGE `0046ffff`). Next: dump the linear range under QEMU with paging ON (`memsave` gives nothing when a chunk is unmapped and meaningless in real mode — retry `stop` until CR0.PG and CS=00AF), same in MIRAGE, first differing byte → decompressor or loader defect. No x86 host available (arm64 Mac): KVM real-silicon oracle is out. |
| H4 | **Catalogue lots 3/4**: ELKS (elks-hd32-fat.img), GentleOS/16, T3XFORTH, PC-MOS/386, KolibriOS | M | Not fetched yet. Triage with v86triage vs qemucap. |
| H5 | AH=11h AL=24h row specifier (BL=03 → 43 rows?) | S | stillalive-os calls it; screen matches without it. Check what the references put in 0040:0084 after it. |
| H6 | Font: SeaVGABIOS draws 'm'/'M' 8 px wide, our ROM font 7 | S | Only residual Still Alive difference vs QEMU. Which font is the IBM one? Decide per target, not a bug. |

Done in this front: PS/2 mouse, EMM386 (V86 defects), DOOF, IBM tutorial (INT 1Ch register save),
chained INT 8→1Ch, IRQ0/1 through the IDT in PM/V86, BIOS INT 9 clears OBF, three INT 10h graphics
defects (`3d9f243`), mode 6Ah + planar BIOS text + SeaBIOS map-mask side effect (`33f072e`, Still
Alive = QEMU up to the font; its mode 0 is the song's END, confirmed by QEMU at 330 s), BDA geometry +
index readback (`08fd1fb`). pitman.com = DOSBox-X in all 2000 cells.

**Front tools — `tools/v86/`** (repo-relative paths; images read from `boot/v86/`, scratch output in
`/tmp`): `v86triage.mjs` (MIRAGE: stop reason, mode, text/PNG incl. 800x600 planar), `qemucap.mjs`
(QEMU: BDA mode, B800 via `pmemsave … "file"` — quoted filename — and screendump), `serialboot.mjs`
(MIRAGE: COM1 output of a boot image), `textdiff.mjs` (text page of a .COM, DOSBox-X vs MIRAGE, via
`grabber.asm -DTEXT`), `bootdiff.mjs` + `bootcom.asm` (H2), `qxmem.mjs` (H3), `fat12.py` (list or
extract a file from a FAT12 floppy — no mtools here), `i10all.sh` (int10gfx.asm on QEMU, DOSBox-X and
MIRAGE). Re-checked after the move: i10all MIRAGE = QEMU byte for byte, textdiff pitman.com 0/2000.
⚠️ `bootdiff.mjs` gets **no DOSBox-X capture** (0 bytes, hello-v86, same with the pre-move copy): the
grabber never writes OUT.BIN once the boot program has taken over — that is where H2 starts.

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
| B2 | ✅ **DONE — and the diagnosis in this task was a misattribution (closed 2026-09-09).** Wolf3D runs: signon screen, attract loop, High Scores, gameplay. `PML_GetPageBuffer: Purged main block` was never a memory-manager defect — the root cause was **`FISTP m64` unimplemented in `src/fpu.js`** (`cd4e501`). The x87 store silently did nothing, the stack drifted, and the damage surfaced as a purge inside PML, then as a smashed stack, then as a corrupt CS — three symptoms that each got blamed in turn. Worth keeping as a lesson: **the component that reports the error is not the component that is wrong**, and an unimplemented instruction that fails SILENTLY produces symptoms arbitrarily far from itself. `tools/survey-gaps.mjs` now censuses unimplemented x87 encodings (`cpu.fpuMisses`) so this class is found by inventory rather than by chasing symptoms. | M | done |
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

| D8 | **Tier 2 is written, works, and is switched off for a reason that no longer holds.** The gating comment says `intros/memories.com` "takes >300s for work tier-1 does in 8.5ms" — stale: regions now decrement the shared `cpu.tbudget` once per internal iteration and memories completes normally. Re-measured 2026-09-03 with `MIRAGE_TIER2=1`: **tube +12 %, chaosequ +31 %, puls +42 %, memories −6 %**, block executions collapsing (puls 4.0 M → 0.15 M). Region fusion is exactly the right shape for a 4K intro's handful of tiny loops. **mesha is now diagnosed and is NOT a correctness defect** ([TIMING.md](TIMING.md) §14/§14c): bisecting the promotion order isolates region root `0xa13d`, the region is entered with byte-identical registers, the first three timer services fire on the *same cycle*, and cumulative delivery lateness moves +0.1 % with a worst case one cycle **better** than tier 1. Only the off-screen A000 residue moves — B800, the DAC and the mode are identical, and mesha ends in text mode 3. It cannot be adjudicated against DOSBox because it takes INT 8 as a **DPMI protected-mode client**, which `grabber.asm` (a real-mode TSR) can never see. **What is still unretested is the half that decides this**: the game defects in the gating comment — Wolf3D ~5× slower, Keen's far-indirect derail, Cosmo's unbounded region — none re-measured since regions gained the `cpu.tbudget` safepoint. | M | The single biggest measured win available, and the code already exists. |
| D9 | **Byte-granular code coverage for the write barrier.** §12(b)/§13: `invalidate()` cost 9.4 % of tube while evicting **nothing** — 3 030 236 calls per 20 ticks, 0 invalidations. Flat typed-array bounds (shipped `8513a60`) took tube +4.3 % and memories +9.5 % and dropped `invalidate` to 7.3 %, but the residual is the barrier being **called** at all: `cp[]` is per 4 KiB page and tube keeps its pixel buffer *inside its own code page*, so the page-level test emitted into the store path cannot say no. DOSBox's `write_map` is per **BYTE** — §11 dismissed it as "not the lever" for Chrome Revenge (true: that one really does write its own instructions) and that is wrong for tube, where it is exactly the lever. Byte- or 16-byte-granular coverage would let the *emitted* test reject all three million writes with no call. Touches the emitted store path (`mem-strategy.js`), so: golden + conformance as the gate, and the emission-volume cost measured (D6 says the inlined memory path is already 54 % of a big block). | M | Removes the last engine overhead visible on the ordinary profile. |

## C · Content — games & demos to add and try

| # | Task | Effort | Why |
|---|---|---|---|
| C1 | ⚠️ **Moktar staged + diagnosed** — `MOKTAR.COM` EXECs `GAME.TDT` (EXEC + HLT-wake added, `fae7ec1`); the child runs but its **E.Zmiro copy protection derails** (needs B8 MCB chain or a cracked release). Blues Brothers still to try. | — | mostly done |
| C2 | **Add Baby Jo (Loriciel)** | S | Another EGA title to widen coverage. |
| C3 | ✅ **DONE (2026-08-25, `25089c5`)** — Dune renders and ANIMATES its intro in the full `DUNEDEM ENG VGA ADL HIM 386` path (Cryo logo → desert → Feyd-Rautha and the Harkonnen guards). The 2026-08-22 conclusion recorded here ("a CPU-semantics bug in Dune's decompressor, the co-sim is the tool") was **half right and cost a pass**: it *was* a decompression corruption, but the cause was in MIRAGE's interrupt path, not in instruction semantics, so the co-sim would never have caught it. `biosCallback` carried a hardware handler's arithmetic flags back through the IRET; Dune's HSQ reader crosses an instruction boundary with the carry (`shr bp,1 / jnz / rcl cx,1`), so a timer tick there shortened a match by one byte and corrupted SHAI2.SQZ from output 0x3334 on — three sprite records at height 0, and a blitter with no `jcxz` looping 65536 times. New oracle `tools/hsq.mjs`. See COMPAT.md § *Dune (Cryo) — SOLVED*. | — | done |
| C5 | **Heretic, Hexen and Quake staged — and the three DOS4GW titles unblocked (2026-08-25)**. Shareware/demo releases in `games/HERETIC`, `games/HEXEN`, `games/QUAKE`; Heretic was unpacked **by MIRAGE itself** (DEICE's interactive installer driven through `machine.keyQueue`, then PKSFX inflating 21 files, both exit code 0). **What changed everything was making a null selector in CS/SS fault** (`ce9f953`): DOS4GW then takes its own exception path instead of running with CS base 0. Measured before → after: **DOOM exits 0 at 0.3 Mc → 240 Mc still running; HERETIC derails at 0.06 Mc → 1028 Mc still running; HEXEN 38.8 Mc → 1021 Mc**. Attributed by A/B — reverting the PSP:000A fix changes none of those numbers, and Heretic still derailed with that fix alone. All three sit in mode 0x1 with an empty A000, so the next question is what they are doing for a billion cycles without reaching a video mode. **QUAKE is unaffected** and still exits 255 on "Load error: no DOS memory" — a message printed from a path its AH=48h never reaches, so the text is not the cause. **The loop, surveyed before naming anything (2026-08-25).** Over 399 Mc Heretic makes **1 745 566 INT 31h calls, of which 1 745 192 are `AX=0302`** — and every one of them targets the SAME real-mode routine, `cde:7273`, with `AX=BFDE`, in two alternating variants (`BX=0x0A`, `BX=0x15`), all returning `CF=1`. No ports are read at all. The caller is DOS4GW's **mode-switch path** — `out 0x70/0x71` on CMOS index 0x0F, the shutdown byte used for real↔protected transitions — and `AX=BFxx` is the private API of an EMM386/QEMM-class memory manager, which is absent here, so the failure is correct (as `BF02` was). A false suspect was eliminated: `0024:1df7`, hot at 1.5 M, is a BOUNDED 8-slot scan. Not a probe artifact either — the production path (`timerAuto`, no manual `tickTimer`) gives the same numbers. **Open: what re-enters the mode-switch path forever.** That is a different question from why the call fails; the failure is normal, the repetition is not. | M | Next: find the re-entry — hot blocks 005c:0054 and 005c:0400 are above it in the protected-mode code. |
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
| **1K** | paleozoa (fsqrt '12, 107👍) ✅, **Chrome Revenge (Abaddon '20) ✅ renders** (SSE + VESA, see F1), BURST MODE TRANSMISSION (Trilobit '08), moodscroll (xylem '21), QBLOVE (Abaddon '20) ✅, nibble (Flare '03) ✅, Paname (RSI '14) |
| **4K** | ⭐ **swept in full 2026-08-28 — 9 of the top 10 render** (see COMPAT). ✅ Omniscent (Sanction '97), Animate (Schwartz '95), Pitman (Tristar '04, TEXT mode), Forever Reality (7dUMP '23), StarPort BBS 2 (Future Crew '93, EGA 0Dh), Heaven (NoooN '95), Juggler 2001 (CoExistence '01, asks for a MIDI port first), Another Soul Lost (Traction '03), Mesha (Rhyme '98 — fixed here). ❌ **Void 3** (kolor '99): needs VESA, see F1. |
| **64k / demo (DPMI tier — later)** | Heaven Seven (Exceed), Second Reality (Future Crew, north star), Moralhardcandy (Blasphemy) |

## D · Performance (the JIT ceiling — see the perf plan)

Current state: the tier-2 region compiler is **OFF everywhere**, opt-in via `MIRAGE_TIER2=1` — see D8,
which re-measured it. Cumulative vs baseline: tube ×3.9, lattice ×3.9, plasma ×3.5, memories ×1.66.

⭐ **Profiled for the first time on NORMAL workloads, 2026-09-03 ([TIMING.md](TIMING.md) §12).** Every
earlier perf measurement was on `crevenge`, a self-modifying pathology. Warmed up so nothing compiles,
four steady-state intros spend **19.9–37.9 % in the dispatch loop**, 41–65 % in emitted block code, and
~0 in `translate`. The reason is the shape of the programs: **4 to 28 distinct blocks** of **4.6–11.5
instructions**, whose successor is the same one **66–100 %** of the time, re-dispatched 15 M times a
second. That reading is what D8 and D9 come from, and it demotes D1/D3 — the emitted code is the part
doing the guest's work.

| # | Task | Effort | Why |
|---|---|---|---|
| D1 | **Lazy flags** (defer/compute-only-the-consumed flag via liveness) | L | ~42% of puls is live-flag helpers the dead-flag pass can't strip; general win for all branch-heavy code. Riskiest, but now gated by fuzz-flags + fuzz-region + golden + conformance. |
| D2 | **Tier-2.5 indirect-call inline cache** (memories' per-pixel `call bx`) | M–L | The memories/Dune trajectory — ~18% dispatch that region fusion can't touch. |
| D3 | **Register→locals / x87-stack→locals promotion within regions** | M | Demoted by the profile but still real for tube's x87. |
| D4 | **Web Worker + SharedArrayBuffer** (Phase 4) | L | Smoothness/unthrottling from rAF + off-main-thread; needs COOP/COEP in serve.py. NOT raw single-thread speed. |
| D5 | **Internal IR backend** (x86→IR→JS) | L | The foundation D1–D3 ultimately want; big architectural step. |
| **Memory dispatch — three strategies implemented, measured, and REJECTED; default stays `inline`** (`src/mem-strategy.js`) | `MIRAGE_MEM_READ=inline|paged|shadow`, `MIRAGE_MEM_WRITE=inline|paged`, chosen independently. All pass test/dos-api/dos-oracle; paged/paged passes conformance 555764/555764 and golden 22/22. **Run-time result on real workloads** (`tools/memsweep.sh`, medians of 3, Mcycles/s, tube / memories / Wolf3D): baseline **188.3 / 181.9 / 476.5**; paged reads −0.9/−2.3/−1.6 %; paged writes −1.2/−0.9/+1.0 %; both −1.4/−1.7/−0.5 %; **shadow reads +0.1/−0.4/+1.2 %**. Everything is noise. **Why the synthetic 2.5–4× for `shadow` evaporated:** tools/memdispatch.mjs sets `m.planar = true` so the test is meaningful, but in real workloads `m.planar` is FALSE almost always (text, mode 13h, and even EGA games touch A000 for a minority of accesses), so today's `m.planar && …` short-circuits on one falsy property load. Removing a test that already costs nothing gains nothing. **And `shadow` is not merely useless, it is incorrect**: `demos/PLANAR.COM` mismatches (21/22 golden). Not an implementation bug — the documented hole. A read loads the four latches; an unconditional array read cannot, so latches are loaded at write time from the write address. Band 2 of that test (read and write the SAME address) passes; band 4 (`mov al,[es:si]` then `mov [es:di],0` — write-mode-1 latch copy ACROSS addresses) fails, and that is the standard EGA blit, not a corner case. This is very likely why no emulator does it. Paged remains the right structure for the day there is address TRANSLATION to do (protected mode/DPMI, EMS by redirection) and wins on volume today (Turbo Pascal 10.01→8.51 MB emitted, compile 295→263 ms) — but not on speed. Kept behind flags as measured dead ends so nobody re-derives them. | done |
| D6 | **Compile-bound startup — RE-SCOPED 2026-08-09 after measuring** (`tools/d6-profile.mjs`, `tools/d6-blocks.mjs`). The original premise — "the per-block `new Function` cost dominates big-program startup" — **is false as stated**: Wolf3D spends **1.0%** of its first 6 s in `new Function` (60 ms, 1915 blocks, 0.031 ms each) and **98.5% executing**. But Turbo Pascal spends **65%** there, so the cost is real and simply does not track block *count* — it tracks emitted **source volume**: 0.6 KB/block for Wolf3D, 10.7 KB for Turbo Pascal, whose 151 biggest blocks (15.8%) are **96.6% of 10 MB** of emitted JS. Capping block length does NOT help (maxOps 192→16 moved 10.0 MB to only 9.2 MB), because the cost is per-INSTRUCTION, not per-block. Of one 68.5 KB block, **~37 KB (54%) is the inlined memory path**: `m.planar&&(a>>>N)===N?m.vga.readByte(a):u8[a]` (19.3 KB), the matching write (10.8 KB) and the SMC dirty check (6.9 KB) — i.e. Phase 1.M buys run-time speed with compile-time volume. **So the work is not a tier-0 interpreter; it is a compact emission mode for cold blocks** (memory ops as short helper calls), re-translated to today's inline form once a block is hot — same tier-0/tier-1 split, entirely inside the emitter, no second execution engine. Both forms must be semantically identical: golden + conformance are the gate. | M | ⭐ **First compile-bound workload found, 2026-09-02 (TIMING.md §9): `intros/crevenge.com` with the INT 8 cap lifted.** 83% of its wall clock is inside `translate()` — 232083 translations emitting 159.5 MB of JS in ten ticks — and throughput collapses from 51.2 MIPS to 3.35. Cause: its ISR is genuinely self-modifying (a 1 KB intro keeps counters in immediate fields at 0x857B and 0x8584, inside its own instruction stream), so every timer interrupt evicts and recompiles two blocks. Invalidation is byte-precise and correct; content-keyed caching would not help, because the hot block cycles through 93858 distinct byte-contents. The fix is to stop SPECIALISING the written bytes — re-emit an SMC-hot block reading that immediate from memory at run time — or an interpreter tier, which is what DOSBox falls back to.
| D7 | ⚠️ **RE-SCOPED 2026-08-28 after measuring — see [TIMING.md](TIMING.md). Parts (a) and (b) are NOT justified: delivery lateness measures p50 = 1 cycle on a 6000-65000 cycle period and exceeds one period in 0.01% of ticks, because blocks average 2-3 instructions rather than the 192 the cap allows. The INT 8 rate cap, the one real pain, is a SPEED problem and not a scheduler one: 256x the deliveries cost +8% wall clock with no guest ISR installed, so the 33x Chrome Revenge pays is its own ISR running 60x more often. Part (c), the frame-anchored beam, survives but its stated justification (jitter) is also ~1 cycle, so it needs its own measurement first. **Beam measured 2026-09-02 (TIMING.md §4-6): the retrace DUTY is 18x too wide (8% where the CRTC says 0.45%) and does not track the mode; the fix is written behind `MIRAGE_BEAM=crtc`. The PERIOD is internally consistent, but a guest gets 2.79x less work per frame here than in the DOSBox config we diff against — measured with the same binary on both sides, 0x10A5 vs 0x2E60 — and `MIRAGE_PITRELOAD=182584` reproduces DOSBox's count exactly. That ratio, not the duty cycle, is what made the fix kill freality: calibrated, freality runs its whole show under the CRTC beam. So the blocker is now a MACHINE-SPEED decision (20 of 43 goldens move with it), not a timing-model one.** Original plan: **Event-driven timing: PIC scheduler + in-block deadline safepoints + frame-anchored beam** — port DOSBox's model (RE'd 2026-08-03, see [DEVICES.md](DEVICES.md) *Known limitation — block-granular timing*). Three parts: (a) `pic.js` (cycle,handler) scheduler with a cached `nextEventCycle` min — **prototyped 2026-08-04, golden-neutral 21/21 + conformance 100 %**; (b) **emit a deadline safepoint inside tier-1 codegen** (blocks decrement/check a budget and return, as tier-2 regions already do) — ⚠️ do **not** bound blocks by re-translating: tried, catastrophically slow (a vsync-poll loop re-JITs per crossing; one `runSlice` never completed), reverted; (c) beam phase from a per-frame anchor instead of `cpu.cycles % vgaPeriod` — **done 2026-08-09** in the browser (`machine.wallClockMs`; headless keeps the cycle-derived period, so goldens are untouched). **(d) NEW, 2026-08-09 — the browser CPU throttle has a floor, same root cause:** `ui.js` accumulates its budget in *cycles* but spends it through `runSlice(n)`, whose `n` is a **block** budget, so it cannot stop more finely than one slice (20000 blocks). On a big-block program (`tube`, ~13 cycles/block) that floor is ~270k cycles/frame ≈ **13–16 M cycles/s whatever the setting** — measured: a 3 MHz cap delivered 13.2 M/s, an 8 MHz cap 15.3 M/s. On small-block programs the cap holds (`demos/CPUSPEED.COM` at 8 MHz → 8.8 M/s). The throttle is therefore weakest on exactly the heavy programs it exists to slow, and **any setting below ~16 MHz is fiction for them** — including "match DOSBox at 3 MHz". Same fix as (b). | L | **Mutualised timing infrastructure**, not a one-demo fix: lets us lift the ~291 Hz PIT cap that throttles **Wolf3D**'s ~700 Hz sound timer, makes **Dune/GoT/Alley Cat** timing exact rather than approximate, gives the seam for a future **PIC controller** (IMR/priority/EOI) needed by sound/mouse/serial IRQs, and makes 0x3DA-polling demos exact. ⚠️ Will shift 0x3DA-polling golden fingerprints (kaneda/difze/rv256/revitro) → per-intro `dosdiff` re-bless. **Does NOT fix Heaven** — measured 2026-08-04, Heaven derails at *every* block granularity (1…192), so its derail is not a timing-granularity bug; justify D7 on the titles above, not on Heaven. |

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
against real DOSBox-X. **38/54 are an exact prefix** (2026-08-25, the corpus having grown by Heretic/Hexen/Quake), up from 20 when the tool was calibrated. See
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
| G8 | **Heretic faults on the raw-XMS path** (opened 2026-09-10). `MIRAGE_NODPMI=1 SHOT_BLOCKS=60000000 node tools/shot.mjs HERETIC HERETIC.EXE 999999 out.png '' 1c,9c` reproduces it in one command: the bound DOS/4G brings up protected mode itself (`PE:1 PG:0`) and then prints its own register dump, `ID 0D` (#GP) at `70:0000116D`, `COD 5340`. **Doom, the same extender, plays on this path**, so it is not the path as such. Narrowed, and the reported fault is a CONSEQUENCE: two #GPs occur, `#GP(0x0C5C)` at `0180:0019d37e` (TI=1, an LDT selector, while `LDTR=0`) FIRST, then the reported `#GP(0x5340)`. The second faults on `mov es,[0x0c2e]` — and a watch on that address shows **nothing ever writes it**: `0x5341` is pre-existing content of DOS's own data area, and 0x5341 with the RPL bits replaced by EXT/IDT/TI is exactly the `0x5340` error code. The instruction reads linear 0xC2E because **DS holds the flat selector 0x188**, not a DOS/4G data selector — DOS/4G's own image starts at linear 0x8140 (PSP 0x814), so 0xC2E is not its data. So the question is what left DS flat in 16-bit code, or whether #1 is legitimate. ⚠️ Two measurement notes for whoever picks this up: `protInt` receives **no `faultIp`** on this path, so an IP read there is a BLOCK START, not the faulting instruction (it coincides for #2 and does not for #1); and a probe without `pumpKeyboard` does not reproduce the crash at all — it saw zero #GP in the same 60 M blocks. **Two follow-up hypotheses were measured and BOTH died** (2026-09-10), so nobody re-runs them: (a) *"we execute with CS = an LDT selector while LDTR is null"* — false, `LDTR = 0x0068`; the probe that said 0 was reading `cpu.ldtrSel`, a field that does not exist. (b) *"`ldtr` and `gdtr` are the same object, so the LDTR silently follows every LGDT"* — false, `ldtr !== gdtr`, and a census of all 10765 LLDT calls shows **DOS/4G's own LDT descriptor** reads `ff 3f 10 40 10 82 00 00`: base 0x104010, limit 0x3FFF, i.e. it deliberately aliases its LDT onto its GDT's memory. We read it correctly. Selector 0x0C5C is index 395, comfortably inside that limit, so the first #GP is not a table-bounds failure either. The block path is `0c5d:1fb3` (looping) -> `0070:1120` -> `0070:115f` -> fault. ⭐ **Diagnosability fixed (`82d42f7`), and it named the instruction immediately**: the fault is `POP ES` at `0180:0019d39c`, in a routine that does `push es` on entry and `pop es` on exit at matching widths. **The value being restored is a REAL-MODE PARAGRAPH.** Measured: while `CS = 0x0C5D` the CS base is `0x0000C5D0`, i.e. `0x0C5D << 4` — so that loop is real-mode code and 0x0C5D is a paragraph, not a selector. Loading it as a selector is exactly `#GP(0x0C5C)` once the RPL bits are replaced. So ES carries a real-mode segment into protected-mode code, and the `pop es` is where it surfaces — the same class as the DPMI "stop loading a paragraph as a selector" fix (`82b477f`). ⚠️ **Three readings died on the way, all from resemblance, so do not redo them**: the LDT descriptor at index 395 is all zeros but **nothing ever writes it** (watched: 0 changes in the whole run) — it was never built, so "something clears it mid-routine" is wrong; `LDTR` is `0x0068`, not 0 (a probe read a field that does not exist); and `ldtr !== gdtr` — DOS/4G's own descriptor aliases its LDT onto its GDT. Note too that `recentBlocks` prints raw `cpu.seg[CS]`, which spans mode changes: reading every value in that path as a selector is what produced two of these. **Three POP sites converted (`7bae309`, `8e8752d`, `e7b54b6`) — Heretic is BYTE-IDENTICAL afterwards**, so that was correctness work and not the fix; do not read those commits as progress on this task. They do narrow it, though: fault #1 still reports a BLOCK START, and `_segIp` now names a different site, so **the faulting instruction is outside the converted set** — not POP ES/DS/SS and not MOV Sreg. What remains unconverted: LES/LDS (diagnostic only, they do not set `cpu.eip`), LSS/LFS/LGS (not converted at all — they need `ipStart` threaded into the 0F handler), and the far transfer / RETF / IRET paths, which are the likeliest candidates for a 32-bit flat routine loading a real-mode paragraph. | M | open |
| G3 | **The unexplained titles**: HOCUS, MATHRESC, MI2, MONKEY, POP, SKIORDIE, UNREAL — ~~PINBALL~~ ✅, ~~MYSTIC~~ ✅, ~~TURBOPAS~~ ✅ and ~~PREHIST~~ ✅ are out. **PREHIST was never a defect (2026-08-25)**: its reference log had been captured on a directory a PREVIOUS capture had polluted, so DOSBox opened a `GRAWAGA.CFG` that a first run does not have. Re-captured against the pristine copy `dbxlog.sh` now mounts, it is an **exact match — 16/16 file, 5/5 video, 26/26 int21**. Our behaviour had been right all along; the reference was a second run. ⚠️ **Worth doing for the whole corpus**: any title whose own capture writes a file has a reference that may describe a second run, and only re-capturing tells you. **MATHRESC re-captured too** and is a REAL divergence: 127 events both sides, diverging at file #98 where DOSBox walks 156-byte records at 128 / 284 / 440 and we jump to 882 and load a resource from there. The bytes read are identical, so the game CHOOSES differently; not clock-driven either — three different starting tick values give the identical seek sequence. | M | **MATHRESC re-diagnosed 2026-08-25: not a lookup bug, an ORDER difference.** Both sides read the same three 156-byte directory records (128 / 284 / 440), decode them identically, and load the same two resources — `CREDITS.MR` at 882 and `HELP.MR` at 232409, each with the characteristic seek-seek-read 20000. DOSBox loads HELP then CREDITS; we load CREDITS then HELP. The directory scan is correct on both sides, so this is the game's state machine reaching the two loads in a different order, not a wrong record or a bad string compare. Not clock-driven either (three starting tick values, identical seek sequence). Next: find what selects between the two — it is a branch in the game, not a service we answer wrongly. |
| G6 | ✅ **DONE (`d788e26`, 2026-08-22).** A block that modifies itself AHEAD of the PC used to carry on from the bytes captured at translation time — the whole in-place-decryptor class. The guard is emitted INSIDE the branch that already fired `m._dirty` (the `/*SMCABORT*/` marker in `mem-strategy.js`), so a write to a page holding no code costs nothing: the first version put the check on the write path outright and cost `memories` 5.5 %, over the ±3 % bar; this one costs 2.2 %. **Mystic Towers went from 1 to 48/48 exact.** | — | done |
| G5 | ✅ **NO LONGER REPRODUCES (re-measured 2026-08-25)** — `TOWERS.EXE` runs **448 M cycles without exiting** and prints its title screen ("Mystic Towers Release 1.11 … Detecting system status EMS. Looking for a mouse. . . found a mouse! No joystick"), where this entry recorded an exit at 0.16 M cycles printing nothing. `dbx-oracle --sweep` also rates MYSTIC an exact prefix (48/48). ⚠️ **Not** the 2026-08-25 interrupt-flag fix: an A/B with that fix disabled is byte-identical, so the cure came from an earlier change this session (G6's SMC guard and G1's PSP/free-memory corrections are the candidates) and was never noticed. Whatever remains of the title is a rendering question, not a crash. | — | done |
| G7 | **Quake, pixel-for-pixel against DOSBox-X** (opened 2026-09-07, proposed by the PRISM session). Same binary, same data, same args — so what is measured is this emulator and nothing else. Stop on the **Nth call to `R_RenderView`** (N=200), not on a presented frame and not on a block budget: one call = one world frame, so the number of console screens drawn first stops mattering. Args `-nosound -nocdaudio +host_framerate 0.05 +con_notifytime 0`. ⚠️ **`+host_framerate` is not enough.** `host.c:643` calls `rand()` once per main-loop iteration, *before* `Host_FilterTime` decides whether the iteration simulates anything (id's comment: "keep the random time dependent"), so the PRNG advances per LOOP, and the loop count depends on host clock speed. PRISM measured its DOS build at 3061 loops when X11 was at 90 world frames — 289 of 64000 pixels differ at frame 200, every one of them placed by `rand()`. PRISM neutralises it by replacing `Sys_FloatTime`; we cannot replace a function but we are the hardware, so the equivalent is to step the BDA tick and the PIT counter by a **fixed 1/72 s per latch** instead of indexing them on real time — which also makes our own captures reproducible. Without this the diff is red with particles and says nothing. **The reference images are regenerated, not archived**: PRISM's `tools/gate-pixels.mjs --data=<dir with id1/> --frames=200 --png=<prefix>` reproduces its four platform layers deterministically, so ask for them when the comparison actually runs rather than pinning a file that may predate a renderer change. Note also that PRISM needs the same fixed-step clock to compare itself against DOSBox-X (its P3.6), so compare notes before either side builds it twice. | M | open |
| G4 | ⚠️ **NO LONGER REPRODUCES (re-measured 2026-09-09)** — the head-14-px-right-of-the-body defect is absent from six MIRAGE samples (ticks 600 / 1200 / 2600 and block budgets 50 M / 150 M / 400 M), and a DOSBox capture at the same trigger shows the same coherent sprite. Something between 2026-08-19 and now fixed it; **which fix is not known**, so this is recorded as not-reproducing rather than as understood. Three hypotheses were tested and all three died: (a) the game port — the memory note said changing 0x201 "measurably changes Baby Jo", but captures under 0xFF and 0xF0 are **byte-identical PNGs**; (b) MIRAGE fabricating an input to leave the language-select screen — the BIOS keyboard buffer stays head=tail=0 throughout and the guest reads exactly four ports (0x3DA, 0x388, 0x201, 0x40), no keyboard at all, and DOSBox with NO keys reaches the same menu; (c) a beam miscalibration — measured 2.78 then 1.97 retraces per BIOS tick against 3.845 expected, and **both numbers were undersampling artifacts**: the retrace pulse is 0.45% of a frame, so a sampler taking ~59 samples per frame catches roughly a quarter of them. Computed exactly from the model (`vgaPeriod = pitBase / 3.845`), the ratio is 3.845. ⚠️ **Open, and it is a harness question, not a MIRAGE one**: under `tools/qemu-shot.mjs` the game sits on the language-select screen for 165 s of guest time (~3000 BIOS ticks) while MIRAGE and DOSBox both reach the menu by tick 2600, with or without the `BABY 2` language argument. Until that is explained, QEMU is not a usable reference for this title. | M | not reproducing; cause unknown |

### ⚠️ MIRAGE_LOCKUD costs two goldens — EXPLAINED (2026-09-11)

`LOCK` on a non-lockable opcode is #UD, and the check is right. It costs `intros/memories.com` and
`intros/oktaeder.com`, and the reason is now measured rather than guessed.

With true per-block tracing (`tools/trace-diff.mjs`), the first divergence is at block **26 252**, and
the six blocks before it are IDENTICAL in both configurations:

    0814:f845 -> f9c5 -> fb45 -> fcc5 -> fe45 -> ffc5     steps of exactly 0x180

**Both configurations are already derailed there** — that is the classifier's "walking forward through
memory" signature, and it happens with the flag OFF too. The block starting at `0xffc5` then decodes
forward across the 64K wrap and into the PSP, where `f0 53` sits (`53 ff 00 f0` is our own dummy vector
`F000:FF53` in the saved-vector fields). With LOCKUD that block is TRUNCATED at the #UD; without it the
decode runs on. That single difference is what splits the two runs.

So the check is not inventing a fault in valid code: it is truncating a block inside a derail that
already exists. **The real defect is upstream — why memories.com executes at 0xf845 at all — and it is
present today, with every flag off, while the golden fingerprint passes.**

⚠️ Four measurement errors produced four wrong readings here; they are listed because each is a trap
this codebase sets repeatedly:
- `rec.run` is called once per **slice**, not per block — it loops over blocks internally. Hooking it
  gave one sample per 2000 blocks and turned "block 26 252" into "block 14".
- A block census filtered `ip < 0x100` to mean "outside the program", which never looked ABOVE the
  program's 0x1ff — the derail is at 0xf845.
- The guard census reports the **instruction** ipStart (0x0d), not the block's ip0 (0xffc5); reading it
  as a block address made the argument circular.
- A block dumped early is not the block that runs later: memories.com self-modifies.

### ⭐ test386 measured on THREE engines, same binary (2026-09-12)

The ROM emits POST codes to a port nothing could observe from outside. Rebuilt from source
(`github.com/barotto/test386.asm`) with **`POST_PORT equ 0x3F8`** — the UART data register — so every
POST code becomes a serial byte that both QEMU (`-serial file:`) and DOSBox-X (`serial1=file file:`)
can capture, with no UART init needed. `tools/run-test386.mjs` already reads `POST_PORT` from the
environment, so MIRAGE runs the **same binary**.

    DOSBox-X  (BOOT -bios)   >= 2 codes   dies on "Exception 6 already in progress -> double fault"
    v86       (tools/v86-test386.mjs)  9 codes   last 0x09   STUCK (nothing further in 75 s)
    QEMU      (-bios)          10 codes   last 0x20   (identical with -cpu 486)
    MIRAGE    defaults          20 codes   last 0x12
    MIRAGE    3 flags           28 codes   last 0x1a

**v86 is the closest comparable** — JavaScript, a dynamic recompiler, real BIOS images — and it stops
FIRST of the four, at POST 0x09.

**All four end in the SAME place: test386's own `error` handler.** Sampling v86's EIP shows it parked
at `0xFFE8A` = `F000:FE8A`, where QEMU and MIRAGE also halt. So none of them is crashing or hanging —
each one FAILS AN ASSERTION and jumps there. That distinction matters for the next question: a
configuration problem (a missing VGA BIOS, wrong memory size) would show up as no POST codes at all,
not as a clean arrival at `error`. **test386 replaces the BIOS; there is no BIOS to add.**

⚠️ Checked, because it was a self-inflicted risk: moving POST_PORT to the UART data register does NOT
change behaviour. v86 ends at the same EIP with the original 0x190 ROM and with the serial one, so the
redirection reports the codes without perturbing the run. (DOSBox-X is the exception — it models the
transmitter and drops bytes, which is why its count is a floor.)

**No emulator available here passes test386.** The ones that plausibly do are the two it was written
for: **IBMulator** (its author's) and **PCjs** (its ancestor). Bochs is used as an example reference in
the README with an explicit "I cannot guarantee that Bochs is bug free"; it is not installed here.

⭐ **So stop treating POST 0xFF as the target.** The README's own method works without it: execution is
deterministic, so **dump the first 640 KB on two engines at the SAME POST code and diff them**. v86 and
MIRAGE both reach 0x09; that is a common point where a byte-level comparison would localise a
divergence exactly, which a POST count never can.

v86 is not committed — `npm i v86` where `V86_DIR` points, the same rule as boot/ and games/.

⚠️ **The DOSBox-X number is a FLOOR, not a count**: its log reports `Serial1: Errors: ... TX:2`, so it
models UART timing and drops POST bytes when the transmitter is busy. QEMU accepts them all. Do not
quote DOSBox-X's figure as a comparison; quote only that it loads the ROM, runs it, and dies on a #UD
cascade.

**What this changes.** "POST 0xFF or it is our bug" was the wrong frame: the reference emulators do
not reach it either on this ROM, and MIRAGE currently goes further than both. That is not a claim of
superiority — test386 is strict and each engine fails it somewhere — but a POST code short of 0xFF is
not by itself evidence of a MIRAGE defect. Compare against these numbers before assuming one is.



### POST 0x1A — ENTER fixed in ring 0; the ring-3 page-fault test is open (2026-09-12)

Two real ENTER defects fell here, both general and both off-flag (`f881053`, `4652ff3`): the
destination width follows the STACK, not the operand size (`BP <- FrameTemp` at operand-32 /
stack-16, EBP's high half preserved), and `FrameTemp` is the FULL ESP, not the 16-bit stack
pointer — on a 16-bit stack SP wraps while ESP's high half is untouched, and both the dword ENTER
pushes per nesting level and the final BP are taken from it.

With those, POST 0x1A's ring-0 checks pass and the section reaches its **ring-3 page-fault test**,
where it now stops:

    .pageFaultEIP:  enter 1,0        ; 0xBD95, CPL 3, stack page marked PTE_SUPER_W
                    jmp error        ; reached only if the ENTER did NOT fault

So the ENTER must raise `#PF(PF_PROT|PF_WRITE|PF_USER)` and does not. Measured at that point:
`cpl=3`, `cr0=0x80000011`, `paged=true` — so the conditions the check needs are all present, and
`Memory.walk` does implement U/S and R/W with the right error bits.

**Our page protection is NOT the gap — measured 2026-09-12 from the live tables at that point:**

    page 20 (lin 00020000): pte=00020023 US=0 RW=1  -> PageFault at CPL 3   <- correctly refused
    page 21 (lin 00021000): pte=00021067 US=1 RW=1  -> write OK
    cpl=3   ss base=00020000   esp=00000fff

The supervisor-only page faults exactly as it should. The ENTER simply never touches it: the test does
`mov esp, 0x1004` with SS base 0x20000, so the pushed dword lands at linear **0x21000** — page 0x21,
user-writable. **The open question is therefore why ESP or the stack base do not put the access in
page 0x20**, not why a refused access fails to fault.

⚠️ **Do not start from "the write path swallows the fault".** That was checked and the check was
wrong twice over: `machine.js` arms `mem.pfRaise = true`, so `xlat`'s silent `-1` return does not
apply to a running Machine; and the probe that "proved" a supervisor page does not fault wrote to
linear 0x21000, a GUESSED address. The page the test marks is `0x1000|(TEST_BASE>>12)` = page
0x1020, i.e. linear **0x1020000**. Redo that measurement on the right page before concluding
anything.

Method note for this section: 0xBD95 is NOT a block start — the ENTER sits inside the block that
begins at 0xBD8A — so a per-block probe watching for that address never fires.

### Segment protection at ACCESS time — why test386 stops at POST 0x12 (named 2026-09-10)

test386 does **not** pass. It signals success by writing POST **0xFF** at `postFF` and only then
halting; we stop at `0x00d0:0xfe8a`, which is `jmp error` inside `DefaultExcHandler`. Both outcomes
halt, which is why "20 POST codes, halted, no fault" was quoted as healthy for months —
`tools/run-test386.mjs` now prints PASS/FAIL instead (`a572fd8`).

**It is not an unexpected exception.** Measured: **zero** exceptions are raised while POST 0x12 is in
force. `DefaultExcHandler` and `error` are the same address, and test386 jumps there itself when a
check fails — so this is a failed assertion, not a fault we mishandled.

The section is *"Verify other memory access faults"*, and its first test is:

    ; #GP(0) If the destination operand is in a non-writable segment.
    mov ax, RO_SEG_PROT      ; write protect DS
    mov ds, ax
    protModeFaultTest EX_GP, 0, mov [0],eax

**We never raise it.** `cpu.segAccess[]` caches each segment's access byte with the comment "checks
come later", and grepping the whole of `src/` shows it is **written once and read nowhere**. There is
no segment-limit check in the emitted code either. So a write through a read-only data segment
succeeds, and every access-time protection rule this section tests is absent.

⚠️ **This is a hot-path change, so measure before and after.** A writability test on every emitted
store, and a limit test on every access, is exactly the kind of per-access work that cost
`tube +6.3% / memories +12.2%` when `pagingOn` was called per access (see the memory-dispatch row).
The access byte is already cached, so the test is a compare on a value we hold — but it must be
emitted, not called. Start with WRITES only: that is what POST 0x12's first test needs, and it is the
smaller half.

## E · Tooling / infra

| # | Task | Size | Notes |
|---|---|---|---|
| E0 | ✅ **80386 conformance vectors integrated, 105807/105807 = 100% (2026-08-25)** — `tools/moo.mjs` + `tools/conformance386.mjs`. The 8088 vectors `conformance.js` runs are 16-bit real mode, so nothing in them reaches a 32-bit operand (`0x66`), a 32-bit address (`0x67`), the two together, or the `0F` space. [SingleStepTests/80386](https://github.com/SingleStepTests/80386) is the same idea a generation later: captured from an actual 80386EX over an Arduino interface, each test run twice and replayed to verify. 941 opcode files, real mode only — protected mode is announced but not out (memory cannot be randomised there without triple-faulting on entry). Chunked binary `MOO`, hence the reader. **Two real engine defects, both invisible to every other oracle:** (a) **SIB with `index=100b` and a non-zero scale** — the manual calls the scale irrelevant with no index, the silicon applies it to the BASE. Unanimous: every failing SIB case had that shape, every other form passed 960/960, and the ones that "passed" with it were the ones whose base held 0, where the two formulas coincide. (b) **`BT`/`BTC` with a memory operand** added the byte displacement to the LINEAR address instead of the effective one, so a register bit offset walked straight out of the segment rather than wrapping inside it. ⚠️ Two harness traps on the way, either of which reads as a pile of engine defects: the byte stream ends in a `HLT` and the captured state is taken AFTER it retires (step once and every case is an off-by-one on EIP); and these are silicon, so architecturally UNDEFINED flags have values — comparing them tests which 386 the capture used. Masking them took 76.09% → 97.70%, the two fixes took it to 100%. **Batches 2-3 (2026-08-25): string ops, then control transfers and the stack frame — 238118 cases at 98.87%.** Two more engine defects: **`PUSHFD` pushed our whole flags word** where a 386 has no EFLAGS bit above 17 and the rest push as zero (0xFFFC0493 → 0x00000493), and **`LEAVE` branched on the OPERAND size for both of its widths** — it moves the frame pointer at the STACK's width and pops at the operand's, so `o32 leave` on a 16-bit stack (every real-mode program) wrote all of EBP into ESP instead of BP into SP. Two more harness traps, of the same family as the first two: a long `rep stos` can write over its own terminating `HLT` (detected — the HLT is gone — and skipped), and the terminator sits wherever execution ARRIVES, so keying on "initial eip + length" reports every CALL/RET/IRET as an off-by-one; look for it under CS:EIP instead. ⚠️ **Two known residuals, both deliberately left.** `ENTER` mixes the same two widths as LEAVE did but inside its nested frame-copy loop (2048 memory failures, 66C8) — a more delicate fix than the one-line LEAVE. And an instruction ending exactly at `0x10000` leaves `EIP = 0x10000` on a 386 where we truncate to 16 bits; that is ~5% of control transfers, not the 5 cases the string batch suggested, so it is now worth doing — but it means letting EIP exceed 0xFFFF in real mode, which is the hot instruction-pointer path AND the block cache key. **Batch 4 (BCD, block stack, port I/O, flag ops).** One more engine defect, and it is a GENERATIONAL one: **`AAA`/`AAS` adjust AX as a whole on a 386** — the carry out of `AL+6` reaches AH and the `+1` rides on top of it — where the 8088 adjusts AL and AH separately and masks the carry away. With AX=1FFFh the 386 gives AH=21h and the 8088 form gives 20h. Measured both ways: making it AX-wide unconditionally costs **366 of the 8088 vectors**, so it went behind `cpu-profile.js` as `bcdAdjustsAX`, whose header had already named the BCD flags as the thing the 286/386 hardware suites would be needed to settle. Both suites are 100% on it now. **The whole BCD group is now clean**, and all of it was the same generational split, each half measured rather than assumed: `AAA`/`AAS` adjust AX as a whole; `DAA`/`DAS` use a plain `0x99` threshold where the 8088 raises it to `0x9F` when AF is set; and `DAS`'s low borrow sets CF, which on an 8088 it does not. All three ride on `bcdAdjustsAX`, and the 8088 vectors stayed at 555764/555764 through every step — the check that keeps this honest, since each change costs them if applied unconditionally. **`ENTER` fixed too**, and it was the same width confusion as `LEAVE` one level down: its nested frame copies walk the frame pointer at the STACK's width and push at the OPERAND's, so using EBP on a 16-bit stack sent every read wherever its high half pointed and each copy came back zero. ⚠️ **Two residuals left, both understood**: `IN` from a port the capture's machine has real hardware on (environmental, 9 cases), and **`EIP = 0x10000`, attempted and reverted 2026-08-25**. An instruction ending exactly there leaves EIP past 0xFFFF on a 386; we truncate. The fix is one line — stop wrapping `ipAdd` when the profile is not an 8088 — and it works: the control-transfer files go to **12113/12113**, the 8088 vectors hold at 555764/555764, and `tools/test.js` passes. **But a golden HANGS.** It ran 30 minutes against a normal 1-2, so some corpus program relies on IP wrapping at 0xFFFF and now runs off the end instead. Reverted. **Bisected 2026-08-25: the two goldens are `intros/memories.com` and `intros/oktaeder.com`** — 34 of 36 pass with the fix in. Both are sizecoding intros, and both depend on the instruction pointer coming back round at 0xFFFF. Splitting the two things the one-liner conflates (EIP is 32 bits and does not wrap; the FETCH ADDRESS stays inside a 16-bit code segment) is not enough either — with the fetch wrapped and EIP free, `memories` mismatches instead of hanging and `oktaeder` still hangs, because branch targets computed from EIP and the block cache key have to agree with it too. So this is a design change across fetch, EIP and the cache, not a one-line profile flag: worth doing, worth doing deliberately. Note the tension it exposes — the 80386EX vectors say EIP reaches 0x10000, and a real 386 would then #GP on the next fetch, so neither wrapping nor free-running is right; the guests only survive because DOSBox wraps. **Batch 5 (the `0F` space, conditionals, SETcc, XCHG, MOV imm): no new engine defect** — the default set is now **314986 cases at 99.79%**, and everything failing is one of the two known residuals. A sixth harness trap surfaced instead: `SHLD`/`SHRD` with a masked count LARGER than the operand size is architecturally UNDEFINED, and unlike the undefined flags no mask comes with it — the vector records what this particular 386EX produced. Verified before skipping them: every count at or below the operand size matches the ordinary formula exactly, by hand on three cases. **Batch 6 (immediate groups, the rest of the shifts, the 32-bit stack block): two more defects, both the same shape as `LEAVE`/`ENTER`.** `MOV r32, Sreg` **zero-extends** the selector into the full register — the memory form's "always two bytes" rule is only half the story, and merging into the low half left `ebx=1934009F` where the vectors give `0000009F`. And **`POPAD`'s discarded ESP slot is not discarded**: the slot IS loaded into ESP and the stack-pointer adjustment then rewrites SP at the STACK's width, so under a 32-bit operand on a 16-bit stack the popped value's HIGH half survives. Verified before implementing — the final ESP's high half is the slot's high half in every case checked, its low half `SP+32`. Default set now **397643 cases at 99.83%**. **821 of the 941 opcode files are still unexploited.** **Batch 7 (the immediate `BT` group, 32-bit addressing): one more defect.** `BT`/`BTS`/`BTR`/`BTC` with an IMMEDIATE offset take it modulo the operand size even when the bit base is in memory — only the REGISTER-offset form addresses an absolute bit and may leave the operand. We ran the raw `imm8` through the shared path, so `bt word [bx],0AFh` tested bit 175 (byte +21) instead of bit 15 of the addressed word. A seventh harness gap came with it: `0FBA.[4-7]` belongs to the BT entry of `undefMask`, and a shift or rotate whose masked count reaches the operand width is undefined with no architectural value, so those are skipped rather than scored. **⭐ CORPUS CLOSED (2026-08-28): all 941 opcode files, 1,439,051 cases, 99.9987%.** The 18 remaining failures are `IN` from ports the capture machine has real hardware on — environmental, not ours. `node tools/conformance386.mjs all` replays the whole corpus from the versioned manifest `tools/sst386-manifest.txt`; `DEFAULT` stays the curated subset a gate run can afford. **`EIP = 0x10000` is FIXED**, and the design change the earlier attempts kept reaching for was not needed: the defect is only that the SEQUENTIAL advance truncates. A near `JMP`/`CALL` at a 16-bit operand size DOES zero the high half — which is what `ipAdd` models and what `memories.com`/`oktaeder.com` depend on — while a plain increment past 0xFFFF does not. So `ipAdd` keeps wrapping (fetch address and block-cache key unchanged, and `step()` re-masks EIP on entry, so nothing on the hot path moves) and a new `SEQ()` recovers the untruncated value at the thirteen sites where `ip` is a return address, a `softInt` return, or a restart point. That took 453 failures to zero, goldens stayed 36/36, and the DOSBox sweep came back byte-identical to HEAD. The tension the earlier note flagged is still real and still unmodelled: a real 386 would `#GP` on the segment limit when it then fetched AT 0x10000, and we wrap instead — no DOS guest exercises that deliberately. | — | done |

| # | Task | Effort | Why |
|---|---|---|---|
| E1 | Fold `tools/run-game.mjs` conveniences (auto-detect main EXE, screenshot PNG) | S | Faster headless game triage. |
| E2 | Extend `fuzz-region` to far transfers / multi-segment / call-return | S–M | Closes the class of tier-2 bugs that single-segment loop fuzzing misses. |

## F · Deferred capability gaps (found while testing, #57)

| # | Task | Effort | Why / what it unblocks |
|---|---|---|---|
| F6 | ✅ **DONE — A20 and the memory-size services; mesha renders under a booted FreeDOS.** `INT 15h AX=2400-2403` did not exist, the 8042 A20 method was inert (`onPortWrite(0x64, () => {})` discarded every controller command), A20 was closed at boot where a POST about to load a kernel opens it (boot path only — the `.COM` path keeps the 1 MiB wrap EXEPACK needs), `AH=88h` answered 0 KB whenever `machine.xms` existed even when orphaned by a booted kernel, and `AX=E801`/`AH=8Ah` were missing. HimemX goes from *"No Supported A20 method detected / Driver won't be installed"* to **`Always on A20 method used`**, word for word what QEMU prints. `boot/FDMESHA.IMG` — FreeDOS + HimemX 3.34 + mesha — now renders on both sides. | — | done |
| F8 | ✅ **DONE — the #GP is fixed; mesha renders on BOTH branches under a booted FreeDOS.** Two defects, both ours, and the fault named neither. **(a) We loaded a real-mode segment into CS in protected mode.** `tickTimer` ended with `if (v1c.seg !== BIOS_SEG) this.realInt(0x1c, ...)`, and FreeDOS hooks INT 1Ch at segment `0x0070`; with a DPMI client in protected mode that value became a SELECTOR, hence `#GP(0x70)`. Reflecting properly means switching modes underneath the client, which the host cannot do in flight — so with a client active and no PM handler, keep the BDA tick and the EOI and drop the reflection. **(b) Set/Get Interrupt Vector is the HOST's job, not the DOS's.** PMODE4K installs its 32-bit timer ISR with `INT 21h AH=25h`, where `DS:(E)DX` is a selector:offset addressing the CLIENT's table. `dos.js` did that — so it worked under our HLE DOS and only there; under a booted kernel INT 21h has no JS handler and the call fell through to "unclaimed" and was **silently swallowed**, so the handler was never registered and nothing mesha draws ever ran. Moved into the host's reflection path, where it holds whatever DOS is underneath. Result: `pmVec 8<-3c:92`, identical to the HLE run, and **3765/3765 pixels on the XMS branch and on the DPMI branch alike**. Three wrong readings on the way, all recorded in COMPAT.md — a descriptor bug, then "executing zeros" (the dump was taken inside the fault-delivery hook), then the guest's `CONV_END` assumption. | — | done |
| F9 | ✅ **DONE — an unclaimed protected-mode software interrupt is reflected to real mode.** `machine.softInt` reflected a DPMI client's `INT n` to our JS services and, finding none, simply returned. Under our own DOS every vector has a JS handler so nothing showed; under a **booted kernel** none do, and every DOS call a client made was silently swallowed — `intros/mesha.com` rendered its whole show and then never terminated, because its `INT 21h AH=4Ch` exit did nothing and it drifted. `dpmi.reflectInt(n)` builds a real-mode call structure from the client's registers and goes through `realCall`, the same mode switch DPMI function 0300 performs, with a `reflect` marker that `realCallReturn` honours to carry the results back into the client's registers — **CF included**, which is where DOS puts success or failure. One detail that matters: the structure's ES/DS get real-mode SEGMENTS, not the client's selectors, since in real mode those fields are paragraph numbers. mesha now renders 3765/3765 **and exits cleanly to `A:\>`** on the DPMI branch under FreeDOS. Checked for collateral: DOOM is byte-identical with and without it, because under the HLE path our DOS claims INT 21h and the new path never fires. | — | done |
| F7 | ✅ **DONE — `machine.reclaimVector()`, and both services stand aside for a real kernel.** Our XMS driver and DPMI host hook INT 2Fh at BIOS-install time, before any kernel exists; a booted kernel installs its own multiplex handler over the vector and is the BOTTOM of that chain, so we were orphaned — measured, reached by chaining **zero** times. `reclaimVector` takes the vector back and remembers the displaced handler; `swInt` chains down to it whenever our JS handler returns falsy (hence the explicit `true`/`false` returns now in `xms.js` and `dpmi.js`), with a `_chaining` guard for the obvious loop — whoever we displace chains to what *they* saved, which is our stub. Called from `tickTimer`, so a driver that loads mid-boot is picked up within a tick. **And both services then STAND ASIDE when a guest handler sits below**, which is the part that matters: a real BIOS provides neither, and DOSBox ships neither. Answering XMS ourselves made HimemX report *"XMS is already installed. Driver won't be installed."* and step aside, so the guest ran on our driver instead of its own; answering DPMI pushed mesha onto its DPMI branch, where it faults (F8), instead of the XMS branch that renders. With both standing aside: HimemX installs and owns XMS (`0290:0620`), `1687` answers "no host" as on real hardware, and mesha renders 3765/3765 under FreeDOS. A DPMI title on a booted kernel loads its own host — as on real hardware, and as proven with CWSDPMI under QEMU. Original entry: **Our DPMI host and XMS driver are orphaned by a booted kernel.** Both hook INT 2Fh at BIOS-install time, i.e. **before** a kernel exists; the kernel then installs its own multiplex handler over the vector, and the DOS kernel is the BOTTOM of that chain with nothing to chain down to. A real DPMI host is a TSR that loads *after* DOS. Measured: at the moment `intros/mesha.com` asks, the vector is the kernel's and our handler is reached by chaining **zero** times, so `INT 2Fh AX=1687` answers "no host". Under our HLE DOS we own every vector and it works — so this only shows up on the boot path, which is exactly the path that matches DOSBox and QEMU. Fix is a re-hook after the kernel is up, or accepting no DPMI there (DOSBox has none either). | M | Blocks any DPMI title from running on a real kernel, which is the configuration the external oracles use. |
| F5 | ✅ **DONE — INT 10h now matches a real VGA BIOS 13/13** (`tools/int10-oracle.mjs`). A `MODE_INFO` table captured from SeaVGABIOS drives the mode set: the AL it returns (0x20 graphics / 0x30 text, 0x3f for mode 6), the columns published at BDA 0x44A (40 for mode 13h), which of four DAC tables it loads, and the per-mode attribute palette — entry 6 is **0x14**, brown not dark yellow. `AH=0Fh` reports the real column count, `AH=0Bh` writes the border into attribute register 0, `AH=12h BL=10h` returns CX=0x0009. Trap worth remembering: the palette must be applied **after** `vga.setMode()`, which resets the sixteen registers to the identity. Eight goldens moved and were re-blessed one at a time — six only in palette state (A000/planes/B800 byte-identical), two in content and checked against QEMU. Original finding text: **INT 10h differences against a real VGA BIOS** — `tools/int10-oracle.mjs`, first run 5 identical / 8 different, reproducible. The DAC block services agree (they were just fixed, and this confirms them against firmware rather than against my reading of a manual). Six distinct defects behind the eight failing cases, none of them yet fixed: **(a)** AH=00 leaves AX untouched; a real BIOS returns AL=0x20 for a graphics mode and 0x30 for text. **(b)** a mode set does not reprogram the DAC — after mode 12h or 03h we keep the previous 256-colour ramp where the ROM loads that mode's own palette (636 of 768 bytes differ). **(c)** attribute palette entry 6 is 0x06 where a VGA sets **0x14** — the classic "colour 6 is brown, not dark yellow" register, 9 entries differ. **(d)** AH=0Fh returns AH=0x50 (80 columns) for mode 13h, which is **40** columns (0x28). **(e)** AH=0Bh does not write the border colour into the attribute palette. **(f)** AH=12h BL=10h returns CX=0 where the ROM returns 0x0009 (feature bits / switch settings). Each is small on its own; (b) and (c) are the two that can visibly change what a text-mode or EGA program looks like. Extend the case table as services are touched — the harness is a table, adding a case is one line. | S–M | ⭐ The gate that did not exist. `conformance.js` is a CPU oracle and never touches INT 10h, `test-dos-api.js` compares our BIOS against **itself** (so it catches changes, never mistakes), and `golden.js` was 43/43 straight through the AL=12h palette defect that made every frame of `intros/mesha.com` the wrong colour. |
| F1 | ✅ **DONE** — **`0F 38` three-byte opcode family + VESA** (INT 10h AH=4Fh, banked/linear framebuffer, hi-res modes) | L | **Chrome Revenge** (1K, Abaddon — arguably the best DOS 1K) faults on `0F 38` and draws in VESA 640×480; both are needed to run it. VESA also unlocks later hi-res demos/games. **Now also the only thing between us and `Void 3`** (pouet 4K #5), and it names the minimum shape: `4F00h` already answers, but our mode list at `f000:740` is the `FFFF` terminator alone, so a client's scan falls straight through. Void 3 walks the list, calls `4F01h` per mode and takes the first that is `320×240` at **32 bpp**, then `4F02h` — so VBE 2.0 with a mode-info block and a linear framebuffer, not just banked 8-bit modes. Its released source (`SRC/SHIVA.RM`) is the spec to build against. **✅ VBE 2.0 landed 2026-08-28; the `0F 38` half is still open.** `4F00` advertises a real mode list, `4F01` fills a ModeInfoBlock (pitch, geometry, bpp, direct-colour masks, `PhysBasePtr`), `4F02` enters the mode and `4F05` moves the A000 window across the framebuffer. The framebuffer is plain RAM reserved at the top of memory (`machine.vbeFbBase`, 2 MiB) the way the DPMI host already reserves its tables, so a client that maps PhysBasePtr writes with no device hook at all, while the windowed path routes A000 through `vga.js`. Eight modes, including OEM numbers for 320x200 and 320x240 — the standard set has no 320x240, which is precisely what Void 3 scans for. `demos/vesa.asm` is the end-to-end test: it walks the list by GEOMETRY, sets 640x480x8 and draws through five bank switches, and it is pinned as a golden whose digest covers the framebuffer itself. ⚠️ **Void 3 still does not render, and no longer for VESA reasons.** It now finds mode 0x141, sets it, and runs on — then needs 16 MiB of DPMI memory (so a 32 MiB machine; the 16 MiB default is not enough), and stalls inside its own INT 8 handler in x87-heavy code that issues no I/O at all. Memory contents are byte-identical between a 20k-tick and a 200k-tick run, so it is a hang, not a slow precalc. Two DPMI defects were fixed reaching that point (0002 unimplemented, and 0501 wrapping instead of failing);  the stall is the next thing to name. **⭐ SSE landed 2026-08-28 and Chrome Revenge RENDERS.** Its published source names the requirement exactly — sixteen XMM instructions, not the whole ISA: SSE (`MOVAPS`, `MOVSS`, `SHUFPS`, `ADDPS`, `SUBPS`, `MULPS`, `XORPS`, `RSQRTPS`), SSE2 (`CVTDQ2PS`, `CVTPS2DQ`, `PCMPEQD`, `PACKUSWB`, `PACKSSDW`, `PAVGB`) and SSE4.1 (`PMOVZXBD`, `PMOVSXWD`, `INSERTPS`, `DPPS` — the `0F 38` and `0F 3A` escapes). `src/sse.js` holds the register file and the semantics; the recompiler decodes the mandatory `66`/`F3` prefixes off the state the prefix loop already leaves behind. **Two engine defects beyond the missing instructions, and neither was in the SSE:** (a) **`FCOMI`/`FUCOMI`/`FCOMIP`/`FUCOMIP` were silent no-ops.** They are the only x87 compares that write EFLAGS instead of the status word, `fpu.js` handled `DB`/`DF` as FNINIT/FNSTSW and returned, and a missing flag write does not fail loudly — the following `Jcc` just reads stale flags. Chrome Revenge gates its whole ray/sphere test on three of them, so every ray missed and the screen was black; qblove's golden gained a whole landscape when this landed. (b) **port 0x60 read back as 0.** The 8042 data port RETAINS the last scancode, and a program launched from a prompt finds Enter's BREAK code there. Chrome Revenge ends each frame with `IN AL,60H / DAS / JC nextframe` — DAS sets CF only above 0x99, i.e. exactly "a key was RELEASED" — so it drew one frame and exited. Same symptom in `symetrie`, whose golden now runs on to its full mandala. ⚠️ The INT 8 cap (D7) still bites here: the intro asks for divider 68 (~17.5 kHz for its PWM audio) and gets `pitBase>>4`, so its animation clock runs ~60x slow. **The oracle came first.** Unicorn refuses SSE until CR0.EM is clear and CR4.OSFXSR is set, and this harness records a faulting capture as `error` and SKIPS it — every XMM case would have "passed" without running. `uc-capture.py` now enables it, verified inert by re-capturing the 2086 pre-SSE expectations byte for byte, and `tools/x86-sse-cases.mjs` adds 30 SSE + 8 x87-compare cases that store their results into the compared scratch. 29 of the 30 passed on the first run; the one that did not was `RSQRTPS`, by one ulp, because QEMU rounds the square root to single precision before the divide. 2124/2124 now. **The P6 x87 extensions were a hole, not a one-off.** After FCOMI came `FCMOVcc`: `fpu.js` had no `DA` arm at all, so `FCMOVB`/`FCMOVE`/`FCMOVBE`/`FCMOVU` (DA C0..DF), their DB negations and `FUCOMPP` (DA E9) were all silent — and FUCOMPP must POP TWICE, so the x87 stack drifted for everything after it. That is what qblove's stripes actually were; it now draws its logo, checked against the author's own pouet screenshot. ⚠️ Note the dead-flag hazard this exposed: the DA/DB register forms go to the fpu.js FALLBACK, which declares no `use`, so elimination would have stripped the CMP or FCOMI that set the flags FCMOVcc reads — the fallback now declares `use |= lALL`. 13 more oracle cases, and they were checked for non-vacuity by disabling the implementation: 8 of the 13 fail without it (the 5 not-taken cases pass either way, as a negative case should). 2137/2137. |
| F4 | ✅ **DONE** (`video quick wins`) — INT 10h **AH=0Ch/0Dh** (write/read pixel, mode 13h + planar + CGA), **AH=10h AL=03** (blink vs bright background) and **AL=17h** (read DAC block, the mirror of the existing AL=12h); text attribute **bit 7** honoured (blink *and* bright backgrounds); **cursor** hide/shape via AH=01 + AH=03 reporting the real shape; **read mode 1** (colour compare) in `vga.readByte`; the **CRTC is reloaded on mode set** (stale offset/start used to shear the next mode); ports **0x3BA** (mirrors 0x3DA — an unregistered read of 0xFF left bit 3 stuck, hanging any "wait for retrace to end" loop), **0x3C1**, **0x3C2/0x3CC**, **0x3C7**, and a real **0x3C6** pixel mask. | — | done |
| F3 | ✅ **DONE** (`7e1e162`) — **`0x67` address-size prefix**: 32-bit ModRM grid, **SIB** (scale/index/base), disp32, 32-bit base+index, SS default for ESP/EBP bases, and moffs32 for A0-A3. v1 consumed the prefix and decoded 16-bit anyway, so the instruction stream **desynchronised** (a 0x67 instruction is 1-5 bytes longer). Was the root cause of **Heaven**'s derail; it now runs past 70 M cycles and renders its animated vortex. `test.js` gained 11 targeted cases (each asserts the decoded *length* too — the 8088 conformance vectors can't reach 386 addressing). | — | done |
| F2 | ✅ **DONE** — **boot-sector mode** (`src/boot.js`): loads the sector at `0000:7C00` and sets up the INT 19h handoff (CS:IP=0000:7C00, SS:SP=0000:7C00, DL=drive, IF set), with no PSP and no `installDOS` at all. The 55 AA signature is required unless `strict:false` — silently booting a non-bootable image would look like a MIRAGE fault rather than a bad image. `tools/run-boot.mjs` is the headless runner (`PNG=out.png` dumps the mode-13h screen); `golden.js` pins a boot workload. **BootChess** (RSi, 512b) renders identically to the author's own Bochs reference. A single-sector prod needs no INT 13h — the BIOS has already read the whole program; multi-sector boot (a DOS kernel) is the next rung and does. Note DOSBox-X hands off with SS:SP=0030:0080: only DL is architecturally meaningful, so a sector that cares sets its own stack. | — | done |
| F2b | ✅ **DONE** — **INT 13h** (`src/disk.js`): AH=00/02/03/04/08/15 over attachable sector images, CHS decoding, geometry inferred for the standard floppy formats, and 80h "not ready" for an empty drive. `demos/bootload.asm` is a two-sector image whose first sector reads the second through INT 13h and jumps into it — the shape every real bootloader has, and the rung a DOS kernel needs. Next: a real 8259 (EOI is still `() => {}`) + D7 before a kernel can boot. | — | done |
| F2c | 🟡 **half done** — **8259A** (`src/pic.js`): IRR/ISR/IMR, fixed priority, EOI, ICW init, cascade; IRQ0/IRQ1 routed through it. Golden-neutral (22/22) because the *delivery point* is unchanged. The other half is **D7**: delivering at run-loop safepoints instead of from the device. Note the `pitBase>>4` (~291 Hz) INT 8 cap may now be redundant — in-service gating is the back-pressure it was standing in for — but that is a separate experiment. | M | in progress |
| F2d | ✅ **FreeDOS 1.4 BOOTS** — real kernel on our synthetic BIOS, verified interactively: boot sector → kernel → FreeCOM 0.86 → the installer's Y/N prompt → answered N → `A:\>`. **Zero unimplemented INT vectors and zero unhandled ports for the whole boot.** My predicted blockers (CMOS/RTC on 0x70/0x71, the FDC ports, INT 1Ah AH=02/04) were all wrong — none was touched. Notably this means **D7 is NOT a prerequisite for booting a kernel**: device-driven delivery is good enough. `node tools/run-boot.mjs boot/FREEDOS14.IMG 9000000 4e,0d`. It unlocked the HLE↔kernel differential oracle, `tools/dos-oracle.mjs`. | — | done |
| F3t | 🟡 **test386.asm: real mode passes (POST 0-6), protected mode reaches POST 0x12** (was 0x0B; 20 codes, was 13). Nine CPU defects found on 2026-08-25, every one by tracing which instruction reaches the `error` handler — never by reading the section and guessing. **Segment loads:** (a) a faulting load did not end the block (`MOV Sreg,Ew` raised #GP and carried on, so the terminator overwrote `cpu.eip` and discarded the interrupt); (b) the P bit was never checked; (c) a faulting load still wrote the segment register — caught one test LATER, when the handler's own `mov ax,ds / push ax` carried the refused selector back out; (d) no descriptor TYPE check; (e) no PRIVILEGE check. **Ring transitions:** (f) a call gate switched stacks with the CALLER's CPL still in `_cpl` — it loads SS before CS — and exception delivery did the same at both its sites; fixing the order let (e) extend to SS with no exemption anywhere. **Paging:** (g) A and D were never set; (h) page-level protection (U/S, R/W, CR0.WP) was never enforced, so a ring-3 program wrote through a read-only mapping and the expected #PF never came; (i) A and D were being set on an access that FAULTS — the handler reads them from inside the fault and requires them clear. All three #PF error codes now come out right: `0x4` user read, `0x6` user write not-present, `0x7` user write protection. Corpus unchanged at 37/54 throughout. **Next is a different KIND of task, not a tenth defect.** POST 0x12 loads DS with a read-only segment and writes through it, expecting `#GP(0)`: we check neither the segment LIMIT nor its WRITE permission on a memory access. The nine above were each a missing test inside one routine; this one is a check on every memory access, on the engine's hottest path, and it interacts with the block cache key — the recompiler knows `csD` at translation time but not `PE`, so emitting the check unconditionally taxes real mode, and emitting it conditionally means keying blocks by protected-mode state too. `segAccess[]` and `limit[]` are already cached, so the data is there; the design and the benchmark are the work. Do it deliberately with `tools/bench.js` on either side, not as an addition to a batch. | — | in progress |
| F3v | ✅ **Real VGA BIOS as an oracle** (`tools/vga-rom.mjs`) — SeaVGABIOS loads at C000:0, inits with no fault, takes INT 10h, and drives our VGA with real mode-set code. It found that our mode set left the **CRTC at zero** (we only set the offset) and GC 5/6/7 at zero — invisible to our renderer, wrong for any program that reads the CRTC back to derive geometry, which is exactly what a Mode-X setup does. `vga.js` now loads the observed tables; all six modes match the ROM register-for-register. PCI probing (0xCF8) and the VBE DISPI probe (0x1CE) did not stop it. | — | done |
