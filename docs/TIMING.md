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

## 4. The 0x3DA beam — investigated 2026-09-02, and NOT shipped

§1 left part (c) as "the only part with a case left, but its stated justification is weakened". So
the beam was measured directly rather than argued about.

**The duty cycle is wrong, and by a lot.** `bios.js` hardcoded two constants: blank from 0.88 of a
frame, retrace from 0.92 to the frame's END. The CRTC tables `vga.js` already carries — the ones
`tools/vga-rom.mjs` verified against a real VGA BIOS ROM, register for register — say otherwise:

| mode | total | display end | retrace | blank | retrace start | end | **duty** |
|---|---|---|---|---|---|---|---|
| 03 / 0D / 0E / 13 | 449 | 400 | 412-414 | 89.1% | 91.8% | 92.2% | **0.45%** |
| 10 (640x350) | 449 | 350 | 387-389 | **78.0%** | 86.2% | 86.6% | 0.45% |
| 12 (640x480) | 525 | 480 | 490-492 | 91.4% | 93.3% | 93.7% | 0.38% |
| **hardcoded** | | | | **88.0%** | **92.0%** | **100%** | **8.00%** |

So the retrace pulse is roughly **eighteen times too long**, and the constants do not track the mode:
640x350 blanks at 78% of a frame, not 88%. `vga.js` now derives all three from the CRTC the way
DOSBox does (`vga_misc.cpp`), cached behind a `beamStamp` because the reader runs 24 M times in one
`intros/starport.com` run.

**It is off by default (`MIRAGE_BEAM=crtc` enables it), and here is why.**

Blast radius first: 13 of 41 golden workloads read 0x3DA at all, and 3 of them change fingerprint.
Fidelity against DOSBox, three runs each, in one binary:

| intro | legacy | crtc |
|---|---|---|
| chaosequ | 86.4 / 70.0 / 83.3 | 93.9 / 86.5 / 87.5 |
| above | 71.6 / 71.8 / 71.7 | 71.7 / 71.7 / 71.6 |
| nibble | 64.7 / 63.3 / 64.0 | 64.7 / 64.0 / 64.0 |
| upup | 32.5 / 31.9 / 32.1 | 32.5 / 32.9 / 32.3 |

⚠️ **`dosdiff` is not reproducible on progressive plots.** chaosequ varies 90.0-94.7% across identical
runs with no code change, and a first single-run comparison of this change read as "93.5% → 61.2%,
a 32-point regression" that did not exist. Any claim resting on one dosdiff number is worth about
±16 points on that kind of workload. On the three stable programs the change is a wash.

**The blocker is `intros/freality.com`.** Under the CRTC beam it reaches a state where its own
arithmetic divides by zero — `CHESS.INC` computes `S = 33 - AX` from an x87 value and lands exactly
on 0, then `div cx`. Under the legacy beam it never gets there, out to 800 ticks. And DOSBox-X runs
the same intro for **45 seconds without ever exiting** (detected by chaining `ECHO > DONE.TXT` after
it, which never appears), so the reference does not reach that state either. A locally correct duty
cycle that diverges from the reference on a real program is trading a known error for an unexplained
one, so it stays behind the flag until the rest of the beam — period, or the relationship between
`cpu.cycles` and frame time — is measured too.

## 5. Unhandled INT 00h — fixed, and measured first

Found while investigating the above: MIRAGE had **no INT 00h handler at all**. The vector pointed at
the BIOS dummy IRET, so the CPU returned to the faulting `DIV` and raised again, for ever; the engine
gave up with "re-raised 100000x at the same address" — an engine error where a real machine has a
program that simply ended.

What DOS actually does was measured, not assumed. `tools/divzero.asm` writes a marker to a file and
**closes it**, divides by zero, then reopens and appends a second marker. Under DOSBox-X the file
holds `B` alone: **DOS terminates the program**. `dos.js` now does the same.

The CPU half got an oracle too — `tools/x86-de-cases.mjs`, 13 cases through `test-x86-uc.mjs`. Note
what Unicorn can and cannot say here: it raises #DE to the embedder rather than dispatching it
through the IVT, so it is an oracle for **which** divisions fault, not for what happens next. An
earlier version of those cases installed an IVT handler and read back the pushed frame; every
faulting case came back as an oracle `error`, and the gate SKIPS those — six cases that would have
reported green without ever running. Cases now declare `fault: 0` and the harness fails them unless
*both* sides faulted, and it prints the skip count on every run so the remaining 5 pre-existing skips
are visible. The 7 fault cases pass, including the overflow conditions (`FFFF:FFFF / 1`, and IDIV's
asymmetric `-32768 / -1`) that are the easy ones to get wrong.

## 6. The beam PERIOD — measured 2026-09-02, and it exonerates §4

§4 shipped the CRTC-derived duty cycle behind a flag because it killed `intros/freality.com`, and
closed by naming the period as the unmeasured piece. It has now been measured, and the period is not
the problem either — the **ratio between the beam and the guest's execution rate** is.

The duty cycle can be checked against the CRTC. The period cannot: it is a relationship between two
clocks, and only the guest can see it. So `tools/beamperiod.asm` measures it from the inside — sync to
a retrace edge, then count poll iterations across one whole frame — and the **same binary** runs on
both sides, which is what makes the two numbers comparable.

| | iterations per frame | instructions per frame |
|---|---|---|
| DOSBox-X, `cycles=fixed 20000` | 0x2E60 = **11872** (stable to ±1 over 8 frames) | ~47500 |
| MIRAGE, default | 0x10A5 = **4261** | **17045** |

4261 is exactly 17045/4, and the loop body is four instructions — so `vgaPeriod = pitBase / 3.845` is
internally consistent and the counter measures what it claims. What it shows is that **a guest gets
2.79x less work per beam frame here than in the DOSBox configuration we diff against**. That is a
machine-speed choice, not a beam defect: 17045 instructions per 70 Hz frame is roughly a fast 286,
and DOSBox at those settings is roughly a low-end 386.

`MIRAGE_PITRELOAD=182584` reproduces DOSBox's count **exactly** — 0x2E60, digit for digit. And with
that calibration:

| beam | pitReload | intros/freality.com |
|---|---|---|
| legacy | 65536 (default) | ends at tick 122 |
| crtc | 65536 (default) | **aborts at tick 36** — divide by zero |
| legacy | 182584 | still running at 200 |
| **crtc** | **182584** | **runs its whole show and exits normally at tick 277** |

So freality's divide by zero was an artifact of the machine being too slow per frame, not of the
retrace pulse being the right width. **The §4 fix is correct and safe**; what gates it is a decision
about how fast this machine should be.

> **What it would cost.** `MIRAGE_PITRELOAD=182584` moves **20 of 43 goldens** — as any change to the
> emulated machine's speed must. That is the real size of the calibration question, and it is the same
> question as [mirage_speed_baseline] in ROADMAP D: one comparable unit between us and the reference.
> The beam stays behind `MIRAGE_BEAM=crtc` until that is settled, because flipping it at today's speed
> still regresses a working intro — for a reason that is now understood rather than mysterious.

## 7. Calibrated to the reference — 2026-09-02

`pitBase` is now **182584**, and the CRTC-derived beam is on by default. A cycle here is one retired
instruction, so that number IS the emulated machine's speed: it went from about a fast 286 to about
a low-end 386, which is what the reference we diff against runs. `tools/beamperiod.asm` reports
`0x2E60` on both sides now, digit for digit.

**The instrument had to be fixed first, and it changed what "fidelity" reads.** `dosdiff` compares a
frame at K ticks, and the two sides did not mean the same thing by a tick: the DOSBox grabber hooks
INT 8 and snapshots after K TIMER ticks, while this side ran K slices of 1.5 M blocks and FORCED a
`tickTimer()` after each — ignoring `pitReload`, double-driving the timer, and executing several
ticks' worth of work per "tick". It now counts the ticks the run loop actually delivers. The effect
on numbers that were quoted for months:

| intro | misaligned | aligned |
|---|---|---|
| intro | 72-77% | **98.3%** |
| above | 71.7% | **30.5%** |
| nibble | 64.0% | 55.6% |

So `intro` was never as bad as reported and `above` was never as good. Both are trustworthy now.

**What the calibration itself bought**, measured with the aligned instrument, old (65536 + legacy
beam) against new:

| intro | old | new |
|---|---|---|
| **rv256** | **10.1%** | **44.2%** |
| upup | 31.5% | 32.0% |
| chaosequ (3 runs) | 99.3 / 99.3 / 79.2 | 98.7 / 96.7 / 97.7 |
| intro, 256b, above, nibble | — | identical |

and on the event-stream oracle, which is far steadier than the pixel one:

| title | matching prefix, before → after |
|---|---|
| WORDRESC/WR2.EXE | **1 → 85** |
| ROC/ROC.EXE | 1844 → 1856 |
| MATHRESC/MR1.EXE | 98 → 107 |
| DUNE/DUNEDEM.EXE | 46/46, and 6 fewer spurious events |
| POP/PRINCE.EXE | 188, with 690 → 454 spurious events |
| MONSTERB/BASH1.EXE | 1691 → **1679** ⚠️ the one regression |

Net **+93 matching events**. 21 of 43 goldens moved and were re-blessed one at a time after checking
each still renders; `freality`'s tick budget was re-measured (20 → 40) because a timer-paced program
advances by ticks, and a tick is now worth 2.79x more work.

> **What this does not fix.** The INT 8 rate cap is still `pitBase>>4`, so still ~291 Hz in emulated
> terms — §2's conclusion is unchanged, and Chrome Revenge still gets 291 Hz where it asks for 17.5 kHz.
> What changed is that a tick is now worth 2.79x more guest work, so its animation clock is that much
> closer without the cap moving at all.

## 8. Does DOSBox cap the timer rate? No — measured 2026-09-02

§2 concluded that our `pitBase>>4` floor (~291 Hz) "covers for the engine being slower than the
hardware", and left it there. It did not ask what the reference does. `tools/pitrate.asm` asks
directly: hook INT 8, count deliveries across 70 vertical retraces — the beam is 70 Hz and
independent of counter 0, which is what makes it usable as the clock — and write the count out. Same
binary on both sides.

| divisor | requested | DOSBox-X | MIRAGE |
|---|---|---|---|
| 4096 | 291 Hz | 293 | 290 |
| 68 | 17546 Hz | **17854** | **290** |

**DOSBox has no cap.** It honours the request. At 291 Hz the two agree; at 17.5 kHz we are 60x below
the reference, and that is the last deliberate divergence left in the timing model.

What lifting it would cost, at the calibrated speed, is entirely the guest's own ISR:

| title | rate asked | wall clock capped | uncapped |
|---|---|---|---|
| WOLF3DSW/WOLF3D.EXE | ~700 Hz | 0.64 s | **0.60 s — free** |
| intros/crevenge.com | 17546 Hz | 1.35 s | 21.2 s — **15.7x** |

Wolf3D's ISR is a small sound service, so the cap costs it fidelity for nothing. Chrome Revenge's is
a PWM synth, so the 15.7x is 17500 synth passes per second — real work it is asking for, not
overhead (§2's dispatch measurement stands: dispatch is ~0.2 µs). Calibrating the machine already
halved this from 33x.

⚠️ **There is a second, independent cap on the browser path**: `ui.js` floors the tick interval at
3 ms, about 333 Hz, whatever `pitReload` says. Any decision about the headless floor has to name that
one too, or the two paths disagree about what a guest gets.

> Found while reading that code: `ui.js` computed its tick interval as `pitReload / 0x10000` with the
> constant hardcoded, so calibrating `pitBase` to 182584 made an unreprogrammed guest tick **2.79x too
> slowly in the browser** — 153 ms instead of 54.9 ms. No headless gate can catch it, because none of
> them run that loop. Fixed to divide by `pitBase`.
