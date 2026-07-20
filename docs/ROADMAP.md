# MIRAGE — Roadmap (candidate tasks to choose from)

North star: run **Dune (Cryo)** and **Second Reality** accurately, in pure JS, "précision et
vitesse". This is a menu, not a plan — pick what's next. Effort: **S** ≤ half a session, **M** ≈
one focused session, **L** = multi-session. Each notes what it unblocks. See [COMPAT.md](COMPAT.md)
for current status and [ARCHITECTURE.md](ARCHITECTURE.md)/[RECOMPILER.md](RECOMPILER.md) for how.

## A · Correctness & browser UX (small, high polish-per-hour)

| # | Task | Effort | Why / unblocks |
|---|---|---|---|
| A1 | **Reset video mode/attributes to text (mode 3) when the shell launches a program** (and/or on program exit) | S | Fixes CATALOG's "ESC doesn't reset colours" and the general "next program inherits the last game's graphics mode" class. Weigh vs keeping a demo's final frame visible → reset on *launch*, not exit. |
| A2 | **CATALOG.EXE arrow-key scrolling** — trace how it reads arrows (INT 16h vs INT 9) and why scrolling misbehaves | S–M | Confirms the keyboard extended-key/auto-repeat behaviour is right for text apps; likely shared with other menu-driven programs. |
| A3 | **Alley Cat post-title screen** (renders mostly black) | M | First CGA *gameplay* (not just title); exercises CGA mode switches + the new keyboard path end-to-end. |
| A4 | **God of Thunder IMPULSE logo slowness** | M | Perf/pacing on a real mode-13h intro; feeds the throttling question (B5) and the perf phase (D). |
| A5 | **Extended-key (E0) scancodes** for arrows/navigation (currently mapped to bare XT codes) | S | Some later games distinguish grey arrows from the numpad; low risk to add behind the physical-code map. |

## B · Game compatibility features (the big levers)

| # | Task | Effort | Why / unblocks |
|---|---|---|---|
| B1 | **PoP browser "Packed file is corrupt"** — EXEPACK works headless but not in-browser; diff `memSize`/residual state | S–M | Unblocks Prince of Persia specifically, and any EXEPACK'd program in-browser (very common early-90s). |
| B2 | **Wolf3D PML memory manager** (`PML_GetPageBuffer: Purged main block`) — test shareware WL1, co-sim vs EMS/XMS expectations | M–L | The last blocker for a landmark title; likely needs B3. |
| B3 | **EMS/XMS** (INT 67h / HIMEM) | M | Wolf3D and other games probe/need it; degrades gracefully today but blocks some. |
| B4 | **DPMI / protected mode** (DOS/16M, DOS4GW) | L | *The* single biggest gap — Raptor, Jazz, Doom-class, advanced 64K demos. Foundational for the north star beyond Dune's real-mode parts. |
| B5 | **Frame-rate throttling** (execute ~one real frame of cycles per tick) | M | Makes timing-sensitive demos/games behave; makes HLT-wake-on-timer safe; would help A4. |
| B6 | **Mode X / unchained VGA** | M | Second Reality and some VGA action games; needs a hand-authored test (nothing we have exercises it yet). |
| B7 | **Real audio** (SB/OPL FM synthesis, currently silent stubs) | L | Detection already passes; this is actual sound output. |

## C · Content — games & demos to add and try

| # | Task | Effort | Why |
|---|---|---|---|
| C1 | **Add Moktar / Blues Brothers (Titus)** | S | EGA/VGA platformer; exercises the keyboard + planar/13h paths. |
| C2 | **Add Baby Jo (Loriciel)** | S | Another EGA title to widen coverage. |
| C3 | **Add Dune (Cryo)** | M | North-star game. Large 1992 VGA title — may need EMS/DPMI/Mode X; even a "how far does it get" run is valuable recon. |
| C4 | **Add top-rated MS-DOS demos as test candidates** | S | See pouet toplist below — highly-acclaimed complex demos stress the engine in useful ways. |

**pouet.net highly-acclaimed MS-DOS candidates** (from `prodlist.php?platform[]=MS-Dos&order=thumbup`
and `toplist.php` — pouet sorts by **thumbs-up/score** and filters by **platform** + **type/size
class** 256b/1k/4k/64k/demo, though not by exact byte count):
- **Second Reality** — Future Crew (demo, Assembly '93) — north star, needs DPMI/Mode X, big.
- **Heaven Seven** — Exceed (64k) — likely DPMI.
- **Tube / Puls / Memories** — already in the golden set ✅.
- **Moralhardcandy** — Blasphemy (demo, 1999).
Good near-term picks: more 256b/4k productions (mostly real-mode) before the 64k/demo (DPMI) tier.

## D · Performance (the JIT ceiling — see the perf plan)

Current state: tier-2 region compiler shipped (default ON). Post-fusion profile says the next
levers are flags and indirect calls, not register access. Cumulative vs baseline: tube ×3.9,
lattice ×3.9, plasma ×3.5, memories ×1.66.

| # | Task | Effort | Why |
|---|---|---|---|
| D1 | **Lazy flags** (defer/compute-only-the-consumed flag via liveness) | L | ~42% of puls is live-flag helpers the dead-flag pass can't strip; general win for all branch-heavy code. Riskiest, but now gated by fuzz-flags + fuzz-region + golden + conformance. |
| D2 | **Tier-2.5 indirect-call inline cache** (memories' per-pixel `call bx`) | M–L | The memories/Dune trajectory — ~18% dispatch that region fusion can't touch. |
| D3 | **Register→locals / x87-stack→locals promotion within regions** | M | Demoted by the profile but still real for tube's x87. |
| D4 | **Web Worker + SharedArrayBuffer** (Phase 4) | L | Smoothness/unthrottling from rAF + off-main-thread; needs COOP/COEP in serve.py. NOT raw single-thread speed. |
| D5 | **Internal IR backend** (x86→IR→JS) | L | The foundation D1–D3 ultimately want; big architectural step. |

## E · Tooling / infra

| # | Task | Effort | Why |
|---|---|---|---|
| E1 | Fold `tools/run-game.mjs` conveniences (auto-detect main EXE, screenshot PNG) | S | Faster headless game triage. |
| E2 | Extend `fuzz-region` to far transfers / multi-segment / call-return | S–M | Closes the class of tier-2 bugs that single-segment loop fuzzing misses. |
