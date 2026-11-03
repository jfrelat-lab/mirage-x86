# MIRAGE compared

MIRAGE beside the tools it is measured against every day: **QEMU** (whole-system emulation with
TCG, and `qemu-user` for Linux programs), **DOSBox-X** (DOS, with its own DOS and BIOS), **v86** (an
x86 PC in the browser, compiled to WebAssembly) — and **Docker**, which is not an emulator but is
what most people reach for to "run a program somewhere else". For speed, **PCjs** and the other x86
emulators of the browser — **js-dos**, **RetroTick** and **CheerpX** — are measured too ([Speed](#speed)).

| | |
|---|---|
| ✅ | yes |
| 🟡 | partly, or with a condition in the note |
| ❌ | no |
| ➖ | does not apply |
| ❔ | not checked by us; from the project's documentation |
| ⭐ | only MIRAGE, of the five |
| 🏆 | best of the five, where a measurement says so |

Rows about MIRAGE are measured in this repository (the tool or document is named). Rows about the
others are what we observed while using them as references (`tools/qemu-*.mjs`, `tools/dbx-*.mjs`,
`tools/diff-v86.mjs`, Docker's `i386/debian` image) or, marked ❔, what their documentation says.
Corrections are welcome.

## What only MIRAGE does

Each line is one capability, so that it can be checked on its own.

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| **DOS implemented in the emulator (HLE)**, in a browser: a `.COM`/`.EXE` starts the moment it is dropped, no DOS image | ❌ | ❌ | 🟡 natively; in a browser through js-dos | ❌ | ✅ `dos.html` (RetroTick does it too, in TypeScript) |
| **XMS (HIMEM) in HLE**: extended memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **EMS (EMM386/LIM 4.0) in HLE**: expanded memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **DPMI host in HLE**: DOS/4GW, CWSDPMI and DJGPP programs with no extender host to load | ❌ | ❌ | 🟡 through the extender's own host | ❌ | ✅ built-in host (C-Dogs, DOOM, Heretic, Kraptor; RetroTick has one too) |
| **BIOS in HLE**, interrupt services answered in JavaScript, checked against SeaBIOS, DOSBox-X and a vendor ROM | ❌ | ❌ (SeaBIOS ROM) | ✅ its own | ❌ (SeaBIOS ROM) | ✅ |
| **Linux programs without a Linux kernel, in a browser** | ❌ | ❌ (`qemu-user` is native only) | ❌ | ❌ | ✅ `linux.html`, `machines.html`, `tools/linux/run.mjs` (CheerpX does it too: WebVM, closed source, WebAssembly) |
| **Linux binaries of 1994–1996**: a.out, libc 4, SVGAlib — no current kernel loads them | ❌ (a.out removed in Linux 5.18) | ❌ | ➖ | 🟡 under an old booted kernel ❔ | ⭐ ✅ id's Linux DOOM (`linuxsdoom`), unmodified, SVGAlib driving the emulated VGA |
| **DOS, Linux user space and bare-metal boot in one engine**, the world chosen by the file's signature | ❌ | 🟡 two programs (system, user) | ❌ | ❌ | ⭐ ✅ `tools/run.mjs` |
| **Translated code as readable JavaScript** (`MIRAGE_KEEP_SRC=1`) | ➖ | ❌ | ❌ | ❌ (WebAssembly) | ⭐ ✅ |
| **No WebAssembly, no build step, no dependency** | ➖ | ➖ | ➖ | ❌ | ⭐ ✅ |
| **Runs reproducible to the cycle**: the guest clock follows retired instructions, randomness is seeded | ❌ | ❌ | 🟡 | ❌ | ⭐ ✅ |

## What each one is

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| What it is | containers sharing the host's Linux kernel | system and user-mode emulator | DOS emulator | PC emulator for the browser | PC emulator with built-in DOS, BIOS and Linux system calls |
| Language | Go | C | C++ | Rust → WebAssembly, JavaScript | JavaScript |
| Runs in a browser | ❌ | 🟡 experimental WebAssembly ports ❔ | 🟡 Emscripten ports (js-dos) ❔ | ✅ | ✅ |
| Runs natively / in Node | ✅ | ✅ | ✅ | ✅ (Node) | ✅ (Node) |
| How code is executed | natively (x86 host); through `qemu-user` or Rosetta on an ARM host | JIT to host code (TCG), or KVM/HVF | interpreter or dynamic recompiler | JIT to WebAssembly | x86 code becomes JavaScript source, block by block, compiled by the JavaScript engine |
| To install | Docker Desktop or Engine, a daemon, a VM on macOS and Windows | a package | a package | nothing (a web page) | nothing (a web page), or Node |
| Isolation | namespaces on the host's kernel | full emulation | full emulation | full emulation, browser sandbox | full emulation, browser sandbox; no system call reaches the host |
| Screen and sound | ❌ (headless) | ✅ | ✅ | ✅ | ✅ |
| Networking | ✅ | ✅ | ✅ | ✅ | ❌ |

## What it can run

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| Boot a PC from a floppy, hard-disk or CD image | ➖ | ✅ | ✅ | ✅ | ✅ `boot.html` |
| DOS programs | ❌ | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ |
| DOS extenders (DOS/4GW, CWSDPMI, DJGPP) | ❌ | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ |
| Linux programs, current (static and dynamic ELF) | ✅ | ✅ `qemu-user` | ❌ | ❌ | ✅ Debian 12 i386 binaries (ls, bash, perl, sort…) as Docker prints them |
| Win16 programs | ❌ | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows 3.0 |
| Win32 programs | 🟡 Windows containers, on a Windows host | 🟡 under a booted Windows | 🟡 under a booted Windows 9x | 🟡 under a booted Windows | 🟡 under a booted Windows 9x; ✅ without Windows for the scene's OpenGL and Direct3D 9 intros (MIRAGE-WIN32) |
| Windows 3.x | ❌ | ✅ | ✅ | ✅ | ✅ 3.0 to the Program Manager |
| Windows 95, 98, ME | ❌ | ✅ | ✅ | ✅ | ✅ the desktop |
| Windows NT, 2000, XP | ❌ | ✅ | 🟡 ❔ | ✅ ❔ | ❌ NT 3.51 stops after the graphical switch; 2000 stays on its boot screen |
| Linux kernels | ➖ | ✅ any | 🟡 old ones ❔ | ✅ | 🟡 2.2 and 2.4 to a shell |
| 64-bit | ✅ | ✅ | ❌ | ❌ | ❌ |

## Processor

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8086 to Pentium Pro instruction sets | ➖ (the host's CPU) | ✅ | ✅ (to Pentium Pro / II ❔) | ✅ | ✅ profiles `386`, `586`, `pentium`, `pentiummmx`, `686`, `pentiumpro`, `pentium3`, `pentium4` |
| Real mode, 16/32-bit protected mode, virtual-8086 | ➖ | ✅ | ✅ | ✅ | ✅ |
| Paging, write protection, 4 MiB pages, hardware task switching | ➖ | ✅ | ✅ | ✅ | ✅ |
| x87 FPU with 80-bit precision | ➖ | ✅ (softfloat) | 🟡 host-dependent ❔ | ✅ ❔ | 🟡 64-bit doubles: musl's `printf("%f")` rounds its last digit differently; gcc's `pr39228` fails |
| MMX | ➖ | ✅ | ✅ ❔ | ✅ ❔ | ✅ `pentiummmx` and up, against Docker i386 |
| SSE, SSE2 | ➖ | ✅ (and later) | 🟡 ❔ | ✅ ❔ | ✅ `pentium3` (SSE) and `pentium4` (SSE2), against Docker i386 |
| PAE, APIC, SMP | ➖ | ✅ | ❌ | 🟡 APIC ❔ | ❌ |

## Machine and devices

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8259, 8254, 8042, CMOS/RTC | ➖ | ✅ | ✅ | ✅ | ✅ checked against QEMU `-M isapc` and DOSBox-X |
| PCI | ➖ | ✅ | ✅ | ✅ | 🟡 option `pci` (i440FX, PIIX3) |
| ACPI | ➖ | ✅ | ❌ | 🟡 ❔ | ❌ |
| VGA: text, planar, mode 13h, Mode X | ➖ | ✅ | ✅ | ✅ | ✅ pixel-compared with QEMU and DOSBox-X |
| VBE 2.0 linear framebuffer | ➖ | ✅ | ✅ | ✅ | ✅ to 1024×768, 32 bpp |
| S3 / Cirrus / Voodoo accelerators | ➖ | ✅ Cirrus | ✅ S3, Voodoo ❔ | ❌ | 🟡 a Cirrus CL-GD5446 (option `vga: 'cirrus'`): its extended modes, banked window and hardware cursor, checked against its own BIOS under QEMU, enough for XFree86 3.3; no BitBLT engine, no PCI aperture yet |
| Sound Blaster 16, AdLib / OPL | ➖ | ✅ | ✅ | ✅ | ✅ |
| General MIDI (MPU-401, Windows' midiOut and MCI) | ➖ | ❌ | ✅ to the host's synthesizer, FluidSynth or an MT-32 emulation | ❌ | ✅ to a small synthesizer of its own (`src/midi.js`), no sound set shipped; the MIDI player checked against Wine's |
| Gravis Ultrasound, MT-32 | ➖ | 🟡 GUS | ✅ | ❌ | ❌ |
| IDE disks, ATAPI CD-ROM | ➖ | ✅ | ✅ | ✅ | ✅ |
| PS/2 mouse, keyboard | ➖ | ✅ | ✅ | ✅ | ✅ |
| Serial (16550) | ➖ | ✅ | ✅ | ✅ | 🟡 option |
| Network card | ➖ | ✅ | ✅ NE2000 | ✅ NE2000 over WebSocket | ❌ |
| USB | ➖ | ✅ | ❌ | ❌ | ❌ |

## Conformance

| Check | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| test386 (the 80386 self-test) | ➖ | ✅ reference | ❔ | ❔ | ✅ to POST FFh (`tools/run-test386.mjs`) |
| SingleStepTests, 8088 vectors | ➖ | ❔ | ❔ | ❔ | ✅ 423,736 vectors (`tools/conformance.js`) |
| Unicorn single-instruction comparison | ➖ | ➖ | ➖ | ➖ | ✅ all green (`tools/test-x86-uc.mjs`) |
| gcc 12.2's execute torture tests (1586 programs, static i386) | ✅ the oracle | ✅ (`qemu-user`, under Docker here) | ➖ | ➖ | ✅ 1585 of 1586 as the oracle (`tools/linux/torture.mjs`); `pr39228` needs the 80-bit x87 |
| Debian 12 i386 binaries, unmodified | ✅ the oracle | ✅ | ➖ | ➖ | ✅ same output on the commands tried |
| Pixel comparisons of DOS demos and games | ➖ | ➖ | ✅ the reference | ➖ | ✅ 44 golden runs (`tools/golden.js`) |

## Speed

Same host (Apple M1), the same binaries everywhere, built by gcc 12.2 at `-O2 -march=pentiumpro`;
higher is better unless said. Measured 2026-11-03 (DOSBox-X native: 2026-10-13), one after another,
never two at once. Besides the five above, this section measures the other x86 emulators that run in
a browser: **js-dos** 8.5.3 (DOSBox-X compiled to WebAssembly), **RetroTick** (DOS and Windows APIs in
TypeScript, an x86 interpreter with a WebAssembly JIT) and **CheerpX** 1.4.0 (Leaning Technologies'
Linux system calls and x86-to-WebAssembly JIT, the engine of WebVM). n.m. = not measured;
d.n.f. = did not finish.

**DOS**, DJGPP 12.2 binaries under CWSDPMI or the emulator's DPMI host. CoreMark runs 6000 iterations
(40000 on v86, so that it lasts the ten seconds CoreMark's rules ask), Dhrystone 10 million runs (50
million on v86), each validated by its own checks.

| | DOSBox-X (native, dynamic core) | js-dos (in Chrome) | v86 (Node, MS-DOS 6.22) | RetroTick (Node) | MIRAGE-DOS (in Chrome) | MIRAGE-DOS (headless) |
|---|---|---|---|---|---|---|
| Dhrystone 2.1, per second | 1,111,000 | 161,000 | 🏆 1,190,000 | d.n.f. | 208,000 | 315,000–322,000 |
| CoreMark, iterations per second | n.m. | 240 | 🏆 2,554 | d.n.f. | 304 | 401–404 |
| BYTE's Sieve, seconds (lower is better) | 🏆 6.2 | 8.1 | 7.1 | 39.5 | 11.1 | 7.5 |

**Linux**, static musl binaries (Dhrystone `-DTIMES -DHZ=100`, CoreMark with `ITERATIONS=0`, which
picks a count that lasts over ten seconds).

| | Docker (`qemu-user` on M1) | CheerpX (in Chrome) | MIRAGE-LINUX (headless) |
|---|---|---|---|
| Dhrystone 2.1, per second | 4,550,000–4,680,000 | 🏆 7,530,000 | 830,000–875,000 |
| CoreMark, iterations per second | 8,175–8,240 | 🏆 9,786 | 940–990 |
| Guest instructions per second | ➖ | ➖ | 420–450 M (Dhrystone), 305–325 M (CoreMark) |

**What this says.** On 32-bit code the WebAssembly JITs are far ahead: v86 runs DJGPP's CoreMark
6.4 times as fast as MIRAGE headless, CheerpX runs Linux Dhrystone 9 times as fast. On 16-bit real-mode
code (the Sieve) v86, DOSBox-X and MIRAGE are within a few tenths of a second of each other
headless. MIRAGE is ahead of js-dos on all three (js-dos is DOSBox-X's own core, compiled to
WebAssembly, so the dynamic recompiler native DOSBox-X uses is not there) and of RetroTick on the one
it finished. MIRAGE's own ground is not speed: the built-in DOS, Linux and Win32 with no system
image, readable generated code, and runs reproducible to the cycle.

How each was measured:

- **DOSBox-X**: the dynamic core, `cycles=max`, native build (the figures of 2026-10-13).
- **js-dos**: `Dos()` of js-dos 8.5.3 with the DOSBox-X backend (`cputype=ppro_slow`, `cycles=max`,
  `core=auto`) in headless Chrome; the Sieve timed by the prompt's `$T`. Its DOSBox backend has no
  Pentium Pro type (CoreMark stops on CMOV) and no `PROMPT`.
- **v86**: the npm package and its SeaBIOS, under Node, MS-DOS 6.22 (v86's own image) on drive C:,
  the binaries on a 1.44 MB floppy, each command typed; scores as the programs print them, the Sieve
  timed from the command to `DONE` on its screen.
- **RetroTick**: commit 41d35ce, its `Emulator` driven headless in Node as its own tests do. The
  Sieve ran (730.7 M instructions, as everywhere). DJGPP's Dhrystone and CoreMark ran 10.6 billion
  instructions in 900 s without finishing (CoreMark needs 2.1 billion): something in it loops under
  CWSDPMI. Its page was not tried.
- **CheerpX**: 1.4.0 from its CDN, WebVM's Debian disk as the root, in headless Chrome; Dhrystone's
  `times()` does not advance there, so 200 million runs were timed by `date` around them, inside the
  machine; CoreMark prints its own score.
- **MIRAGE-DOS**: in Chrome, the DOS player, scores as the programs print them; headless,
  `MIRAGE_DOSSTATS=1 node tools/dos/run.mjs`, the runs or iterations divided by the host seconds it
  prints (the DOS clock follows guest instructions there).
- **MIRAGE-LINUX**: `MIRAGE_LXWALLCLOCK=1 MIRAGE_LXSTATS=1 node tools/linux/run.mjs <binary>`, which
  prints the instructions run, the host time and the instructions a dispatch.

MIRAGE-LINUX runs paged, where blocks go on through branches, loops and calls
([RECOMPILER.md](RECOMPILER.md#longer-blocks-under-paging)); MIRAGE-DOS runs in a DPMI host without
paging, where they do not (some 5 instructions a dispatch). PCjs, at its highest speed setting, took
64.3 s for the Sieve (a COMPAQ DeskPro 386 at about 53 MHz); on PCjs, DJGPP's Dhrystone stopped with a
general protection fault inside CWSDPMI. PCjs hosts Windows 1.0-95, DOS and OS/2 images "for
archival/demonstration purposes only" (its licence excludes "all programs, images and documentation
produced by other parties"), as v86 hosts Windows 1.01 to 2000 marked "Proprietary"; MIRAGE serves
only what may be redistributed.

Booting whole systems, wall-clock seconds to the arrival screen (lower is better), from the
[README](../README.md#how-fast):

| | QEMU (TCG) | v86 | MIRAGE |
|---|---|---|---|
| Windows 98 | 🏆 26 | 40 | 36 |
| Windows 95 | 18 | 🏆 16 | 24 |
| QNX 4.05 demo | 4 | 6 | 🏆 2 |

The three are not timed alike. QEMU and v86 run in real time, so their times include every wait a
guest makes on its timers; MIRAGE is timed headless, where guest time follows its instructions and an
idle HLT costs nothing — which is all of its lead on QNX, a disk that mostly waits. In the page MIRAGE
runs in real time too. Windows 95's arrival is its first dialog, the others' their desktop or prompt.
`tools/v86/compare3.mjs`, the three measured one after another on 2026-11-03. Linux 2.2 is left out:
at MIRAGE's headless speed its console blanks itself (ten guest minutes) a few seconds after it boots,
and the screen it settles on is that blank one.

QEMU, DOSBox-X and Docker run native code; v86 runs WebAssembly; MIRAGE runs JavaScript, and its
time goes where a JavaScript engine puts it. On paged code a block now runs through forward branches,
short loops and followed calls, some 30 x86 instructions a dispatch on Dhrystone where it was five
(2026-10-12), and Dhrystone went from 156,500 to over 830,000 a second; real-mode and unpaged DOS code
still ends a block at every branch (ROADMAP D8).

## Where this is going

[ROADMAP](ROADMAP.md) **OASIS** turns MIRAGE into a container runner for the period PC: images (a
world — DOS, Linux user space, Win16, a bootable PC — a machine profile, an entry point, file layers
fetched on demand) run with `oasis run <image>` in a terminal, a native window or the browser, with
a commit that saves the whole machine so that a URL resumes a program where it was.

What MIRAGE does not do (yet): 64-bit, NT-family Windows, networking, USB, ACPI, an 80-bit x87,
and speed close to native-code emulators.
