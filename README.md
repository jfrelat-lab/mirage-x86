# MIRAGE — a pure-JavaScript x86 / MS-DOS machine

MIRAGE runs MS-DOS programs in a web page with **no WASM and no DOSBox** — just a
**source-level x86→JavaScript dynamic recompiler**. It decodes real-mode x86 basic
blocks, emits readable JavaScript, compiles it with `new Function`, and lets the
browser's own JIT optimise the hot blocks. A two-tier JIT, all client-side.

```
 x86 machine code ─▶ decoder ─▶ JS source ─▶ new Function ─▶ V8/SpiderMonkey JIT ─▶ run
                     (per basic block, cached by linear address; SMC-aware)
```

It is **not** an interpreter (like a naïve emulator), **not** DOSBox compiled to
WASM (js-dos), and **not** a WASM-emitting JIT (v86). The generated code is plain
JavaScript you can read in the debugger.

## Status

The core is built and **verified in Node**: a hand-written suite (31 checks) plus a
**conformance harness that passes 423,736 real-8088 test vectors at 100%** (the
TomHarte / SingleStepTests set) across the ALU grid, INC/DEC, TEST, MOV/XCHG,
group-1, shifts, rotates, NOT/NEG/MUL/IMUL and the BCD instructions. In the browser
you get a working MS-DOS prompt, the CP437 text screen, VGA mode 13h graphics,
keyboard input, drag-and-drop file mounting, and URL program loading. Running *Dune*
(Cryo) or *Second Reality* flawlessly is the north star this foundation is built
toward — see [Roadmap](#roadmap). This is an honest early build of a very large
machine, not a finished emulator.

## Quick start

No build step, no dependencies.

```bash
# from the mirage/ directory
python3 tools/serve.py 8761      # any static server works
# open http://localhost:8761
node tools/test.js               # 31 recompiler checks
node tools/test-dos.js           # DOS hello-world end-to-end
node tools/test-gfx.js           # mode-13h demos paint the framebuffer
node tools/test-demos.js         # real nasm-assembled VGA demos render + animate
node tools/conformance.js        # 423k+ real-8088 vectors (downloads on demand)
```

At the prompt: `DIR`, `HELP`, or run a demo. Besides the hand-written `BARS`,
`PLASMA`, `BANNER`, `HELLO`, two **real nasm-assembled VGA demos** ship in `demos/`
and mount on `C:`: **`XORMUNCH`** (munching-squares XOR field with a palette
rotated through the DAC ports) and **`PLASMA13`** (a runtime-LUT plasma under a
rainbow palette). **Ctrl+C** stops a running program. Drag a `.COM`/`.EXE` onto the
window to mount it on `C:` (and auto-run it).

The demos are real-mode VGA programs (`demos/*.asm`); rebuild with `npm run demos`
(needs `nasm`). They exercise INT 10h mode-set, direct `A000:0` framebuffer writes,
the VGA DAC palette ports (`0x3C8`/`0x3C9`), `0x3DA` vsync polling, and INT 16h —
which is what testing *real* programs forced the engine to implement.

### URL parameters

```
?run=PLASMA                 run a program already on C:
?run=https://…/x.com        fetch a binary, mount it, run it
?args=...                   command tail passed to the program
?load=URL[,URL2]            fetch + mount without running
?cmd=DIR                    run any shell command line
```

## Architecture

The engine is **DOM-free** so it runs identically in Node and the browser, which is
what makes the headless test harness possible.

| Module | Role |
|--------|------|
| `src/memory.js` | Flat physical RAM, little-endian accessors, self-modifying-code page tracking |
| `src/cpu.js` | Register file (32-bit, 386-ready), segmentation, EFLAGS, mul/div/shift helpers |
| `src/recompiler.js` | **The dynarec** — decodes basic blocks, emits JS, caches by `(linear, ip)`, SMC invalidation |
| `src/machine.js` | Run loop, modular I/O-port + interrupt bus, JS-handler vs guest-ISR routing, timer injection |
| `src/bios.js` | INT 10h (video + DAC palette), INT 16h (keyboard), INT 1Ah (timer), the BIOS Data Area |
| `src/dos.js` | INT 21h kernel, PSP, bump allocator, COM + MZ-EXE loaders (with relocation) |
| `src/vfs.js` | In-memory `C:` filesystem, 8.3 paths, DOS handle table, drag-drop ingestion |
| `src/video.js` | Renders text mode (CP437 glyphs) and mode 13h (256-colour) to a canvas |
| `src/keyboard.js` | Browser key events → BIOS (scan, ascii) pairs |
| `src/shell.js` | A COMMAND.COM-style shell (DIR, CD, TYPE, COPY, …) and program launcher |
| `src/ui.js` / `src/main.js` | App controller (render loop, timer pacing) and DOM wiring |

### How a block is compiled

The recompiler walks x86 bytes from CS:IP until the first control transfer, building
a JavaScript function body that mutates CPU state directly. For example a small loop
becomes something like:

```js
// generated for: ADD AX,CX / LOOP back
var r = cpu.reg, m = cpu.mem, sb = cpu.base;
var _0 = (r[0]&0xffff), _1 = (r[1]&0xffff);
var _2 = (_0+_1)&0xffff; r[0]=(r[0]&~0xffff)|_2; cpu.setAdd(_0,_1,_2,16);
r[1]=(r[1]&~0xffff)|((r[1]-1)&0xffff);
cpu.eip = ((r[1]&0xffff)!==0) ? 5 : 9; return;
```

Each block is compiled **once** and then re-run from cache — in the browser, the
PLASMA demo executes ~100M block-invocations from only **7 compiled blocks**.

## Innovations (vs. the state of the art)

- **Source-level x86→JS recompilation.** Readable generated JS, JIT-compiled by the
  browser. Different approach from js-dos (DOSBox→WASM) and v86 (WASM-JIT).
- **DOM-free deterministic core** → enables headless framebuffer testing today, and
  time-travel / deterministic replay tomorrow (the state is fully serialisable).
- **Modular device + interrupt bus.** I/O ports and interrupt vectors are pluggable;
  a software INT is trap-and-emulated in JS unless the guest has hooked the vector,
  in which case a *real* INT runs the guest ISR (so games can install INT 9 / 1Ch).
- **Live JIT inspector.** The DEVTOOLS panel shows registers/flags, block-compile
  counts, and execution rate — a window into the recompiler.
- **Self-modifying-code aware.** Writes to a translated page invalidate its blocks.
- **Silicon-validated.** `tools/conformance.js` replays the TomHarte 8088 vectors
  (10k cases/opcode) through the single-step path and compares registers + RAM
  strictly and flags masked by the 8088's officially-undefined bits. It caught two
  genuine 8086 quirks during development: DAA/DAS use an **AF-dependent** high-adjust
  threshold (`0x99` vs `0x9F`), and a DAS low-nibble borrow does **not** set CF.

## Roadmap (toward Dune / Second Reality)

The foundation is deliberately shaped to grow without a rewrite (the register file is
already 32-bit, operand sizes are parameterised, the device bus is modular).

**Done — Phase A (core correctness):** broad real-mode instruction set incl. BCD,
bit instructions (BT/BTS/BTR/BTC, BSF/BSR), SHLD/SHRD, XADD, CMPXCHG, INS/OUTS;
single-step path; 423k-vector conformance at 100%; an **x87 FPU subset** (the full
memory-operand grid over f32/f64/i16/i32 plus common register ops) wired in as a
modular coprocessor. Real third-party intros run: **HellMood's "Memories"** (the
256-byte REVISION 2020 intro, [pouet #85227](https://www.pouet.net/prod.php?which=85227))
loads and animates through its scenes — it needs only `fild`/`fidivr`/`fstp` plus
`outsb` for its MIDI music. Use `node tools/run-com.js <program>` to probe any .COM.

**Next:**
- **Hardware input/timing** — 8259 PIC, keyboard IRQ via INT 9 + port 60h, 8253 PIT,
  and a mouse INT 33h driver (the path to a *playable* game).
- **386 protected mode + DPMI** — most larger 90s demos and games need it.
- **Mode X, planar VGA, palette tricks**, and a WebGL CRT / composite-CGA shader.
- **Sound Blaster / AdLib (OPL) + MPU-401 MIDI** audio via WebAudio (today the music
  ports are accepted but silent).
- **INT 13h disk + disk-image mounting** (boot real DOS, mount `.img`/`.zip`).
- **More INT 21h** (EXEC/4Bh, full FCB layer) and **lazy flags + block linking** for
  raw speed, plus a **Web Worker + SharedArrayBuffer** transport to free the main thread.

## Known limitations

- Real-mode 8086/186/286 instruction set (broad and conformance-checked); no protected
  mode yet, and the **FPU is a pragmatic subset** (float64-backed, no 80-bit precision,
  no exception/tag machinery). Variable shift counts mask to 5 bits (286+ semantics, not
  the 8088's full-count behaviour); 32-bit `IMUL` overflow flag is approximate.
- Audio is not synthesised — AdLib/SB/MPU-401 port writes are accepted but silent.
- One drive (`C:`), in-memory (not yet persisted to IndexedDB).

## Credits

The CP437 ROM font (`assets/vga-rom-8x16.bin`) is a raw IBM VGA character-ROM dump
from VileR's [VGA text-mode fonts](https://int10h.org/oldschool-pc-fonts/)
(CC BY-SA 4.0; see `assets/FONT-LICENSE.txt`). Everything in `src/` is original work.
