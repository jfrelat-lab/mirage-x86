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

## 9. Why Chrome Revenge is 15x slower than DOSBox uncapped — measured 2026-09-02

§8 put the cost of uncapping at 15.7x and attributed it to "the guest's own ISR, real work it is
asking for". Measured properly, that is wrong. The work barely grows; the ENGINE collapses.

| | capped (291 Hz) | uncapped (17546 Hz) |
|---|---|---|
| instructions executed | 120.8 M | 152.0 M — **+26%** |
| wall clock | 2.36 s | 45.4 s — **19x** |
| throughput | **51.2 MIPS** | **3.35 MIPS** |
| real-time ratio | 0.06x (16x faster than realtime) | 0.99x (exactly realtime) |

A 26% increase in work costs 19x in time, so the cost is per-interrupt overhead, not guest work.
Where it goes:

| | capped | uncapped |
|---|---|---|
| INT 8 delivered | ~5300 | ~402000 |
| **translations** | 10708 | **780219** |
| invalidations | 10644 | 780150 |

Two evictions and two recompilations **per interrupt**, and 83% of the wall clock is inside
`translate()` — 232083 translations emitting **159.5 MB of JavaScript** in ten ticks.

**The cause is genuine self-modifying code, and our invalidation is right.** The ISR sits at
0814:0439 = linear 0x8579, and the invalidating writes are at 0x857B (1 byte) and 0x8584 (4 bytes) —
*inside its own instruction stream*. A 1 KB intro keeps its counters in immediate fields; there is
nowhere else to put them. Invalidation is already byte-precise (`blk.linStart < end && addr <
blk.linEnd`, with a `pageLo/pageHi` fast-out), so this is not over-approximation: the guest really is
rewriting the bytes we compiled.

**Caching compiled functions by content would not fix it.** Distinct byte-contents seen at each hot
block over ~116000 invalidations:

| block | distinct contents |
|---|---|
| 0x8579 | **27** |
| 0x8580 | 20180 |
| 0x8582 | **93858** |

0x8582 holds a 32-bit accumulator, so nearly every value is new. One block of three would hit in
such a cache.

> **What would actually fix it**, in the order I would try them:
> 1. **Do not specialise the written bytes.** When a block is detected as SMC-hot, re-emit it with
>    the immediate/displacement at the written address read from memory at RUN time instead of baked
>    in as a constant. The compiled function then stays valid across the writes and nothing is
>    recompiled. It reuses the existing emitter and adds no second implementation of the semantics.
> 2. **An interpreter tier**, which is what DOSBox does — its dynrec falls back to the normal core on
>    SMC-heavy pages. Architecturally the right answer, but MIRAGE has only a compiler, and a partial
>    interpreter means two implementations of the same semantics: exactly the duplication that hid
>    FCOMI, FXTRACT and FPREM1 in `fpu.js` and the recompiler at once.
>
> Either way this is ROADMAP **D6**, whose current framing says the compile cost is emitted source
> volume and notes "Wolf3D was never compile-bound". **Chrome Revenge is** — the first workload in the
> corpus that is, and the one that makes D6 concrete.

## 10. How fast IS DOSBox on Chrome Revenge? — measured 2026-09-02

§9 ended by proposing work to "make Chrome Revenge as fast as DOSBox". That assumed DOSBox is fast on
it. It is not, and the assumption was never checked.

**DOSBox's own timing, measured by timing a known amount of EMULATED time.** `tools/pitrate.asm`
waits exactly 70 vertical retraces — one second of beam time, and the beam is independent of counter
0 — then exits, so its wall clock minus DOSBox's startup is the real-to-emulated ratio:

| program | wall clock (3 runs) | 1 s emulated costs |
|---|---|---|
| a .COM that exits immediately | 0.25-0.26 s | — (startup) |
| 17.5 kHz ISR | 1.26-1.29 s | **~1.01 s — realtime** |
| 17.5 kHz **self-modifying** ISR | 1.26-1.29 s | **~1.01 s — SMC costs nothing** |

Then CPU load, sampled while running, which is what says whether it has headroom:

| workload in DOSBox-X | CPU |
|---|---|
| idle at the prompt | 2.6% |
| 17.5 kHz ISR, 30 s emulated | 6.7% |
| 17.5 kHz ISR, self-modifying | 6.7% |
| **intros/crevenge.com** | **99%** |

and that 99% does not move when the cycle budget does — 5000, 20000 and 60000 cycles/ms all peg it —
so on this demo DOSBox is **host-bound, not budget-bound**: it cannot deliver its configured rate.

> **So DOSBox is saturated on Chrome Revenge, and neither the interrupt rate nor the self-modifying
> code is why** — both cost it about four points of CPU. What costs it is the demo: SSE ray tracing
> into a 640x480x32 framebuffer, emulated in its normal core.
>
> MIRAGE uncapped runs the same demo at **0.99x realtime** (§9). The two are, roughly, in the same
> place — which makes "as fast as DOSBox" a target we have already met on this workload, and makes
> §9's proposal something to justify on its own merits rather than by comparison.

**What the comparison DOES show** is narrower and still worth having. On the same binary, isolating
the mechanism:

| 1 s emulated at 17.5 kHz | DOSBox | MIRAGE |
|---|---|---|
| plain ISR | ~1.01 s | **0.10 s** — 10x faster than realtime |
| self-modifying ISR | ~1.01 s | **0.63 s** — **6.3x slower than plain** |

MIRAGE is well ahead of DOSBox on both, and self-modifying code costs it 6.3x where it costs DOSBox
nothing. That gap is real and is what §9 diagnosed; it just is not what makes Chrome Revenge slow.

## 11. How DOSBox makes self-modifying code free — read from its source, 2026-09-02

⚠️ **First, a correction to §10.** Those measurements used `core=normal`, which is DOSBox's
**interpreter**. SMC is free for an interpreter by construction — it re-decodes from memory every
time, so there is no compiled cache to throw away. Comparing our recompiler to that says nothing.
Re-measured with `core=dynamic`, its recompiler, sampling CPU load (wall clock cannot discriminate
here: `cycles=fixed` self-paces, so 1 s emulated takes 1 s wall by construction whenever it keeps up):

| workload | core=normal | core=dynamic |
|---|---|---|
| 17.5 kHz ISR | 6.8-7.3% | 5.2-5.4% |
| 17.5 kHz **self-modifying** ISR | 7.0-7.2% | **5.3-5.4%** |

So its recompiler really does pay nothing. `src/cpu/core_dynrec/cache.h` and `core_dynrec.cpp` say how.

**1. A write of the SAME value invalidates nothing.**
```c
void writeb(PhysPt addr,uint8_t val) {
    addr &= 4095;
    if (host_readb(hostmem+addr) == val) return;      // ← identical: nothing happens at all
```

**2. `write_map[addr]` is per BYTE, not per page** — it counts how many cache blocks cover that byte,
so a write to a byte no block covers costs one array read.

**3. And the one that actually matters — `invalidation_map[addr]`, a per-byte count of how often a
write there invalidated code.** `core_dynrec.cpp`:
```c
if (!chandler->invalidation_map || (chandler->invalidation_map[ip_point&4095] < 4)) {
    block = CreateCacheBlock(chandler, ip_point, 32);   // translate, at most 32 instructions
} else {
    CPU_Cycles = 1;
    Bits nc_retcode = CPU_Core_Normal_Run();            // ← INTERPRET one instruction
}
```

> **DOSBox does not make its recompiler handle self-modifying code. It stops using the recompiler
> there.** After four invalidations at an address, that code is interpreted, one instruction at a
> time, for good; the dynrec never sees it again. And it can afford that because **the interpreter is
> not a fallback it had to build — it is the other production core**, complete and tested, that
> `core=normal` selects. Deferring to it costs DOSBox nothing in engineering or in semantic risk.

**What this means for MIRAGE**, taking the three in turn:

| mechanism | our position |
|---|---|
| same-value elision | Not free for us. DOSBox's writes to code pages go through a page handler; ours are **emitted inline** (`u8[a]=v` plus a `codePage` guard), so a compare-before-store would tax the hot store path rather than a handler that only code pages reach. Measurable before deciding, not obvious. |
| per-byte `write_map` | We use `pageLo`/`pageHi` as a range fast-out and then walk the page's block set. Coarser, but the profile in §9 shows these writes DO hit real blocks, so it is not the lever here. |
| **interpret after N invalidations** | **We have no interpreter.** This is the whole gap. |

Block size is measurably NOT the lever, which is worth recording because it looks like one — DOSBox
compiles at most 32 instructions and we allow 192:

| `MIRAGE_MAXOPS` | crevenge uncapped |
|---|---|
| 192 | 3.46 MIPS, 506111 compilations |
| 32 | 3.43 MIPS, 506111 |
| 8 | 3.35 MIPS, 442600 |

No change, because the blocks being invalidated are already 4 and 8-9 instructions long.

> **The design this suggests for us.** Writing a separate interpreter would mean a second
> implementation of every instruction's semantics — precisely the duplication that let FCOMI,
> FXTRACT and FPREM1 sit wrong in both `fpu.js` and the recompiler at once. But we do not need one.
> The same emitter can produce a **generic, non-specialising** form of an instruction, one that reads
> its immediate and displacement from memory at run time instead of baking them in as constants.
> Compiled once per opcode form and cached by form rather than by address, that IS an interpreter —
> written in the emitter we already have and test, with no second copy of the semantics. Blocks whose
> `invalidation_map` crosses a threshold would be emitted that way and would then survive the writes.
>
> §9 listed this as "option 1, do not specialise the written bytes". Reading DOSBox's source says it
> is also option 2, arrived at from the other end.

## 12. Stepping back: where the time goes on NORMAL workloads — profiled 2026-09-03

§9-§11 all measured Chrome Revenge, which is a pathology (genuine SMC in an ISR at 17.5 kHz). Nothing
had profiled the ordinary case. Four steady-state intros under V8's sampling profiler, after 20 warm-up
ticks so nothing is compiling (`compiles=0`, `invalidations=0` throughout):

| | tube | memories | chaosequ | puls |
|---|---|---|---|---|
| throughput | 173.5 MIPS | 165.4 | 224.2 | 123.2 |
| **emitted block code** | 65.4% | 41.0% | 52.7% | 52.4% |
| **`recompiler.js:run` (dispatch)** | **19.9%** | **24.0%** | **37.9%** | **28.3%** |
| `recompiler.js:invalidate` | 9.4% | 4.7% | — | — |
| `translate` | 0.2% | 17.0% | 0.6% | 0.5% |

**Between a fifth and two fifths of a steady-state workload is the dispatch loop**, not the guest's
code and not compilation. Why is visible in the shape of these programs:

| | tube | memories | chaosequ | puls |
|---|---|---|---|---|
| distinct blocks executed | **12** | **4** | 26 | 28 |
| instructions per block | 11.5 | 8.3 | 6.9 | **4.6** |
| most frequent successor | 87.7% | 100% | 80.0% | 66.4% |

A 4K intro is a handful of tiny loops. We chop them into 4-to-11-instruction blocks and re-dispatch
15 M times a second — a page-table index, an `ip0` re-check and an indirect call to amortise over
five instructions.

### (a) Tier 2 already exists, is off, and its stated blocker no longer reproduces

The region compiler fuses a hot block with its statically-reachable successors, which is exactly this
shape. It is gated `MIRAGE_TIER2=1`, and the comment gating it says `intros/memories.com` "takes >300s
for work tier-1 does in 8.5ms, a >30,000x cliff". **That is stale** — regions now decrement the shared
`cpu.tbudget` once per internal iteration, and memories completes normally. Measured:

| | tier 1 | tier 2 | |
|---|---|---|---|
| tube | 173.5 MIPS | **194.2** | +12% |
| memories | 165.4 | 155.4 | **-6%** |
| chaosequ | 224.2 | **293.9** | **+31%** |
| puls | 123.2 | **175.5** | **+42%** |

Block executions collapse accordingly: puls 4.0 M -> 0.15 M, tube 4.0 M -> 1.96 M.

**Not yet a green light.** `golden.js check` under `MIRAGE_TIER2=1` gives **42 ok, 1 mismatch
(`intros/mesha.com`)**, and the corpus run is slower in wall clock than tier 1's 11m27s. The game
defects in the gating comment (Wolf3D 5x slower, Keen's far-indirect derail) are unretested. But the
headline reason it was disabled is fixed, and the upside is now a measured 12-42% rather than a guess.

### (b) The SMC write barrier costs 9.4% of tube while evicting nothing

`invalidate` is 9.4% of tube's self time with **zero** invalidations. Counting the calls:

| | barrier calls | on a page holding code | actual evictions |
|---|---|---|---|
| tube | **3 030 236** | 3 030 236 | **0** |
| memories | 1 333 327 | 1 333 327 | **0** |
| chaosequ | 3 049 | 3 049 | 0 |
| puls | 0 | 0 | 0 |

tube stashes its pixel buffer *in its own code page* (already noted at `recompiler.js:139`), so the
barrier genuinely cannot be skipped by page. What saves it is the `pageLo/pageHi` range fast-out — but
only *after* a `pageBlocks.get(p)` **Map lookup**, three million times a second, to reach two integer
comparisons. Hoisting those bounds into a flat `Int32Array` indexed by page number would make the
fast-out two array reads and no Map at all. Small, local, and its correctness argument is the one
already in the code.

### (c) What is NOT worth doing

Chasing the emitted code itself. It is 41-65% of the time and it is the part actually doing the guest's
work; the engine overhead around it is the 25-40% that (a) and (b) address.

> **Order I would take these:** (b) first — hours, self-contained, no semantic risk, golden must stay
> 43/43. Then (a), whose real cost is re-testing the games, not the code. Both are independent of D6,
> which remains the SMC story of §9-§11.

## 13. §12(b) implemented — flat page bounds — 2026-09-03

`invalidate()`'s per-page fast-out now reads two integers out of a typed array before touching
anything else, where it used to reach them through a `Map`:

```js
const grp = this.pageBounds[p >>> 8];                                  // Int32Array(512), lazily allocated
if (grp === undefined) continue;
const b = (p & 0xff) << 1;
if (end <= (grp[b] >>> 0) || addr >= (grp[b + 1] >>> 0)) continue;
const set = this.pageBlocks.get(p);                                    // only the SCAN pays for the Map
```

Two-level and keyed like `blockPages`, so a 4 GiB address space stays sparse; bounds are read back
**unsigned** because a linear address above 2 GiB is a negative int32 (Windows 3.0's kernel at
0x80201b5e), and `linEnd` is clamped to 0xffffffff so that `hi === 0` can mean "no block here" —
an `Int32Array` stores 2**32 as 0, and the page would otherwise read back empty and miss the write.

**Result**, median of 5 fresh processes each (one process's number moves several percent run to run,
so a claim this size needs the median, not a run):

| | barrier calls / 20 ticks | before | after | |
|---|---|---|---|---|
| tube | 3 030 236 | 172.0 MIPS | **179.4** | **+4.3%** |
| memories | 1 333 327 | 153.1 | **167.6** | **+9.5%** |
| chaosequ | 3 049 | 224.8 | 223.2 | -0.7% |
| puls | 0 | 125.5 | 123.9 | -1.3% |

The two workloads that call the barrier gain; the two that barely call it are flat within noise, which
is the shape the mechanism predicts.

**But the Map was only a quarter of the cost, not the whole of it.** Re-profiled:

| `recompiler.js:invalidate` self time | before | after |
|---|---|---|
| tube | 9.4% | **7.3%** |
| memories | 4.7% | **3.7%** |

The residual is the barrier being *called* three million times at all — `u8[a]=v` → `cp[a>>>12]` →
`m._dirty` → `onCodeWrite` → `invalidate`, three frames deep, for a write that can never hit code.
`cp[]` is per 4 KiB page and tube keeps its pixel buffer *inside its own code page*, so the page-level
test cannot say no.

> **Follow-up, and §11 already named the mechanism.** DOSBox's `write_map` is per **BYTE**, not per
> page. §11 dismissed it as "not the lever" — true for Chrome Revenge, which really does write into
> its instruction stream, and wrong for tube, where it is exactly the lever: a byte- or 16-byte-granular
> coverage map would let the *emitted* test reject all three million writes without a call. That is a
> change to the emitted store path, so it is a separate piece of work with its own gate.

Gates, all on the patched tree: `golden.js check` 43/43, `conformance.js` 555764/555764 (100.00%),
`test-x86-uc` green, `test.js` 194/194, dos/gfx/demos green. `test-dos-api.js` fails one case (INT 15h
AH=86h advanced the virtual clock, 3324 cycles) — **pre-existing**, identical on the unpatched tree
down to the cycle count, and unrelated to this change.

## 14. D8 — what tier 2 actually does to `mesha`, and why DOSBox cannot adjudicate it — 2026-09-03

`golden.js check` under `MIRAGE_TIER2=1` is 42 ok / 1 mismatch (`intros/mesha.com`). Bisecting on the
promotion order (deterministic, so the first N promotions can be allowed and the rest refused) puts it
on **promotion #114, region root linear `0xa13d`**. Co-simulating the two runs from that instant —
limit 113 against limit 114, identical by construction before it:

* the region is **entered with byte-identical register state**;
* the **first three timer services fire at the exact same cycle** in both runs (252164889, 252176818,
  252188750). The fourth differs: 252200696 against 252200710, same `next=252200679`.

So the fused region is not computing anything wrong. It is **late**, by a hair. Over the whole run:

| | livraisons en retard | total | pire cas |
|---|---|---|---|
| tier 1 | 35 631 | 264 070 cycles | 3017 |
| tier 2 | 35 749 | 264 350 cycles | **3016** |

**+0.1 % cumulative lateness, and a worst case one cycle better.** Tier 1 is itself late on 35 631
deliveries; neither is "correct" in absolute terms.

What moves in the fingerprint is correspondingly narrow:

| | tier 1 | tier 2 |
|---|---|---|
| mode | 3 | 3 |
| **B800 (the screen actually displayed)** | 6fb20501 | **6fb20501** |
| DAC | 2e5f1e20 | 2e5f1e20 |
| A000 | 4d352f1a | **6a59edef** |

mesha ends in **text mode 3**, so A000 — the only thing that differs — is *not on screen*. It is the
residue of the animation, hashed unconditionally by `golden.js`.

Not noise, though: the entry is stable. Re-run at slice budgets 399999/400000/400001/800000 and the
hash and the final cycle count are identical (501543260) — mesha runs to completion and its end state
is a fixed point. Tier 2 really does change it, by chaotic amplification of a 0.1 % phase difference
over 500 M cycles.

### The oracle is unavailable, and not for the reason the tool said

ROADMAP D7's policy for a moved golden is to re-bless per intro **after `dosdiff` confirms fidelity**.
`dosdiff` reported `no capture (interrupts off / hooks INT 8 / crashed)` and I first repeated that
diagnosis. Measured, all three are wrong for mesha:

* **It hooks no vector.** Sampling `0000:0020` throughout the run, not just comparing start to end
  (mesha restores what it touches), INT 8 stays `f000:0008` from first tick to last. The `OUT 0x20,20h`
  writes that suggested a guest ISR are **our own BIOS handler's** EOI.
* **Interrupts are not off**: IF set on 19 998 of 20 000 samples.
* **Not the alarm** either — it fails at K=20 as at K=2200.
* DOSBox does run it: its log shows the mode-13h 320x200 surface.
* The grabber is fine: same harness, `tube` captures at K=20 **and** K=200.

The one behavioural difference found is that mesha reprograms PIT channel 0 to ~100 Hz
(`43h←36h`, `40h←9Bh,2Eh` = 11931) and restores 65536 on exit. Raising K to 600/1200/2200 to compensate
changes nothing, so that is **not** the cause either. **Why the grabber never dumps under mesha is
unresolved**, and the honest statement is that mesha cannot currently be adjudicated against DOSBox —
not that it hooks INT 8.

### One real defect found on the way

`dosdiff`'s DOSBox side had a **hardcoded 7-second alarm** while the grabber triggers after K *timer*
ticks, i.e. K/18.2 seconds of emulated time. Every workload pinned past ~120 ticks therefore reported
`no capture` regardless of the program — which is exactly the set a golden re-bless needs it for
(`crevenge` 200, `mesha` 400, `omniscent` 120, `starport` 200). Now scaled with K and overridable with
`DDALARM`. Verified on a program that hooks nothing: **tube at K=200 fails at 7 s and matches at 44.7 %
with the computed alarm.**

### §14b. Debugging mesha under DOSBox — what is established, 2026-09-03

§14 left "why the grabber never dumps under mesha" open. It is now localised, with a control.

**The resident INT 8 handler never executes under mesha.** A probe TSR that calls no DOS at all — at
tick K it sets text mode 3 through the BIOS, which DOSBox announces in its own log — fires for `tube`
(a fourth `surface consider=720x400` line appears) and never fires for mesha. The instrument is
working; there is nothing to capture.

Ruled out, each by measurement rather than by plausibility:

| hypothesis | verdict |
|---|---|
| the 7 s alarm | no — fails at K=20 as at K=2200 |
| mesha hooks INT 8 | ~~no~~ **YES — see §14c. This row was wrong.** |
| interrupts masked at the PIC | no — it never writes port 21h; IMR reads 0 at exit |
| mesha scribbles the resident block | no — below its own PSP it touches only page 0 (the BDA) |
| DOS reentrancy from the ISR | no — added the InDOS guard the grabber was missing; no change |
| our primed `kb.data = 0x9c` | no — mesha ends at the same cycle (501543260) with 0x9c or 0x00 |
| DOSBox is too slow to reach K | no — it does not return to DOS in 60 s at any K |

What is left is a **disagreement about mesha itself**, and it is on our side of the line:

| MIRAGE, 214 ticks | tube | mesha |
|---|---|---|
| timer services delivered | 5363 | **41956** |
| dropped: IF clear / PIC busy | 0 / 0 | **0 / 0** |
| BDA `0040:006C` advanced by | **5363** (1:1) | **5** |
| run time with IF clear | 0 % | **26.4 %** |

mesha reprograms PIT channel 0 to ~100 Hz (`43h←36h`, `40h←9Bh,2Eh` = 11931) and gets its 41956
interrupts — every one passes both gates. But the BIOS tick counter, which tracks services exactly for
tube, advances **five times**. So MIRAGE delivers the interrupts and DOSBox's resident handler never
sees any; these are not the same statement, and the honest position is that **mesha's INT 8 path
differs between the two emulators and the discrepancy is not yet explained**.

> ⚠️ **§14c corrects this section: mesha DOES take INT 8, in protected mode.** Everything below the
> table about "a disagreement about mesha itself" is wrong and is kept only so the error is legible.

> **This outranks the tier-2 question that led here.** `intros/mesha.com` is in `golden.js` with a
> pinned fingerprint, and the run it pins is one DOSBox does not reproduce — it terminates here and
> does not there. Whether tier 2 shifts its off-screen A000 residue by 0.1 % of timer phase is a
> detail next to that. Next step is the apples-to-apples test this one was not: run the same probe TSR
> *in MIRAGE*, chained ahead of mesha, and see whether a guest-side INT 8 handler runs here either.

**Fixed on the way** (`tools/grabber.asm`): the grabber issued INT 21h from inside the timer ISR with
no **InDOS** test, which every resident program that calls DOS from an interrupt is required to do —
DOS is not reentrant and the failure is silent, no file and no error. It now re-arms for one more tick
whenever DOS is busy, so the snapshot is the first frame at or after KTICKS at which DOS is callable.
Behaviour-neutral where capture already worked: tube reports 27.5 % with and without it.

### §14c. Correction — mesha takes INT 8 as a DPMI client, and dosdiff said so all along

§14 and §14b concluded that mesha hooks no interrupt and that the tool's message
(`hooks INT 8`) was wrong. **That was my error.** I checked the REAL-MODE IVT at `0000:0020` on a
program that installs a **protected-mode** vector, so of course it never changed.

Traced at the point where it is actually written — `dpmi.pmVec` behind a Proxy, because mesha issues
the call from protected mode where the real-mode `swInt` hook never sees it:

```
INT 31h AX=0205 : vecteur PM 8 <- 3c:92 (cyc 1017324)
OUT 0x43 <- 0x36 / OUT 0x40 <- 0x9b,0x2e  (cyc 1017336)
```

mesha calls **INT 2Fh AX=1687**, becomes a DPMI client, installs its own protected-mode INT 8 handler
at `003c:0092`, and **twelve cycles later** programs channel 0 to ~100 Hz. Install the handler, then
set the rate — the ordinary sequence.

So the whole chain resolves, and MIRAGE is right at every step:

| | |
|---|---|
| `dpmiIrq(8)` returns true 41 951 times | correct — the client owns the vector, `cr0 = 0x11` (PE set), `is32` |
| BDA `0040:006C` advances only 5 times | correct — the BDA tick belongs to the *BIOS* handler, and mesha's own handler has the interrupt |
| the resident probe TSR never fires under DOSBox | correct — a **real-mode** TSR cannot see an interrupt taken in protected mode |
| `tube` 1:1 services-to-BDA | correct — no client, so the BIOS handler runs every time |

**`intros/mesha.com` is therefore not capturable by `tools/grabber.asm` at all**, and no fix to the
grabber will change that: the instrument is a real-mode TSR and the program takes the vector in
protected mode. Adjudicating mesha against DOSBox needs a different instrument (a DPMI-aware grabber,
or a capture path that does not ride on an interrupt).

Nothing above invalidates §14's tier-2 result — the region is **late, not wrong** (byte-identical entry
state, first three timer services on the same cycle, +0.1 % cumulative lateness) — and the two real
defects found on the way stand: `dosdiff`'s fixed 7 s alarm, and the grabber calling DOS from an ISR
with no InDOS test.

**The method lesson, learned for the third time in this investigation:** every one of these wrong readings came
from instrumenting a path the code does not take — `mem.w8` when the recompiler emits inline stores,
`realInt` when the tick goes through `dpmiIrq`, the real-mode IVT when the vector is protected-mode.
Before believing a counter that reads zero, make it fire once on purpose.

### §14d. The grabber cannot be made DPMI-aware — the two emulators run different programs

Chasing "make `grabber.asm` see a protected-mode client's timer" ended somewhere else, so here is the
chain, each step measured.

**1. mesha does not chain.** A client that installs a PM handler *and chains* would still reach a
real-mode TSR through the host's reflection. Watching `dpmi.pmVec[8]` for reads and writes, the first
event is the write — no `INT 31h AX=0204` first, so nothing is chained to. That closes the easy route.

**2. So use an interrupt the client has NOT taken.** mesha hooks only vector 8, and touches neither
PIC (`0x21`, `0xA0`, `0xA1` never written — only `0x20`, and only ever `0x20`, the EOI) nor the CMOS.
The RTC's periodic interrupt (IRQ8 → INT 70h) is an independent source: `rtcprobe.asm` programs CMOS
reg 0Ah to 1024 Hz, sets PIE in reg 0Bh, unmasks IRQ8 on the slave and IRQ2 on the master, and at tick
N sets text mode 3 through the BIOS — which DOSBox prints in its log, so the probe needs no DOS at all.
It **fires for tube and not for mesha**.

**3. Which is when the actual cause turned up. DOSBox-X ships no DPMI host.** A .COM that calls
INT 2Fh AX=1687 and writes AX to a file answers **`AX=1687`** — unchanged, i.e. no host. (The
`dbx-oracle.mjs` header already records this for the file-I/O channel; it bites the pixel oracle too.)

So mesha runs **two different code paths**:

| `intros/mesha.com`, 400 ticks | DPMI host present (our default) | no host (`MIRAGE_NODPMI=1`, i.e. DOSBox) |
|---|---|---|
| returns to DOS | yes, at 214 ticks | **no — still running** |
| cycles | 501 543 260 | 590 468 949 |
| BIOS ticks (`0040:006C`) | 5 | **49 410** |
| `dpmiIrq(8)` claims | 41 951 | 0 |
| final mode | 3 (text) | **0x13** (still on screen) |
| A000 | 4d352f1a | c8640a0b |

The no-host column matches every externally observed DOSBox behaviour: it does not return to DOS in
60 s, and it stays in mode 13h. **`MIRAGE_NODPMI=1` is the knob** (added to `src/dpmi.js`, default off,
so nothing changes unless it is set) that puts both sides on the same path.

> **A DPMI-aware grabber is not the fix, and cannot be.** `grabber.asm` is a real-mode TSR; a
> protected-mode client owns the vector outright and does not chain. What comparability actually needs
> is for both emulators to answer INT 2Fh AX=1687 the same way — either give DOSBox a host, or run
> MIRAGE without one.

**And the knob exposes a fidelity gap of our own.** Without a host, mesha still enters protected mode
by itself (`CR0 = 0x11`, PE set, measured) — but MIRAGE then delivers 49 410 timer interrupts to the
**real-mode IVT**, because `tickTimer` falls through `dpmiIrq` (false: no client) straight to
`getVector(8)`. Under DOSBox no real-mode handler runs at all. A hardware interrupt taken with PE set
belongs to the guest's **IDT**, not the real-mode vector table. That is the next task, and it is a
correctness question, not a tooling one.

Also worth keeping: `!!process.env.X` is **true for the string `"0"`**, so the obvious spelling made
`MIRAGE_NODPMI=0` mean *on* and both arms of the first comparison came back identical. The existing
knobs (`MIRAGE_TIER2`, `MIRAGE_NOSTRIP`) share the spelling; this one compares against `'0'` and `''`.

### §14e. Does mesha run under DOSBox at all? — and what capture path would settle it

**Bracketing when it blocks real-mode interrupts.** `tools/rtcprobe.asm` at several tick counts, with
`tube` as the firing control:

| | N=4 (3 ms) | N=64 (62 ms) | N=1024 | N=8192 |
|---|---|---|---|---|
| tube | — | **fires** | **fires** | — |
| mesha | **fires** | mute | mute | mute |

So mesha shuts real-mode interrupt delivery off within **4 to 64 RTC ticks — under 62 ms** of the TSR
installing, which is during or just after COMMAND.COM loads it.

⚠️ The first attempt at this table was **all mute, including at N=4**, and that reading was an
artefact: the probe signalled by setting **mode 3**, and at small N the screen is *still* text mode, so
the BIOS call changed nothing and DOSBox logged nothing. A mute probe and a probe that never ran look
identical. The signal is now mode **12h** (640x480), which is neither text nor 13h and is therefore
always a visible change. Same lesson as §14c, fourth time.

**Does it render?** Not established, and I cannot claim it either way:

* it sets mode 13h and never returns to DOS in 60 s;
* DOSBox-X has no DPMI host (§14d), so it cannot take the client path it takes here;
* in MIRAGE's no-host path A000 stays **entirely black — 0 non-zero pixels across 400 ticks**.

That last one is suggestive and **cannot be used as evidence**: the no-host path is exactly where §14d
found our own defect (timer interrupts delivered to the real-mode IVT with PE set), which would produce
a black screen all by itself. No instrument here has produced a DOSBox pixel of mesha.

**What would.** Surveyed the capture techniques available:

| approach | verdict for mesha |
|---|---|
| `grabber.asm` (real-mode TSR on INT 8) | impossible — the client owns the vector and does not chain (§14d) |
| RTC / IRQ8 TSR | impossible — mesha stops real-mode delivery inside 62 ms |
| **`qblue/tools/dosbox-compare`** — the guest BSAVEs its own video memory, then SYSTEM | does not transfer: that harness *appends* the epilogue to a `.BAS` it controls. mesha is a third-party binary that never terminates. |
| DOSBox-X external capture | none exists — no screenshot, savestate or memory-dump CLI (`-helpdebug` is logging only) |
| **QEMU** — `screendump` on the monitor socket | **the one that works.** An external, guest-independent framebuffer dump: nothing to install in the guest, nothing to hook, immune to protected mode, DPMI and interrupt hijacking alike. Not installed here (`brew install qemu`). |
| give DOSBox a DPMI host (CWSDPMI is redistributable) | would put both sides on mesha's *client* path and answer "does it run" — but not capture it, since the client still owns INT 8 |

> The structural point: **every capture path we have runs inside the guest, and therefore competes with
> the guest for the machine.** QEMU's monitor is the first one that does not.

### §14f. Settled — mesha's own source, and an external capture path (QEMU)

pouet lists **source code** for mesha (Rhyme, 1st at Assembly 1998, PC 4K):
`files.scene.org/.../Source/intro/meshasrc.zip`. It contains `PMODE4K.ASM`, the protected-mode
extender, whose header states the whole thing outright:

```
; Micro 32bit Protected Mode Manager v2.00                  by Picard 1998 (c)
;   -XMS,DPMI (no RAW,VCPI)
;   -NO hardware interrupts, only timer interrupt available
;   -timer speed to 100Hz (adjustable)
```

Three measurements made here are confirmed by that comment rather than inferred:

* **"only timer interrupt available"** — the extender masks every hardware interrupt but the timer,
  which it owns. That is why `rtcprobe.asm` goes mute within 62 ms (§14e) and why no real-mode TSR can
  ever run. **No in-guest, interrupt-driven grabber can ever capture this program.** Not a tool defect.
* **"timer speed to 100Hz"** — matches the measured reload `0x2E9B` = 11931 exactly.
* **"XMS,DPMI (no RAW,VCPI)"** — it needs one of the two, and the init is a plain fallback:

```asm
        mov AX,1687h        ; check DPMI
        int 2Fh
        or  AX,AX
        jnz UseXMS          ; no host -> try XMS
UseXMS: mov AX,4300h        ; check himem.sys
        int 2Fh
        cmp AL,80h
        jz  XMS_Ok
InitError:
Quit:   mov AL,3 / int 10h / mov AH,4Ch / int 21h   ; otherwise: text mode, exit
```

**Does mesha run under DOSBox? Yes.** DOSBox provides no DPMI host (§14d) but does provide XMS, so it
takes the `UseXMS` branch. The proof is the `InitError` path: it exits in **milliseconds**. Under
DOSBox, a marker program placed after mesha in the autoexec never runs, at 60 s — so mesha did not take
that branch, i.e. it initialised and is running. Our own runs take the DPMI branch, which is a
different branch of the same program but not a different program.

**And there is now an external capture path.** `tools/qemu-shot.mjs` boots MS-DOS under QEMU with the
program's directory exposed through vvfat, types the command with monitor `sendkey`, and takes the
picture with monitor **`screendump`** — read from the emulated VGA on the HOST side. It does not care
what mode the CPU is in, who owns the interrupts, or whether the program ever terminates, which is
precisely what every previous instrument could not survive. Validated on `tube`: mode 13h, the real
picture. On mesha it returns a bare `C:\>` — correct, and informative: that boot floppy loads neither
HIMEM.SYS nor a DPMI host, so mesha takes `InitError` and quits. Giving the QEMU guest XMS is what
would let it be compared frame-to-frame.

Two harness bugs found by *looking at the picture*, both of which a blind pass/fail would have
reported as "the program drew nothing": `boot/FREEDOS14.IMG` is an **installer** disk that stops at
`Do you want to proceed [Y,N]?`, and MS-DOS 6.22 with no AUTOEXEC.BAT asks for the date and time first,
so the typed commands were answered with `Invalid date`.

### §14g. Giving QEMU a DPMI host — yes, and what it showed

`tools/qemu-shot.mjs` takes `QSHOT_DPMI=<path to CWSDPMI.EXE>` (Charles Sandmann's freeware DPMI host,
`csdpmi7b.zip` from delorie.com) and installs it before the program. It is a plain TSR, so it runs off
the vvfat drive and nothing has to be written into the boot image. **Verified, not assumed**: a .COM
that calls INT 2Fh AX=1687 and prints AX shows `CWSDPMI V0.90+ (r7)` and then `AX= 0000` — host
present, against `AX= 1687` without it.

Three failures on the way, each of which a blind pass/fail would have called "the program drew
nothing", and each found only by *looking at the captured screen*:

1. `cwsdpmi -p` arrived as `cwsdpmip` — the `sendkey` map covered no space and no dash, so those
   keystrokes were silently dropped and DOS answered `Bad command or file name`. The map now throws on
   an unmapped character instead of dropping it.
2. `Error: could not allocate page table memory`. CWSDPMI's own doc names this exact case: *"If the
   application which calls CWSDPMI internally manages all the DOS memory, the page tables may need to
   be pre-allocated at DPMI startup time — try using the run option flag 2 in cwsparam."* A `.COM` owns
   all of conventional memory and PMODE4K manages it itself. Not a memory-size problem: identical at
   4, 16 and 64 MB. `QSHOT_PRE` now drives `CWSPARAM` to set flag 2.
3. With that set, mesha clears the error and reaches **mode 13h** — and the screen stays **black at
   12 s, 40 s and 90 s**.

> So: MIRAGE renders mesha on the DPMI branch; QEMU with a real DPMI host does not. One of the two is
> wrong and this does not say which. The likely reading is that **the DPMI branch is not the one the
> intro was developed against** — it is 1998, HIMEM.SYS was on every machine, and `UseXMS` is the
> branch DOSBox takes and that its authors would have tested. Our host may simply be more permissive
> than a real one.
>
> **The next step is therefore XMS, not more DPMI tuning**: an XMS driver in the QEMU guest puts it on
> DOSBox's branch and on the intro's own. Neither `boot/MSDOS622.IMG` (no HIMEM.SYS — root listed) nor
> `boot/FREEDOS14.IMG` (no HIMEMX in `freedos/bin`) carries one, so it has to be added. The FreeDOS
> image mounts read-write on macOS with
> `hdiutil attach -imagekey diskimage-class=CRawDiskImage`, so `FDCONFIG.SYS` is editable — that is the
> route.

### §14h. DPMI as an option, and mesha on the XMS branch — 2026-09-05

**DPMI is now optional in the same shape as XMS and EMS.** `installBIOS` already read
`opts.xms !== false` and `opts.ems !== false`; `installDPMI` was the one called unconditionally. It now
takes `dpmi`, passed through `tools/harness.mjs`, with `MIRAGE_NODPMI=1` left as the global default for
the tools that take no options. The knob no longer lives *inside* the INT 2Fh handler — a host that is
not wanted is simply not installed, which is what the other two do.

**mesha, all three configurations, 400 ticks:**

| | ticks | returns to DOS | PE seen | final mode | max lit pixels |
|---|---|---|---|---|---|
| DPMI + XMS (default) | 214 | yes | yes | 0x3 | **9143** (tick 133) |
| **XMS only** (`dpmi: false`) | 400 | **no** | yes | **0x13** | **0** |
| neither | **1** | yes | **no** | 0x3 | 0 |

The third row is a **positive control for the whole setup**: with neither service mesha quits at tick 1
in text mode, which is exactly `InitError` in `PMODE4K.ASM` (`cmp AL,80h` fails → `int 10h` mode 3 →
`AH=4Ch`) and exactly what QEMU showed with no HIMEM and no DPMI host. The harness is measuring what it
claims to.

> So on the **XMS branch — the one DOSBox takes** — MIRAGE enters protected mode, sets mode 13h, and
> **never draws a single pixel** across 400 ticks. That is our defect, not the intro's.

**And the diagnosis in §14d needs correcting.** I expected the fault to be hardware interrupts
delivered through the real-mode IVT with PE set. Measured, the picture is different:

* mesha loads a **GDT** — base `0xa875`, limit `0x18`, four descriptors;
* it **never loads an IDT** — `idtr` stays at its reset value (base 0, limit 0x3FF);
* MIRAGE delivers **49 410** INT 8 to the real-mode BIOS handler.

A guest running in protected mode with the reset IDTR is not expecting to take interrupts there, which
matches PMODE4K's own header: *"NO hardware interrupts, only timer interrupt available"*. The extender
switches back to **real mode** to service them rather than handling them in PM. So the failure is in
that **real↔protected switching**, not in interrupt dispatch, and the 49 410 real-mode deliveries may
well be correct. `LGDT`/`LIDT` are implemented (`recompiler.js:1588`), so that is not it either.

Gates on the option change: golden 43/43, conformance 555764/555764, `test.js` 194/194,
`test-dos-api` 268/268, `dpmi-probe` clean.

### §14i. Tracing mesha's `mov cr0` — and what it corrects — 2026-09-05

`tools/cr0-trace.mjs` hooks `cpu.setCR0`, the single writer, and logs every PE transition in both
configurations.

```
DPMI + XMS : 1 bascule PE   PE 0->1  cr0 10->11  a lin=f0200  CS.D=0  gdt=0/0       cyc=1017297
XMS seul   : 1 bascule PE   PE 0->1  cr0 10->11  a lin=93cb   CS.D=0  gdt=a875/18   cyc=1017315
```

**One transition each, and never back.** So §14h's reading — *"the extender switches back to real mode
to service interrupts"* — is **wrong**: PMODE4K never clears PE. And the two entries are different in
kind: the DPMI branch switches at `f000:0200`, our own JS host entry, with no GDT of its own; the XMS
branch switches inside mesha's code at `lin 0x93cb` with the GDT it built (base `0xa875`, limit `0x18`).

**The XMS branch is not writing to the wrong place — it is not writing at all.** Comparing memory
across 15 ticks in mid-run:

| animated regions | |
|---|---|
| DPMI | `0xa0000-0xaffff` (the framebuffer), `0x7ca000-0x808fff`, `0x80a000-0x819fff`, three more |
| **XMS** | **none** |

And the execution profile says why:

| over 10 ticks | DPMI | XMS |
|---|---|---|
| **distinct blocks executed** | **108** | **6** |
| outer loop at `a13d` | 480 | **24 288** |
| retrace wait at `a482` | 169 172 | **3 950 412** (98.8 % of all block executions) |

`a482` is `IN AL,DX` / `TEST AL,8` / `JZ` — the 0x3DA vertical-retrace wait. It is **not** deadlocked:
both branches read the port and both see bit 3 set (152 times in 6 ticks on the XMS branch). The loop
turns; it just never reaches the rest of the program. Six blocks against a hundred and eight.

The loop body calls indirectly — `call dword [ebp-0x2c]`, twice — and `EBP` differs structurally
between the branches (`0x100000`, the XMS extended-memory base, against `0` at the sampled instant).
**That indirect target is where to look next**, not the interrupt path and not the mode switch.

### §14j. Root cause — hardware interrupts were never dispatched through the IDT — FIXED 2026-09-05

`[ebp-0x2c]`, which §14i pointed at, is **innocent**. Sampled while the loop is turning — and through
**SS**, since EBP-relative addressing defaults to SS, which the first attempt got wrong — both branches
read the same target:

| | EBP | `[SS:EBP-0x2c]` | target |
|---|---|---|---|
| DPMI | `0x7c0000` | `0x41f` | lin `0x983f`: `53 51 52 8b 73 28 0b 71` |
| XMS | `0x100000` | `0x41f` | lin `0x983f`: **identical bytes** |

Only EBP differs, and that is just where the extender put the client's data (`0x100000` is the XMS base).

**The experiment that settled it** was to cut timer delivery in the branch that *works*:

| | distinct blocks | framebuffer over 10 ticks |
|---|---|---|
| DPMI, normal | 108 | changed at 3710/4000 probes |
| **DPMI, timer cut** | **6** | **0** |
| XMS only | **6** | **0** |

Identical signature. All of mesha's rendering lives in its timer handler.

**And its own source says how that handler is installed on the XMS branch** (`PMODE4K.ASM`):

```asm
xor AX,AX / mov DS,AX / mov SI,64      ; 64 = 0x40
movsw / movsw
mov [d SI-4], o Int_Timer + Sel_Code32*10000h
movsw / movsw
mov [d SI-4], 8E00h
```

It keeps the **reset IDTR** (base 0) and writes its gate straight to linear `0x40` — which is
`base 0 + vector 8 * 8`. There is no `LIDT` to notice, which is why §14h concluded "no IDT at all".
Verified in memory: `92 00 08 00 00 8e 00 00` — offset `0x92`, selector `0x08`, access **`0x8E`**, a
present 32-bit interrupt gate; and offset `0x92` is the very handler the DPMI branch installs through
`INT 31h AX=0205`.

> **The defect was ours**: `tickTimer` never consulted the IDT. With PE set and no DPMI client it fell
> through to `getVector(8)` — the **real-mode** vector table — and ran our own BIOS handler. So a
> guest that switches to protected mode by itself, rather than through a DPMI host, never received the
> timer at all.

`_protInt` already decoded a gate at `idtr.base + n*8` (offset, selector, 32-bit gates, the target's
DPL as the new CPL), so the fix is to route the tick there, guarded on the gate's **present** bit and
the IDT limit so a protected-mode guest with no IDT keeps the previous behaviour. V86 is excluded for
now and is a separate question.

**Result: the two branches are now identical** — 214 ticks, terminates, mode 3, 9143 lit pixels each.
mesha renders on the branch DOSBox takes, for the first time.

Gates: golden 43/43, conformance 555764/555764, `test.js` 194/194, `test-dos-api` 268/268, `test-x86-uc`
green. The DPMI path is untouched (`dpmiIrq` still claims the tick first), which is why mesha's own
pinned fingerprint does not move.

## 15. A reprogrammed timer ran 2.79x fast — measured 2026-10-11

`setPitReload` took the reload a guest writes to counter 0 — PIT ticks, 65536 to the BIOS's 18.2 Hz —
as a number of CPU cycles. The two were the same unit while `pitBase` was 65536; §7 made it 182584
and every reprogrammed timer has run 2.79x fast since, in the browser too (`ui.js` divides
`pitReload` by `pitBase`). §8 did not see it: its 4096 divisor hits the `pitBase>>4` floor, which is
exactly 4096 ticks, and its 68 is below it. Found through DOOM, whose DMX timer asks for 104.6 Hz
and got 291.

`tools/pitrate.asm`, same binary on both sides, INT 8s in 70 retraces:

| divisor | requested | DOSBox-X | MIRAGE before | MIRAGE now |
|---|---|---|---|---|
| 4096 | 291 Hz | 291 | 290 | 290 |
| 11932 | 100 Hz | 100 | **278** | 99 |
| 32768 | 36.4 Hz | 37 | **101** | 36 |

The reload is now converted, `r * pitBase / 65536` cycles; the floor is unchanged. Three goldens
reprogram the timer and moved — animate (256 Hz asked), mesha (100 Hz), starport (70 Hz); all three
still draw their picture.

## 16. DOOM at four frames a second in Chrome: self-modifying drawers — measured 2026-10-11

`tools/chrome-perf.mjs` runs a page in headless Chrome (the app's own pane is hidden, and a hidden
tab gets no requestAnimationFrame) and samples guest instructions, frames and main-thread load each
second, with a JS profile. DOOM's demo: 0.5 M instructions/s, 4 frames/s, the main thread 100% busy —
68% of it "(program)" and 30% garbage collection, V8 compiling and discarding the JS we emit. The
sound (OPL, SB, the worklet) was under 1%.

The cause is §9's, in a game: DOOM's R_DrawColumn takes each column's texture step as the immediate
of `add ebp,imm32` and rewrites it per column; every write evicted the block, the next column
translated it again — 14 000 translations in 8 s. Heretic's R_DrawSpan writes a one-byte
terminator into its unrolled loop, at a different place for every span, evicting a 400-byte block
each time.

- An immediate whose bytes have evicted their block twice is translated as a read of memory at run
  time (`immX` in translate; ALU 80h/81h/83h, MOV B0h-BFh, C6h/C7h), and a write that lands only in
  such bytes no longer evicts. DOOM: invalidations 20 000 → 370 over 30 s; the picture identical to
  the pixel at four points of the demo.
- A page that has taken 64 evictions is translated in blocks of 8 instructions, so a rewritten opcode
  costs a short retranslation.

Chrome, same page: DOOM 0.5 → 50 M instructions/s and 4 → 60 frames/s; Heretic ~10 → 50-60 frames/s.
tube (bench.js, alternated x3) unchanged. Five goldens moved (crevenge, freality, mesha, omniscent,
qblove): their blocks end in other places now, the same pictures at slightly different moments.

## 17. The INT 8 floor, lowered to 1165 Hz — 2026-10-11

The floor of §2 and §8 (pitBase>>4, 4096 PIT ticks, 291 Hz) sat below what games ask for their own
clocks: Keen 4 sets 561 Hz, Wolf3D ~700 Hz for its sound service, which also counts its 70 Hz
TimeCount. They ran 1.9x and 2.4x slow, in the browser too, where ui.js had its own 3 ms (333 Hz)
floor. In Chrome, Wolf3D sat on its title screen past 30 s; at 701 Hz it runs its attract loop.
The floor is pitBase>>6 now, 1024 ticks, about 1165 Hz, and ui.js's is 0.8 ms; Chrome Revenge's
17.5 kHz stays capped. tools/pitrate.asm -dDIVIDER=2128: DOSBox-X 560, MIRAGE 559 (290 before).
Goldens abstract, crevenge, omniscent, paleozoa and qblove ask for more than 291 Hz and moved: the
same pictures, further on, as their clocks run at the rate they set.

## 18. CWSDPMI under FreeDOS: 128 000 translations a second — measured 2026-10-11

Kraptor and Liquid War on the FreeDOS disk ran at 1.7 M instructions a second in Chrome, the page
busy in translate(). Counted there (tools/chrome-perf.mjs PROBE): 2600 paging transitions a second,
two per timer tick, as CWSDPMI returns to real mode for each interrupt, and each one reset the whole
block cache; CWSDPMI also loads CR3 while paging is off, which took the same path; and Allegro's FLDCW,
changing the precision control thousands of times a second, reset it too.

- The recompiler keeps one cache per paging state and swaps them (switchPaging). The cache put away
  is not watched for writes, so each of its blocks is compared with its bytes (`snap`) on its first
  dispatch after it comes back.
- A CR3 load with paging off changes nothing; a CR4 change under paging is handled as a CR3 load.
- A change of precision bumps the epoch; _revalidate drops only the FPU blocks translated under
  another precision (`fprec`).

Kraptor: 613 000 translations in 5 s → 29; 1.7 → 35-50 M instructions a second, and its title screen.
tube unchanged; golden 44/0.
