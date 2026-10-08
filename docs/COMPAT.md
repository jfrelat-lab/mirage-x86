# MIRAGE — Compatibility Status

A living record of what runs and what's blocked, so that whoever picks the work up next starts from the known
frontier instead of re-surveying. Update it when you unblock something.

> ⚠️ When probing a game headless, check the **right framebuffer**: mode 13h → `mem.u8[0xa0000]`;
> **EGA planar (mode 0xD) → `machine.vga.planes`** (linear A000 is empty); **CGA (4/5/6) → B800
> interleaved banks**. Getting this wrong once cost a whole mis-diagnosis.

> 🧪 **Headless game runner:** `node tools/run-game.mjs <subdir> <PROG.EXE> [frames] [keysHexCSV]`
> mounts a whole `games/<subdir>` into the VFS, runs the program, and reports mode(0x449)/planar/
> cga/faults/framebuffer-occupancy + any B800 text. Feed keys as make/break hex (e.g. `39,b9` =
> space). This is the fast path for "what mode did it set / why is the screen wrong".

> 🖥️ **`requestAnimationFrame` is throttled in a hidden tab**, and a browser driven by automation
> often counts as hidden: the run loop stalls. To drive frames from the console, loop `mirage.machine.pumpKeyboard(); mirage.
> machine.runSlice(20000);` then `mirage.machine.tickTimer(); mirage.video.render();`. Synthetic
> `KeyboardEvent`s dispatched on `window` DO reach `keyboard.js`; an automation tool's synthetic typing may not.

## Demos / intros — the golden set (all render)

21 workloads are covered by the golden gate: `plasma13`, `xormunch`, `planar` (hand-written EGA
write-mode test), `cga` (hand-written CGA test), plus third-party intros `256b 256bytef above
chaosequ difze intoanew intro intro256 kaneda lattice memories oktaeder puls revitro rv256 tube

**Demo tier, swept 2026-08-22: 31 of 32 intros render.** The one that does not is `oktaeder.com`,
and it is now diagnosed rather than merely pinned. It is three blocks long before it leaves:

    0100  mov ax,cs / shl ax,4      ; linear base of its own segment
    0128  mov [0x11a],ax            ; patch that base into its GDT at 0108..0127
    012F  mov bx,sp / cli / lgdt [bx]
    0135  mov cr0,edx               ; enter protected mode -- with EDX **as DOS left it**
    013B  jmp 0x18:0x140

There is no load of EDX anywhere. DOS leaves `DX = the PSP segment` at `.COM` entry, so the intro
enters protected mode **only when that segment happens to be odd**. Ours is 0x0100 — even — so CR0
stays 0x100, PE never sets, the far jump is taken as a real-mode one and the guest walks off into the
DOS environment block (which is how `src/derail.js` reports it: executing `"C:\oktaeder.com"`).
Forcing DX odd sets CR0 to 0x101 and it does enter protected mode, confirming the mechanism.

It still draws nothing after that, and the rest of the disassembly says why: `mov dx,0xcf8` then
`out dx,ax`, and `0xcfc` — **PCI configuration space**. This is a demo driving real hardware.
Measured on dosbox-x in the same configuration, `.COM` entry gives `DX = CS = 0x0814`, also even, so
the reference would derail at the same instruction. Not a MIRAGE-specific failure, and not worth
chasing; the golden entry stays as a fault fingerprint.

upup`. `memories`/`tube`/`kaneda` exercise the FPU path. `256bytef intoanew memories` are
timer-paced (a phase shift on timing changes is a golden re-bless after visual check, not a
regression). **Mars** (Tim Clarke voxel landscape, 8K MZ-EXE) renders + steers via INT 33h mouse.

### 4K tier (2026-08-01/04, local-only — `intros/` is gitignored)

Six notable sub-4K DOS intros pulled from scene.org (pouet API `download`, `/view/`→`/get/`).
`tools/probe-intro.js` reports mode / fault / Mode-X / chained-vs-planar pixels for triage.

| intro | result |
|---|---|
| **Helium** (ocsa, ASM'97) | ✅ **renders** — orange balloon + gem. A *finite* intro (plays ~48 ticks, restores mode 3, exits — not a hang). Needed the CRTC-Offset fix: it sets offset=32 (256-byte virtual line) where mode 13h defaults to 40 → `_renderGfx13` hardcoded a 320 stride and tore the picture. |
| **Heaven** (NoooN, ASM'95) | ✅ **runs** — animated vortex/tunnel effect. Was derailing at ~52.5 M cycles; root cause was the missing **`0x67` address-size prefix**, implemented in `7e1e162` (ROADMAP F3, details below). Now past 70 M cycles with CS intact. ⚠️ Not verified frame-exact against DOSBox: `dosdiff` double-delivers INT 8 (it calls `tickTimer()` *and* leaves `timerAuto` on), and animated demos differ by phase anyway — use `render-com.js` for visual checks. |
| **Mesha** (ASM'98) | ✅ **renders** — textured 3D mesh. Its PMODE4K stub installs a 32-bit timer ISR with `INT 21h AX=2508h` *from protected mode*, which under DPMI addresses the client's PM vector table; we wrote it to the real-mode IVT and then delivered IRQ0 through `realInt`'s 16-bit frame, so the ISR's `POPAD`/`IRETD` popped three words as three dwords and `#GP`'d on a garbage CS. Fixed in `dos.js` (25h/35h) + `machine.dpmiIrq()`. |
| **Void 3** (MS'99) | 🟡 **past VESA, stalls later.** VBE 2.0 landed (ROADMAP F1): it now walks the mode list, matches 320x240x32 (our OEM mode 0x141), sets it, and carries on. It then needs a **32 MiB** machine — it allocates a flat 16 MiB through DPMI 0501 — and hangs inside its own INT 8 handler, in x87 code that touches no I/O port. Memory is byte-identical between a 20k-tick and a 200k-tick run, so it is a hang and not a long precalc. Fixed on the way: DPMI **0002** (Segment to Descriptor) was unimplemented and returned 0x8001, which the client loaded into ES as a selector; DPMI **0501** computed its base with `>>> 0`, so an over-large request wrapped to a huge address instead of failing; and a client-set descriptor's DPL is now normalised to the client's own ring, since this host runs clients at ring 0 and Void 3 hard-codes DPL 3 for a ring-3 host. |
| **Juggler 2001** (MS'01) | ✅ **renders** once it gets a keystroke — it *asks* for the General MIDI port (`GMIDI @ 3x0h?`) and blocks on `INT 16h AH=00`. A headless probe has no keyboard, which is what "stuck in text mode" actually was. |
| **Pitman** (Tristar) | ✅ **fully playable** — title screen, menu and level 1. It is a TEXT-mode game, so a probe that only counts pixels in `A000` reports it as blank. |
| **Omniscent** (Sanction '97), **Forever Reality** (7dUMP '23), **StarPort BBS 2** (Future Crew '93, EGA `0Dh`), **Another Soul Lost** (Traction '03) | ✅ render. |

**Quake** (id, 1996) — ✅ **plays**: `QUAKE.EXE -nocdaudio` runs demo1, textured world and full HUD,
with no key sent. It is a DJGPP program and drives our DPMI host directly; DOS/4GW is not involved.
Three defects stood between "starts" and "plays", and the last one was not where it looked.

1. **A stale FPU address mask.** `src/fpu.js` captured `cpu.mem.mask` once at install time, while A20
was still closed, so every x87 memory access was pinned to the first megabyte for the rest of the
run. Quake's float formatter reloads an 80-bit temporary on its protected-mode stack at 0xBD9EC0: the
load read 0xD9EC0 instead, normalised whatever sat in low memory, and emitted 8191 leading zeros down
through its own stack. The mask is now read per access.

2. **No System File Table.** DJGPP's `fstat` does not ask DOS for a size — it walks DOS's own SFT: INT
21h AH=52h for the List of Lists, then the SFT chain, then the PSP's job file table to map a handle to
an entry. We answered AH=52h with an MCB chain and no SFT, so `open` succeeded and `fstat` returned -1
(`Error fstating c:/id1/pak0.pak`). `src/dos.js` now keeps a live SFT. Its address was **measured, not
guessed**: `tools/sftprobe.asm` under DOSBox reports LoL at 0071:0026 with the SFT pointer at +04h, and
FreeDOS reports 00D8:0026 — same offsets, different segment.

3. **An empty game port that looked occupied.** Port 0x201 returned 0xF0 — buttons high, axis one-shots
reading 0. That is not "no joystick", it is a joystick whose one-shots already timed out.
`IN_ReadJoystick` accepted it, printed `JOYSTICK FOUND`, and parked in `WaitJoyButton` **before
`Host_Init` finished**: quake.rc was never executed, the command buffer never ran, and no frame was
ever drawn. The console still answered, because that modal runs its own key pump — which is why this
read for a while as a stalled demo loop rather than a stalled boot. Diagnosed by typing `echo hello`
at the console and getting the echo but no `hello`: `Cmd_Echo_f` has no guard, so silence placed the
fault upstream of `Cbuf_Execute`. An unconnected port floats high; 0xFF fixes it.

The float64 register model IS a real limitation of this engine — the first three constants in that
formatter's table load as Infinity — but it never stopped Quake, and an earlier version of this file
wrongly said it did. DOSBox-X on this arm64 Mac runs Quake with an 8-byte `long double`.

`-nocdaudio` is not a workaround for an emulation defect: there is genuinely no CD drive here, and
without it Quake stops on its own MSCDEX notice, which any keypress also clears.

**Chrome Revenge** (Abaddon, 1K, Assembly 2020) — ✅ **renders**: a realtime SSE raytracer in VESA 640x480x32. It needed three things, and only the first was the one we expected. (1) VBE 2.0, for mode 0x112. (2) Sixteen XMM instructions through SSE4.1 (`src/sse.js`, ROADMAP F1). (3) Two defects that had nothing to do with either: `FCOMI`/`FUCOMI` were no-ops — the only x87 compares that write EFLAGS — so its ray/sphere test always missed and the screen stayed black; and port 0x60 read back as 0, where the 8042 retains the last scancode, so `IN AL,60H / DAS / JC` ended the intro after a single frame. Both also improved existing goldens (`qblove`, `symetrie`). Verified against the author's own bundled screenshots: same scene, different animation phase.

**qblove** (Abaddon, 1K) — ✅ **renders its logo**, verified against the author's own pouet
screenshot. It had been in the golden set for months drawing a third of a screen of stripes, which
read as "renders" because nothing compared it to anything. It is NOT a Mode-X problem — measured:
it never writes a single VGA register, it is plain chained 13h from `INT 10h AX=0013`. The cause was
`fpu.js` having **no `DA` arm at all**, so `FCMOVB`/`FCMOVE`/`FCMOVBE`/`FCMOVU` and `FUCOMPP` were
no-ops — and `FUCOMPP` must POP TWICE, so the x87 stack drifted for everything after it. With
`FCMOVcc` implemented the intro goes from 34560 to 63822 non-zero pixels.

Most *famous* 4Ks (Elevated, fr-08, cdak) are protected-mode/Windows → out of scope for the
real-mode target. Mid-90s mode-13h party entries are the right hunting ground.

**Mirrors Within** (Digimind, 512b) — was rendering an entirely wrong picture (two ringed blobs on a grey diagonal, against DOSBox's two ellipses of nested shapes on black) because **FTST was a no-op**. It calls it 1.96 M times. 40.4% → 82.1% against DOSBox. ⚠️ `freality` carries a **pre-existing** `INT 00h` divide-error loop at 0814:09dd under `dosdiff` (present before the x87 work, unchanged by it) — not yet investigated.

**Forever Reality — divides by zero under a CRTC-derived 0x3DA beam.** Not shipped for that reason; see [notes/timing.md](notes/timing.md) §4. Its `CHESS.INC` computes `S = 33 - AX` from an x87 value and divides by it, so any pacing that lands AX on exactly 33 kills it. DOSBox-X runs it 45 s without exiting. Under the shipped (legacy) beam it is unaffected. Since 2026-09-02 an unhandled divide error TERMINATES the program the way DOS does rather than raising an engine error, so even when it happens the outcome is a program that ended, not a crash.

**Hocus Pocus — the x87 state work (2026-08-28) moved it from 13 to 97 matching DOSBox events.**
`dbx-oracle --sweep` compares event streams as an agreeing PREFIX, so the number is where the two
first disagree. `FTST` and `FXAM` were no-ops until then (they are in the batch that also fixed the
control word and the tag word), and `FTST` in particular passed its only oracle case by accident
because for x > 0 every condition code is zero either way. Wolf3D shifted too — 7 fewer events, same
248-event agreeing prefix. ⚠️ Caught late: that commit ran the unit, golden and Unicorn gates but not
the DOSBox sweep, and its message claimed the sweep was unchanged. It was not.

**pouët MS-Dos 4K top 10, swept 2026-08-28: 9/10 render, one blocked (Void 3, VESA).** Three of them
had been filed as engine failures and none was: two were *waiting on a keypress* they had asked for
in a printed message, and one is a text-mode game. The triage rule that follows: `probe-intro.js`
counts non-zero bytes in chained `A000`, which is silent about `B800` text and about EGA planes, and
"non-zero" is not "content" — a solid fill scores 64000/64000 and is a blank screen. Score frames by
DISTINCT values, read what the program PRINTS before it blocks, and check the released source when
there is one (`vesa?` looked like a prompt and is an error string).

#### Engine gap found by the Heaven trace: the `0x67` address-size prefix (FIXED, `7e1e162`)

v1 consumed `0x67` and then decoded the instruction with **16-bit** addressing — no 32-bit ModRM,
no **SIB** byte, no disp32. On 386 code that uses 32-bit addressing the byte stream
**desynchronises**, and everything after it is garbage.

Demonstrated with a planted 9-byte sequence `67 8D 04 80 | C1 E0 02 | 90 | F4`
(`LEA AX,[EAX+EAX*4]; SHL EAX,2; NOP; HLT` — 4 instructions): MIRAGE decoded **8 instructions
across 20 bytes**, emitting `LEA AX,[SI]` for `8D 04` and then treating the SIB byte `80` as the
next opcode.

How it kills Heaven: its runtime-generated code at `0100:1206` is `67 8D 04 80 …`. The mis-decode
makes that block write a bad word into the stack slot at `SS:0xE6B2` (traced: `0080 -> 5F6D`),
so the `RET` at `0100:12DE` returns to `0100:5F6D` — a field of zeros — which is executed as
`ADD [BX+SI],AL` for thousands of bytes until an `FF /5` (`JMP FAR [BX-1]`) lands in the IVT.

**Fixed** by implementing the prefix: 32-bit effective addresses (32-bit ModRM grid, SIB
scale/index/base, disp32, 32-bit base+index, SS default for ESP/EBP bases, moffs32 for A0-A3),
in `modrm()` + the address path. `test.js` has 11 targeted cases — each ends with
`mov bx,0x1234; hlt` so it asserts the decoded **length**, not just the value (the 8088
conformance vectors are 16-bit-only and cannot reach this class). Should help other 386-era
demos, not just Heaven.

## Games (in `games/`, gitignored; listed at C:\GAMES\ from `games/manifest.json`, and each one mounted AS C:\ while it runs)

| Game | Mode | Status |
|---|---|---|
| Cosmo's Cosmic Adventure | EGA 0Dh | ✅ renders (gameplay attract) — verified |
| Commander Keen 1 | EGA 0Dh | ✅ renders (High Scores, pixel-perfect) — verified |
| Commander Keen 4 | EGA 0Dh | ✅ renders (main menu) — verified |
| Bio Menace | EGA 0Dh | ✅ renders — verified |
| Commander Keen 3 | EGA 0Dh | ✅ renders (Apogee logo intro, pixel-perfect) — Vorticons engine confirmed on a 2nd episode |
| Duke Nukem 1 | EGA 0Dh | ✅ renders (credits screen: Todd Replogle / George Broussard / id Software) — clean |
| Prehistorik (Titus) | EGA 0Dh | ✅ **renders correctly** (title logo + caveman intro cutscene). The earlier rainbow speckle was **not** dithering — it was MIRAGE dropping the game's palette writes: Prehistorik repaints the 16 EGA attribute-controller registers via **INT 10h AH=10h AL=00**, which MIRAGE ignored (only AL=10/12 DAC were handled). Now AL=00/02 are honoured and a planar mode loads the 64 EGA colours into the DAC with the EGA-default palette registers (`bios.js`). Reach EGA via the C/E/V "Graphics Mode" menu: **Y** (dismiss "Computer Setup not detected"), then **E**, then RETURN. |
| Digger (Windmill, 1983) | CGA 4 | ✅ renders its title / high-scores (Nobbin + Hobbin), classic CGA palette — verified in-browser. |
| Lode Runner (1983) | CGA 4 | ✅ renders gameplay (brick platforms, ladders, gold, guards) — verified in-browser. |
| Golden Axe (1990 DOS) | text→? | ▶ **engine verified** (`gold.exe`) — loads and draws its graphics-mode menu ("1-EGA / 2-CGA/MCGA/Tandy / 3-Hercules / 4-VGA / 5-Tandy"). Reads the choice via its **own INT 9 handler** (hardware scancodes). Headless scancode injection didn't advance it past the menu (interactive; would work in the browser). |
| Arkanoid (Taito, 1986) | text→? | ▶ **engine fully verified** (`ARKANOID.COM`) — loads + draws its "C: CGA / E: EGA / T: TANDY" menu; keyboard reads work (INT 21h AH=07), and the **0x3DA vertical-retrace beam toggles correctly** (bit3 seen set ~5% of frames, its menu vsync-syncs 130k×). But no ASCII letter (`e/c/t/E`) triggers the mode-set — the menu likely navigates via **cursor keys + Enter** (it says so), a headless-input detail, not a MIRAGE bug. Would work in the browser. |
| Crystal Caves (Apogee) | EGA 0Dh | ✅ renders its full Apogee main menu over the alien-landscape background — verified in-browser. |
| Dangerous Dave in the Haunted Mansion | EGA 0Dh | ✅ renders gameplay (Dave + shotgun, the mansion, AMMO HUD) — verified in-browser. |
| Secret Agent (Apogee) | EGA 0Dh | ✅ **renders its title screen** (commit `0bd3d5a`). It printed *"This game requires an EGA or VGA Adapter!"* for **two** reasons, both found by a full single-step audit of the print path: **(1)** `INT 10h AH=1Ch` (video save/restore) was unimplemented, so the VGA probe (`CMP AL,1Ch`) failed while the `BL=32h` probe returned `AL=12h` → the game misdetected **MCGA** (which can't do EGA 16-colour) and refused. Now acknowledged with `AL=1Ch` so MIRAGE presents as VGA consistently. **(2)** The real gate: the game calls the video BIOS **inline** — reads the INT 10h vector from the IVT and `RETF`s straight into `f000:10` instead of executing `INT 10h` (`2dd7:000b`). MIRAGE's BIOS is JS-only (dispatched via `swInt` on the `INT` instruction); `f000:n` was a bare `0xCF` IRET stub, so the inline call did nothing and detection read garbage. The recompiler now emits `cpu.biosCallback(n)` when compiling a still-stubbed BIOS entry → the JS handler runs, then IRET. Engine sibling **Crystal Caves** also works. |
| **Protected-mode / DOS-extender games** | — | ⛔ **out of scope** — MIRAGE is a **real-mode** engine. Games that switch to 32-bit protected mode or ship a DOS extender can't run: **Doom**, **One Must Fall 2097** (both DOS/4GW — "Runtime error 001"/`RTM`), **Zone 66** (enters protected/unreal mode via `MOV CR0` with PE=1 → derails on a selector `CS=0008`). Getting Zone 66 that far needed the new `SMSW`/`MOV CR0` opcodes (`347383e`); the mode switch itself is unsupported. |
| Realms of Chaos (Apogee) | VGA Mode-X | ✅ **renders its title screen** (golden logo + sorceress/barbarian vs reptiles) — commit `8c19457`. Needed the new **XMS driver** (`xms.js`): it reported *"15360K XMS free"*, `CreatePageMap()` allocated 2560K, loaded its config, set up Sound Blaster music, and drew in Mode-X. The `e_maxalloc` fix also matters (its "near/far bytes free" checks). |
| Mystic Towers (Animation FX) | VGA 13h | ▶ detects hardware then exits after `INT 33h AH=00` (mouse reset) — needs a **mouse** (installed in the browser via `installMouse`, absent in the headless harness) and its **full data set** (only `RGMYSTUS.DAT` staged). Non-engine (browser + staging). |
| **XMS driver** (extended memory) | — | ✅ **implemented** (`xms.js`, INT 2Fh + `f000:0100` far-call entry). Backs XMS blocks with RAM above 1 MB (16 MB default); query-free / alloc / free (with reclaim) / lock / move / handle-info / A20. Unblocked **Realms of Chaos**. Registered **Wolf3D WL6** still fails its PML (*"Purged main block"*) even with XMS — a deeper WL6-specific memory layout (shareware WL1 renders). |
| Indiana Jones & the Last Crusade (LucasArts, SCUMM v3) | EGA 0Dh | ✅ **renders** (`INDY3.EXE`, DOS EGA) — reaches its "Insert Disk 1, Press ENTER" prompt, then draws the **Grail-Diary copy-protection screen** (the spiral notepad "translate the parchment for Brody… Section 2, Row 0, Column 7" + the runic Grail glyphs) — pixel-clean. SCUMM **v3** works (same as Loom); the SCUMM **v5** games (Fate of Atlantis, MI2) still spin. |
| Loom (LucasArts, SCUMM v3) | EGA 0Dh | ✅ **renders** (`LOOM.EXE`, floppy EGA) — its proficiency-select menu ("STANDARD / PRACTICE / EXPERT", "Refer to your Loom™ manual", mouse cursor) draws correctly. SCUMM **v3** works (contrast MI2 = SCUMM v5, which still spins). Interactive from here (mouse). |
| Ski or Die (EA) | text→EGA | ▶ **huge progress** — was an infinite loop at startup; `SKI.EXE` is a chain-loader that (1) sizes free memory by **walking the DOS MCB chain** directly, (2) reads the first-MCB via **INT 21h AH=52** (list of lists), and (3) loads the real game `SKIEGA` as an **overlay via INT 21h AH=4B AL=03**. All three were unimplemented; now added (MCB chain at PSP-1 + free block, AH=52, AH=4B AL=03 load-overlay). SKIEGA now runs: enters **EGA mode 0Dh**, loads its assets (`pcski.smb`, `ski2.bin`, `splash.lzw`), and programs palettes — then **spins in its splash decompression/render loop without drawing** (a deep SKIEGA-internal issue; likely a subtle overlay-relocation or decompress-completion detail — a co-sim/trace job). |
| Turbo Pascal 7.1 (Borland IDE) | text 03h | ▶ `TURBO.EXE` loads, runs CPU detection (needs `ARPL`/0x63), **prints its banner**, then **derails ~30M cycles into IDE init**: a bad control transfer sends execution into a **text buffer** (segment 3d10, attr `0x07`) which it runs as code until a stray `BOUND` byte fails and spins on INT 5. A **co-sim-class divergence hunt** (Wolf3D-class), not a single gate. `ARPL` left unimplemented — it makes a protected-mode intro spin during golden capture without unlocking TP. |
| Beneath a Steel Sky | VGA | Virtual Theatre engine, real-mode — a viable candidate, not yet downloaded/tested. |
| Word Rescue (Apogee) | EGA 0Dh | ✅ **renders** (`WR1.EXE`) — its "Karen Crowther / Bud Pembroke Production" credits card (pink Benny mascot) draws clean. Verified headless. |
| Math Rescue (Apogee) | EGA 0Dh | ✅ **renders** (`MR1.EXE`) — its starfield intro (coloured stars, spiral galaxies, ships). Verified headless. |
| Jazz Jackrabbit (Epic) | — | ⛔ **out of scope** — "DPMI error (4009)": uses a DOS extender / protected mode (like Doom, OMF, Zone 66). MIRAGE is real-mode only. |
| Pinball Fantasies (21st Century) | VGA (Mode-X) | ▶ **past its memory gate now** (commit `e11aafa`) — PF.EXE is a multi-stage launcher; MIRAGE's AH=4A only recognised the *first* program's PSP, so an EXEC'd child couldn't shrink its own block to free memory for the real game (nested EXEC failed -> "requires 555 kbytes"). Fixed AH=4A to recognise the *current* program's PSP (`seg === dos.psp`). Now the child frees memory, the nested EXEC succeeds, and the game runs + draws. Output is 4x-sheared because it uses **Mode-X (unchained VGA)** which MIRAGE renders as linear 13h — a separate VGA feature. |
| Monster Bash (Apogee) | EGA 0Dh | ✅ **renders** (`BASH1.EXE`) — its "NOT shareware" notice screen (monster/werewolf/kid sprites, ornate border) draws pixel-clean. Same engine family as Secret Agent; benefits from the inline-BIOS-call fix. Verified headless. |
| Dark Ages (Apogee) | EGA 0Dh | ✅ **renders** (`DA1.EXE`) — full main menu ("Prince of Destiny": Begin/Instructions/Story/Ordering/High scores/Quit) over a dithered stone-brick background. Verified headless. |
| Paganitzu (Apogee/Trilobyte) | text→EGA | ▶ **engine verified** (`PAGA1.EXE`) — renders its intro/credits text, DOS console input (INT 21h AH=07) works, and `1` passes its "select a graphics display" menu. Chains through several text menus (graphics → controller); the later menus need real interactive keys, so full gameplay needs the browser UI, not the headless harness. No rendering/CPU bug. |
| Arctic Adventure (Apogee) | CGA 4 | ✅ **renders its "Arctic Map" screen** (level map + Keys/Items/Score/Caves panel, decorative border) — commit `98c25f0`. The *"incomplete copy… or not enough memory"* bail was a **DOS-loader bug, not an integrity check**: `AA1.EXE`'s MZ header sets a **bounded `e_maxalloc` (0x216d)**, expecting DOS to give it a limited block and leave the rest free for `AH=48`. MIRAGE ignored `e_maxalloc` and handed every EXE *all* of RAM → the game's `AH=48` found 0 free and bailed. `loadEXE` now sizes the program block from `e_maxalloc` (EXEs that set 0xFFFF still get everything, unchanged). General fix. |
| Lemmings (DOS) | VGA/EGA | ✅ **derail ROOT-CAUSED + FIXED** (commit `2508d98`). The `0F 00` crash was **MIRAGE ignoring the Trap Flag**: both official releases use TF-based self-decryption (an `IRET` restores `flags=0x146`, TF set, so each instruction traps to an INT-1 handler at `0110:0dff` that decrypts the *next* instruction in place). With no TF single-step, the still-encrypted trampoline at `074f` ran as garbage → `RETF` popped `f000:0000` → `IRET` to `0000:0000` → executed the IVT until `0F 00` at offset `0x3c`. A single-step trace nailed the exact transfer; the co-sim had (correctly) exonerated the CPU core — TF is a *run-loop* feature its window sat past. Now honoured: ~1593 protection traps decrypt cleanly, no derail. **Remaining blocker (different layer):** this `LEMMING` release is a **disk-based game** — after decryption it reads its data via raw **INT 13h AH=02 floppy sector reads** (drive A), bypassing DOS files. With no floppy device it prints *"Lemmings Disk 1 Not found… Have a nice DOS!"* and exits gracefully. Needs a **virtual floppy (INT 13h + disk image)** to boot. |
| Major Stryker | VGA 13h | ✅ renders (Apogee title) — needed the tier-2 PIT fix |
| Hocus Pocus | VGA 13h | ✅ renders — needed the mid-slice PIT fix |
| Jill of the Jungle | VGA 13h | ✅ renders — verified |
| God of Thunder | VGA 13h | ✅ renders (IMPULSE intro) under tier-2 — ⚠️ the intro logo animates **very slowly** in the browser (see rough edges) |
| Alley Cat | CGA 4/5 | ✅ **playable** — title, front-end menus, and gameplay (the alley scene) all render + respond to input. Needed: keyboard hardware path, CGA graphics-mode BIOS text (`126c901`), and PIT counter-0 read `IN 0x40` (`e32b84c`) — its gameplay loop polls the countdown counter, and a constant reply froze it. |
| **Dune (Cryo)** — north star | VGA 13h | 🌅 **boots + plays its intro** (Virgin Games → CRYO, from the `.SQZ` resources, correct palette) in the **real-mode path** `DUNEDEM ENG VGA ADL`, now **at correct speed** (the PIT-reprogramming fix `c0c925c` — it drives counter 0 at ~200 Hz). The **enhanced path** `… HIM 386` faults on **`0F 00`** (protected mode / DPMI gap). Tried via the demo (`games/DUNE`, same engine). |
| Prince of Persia | VGA 13h | ✅ **renders its title screen** (the Persian arch + palace/desert). Was blocked by EXEPACK "Packed file is corrupt" — **FIXED** by the 1 MiB address wrap (A20 default off); the browser's 16 MiB buffer had no wrap, so the EXEPACK stub's segment arithmetic broke. Now identical to real hardware. |
| Maniac Mansion (Enhanced, SCUMM) | EGA 0Dh | ✅ **renders its title + character-select screen**. Needed two fixes: the 1 MiB address wrap (EXEPACK) and a DOS free-memory-reclaim fix — the SCUMM interpreter allocs a temp block, frees it (AH=49), then allocs its 384 KB heap; MIRAGE's AH=49 was a no-op so the freed block wasn't reclaimed → "Not Enough Free Memory. Program requires 384K". AH=48/49/4A now track live blocks and reclaim on free. First **SCUMM** game to run. |
| Monkey Island 2 (VGA, SCUMM v5) | VGA 13h | ✅ **renders** — `MONKEY2.EXE` draws its VGA copy-protection screen (the Dial-a-Pirate wheel halves over magenta, *"Press Enter to begin Lame-O copy protection."*), 61 730 non-zero bytes at A000. The earlier "spins in a 13-block compute loop" reading is **retracted**: re-measured 2026-08-22 under the *old* tick bound as well, it drew the same screen (61 713), so it was never spinning — the entry was stale. |
| Indiana Jones (SCUMM) | — | ⏸ not staged — archive.org blocked: Last Crusade zip node returns 500, Fate of Atlantis is a 170 MB CD or 5× FAT12 floppy `.img` (needs mtools). Retry later. |
| Monkey Island (EGA, SCUMM v5) | EGA 0Dh | ✅ **renders its title screen** ("The Secret of Monkey Island", the magenta logo over the starry island). Needed the 1 MiB wrap + free-reclaim fixes (past the earlier BOUND spin), correct timer pacing (`timerAuto=true`), and a real **Enter** keypress at its "Press ENTER to continue" (SCUMM reads the INT-9/scancode path, not the DOS buffer). Polls the mouse (INT 33h) in its main loop. **First SCUMM v5** — same engine as MI2 / Indy. **Headless renders it too since 2026-08-22**: `node tools/shot.mjs MONKEY monkey.exe 1600 out.png "" 1c,9c`. Two defects hid it — the BDA clock ran at the game's PIT rate (473 Hz) instead of 18.2 Hz, so a tick-bounded capture stopped 16x too early on a blank screen, and `shot.mjs` queued its KEYS without ever calling `pumpKeyboard`, so Enter was never delivered and it sat on "Press ENTER to continue…". |
| Blues Brothers (Titus, EGA) | EGA 0Dh | ✅ **playable** — renders its gameplay level (mall: STORE/STAGE, awnings, shopping cart, character, HUD with hearts + timer). It reprograms the PIT (`pitReload=0x4000`, ~73 Hz) and its logic is timer-paced. |
| Baby Jo: Going Home (Loriciel, EGA) | EGA 0Dh | ✅ **renders** its language-select screen (FR/UK/DE/ES flags, correct colours). Launch `BABY 2`. |
| Ski or Die (EA) | EGA | ⚠️ `SKI.EXE` (launcher) opened `skiega.` — a **trailing-dot filename** (`NAME.` = empty extension) that MIRAGE's VFS failed to match to the file `SKIEGA`; **fixed** (vfs.js `_split` strips trailing dots). It now finds `SKIEGA` (an MZ-EXE overlay) but stalls in its **custom overlay loader** (loads the MZ manually, not via INT 21h EXEC) — deeper, open. |

> 🧪 **Test-harness pitfall (learned the hard way):** a manual browser loop that calls `runSlice`
> then `tickTimer()` at an *arbitrary* cadence **starves timer-paced games of INT 8** (they reprogram
> the PIT and expect ticks at that rate). That mis-timing corrupts their timer logic and they **derail
> into the IVT** (`0F 00` at `0x3C`) — a **false** failure. Blues Brothers and Baby Jo "derailed" this
> way, then rendered perfectly once driven with `machine.timerAuto = true` (INT 8 at the programmed
> rate, like the real `ui.js` `_loop`). **Always test with `timerAuto=true` or the real loop.**
> Residual *genuine* issues after correct pacing: **Lemmings** derailed (`0F 00` at `0x3C`) — now
> **FIXED** via Trap-Flag single-step (`2508d98`; it self-decrypts under TF), leaving only a
> raw-floppy (INT 13h) disk-image blocker. (**Monkey Island**'s "draws only a sliver" was the
> BDA-clock and keyboard-pump pair above, fixed 2026-08-22.)
| QBasic | text/13h | ▶ renders its full IDE but ~16 s one-time compile warmup (1712 blocks × ~9.7 ms `new Function`); keyboard now reaches it via the INT-9 path |
| Wolf3D (shareware WL1 + registered WL6) | VGA Mode-X | ✅ **PLAYS** (re-verified 2026-09-09): signon screen, attract loop, High Scores, and its **played demo** — raycast world with the full HUD (FLOOR 7, SCORE 500, LIVES 3, HEALTH 100%, AMMO 8). ⚠️ The long-standing `PML_GetPageBuffer: Purged main block` was **a misattribution**, and this row said so for months: PML was never the defect. The root cause was **`FISTP m64` unimplemented in `src/fpu.js`** (`cd4e501`) — a silent x87 store that drifted the stack, surfacing first as a PML purge, then as a smashed stack, then as a corrupt CS. Each symptom was blamed in turn before the instruction was. Mode-X (unchained 320x200) is real and needed here; note the signon screen now reports JOYSTICK **absent**, which is the game port answering 0xFF (`7a1744a`) instead of impersonating a stick. |
| **DOOM** (id, 1993) | VGA 13h | ✅ **PLAYS** (verified 2026-09-09): the attract demo runs with the full status bar — *"PICKED UP A MEDIKIT."*, 100% health, 200% armor, the ammo counters. ⭐ **And it plays BOTH WAYS**: `DOOM.EXE` has DOS/4G bound in, and with `MIRAGE_NODPMI=1` — where `tools/dpmiq.asm` confirms we present no host at all, `AX=1687`, exactly the machine DOSBox-X presents — the game still plays. There is no VCPI anywhere in `src/` either, so the extender had neither DPMI nor VCPI and brought up protected mode itself on the raw XMS path. So MIRAGE runs the extender's own bring-up *and* offers a host here; **DOSBox-X provides no DPMI host** (measured: `AX=1687` unchanged), so it only ever exercises the former. ⚠️ **This is a Doom result, not a general one** — Heretic, the same DOS/4G, faults on that path (see its row). |
| **Heretic** (Raven/id, 1994) | VGA 13h | ✅ **PLAYS with our DPMI host** (verified 2026-09-09): the menu over a running demo, full status bar (LIFE 86, ARMOR 0). ⚠️ **But NOT without it** — with `MIRAGE_NODPMI=1` the bound DOS/4G enters protected mode on its own (`PE:1 PG:0`) and then faults: its own register dump, `ID 0D` (#GP) at `70:0000116D`. So the raw-XMS bring-up that works for Doom does **not** work here, and the host is load-bearing for this title. Since DOSBox-X provides no DPMI host at all (measured), anything that runs Heretic there runs it on exactly the path we fault on — worth checking, and a named defect rather than a mystery. |
| Raptor / Jazz Jackrabbit | — | ❌ need **DPMI/protected mode** (DOS/16M, DOS4GW). Pass 386 detection. |
| Halloween Harry | text | ❌ `HH1.EXE` is an 11 KB launcher (exits 255 after config I/O without a graphics mode). |

## Known rough edges (browser UX — seen in use, not yet fixed)

1. ~~CATALOG.EXE arrow-scroll + ESC colours~~ — **FIXED** (`6553340`): INT 10h AH=06/07 now honours
   the window rectangle (was scrolling the whole screen, wiping the header/footer) and the correct
   up/down direction; `shell.programReturned()` resets `bios.attr` to 0x07 so the prompt isn't left
   in a program's colour (CATALOG paints white-on-blue). Verified in-browser.
2. ~~Alley Cat post-title screen~~ — **FIXED** (`126c901`): it prints its joystick prompt / skill
   menu / instructions via INT 10h teletype **over CGA graphics mode 4**; the BIOS now renders those
   as 8×8 font glyphs into the bitmap (was writing text char/attr → garbage). The whole front-end
   renders and navigates with the keyboard now. (CGA graphics-mode BIOS text is a general new feature.)
3. ~~God of Thunder IMPULSE logo slow~~ + ~~Dune intro slow~~ — **FIXED** (`c0c925c`): both reprogram
   PIT counter 0 to a faster rate (Dune ~200 Hz, GoT ~140 Hz for the logo) and are timer-paced, but
   MIRAGE ignored PIT programming (fixed 18.2 Hz) → their animation ran ~8–11× too slow. MIRAGE now
   honours counter-0 reprogramming (`machine.setPitReload`; `ui.js` paces to the programmed rate).
4. **Prince of Persia "Packed file is corrupt"** in the browser only (EXEPACK; see table).
5. **Stale video mode across programs:** MIRAGE never resets to text mode when a program exits /
   the shell relaunches, so a program that doesn't set its own mode inherits the previous game's
   graphics mode/planar/colours. A "reset to mode 3 before launching a shell command" would fix a
   class of these (weigh against keeping a demo's final frame visible after it exits).

## Shell features

`DIR` supports wildcard filters (`DIR *.EXE`, `DIR \GAMES\*.DAT`) as of 2026-07-20. Builtins:
DIR CD CLS TYPE COPY DEL REN MD RD ECHO SET. Programs launched by name or `?run=…`.

## Tier-2 (region compiler) — OFF everywhere, opt-in

Tier-2 is **off everywhere**; `MIRAGE_TIER2=1` opts in (Node only) for work on it. Reason: on real
**games** a fused region can run unbounded work in one `runSlice` and hang the main thread (Cosmo's
decompression froze the tab), Wolf3D runs ~5× slower under it, and Keen once derailed on a
far-indirect pattern. Re-enabling needs a region **instruction-budget** (bail on retired-instruction
count, not just region-iterations) + fixing those game cases. Demos are byte-identical either way.

It used to be ON by default in Node and off in the browser, and that asymmetry cost more than it
looked. Every headless perf figure — `tools/bench.js`, the roadmap's targets — was measuring a
configuration that never shipped. And "unbounded work per slice" is not a corner case: `bench.js`
appeared to hang for **25 minutes** because `intros/memories.com` takes >300 s under tier-2 for work
tier-1 does in **8.5 ms**, a >30,000× cliff. Same bench, tier-1: 25 seconds, and now comparable to
what the browser actually runs.

> ⚠️ **Fast-timer games + the browser loop:** games reprogram PIT counter 0 to 200–1000 Hz. `ui.js`
> delivers **one INT 8 per runSlice iteration** (interleaved), never several back-to-back — `realInt`
> only pushes an interrupt frame (the ISR runs in the next runSlice), so firing many at once piled
> frames on the guest stack → underflow → hang. The rate is also capped (`setPitReload` floors at
> pitBase/16 ≈ 291 Hz).

## EXEC (INT 21h AH=4B) — loader-stub games

`dos.js` implements **AH=4B AL=00 (load + execute child)**: it saves the parent's full CPU
context, loads the child (COM/MZ) into free memory above the parent (which shrinks its own block
via AH=4A first), and switches to it; when the child terminates, `terminate()` pops the context
and resumes the parent right after its INT 21h (DOS's INT 22h return, without a real IRET). This
unblocks games that ship a tiny launcher `.COM` that EXECs the real binary. Also fixed: `tickTimer`
now wakes a `HLT` on the BIOS-default timer (a `STI;HLT` before the guest installs its own INT 8).

| Game | Status |
|---|---|
| **Moktar** (Titus, *Les Aventures de Moktar*) | VGA 13h | ✅ **renders its title screen** (Lagaf + camel + snake, ©1991 Titus) — commit `b40ae0a`. `MOKTAR.COM` EXECs `GAME.TDT`, wrapped in **E.Zmiro's protection**. Two fixes unblocked it: the **MCB chain** (its protection walks the MCBs — landed for Ski or Die), and a **HLT-wake**: `GAME.TDT` does `STI;HLT` between its decryption passes, but headless the cycle-based PIT freezes during HLT (cpu.cycles stops) so the timer never fires → deadlock. `runSlice` now advances to the next timer deadline and delivers the tick when halted with IF set (the PIT ticks through HLT on real hardware). Decryption completes and the game reaches **mode 13h**, loads `MENU.SQZ` etc., draws the title. |

## Known engine gaps (the frontier)

1. **DPMI / protected mode** — none. The single biggest gap: blocks Raptor, Jazz, Doom-class
   (DOS4GW), and advanced 64K demos. Real-mode games/≤4K demos do NOT need it.
2. ~~**EMS** — none~~ **DONE 2026-08-17** (`src/ems.js`, `58cc60b` + `b3e41fa`). LIM EMS 4.0 behind an
   `ems` option beside `xms`. The half that mattered was **detection**: programs find EMS by OPENING
   the character device `EMMXXXX0` and confirming bit 7 of IOCTL 4400h, **never** by reading the INT
   67h vector. Installed-but-undiscoverable EMS is worth nothing — Wolf3D's first divergence against
   the reference moved from file event #7 to #155 the moment the device existed.
3. **Audio** — SB/OPL are detection stubs only (no synthesis). Silent, but detection passes.
4. **Mode X / unchained VGA** — not implemented. No demo/game we currently have exercises it, but
   it's a genuine future need (Second Reality, some VGA action games). Would need a hand test.
6. **No MCB chain** — DOS memory is a bump allocator (now with free-reclaim), not a linked list of
   Memory Control Blocks. Games that *walk* the MCB chain (common in copy protection — Moktar's
   E.Zmiro kit) find no valid chain and take an anti-tamper path. A real MCB chain would fix that
   class.
5. **Frame-rate throttling** — the virtual CPU clock (`ui.js` `VCPU_HZ`) caps the guest to N
   cycles/second of wall-clock. It exists for code paced by neither the timer nor the retrace — the
   Commander Keen Vorticons menus and story scroll, which reprogram the PIT to 145.6 Hz but do
   **not** poll 0x3DA — which otherwise flies past.

   **It now defaults to `null` (uncapped)**, which is almost certainly too fast for period games —
   see the measurements below before changing it again.

   `demos/cpuspeed.asm` measures work completed per second of wall-clock, so MIRAGE and DOSBox can
   be compared in one unit instead of trusting that a MIRAGE "cycle" means what a DOSBox `cycles=`
   means (it roughly does: 3 MHz here ≈ `cycles=3000` there, within 20%):

   | configuration | work units in 3.02 s |
   |---|---|
   | DOSBox `cycles=auto` — **the default, and what archive.org serves** | 449 |
   | DOSBox `cycles=3000` | 449 |
   | MIRAGE capped at 3 MHz | 551 |
   | MIRAGE capped at 8 MHz (the old default) | 1333 |
   | DOSBox `cycles=20000` | 3015 |
   | MIRAGE **uncapped**, through the animation-frame loop (what you see) | 10622 |
   | DOSBox `core=normal cycles=max` — the **interpreter** | 14367 |
   | MIRAGE **uncapped**, engine flat out (no compositor share) | 14155 |
   | DOSBox `core=dynamic cycles=max` — its **recompiler** | 39936 |

   So MIRAGE is at **parity with DOSBox's interpreter (~99%)** and at **~35% of its dynamic core**.
   An earlier revision said "76% of DOSBox `cycles=max`", which compared against `core=normal`
   while calling it DOSBox, and handicapped MIRAGE with the loop's 12-of-16.7 ms share — two errors
   that partly cancelled. Caveat: this is one tight ALU loop on one Apple Silicon host, where
   `core=dynamic_x86` falls back (14373) so DOSBox is using its generic recompiler; it says nothing
   about memory, FPU or VGA-bound work.

   The correction that matters: DOSBox does **not** run these titles at full speed. `cycles=auto`
   means "3000 cycles/ms for real-mode programs, `max` only once a program enters protected mode" —
   so Keen Vorticons is playable on archive.org *because* it is throttled to ~3 M instructions/s.
   The old 8 MHz default was already 3× faster than that, and uncapped is ~24×. An earlier revision
   of this file claimed the opposite and used it to justify uncapping; it was wrong.

   The knob stays reachable — `?mhz=8`, or `new Mirage(canvas, { vcpuHz })`.

   The 0x3DA beam no longer derives from `VCPU_HZ`: with no cap, cycles are not proportional to wall
   time, so `bios.js` anchors the beam to `machine.wallClockMs` (real 70 Hz however fast the engine
   runs). Timer-paced games (Dune/Cosmo/GoT) were always unaffected — their animation is gated by
   the wall-clock INT 8. Headless tools set no wall clock and keep the pitBase-derived beam, so
   golden fingerprints are unchanged.

   ⚠️ Still to verify: how Keen Vorticons actually behaves uncapped, side by side with DOSBox.

## Fixes this frontier came from (recent)

- **BIOS ROM identity at the top of F000 (`beb766d`, 2026-08-19):** F000:FFF0 far JMP, FFF5 the
  8-byte release date, FFFE the model byte, FFFF the submodel — read off the reference with
  `tools/biosid.asm`, not invented. Ours held zeros; **Turbo Pascal** scans that region, ran clean off
  the end of memory, wrapped past 1 MB and executed the interrupt vector table. It now runs (24 M
  cycles and going, against a fault at 0.1 M). Found with the co-sim.
- **INT 10h AH=05h moves the CRTC display start (`225c677`, 2026-08-18):** we recorded the page number
  in the BDA and nothing else, so a game drawing to the hidden page showed page 0 for ever. Baby Jo
  alternates pages 1375 times each through this call.
- **Transfers stop at the segment end; DOS handles are reused (`50a326e`, 2026-08-18):** AH=3Fh/40h
  ran past 64 KB where DOS truncates (Keen asks for a hard-coded 0FFFFh into a buffer at offset 4),
  and the handle counter was monotonic, so numbers climbed past the 20-entry table DOS gives a
  program and Keen leaked a handle it never closed. **Keen 1 is now event-exact** against the
  reference on all three channels.
- **INT 21h AH=50h/51h (`4cdd8a7`, 2026-08-17):** set/get current PSP, found by diffing the corpus's
  whole INT 21h surface against `src/dos.js`. `AH=31h` and `AH=5Dh` are still missing (Jazz).

- **1 MiB address wrap + A20 gate (`76d0e90`, 2026-08-01):** real-mode addresses now wrap at 1 MiB
  regardless of installed RAM (was `size-1`, so the browser's 16 MiB had no wrap while headless's
  1 MiB did). Fixes EXEPACK "Packed file is corrupt" → **Prince of Persia** renders. Port 0x92 opens
  A20 for HMA. Also aligns browser ↔ headless behaviour.
- **DOS free-memory reclaim (`38c2c5c`, 2026-08-01):** AH=49 was a no-op; now AH=48/49/4A track live
  blocks and reclaim on free → the SCUMM interpreter's alloc-temp/free/alloc-heap pattern works.
  **Maniac Mansion** (first SCUMM game) renders.
- **EGA palette registers INT 10h AH=10h AL=00/02 (`adc9762`, 2026-08-01):** were unimplemented
  (only DAC AL=10/12); a planar mode now loads the 64 EGA colours into the DAC with the EGA-default
  registers, and games can repaint them → **Prehistorik** colours correct (the "rainbow dither" was
  dropped palette writes).
- **INT 21h AH=4B EXEC + HLT-wake (`fae7ec1`, 2026-08-01):** load-and-run child programs (parent
  context saved/restored on the child's exit); `tickTimer` wakes a HLT on the BIOS-default timer.
  Loader-stub games (Moktar's `MOKTAR.COM` → `GAME.TDT`) now launch the child.
- **BDA 0040:0063 CRTC base port (`1bacf8d`, 2026-08-01):** was 0; programs read it + add 6 for the
  0x3DA retrace port → **Lemmings** no longer polls a dead port 6.
- **Virtual CPU clock (`92e4741`, 2026-08-01):** browser-only throttle (see gap #5) → Keen menus no
  longer fly by.
- **Keyboard hardware path (`acaf40f`, 2026-07-20):** the browser fed only the INT 16h buffer;
  now feeds make/break scancodes to the INT-9/port-0x60 path too → games receive input.
- **DIR wildcards (`2d461bf`, 2026-07-20).**
- `push dword imm` / `FF /6 PUSH` operand-size → Wolf3D past its derails (co-sim).
- Cycle-based **PIT timer** mid-slice + tier-2 `cpu.deadline` safepoint → Hocus/Stryker/GoT render.
- Time-based **0x3DA beam**; INT 10h **AH=1Ah** DCC → God of Thunder renders.
- **CGA renderer** (`video.js:_renderCGA`) + 0x3D9 colour-select → Alley Cat title renders.
- **EGA planar** path (`vga.js`) + CRTC scroll → Keen/Cosmo/PoP-intro/Stryker render.
