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
| L3 | Optional: a cycle rate per CPU profile in turbo and headless runs, where a guest second is 3.32 M instructions whatever the profile. Not a fidelity gap: in real time MIRAGE runs as fast as the host, as QEMU and v86 do, and DOSBox-X's fixed cycles and QEMU's `-icount` do not follow the CPU model either. It would move every headless measurement, goldens included | S |
| L4 | BeOS 5: why the display server does not start | M |
| L5 | Windows NT 3.51: the stop error after the graphical switch | M |
| L6 | Plan 9: an instruction pointer above FFFFh in a 16-bit segment | S |
| L7 | Try Haiku, Alpine Linux (i686), Damn Small Linux's desktop, a full FreeDOS install | S each |

## Hardware

| Id | Item | Effort |
|---|---|---|
| I5 | A network card: NE2000 with "no cable" first (ends the driver dialogs in Windows 9x, lets QNX go on) | M |
| I6 | Sound — done: OPL3 FM (checked against Nuked-OPL3), Sound Blaster 16 PCM playback to WebAudio, the IRQ and DMA channels its mixer selects, the ASP commands Windows 95's driver probes. To do: ADPCM and recording, the Gravis Ultrasound | M |
| I7 | DMA — done: the 8237 pair (current address and count, terminal count, auto-init) feeding the Sound Blaster. To do: the 82077 floppy controller, bus-master IDE DMA that moves data | M |
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
| H12 | **User-space Linux (MIRAGE-LINUX)** — done: static, Debian dynamic (ELF, PIE, the interpreter) and a.out programs; processes (fork, exec, wait, pipes — one process at a time); the console (n_tty line discipline, the VGA text screen and its cursor, the keyboard in XLATE, MEDIUMRAW and RAW); ioperm and /dev; Debian 12's bash runs id's 1994 DOOM and comes back when it quits. Dhrystone 77–79 M instructions/s | — |
| H12a | Two processes at once: a scheduler over the snapshots fork already takes — DOOM's sndserver beside it, interactive pipes (`ls \| less`) | L |
| H12b | Signals delivered to the handlers a program installs (sigaction, sigreturn, the frame on the user stack), SIGCHLD, SIGINT from ^C | M |
| H12c | The 80-bit x87: extended precision where a program asks for it, not float64 | M |
| H12d | Threads: clone with a shared address space, futex, thread-local storage (set_thread_area) — after H12a | L |
| H12e | Sockets: Unix-domain first (X11, sndserver), then TCP/UDP over a host proxy (WebSocket), for OASIS's network (O17) and Docker images (O13) | L |
| H12f | A fuller /proc and /sys (self, cpuinfo, meminfo, mounts, the pid directories) for the tools that read them (ps, top, free) | M |
| H12g | Sound for Linux programs: /dev/dsp (OSS) on src/audio.js — DOOM's sndserver writes there | M |
| H12h | The mouse through /dev/input and gpm, and X11 programs through PRISM's X11 layer or a real X server (with H12e) | L |
| H12i | x86-64 user space: the long-mode decoder and 64-bit registers, the x86-64 system call table — what most Docker images are | XL |
| H12j | **Quake for Linux** (id's svgalib `squake`, 1996–97), the next showcase after DOOM: the same console and svgalib path, heavy x87 and software 3D, larger binaries; the shareware `pak0.pak` | M |
| H12k | **Build DOOM inside MIRAGE-LINUX**: the 1997 source release, `make` in Debian's bash (make, gcc, cc1, as, ld one after another), then play the binary it made — a toolchain of the period in a tab, and O8's twin without PRISM | M |
| H12l | **A Linux without a distribution**: an image of a few MB — static busybox i386 (shell, coreutils, vi), the program and its data, and only the libraries it needs (linuxsdoom: ld.so, libc4, libvga) — that starts in seconds and suits a static host (O3). Debian stays the fidelity reference | S |
| H12m | **Libraries in JavaScript beyond svgalib** (with O9): the part of libc4 an old binary uses (DOOM: some sixty functions), so a program runs with no library of its time — optional, less faithful than the real code | L |
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
| O10 | **Instant start from a snapshot** (with O5): an image may carry the machine already booted — Windows 98's desktop or a bash prompt in milliseconds instead of a minute | M |
| O11 | **Record and replay, and stepping back in time**: MIRAGE is deterministic to the cycle, so `oasis run --record` keeps the inputs and `oasis replay` runs the same execution again; snapshots plus replay give reverse debugging, as `rr` does | L |
| O12 | **An image is a URL, and an element to embed**: `<oasis-run image="linux/doom-1994">` in a blog, a manual or a museum's page, on phones and offline (PWA) | M |
| O13 | **Docker i386 images in the browser**: `oasis import docker://i386/debian` (the `docker` layer exists) — a Linux container without Docker, on an ARM Mac or a phone. Limits: i386 only (most of Docker Hub is amd64), one process at a time, no sockets yet | M |
| O14 | **A sandbox with no shared kernel**: old or suspect binaries (DOS viruses, unknown i386 ELF) run with nothing of the host reachable | S |
| O15 | **`Oasisfile`**, the Dockerfile of OASIS: its `RUN` steps execute inside the emulated world (`make` under DJGPP, Turbo C or Watcom in MIRAGE), so images are built with the tools of their time | L |
| O16 | **Volumes**: `-v .:/work` mounts a host directory as C: or a Linux directory (the host file provider exists) | S |
| O17 | **Network and `compose`**: an NE2000 and IPX/TCP over WebRTC or WebSocket — DOOM deathmatch between two tabs, a BBS or a MUD on `-p 23:2323` | L |
| O18 | **`oasis diff` and tracing**: the files a run changed, and its system calls (`strace`) or DOS calls (INT 21h) as the tool's own output | M |
| O19 | **`oasis.lock`**: each layer's SHA-256 pinned, with fallback mirrors (Software Heritage, the Wayback Machine), so an image still runs when its archive is gone | S |
| O20 | **`oasis test` for CI**: run headless and compare the output or the screen with a reference — continuous integration for period software (16-bit code, Turbo Pascal), as a GitHub Action | M |
| O21 | **A period speed, guaranteed**: `--cpu 386@33MHz`, held in cycles, for programs that time themselves on the CPU | S |

## The project

| Id | Item | Effort |
|---|---|---|
| P1 | The home page exists (`index.html`, seven free boot-sector programs and five MIRAGE demos); to do: publish it on GitHub Pages, add GPL systems (FreeDOS, KolibriOS) with their sources | S |
| P2 | `boot.html`: a memory choice that matches what the examples ask for, drag-and-drop of an image | S |
| P3 | Tools that find `nasm`, `qemu` and `dosbox-x` on the PATH instead of in Homebrew's directory | S |
| P4 | Sort `tools/`: the gates and probes apart from the one-off investigations | M |
| H11 | One launcher for both machines: a profile plus content | M |
