# MIRAGE — Testing & Gates

The safety net. Every non-trivial change runs these; a green run is the bar for a commit. All
are plain Node scripts in `tools/` and drive the DOM-free engine headless. Run each with the
optimization kill-switches (see [RECOMPILER.md](RECOMPILER.md)) both on and off.

## Surveying the gaps (`tools/survey-gaps.mjs`)

Not a gate — a measurement. It runs every program in `games/` and `intros/` and reports what each
one **asked for and did not get**: INT vectors with no handler (`machine.unhandledInts`) and INT 21h
functions that fell through to `default:` (`dos.unhandledFn`). Gaps used to be chosen by reading the
code and guessing; this ranks them by what the corpus actually calls.

    node tools/survey-gaps.mjs            # whole corpus
    node tools/survey-gaps.mjs WOLF3DSW   # one game
    FRAMES=120 node tools/survey-gaps.mjs

Caveat: a title only reaches the calls *after* the point where it currently derails, so anything
dying early under-reports.

## The DOS oracle (`tools/dos-oracle.mjs`)

`test-dos-api.js` states its expectations by hand, and three of its early cases were wrong because I
derived them by hand. The fix that worked for the CPU was to stop deriving and start observing. Since
a real kernel boots on our BIOS (roadmap F2d), the same move is available for the DOS layer:

    node tools/dos-oracle.mjs capture   # boot FreeDOS, record every INT 21h in -> out
    node tools/dos-oracle.mjs check     # replay the recording into our INT 21h and diff

An INT 21h serviced by the guest's own kernel goes swInt -> realInt, so there is no "handler
returned" hook; the capture remembers where the frame will unwind to and watches for the CPU to
arrive back there with the stack restored.

Two limits, both deliberate. **The comparison runs over a whitelist** of calls whose answer does not
depend on state we cannot replicate — widening it means replicating state on purpose, one function at
a time, not loosening the filter. And **FreeDOS is a peer, not an authority**: where it and MS-DOS
differ neither is automatically right. What this catches is our answers being differently *shaped*
from a real kernel's, which is a more tractable question than "which DOS is correct".

The recording is committed, so `check` runs without a boot image.

## Surveying the I/O bus (`tools/survey-ports.mjs`)

The port-bus counterpart of `survey-gaps.mjs`. Runs the same corpus (`tools/corpus.mjs`) with
`cpu.ioRead`/`cpu.ioWrite` replaced by recording wrappers, and ranks every port by traffic, with the
distinct values written and a separate list of ports that have **no handler** — where a read returns
all-ones and a write vanishes.

    node tools/survey-ports.mjs                 # ranked table
    node tools/survey-ports.mjs --watch=0x21    # the exact access sequence on one port

The hook has to replace the `cpu` closures, not `machine.ioRead`: recompiled code calls the closures
directly (they capture the port tables), and only replacing them catches the miss path too.

## Harness composition (`tools/harness.mjs`)

Every headless tool composes its Machine through `makeMachine()`, which mirrors `ui.js`: 16 MiB, the
ROM fonts, the INT 33h mouse, BIOS + DOS. Each of those was, at some point, missing from one tool and
present in the browser — and every time, the harness's blindness was mistaken for correct behaviour
(1 MiB made every XMS allocation fail; no fonts pinned three intros rendering a black screen). The
instruction-level tools (`test.js`, `conformance.js`, the fuzzers, the co-simulator) deliberately
build bare machines and do not use it.

## The gates (in the order to run them)

| Gate | Command | Checks | Bar |
|---|---|---|---|
| **Unit** | `node tools/test.js` | 101 hand-written cases: opcodes, flags, ALU/BCD, the EGA planar write pipeline, keyboard 8042/IRQ1, multi-instruction dead-flag cases, 386 addressing (`0x67` ModRM/SIB), `0x66` operand size (CWDE/CDQ, PUSHAD/PUSHFD), #DE aborting a block | 101/101 |
| **386 semantics vs Unicorn** | `node tools/test-x86-uc.mjs` (`--capture` to refresh) | 86 cases (single instructions + multi-instruction **sequences**) whose expected values are **observed from Unicorn** (QEMU's TCG core), not hand-derived: `0x67` ModRM/SIB forms, `0x66` operand size (CWDE/CDQ, PUSHAD/PUSHFD, 32-bit ALU), BT/BTS/BTR/BTC bit-string offsets on memory, string ops/XLAT/LOOP under `0x67`, shift/rotate flag corners, and sequences that exercise the **dead-flag elimination** pass (producer → consumer → killer, INC/DEC preserving CF, shifts with a runtime count of 0, REP with CX=0, LAHF/PUSHF reading the whole word, bounded loops). The captured reference is committed, so the gate needs neither Python nor Unicorn. ⚠️ **BCD (27/2f/37/3f) is deliberately excluded** — Unicorn models the later-CPU algorithm; the 8088 differs and `conformance` covers it with real silicon (40000/40000). | 86/86 |
| **DOS/BIOS services** | `node tools/test-dos-api.js` | 241 cases against the INT 21h / 10h / 16h / 1Ah / 2Fh surface: file handles, find-first/next, memory (4Ah then 48h/49h), EXEC child block sizing, directories (39h/3Ah/3Bh/47h), the boot-sector INT 19h handoff, INT 13h over sector images (CHS decoding, geometry, error codes, and a two-sector boot image that loads its own second sector), DTA, the **CF-on-success convention**, and the XMS driver (move bounds/overlap/even length, realloc relocation, lock/free refusal, plus an end-to-end check that an AH=0Bh overlay swap invalidates the cached compiled block) - the layer `conformance`/`golden` cannot see | 241/241 |
| **Conformance** | `node tools/conformance.js` | 527,651 SingleStepTests vectors — per-instruction reg/flag/memory exactness | **100%**, non-negotiable |
| **Golden** | `node tools/golden.js check` | deterministic output fingerprint of 20 demos (framebuffer + planes + DAC + fault) | 20/20 |
| **Region fuzzer** | `node tools/fuzz-region.js 20000` | tier-2 region output == tier-1 (`stepOne`) on 20k random programs | `region == tier-1 on all` |
| **Flag fuzzer** | `node tools/fuzz-flags.js` | randomized flag-producing sequences vs a reference | clean |
| **Bench** | `node tools/bench.js` | p50 ms/frame for tube/memories/plasma13/xormunch/kaneda/lattice/puls | within ~±3% (A/B, this machine) |
| **DOSBox diff** | `node tools/dosdiff.js <prog.com>` | frame-matched pixel compare vs real DOSBox-X | visual signal (see below) |

`test-demos.js` / `test-dos.js` / `test-gfx.js` are additional targeted suites.

## Golden — the fingerprint gate (`tools/golden.js`)

The **only** gate that catches multi-instruction dead-flag bugs (conformance is
single-instruction and never strips). For each of 20 workloads it runs a fixed schedule
(`TICKS=60` × `runSlice(400000)`, run-loop owns the PIT timer) and SHA-1s: video mode, fault
message, the mode-13h framebuffer, the DAC — **and in planar modes the four bit-planes + the
attribute palette + the CRTC start/stride** (linear A000 is empty then). `demos/PLANAR.COM`
exercises the EGA write modes end-to-end (sensitivity-checked: perturbing write mode 1 flips its
fingerprint).

**Self-referential:** the baseline (`tools/golden-baseline.json`) is MIRAGE's own past output,
not a DOSBox reference — it catches *drift*. So a legitimate behavioural change (e.g. more
accurate timer delivery shifting a timer-paced demo to a new animation phase) is a **re-bless**
(`node tools/golden.js capture`), but only after confirming each changed demo still renders
correctly (render both ways to PNG and eyeball) and, for engine changes, that tier-2 and
`MIRAGE_NOTIER2` produce identical hashes.

## DOSBox diff (`tools/dosdiff.js`)

`node tools/dosdiff.js intros/tube.com [ticks]` runs the program in headless DOSBox-X (a tiny
resident grabber snapshots the framebuffer+DAC after K ticks) and in MIRAGE, renders both to
PNG (`-dosbox`/`-mirage`/`-diff`) and reports a similarity %. This is the *ground-truth*
reference (golden is only self-consistency). Expect <100% on FP raytracers (float64 vs 80-bit,
1-frame phase) — the side-by-side + diff image are the real signal; integer effects should be
~100%. Needs `nasm` + `dosbox-x` installed (`/opt/homebrew/bin` on this machine).

## Rendering a program to inspect it

`node tools/render-com.js <prog> <out.png> [ticks] [scale]` — mode-13h render. For **planar**
programs render from `machine.vga.planes` (see the planar renderer in `video.js` or the scratch
`render-planar-com.mjs` pattern), since linear A000 is empty in EGA modes.

## The CPU co-sim (found the real CPU bugs)

Not in `tools/` — an ad-hoc harness (scratchpad) that snapshots MIRAGE's exact CPU+memory state
and single-steps it against **Unicorn Engine** (QEMU's core, `pip install --user unicorn`) as a
trusted x86 oracle, diffing registers/memory each instruction. Same initial state ⇒ only genuine
CPU-emulation bugs surface (no need to match two DOSes). It found the `push dword` SP bug and the
`popf` 386-flag-mask bug. For BIOS/DOS INTs it *adopts* MIRAGE's after-state (device behaviour,
not CPU); it replays MIRAGE's port reads and runs whole REP ops as one step. Reach for it when a
game derails and you need to localize a wrong branch/computation. See the `cosim_tool` memory.

## What "verify a change" means here

1. Run the affected program (headless render or the browser) and *see* the pixels/behaviour —
   not just the tests.
2. Run the gates above relevant to what you touched (always test + conformance; add golden for
   anything touching emission/flags/timing; add fuzz-region for anything touching the run loop or
   region compiler; add bench for hot-path changes).
3. For device/timing changes, confirm tier-2 == notier2 and re-bless golden only after visual
   verification.
4. Browser sanity (reload, run a demo, check the console) for anything in the engine or `ui.js`.
