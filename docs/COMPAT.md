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
upup`. `memories`/`tube`/`kaneda` exercise the FPU path. `256bytef intoanew memories` are
timer-paced (a phase shift on timing changes is a golden re-bless after visual check, not a
regression). **Mars** (Tim Clarke voxel landscape, 8K MZ-EXE) renders + steers via INT 33h mouse.

## Games (in `games/`, gitignored; mounted at C:\GAMES\ from `games/manifest.json`)

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
| Realms of Chaos / Mystic Towers (Apogee) | VGA 13h | ⛔ **need EMS/XMS memory** (MIRAGE has none). ROC prints *"DetectVGA()…VGA present / Not enough memory: You need at least 640K of EMS or XMS free. Try installing HIMEM.SYS"* and waits at "Press any key". Mystic (Animation FX) detects hardware (finds the Sound Blaster), then exits wanting extended memory. Blocked on a real **XMS/EMS driver** (INT 2Fh/67h + backing memory above 1 MB) — a moderate feature, would also help other 1993-94 games. |
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
| Monkey Island 2 (VGA, SCUMM v5) | VGA 13h | ⚠️ `MONKEY2.EXE` reaches **VGA mode 13h** and opens its `.000/.001` resources, then **spins in a 13-block compute loop** (`10bf:xxxx`, no I/O / no input) — likely resource decompression or a stuck loop in the SCUMM v5 **VGA** path (MI1's EGA path renders). Open. |
| Indiana Jones (SCUMM) | — | ⏸ not staged — archive.org blocked: Last Crusade zip node returns 500, Fate of Atlantis is a 170 MB CD or 5× FAT12 floppy `.img` (needs mtools). Retry later. |
| Monkey Island (EGA, SCUMM v5) | EGA 0Dh | ✅ **renders its title screen** ("The Secret of Monkey Island", the magenta logo over the starry island). Needed the 1 MiB wrap + free-reclaim fixes (past the earlier BOUND spin), correct timer pacing (`timerAuto=true`), and a real **Enter** keypress at its "Press ENTER to continue" (SCUMM reads the INT-9/scancode path, not the DOS buffer). Polls the mouse (INT 33h) in its main loop. **First SCUMM v5** — same engine as MI2 / Indy. |
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
> raw-floppy (INT 13h) disk-image blocker — and **Monkey Island** (SCUMM v5) draws only a sliver.
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

## Tier-2 (region compiler) — browser-OFF

Tier-2 is **off in the browser** (`recompiler.js`: `typeof process !== 'undefined'`) and **on in
Node** (tests/golden/fuzzers still exercise it; `MIRAGE_NOTIER2=1` disables). Reason: on real
**games** a fused region can run unbounded work in one `runSlice` and hang the main thread (Cosmo's
decompression froze the tab), Wolf3D runs ~5× slower under it, and Keen once derailed on a
far-indirect pattern. Re-enabling needs a region **instruction-budget** (bail on retired-instruction
count, not just region-iterations) + fixing those game cases. Demos are byte-identical either way.

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
2. **EMS/XMS** — none. Some games probe for it; most degrade. (Wolf3D WL6's PML wants memory.)
3. **Audio** — SB/OPL are detection stubs only (no synthesis). Silent, but detection passes.
4. **Mode X / unchained VGA** — not implemented. No demo/game we currently have exercises it, but
   it's a genuine future need (Second Reality, some VGA action games). Would need a hand test.
6. **No MCB chain** — DOS memory is a bump allocator (now with free-reclaim), not a linked list of
   Memory Control Blocks. Games that *walk* the MCB chain (common in copy protection — Moktar's
   E.Zmiro kit) find no valid chain and take an anti-tamper path. A real MCB chain would fix that
   class.
5. ~~**Frame-rate throttling**~~ — **addressed in the browser** (`ui.js`): a virtual CPU clock
   (`VCPU_HZ`, ~8 MHz ≈ a fast 386) caps the guest to N cycles/second of wall-clock, so code whose
   pace is bound by raw CPU speed rather than the timer/retrace (e.g. the Commander Keen Vorticons
   menus/story scroll, which wait on neither — it reprograms the PIT to 145.6 Hz but does **not**
   poll 0x3DA) no longer flies by. The 0x3DA beam is derived from `VCPU_HZ` (bios.js) so vertical
   retrace stays a real 70 Hz. Timer-paced games (Dune/Cosmo/GoT) are unaffected (their animation
   is gated by the wall-clock INT 8). Headless tools (no `vcpuHz`, deterministic `timerAuto`) keep
   the pitBase-derived beam, so golden fingerprints are unchanged. `VCPU_HZ` is a single tunable
   constant — lower it toward ~3–4 MHz to match a slower period machine (e.g. archive.org's DOSBox).

## Fixes this frontier came from (recent)

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
