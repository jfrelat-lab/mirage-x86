# MIRAGE

[![tests](https://github.com/jfrelat-lab/mirage-x86/actions/workflows/test.yml/badge.svg)](https://github.com/jfrelat-lab/mirage-x86/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Run it in your browser](https://img.shields.io/badge/%E2%96%B6%20run%20it-in%20your%20browser-00d0a0)](https://mirage-x86.pages.dev)

**An x86 PC in plain JavaScript: a dynamic recompiler that turns x86 machine code into JavaScript
source, with a built-in DOS so a `.COM` or `.EXE` runs the moment you drop it on the page.**

No WebAssembly, no build step, no dependencies beyond its sibling [PRISM](https://github.com/jfrelat-lab/prism)
(a submodule, for OpenGL and Direct3D 9). It runs in a browser and in Node.

**Try it: [mirage-x86.pages.dev](https://mirage-x86.pages.dev)** — boot-sector games, size-coded
intros, DOS games and demos, a FreeDOS disk, Linux and Windows intros, each a click away.

```
 x86 machine code ─▶ decoder ─▶ JS source ─▶ new Function ─▶ the engine's own JIT ─▶ run
                     (block by block, cached by linear address, aware of self-modifying code)
```

MIRAGE is four machines sharing one CPU:

- **A DOS player** (`dos.html`). DOS, the BIOS, XMS, EMS and a DPMI host are implemented in
  JavaScript, so there is no DOS image to boot: a program starts at once.
- **A bare PC** (`boot.html`). A BIOS, an 8259/8254/RTC chipset, VGA and VBE, IDE disks, an ATAPI
  CD-ROM, and optionally a PCI bus and a 16550 serial port: enough to boot unmodified operating
  systems from a disk image or an El Torito CD.
- **MIRAGE-LINUX** (`linux.html`, `machines.html`). i386 Linux programs with no Linux: the kernel's
  system calls in JavaScript, Debian's own binaries and libraries, from bash to X and Quake.
- **MIRAGE-WIN32** (`machines.html?m=win32`). Windows programs with no Windows: the `.exe` mapped as
  Windows XP maps it, every DLL it imports written in JavaScript, OpenGL and Direct3D 9 drawn by
  [PRISM](https://github.com/jfrelat-lab/prism)'s WebGL2 renderer.

## What runs today

Per-title status, with dates, is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Apart from the
redistributable examples, none of that software is in this repository — see
[Third-party software](#third-party-software).

| | Reaches |
|---|---|
| DOS intros and demos | 31 of the 32 tried render; 37 intros are pinned by the golden test |
| DOS games | real mode, DOS extenders (DPMI), EMS/XMS — per-title status in docs/COMPATIBILITY.md |
| Windows 3.0, 95, 98, ME | the desktop |
| Linux 2.2 (BasicLinux), Linux 2.4 (Damn Small Linux, booted from its CD) | a shell; runlevel 5 |
| FreeDOS 1.3 (from its CD), MS-DOS 6.22 | the installer; the prompt |
| QNX 4.05 demo disk, KolibriOS, OpenBSD | the desktop; the desktop; `login:` |
| Linux programs (MIRAGE-LINUX) | Debian 12's bash, XFree86 3.3 and its clients, DOOM and Quake for Linux, Mesa's demos, the scene's Linux intros — the images in [docs/OASIS.md](docs/OASIS.md) |
| Windows intros (MIRAGE-WIN32) | seven OpenGL intros of 2007-2017 and five Direct3D 9 intros of 2008-2010, Elevated and Ergon among them — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) |

**What does not work yet**, so nobody has to find out the hard way: Windows NT 3.51 (dies after the
graphical switch), Windows 2000 (stays on its boot screen), ReactOS (needs ACPI, which MIRAGE does
not have), BeOS 5 (stays on its splash screen), Plan 9. There is no Gravis Ultrasound, no network card,
no USB, no 64-bit mode. The CPU profiles go up to a Pentium 4 (MMX, SSE, SSE2).
MIRAGE-WIN32 has OpenGL and Direct3D 9 but not yet DirectDraw, DirectSound, DirectInput or Win16.

## How fast

Wall-clock seconds to the arrival screen, same image, same host (Apple M1; lower is better):

| | QEMU (TCG) | v86 | MIRAGE |
|---|---|---|---|
| Windows 98 | 26 | 40 | 36 |
| Windows 95 | 18 | 16 | 24 |
| QNX 4.05 demo | 4 | 6 | 2 |

The three are not timed alike. QEMU and v86 run in real time, so their times include every wait a
guest makes on its timers; MIRAGE is timed headless, where guest time follows its instructions and an
idle HLT costs nothing — which is all of its lead on QNX, a disk that mostly waits. In the page MIRAGE
runs in real time too. Windows 95's arrival is its first dialog, the others' their desktop or prompt.
`tools/v86/compare3.mjs`, the three measured one after another on 2026-11-03. Linux 2.2 is left out:
at MIRAGE's headless speed its console blanks itself (ten guest minutes) a few seconds after it boots,
and the screen it settles on is that blank one.

Linux programs run at 420–450 M x86 instructions a second on Dhrystone (830,000 Dhrystones a second,
a fifth of QEMU's user-mode translator); [docs/COMPARISON.md](docs/COMPARISON.md#speed) has the
benchmarks and how to reproduce them.

[v86](https://github.com/copy/v86) is the mature project in this space: it compiles to WebAssembly,
is faster on Windows, and boots systems MIRAGE cannot. On 32-bit computing the WebAssembly JITs are well
ahead: v86 runs DJGPP's CoreMark 6 times as fast as MIRAGE, and CheerpX (WebVM's engine) runs Linux
Dhrystone 9 times as fast; MIRAGE is ahead of js-dos and RetroTick. MIRAGE's own ground is the built-in DOS, the
readable generated code, and runs that are reproducible to the cycle.

## Quick start

```bash
python3 tools/serve.py 8761      # with the oasis-fetch relay OASIS images are fetched through; any static server runs the rest
# http://localhost:8761/            the home page, with the examples
# http://localhost:8761/machines.html  DOS, Linux, Windows and the bare PC on one page
# http://localhost:8761/dos.html    the DOS player: drop a .COM, .EXE or a folder
# http://localhost:8761/boot.html   the bare PC: boot a floppy, hard-disk or ISO image
```

```bash
git clone --recursive https://github.com/jfrelat-lab/mirage-x86   # PRISM is a submodule
node tools/test.js                # the unit suite
npm run test:all                  # every suite that needs nothing outside the repository
```

Node 22 (what it is developed on). The assembly sources under `demos/` and `tools/` need `nasm` only if you change
them; the assembled demos are checked in.

## How it is tested

MIRAGE is checked against other machines, not against its own expectations:

- `tools/test.js` — the unit suite; each test was written to fail when its fix is reverted.
- `tools/golden.js` — a fingerprint of the screen and state of 44 programs after a fixed number of
  cycles. Most are third-party and are skipped when their files are absent.
- `tools/conformance.js`, `tools/conformance386.mjs`, `tools/test-x86-uc.mjs` — single-instruction
  tests against the SingleStepTests vectors and against Unicorn.
- Probes in `tools/*.asm` — small boot programs that print what the hardware answers, run unchanged
  under QEMU and under MIRAGE and compared line by line (PCI, ATAPI, VBE, the UART, CMPXCHG8B…).
- Whole-system comparison against QEMU, DOSBox-X and v86 (`tools/v86/`, `tools/cosim/`).

[docs/TESTING.md](docs/TESTING.md) has the details.

## Documentation

Reference — the present state, kept current:

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — the model, the file map, how a block runs. Start here.
- [RECOMPILER.md](docs/RECOMPILER.md), [DEVICES.md](docs/DEVICES.md) — the engine; the BIOS, DOS and devices.
- [HARDWARE.md](docs/HARDWARE.md) — the machine a guest sees, and what each part was checked against.
- [COMPATIBILITY.md](docs/COMPATIBILITY.md), [KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — what runs; what does not, and why.
- [TESTING.md](docs/TESTING.md) — the gates and the comparison tools.
- [OASIS.md](docs/OASIS.md) — images of the period PC: `node tools/oasis.mjs run dos/c-dogs`, `run linux/doom-1994`.
- [COMPARISON.md](docs/COMPARISON.md) — MIRAGE beside Docker, QEMU, DOSBox-X and v86: what only MIRAGE does, modes, CPU, devices, conformance, speed.
- [ROADMAP.md](docs/ROADMAP.md) — what is open.
- [SITE.md](docs/SITE.md) — how the static site is built, checked and hosted.
- [CHANGELOG.md](CHANGELOG.md) — what changed, newest first.

Record — [docs/notes/](docs/notes/README.md): the investigations, measurements and audits as they
were written, wrong turns included. They are dated and not updated.

## Third-party software

This repository contains MIRAGE, the small demos written for it (`demos/`), and the **examples** of
the home page (`examples/`): programs whose authors or rights holders allow passing them on, each
with its licence in `examples/licenses/` and listed in [examples/README.md](examples/README.md) —
seven boot-sector programs (MIT, BSD, ISC, WTFPL), demoscene intros under free licences (Řrřola's,
viznut's Helium, The Orz's Linux intros), freeware and shareware DOS programs served as their
publishers released them (Unreal, Fractint, the Dune demo, C-Dogs, the DOOM, Heretic, Wolfenstein 3D
and Commander Keen shareware), and a FreeDOS 1.4 disk built from FreeDOS's own packages.

[PRISM](https://github.com/jfrelat-lab/prism) is a submodule (`vendor/prism`, MIT); its OpenGL and
Direct3D 9 code carries the third-party code listed in its
[THIRD-PARTY.md](https://github.com/jfrelat-lab/prism/blob/main/THIRD-PARTY.md).

OASIS images are recipes: the files they run are fetched from where their authors published them
(Debian's archive, idgames, scene.org) and are not in this repository. Beyond that, the tools that
expect an operating system, a game or an intro look in `boot/`, `games/` and `intros/`, which are
ignored by git: bring your own, and check that you are allowed to use what you bring.

The VGA fonts in `assets/` were rebuilt from rendered glyphs (`tools/build-fonts.mjs`).

## How it was built

MIRAGE was written with [Claude Code](https://claude.com/claude-code), Anthropic's coding agent,
directed by Julien Frelat; the commit history says so on every commit. The method is the one above:
nothing is taken on trust, every behaviour is compared with an independent implementation.

## License

[MIT](LICENSE). The licence covers MIRAGE itself, not the software you run on it.
