# MIRAGE compared

MIRAGE beside the tools it is measured against every day — and, for speed, **PCjs**: **QEMU** (whole-system emulation with
TCG, and `qemu-user` for Linux programs), **DOSBox-X** (DOS, with its own DOS and BIOS), **v86** (an
x86 PC in the browser, compiled to WebAssembly) — and **Docker**, which is not an emulator but is
what most people reach for to "run a program somewhere else".

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
| **DOS implemented in the emulator (HLE)**, in a browser: a `.COM`/`.EXE` starts the moment it is dropped, no DOS image | ❌ | ❌ | 🟡 natively; in a browser through js-dos ❔ | ❌ | ⭐ ✅ `dos.html` |
| **XMS (HIMEM) in HLE**: extended memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **EMS (EMM386/LIM 4.0) in HLE**: expanded memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **DPMI host in HLE**: DOS/4GW, CWSDPMI and DJGPP programs with no extender host to load | ❌ | ❌ | 🟡 through the extender's own host | ❌ | ⭐ ✅ built-in host (C-Dogs, DOOM, Heretic, Kraptor) |
| **BIOS in HLE**, interrupt services answered in JavaScript, checked against SeaBIOS, DOSBox-X and a vendor ROM | ❌ | ❌ (SeaBIOS ROM) | ✅ its own | ❌ (SeaBIOS ROM) | ✅ |
| **Linux programs without a Linux kernel, in a browser** | ❌ | ❌ (`qemu-user` is native only) | ❌ | ❌ | ⭐ ✅ `tools/linux/run.mjs` (browser page to come) |
| **Linux binaries of 1994–1996**: a.out, libc 4, SVGAlib — no current kernel loads them | ❌ (a.out removed in Linux 5.18) | ❌ | ➖ | 🟡 under an old booted kernel ❔ | ⭐ ✅ id's Linux DOOM (`linuxsdoom`), unmodified, SVGAlib driving the emulated VGA |
| **Win16 programs without Windows** | ❌ | ❌ | ❌ | ❌ | ⭐ 🟡 branch `win16-hle`: NE loader, CLOCK.EXE starts with Microsoft's own USER.EXE and GDI.EXE run as guest code |
| **DOS, Linux user space, Win16 and bare-metal boot in one engine**, the world chosen by the file's signature | ❌ | 🟡 two programs (system, user) | ❌ | ❌ | ⭐ ✅ `tools/run.mjs` |
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
| How code is executed | natively (x86 host); through `qemu-user` or Rosetta on an ARM host | JIT to host code (TCG), or KVM/HVF | interpreter or dynamic recompiler | JIT to WebAssembly | x86 basic blocks become JavaScript source, compiled by the JavaScript engine |
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
| Win16 programs | ❌ | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows 3.0; without Windows on a branch (above) |
| Win32 programs | 🟡 Windows containers, on a Windows host | 🟡 under a booted Windows | 🟡 under a booted Windows 9x | 🟡 under a booted Windows | 🟡 under a booted Windows 9x; without Windows planned (ROADMAP H14) |
| Windows 3.x | ❌ | ✅ | ✅ | ✅ | ✅ 3.0 to the Program Manager |
| Windows 95, 98, ME | ❌ | ✅ | ✅ | ✅ | ✅ the desktop |
| Windows NT, 2000, XP | ❌ | ✅ | 🟡 ❔ | ✅ ❔ | ❌ NT 3.51 stops after the graphical switch; 2000 stays on its boot screen |
| Linux kernels | ➖ | ✅ any | 🟡 old ones ❔ | ✅ | 🟡 2.2 and 2.4 to a shell |
| 64-bit | ✅ | ✅ | ❌ | ❌ | ❌ |

## Processor

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8086 to Pentium Pro instruction sets | ➖ (the host's CPU) | ✅ | ✅ (to Pentium Pro / II ❔) | ✅ | ✅ profiles `386`, `586`, `pentium`, `686`, `pentiumpro` |
| Real mode, 16/32-bit protected mode, virtual-8086 | ➖ | ✅ | ✅ | ✅ | ✅ |
| Paging, write protection, 4 MiB pages, hardware task switching | ➖ | ✅ | ✅ | ✅ | ✅ |
| x87 FPU with 80-bit precision | ➖ | ✅ (softfloat) | 🟡 host-dependent ❔ | ✅ ❔ | 🟡 64-bit doubles: musl's `printf("%f")` rounds its last digit differently; gcc's `pr39228` fails |
| MMX | ➖ | ✅ | ✅ ❔ | ✅ ❔ | ❌ |
| SSE, SSE2 | ➖ | ✅ (and later) | 🟡 ❔ | ✅ ❔ | 🟡 implemented, not advertised by CPUID |
| PAE, APIC, SMP | ➖ | ✅ | ❌ | 🟡 APIC ❔ | ❌ |

## Machine and devices

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8259, 8254, 8042, CMOS/RTC | ➖ | ✅ | ✅ | ✅ | ✅ checked against QEMU `-M isapc` and DOSBox-X |
| PCI | ➖ | ✅ | ✅ | ✅ | 🟡 option `pci` (i440FX, PIIX3) |
| ACPI | ➖ | ✅ | ❌ | 🟡 ❔ | ❌ |
| VGA: text, planar, mode 13h, Mode X | ➖ | ✅ | ✅ | ✅ | ✅ pixel-compared with QEMU and DOSBox-X |
| VBE 2.0 linear framebuffer | ➖ | ✅ | ✅ | ✅ | ✅ to 1024×768, 32 bpp |
| S3 / Cirrus / Voodoo accelerators | ➖ | ✅ Cirrus | ✅ S3, Voodoo ❔ | ❌ | ❌ |
| Sound Blaster 16, AdLib / OPL | ➖ | ✅ | ✅ | ✅ | ✅ |
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

Same host (Apple M1), same source, gcc 12.2 at `-O2 -march=pentiumpro`. Higher is better. On this
ARM host Docker runs an i386 program through `qemu-user`, so its column is QEMU's user-mode
translator; on an x86 host Docker would run it natively. MIRAGE-DOS is timed by the host (its DOS
clock follows guest cycles); the others report their own score. n.m. = not measured yet.

| Benchmark | Docker (`qemu-user` on M1) | DOSBox-X (dynamic core, `cycles=max`) | v86 | MIRAGE-DOS (DJGPP) | MIRAGE-LINUX (musl) |
|---|---|---|---|---|---|
| Dhrystone 2.1, per second | 🏆 4,100,000 | 1,111,000 | n.m. | 169,000 | 156,500 |
| CoreMark, iterations per second | 🏆 7,763 | n.m. | n.m. | 210 | 242 |
| Guest instructions per second | ➖ | ➖ | ➖ | 82 M | 76–79 M |

BYTE's Sieve of Eratosthenes (8190 flags, 5000 times: `tools/bench/sieve.asm`, a 16-bit `.COM` of 126
bytes, 730.7 M instructions), wall-clock seconds on the same host, lower is better. It is run in
real mode so that every emulator executes the same instructions: on PCjs, DJGPP's Dhrystone stopped
with a general protection fault inside CWSDPMI.

| | DOSBox-X (dynamic, `cycles=max`) | MIRAGE-DOS | PCjs (COMPAQ DeskPro 386, at its highest speed) |
|---|---|---|---|
| Sieve, seconds | 🏆 6.2 | 13 | 64.3 |
| Relative to MIRAGE | 2.1x faster | 1 | 4.9x slower |

PCjs runs a machine at its original clock (16 MHz for the DeskPro 386); its debugger page's speed
button doubles the target, and the host reached about 53 MHz of 386 cycles, about 4 cycles an
instruction here. PCjs also hosts Windows 1.0-95, DOS and OS/2 images "for archival/demonstration
purposes only" (its licence excludes "all programs, images and documentation produced by other
parties"), as v86 hosts Windows 1.01 to 2000 marked "Proprietary"; MIRAGE serves only what may be
redistributed.

Booting whole systems, wall-clock seconds to the arrival screen (lower is better), from the
[README](../README.md#how-fast):

| | QEMU (TCG) | v86 | MIRAGE |
|---|---|---|---|
| Windows 98 | 🏆 28 | 44 | 50 |
| Windows 95 | 18 | 🏆 16 | 34 |
| QNX 4.05 demo | 4 | 6 | 🏆 2 |
| Linux 2.2 | 10 | — | 🏆 8 |

QEMU, DOSBox-X and Docker run native code; v86 runs WebAssembly; MIRAGE runs JavaScript, and its
time goes where a JavaScript engine puts it: a profile of Dhrystone spends 28–42% calling one block
of translated code after another (five x86 instructions a block on average). Closing that gap means
compiling traces of blocks together (ROADMAP D8).

## Where this is going

[ROADMAP](ROADMAP.md) **OASIS** turns MIRAGE into a container runner for the period PC: images (a
world — DOS, Linux user space, Win16, a bootable PC — a machine profile, an entry point, file layers
fetched on demand) run with `oasis run <image>` in a terminal, a native window or the browser, with
a commit that saves the whole machine so that a URL resumes a program where it was.

What MIRAGE does not do (yet): 64-bit, NT-family Windows, networking, USB, ACPI, MMX, an 80-bit x87,
and speed close to native-code emulators.
