# MIRAGE — Roadmap

What is open, by theme, one line each. This is a menu, not a schedule. Identifiers are stable: the
code and the notes refer to them (`ROADMAP D8`). The history of every item — including the ones
that are finished and no longer listed here — is in
[notes/roadmap-log.md](notes/roadmap-log.md).

Effort: **S** a few hours, **M** a day or two, **L** more.

## Systems that should boot

| Id | Item | Effort |
|---|---|---|
| L1 | Windows 2000: find what it waits for after its delay calibration (compare with v86, which boots the same image) | M |
| L2 | ACPI: the tables and the PIIX4 power-management function — ReactOS, and probably Windows XP | L |
| L3 | A clock rate that goes with the CPU profile, so a Pentium is not given a 386's 3.3 MIPS | S |
| L4 | BeOS 5: why the display server does not start | M |
| L5 | Windows NT 3.51: the stop error after the graphical switch | M |
| L6 | Plan 9: an instruction pointer above FFFFh in a 16-bit segment | S |
| L7 | Try Haiku, Alpine Linux (i686), Damn Small Linux's desktop, a full FreeDOS install | S each |

## Hardware

| Id | Item | Effort |
|---|---|---|
| I5 | A network card: NE2000 with "no cable" first (ends the driver dialogs in Windows 9x, lets QNX go on) | M |
| I6 | Sound: an OPL core to WebAudio; then Sound Blaster PCM, which needs the 8237 | L |
| I7 | The 8237 DMA controller and the 82077 floppy controller; bus-master DMA that moves data | M |
| I2 | A `486` profile; MMX for a Pentium II | M |
| I8 | RTC alarm and update interrupts, a valid CMOS checksum; COM2-4; a parallel-port stub | S |
| B7 | (same as I6) | |

## Performance

| Id | Item | Effort |
|---|---|---|
| D6 | Compilation of cold blocks: about a fifth of a Windows 98 boot | M |
| D8 | Dispatch between blocks: the second tier needs an instruction budget before it can be switched back on | L |
| D9 | Byte-granular tracking of compiled code for the write barrier | M |
| D1–D5 | Lazy flags, inline caches for indirect calls, registers as locals, a worker thread, an intermediate representation | L each |

Rule for all of them: a change that speeds up the paged systems must not slow the DOS player
(see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## The DOS player

| Id | Item | Effort |
|---|---|---|
| A5 | Extended (E0) scancodes for the arrow and navigation keys | S |
| G8 | Heretic on its own extender, without our DPMI host | M |
| G7 | Quake, pixel for pixel against DOSBox-X | M |
| C4 | More demos and games as test candidates; re-run the titles marked *Unknown* in COMPATIBILITY.md | M |
| — | The FCB file calls of INT 21h; the two failing checks of `tools/test-dos-api.js` | S |

## Exchanges with the host

| Id | Item | Effort |
|---|---|---|
| J1–J2 | Drop files into C:, download what a program wrote | S |
| J3–J4 | Paste text as keystrokes, copy text off a text screen | S |
| J5, J9 | A floppy or CD image built from dropped files | M |
| J6 | Read and write the hard-disk image from the page | M |
| J7–J8, J10 | The network card with no cable, then a cable between two machines, then between distant players | L |
| J11–J13 | A shared clipboard, a shared folder, Internet access from the guest | L |

## Outside the browser

| Id | Item | Effort |
|---|---|---|
| K1 | The serial console in a terminal, like `qemu -nographic` | S |
| K3, K5 | VGA text as ANSI; graphics through terminal image protocols | M |
| K4 | Recording to GIF or video | S |
| H12 | User-space Linux: static, Debian dynamic and a.out programs; processes (fork, exec, wait, pipes — one process at a time) and the console (n_tty line discipline, the VGA text screen): Debian's bash runs id's 1994 DOOM. Next: two processes at once (DOOM's sndserver, interactive pipes), signals delivered to handlers, the 80-bit x87 | L |
| K7, H14 | User-space Win32 programs, their API answered in JavaScript | L |
| K8 | A native window with sound — for OASIS's `oasis run` (O4) | M |

## OASIS — images for every world of the period PC

A container format and runner on MIRAGE, the way Docker is one on Linux: an **image** is a manifest
(the world — DOS, Linux user space, Win16, a bootable PC — the machine profile, the entry point) and
file layers fetched on demand; `oasis run <image> [cmd]` runs it in a terminal, a native window or
the browser. What Docker does not: no daemon and nothing to install, the same x86 on every host
(phones included), a VGA screen and a Sound Blaster, period binaries (DOS, DPMI, a.out, Win16),
runs reproducible to the cycle, and a commit that saves the whole machine — CPU included — so a URL
resumes a program at the instant it was taken. The name: what a mirage promises, an oasis is.

| Id | Item | Effort |
|---|---|---|
| — | O1 and O2 are done: [OASIS.md](OASIS.md) (the manifest, the layers), `node tools/oasis.mjs list|inspect|pull|run` with a window in app mode or the terminal; `linux.html` | — |
| O3 | Layers read on demand over HTTP in the browser (byte ranges), cached offline; a registry is any static host | M |
| O4 | Output: done for a window in app mode (DOS, Linux) and the terminal; to do: ANSI in the terminal, mouse and sound for Linux, a WebView | M |
| O5 | `commit` of the machine state (`tools/snapshot.mjs`), and URLs that resume or replay a run | L |
| O6 | First images: `dos/c-dogs`, `dos/doom`, `linux/debian-bookworm`, `linux/doom-1994` exist; to do: `win/3.0`, more | M |
| O7 | **One format for MIRAGE and PRISM (manifest v2)**: an image says what world a program needs, not which engine runs it — the difference is where the program comes from. `binary`: the layers that hold the executable, run by MIRAGE; `source`: the sources and how to build them (`dir`, `make`, `defines`, `to`), compiled by [PRISM](https://github.com/jfrelat-lab/prism) to the same path. Shared: `world`, `machine`, the data layers, `entry`, `output`. An image may have either or both; with both, `oasis run --from binary\|source` chooses. The compiler follows from the world (`linux`: i386 System V and libc); `dos` names its original toolchain (`djgpp`, `borland`, `watcom`) since the ABI depends on it | M |
| O8 | **Twin images as a cross oracle**: one image, two origins — `linux/doom-1994` from id's binary of 1994 (MIRAGE) and from the 1997 source release (PRISM), same data, frames compared at equal points | M |
| O9 | **`hle`: libraries the environment supplies in JavaScript**, common to both engines — PRISM compiles against the headers and links its own; MIRAGE replaces the library's a.out jump table (`libvga.so.1`) with entries into the same JavaScript. First: svgalib, PRISM's `src/env/svgalib.js` moved into a module both projects share, with an adapter for MIRAGE's guest pointers. Optional per image: without it the binary keeps Debian's real svgalib, the better test of the emulated VGA. To check first: which svgalib calls linuxsdoom makes beyond Quake's nineteen, and the jump table's slot names | L |

## The project

| Id | Item | Effort |
|---|---|---|
| P1 | The home page exists (`index.html`, seven free boot-sector programs and five MIRAGE demos); to do: publish it on GitHub Pages, add GPL systems (FreeDOS, KolibriOS) with their sources | S |
| P2 | `boot.html`: a memory choice that matches what the examples ask for, drag-and-drop of an image | S |
| P3 | Tools that find `nasm`, `qemu` and `dosbox-x` on the PATH instead of in Homebrew's directory | S |
| P4 | Sort `tools/`: the gates and probes apart from the one-off investigations | M |
| H11 | One launcher for both machines: a profile plus content | M |
