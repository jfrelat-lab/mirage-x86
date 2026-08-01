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
| Secret Agent (Apogee) | text→EGA | ⚠️ `SAM1.EXE` loads + runs (CPU active, paints a background) but **stalls before its menu** under scripted input — a config/keyboard-wait quirk shared with its engine sibling Crystal Caves. Normal launch is via `CHOICE.EXE`/`run.bat`. |
| Lemmings (DOS, THG release) | VGA/EGA | ⚠️ **partial** — root cause of the original hang/derail found + fixed: it reads the **CRTC base port from BDA `0040:0063`** and adds 6 to get the retrace register (`0x3DA`), but MIRAGE left `0x463` = **0**, so it polled a dead port 6 (hang) or, on other timing, executed data → `0F 0C`. BIOS now sets `0x463 = 0x3D4` (`bios.js`). Must be launched with the mode arg the launcher (`LEMMINGS.BAT`) passes: **`VGALEMMI /v`** (VGA) or **`/e`** (EGA — so this *is* an EGA-capable binary). Headless it now runs its init and exits cleanly; a **residual timing-sensitive derail** (`0F 0C`, executing data at `0110:0102`) still hits in the browser path only — a retrace-calibration divergence, not yet root-caused (co-sim uses deterministic timing that doesn't reproduce it). |
| Major Stryker | VGA 13h | ✅ renders (Apogee title) — needed the tier-2 PIT fix |
| Hocus Pocus | VGA 13h | ✅ renders — needed the mid-slice PIT fix |
| Jill of the Jungle | VGA 13h | ✅ renders — verified |
| God of Thunder | VGA 13h | ✅ renders (IMPULSE intro) under tier-2 — ⚠️ the intro logo animates **very slowly** in the browser (see rough edges) |
| Alley Cat | CGA 4/5 | ✅ **playable** — title, front-end menus, and gameplay (the alley scene) all render + respond to input. Needed: keyboard hardware path, CGA graphics-mode BIOS text (`126c901`), and PIT counter-0 read `IN 0x40` (`e32b84c`) — its gameplay loop polls the countdown counter, and a constant reply froze it. |
| **Dune (Cryo)** — north star | VGA 13h | 🌅 **boots + plays its intro** (Virgin Games → CRYO, from the `.SQZ` resources, correct palette) in the **real-mode path** `DUNEDEM ENG VGA ADL`, now **at correct speed** (the PIT-reprogramming fix `c0c925c` — it drives counter 0 at ~200 Hz). The **enhanced path** `… HIM 386` faults on **`0F 00`** (protected mode / DPMI gap). Tried via the demo (`games/DUNE`, same engine). |
| Prince of Persia | VGA 13h | ✅ **renders its title screen** (the Persian arch + palace/desert). Was blocked by EXEPACK "Packed file is corrupt" — **FIXED** by the 1 MiB address wrap (A20 default off); the browser's 16 MiB buffer had no wrap, so the EXEPACK stub's segment arithmetic broke. Now identical to real hardware. |
| Maniac Mansion (Enhanced, SCUMM) | EGA 0Dh | ✅ **renders its title + character-select screen**. Needed two fixes: the 1 MiB address wrap (EXEPACK) and a DOS free-memory-reclaim fix — the SCUMM interpreter allocs a temp block, frees it (AH=49), then allocs its 384 KB heap; MIRAGE's AH=49 was a no-op so the freed block wasn't reclaimed → "Not Enough Free Memory. Program requires 384K". AH=48/49/4A now track live blocks and reclaim on free. First **SCUMM** game to run. |
| Monkey Island (EGA, SCUMM v5) | EGA 0Dh | ✅ **renders its title screen** ("The Secret of Monkey Island", the magenta logo over the starry island). Needed the 1 MiB wrap + free-reclaim fixes (past the earlier BOUND spin), correct timer pacing (`timerAuto=true`), and a real **Enter** keypress at its "Press ENTER to continue" (SCUMM reads the INT-9/scancode path, not the DOS buffer). Polls the mouse (INT 33h) in its main loop. **First SCUMM v5** — same engine as MI2 / Indy. |
| Blues Brothers (Titus, EGA) | EGA 0Dh | ✅ **playable** — renders its gameplay level (mall: STORE/STAGE, awnings, shopping cart, character, HUD with hearts + timer). It reprograms the PIT (`pitReload=0x4000`, ~73 Hz) and its logic is timer-paced. |
| Baby Jo: Going Home (Loriciel, EGA) | EGA 0Dh | ✅ **renders** its language-select screen (FR/UK/DE/ES flags, correct colours). Launch `BABY 2`. |
| Ski or Die (EA) | — | ⚠️ `SKI.EXE` exits early (loader/config — 13 KB stub, not yet diagnosed). |

> 🧪 **Test-harness pitfall (learned the hard way):** a manual browser loop that calls `runSlice`
> then `tickTimer()` at an *arbitrary* cadence **starves timer-paced games of INT 8** (they reprogram
> the PIT and expect ticks at that rate). That mis-timing corrupts their timer logic and they **derail
> into the IVT** (`0F 00` at `0x3C`) — a **false** failure. Blues Brothers and Baby Jo "derailed" this
> way, then rendered perfectly once driven with `machine.timerAuto = true` (INT 8 at the programmed
> rate, like the real `ui.js` `_loop`). **Always test with `timerAuto=true` or the real loop.**
> Residual *genuine* issues after correct pacing: **Lemmings** still derails (`0F 00` at `0x3C`) and
> **Monkey Island** (SCUMM v5) draws only a sliver — both need their own diagnosis.
| QBasic | text/13h | ▶ renders its full IDE but ~16 s one-time compile warmup (1712 blocks × ~9.7 ms `new Function`); keyboard now reaches it via the INT-9 path |
| Wolf3D (registered WL6) | VGA 13h | ⚠️ ISR-install derail FIXED (`0d7c2b3`); now exits its paged memory manager (`PML_GetPageBuffer: Purged main block`). Shareware WOLF3DSW staged to test as it fits conventional memory. See [wolf3d_diagnosis] memory. |
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
| **Moktar** (Titus, *Les Aventures de Moktar*, same engine as Prehistorik) | ⚠️ `MOKTAR.COM` (344 B) EXECs `GAME.TDT` — **EXEC works, the child loads + runs** (STI/HLT, stack setup, hundreds of instructions). But `GAME.TDT` is wrapped in **E.Zmiro's "Best Protection Kit"**, which derails into the IVT (executes low memory as code → hits `0F`-less opcode `0x63`/ARPL at linear `0x18C`). Likely walks the DOS **MCB chain** (MIRAGE has a bump allocator, no MCBs) and jumps to an anti-tamper path on mismatch. A cracked/un-protected release, or an MCB chain, would be needed. |

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
