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
| I9 | **A Cirrus Logic CL-GD5446** (`src/cirrus.js`, `vga: 'cirrus'` / `MIRAGE_VGA=cirrus`, OASIS `machine.vga`) — done: the extensions behind the VGA's ports (SR6 unlock, CR27 part ID, memory and bus registers as the card's BIOS leaves them), extended 8/15/16/24/32-bit modes from its CRTC, the banked A000 window (one or two banks, 4 or 16 KiB units), the hidden DAC, the hardware cursor and its colours — checked against the real CL-GD5436/46 BIOS 1.25 under QEMU (`tools/cirprobe.asm`). XFree86 3.3's `clgd5446` driver runs on it at 800x600. To do: the PCI device (1013:00B8) and its linear aperture, the BitBLT engine (XFree86's acceleration, Windows 95's and NT's Cirrus drivers), its own VGA BIOS's VBE modes setting its registers | M |
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
| N1 | **The network, in three deployments** — one `src/net.js`, the same guest side (MIRAGE-LINUX's sockets, H12e; an NE2000's Ethernet frames, I5) over an interchangeable transport: `direct` (Node: `run.mjs`, `oasis run --terminal`), `ws` (a WebSocket relay — modes 1 and 2 speak one protocol), `local` (the page alone). The page chooses by parameter (`?net=ws://…`, `?net=local`) and falls back to mode 3 when there is no server. Carries J7–J8, J10, J13 and O17 | — |
| N2 | **Mode 1, server + browser**: `oasis serve` relays — Node opens real TCP/UDP sockets (`net`, `dgram`) and resolves names (`dns.lookup`), forwards ports into the guest, and is a hub for a LAN between tabs and machines. Listening on localhost by default, with an allowlist of hosts and ports and a token when exposed (a relay is an open proxy). A WebSocket server with no dependency (handshake and framing). First user: AF_INET for MIRAGE-LINUX — wget, lynx, apt, Quake without `-noudp`, X clients over TCP | M |
| N3 | **Mode 3, browser only**: no raw sockets — a LAN between tabs of one browser over `BroadcastChannel` (DOOM in IPX, Quake in UDP, a Windows 95 network neighbourhood), the guest's HTTP turned into `fetch()` (CORS permitting), names by DNS-over-HTTPS; between machines WebRTC, with signalling by hand (a code to copy) or by a relay. Loopback always works | M |
| N4 | **Mode 2, external relay + browser**: a static page (GitHub Pages) and the URL of a relay — N2's relay taken out as `tools/relay.mjs`, deployable anywhere. Opt-in and said plainly: the traffic goes through a third party | S |
| N5 | **The NE2000 on v86's relays**: if I5's card speaks their protocol (raw Ethernet frames over WebSocket), the public relays v86 uses serve full systems (Windows 9x, Linux kernels) with no NAT of our own; else a user-mode NAT (QEMU's slirp) in Node | L |

## Outside the browser

| Id | Item | Effort |
|---|---|---|
| K1 | The serial console in a terminal, like `qemu -nographic` | S |
| K3, K5 | VGA text as ANSI; graphics through terminal image protocols | M |
| K4 | Recording to GIF or video | S |
| H12 | **User-space Linux (MIRAGE-LINUX)** — done: static, Debian dynamic (ELF, PIE, the interpreter) and a.out programs; processes (fork, exec, wait, pipes — one process at a time); the console (n_tty line discipline, the VGA text screen and its cursor, the keyboard in XLATE, MEDIUMRAW and RAW); ioperm and /dev; Debian 12's bash runs id's 1994 DOOM and comes back when it quits. Dhrystone 77–79 M instructions/s | — |
| H12a | ✅ **Processes run in turn**: a queue in src/linux.js, switching on a system-call boundary — when a call blocks (the process retries it on its next turn), after a 20 ms quantum, at nanosleep; an empty pipe blocks while a writer is open somewhere; wait4 waits for a living child; the first process ends the run, as PID 1 does a container. DOOM's sndserver now starts beside it (and stops at /dev/dsp: H12g). A switch keeps the translated code: the CR3 load starts a new epoch and each block is checked against its frames (D8) — DOOM with its sndserver runs within 10% of DOOM alone | — |
| H12b | Signals delivered to the handlers a program installs (sigaction, sigreturn, the frame on the user stack), SIGCHLD, SIGINT from ^C | M |
| H12c | The 80-bit x87: extended precision where a program asks for it, not float64 | M |
| H12d | Threads: clone with a shared address space, futex, thread-local storage (set_thread_area) — after H12a | L |
| H12e | **Sockets** — ✅ Unix stream sockets: socket, bind (a path or an abstract name), listen, connect, accept, socketpair, shutdown, get{sock,peer}name, SO_PEERCRED, send/recv/msg, through socketcall and the direct calls; poll and ppoll; a read waits while the peer is open. To do: AF_INET (TCP/UDP through N1's transport: Node directly, a WebSocket relay, or the page alone) for OASIS's network (O17) and Docker images (O13), file descriptors over sendmsg (SCM_RIGHTS) | L |
| H12f | A fuller /proc and /sys (self, cpuinfo, meminfo, mounts, the pid directories) for the tools that read them (ps, top, free) | M |
| H12g | ✅ **Sound: /dev/dsp (OSS)** — write mode (DOOM's sndserver, paced by the card's buffer) and mmap mode (Quake mixes into the card's buffer and asks GETOPTR, as PRISM's dsp.js taught: MMAP in GETCAPS, a power-of-two buffer, GETOSPACE as geometry); the samples go to src/audio.js beside the Sound Blaster, heard in the page; `MIRAGE_LXWAV` records them headless | — |
| H12h | **Mouse, display and X11** — ✅ the page's mouse on /dev/mouse (Microsoft serial, SVGAlib) and /dev/input/mice (PS/2); ✅ /dev/fb0 (busybox's fbset and fbsplash); ✅ **X11**: `linux/x11-1997` runs XFree86 3.3's SVGA server (Debian 1.3) on the emulated VGA, 320x200x256 through its ports, with twm and oclock over a Unix socket (H12e) — the X server of 1997 on no Linux kernel. ✅ **id's X DOOM, built in the tab, plays on it** (`linux/doom-x11`: gcc 2.7.2, XFree86 3.3, twm, MIT-SHM). ✅ **A larger screen**: the same 1997 server's `clgd5446` driver on an emulated Cirrus GD5446 (I9) — 800x600 at 256 colours, DOOM in a 640x400 window (`-2`). To do: `nanosleep` that waits (it only yields: a script's `sleep` lasts no time, and a shell loop with no system call starves the other processes) | M |
| H12i | x86-64 user space: the long-mode decoder and 64-bit registers, the x86-64 system call table — what most Docker images are | XL |
| H12j | ✅ **Quake for Linux** (id's svgalib `squake` 1.1, 1997): `linux/quake-1997` plays its demos — mprotect sets page rights (Quake patches its own code), libc5 and svgalib from Debian 1.3, `pak0.pak` from id's `quake106.zip` through an LHA layer (`src/lha.js`). Its sound plays through /dev/dsp in mmap mode (H12g); it runs with `-noudp` until AF_INET sockets (H12e) | — |
| H12k | ✅ **Build DOOM inside MIRAGE-LINUX** (`linux/doom-build`): Debian 1.3's gcc 2.7.2.1, binutils and make build id's 1997 sources — `sndserv` in 82 s host (DOOM 1994 then plays with it: 186 s of sound), and `linuxdoom-1.10`'s 62 files compiled and linked (`linuxxdoom`, X11: it runs with X11, H12h) — 18.5 min host at first, 372 s with the recompiler's translation memo across exec; `linux/doom-x11` builds it once in a `run` layer (O5) and starts with the game already there. The image supplies `errnos.h` and an empty `libnsl.a`, which libc5 no longer ships; id's sources are untouched | — |
| H12l | ✅ **A Linux without a distribution**: `linux/doom-mini` — static busybox 1.35 (an OASIS `busybox` layer links its 402 applets from its own `--list`), ld.so, libc4 and libvga, linuxsdoom and its WAD: about 4 MB; busybox's shell starts DOOM. Debian stays the fidelity reference | — |
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
| O5 | `commit`: done for the file tree — a `run` layer (a Dockerfile's `RUN`) keeps what a command made, cached under a hash of the layers below it (`linux/doom-x11` builds DOOM once). To do: the machine state (`tools/snapshot.mjs`), and URLs that resume or replay a run | L |
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
| O17 | **Network and `compose`**: an NE2000 and IPX/TCP over WebRTC or WebSocket — DOOM deathmatch between two tabs, a BBS or a MUD on `-p 23:2323`. The transport is N1–N5 | L |
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
