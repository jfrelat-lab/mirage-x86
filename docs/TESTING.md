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

## test386.asm (`tools/run-test386.mjs`)

A third kind of CPU oracle, and the only one that is a *program*: [test386.asm](https://github.com/barotto/test386.asm)
is a self-checking tester whose author read the manuals and encoded the expected behaviour as
executable assertions; PCem and 86Box use it on themselves. It runs as a BIOS replacement — the 64 KB
image IS the F000 segment, entered at the reset vector — and reports a rising sequence of codes to
the POST port (0x190 by default). The last code before it stops is the diagnostic.

    node tools/run-test386.mjs boot/test386.bin

It earned its place in the first ten minutes by finding two real defects the per-instruction
harnesses structurally could not:

* **`MOV CS,r/m` did not raise #UD.** The instruction does not exist; we executed it. Nothing
  legitimate does this, but a CPU-detection routine probing an instruction's existence via #UD gets
  the wrong answer.
* **The whole 0x66 control-transfer family transferred 16 bits.** `CALL`/`JMP rel`, the indirect
  `FF /2`/`/3`/`/4` forms, `CALLF`/`JMPF ptr` and `RETF` all ignored the operand-size prefix: the
  return address was pushed as a word instead of a dword, so the stack was two bytes out for the
  rest of the frame, and the far-pointer *immediate* was read as 2+2 bytes instead of 4+2 — which
  DESYNCHRONISES the instruction stream, the same failure shape as the 0x67 bug that derailed Heaven
  for a week. Four POST stages' worth of tests were sitting behind it.
* **`LDS`/`LES`/`LSS`/`LFS`/`LGS` read the selector at the wrong offset under 0x66.** The offset
  is a dword there, so the selector sits at +4; we read +2 regardless and loaded half the offset as
  the segment. Same family as the control transfers, and the last of the audit's T0.3 list.
* **We assumed the F000 segment was ours.** `swInt` claimed any vector pointing into F000, so a
  guest that replaces the ROM — which is exactly what test386 is — had its own exception handler
  swallowed, and spun on the faulting instruction forever. The vector is now only claimed when our
  own 0xCF stub is still the byte at the target.

Build it with NASM (`git clone https://github.com/barotto/test386.asm && make`); `boot/` is
gitignored. **Its entire real-mode section now passes** (POST 0-6), up from POST 3 when it was first run. What
follows POST 6 is protected mode, which MIRAGE does not implement — so test386 has nothing further
to tell us until roadmap B4 lands. That makes it a finished ladder rather than a failing gate.

### Generated cases (`tools/x86-gen.mjs`)

The 86 hand-written cases test what I thought of; the `0x67` bug that derailed Heaven for a week
lived in a corner nobody thought to write a case for. The generator does not think — it walks the
ModRM/SIB/prefix grid mechanically for a table of opcode templates and asks the oracle. Seeded
xorshift, no `Math.random`, so a seed always yields the same cases and the committed expectations
stay meaningful; change the seed or the tables and you must re-capture.

Every generated case has to be safe to run: registers that take part in an effective address are
clamped so the access lands inside the 256-byte scratch area, and counts for `SHLD`/`SHRD` are held
below the operand size because the result above it is architecturally **undefined**. That last rule
is not cosmetic — the first run without it reported 16 "failures" that were only Unicorn's choice in
undefined territory, the same trap as BCD and as the MUL flags in the co-simulator.

`GEN_SEED=… GEN_COUNT=… node tools/test-x86-uc.mjs --capture` re-rolls the set. Two further seeds at
2000 cases were tried and also passed clean, which is what makes "the grid is covered" a measurement
rather than a hope.

## CPU profiles (`src/cpu-profile.js`)

`new Machine({ cpu: '8088' | '286' | '386' })` selects which x86 generation the engine claims to be;
the default is `386`. Nearly every difference resolves at translation time, so a profile is a
constant in the emitted JS and costs nothing at run time.

Why it exists: MIRAGE was a hybrid nobody shipped — 8088 on some 16-bit corners, 286 on others
(shift counts masked to 5 bits, `PUSH SP` pushing the entry value), 386 decoding throughout. Several
of those differences are exactly how a DOS program **detects** the CPU, so a program could reach a
conclusion no real machine supports and pick a code path on it.

The profile is also what makes the conformance gate honest. Those vectors are captured from **8088
silicon**, so `tools/conformance.js` now selects the `8088` profile by default. It used to run under
the shipping default and skip the 28,113 cases where the generations genuinely differ — which meant
the gate quietly excluded the cases most likely to expose a bug. `MIRAGE_CPU=386 node
tools/conformance.js` still runs it under the shipping profile, with those skips, to check that
profile has not drifted.

Completing the 8088 profile was the work that bought this. The shift *mask* was plumbed but the
arithmetic for counts >= the operand size was not implemented — JS's own `<<`/`>>` mask to 5 bits, so
a shift of 32 silently became a no-op. `MIRAGE_CPU=8088 node tools/conformance.js d2.4 d3.4` went
**81.19% → 100%** (8000/8000), and the full run from 527,651 compared cases to **555,764**.

Still to come: `PUSHA`/`BOUND`/`ENTER` raising #UD below a 186, `0x66`/`0x67`/SIB below a 386, and
the undefined-flag values after MUL/DIV/BCD. The last needs the hardware-generated 286/386 suites
([SingleStepTests/80286](https://github.com/SingleStepTests/80286),
[/80386](https://github.com/SingleStepTests/80386) — real silicon, same author as our 8088 vectors),
which ship in a binary **MOO** container rather than JSON, so a decoder is a prerequisite.

## The VGA oracle (`tools/vga-rom.mjs`)

Asking "is our INT 10h mode set correct?" has no oracle — we wrote both the question and the answer.
Loading a **real VGA BIOS ROM** turns it around: the ROM is placed at C000:0 and entered by a far
call to C000:0003 exactly as a POST does, it programs the card and points INT 10h at itself, and from
then on a mode set runs real 16-bit code against our device model. Any difference is then in our
*hardware*, not in our approximation of a BIOS.

    node tools/vga-rom.mjs boot/vgabios-stdvga.bin
    MODE=0x12 node tools/vga-rom.mjs boot/vgabios-stdvga.bin
    MODE=0x0d DUMP=1 node tools/vga-rom.mjs boot/...        # print one mode's register table

SeaVGABIOS narrates itself on port 0x402 (the QEMU/Bochs debug console) and the tool prints that too.
The ROM ships prebuilt with QEMU as `pc-bios/vgabios-stdvga.bin` (LGPL); `boot/` is gitignored.

## The DOS oracle (`tools/dos-oracle.mjs`)

`test-dos-api.js` states its expectations by hand, and three of its early cases were wrong because I
derived them by hand. The fix that worked for the CPU was to stop deriving and start observing. Since
a real kernel boots on our BIOS (roadmap F2d), the same move is available for the DOS layer:

    node tools/dos-oracle.mjs capture   # boot FreeDOS, record every INT 21h in -> out
    node tools/dos-oracle.mjs check     # replay the recording into our INT 21h and diff

An INT 21h serviced by the guest's own kernel goes swInt -> realInt, so there is no "handler
returned" hook; the capture remembers where the frame will unwind to and watches for the CPU to
arrive back there with the stack restored.

The comparison has two tiers. **State-light calls** are replayed on a fresh machine. **File calls
are replayed in order on one machine**, with the boot image's own FAT12 filesystem mounted
(`tools/fat12.mjs`) and the kernel's handle numbers mapped onto ours — the state a file call depends
on, reproduced on purpose. A read is compared on the bytes it delivered, not just the count.

Two limits, both deliberate. **The comparison runs over a whitelist** of calls whose answer does not
depend on state we cannot replicate — widening it means replicating state on purpose, one function at
a time, not loosening the filter. And **FreeDOS is a peer, not an authority**: where it and MS-DOS
differ neither is automatically right. What this catches is our answers being differently *shaped*
from a real kernel's, which is a more tractable question than "which DOS is correct".

The recording is committed, so `check` runs without a boot image.

## ⚠️ The DOS oracle was silently recording nothing (fixed 2026-08-22)

`tools/dos-oracle.mjs capture` wrapped **`cpu.swInt`**. That is a binding the machine installs for
code holding only a CPU; the path from emitted code is `cpu.softInt` → `machine.softInt` → `this.swInt(n)`,
which resolves on the MACHINE and never touches it. So the hook saw **4,274,325 softInt calls and
captured zero**, and `capture` then wrote that empty result over a 3978-record baseline — recoverable
only because the file is in git. It hooks `mc.swInt` now, and `capture` refuses to replace a
recording with one under 90% of its size unless you pass `--force`.

The lesson generalises past this tool: a hook placed on the wrong side of a dispatch chain fails
*quietly*, and a capture tool that overwrites its own baseline turns that silence into data loss.

With it working, the answer is worth having: **3964/3964 calls match** a real FreeDOS kernel
(1408 state-light, 2556 sequential file calls, 14 skipped because their handle predates the
recording). This is the authority on what a call RETURNS, where `dbx-oracle.mjs` is the authority on
the SEQUENCE a program produces — and it is now usable again, because FreeDOS boots to its shell.

## The DOSBox-log oracle (`tools/dbx-oracle.mjs`)

Not to be confused with `dos-oracle.mjs` above — one hyphen apart and a different question.
`dos-oracle` is the authority on what a call **returns**; this one is the authority on the
**sequence** a real program produces.

DOSBox-X's `-debug -log-fileio -log-int21` prints every file a program opens, reads, seeks, creates,
deletes and closes, every INT 21h function, and every video mode. Both sides are normalised to one
event vocabulary and compared as a **prefix** — DOSBox is killed from outside and MIRAGE stops on its
own budget, so only the common prefix means anything.

    node tools/dbx-oracle.mjs games/DOOM DOOM.EXE      # one title (cached log under .dbxlogs/)
    node tools/dbx-oracle.mjs --capture games/X Y.EXE  # re-capture the reference
    node tools/dbx-oracle.mjs --sweep [filter]         # the whole corpus, ~2 min
    --strict                                           # compare byte counts and seek offsets too

**Three separate channels** (file / video / int21), never interleaved: they are independent
subsystems whose relative order neither emulator promises. Comparing them as one stream reported a
divergence for Keen 1 that was only "the mode was set a few opens later".

### The normalisations, every one of which was a false positive first

Building this cost six wrong readings, all in the tool rather than the engine. They are listed
because each looks like a defect and none is:

| Trap | What it looked like | What it was |
|---|---|---|
| AH printed unpadded (`ah=e`) | six titles diverging on the first call | pad both sides to two digits |
| failed opens suppressed on our side | eight titles diverging where the reference opens a settings or high-score file | DOSBox logs the **attempt**; those files are absent from the directory |
| creates and deletes | Roc diverging at its second event | they have their **own** line shapes, neither of which looks like an open |
| empty filename | Dave carrying one event more, for ever | `file open command 0 file ` with nothing after; `(.+)` needed a character |
| EXEPACK | Maniac Mansion diverging from its first INT 21h | the reference **exited 255** on "Packed file is corrupt"; retried through LOADFIX automatically |
| a wall-clock budget | Duke 1 apparently going from 1869 events to 16218 | noise; **bound in cycles**, run the sweep alone |

### Environmental differences that are NOT defects

Two of these are permanent and documented in the tool's header. Rule them out before chasing
anything.

**Free conventional memory.** Our HLE DOS is resident in almost nothing, so the PSP sits at 0x0100
where DOSBox's is around 0x0800 — about 29 KB more for the program. Any title that binary-searches
for its largest block (SCUMM does, in AH=48/49 pairs) converges elsewhere: Indy 3, Maniac Mansion and
Monkey Island diverge for exactly this and nothing else, with every one of their file events
agreeing. Deliberately **not** auto-flagged, because a real allocator defect looks identical from
outside — measure the sizes before concluding.

**A DPMI host.** DOSBox answers none on INT 2Fh AX=1687, so an extender there falls back to hunting
VCPI/EMS. Doom, OMF and Heaven Seven all read the INT 67h vector at INT 21h call #16 where we go
straight on, and Jazz loads its bundled DPMI.000 where we skip to RTM.000. The sweep labels these
"chemins DPMI divergents (attendu)".

## The EGA/VGA pixel reference (`tools/egaref.mjs`, `tools/shot.mjs`, `tools/frame.mjs`)

`dosdiff.js` covers one self-contained mode-13h program. Most of the corpus is neither: a multi-file
game in a 16-colour planar mode, and until 2026-08-18 none of those had any pixel reference at all.

    node tools/egaref.mjs BABYJO BABY.EXE 2600 /tmp/ref.png   # DOSBox side, K = timer interrupts
    node tools/shot.mjs   BABYJO BABY.EXE 2600 /tmp/ours.png  # ours, same clock
    KEYS="-w 8 enter" node tools/egaref.mjs ...               # AUTOTYPE, to get past a menu
    RUNS=1 ...                                                # print per-row pixel runs instead of eyeballing

`grabber-ega.asm` goes resident, chains INT 8, and dumps the four planes through the Graphics
Controller's read-map-select plus the CRTC offset/start and the sixteen attribute entries. Both sides
compose through `frame.mjs` **on purpose**: with separate renderers, a difference in the picture would
not say whether the DATA differs or only the two renderers disagree.

Three things to know before using it:

- **Bound on the BIOS tick counter (0040:006C), never on host iterations.** `run-game.mjs`'s loop
  advances ~150 guest ticks per iteration, so its "frame 40" is minutes of guest time.
- **The two tick rates are not the same clock.** A game that reprograms the PIT (Baby Jo runs it at
  291 Hz) makes our counter race DOSBox's 18.2 Hz grabber ticks by 16×. Asking the reference for our
  tick count once asked it for 41 minutes.
- **The grabber dies when the guest takes over INT 8** without chaining, which is what reprogramming
  the PIT usually comes with. Baby Jo captures at 60 and 200 ticks and never at 45000. Later screens
  need a trigger the guest does not own.

DOSBox-X has **no scriptable screenshot** — it is the F12+P host hotkey, with no command and no config
trigger — so the grabber is the only dump path headless. `AUTOTYPE` *is* a real internal command and
is how you drive the guest past a menu.

## Is the BDA tick the PIT counter? (`tools/tickq.asm`)

`0040:006C` — ticks since midnight — is either the PIT's own counter or a software counter kept by
the BIOS `INT 8` handler. It decides where the increment belongs, and `tools/test-dos-api.js`
asserted the first answer in so many words ("the counter is not the interrupt"), with
`machine.tickTimer` bumping it per PIT tick to match.

That is wrong, and the cost was large: a title that reprograms counter 0 then ran the DOS clock at
*its* rate. Monkey Island programs 2521 (473 Hz), so `0040:006C` advanced ~16x too fast and every
capture bounded on the BIOS tick — `tools/shot.mjs`, and with it every DOSBox pixel comparison that
claims to stop at "the same moment" — photographed a screen the game had not drawn yet.

`tools/tickq.asm` asks the reference instead. It masks IRQ0 at the PIC, busy-loops, and reports
whether the tick moved; `-DNOMASK` builds the control, same loop, same length, IRQ0 left alone.

    control (IRQ0 unmasked): RESULT: BDA TICK ADVANCED
    masked:                  RESULT: BDA TICK FROZEN

So it is software, and the increment lives in `bios.js`'s `INT 8` hook — the one a guest ISR chains
to. A game that reprograms the PIT keeps the DOS clock at 18.2 Hz by chaining once every N of its own
ticks, and Monkey Island now chains **24.8:1** against the **26:1** its divider implies. (The
residual is the anti-storm clamp on `pitReload`, which is D7, not this.)

⚠️ Run it on a SLOW clock. DOSBox `cycles = fixed N` is N cycles per **millisecond**, so at anything
brisk the whole loop finishes inside half a tick and the *control* reads "frozen" too — which is
exactly how the first run of this looked like a result and was not one. `cycles = fixed 3000` works.

## Reading the ROM identity (`tools/biosid.asm`)

A one-shot COM that writes F000:FFF0..FFFF to a file, so the values a real machine carries can be read
off the reference instead of invented. Ours were zeros; Turbo Pascal scans that region, ran off the
end of memory and executed the interrupt vector table.

## Classifying a derail (`src/derail.js`)

Four investigations in one day began with a message naming an opcode, and in all four the opcode was
innocent — the guest had left its own code and we were decoding whatever it landed in:

| Title | Where it actually was | What the message said |
|---|---|---|
| Turbo Pascal | the real-mode IVT, after a 1 MB wrap | `unimplemented opcode 0x0f 0x53` (an SSE opcode, in a 1989 program) |
| MS-DOS 6.22 | the same table, where `62 07` reads as BOUND | an unhandled `#BR`, looping |
| test386 | the IDT — gate access bytes `8e`/`ee` | an instruction |
| Crystal Dream 2 | its own error string, `"Exception fault."` | `INT 06h` re-raised |

Every time, the first move was to implement or investigate the opcode, and every time that was wrong.
So the two diagnostic paths — the unimplemented-opcode throw in `recompiler.js` and the
exception-loop detector in `machine.js` — now classify the address before printing it:

```
mirage: unimplemented opcode 0x0f 0x53 at linear 0x30 — INSIDE THE REAL-MODE IVT (vector 12) —
the guest left its own code. Implementing the opcode would be the wrong fix.
Recent block starts (oldest first, the last is this one): 0003:0
```

`describeRegion(mem, lin, cpu)` recognises the IVT, the BIOS data area, the IDT/GDT/LDT (from the
CPU's own registers, so it follows a guest that reloads them), a run of zeros, text, and packed
data. It returns
`''` for anything that looks like ordinary code, because a false positive sends the reader the wrong
way — `tools/test.js` asserts that on hand-written code.

The text test is a run of eight printable bytes, at least 60 % of them letters or spaces, and the
quote is taken from the *start* of the run rather than from the fault address: Crystal Dream 2 lands
mid-string, and "ception faul" is much harder to recognise than `"Exception fault."`. Requiring a
whole printable window — the first version — rejected that very case, since the message embeds a
`0x12` separator.

**Packed data** — a bitmap, a table. Pinball Fantasies executes a sprite mask,
`ff fc 00 ff ff c0 ff ff f8 00 7f ff 80 …`, and surfaced as `unimplemented opcode 0x0f 0xff`. The
thresholds here are measured rather than guessed: over **380 583 block starts the recompiler actually
translated and ran** across the corpus, a zero-density test alone fires on **75 % of real code** —
code is full of zero bytes — while additionally requiring six `0xff` bytes in the window drops that
to **4 in 380 583 (0.001 %)**. The `0xff` count is the whole discriminator.

**The forward walk.** Real code branches. When the recent blocks advance by an identical positive
step three times over, the decoder is walking straight through memory a maximum-length block at a
time, and the derail is *earlier* than the address being reported. test386 walked upward in ~0x180
steps for a long way before it reached the IDT and surfaced as an opcode; reading that walk as the
symptom rather than the trail cost real time.

Applied to the corpus, all three faults `tools/survey-gaps.mjs` finds across 84 programs are now
named rather than merely located:

| Program | Was | Is |
|---|---|---|
| `games/CD2/CD2.EXE` | `INT 06h re-raised at 2e1d:0165` | executing `"Exception fault."`, its own error string |
| `games/PINBALL/PF.EXE` | `unimplemented opcode 0x0f 0xff` | executing a sprite mask |
| `intros/oktaeder.com` | `INT 06h re-raised at 0018:0ad4` | executing the DOS **environment block** — `"C:\oktaeder.com"`, right after `BLASTER=A220 I7 D1 H5 T6` |

Two lessons are baked into the heuristics, both from getting them wrong first: a fault lands
*inside* the region, not at its start, so the printable run is measured **around** the address in
both directions (Crystal Dream 2 stops three words into its message, oktaeder three bytes from the
end of its path); and the exception-loop detector must use `cpu.base[CS]`, not `seg[CS] << 4`, since
in protected mode the shift is fiction.

The block path comes from a 16-entry ring the recompiler writes in `translate()`. That is the
*compile* path, entered once per new block, not the hot execution path, so it costs nothing
measurable (`bench.js tube memories` unchanged).

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
| **386 semantics vs Unicorn** | `node tools/test-x86-uc.mjs` (`--capture` to refresh) | 2086 cases — 86 hand-written plus **2000 generated** (`tools/x86-gen.mjs`) (single instructions + multi-instruction **sequences**) whose expected values are **observed from Unicorn** (QEMU's TCG core), not hand-derived: `0x67` ModRM/SIB forms, `0x66` operand size (CWDE/CDQ, PUSHAD/PUSHFD, 32-bit ALU), BT/BTS/BTR/BTC bit-string offsets on memory, string ops/XLAT/LOOP under `0x67`, shift/rotate flag corners, and sequences that exercise the **dead-flag elimination** pass (producer → consumer → killer, INC/DEC preserving CF, shifts with a runtime count of 0, REP with CX=0, LAHF/PUSHF reading the whole word, bounded loops). The captured reference is committed, so the gate needs neither Python nor Unicorn. ⚠️ **BCD (27/2f/37/3f) is deliberately excluded** — Unicorn models the later-CPU algorithm; the 8088 differs and `conformance` covers it with real silicon (40000/40000). | 2086/2086 |
| **DOS/BIOS services** | `node tools/test-dos-api.js` | 243 cases against the INT 21h / 10h / 16h / 1Ah / 2Fh surface: file handles, find-first/next, memory (4Ah then 48h/49h), EXEC child block sizing, directories (39h/3Ah/3Bh/47h), the boot-sector INT 19h handoff, INT 13h over sector images (CHS decoding, geometry, error codes, and a two-sector boot image that loads its own second sector), DTA, the **CF-on-success convention**, and the XMS driver (move bounds/overlap/even length, realloc relocation, lock/free refusal, plus an end-to-end check that an AH=0Bh overlay swap invalidates the cached compiled block) - the layer `conformance`/`golden` cannot see | 243/243 |
| **x87 / SSE differential** | `node tools/test-x86-uc.mjs` | Unicorn as the oracle for the FPU and XMM. ⚠️ Until 2026-08-28 this suite had **zero** cases whose opcode was D8-DF: the 8088 vectors predate the FPU, the 80386 corpus ships no x87 files, and neither the hand-written nor the generated cases reach it — so the arithmetic every intro leans on had never been compared to anything, which is how FCOMI, FCMOVcc and FUCOMPP all sat there as silent no-ops. `x87-cases.mjs` (40) and `x86-sse-cases.mjs` (51) close that. Both work the same way: the harness compares 256 bytes of scratch and never reads FPU or XMM state, so every case ENDS by storing its result into that scratch. Two things to keep honest about it — Unicorn refuses SSE until CR0.EM is clear and CR4.OSFXSR is set, and a faulting capture is recorded as `error` and SKIPPED, so check the error count is 0 or the cases 'pass' without running; and MIRAGE models the x87 in float64 against silicon's 80-bit, so four transcendental cases carry a declared per-case ULP budget (`fp: {off, ulp}`) and are printed as tolerated on every run. The budget is narrow and local: biasing FSQRT by one ulp still fails `fsqrt 2`, which declares none. | **100%**, tolerances declared |
| **Conformance** | `node tools/conformance.js` | 555,764 SingleStepTests vectors (8088 silicon, run under the `8088` profile — no skips) — per-instruction reg/flag/memory exactness | **100%**, non-negotiable |
| **Golden** | `node tools/golden.js check` | deterministic output fingerprint of 22 workloads (framebuffer + planes + DAC + fault) | 22/22 |
| **Region fuzzer** | `node tools/fuzz-region.js 20000` | tier-2 region output == tier-1 (`stepOne`) on 20k random programs | `region == tier-1 on all` |
| **Flag fuzzer** | `node tools/fuzz-flags.js` | randomized flag-producing sequences vs a reference | clean |
| **Bench** | `node tools/bench.js` | p50 ms/frame for tube/memories/plasma13/xormunch/kaneda/lattice/puls | within ~±3% (A/B, this machine) |
| **DOSBox diff** | `node tools/dosdiff.js <prog.com>` | frame-matched pixel compare vs real DOSBox-X, mode 13h | visual signal (see below) |
| **DOS/BIOS sequence** | `node tools/dbx-oracle.mjs --sweep` | file / video / INT 21h event streams vs real DOSBox-X, whole corpus | 30/47 exact prefixes (2026-08-19) |

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

`tools/cosim/` — snapshots MIRAGE's exact CPU+memory state and single-steps it against **Unicorn
Engine** (QEMU's core, `pip3 install --user unicorn`) as a trusted x86 oracle, diffing
registers/memory each instruction. Same initial state ⇒ only genuine CPU-emulation bugs surface (no
need to match two DOSes). It found the `push dword` SP bug, the `popf` 386-flag-mask bug, and the
BIOS ROM identity gap behind Turbo Pascal's derail.

    GAME=TURBOPAS EXE=TURBO.EXE node tools/cosim/mirage-cosim.mjs   # snapshot a pure-CPU window
    python3 tools/cosim/uc-cosim.py                                 # replay it in Unicorn
    node tools/cosim/cosim-diff.mjs                                 # first divergence + culprit

Parameterised by `GAME`/`EXE`/`TAIL`/`MOUNT`/`SNAPBACK`, not edited per title — it used to be a
template you rewrote, which lost the previous wiring every time.

**The pure-CPU window is the whole contract.** Unicorn has no BIOS or DOS, so the snapshot must land
*between* services. The driver picks that point by watching entries into them — and that means
`biosCallback` as well as `swInt`, since BIOS services now run as inline far-calls to `f000:n`.
Missing them put a snapshot inside a BIOS call, and Unicorn then differed on AX at the IRET: a
divergence that is the harness's, not the engine's.

**Unicorn has blind spots too — read its verdicts, do not swallow them.** Measured on Turbo Pascal:

- it **clears AF after `SHR`** where we set it. The flag is architecturally *undefined* there, so
  neither is wrong; ignore AF-only differences on shifts.
- it does **not wrap a real-mode word read at the 1 MB boundary**, where we do — and we are right.
  A `LODSW` at `f000:ffff` reads one byte below 1 MB and one at linear 0.
- its real-mode single-step mishandles self-modified code (stale JIT cache); a Unicorn-side fault on
  an SMC'd byte is an artifact. Verify by comparing runtime opcode bytes.

**A derail reproduced by BOTH engines is not a CPU bug.** That was the Lemmings result in 2026-08-01
and the Turbo Pascal result here: the guest faithfully executes garbage that both engines produce
from the same RAM, so the corruption was set up earlier — by a service, a device, or missing data.

## What "verify a change" means here

1. Run the affected program (headless render or the browser) and *see* the pixels/behaviour —
   not just the tests.
2. Run the gates above relevant to what you touched (always test + conformance; add golden for
   anything touching emission/flags/timing; add fuzz-region for anything touching the run loop or
   region compiler; add bench for hot-path changes).
3. For device/timing changes, confirm tier-2 == notier2 and re-bless golden only after visual
   verification.
4. Browser sanity (reload, run a demo, check the console) for anything in the engine or `ui.js`.
