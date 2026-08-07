# MIRAGE — Testing & Gates

The safety net. Every non-trivial change runs these; a green run is the bar for a commit. All
are plain Node scripts in `tools/` and drive the DOM-free engine headless. Run each with the
optimization kill-switches (see [RECOMPILER.md](RECOMPILER.md)) both on and off.

## The gates (in the order to run them)

| Gate | Command | Checks | Bar |
|---|---|---|---|
| **Unit** | `node tools/test.js` | 101 hand-written cases: opcodes, flags, ALU/BCD, the EGA planar write pipeline, keyboard 8042/IRQ1, multi-instruction dead-flag cases, 386 addressing (`0x67` ModRM/SIB), `0x66` operand size (CWDE/CDQ, PUSHAD/PUSHFD), #DE aborting a block | 101/101 |
| **386 semantics vs Unicorn** | `node tools/test-x86-uc.mjs` (`--capture` to refresh) | 86 cases (single instructions + multi-instruction **sequences**) whose expected values are **observed from Unicorn** (QEMU's TCG core), not hand-derived: `0x67` ModRM/SIB forms, `0x66` operand size (CWDE/CDQ, PUSHAD/PUSHFD, 32-bit ALU), BT/BTS/BTR/BTC bit-string offsets on memory, string ops/XLAT/LOOP under `0x67`, shift/rotate flag corners, and sequences that exercise the **dead-flag elimination** pass (producer → consumer → killer, INC/DEC preserving CF, shifts with a runtime count of 0, REP with CX=0, LAHF/PUSHF reading the whole word, bounded loops). The captured reference is committed, so the gate needs neither Python nor Unicorn. ⚠️ **BCD (27/2f/37/3f) is deliberately excluded** — Unicorn models the later-CPU algorithm; the 8088 differs and `conformance` covers it with real silicon (40000/40000). | 86/86 |
| **DOS/BIOS services** | `node tools/test-dos-api.js` | 62 cases against the INT 21h / 10h / 16h / 1Ah / 2Fh surface: file handles, find-first/next, memory (4Ah→48h→49h), DTA, XMS, and the **CF-on-success convention** — the layer `conformance`/`golden` cannot see | 62/62 |
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
