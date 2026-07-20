# MIRAGE — Compatibility Status

A living record of what runs and what's blocked, so a future session starts from the known
frontier instead of re-surveying. Update it when you unblock something.

> ⚠️ When probing a game headless, check the **right framebuffer**: mode 13h → `mem.u8[0xa0000]`;
> **EGA planar (mode 0xD) → `machine.vga.planes`** (linear A000 is empty). Getting this wrong
> once cost a whole mis-diagnosis ("stuck on planar" that was actually rendering fine).

## Demos / intros — the golden set (all render)

20 workloads are covered by the golden gate: `plasma13`, `xormunch`, **`planar`** (the
hand-written EGA write-mode test), plus the third-party intros `256b 256bytef above chaosequ
difze intoanew intro intro256 kaneda lattice memories oktaeder puls revitro rv256 tube upup`.
`memories` (x87 FP) and `tube`/`kaneda` (FP raytracers) exercise the FPU path. `256bytef`,
`intoanew`, `memories` are **timer-paced** — engine timing changes shift their animation phase
(a golden re-bless after visual check, not a regression).

## Games (in `scratchpad/games/`, gitignored)

| Game | Mode | Status |
|---|---|---|
| Cosmo's Cosmic Adventure | EGA 0Dh | ✅ renders (title screen) — verified |
| Commander Keen 1 | EGA 0Dh | ✅ renders (gameplay level) — verified |
| Commander Keen 4 | EGA 0Dh | ✅ renders (main menu) — verified |
| Bio Menace | EGA 0Dh | ✅ renders — verified |
| Major Stryker | VGA 13h | ✅ renders (Apogee title) — verified, needed the tier-2 PIT fix |
| Hocus Pocus | VGA 13h | ✅ renders — verified, needed the mid-slice PIT fix |
| Jill of the Jungle | VGA 13h | ✅ renders — verified |
| God of Thunder | VGA 13h | ✅ renders (IMPULSE intro) under tier-2 — needed the INT 10h AH=1Ah fix AND the tier-2 CLI-deadline fix (it hung under tier-2 running a hot loop with interrupts off) |
| Prince of Persia | EGA 0Dh | ▶ EGA — reached graphics in an earlier survey; not re-verified end-to-end |
| Monster Bash | EGA | ▶ not verified this session |
| QBasic | text/13h | ▶ renders its full IDE; keyboard keys don't yet surface to the app (see `qbasic_diagnosis` memory) |
| **Wolf3D** | VGA 13h | ⚠️ ISR-install derail FIXED (the `FF /6` operand-size bug, commit `0d7c2b3`) — now runs full startup, installs its INT 8/9/0Fh/24h ISRs, and loads all data. Next blocker: exits from its paged memory manager (`PML_GetPageBuffer: Purged main block`) — not rendering yet. See `wolf3d_diagnosis` memory. |
| Raptor | — | ❌ needs **DPMI/protected mode** (DOS/16M). Passes 386 detection now (after the `popf` fix). |
| Jazz Jackrabbit | — | ❌ needs **DPMI/protected mode**. |
| Halloween Harry | text | ❌ `HH1.EXE` is an 11 KB **launcher** (not the engine); exits code 255 after config I/O without setting a graphics mode. Needs the full install or a launcher-specific check. |

## Known engine gaps (the frontier)

1. ~~CGA graphics (modes 4/5/6)~~ — **DONE** (`video.js:_renderCGA`, 0x3D9 colour-select in
   `bios.js`). Verified: Alley Cat (mode 4) renders its title screen; `demos/CGA.COM` guards it
   in golden. B800 even/odd banks, 2bpp (4-colour) + mode-6 mono.
2. **DPMI / protected mode** — none. Blocks Raptor, Jazz, and anything using a DOS extender
   (DOS/16M, DOS4GW). This is the biggest single feature gap for early-90s VGA action games.
3. **EMS/XMS** — none. Some games probe for it; most degrade gracefully.
4. **Audio** — SB/OPL are detection stubs only (no synthesis). Fine for compatibility, silent.
5. **Wolf3D's ISR-install path** — a specific upstream control-flow divergence, not a device
   gap; the co-sim ([TESTING.md](TESTING.md)) is the tool to localize it.

## Fixes this frontier came from (session 2026-07-18/19)

- `push dword imm` decrementing SP by 2 not 4 → Wolf3D past its derail (co-sim).
- `popf`/`iret` 386 flag mask (0x7FD5) → Raptor/Halloween pass 386 detection (co-sim).
- Cycle-based **PIT timer** delivered mid-slice → Hocus renders; Cosmo/Stryker reach graphics.
- Tier-2 regions bail on `cpu.deadline` for a due tick → **Stryker** renders (+ tier-1==tier-2).
- Time-based **0x3DA beam**; joystick 0x201 → 0xF0; INT 10h **AH=1Ah** DCC → God of Thunder renders.
- Discovered the **EGA planar path already worked** (`vga.js`) — the earlier "stuck on planar"
  was a probe reading linear A000 instead of `vga.planes`.
