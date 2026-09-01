# Timing — measured, 2026-08-28

D7 has sat on the roadmap since 2026-08-03 as "port DOSBox's event-driven timing model": a PIC event
scheduler, in-block deadline safepoints, and a frame-anchored 0x3DA beam. Before building it I
measured what the current design actually costs. **Two of its three parts turn out to address an
error that is not there, and the one real problem it was expected to solve has a different cause.**

This document is the measurement, so the conclusion can be re-checked rather than believed.

## How to reproduce

Two research knobs exist for exactly this, both inert at their defaults and both used below:

| knob | default | what it moves |
|---|---|---|
| `MIRAGE_MAXOPS` | 192 | basic-block length cap — moves where block boundaries, and so IRQ sampling points, fall |
| `MIRAGE_PITFLOOR` | `pitBase>>4` (4096) | the floor `setPitReload` clamps a guest's counter-0 reload to |

`MIRAGE_PITRELOAD` (already present) sets the starting reload.

## 1. Delivery lateness — the error D7(a)+(b) exist to fix

`run()` samples `cpu.cycles >= nextTimerCycle` between basic blocks, so a due INT 8 lands late by at
most one block. DEVICES.md put that at "up to 192 instructions". Measured, over 120 ticks:

| workload | mean block | INT 8 | period | late p50 | late p90 | late max | > 1 period |
|---|---|---|---|---|---|---|---|
| DUNE/DUNEDEM.EXE | 3.3 instr | 13096 | 5957 | 1 | 3 | 532147 | 1 / 13096 (0.01%) |
| GODTHUND/GOT.EXE | 2.8 instr | 7818 | 8514 | 1 | 3 | 5309 | 0 / 7818 |
| ALLEYCAT/CAT.EXE | 2.2 instr | 809 | 65536 | 1 | 2 | 3 | 0 / 809 |
| intros/tube.com | — | 2087 | 65536 | 6 | 15 | 20 | 0 |
| intros/crevenge.com | — | 14826 | 4096 | 2 | 7 | 17 | 0 |

**Blocks average 2-3 instructions, not 192.** The worst case in the documentation is real but
essentially never happens: the boundary check runs every couple of instructions already, so the
median tick is delivered **1 cycle** after it is due, on periods of 6000-65000 cycles.

The one large number — Dune's 532147-cycle maximum — is not block granularity. An IRQ cannot be
delivered with IF clear at all, so a long interrupts-off window defers it, and `serviceTimer`'s
coalescing then re-anchors and **drops** the ticks in between. Measured over the same 120 ticks:
Dune has **one** such event, dropping 89 ticks (0.7% of the total expected); God of Thunder has
**none**. No amount of in-block sampling can help there — the CPU is not accepting interrupts.

> **Conclusion.** D7(a) (event scheduler) and D7(b) (in-block deadline safepoints) would buy about one
> cycle of accuracy on a six-thousand-cycle period, at the cost of a check on a path where the
> existing check already runs every 2-3 instructions. **Not justified by measurement.**

## 2. The INT 8 rate cap — the problem that IS real

`setPitReload` floors the reload at `pitBase>>4` ≈ 291 Hz. Two titles ask for far more: Wolf3D ~700 Hz
for its sound service, and Chrome Revenge divider **68** (~17.5 kHz) for its PWM audio, so its whole
animation clock runs ~60x slow. Lowering the floor, Chrome Revenge over 100 ticks:

| floor | INT 8 delivered | wall clock | relative |
|---|---|---|---|
| 4096 (today) | 24591 | 2.68 s | 1x |
| 1024 | 100007 | 6.17 s | 2.3x |
| 256 | 455207 | 24.34 s | 9.1x |
| 68 (requested) | 1182885 | 60.4 s (and only 69 of 100 ticks) | ~33x |

The obvious reading is "interrupt dispatch is expensive, make it cheaper". It is not. The same sweep
on `intros/kaneda.com`, which installs **no** INT 8 handler so the BIOS default path runs:

| floor | INT 8 delivered | wall clock |
|---|---|---|
| 65536 | 1045 | 0.59 s |
| 4096 | 16730 | 0.60 s |
| 1024 | 66923 | 0.60 s |
| 256 | 267692 | 0.64 s |

**256x the deliveries for +8% wall clock** — dispatch costs roughly 0.2 µs and is free at any rate a
guest asks for. The 33x is therefore **the guest's own ISR**, run 60x more often: real emulated work,
not overhead.

> **Conclusion.** The cap is not covering for a slow scheduler. It is covering for the engine being
> roughly 30x slower than the hardware that made a 17.5 kHz ISR reasonable (see
> [mirage_speed_baseline] in ROADMAP D). Lifting it needs D1-D5 (engine speed) or an explicit policy
> decision to accept the slowdown — **an event scheduler would not move this number at all.**

## 3. Blast radius of touching block boundaries

`MIRAGE_MAXOPS` changes where blocks end, which is what a deadline safepoint would also do:

| MAXOPS | goldens |
|---|---|
| 192 (default) | 43 ok |
| 96 | 42 ok, **1 mismatch** — `intros/memories.com` |
| 191 | same single mismatch |

Only one of 43 workloads is sensitive, and it is the one already known to be the most layout-sensitive
in the corpus (it is what blocked the `EIP = 0x10000` fix for three attempts). Useful to know, and it
means a future change here is verifiable rather than frightening — but it is not an argument *for* the
change.

## What is left of D7

**(c) the frame-anchored beam** is untouched by the above and is the only part with a case left. Note
though that its stated justification — "the beam is coupled to `cpu.cycles`, so ISR jitter moves the
apparent beam position" — is weakened by §1: the jitter is about one cycle. If our 0x3DA is wrong it
is for a different reason (period or duty cycle, not phase noise), and **that** would need its own
measurement against a reference before any work. Reads are plentiful enough to matter — 5.2 M in Dune,
1.36 M in God of Thunder, 1.17 M in Alley Cat — so the question is worth answering; it just has not
been answered yet, and nothing here answers it.

**Recommended re-scope**: drop (a) and (b); treat the rate cap as a speed problem, not a timing one;
and reopen (c) only behind a measurement that shows the beam is actually wrong.
