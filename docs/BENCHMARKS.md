# MIRAGE — Benchmarks

How fast MIRAGE runs x86 code beside the other x86 emulators, on the same host and the same binaries.
What each one *can do* is in [COMPARISON.md](COMPARISON.md).

**At a glance.** On 32-bit code the WebAssembly JITs lead by a wide margin: v86 and CheerpX run the
same programs 6 to 9 times as fast as MIRAGE. On 16-bit real-mode code (the Sieve) MIRAGE headless is
within a fifth of native DOSBox-X and level with v86. MIRAGE is ahead of js-dos and RetroTick on
every benchmark they finished. Its JavaScript runs at 420–450 M x86 instructions a second on Linux
code, about 150 M on unpaged DOS code.

## The rules

- **Host**: one Apple M1, nothing else measured at the same time; each figure is the program's own
  score (or, where its clock cannot be trusted, wall-clock time around it).
- **Binaries**: the same files everywhere, built by gcc 12.2 at `-O2 -march=pentiumpro` — DJGPP 12.2
  for DOS (under CWSDPMI or the emulator's own DPMI host), musl, static, for Linux.
- **Where it ran** matters and is given on every line: *native* builds run machine code; *Chrome* is
  headless Chrome on the page as a visitor gets it; *Node* is the engine driven without a page;
  MIRAGE *headless* runs as fast as it can, its guest clock following its instructions.
- **Ranking**: within one benchmark and one guest system only. *Relative to the first* is the score
  over the best score (for a time, the best time over this one). A range is the spread of repeated
  runs; it is ranked by its best.
- **Dates**: 2026-11-03; DOSBox-X native 2026-10-13, PCjs 2026-10-12.

## DOS

### Dhrystone 2.1

| Rank | Emulator | Where it ran | Dhrystones a second | Relative to the first |
|---|---|---|---|---|
| 🥇 1 | v86 | Node, MS-DOS 6.22 | 1,190,000 | `████████████████████` 100 % |
| 🥈 2 | DOSBox-X | native, dynamic core | 1,111,000 | `███████████████████░` 93 % |
| 🥉 3 | **MIRAGE** | headless (Node) | 315,000–322,000 | `█████░░░░░░░░░░░░░░░` 27 % |
| 4 | **MIRAGE** | Chrome, the DOS player | 208,000 | `███░░░░░░░░░░░░░░░░░` 17 % |
| 5 | js-dos | Chrome | 161,000 | `███░░░░░░░░░░░░░░░░░` 14 % |
| — | RetroTick | Node | did not finish | |

### CoreMark 1.0

6000 iterations (40000 on v86, so that it runs the ten seconds CoreMark's rules ask); every run
validated by CoreMark's own checks.

| Rank | Emulator | Where it ran | Iterations a second | Relative to the first |
|---|---|---|---|---|
| 🥇 1 | v86 | Node, MS-DOS 6.22 | 2,554 | `████████████████████` 100 % |
| 🥈 2 | **MIRAGE** | headless (Node) | 401–404 | `███░░░░░░░░░░░░░░░░░` 16 % |
| 🥉 3 | **MIRAGE** | Chrome, the DOS player | 304 | `██░░░░░░░░░░░░░░░░░░` 12 % |
| 4 | js-dos | Chrome | 240 | `██░░░░░░░░░░░░░░░░░░` 9 % |
| — | DOSBox-X | native | not measured | |
| — | RetroTick | Node | did not finish | |

### BYTE's Sieve of Eratosthenes

8190 flags, 5000 times: `tools/bench/sieve.asm`, a 16-bit `.COM` of 126 bytes, 730.7 M instructions in
real mode — the same instructions on every emulator. Lower is better.

| Rank | Emulator | Where it ran | Time | Relative to the first |
|---|---|---|---|---|
| 🥇 1 | DOSBox-X | native, dynamic core | 6.2 s | `████████████████████` 100 % |
| 🥈 2 | v86 | Node, MS-DOS 6.22 | 7.1 s | `█████████████████░░░` 87 % |
| 🥉 3 | **MIRAGE** | headless (Node) | 7.5 s | `█████████████████░░░` 83 % |
| 4 | js-dos | Chrome | 8.1 s | `███████████████░░░░░` 77 % |
| 5 | **MIRAGE** | Chrome, the DOS player | 11.1 s | `███████████░░░░░░░░░` 56 % |
| 6 | RetroTick | Node | 39.5 s | `███░░░░░░░░░░░░░░░░░` 16 % |
| 7 | PCjs | Chrome, DeskPro 386 at its top speed | 64.3 s | `██░░░░░░░░░░░░░░░░░░` 10 % |

## Linux

Static musl binaries: Dhrystone with `-DTIMES -DHZ=100`, CoreMark with `ITERATIONS=0` (it picks a
count that runs over ten seconds).

### Dhrystone 2.1

| Rank | Emulator | Where it ran | Dhrystones a second | Relative to the first |
|---|---|---|---|---|
| 🥇 1 | CheerpX | Chrome | 7,530,000 | `████████████████████` 100 % |
| 🥈 2 | Docker (`qemu-user`) | native | 4,550,000–4,680,000 | `████████████░░░░░░░░` 62 % |
| 🥉 3 | **MIRAGE** | headless (Node) | 830,000–875,000 | `██░░░░░░░░░░░░░░░░░░` 12 % |

### CoreMark 1.0

| Rank | Emulator | Where it ran | Iterations a second | Relative to the first |
|---|---|---|---|---|
| 🥇 1 | CheerpX | Chrome | 9,786 | `████████████████████` 100 % |
| 🥈 2 | Docker (`qemu-user`) | native | 8,175–8,240 | `█████████████████░░░` 84 % |
| 🥉 3 | **MIRAGE** | headless (Node) | 940–990 | `██░░░░░░░░░░░░░░░░░░` 10 % |

## Booting whole systems

Wall-clock seconds to the arrival screen, `tools/v86/compare3.mjs`, the three measured one after
another on 2026-11-03. **Not ranked**: QEMU and v86 run in real time, so their times include every
wait a guest makes on its timers, while MIRAGE is timed headless, where an idle HLT costs nothing —
which is all of its lead on QNX, a disk that mostly waits.

| | QEMU (TCG, native) | v86 (Node) | MIRAGE (headless) |
|---|---|---|---|
| Windows 98, its desktop | 26 | 40 | 36 |
| Windows 95, its first dialog | 18 | 16 | 24 |
| QNX 4.05 demo disk, its prompt | 4 | 6 | 2 |

Linux 2.2 is left out: at MIRAGE's headless speed its console blanks itself (ten guest minutes) a
few seconds after it boots, and the screen it settles on is that blank one.

## How each was measured

- **DOSBox-X**: the dynamic core, `cycles=max`, native build.
- **js-dos** 8.5.3: `Dos()` with the DOSBox-X backend (`cputype=ppro_slow`, `cycles=max`,
  `core=auto`); the Sieve timed by the prompt's `$T`. Its DOSBox backend has no Pentium Pro type
  (CoreMark stops on CMOV) and no `PROMPT`. It is DOSBox-X's portable core compiled to WebAssembly,
  without the dynamic recompiler the native build uses.
- **v86**: the npm package and its SeaBIOS, MS-DOS 6.22 (v86's own image) on C:, the binaries on a
  1.44 MB floppy, each command typed; Dhrystone's run count given as an argument (keys typed into a
  DJGPP program under CWSDPMI did not arrive).
- **RetroTick** (commit 41d35ce): its `Emulator` driven in Node as its own tests do. The Sieve ran;
  DJGPP's Dhrystone and CoreMark ran 10.6 billion instructions in 900 s without finishing (CoreMark
  needs 2.1 billion). Its page was not tried, and the loop was not investigated: it may be a harness
  limit as much as RetroTick's.
- **CheerpX** 1.4.0: from its CDN, WebVM's Debian disk as the root. Dhrystone's `times()` does not
  advance there, so 200 million runs were timed by `date` inside the machine; CoreMark prints its own
  score.
- **Docker**: `docker run --platform linux/386 i386/debian`, which on an ARM host is QEMU's user-mode
  translator; on an x86 host it would be native.
- **PCjs**: a COMPAQ DeskPro 386 at its highest speed setting (about 53 MHz of 386 cycles); DJGPP's
  Dhrystone stopped with a general protection fault inside CWSDPMI.
- **MIRAGE**: in Chrome, the DOS player, scores as printed; headless,
  `MIRAGE_DOSSTATS=1 node tools/dos/run.mjs` and
  `MIRAGE_LXWALLCLOCK=1 MIRAGE_LXSTATS=1 node tools/linux/run.mjs`, which print the instructions run and
  the host time (the DOS score is the runs divided by those host seconds: headless, the DOS clock
  follows guest instructions).

## Why MIRAGE is where it is

MIRAGE runs JavaScript, and its time goes where a JavaScript engine puts it. Under paging a block
runs on through forward branches, short loops and followed calls — some 30 x86 instructions a
dispatch on Dhrystone ([RECOMPILER.md](RECOMPILER.md#longer-blocks-under-paging)); real-mode and
unpaged DOS code still ends a block at every branch, about 5 instructions a dispatch (ROADMAP D8),
which is most of the gap between its Linux and DOS figures. The WebAssembly JITs compile to a
lower-level target and do not pay for a JavaScript function call between blocks.
