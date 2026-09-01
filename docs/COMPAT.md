# MIRAGE — Compatibility Status

A living record of what runs and what's blocked, so a future session starts from the known
frontier instead of re-surveying. Update it when you unblock something.

> ⚠️ When probing a game headless, check the **right framebuffer**: mode 13h → `mem.u8[0xa0000]`;
> **EGA planar (mode 0xD) → `machine.vga.planes`** (linear A000 is empty); **CGA (4/5/6) → B800
> interleaved banks**. Getting this wrong once cost a whole mis-diagnosis.

> 🧪 **Headless game runner:** `node tools/run-game.mjs <subdir> <PROG.EXE> [frames] [keysHexCSV]`
> mounts a whole `games/<subdir>` into the VFS, runs the program, and reports mode(0x449)/planar/
> cga/faults/framebuffer-occupancy + any B800 text. Feed keys as make/break hex (e.g. `39,b9` =
> space). This is the fast path for "what mode did it set / why is the screen wrong".

> 🖥️ **Browser rAF is throttled under preview automation** (tab treated as hidden → the run loop
> stalls). To drive frames from `javascript_tool`: loop `mirage.machine.pumpKeyboard(); mirage.
> machine.runSlice(20000);` then `mirage.machine.tickTimer(); mirage.video.render();`. Synthetic
> `KeyboardEvent`s dispatched on `window` DO reach `keyboard.js`; the automation `type` action does not.

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
| Realms of Chaos (Apogee) | VGA Mode-X | ✅ **renders its title screen** (golden logo + sorceress/barbarian vs reptiles) — commit `48177bf`. Needed the new **XMS driver** (`xms.js`): it reported *"15360K XMS free"*, `CreatePageMap()` allocated 2560K, loaded its config, set up Sound Blaster music, and drew in Mode-X. The `e_maxalloc` fix also matters (its "near/far bytes free" checks). |
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
| Pinball Fantasies (21st Century) | VGA (Mode-X) | ▶ **past its memory gate now** (commit `11b610d`) — PF.EXE is a multi-stage launcher; MIRAGE's AH=4A only recognised the *first* program's PSP, so an EXEC'd child couldn't shrink its own block to free memory for the real game (nested EXEC failed -> "requires 555 kbytes"). Fixed AH=4A to recognise the *current* program's PSP (`seg === dos.psp`). Now the child frees memory, the nested EXEC succeeds, and the game runs + draws. Output is 4x-sheared because it uses **Mode-X (unchained VGA)** which MIRAGE renders as linear 13h — a separate VGA feature. |
| Monster Bash (Apogee) | EGA 0Dh | ✅ **renders** (`BASH1.EXE`) — its "NOT shareware" notice screen (monster/werewolf/kid sprites, ornate border) draws pixel-clean. Same engine family as Secret Agent; benefits from the inline-BIOS-call fix. Verified headless. |
| Dark Ages (Apogee) | EGA 0Dh | ✅ **renders** (`DA1.EXE`) — full main menu ("Prince of Destiny": Begin/Instructions/Story/Ordering/High scores/Quit) over a dithered stone-brick background. Verified headless. |
| Paganitzu (Apogee/Trilobyte) | text→EGA | ▶ **engine verified** (`PAGA1.EXE`) — renders its intro/credits text, DOS console input (INT 21h AH=07) works, and `1` passes its "select a graphics display" menu. Chains through several text menus (graphics → controller); the later menus need real interactive keys, so full gameplay needs the browser UI, not the headless harness. No rendering/CPU bug. |
| Arctic Adventure (Apogee) | CGA 4 | ✅ **renders its "Arctic Map" screen** (level map + Keys/Items/Score/Caves panel, decorative border) — commit `98199c7`. The *"incomplete copy… or not enough memory"* bail was a **DOS-loader bug, not an integrity check**: `AA1.EXE`'s MZ header sets a **bounded `e_maxalloc` (0x216d)**, expecting DOS to give it a limited block and leave the rest free for `AH=48`. MIRAGE ignored `e_maxalloc` and handed every EXE *all* of RAM → the game's `AH=48` found 0 free and bailed. `loadEXE` now sizes the program block from `e_maxalloc` (EXEs that set 0xFFFF still get everything, unchanged). General fix. |
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
| Wolf3D (shareware WL1 + registered WL6) | VGA Mode-X | ✅ **renders its PC-13 signon screen** (id Software + Apogee logos, "Wolfenstein 3-D ©1992", AVAILABLE MEMORY MAIN/EMS/XMS, the MOUSE/JOYSTICK/ADLIB/SB detection list) — commit `51e859f`. Two blockers fell this session: (1) the **PML memory manager** now allocates instead of purging, unblocked by the **MCB chain** (`2d85ee3`) + **AH=4A child-PSP** (`e11aafa`); (2) it draws in **Mode-X (unchained 320×200, "Mode Y")**, now implemented — the recompiler routes A000 through the plane pipeline when chain-4 is off (SEQ reg 4 bit 3), and a 256-colour Mode-X renderer assembles pixels from the 4 planes (`vga.js`/`video.js`). Still compile-bound slow (~50×; a separate perf item). |
| Raptor / Jazz Jackrabbit | — | ❌ need **DPMI/protected mode** (DOS/16M, DOS4GW). Pass 386 detection. |
| Halloween Harry | text | ❌ `HH1.EXE` is an 11 KB launcher (exits 255 after config I/O without a graphics mode). |

## Known rough edges (browser UX — reported by the user, not yet fixed)

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
| **Moktar** (Titus, *Les Aventures de Moktar*) | VGA 13h | ✅ **renders its title screen** (Lagaf + camel + snake, ©1991 Titus) — commit `a41cd10`. `MOKTAR.COM` EXECs `GAME.TDT`, wrapped in **E.Zmiro's protection**. Two fixes unblocked it: the **MCB chain** (its protection walks the MCBs — landed for Ski or Die), and a **HLT-wake**: `GAME.TDT` does `STI;HLT` between its decryption passes, but headless the cycle-based PIT freezes during HLT (cpu.cycles stops) so the timer never fires → deadlock. `runSlice` now advances to the next timer deadline and delivers the tick when halted with IF set (the PIT ticks through HLT on real hardware). Decryption completes and the game reaches **mode 13h**, loads `MENU.SQZ` etc., draws the title. |

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

## Windows 3.0 (real / standard / 386 enhanced)

`tools/win30-install.mjs` builds a runnable tree from the four install floppies without SETUP (the
files are SZDD-compressed; `WIN.COM` is `WIN.CNF` + `VGALOGO.LGO` + `VGALOGO.RLE` concatenated).
Disks and tree live under `boot/`, gitignored.

| Mode | Where it gets |
|---|---|
| `win /r` (real) | loads and EXECs **KERNEL.EXE**, switches to **mode 0x12 (VGA 640x480x16 planar)**, then stops on *"Incorrect DOS version: DOS 3.1 or greater required."* AH=30h is correct for both AL=0 and AL=1; the last INT 21h calls before the refusal are `34h, 35h/21h, 35h/2Fh, DCh, 30h/01h`, so what it validates through the InDOS flag and the 21h/2Fh vectors is where to look. |
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
present, the **takeover** is what fails. The INT 2Fh trail ends `4300 / 4310 / 4310 / 1606`: it finds
the XMS driver, asks twice for its entry point, and then broadcasts 1606h (Windows exiting). **It
never calls that entry point** — no XMS call reaches our dispatch at all — so it is failing before
the call, at the point where it wants the driver's real-mode CODE to map into each VM.

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

## Dune (Cryo) — SOLVED, 2026-08-25 (ROADMAP C3)

**Dune's intro renders**, in its full `DUNEDEM ENG VGA ADL HIM 386` path — the Cryo logo, then the
desert, then Feyd-Rautha and his Harkonnen guards, animating instead of freezing. One engine bug was
behind all of it, and the chain from that bug to the pixels is worth keeping.

### The bug

A **hardware** interrupt handler owes the interrupted instruction its flags byte for byte; only a
**service** reports back through the flags image on the stack. `machine.js`'s `biosCallback` carried
the handler's arithmetic flags back for *both*. That rule had been added for a real reason — a TSR
that hooks INT 21h and chains to the saved vector comes through this path, and restoring the caller's
flags verbatim threw away every error the service reported — but it was applied one class too wide.

Dune's HSQ decompressor reads its bit stream as `shr bp,1` / `jnz` / `rcl cx,1`: the carry crosses an
instruction boundary. A timer tick landing on that boundary came back with the handler's carry, so
`rcl` shifted in a 0 where the stream said 1, and a match length of 3 became 2.

Fixed by excluding vectors 0x08-0x0F, 0x70-0x77 and 0x1C. Regression test in `tools/test.js`
(it fails without the fix); 189 tests, 36 goldens, conformance 555764/555764 all green.

### The chain, from one bit to the screen

One short copy corrupted `SHAI2.SQZ` from output byte **0x3334** onward — 40 918 of its 62 626 bytes.
That resource is a bank of 20 sprites behind a word table at `5d3b:0002`. Records #16, #18 and #19
came out as `f9 01 00 00` where the file says `02 00 01 00`: **height 0** instead of 1. A real sprite
has bit 15 set in its first word, which sends it down the `js 0xdc3` path at `23a2:0d9b`; a positive
one falls through to `23a2:0dba`, where `xor ch,ch` makes `CX` the row count, and reaches the blitter
at `23a2:12bc`. Dune's blitter has no `jcxz`, so `loop` ran **65 536** times, `DI` walked past the
64 000-byte buffer and wrapped the segment. That single call was both the noise bands at the top and
bottom of the screen and the frozen frame.

### How it was found, and what wasted time

`tools/hsq.mjs` is the oracle that cracked it: an independent HSQ decompressor to say what a resource
*must* contain. Two things about it are worth remembering.

- **Transcribe, do not infer.** Every attempt to deduce the format from outside failed. Reading Dune's
  own routine at `0824:bc29` gave it in ten minutes — including the detail that the `shr bp,1 / jz`
  queue throws away the shift that empties it, so returning that sentinel as data yields 17 bits per
  word and desynchronises everything.
- **The obvious check was vacuous.** "32/32 files decompress to exactly the declared size" proves
  nothing: the loop is bounded by that size, so it always reaches it unless it stops early. The honest
  check is INPUT consumption — a correct decode ends exactly 3 bytes short of the file.

Dead ends, all refuted by measurement rather than argument: file I/O (16/16 reads byte-exact), the XMS
driver (14/14 moves byte-exact, and the intro never reads extended memory back), self-modifying-code
invalidation (flushing the cache before *every* block gives a bit-identical run), interrupt phase,
dead-flag elimination (`MIRAGE_NOSTRIP=1` changes nothing) and tier-2 regions (off by default).

Two measurement traps cost a pass each: Dune's INT 8 handler at `0824:b8e0` saves neither BX, CX nor
DX, so a range-based "execution entered the blitter" detector counts every IRET back into a running
blit as a fresh call; and `0824:bc63` is only a block start for LONG matches, so a probe anchored
there sees no short match at all.

⚠️ `tools/dosdiff.js` can stage a whole game directory now (`DDEXE` / `DDTAIL`), but it still cannot
capture Dune: `grabber.asm` is a TSR on INT 8 and Dune takes INT 8.

⚠️ `DUNE.BAT` passes `ENG VGA ADL HIM 386`, and `tools/corpus.mjs` takes the entry point from a `.BAT`
but **not its arguments**, so the corpus runs Dune bare — as does the oracle's DOSBox side.

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
