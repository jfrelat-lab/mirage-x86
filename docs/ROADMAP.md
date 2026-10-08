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
| K2 | `mirage prog.exe`: user-space DOS with a host directory as C: | M |
| K3, K5 | VGA text as ANSI; graphics through terminal image protocols | M |
| K4 | Recording to GIF or video | S |
| K6–K7, H12, H14 | User-space Linux and Win32 programs, their system calls answered in JavaScript | L |
| K8 | A native window with sound | M |

## The project

| Id | Item | Effort |
|---|---|---|
| P1 | A demonstration page (GitHub Pages) with freely redistributable examples | M |
| P2 | A CD and disk picker in `boot.html` | S |
| P3 | Tools that find `nasm`, `qemu` and `dosbox-x` on the PATH instead of in Homebrew's directory | S |
| P4 | Sort `tools/`: the gates and probes apart from the one-off investigations | M |
| H11 | One launcher for both machines: a profile plus content | M |
