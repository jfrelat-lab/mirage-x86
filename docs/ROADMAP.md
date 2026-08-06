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
| B2 | **Wolf3D PML memory manager** (`PML_GetPageBuffer: Purged main block`) — ⚠️ now **blocked on compile-bound slowness**: Wolf3D runs at ~0.05–0.13 Mblk/s (profiled: `translate`/`new Function`-per-block dominates, ~1716 blocks, QBasic-class warmup — NOT SMC/cache thrash), so PM_Startup can't finish in a practical window to reach/diagnose PML. Needs **D5/tier-0** (faster codegen) first, or a fast-forward past startup. Fixed en route: PIT storm capped (`d94ff27`); noted tier-2 is ~5× slower than tier-1 on Wolf3D. | M–L | The last blocker for a landmark title; gated by D + likely needs B3. |
| B3 | **EMS/XMS** (INT 67h / HIMEM) | M | Wolf3D and other games probe/need it; degrades gracefully today but blocks some. |
| B4 | **DPMI / protected mode** (DOS/16M, DOS4GW) | L | *The* single biggest gap — Raptor, Jazz, Doom-class, advanced 64K demos. Foundational for the north star beyond Dune's real-mode parts. |
| B5 | ✅ **DONE (browser)** (`92e4741`) — virtual CPU clock in `ui.js` (`VCPU_HZ` ≈ 8 MHz) caps guest cycles/wall-second; 0x3DA beam derived from it stays 70 Hz. Fixed raw-CPU-speed-bound code (Keen Vorticons menus flying by). Headless keeps its deterministic timing. Tunable constant. | — | done |
| B8 | **DOS MCB chain** — replace the bump allocator with a real Memory Control Block linked list | M | Copy protections (Moktar's E.Zmiro kit) walk the MCB chain and take an anti-tamper path when it's missing. Unblocks that class of protected games. |
| B9 | **SCUMM v5 timing divergence (Monkey Island)** — past the earlier BOUND loop after the memory fixes, but still renders nothing (browser blank, headless a sliver); browser/headless diverge | M | Co-sim the interpreter to find where state drifts. Would land the SCUMM v5 line (MI1/MI2/Indy). |
| B6 | **Mode X / unchained VGA** | M | Second Reality and some VGA action games; needs a hand-authored test (nothing we have exercises it yet). |
| B7 | **Real audio** (SB/OPL FM synthesis, currently silent stubs) | L | Detection already passes; this is actual sound output. |

## C · Content — games & demos to add and try

| # | Task | Effort | Why |
|---|---|---|---|
| C1 | ⚠️ **Moktar staged + diagnosed** — `MOKTAR.COM` EXECs `GAME.TDT` (EXEC + HLT-wake added, `fae7ec1`); the child runs but its **E.Zmiro copy protection derails** (needs B8 MCB chain or a cracked release). Blues Brothers still to try. | — | mostly done |
| C2 | **Add Baby Jo (Loriciel)** | S | Another EGA title to widen coverage. |
| C3 | **Add Dune (Cryo)** | M | North-star game. Large 1992 VGA title — may need EMS/DPMI/Mode X; even a "how far does it get" run is valuable recon. |
| C4 | **Add top-rated MS-DOS demos as test candidates** | S | See the sizecoding survey below. |
| C5 | ✅ **DONE (2026-07-20):** curated `intros/` — triaged all (24/28 rendered), added **dirojed, paralaxa, warp** (32b) + **symetrie** (256b) from Řrřola, removed dead `cantorus` (exits blank), added `tools/intros-manifest.mjs`, regenerated `intros/manifest.json` (→31). Chrome Revenge skipped (`0F 38`+VESA); BootChess skipped (boot sector, not DOS). `oktaeder` stays (golden fault-fingerprint, needs protected mode); `256b` sparse but golden-pinned; `pitman` is text. | S | done |

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
| D6 | **Compile-bound startup** (tier-0 bytecode interpreter for cold code, or faster codegen) | L | The per-block `new Function` cost dominates *big-program startup* — **blocks Wolf3D** (~1716 blocks) and **QBasic** (~1712 blocks, ~16 s warmup). Interpret cold blocks, only JIT-compile hot ones. Prereq for B2 (Wolf3D PML). |
| D7 | **Event-driven timing: PIC scheduler + in-block deadline safepoints + frame-anchored beam** — port DOSBox's model (RE'd 2026-08-03, see [DEVICES.md](DEVICES.md) *Known limitation — block-granular timing*). Three parts: (a) `pic.js` (cycle,handler) scheduler with a cached `nextEventCycle` min — **prototyped 2026-08-04, golden-neutral 21/21 + conformance 100 %**; (b) **emit a deadline safepoint inside tier-1 codegen** (blocks decrement/check a budget and return, as tier-2 regions already do) — ⚠️ do **not** bound blocks by re-translating: tried, catastrophically slow (a vsync-poll loop re-JITs per crossing; one `runSlice` never completed), reverted; (c) beam phase from a per-frame anchor instead of `cpu.cycles % vgaPeriod`. | L | **Mutualised timing infrastructure**, not a one-demo fix: lets us lift the ~291 Hz PIT cap that throttles **Wolf3D**'s ~700 Hz sound timer, makes **Dune/GoT/Alley Cat** timing exact rather than approximate, gives the seam for a future **PIC controller** (IMR/priority/EOI) needed by sound/mouse/serial IRQs, and makes 0x3DA-polling demos exact. ⚠️ Will shift 0x3DA-polling golden fingerprints (kaneda/difze/rv256/revitro) → per-intro `dosdiff` re-bless. **Does NOT fix Heaven** — measured 2026-08-04, Heaven derails at *every* block granularity (1…192), so its derail is not a timing-granularity bug; justify D7 on the titles above, not on Heaven. |

## E · Tooling / infra

| # | Task | Effort | Why |
|---|---|---|---|
| E1 | Fold `tools/run-game.mjs` conveniences (auto-detect main EXE, screenshot PNG) | S | Faster headless game triage. |
| E2 | Extend `fuzz-region` to far transfers / multi-segment / call-return | S–M | Closes the class of tier-2 bugs that single-segment loop fuzzing misses. |

## F · Deferred capability gaps (found while testing, #57)

| # | Task | Effort | Why / what it unblocks |
|---|---|---|---|
| F1 | **`0F 38` three-byte opcode family + VESA** (INT 10h AH=4Fh, banked/linear framebuffer, hi-res modes) | L | **Chrome Revenge** (1K, Abaddon — arguably the best DOS 1K) faults on `0F 38` and draws in VESA 640×480; both are needed to run it. VESA also unlocks later hi-res demos/games. |
| F3 | **`0x67` address-size prefix — 32-bit effective addresses** (32-bit ModRM, **SIB** byte, disp32, 32-bit base+index). Today `recompiler.js:503` consumes `0x67` and decodes 16-bit anyway, so the byte stream **desynchronises** on any 386 code using 32-bit addressing. | M | **Root cause of Heaven's derail** (traced 2026-08-04, see [COMPAT.md](COMPAT.md) *4K tier*): its generated code runs `67 8D 04 80` (`LEA AX,[EAX+EAX*4]`), MIRAGE decodes `LEA AX,[SI]` + treats the SIB byte as an opcode → garbage → a corrupted stack slot → `RET` into a field of zeros. A planted 4-instruction/9-byte test decodes as **8 instructions over 20 bytes**. Scoped to `modrm()` + the address path; likely helps other 386-era demos. Conformance (8088 vectors) can't catch it — needs new targeted tests. |
| F2 | **Boot-sector execution mode** (load a 512-byte sector at `0000:7C00`, set up registers as if BIOS INT 19h booted it, run in that bare environment — not the DOS loader) | M | **BootChess** (512b, RSi) and other bootsector sizecoding prods are NOT DOS programs; MIRAGE only loads `.COM`/`.EXE` via the DOS PSP path. A "boot this image" mode would run them (and is a stepping stone toward disk-image booting). |
