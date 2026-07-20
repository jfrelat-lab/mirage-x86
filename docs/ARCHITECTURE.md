# MIRAGE — Architecture

MIRAGE is a **pure-JavaScript x86→JS dynamic recompiler** plus a minimal **MS-DOS
environment**. It runs real DOS `.COM`/`.EXE` programs (demoscene intros, EGA/VGA games)
in the browser and headless in Node. **No WASM** — the design bet is that readable emitted
JavaScript + the browser's own JIT (V8/JSC) is a fast enough backend. North-star target:
Cryo's *Dune* and *Second Reality* running accurately and fluidly.

Project identity: **precision and speed** — a 100%-passing instruction conformance suite is a
non-negotiable safety net, and every optimization must preserve it.

> New to the codebase? Read this file, then [RECOMPILER.md](RECOMPILER.md) (the engine),
> [DEVICES.md](DEVICES.md) (BIOS/DOS/video/timer), [TESTING.md](TESTING.md) (the gates), and
> [COMPAT.md](COMPAT.md) (what runs today). Keep them updated when you change the design.

## The one-paragraph model

The guest is a 16-bit real-mode x86 (with 386 32-bit operand/address prefixes). Guest memory
is one flat `Uint8Array`. The recompiler translates a **basic block** of x86 starting at the
current `CS:IP` into a JavaScript function (a string compiled with `new Function`), caches it
keyed by linear address, and runs it. Blocks read/write the CPU register file and the memory
array directly. Software interrupts either trap into a JS BIOS/DOS handler or jump into a
guest-installed ISR. Hardware interrupts (PIT timer, keyboard) are delivered at block
boundaries. A hot loop is re-compiled as a single **fused region** (tier-2).

## File map (`src/`, ~3200 LOC)

| File | LOC | Role |
|---|---|---|
| `recompiler.js` | 983 | **The dynarec.** `translate()` (x86→JS emitter), the block cache, the run loop, tier-2 region compiler, SMC invalidation. The heart of the project — see [RECOMPILER.md](RECOMPILER.md). |
| `cpu.js` | 300 | CPU state (`reg`/`seg`/`base`/`eip`/`flags`/`fst`/`cycles`/`deadline`) + register accessors + ALU/flag helpers used by emitted code (`setSub`, `setAdd`, shifts, BCD, `mul16`, `cond`). |
| `bios.js` | 300 | BIOS: INT 10h/11h/12h/16h/1Ah, the IVT stubs, and the **I/O-port devices** (VGA DAC, 0x3DA beam, PIT-adjacent, keyboard 8042, SB/OPL stubs). Calls `installVGA`. |
| `dos.js` | 254 | DOS: the `.COM`/`.EXE` loader (`dos.load`), PSP setup, and the INT 21h services (file I/O via the VFS, memory, exec, date/time). |
| `machine.js` | 158 | Wires CPU+memory+recompiler; owns the **run loop entry** (`runSlice`), the modular I/O-port + interrupt bus, `swInt`/`realInt` dispatch, the **PIT timer** (`tickTimer`/`serviceTimer`), and keyboard IRQ injection. |
| `vga.js` | 101 | The **EGA/VGA 16-colour planar device** — 4 bit-planes + latches, all 4 write modes, Sequencer/Graphics-Controller/CRTC/Attribute registers. Mode 13h stays linear (handled in memory/video). |
| `memory.js` | 87 | Guest RAM: `u8`/`dv` over one `ArrayBuffer`, `codePage[]` (SMC dirty-tracking per 4 KiB page), and the `planar`/`vga` hooks that route A000 writes to `vga.js`. |
| `fpu.js` | 151 | x87 subset: an 8-deep `fst` register stack + status word; math via JS `Math.*`. Emitted inline by the recompiler (fallback calls for rare ops). |
| `vfs.js` | 167 | In-memory FAT-ish file system backing DOS file I/O. `VFS.dosName()` (8.3), `addFile`. |
| `video.js` | 116 | **Browser render** (main thread): mode 13h linear, EGA planar (`_renderPlanar`), and 80×25 text → an `ImageData`/canvas. |
| `ui.js` | 133 | Browser main loop: rAF, wall-clock PIT pacing, `runSlice` budgeting, the HUD/CRT toggles. |
| `shell.js` | 164 | A tiny `COMMAND.COM`: prompt, built-ins (`DIR`, `BARS`, `PLASMA`, …), launching programs. |
| `keyboard.js` / `mouse.js` | 45 / 63 | Browser input → guest scancodes / INT 33h mouse. |
| `main.js` | 104 | Browser entry: constructs everything, URL-param program loading (`?run=`), drag-drop. |
| `samples.js` | 78 | Built-in demo programs for the shell. |

Only `video.js`, `keyboard.js`, `mouse.js`, `ui.js`, `main.js`, `shell.js` touch the DOM.
The 9 engine files (`machine/cpu/memory/recompiler/bios/dos/vfs/fpu` + `vga`) are DOM-free and
run identically in Node — which is why the test/gate harnesses in `tools/` can drive the whole
machine headless.

## CPU state (`cpu.js`)

```
reg   : Uint32Array(8)   AX,CX,DX,BX,SP,BP,SI,DI  (index order: AX=0 CX=1 DX=2 BX=3 SP=4 BP=5 SI=6 DI=7)
seg   : Uint16Array(6)   ES=0 CS=1 SS=2 DS=3 FS=4 GS=5   (the selectors)
base  : Uint32Array(6)   cached linear base = selector<<4 (real mode); kept in step by setSeg
eip   : number           16-bit IP (32 under a 66 prefix)
flags : number           CF=1 PF=4 AF=0x10 ZF=0x40 SF=0x80 TF=0x100 IF=0x200 DF=0x400 OF=0x800
fst   : Float64Array(8)  x87 stack; ftop = top-of-stack index
cycles: number           retired-instruction counter — drives RDTSC, the PIT, and the VGA beam
deadline: number         cpu.cycles at which a running tier-2 region must bail (PIT delivery)
```

8/16/high-low register access goes through getters/setters (`cpu.al`, `cpu.ax`, …); the hot
emitted path indexes `reg`/`seg`/`base` directly.

## Memory (`memory.js`)

- One `ArrayBuffer` (16 MiB in the browser, 1 MiB headless). Views: `u8` (`Uint8Array`),
  `dv` (`DataView`, used for FPU float loads/stores). `mask = size-1`; addresses are masked.
- **SMC tracking:** `codePage[]` has one flag byte per 4 KiB page (`PAGE_BITS=12`). A page is
  marked when a block is compiled from it (`markCodePage`). Every guest write checks
  `codePage[addr>>12]` and, if set, calls `onCodeWrite` (wired to the recompiler's
  invalidator). Emitted inline writes replicate this check. See [RECOMPILER.md](RECOMPILER.md).
- **Planar routing:** in EGA/VGA 16-colour modes `mem.planar=true` and A000 byte accesses are
  routed to `mem.vga.writeByte/readByte` (the plane pipeline) instead of the flat array —
  emitted inline as `if(m.planar&&(addr>>>16)===10)…`. Mode 13h stays flat. See [DEVICES.md](DEVICES.md).

## Execution pipeline (`machine.js` + `recompiler.js`)

```
runSlice(maxBlocks)                      # machine.js — one time-slice
  └─ rec.run(machine, maxBlocks)         # recompiler.js — the dispatch loop:
       set cpu.deadline (next PIT tick, or Infinity if timerAuto off)
       while tbudget>0 and !halted and !blocked:
         if IF set: service queued keyboard IRQ, and PIT tick if cpu.cycles≥nextTimerCycle
         lin = base[CS] + (eip & 0xffff)
         blk = blockPages[lin>>12][lin&0xfff]         # O(1), no hashing
         if missing or blk.ip0 != ip0: blk = compile(lin, ip0)   # translate → new Function
         blk.fn(cpu, blk)                              # run the block (or fused region)
         cpu.cycles += blk.count
         if tier-1 block: tbudget--; if ++blk.hot == 64: promote to a tier-2 region
```

A **basic block** ends at any control-flow instruction (Jcc/JMP/CALL/RET/INT/LOOP/HLT) or at
`MAXOPS=192` instructions. INT n / INT3 / INTO terminate the block; div/idiv/`aam 0` faults are
the only mid-block trap (they call `swInt(0)` then continue).

## Interrupt model (`machine.js`)

Every IVT vector initially points at a BIOS stub segment (`0xF000`) whose bytes are `IRET`.
- `swInt(n)`: if vector n still points at the stub → run the **JS handler** for INT n
  (`intHandlers[n]`, trap-and-emulate; `eip` already points past the INT). Else the guest
  hooked it → `realInt(n)` pushes FLAGS/CS/IP, clears IF/TF, and jumps to the guest ISR.
- Hardware IRQs (PIT INT 8 / INT 1Ch, keyboard IRQ1 → INT 9) are delivered by `realInt` at
  block boundaries **only when IF is set**. See the timer/keyboard sections of [DEVICES.md](DEVICES.md).

## Two execution tiers

- **Tier-1** — every block is translated once to a JS function and cached. Correct, simple,
  the conformance/debug path (`stepOne` compiles exactly one instruction, uncached).
- **Tier-2** — after a block executes `T2_HOT=64` times it is promoted: its hot loop (the block
  plus its statically-reachable successors, ≤`T2_MAXBLK=24` blocks / `T2_MAXINS=384` instrs) is
  fused into one `for(;;){switch(_e){…}}` region, so a tight loop runs with zero per-iteration
  dispatch. Gated by `MIRAGE_NOTIER2`. Regions must be byte-identical to tier-1 — the
  `fuzz-region` gate enforces it. See [RECOMPILER.md](RECOMPILER.md).

## How a program gets loaded

Headless: `installBIOS(mc)` → `installDOS(mc, vfs)` → `dos.load(bytes, args, 'C:\\PROG.EXE')`,
then loop `mc.runSlice(N)`. `.COM` loads at PSP:0x100; `.EXE` is relocated per its MZ header.
Browser: `main.js` does the same via `?run=NAME` / `?run=https://…/x.com` / drag-drop, and
`ui.js` drives `runSlice` from `requestAnimationFrame`.

## Determinism (why the gates work)

The engine has **no nondeterminism**: `RDTSC` reads `cpu.cycles`, and there is no
`Math.random`/`Date`. The same input path yields byte-identical memory + video state, which is
what makes the golden-fingerprint gate possible (see [TESTING.md](TESTING.md)). Keep it that way.
