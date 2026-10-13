# MIRAGE

**An x86 PC in plain JavaScript: a dynamic recompiler that turns x86 machine code into JavaScript
source, with a built-in DOS so a `.COM` or `.EXE` runs the moment you drop it on the page.**

No WebAssembly, no build step, no dependencies. It runs in a browser and in Node.

```
 x86 machine code ─▶ decoder ─▶ JS source ─▶ new Function ─▶ the engine's own JIT ─▶ run
                     (per basic block, cached by linear address, aware of self-modifying code)
```

MIRAGE is two things sharing one CPU:

- **A DOS player** (`dos.html`). DOS, the BIOS, XMS, EMS and a DPMI host are implemented in
  JavaScript, so there is no DOS image to boot: a program starts at once.
- **A bare PC** (`boot.html`). A BIOS, an 8259/8254/RTC chipset, VGA and VBE, IDE disks, an ATAPI
  CD-ROM, and optionally a PCI bus and a 16550 serial port: enough to boot unmodified operating
  systems from a disk image or an El Torito CD.

## What runs today

Per-title status, with dates, is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
None of that software is in this repository — see [Third-party software](#third-party-software).

| | Reaches |
|---|---|
| DOS intros and demos | 31 of the 32 tried render; 21 are pinned by the golden test |
| DOS games | real mode, DOS extenders (DPMI), EMS/XMS — per-title status in docs/COMPATIBILITY.md |
| Windows 3.0, 95, 98, ME | the desktop |
| Linux 2.2 (BasicLinux), Linux 2.4 (Damn Small Linux, booted from its CD) | a shell; runlevel 5 |
| FreeDOS 1.3 (from its CD), MS-DOS 6.22 | the installer; the prompt |
| QNX 4.05 demo disk, KolibriOS, OpenBSD | the desktop; the desktop; `login:` |

**What does not work yet**, so nobody has to find out the hard way: Windows NT 3.51 (dies after the
graphical switch), Windows 2000 (stays on its boot screen), ReactOS (needs ACPI, which MIRAGE does
not have), BeOS 5 (stays on its splash screen), Plan 9. There is no Gravis Ultrasound, no network card,
no USB, no 64-bit mode. The CPU is a Pentium Pro without MMX.

## How fast

Wall-clock seconds to the arrival screen, same image, same host (lower is better):

| | QEMU (TCG) | v86 | MIRAGE |
|---|---|---|---|
| Windows 98 | 28 | 44 | 50 |
| Windows 95 | 18 | 16 | 34 |
| QNX 4.05 demo | 4 | 6 | 2 |
| Linux 2.2 | 10 | — | 8 |

[v86](https://github.com/copy/v86) is the mature project in this space: it compiles to WebAssembly,
is faster on Windows, and boots systems MIRAGE cannot. MIRAGE's own ground is the built-in DOS, the
readable generated code, and runs that are reproducible to the cycle.

## Quick start

```bash
python3 tools/serve.py 8761      # any static file server works
# http://localhost:8761/            the home page, with the examples
# http://localhost:8761/dos.html    the DOS player: drop a .COM, .EXE or a folder
# http://localhost:8761/boot.html   the bare PC: boot a floppy, hard-disk or ISO image
```

```bash
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
- [COMPARISON.md](docs/COMPARISON.md) — MIRAGE beside Docker, QEMU, DOSBox-X and v86: what only MIRAGE does, modes, CPU, devices, conformance, speed.
- [ROADMAP.md](docs/ROADMAP.md) — what is open.

Record — [docs/notes/](docs/notes/README.md): the investigations, measurements and audits as they
were written, wrong turns included. They are dated and not updated.

## Third-party software

This repository contains MIRAGE and the small demos written for it (`demos/`). It contains no
operating system, game, intro or BIOS from anyone else, and the tools that expect them look in
`boot/`, `games/` and `intros/`, which are ignored by git. Bring your own, and check that you are
allowed to use what you bring.

The VGA fonts in `assets/` were rebuilt from rendered glyphs (`tools/build-fonts.mjs`).

## How it was built

MIRAGE was written with [Claude Code](https://claude.com/claude-code), Anthropic's coding agent,
directed by Julien Frelat; the commit history says so on every commit. The method is the one above:
nothing is taken on trust, every behaviour is compared with an independent implementation.

## License

[MIT](LICENSE). The licence covers MIRAGE itself, not the software you run on it.
