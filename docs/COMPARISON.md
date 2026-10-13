# MIRAGE compared

How MIRAGE stands against the three emulators it is measured against every day: **QEMU** (system
emulation with TCG, and `qemu-user` for Linux programs), **DOSBox-X** (DOS, with its own DOS and
BIOS) and **v86** (an x86 PC in the browser, compiled to WebAssembly).

| | |
|---|---|
| ✅ | yes |
| 🟡 | partly, or with a condition in the note |
| ❌ | no |
| ➖ | does not apply |
| ❔ | not checked by us; from the project's documentation |
| 🏆 | best of the four, where a measurement says so |

Rows about MIRAGE are measured in this repository (the tool or document is named). Rows about the
other three are what we observed while using them as references (`tools/qemu-*.mjs`,
`tools/dbx-*.mjs`, `tools/diff-v86.mjs`, Docker's `i386/debian` for `qemu-user`) or, marked ❔,
what their documentation says. Corrections are welcome.

## What each one is

| | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|
| Language | C | C++ | Rust → WebAssembly, JavaScript | JavaScript only — no WebAssembly, no build step |
| Runs in a browser | 🟡 experimental WebAssembly ports ❔ | 🟡 through Emscripten ports (js-dos) ❔ | ✅ | ✅ |
| Runs natively / in Node | ✅ | ✅ | ✅ (Node) | ✅ (Node) |
| How code is executed | JIT to host code (TCG) or hardware virtualisation (KVM, HVF) | interpreter, or a dynamic recompiler | JIT to WebAssembly | dynamic recompiler: x86 basic blocks become JavaScript source, compiled by the JavaScript engine |
| Generated code is readable | ❌ | ❌ | 🟡 WebAssembly | ✅ JavaScript |
| Install | package | package | none (web page) | none (web page) |

## What it can run

| Mode | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|
| Boot a PC from a floppy, hard disk or CD image | ✅ | ✅ (`boot`, `imgmount`) | ✅ | ✅ `boot.html` |
| DOS programs **without** a DOS image (DOS in the emulator) | ❌ | ✅ | ❌ | ✅ `dos.html`, `tools/dos/run.mjs` |
| DOS extenders: DPMI, DOS/4GW, CWSDPMI, DJGPP | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ built-in DPMI host |
| XMS, EMS | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ built in |
| Linux programs without a Linux kernel (user space) | ✅ `qemu-user` | ❌ | ❌ | ✅ `tools/linux/run.mjs`: static ELF, Debian's dynamic ELF, a.out with libc 4 |
| Linux programs from 1994 (a.out, libc 4, SVGAlib) | ❌ (a.out not supported) | ➖ | ❌ in user space; ✅ under an old booted kernel ❔ | ✅ id's Linux DOOM (`linuxsdoom`), unmodified |
| Win16 programs without Windows | ❌ | ❌ | ❌ | 🟡 probes only (`tools/win16-probe.mjs`) |
| Win32 programs without Windows | ❌ | ❌ | ❌ | ❌ planned (ROADMAP H14) |
| Windows 3.x | ✅ | ✅ | ✅ | ✅ 3.0 to the Program Manager |
| Windows 95, 98, ME | ✅ | ✅ | ✅ | ✅ the desktop |
| Windows NT, 2000, XP | ✅ | 🟡 ❔ | ✅ ❔ | ❌ NT 3.51 stops after the graphical switch; 2000 stays on its boot screen |
| Linux kernels | ✅ any | 🟡 old ones ❔ | ✅ | 🟡 2.2 and 2.4 to a shell; not 2.6+ distributions |
| 64-bit guests | ✅ | ❌ | ❌ | ❌ |

## Processor

| | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|
| 8086 to Pentium Pro instruction sets | ✅ | ✅ (to Pentium Pro / II ❔) | ✅ | ✅ profiles `386`, `586`, `pentium`, `686`, `pentiumpro` |
| Real mode, 16/32-bit protected mode, virtual-8086 | ✅ | ✅ | ✅ | ✅ |
| Paging, write protection, 4 MiB pages | ✅ | ✅ | ✅ | ✅ |
| Hardware task switching | ✅ | ✅ | ✅ | ✅ |
| x87 FPU with 80-bit precision | ✅ (softfloat) | 🟡 host-dependent ❔ | ✅ ❔ | 🟡 computes in 64-bit doubles: musl's `printf("%f")` rounds its last digit differently; gcc's `pr39228` fails |
| MMX | ✅ | ✅ ❔ | ✅ ❔ | ❌ |
| SSE, SSE2 | ✅ (and later) | 🟡 ❔ | ✅ ❔ | 🟡 implemented, not advertised by CPUID |
| PAE, APIC, SMP | ✅ | ❌ | 🟡 APIC ❔ | ❌ |
| Cycle-exact reproducible runs | ❌ | 🟡 | ❌ | ✅ the clock follows retired instructions; same inputs, same run |

## Machine and devices

| | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|
| 8259, 8254, 8042, CMOS/RTC | ✅ | ✅ | ✅ | ✅ checked against QEMU `-M isapc` and DOSBox-X |
| PCI | ✅ | ✅ | ✅ | 🟡 option `pci` (i440FX, PIIX3) |
| ACPI | ✅ | ❌ | 🟡 ❔ | ❌ |
| VGA: text, planar, mode 13h, Mode X | ✅ | ✅ | ✅ | ✅ pixel-compared with QEMU and DOSBox-X |
| VBE 2.0 linear framebuffer | ✅ | ✅ | ✅ | ✅ to 1024×768, 32 bpp |
| S3 / Cirrus / Voodoo accelerators | ✅ Cirrus | ✅ S3, Voodoo ❔ | ❌ | ❌ |
| Sound Blaster 16, AdLib / OPL | ✅ | ✅ | ✅ | ✅ |
| Gravis Ultrasound, MT-32 | 🟡 GUS | ✅ | ❌ | ❌ |
| IDE disks, ATAPI CD-ROM | ✅ | ✅ | ✅ | ✅ |
| Floppy controller | ✅ | ✅ | ✅ | 🟡 through the BIOS |
| PS/2 mouse, keyboard | ✅ | ✅ | ✅ | ✅ |
| Serial (16550) | ✅ | ✅ | ✅ | 🟡 option |
| Network | ✅ | ✅ NE2000 | ✅ NE2000 over WebSocket | ❌ |
| USB | ✅ | ❌ | ❌ | ❌ |

## Conformance

| Check | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|
| test386 (the 80386 self-test) | ✅ reference | ❔ | ❔ | ✅ to POST FFh (`tools/run-test386.mjs`) |
| SingleStepTests, 8088 vectors | ❔ | ❔ | ❔ | ✅ 423,736 vectors (`tools/conformance.js`) |
| Unicorn single-instruction comparison | ➖ | ➖ | ➖ | ✅ all green (`tools/test-x86-uc.mjs`) |
| gcc 12.2's execute torture tests (1586 programs, static i386) | ✅ the oracle (`qemu-user`) | ➖ | ➖ | ✅ 1585 of 1586 as the oracle (`tools/linux/torture.mjs`); `pr39228` needs the 80-bit x87 |
| Debian 12 i386 binaries, unmodified (ls, bash, perl, sort...) | ✅ the oracle | ➖ | ➖ | ✅ same output on the commands tried |
| Pixel comparisons of DOS demos | ➖ | ✅ the reference | ➖ | ✅ 44 golden runs (`tools/golden.js`) |

## Speed

Same host (Apple M1), same source, gcc 12.2 at `-O2 -march=pentiumpro`. Higher is better.
MIRAGE-DOS is timed by the host (its DOS clock follows guest cycles); the others report their own
score. n.m. = not measured yet.

| Benchmark | QEMU (`qemu-user`, Docker) | DOSBox-X (dynamic core, `cycles=max`) | v86 | MIRAGE-DOS (DJGPP) | MIRAGE-LINUX (musl) |
|---|---|---|---|---|---|
| Dhrystone 2.1, per second | 🏆 4,100,000 | 1,111,000 | n.m. | 169,000 | 156,500 |
| CoreMark, iterations per second | 🏆 7,763 | n.m. | n.m. | 210 | 242 |
| Guest instructions per second | ➖ | ➖ | ➖ | 82 M | 76–79 M |

Booting whole systems, wall-clock seconds to the arrival screen (lower is better), from the
[README](../README.md#how-fast):

| | QEMU (TCG) | v86 | MIRAGE |
|---|---|---|---|
| Windows 98 | 🏆 28 | 44 | 50 |
| Windows 95 | 18 | 🏆 16 | 34 |
| QNX 4.05 demo | 4 | 6 | 🏆 2 |
| Linux 2.2 | 10 | — | 🏆 8 |

QEMU and DOSBox-X translate to native code; v86 to WebAssembly; MIRAGE to JavaScript, and its time
goes where a JavaScript engine puts it: a profile of Dhrystone spends 28–42% in calling one block of
translated code after another (five x86 instructions a block, on average). Closing that gap means
compiling traces of blocks together (ROADMAP).

## Where MIRAGE is different

- **Nothing to install, nothing to boot.** A DOS program starts the moment it is dropped on the page;
  a Linux program runs from the command line or the browser with no kernel image.
- **One engine, every world of the period PC.** DOS, DOS extenders, Windows 3.x/9x, bare-metal
  operating systems and Linux user space, chosen by the file's signature (`tools/run.mjs`).
- **Old Linux binaries nothing else runs.** a.out programs linked against libc 4 and SVGAlib — the
  Linux of 1994–1996 — with SVGAlib driving the emulated VGA through its own ports.
- **Reproducible to the cycle.** The guest clock follows retired instructions and randomness is
  seeded: a run, a bug, a frame are the same every time.
- **Readable translation.** Every block of x86 becomes a JavaScript function that can be printed and
  read (`MIRAGE_KEEP_SRC=1`).
- **Checked against references.** Behaviour changes only where independent implementations agree
  (QEMU, DOSBox-X, the Cirrus VGA ROM, real kernels); each check is a probe in `tools/` that runs
  unchanged on both sides.

What MIRAGE does not do (yet): 64-bit, NT-family Windows, networking, USB, ACPI, MMX, an 80-bit x87,
and raw speed close to native-code emulators.
