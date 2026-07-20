# MIRAGE — Docs

Architecture and internals reference. Start with **[ARCHITECTURE.md](ARCHITECTURE.md)**.

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the big picture: the execution model, file map, CPU
  and memory layout, the run loop, the interrupt model, the two execution tiers. Read first.
- **[RECOMPILER.md](RECOMPILER.md)** — the dynarec (`recompiler.js`): block emission, the cache,
  flag handling (dead-flag elimination, inlined `cond`), inlined memory/FPU/mul fast paths, SMC,
  and the tier-2 region compiler (promotion, `cpu.deadline` safepoints, eviction).
- **[DEVICES.md](DEVICES.md)** — BIOS/DOS/video/timer/input: the INT + I/O-port buses, INT 10h/21h,
  the EGA/VGA planar device, the cycle-based PIT timer, the 0x3DA beam, keyboard/joystick, sound
  stubs, and the full port map.
- **[TESTING.md](TESTING.md)** — the gates (unit, conformance, golden, region/flag fuzzers, bench,
  DOSBox diff), the golden fingerprint mechanism, the CPU co-sim, and what "verify a change" means.
- **[COMPAT.md](COMPAT.md)** — what runs today and what's blocked (games + demos), the known
  rough edges, the engine gaps (DPMI, EMS/XMS, audio, Mode X), and the fixes that got us here.
- **[ROADMAP.md](ROADMAP.md)** — a menu of candidate next tasks grouped by theme (correctness,
  compatibility features, content, performance, tooling) with effort/value, to choose what's next.

These are written to survive between sessions — keep them in step with the code when you change
the design (especially the run loop, the region compiler, the device model, or the gates).
