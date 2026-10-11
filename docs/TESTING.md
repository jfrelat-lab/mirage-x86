# MIRAGE — Testing

What is checked, against what, and how to run it. Every tool is a Node script in `tools/` that
drives the engine headless; `tools/harness.mjs` composes the machine the way the browser does. The
history of how each tool came about is in [notes/testing-log.md](notes/testing-log.md).

## The gates

Run before every change to code or tools (documentation-only changes are exempt):

```bash
node tools/test.js              # must be all green
node tools/golden.js check      # must report 0 mismatch
```

`npm run test:all` runs these and the suites below that need nothing outside the repository; it is
what continuous integration runs.

| Tool | What it checks |
|---|---|
| `test.js` | The unit suite: the recompiler, the CPU, the devices, the BIOS and the probes' expected answers, close to 600 checks. Every check was written to fail when its fix is reverted. |
| `golden.js check` | The **golden** test: 44 programs run for a fixed number of cycles, and a fingerprint of what they leave — video mode, framebuffer, palette, planes, text, any fault — is compared with `tools/golden-baseline.json`. The only gate that sees a bug spanning several instructions, such as a flag computed by one and read by another. 39 of the programs are third-party files that are not in the repository; on a fresh clone they are skipped. `golden.js capture <file>` re-records one fingerprint: only after looking at the new picture and deciding it is right. |
| `test-x86-uc.mjs` | Single instructions against expectations captured from Unicorn, including generated cases that walk the ModRM, SIB and prefix grid (`tools/x86-gen.mjs`). |
| `test-dos.js`, `test-gfx.js`, `test-demos.js` | DOS end to end (a program loads and prints); mode 13h drawing; the assembled demos in `demos/` render and animate. |
| `test-dos-api.js` | The DOS and BIOS services against expected results. Two checks fail today ([KNOWN-ISSUES.md](KNOWN-ISSUES.md)); it is not part of `test:all`. |

## CPU references

| Tool | Reference |
|---|---|
| `conformance.js` | SingleStepTests 8088 vectors, 10,000 cases per opcode, fetched into `tools/sst/` on first use. `MIRAGE_CPU=386` runs the 386 profile on them, skipping the cases where the generations differ. |
| `conformance386.mjs` | SingleStepTests 80386 real-mode vectors (`tools/sst386/`). |
| `run-test386.mjs` | test386.asm, a self-checking 386 tester run as the BIOS ROM; the last POST code is the diagnostic. Build it from github.com/barotto/test386.asm into `boot/test386.bin`; it is also a golden entry and must reach POST FFh. |
| `fuzz-flags.js` | Random programs with and without dead-flag elimination: identical results required. |
| `fuzz-region.js` | Random programs through the second tier and through single steps: identical results required. |
| `cosim/` | Runs the same window of a real program in MIRAGE and in Unicorn, instruction by instruction, to find the first divergence. |

## Machine references

The rule: behaviour changes when independent implementations agree ([HARDWARE.md](HARDWARE.md)).

**Probes.** `tools/*.asm` are small boot programs that print, on COM1, what the machine answers:
PCI configuration (`pcidump`), the ATAPI drive (`atapiprobe`), a CD boot (`cdboot`), VBE modes
(`vbemodes`, `vbeprobe`), DISPI (`dispiprobe`), the UART (`uartprobe`), the CMOS (`cmosdump`), INT 10h
in graphics modes (`int10gfx`), CMPXCHG8B (`cx8probe`), and others. Each file's header gives the
commands. The same image runs under QEMU (`-serial file:…`, `-device isa-debug-exit,iobase=0xf4`) and
under MIRAGE (`tools/v86/serialboot.mjs`, `MIRAGE_SERIAL=1`), and the two outputs are compared line
by line. Where a probe's answer settled a behaviour, `test.js` has a check with the same values.

| Tool | Reference |
|---|---|
| `int10-oracle.mjs`, `vga-rom.mjs` | INT 10h against a real VGA BIOS ROM run inside MIRAGE, call by call. |
| `dos-oracle.mjs` | INT 21h answers recorded from a real DOS kernel booted on MIRAGE's BIOS. |
| `dbx-oracle.mjs` | The sequence of file and video events of a program, against DOSBox-X's debug log. |
| `dosdiff.js`, `egaref.mjs` + `shot.mjs` | A program's picture against DOSBox-X's at the same timer count; `DDCYCLES="fixed 3323"` runs DOSBox-X at MIRAGE's instruction rate, for CPU-bound programs. |
| `record-audio.mjs` | What a program sounds like, as a WAV, over machine seconds; prints the level of each second. |
| `opl-compare.mjs` | `src/opl.js` against Nuked-OPL3 sample for sample: a program's OPL writes are logged at their sample positions and rendered by both (`tools/nuked-render.c`, built outside the repository: Nuked is LGPL). |
| `audio-compare.mjs` | Two recordings of the same program (ours and a reference's: DOSBox-X through SDL's disk audio driver, or QEMU's `-audiodev wav`), cut at their silences and compared section by section: duration, level, pitch, spectral centroid, L/R, envelope correlation. |
| `qemu-shot.mjs` | A protected-mode program's picture captured from QEMU, from outside the guest. |
| `dbx-shot.mjs` | The frames DOSBox-X's VGA displays (`DX-CAPTURE /V`, decoded by `zmbv.mjs` from PRISM): what the card shows, CRTC display end and blanking included, not what memory holds. QEMU ignores horizontal blanking (Helium: 288 pixels there, 252 on DOSBox-X). |
| `v86/qemudiff.mjs` | A boot image's screen under MIRAGE against QEMU's, pixel by pixel. |
| `v86/compare3.mjs` | Time to the arrival screen under QEMU, v86 and MIRAGE. |
| `v86/v86shot.mjs` | v86 itself, headless, with screenshots and keystrokes. Needs v86 installed in `V86_DIR`. |

## Running systems and programs

| Tool | Use |
|---|---|
| `v86/bootshot.mjs <image> <seconds> <outdir>` | Boot a disk image or an ISO, screenshot every `STEP` guest seconds. `MEM`, `MIRAGE_CPU`, `MIRAGE_PCI`, `MIRAGE_SERIAL` (COM1 to `serial.txt`), `CDROM`, `ENTER`. |
| `v86/typeboot.mjs <image> <wait-for> <line>…` | Boot, wait for text on the screen, type lines, print the screen after each. |
| `v86/serialboot.mjs <image>` | Boot and print what the guest sends to COM1, until it writes port F4h. |
| `run-game.mjs <dir> <program>` | Mount a directory as C: and run a DOS program headless; report mode, faults, what was drawn. |
| `shot.mjs`, `probe-intro.js` | A DOS program's frame as a PNG; why an intro draws black. |
| `survey-gaps.mjs`, `survey-ports.mjs` | Over the whole corpus: the interrupts and DOS functions asked for and missing; what is done to the I/O bus. |

The images and programs these expect live in `boot/`, `games/` and `intros/`, which are not in the
repository.

## Performance

```bash
node tools/bench.js --json      # throughput per workload, in cycles
```

Measure in cycles, never in wall-clock seconds alone, and never two runs at once. A change that
speeds up one kind of guest must not slow the DOS player: profile `tools/bench.js tube` on the old
and new trees, then run `bench.js --json` alternating old and new, three times each.

## Verifying a change

1. The two gates, green.
2. A new check in `test.js` that fails when the change is reverted — try it.
3. For behaviour that a reference can see: the probe or oracle, run on both sides.
4. For an optimisation with a switch: the gates with the switch on and off.
5. Look at the picture. A count of non-zero pixels is not a picture: a solid fill scores full marks.
