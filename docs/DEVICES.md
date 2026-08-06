# MIRAGE — Devices (BIOS, DOS, Video, Timer, Input)

The trap-and-emulate layer around the CPU. Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

Everything hangs off `machine.js`'s two buses:
- **Interrupts:** `hookInterrupt(n, fn)` registers a JS handler for INT n and points its vector
  at the BIOS stub. `swInt(n)` runs it (or `realInt` into a guest ISR if the guest hooked n).
- **I/O ports:** `onPortRead(port, fn)` / `onPortWrite(port, fn)`. `ioRead/ioWrite` mask the
  return width. An unhandled port reads `0xFF`/`0xFFFF`.

## BIOS (`bios.js`)

INT handlers: **10h** (video), **11h** (equipment), **12h** (memory KB), **16h** (keyboard),
**1Ah** (RTC/ticks). The BIOS Data Area (`0x400`) is seeded (equipment word, video mode, cols,
rows). `installVGA(machine)` is called from here.

### INT 10h subfunctions worth knowing
- `AH=00` set mode → writes BDA 0x449, reloads the default DAC, sets `mem.planar` for
  EGA/VGA 16-colour modes (0Dh/0Eh/0Fh/10h/11h/12h) and calls `vga.setMode`.
- `AH=0E` teletype, `AH=09/0A` write char/attr, `AH=13` write string, `AH=02/03` cursor.
- `AH=12` (BL=10h) returns EGA/VGA info (BX=0x0003, CX=0). Other subfns are acked.
- `AH=1A` **Get Display Combination Code** — returns **AL=0x1A** (function supported) + BL=0x08
  (VGA colour). ⚠️ AL *must* be 0x1A; the universal probe is `mov ax,1A00h;int 10h;cmp al,1Ah`.
  Returning AL=0 reads as "no VGA" (this was God of Thunder's quit bug).

## DOS (`dos.js`)

The loader (`dos.load`) builds a PSP, relocates `.EXE` (MZ header) or loads `.COM` at :0x100,
sets up segments/stack, and jumps to the entry point. INT 21h services implemented (by AH):

```
00 01 02 06 07 08 09 0A 0B 0C 0E   console/char I/O + print$
19 1A                              current drive / set DTA
25 35                              set / get interrupt vector   ← games install ISRs here
2A 2C                              get date / get time
2F 30 33 36                        get DTA / DOS version(5,0) / ctrl-break / free space
3C 3D 3E 3F 40 41 42 43 44         create/open/close/read/write/delete/seek/attr/ioctl (files via VFS)
47 48 49 4A                        get cwd / alloc / free / resize MCB
4C 4D                              terminate(exit code) / get child return code
4E 4F 56 57                        findfirst / findnext / rename / file date-time
```

Files live in an in-memory `VFS` (`vfs.js`); `VFS.dosName()` maps to 8.3. No real disk, no
network. There is **no EMS/XMS and no DPMI/protected mode** (raptor/jazz need DPMI).

## Video

Two completely separate paths depending on mode:

### Mode 13h — linear 256-colour (fast path)
A000 is a flat `320×200` byte framebuffer in `mem.u8`. Emitted writes hit the array directly.
`video.js._renderGfx13` maps each byte through the DAC palette. No device object involved.

### EGA/VGA 16-colour — planar (`vga.js`)
`mem.planar=true` routes A000 byte accesses to the VGA device. The picture lives in
**`vga.planes`** (4 × 64 KiB bit-planes), **not** in linear A000 — a common trap when writing a
probe (check `machine.vga.planes`, never `mem.u8[0xa0000]`, in planar modes).

The write pipeline (`vga.writeByte`) implements the real Graphics Controller:
- **Sequencer** (0x3C4/5): reg 2 = Map Mask (per-plane write enable).
- **Graphics Controller** (0x3CE/F): reg 0 Set/Reset, reg 1 Enable-Set/Reset, reg 3
  Rotate+ALU-function, reg 4 Read-Map-Select, reg 5 write mode (0–3), reg 8 Bit Mask.
- **Latches** (4): a CPU *read* loads all four latches (what makes read-modify-write blitting
  work) and returns the read-map-selected plane. Write modes 0/1(latch-copy)/2/3 all implemented.
- **Attribute Controller** (0x3C0): the 16-entry palette (index→DAC), flip-flop reset by a
  0x3DA read. **CRTC** (0x3D4/5): reg 0C/0D display-start (page-flip/scroll), reg 13 offset
  (logical row width) — `_renderPlanar` honours both, so Keen's smooth scroll works.

### CGA graphics — modes 4/5/6 (`video.js._renderCGA`)
Implemented (Alley Cat renders; `demos/CGA.COM` guards it in golden). The B800 framebuffer is
interleaved: even scanlines at +0x0000, odd at +0x2000, 80 bytes/row. Modes 4/5 = 320×200×4
(2 bpp) with the palette chosen by the **0x3D9 colour-select register** (`bios.cga.color`:
bit4 intensity, bit5 palette green/red/brown vs cyan/magenta/white); mode 6 = 640×200 mono.
`bios.cga = { color, mode }`; ports 0x3D8/0x3D9 in `bios.js`. **INT 10h character output works in
CGA graphics modes:** teletype/write-char draw each char as an 8×8 font glyph into the B800 bitmap
(from the real 8×8 `machine.font8x8`, falling back to the 8×16 `machine.font` downsampled), not a
text char/attr cell — games print prompts over graphics this way (Alley Cat). INT 10h AH=0Bh sets
the CGA palette/background.

**Fonts** — the three IBM VGA ROM fonts `assets/vga-rom-8x{8,14,16}.bin` (256 glyphs, 1 byte/row,
MSB=left) cover every mode: 8×8 (CGA/200-line graphics + CGA text), 8×14 (EGA text/350-line), 8×16
(VGA text mode 3 + 480-line graphics). They were **graphically extracted from DOSBox-X** (the
reference), not copied from source: `tools/fontdump.asm` draws all glyphs in modes 13h/10h/12h and
dumps the framebuffer, `tools/build-fonts.mjs` reverse-engineers the bitmaps. `video.js` loads all
three onto `machine.font`/`font8x8`/`font8x14`.

> ⚠️ **Render dispatch is flag/mode-mixed** (`video.js:render`): 13h → gfx13; else `mem.planar`
> → planar; else mode 4/5/6 → CGA; else text. A program that inherits a stale graphics mode
> from a *previous* program (MIRAGE never resets the mode when the shell regains control) can
> render its text through the wrong path — see [COMPAT.md](COMPAT.md) "known rough edges".

### The DAC (`bios.js`)
Ports 0x3C8 (write index) / 0x3C7 (read index) / 0x3C9 (RGB data, 6-bit). Most demos set the
palette this way rather than via INT 10h. `bios.dac` is 256×3 bytes.

## Timer — PIT channel 0 (`machine.js`)

The 18.2 Hz tick is **clocked off `cpu.cycles`**, treating one retired instruction as one
~1.19 MHz PIT tick. `pitReload` (default 65536 = the real reload → an emulated ~1.2 MIPS 386;
override with `MIRAGE_PITRELOAD`) is the period; `nextTimerCycle` the next threshold.

- **Counter-0 read (`IN 0x40`)** returns the live countdown value (derived from `cpu.cycles`, LSB-
  then-MSB per the access mode). Games poll it for fine timing/delays/entropy — Alley Cat's gameplay
  loop spins on it, so a constant reply froze the game. A counter-0 command re-aligns reads to LSB.
- **Counter-0 reprogramming honoured:** games set a faster INT 8 rate via `OUT 43h`/`OUT 40h`
  (Dune ~200 Hz, God of Thunder ~140 Hz for its logo). `machine`'s 0x43/0x40 handlers decode the
  access mode and call `setPitReload()`, so timer-paced intros run at the intended speed (ignoring
  this made them 8–11× too slow). `machine.pitBase` keeps the default so the **0x3DA beam** (70 Hz,
  an independent clock) does not move when the system timer is reprogrammed. In the browser `ui.js`
  paces `tickTimer` to `pitReload` (clamped, so a kHz sound-rate timer can't flood the loop).

- **`serviceTimer()`** — fires when `cpu.cycles ≥ nextTimerCycle`: bumps the BDA tick, runs the
  guest INT 8 ISR (or chains INT 1Ch) via `realInt`, advances `nextTimerCycle` and `cpu.deadline`.
  Coalesces a long IF-off gap into a single tick.
- **Delivered mid-slice** at run-loop block boundaries (and by tier-2 regions via `cpu.deadline`,
  see [RECOMPILER.md](RECOMPILER.md)). This is why a guest that busy-waits on a timer-updated
  counter *inside* one `runSlice` (Wolf3D/Stryker/Hocus) now makes progress — the old model only
  ticked between slices.
- **`machine.timerAuto`** gates the run-loop firing. **On** headless (deterministic,
  representative). **Off** in the browser (`ui.js` paces `tickTimer` to wall-clock 18.2 Hz for
  real-time game speed) and in `bench.js`/`fuzz-region.js` (they need the legacy 1-tick-per-frame
  model / no async ticks). When off, `cpu.deadline=Infinity` so regions never bail on the timer.

### Known limitation — block-granular timing (and how DOSBox avoids it)

Two design choices bound how accurate our timing can be, and they matter to a whole class of
timing-sensitive titles (see the table below):

1. **IRQs are sampled at basic-block boundaries.** `runSlice(N blocks)` runs a fixed block count;
   `run()` checks `cpu.cycles ≥ nextTimerCycle` only *between* blocks, so a due INT 8 lands up to
   one block (`MAXOPS` = 192 instructions) late. Errors do not self-correct — the schedule is never
   re-anchored inside a slice.
2. **The 0x3DA beam is `cpu.cycles % vgaPeriod`** — the beam phase is *coupled to* `cpu.cycles`, so
   jitter in when the ISR runs also moves the apparent beam position.

**DOSBox does it differently** (reverse-engineered from dosbox-staging, 2026-08-03):

| | DOSBox | MIRAGE today |
|---|---|---|
| Run budget | `CPU_Cycles` **capped to the next PIC event** (`pic.cpp` `PIC_RunQueue`), re-anchored at every event | fixed `runSlice(N blocks)` |
| IRQ sampling | per block, but the budget *ends* at the event, so it returns there | per block, run continues past the tick |
| 0x3DA beam | `PIC_FullIndex() - vga.draw.delay.framestart` (`vga_misc.cpp`) — **PIC time re-anchored every frame**, immune to CPU-cycle granularity | `cpu.cycles % vgaPeriod` (coupled to cycle jitter) |
| Trap Flag | dynrec **falls back to the interpreter** (`CPU_Core_Dynrec_Trap_Run` → `CPU_Core_Normal_Run`) | same idea — `run()`'s TF path uses `translate(…,1)` |

Empirically, **DOSBox-X `core=dynamic` renders Heaven identically to `core=normal`** — so this is
*not* a recompiler-paradigm limit; a block recompiler can be accurate enough. The gap is our
fixed-slice + raw-cycle-beam design.

**The correct fix path** (see ROADMAP D7): emit a **deadline safepoint inside tier-1 codegen**
(blocks decrement/check a budget and return, exactly as tier-2 regions already do via
`cpu.deadline`), plus a PIC-style event scheduler and a frame-anchored beam clock.
⚠️ **Do NOT bound blocks by re-translating them** — truncating the straddling block with an uncached
`translate(lin, ip0, room)` per crossing was catastrophically slow (a vsync-poll loop crossing frame
boundaries re-JITs constantly; a single `runSlice` never completed). Tried and reverted, 2026-08-04.

### Titles that depend on PIT/PIC timing (mutualise the work here)

| Title | What it does | Status today |
|---|---|---|
| **Wolf3D** | reprograms counter 0 to ~700 Hz for its sound service | **capped** at `pitBase>>4` ≈ 291 Hz to avoid an INT-8 storm — a real event scheduler could lift this |
| **Dune (Cryo)** | ~200 Hz timer-paced animation | works (A6) |
| **God of Thunder** | ~140 Hz for the logo | works (A4) |
| **Alley Cat** | polls the counter-0 live countdown (`IN 0x40`) for gameplay/entropy | works |
| **Heaven** (NoooN 4K) | 1 kHz ISR **+ ~240 k 0x3DA polls/frame** for vsync | **derails** ~52.5 M cycles — but **NOT a timing-granularity bug**: it derails identically at *every* block size (1, 2, 4, 8, 16, 64, 192), all landing in 52.49–52.70 M. Cause still unknown; do **not** use it to justify D7 (see COMPAT.md) |
| **Moktar** `GAME.TDT` | `STI;HLT` between decryption passes | works via the HLT-wake path |
| 0x3DA-polling intros (kaneda, difze, rv256, revitro) | measure the retrace | work, but their golden fingerprints **shift** whenever delivery timing changes → any timing change needs a per-intro dosdiff re-bless |

## Input

- **Keyboard:** an 8042 controller (ports 0x60 data / 0x64 status) delivers queued keys as
  make/break scancodes and raises **IRQ1 → INT 9** (`machine.pushScancodes`/`pumpKeyboard` →
  `hwIrqPending`, serviced at block boundaries when IF set). Games install their own INT 9 and
  read scancodes from port 0x60 — the BIOS INT 16h buffer (`machine.keyQueue`) is the fallback.
  - **Browser bridge (`keyboard.js`):** drives BOTH paths. `keydown` → a Set-1 MAKE scancode
    (keyed by `KeyboardEvent.code`, the physical key) via `pushScancodes`, plus a `(scan,ascii)`
    pair onto `keyQueue`; `keyup` → the BREAK scancode (`make | 0x80`). Arrows map to bare XT
    numpad scancodes (0x48/0x4b/0x4d/0x50, no E0). `ui.js`'s run loop calls `pumpKeyboard()` each
    iteration so staged scancodes reach the guest. Before the 2026-07-20 fix the browser fed only
    `keyQueue`, so INT-9 games (Alley Cat, God of Thunder, Wolf3D) got no input at all.
- **Game port 0x201:** reads `0xF0` — "no joystick" (buttons up, axis one-shots timed out).
  Returning the bus default 0xFF left the axis bits stuck high and hung Keen 4's joystick probe.

## Sound (stubs only — no audio)

Just enough handshake so detection passes:
- **Sound Blaster** (base 0x220): DSP reset (0x226→0xAA), version query (0x22C `E1`→4.05),
  read/status ports. Commands accepted and dropped.
- **AdLib/OPL** (0x388, mirrored at 0x228): the timer-expiry handshake — writing the
  timer-start bit to register 4 arms the 0xC0 status the probe expects. No FM synthesis.

## Full port map

| Port | Dir | Device |
|---|---|---|
| 0x20 / 0xA0 | W | PIC EOI (no-op) |
| 0x60 / 0x64 | R/W | 8042 keyboard |
| 0x201 | R/W | game/joystick (0xF0) |
| 0x226 / 0x22A / 0x22C / 0x22E | R/W | Sound Blaster DSP |
| 0x228 / 0x229 · 0x388 / 0x389 | R/W | OPL/AdLib |
| 0x3C0 | W | Attribute Controller |
| 0x3C4 / 0x3C5 | R/W | VGA Sequencer |
| 0x3C6 | R/W | DAC pixel mask |
| 0x3C7 / 0x3C8 / 0x3C9 | R/W | DAC palette |
| 0x3CE / 0x3CF | R/W | VGA Graphics Controller |
| 0x3D4 / 0x3D5 | R/W | CRTC |
| 0x3DA | R | Input Status #1 — the **VGA beam** |

### The 0x3DA beam
A time-based beam, not a per-read toggle: bit3 (vertical retrace) and bit0 (display-disabled)
are derived from `cpu.cycles % vgaPeriod`, where `vgaPeriod = pitReload / 3.845` (the 70 Hz VGA
: 18.2 Hz PIT ratio). Reading 0x3DA also resets the Attribute Controller flip-flop. A short
retrace pulse at frame end + surrounding vblank; demos that *measure* the retrace (not just wait
for an edge) see a realistic period.

⚠️ Because the phase is `cpu.cycles % vgaPeriod`, it is **coupled to cycle jitter**: anything that
shifts when the timer ISR runs also shifts the apparent beam. DOSBox instead measures from a
**per-frame anchor** (`PIC_FullIndex() - framestart`), which is immune to that. See *Known
limitation — block-granular timing* above and ROADMAP **D7**.
