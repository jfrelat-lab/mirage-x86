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

The hard core is built and **verified in Node** (35 assertions across CPU, DOS and
graphics). In the browser you get a working MS-DOS prompt, the CP437 text screen,
VGA mode 13h graphics, keyboard input, drag-and-drop file mounting, and URL
program loading. Running *Dune* (Cryo) or *Second Reality* flawlessly is the north
star this foundation is built toward — see [Roadmap](#roadmap) for what that needs.
This is an honest v1 of a very large machine, not a finished emulator.

## Quick start

No build step, no dependencies.

```bash
# from the mirage/ directory
python3 tools/serve.py 8761      # any static server works
# open http://localhost:8761
node tools/test.js               # 20 recompiler checks
node tools/test-dos.js           # DOS hello-world end-to-end
node tools/test-gfx.js           # mode-13h demos paint the framebuffer
```

At the prompt: `DIR`, `HELP`, or run a bundled demo — `BARS`, `PLASMA`, `BANNER`,
`HELLO`. **Ctrl+C** stops a running program. Drag a `.COM`/`.EXE` onto the window
to mount it on `C:` (and auto-run it).

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

## Roadmap (toward Dune / Second Reality)

The foundation is deliberately shaped to grow here without a rewrite (the register
file is already 32-bit, sizes are parameterised, the device bus is modular):

- **386 protected mode + DPMI** — most 90s demos and games need it.
- **x87 FPU** — currently decoded and skipped (a v1 limitation).
- **Mode X, planar VGA, palette tricks**, and a WebGL CRT / composite-CGA shader.
- **Sound Blaster / AdLib (OPL)** audio via WebAudio.
- **INT 13h disk + disk-image mounting** (boot real DOS, mount `.img`/`.zip`).
- **More INT 21h** (EXEC/4Bh, full FCB layer) and **lazy flags + block linking** for
  raw speed, plus a **Web Worker + SharedArrayBuffer** transport to free the main thread.

## Known limitations (v1)

- Real-mode 8086/186/286 instruction subset (broad, but no protected mode/FPU yet).
- Shifts mask the count to 5 bits (286+ semantics); BCD `DAA/DAS/AAA/AAS` not yet
  implemented; 32-bit `IMUL` overflow flag is approximate.
- One drive (`C:`), in-memory (not yet persisted to IndexedDB).

## Credits

The CP437 ROM font (`assets/vga-rom-8x16.bin`) is a raw IBM VGA character-ROM dump
from VileR's [VGA text-mode fonts](https://int10h.org/oldschool-pc-fonts/)
(CC BY-SA 4.0; see `assets/FONT-LICENSE.txt`). Everything in `src/` is original work.
