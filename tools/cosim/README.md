# MIRAGE ↔ Unicorn CPU co-sim

Finds MIRAGE CPU-emulation bugs by single-stepping MIRAGE and Unicorn (QEMU core) from an
identical snapshot and diffing registers/flow each instruction. Same initial state ⇒ only
genuine CPU differences surface (no need to match DOS/BIOS between the two). See the
`cosim_tool` memory for the method. Requires `pip3 install --user unicorn`.

These three scripts are a **template** (currently wired to Lemmings). To co-sim another game,
edit the game path/EXE/tail + the trigger in `mirage-cosim.mjs`.

    node tools/cosim/mirage-cosim.mjs   # run MIRAGE to the fault, snapshot a pure-CPU window
                                        # -> /tmp/cosim-snap.bin + /tmp/cosim-mirage-*.json
                                        # SNAPBACK=N env = how many instrs before the fault to snapshot
    python3 tools/cosim/uc-cosim.py     # replay the snapshot in Unicorn -> /tmp/cosim-uc-trace.json
    node tools/cosim/cosim-diff.mjs     # first register/flow divergence + the culprit instruction

Reg order MIRAGE reg[AX,CX,DX,BX,SP,BP,SI,DI]; seg[ES,CS,SS,DS,FS,GS]. The window must be
pure-CPU (Unicorn has no BIOS/DOS — it stops at INT boundaries). Unicorn's real-mode
single-step mishandles self-modified code (stale JIT cache) — a Unicorn-side fault on an
SMC'd byte is an artifact, not a MIRAGE bug (verify by comparing runtime opcode bytes).

## 2026-08-01 result — Lemmings (VGALEMMI /v) derail
MIRAGE matches Unicorn for the entire 266-instruction window up to the derail — **the CPU is
correct**. The game faithfully executes garbage (INT 3, then `PUSH AX; JMP 0x74F` into
un-decodable bytes) which BOTH emulators reproduce from the same RAM. So the derail is **not
a CPU bug**; the corruption is set up earlier (a device/DOS service returning/placing wrong
data, or the THG-cracked binary is genuinely broken). Not chased further.

## Boot-image variant (2026-08-08)

`mirage-cosim-boot.mjs` + `uc-cosim-boot.py` co-sim a **booted kernel** instead of a DOS program.
The original pair needs an INT-free window, and IO.SYS init has none longer than ~100 instructions —
it calls the BIOS constantly, and mostly by *inline far call* to f000:n rather than by INT, which the
`swInt`-only window detection did not even see. Three things make it work:

* Unicorn **vectors INT itself** (a UC_HOOK_INTR doing the 8086 sequence), so a guest ISR executes
  independently instead of raising an unhandled exception.
* Only the **f000 BIOS stubs are bridged** from the MIRAGE trace — both the `INT n`-with-BIOS-vector
  form and the arrive-in-f000 form, because MIRAGE retires each as a single step while Unicorn would
  vector or execute the stub and slip a step. Everything the guest itself runs stays independently
  verified, which is the point.
* **Granularity**: MIRAGE retires a whole `REP` string op as one step; Unicorn does one iteration.
  The Unicorn side runs a REP to completion so "one step" means the same thing on both.

`cosim-diff.mjs` also now ignores SF/ZF/AF/PF after MUL/IMUL/DIV/IDIV, where they are architecturally
**undefined**: MIRAGE matches real 8088 silicon (conformance is 100% on those vectors) and Unicorn
models a later CPU. Comparing them reports an artifact as a bug — the same trap as BCD in
`tools/x86-cases.mjs`.

### 2026-08-08 result — MS-DOS 6.22 boot
A 22 000-instruction window of IO.SYS init (388 bridged BIOS calls) shows **no divergence**: the CPU
is not the problem there. Widening to the whole init from instruction 0 runs into flag differences
after MUL that cascade — Unicorn-vs-8088 artifacts rather than bugs — so the derail in
`docs/COMPAT.md` is **still unexplained**. The tool is sound; the remaining artifacts are what to
tighten next if this is picked up again.

## 2026-08-19 — three harness defects fixed, and one limit that stands

Driving it at Mystic Towers exposed three ways the co-sim was not running the same guest as
everything else. All fixed:

- **It built its own machine** (1 MiB, no mouse, no ROM fonts) instead of going through
  `tools/harness.mjs`. Mystic ran 50 M instructions without terminating under it, where the real
  harness has it exit on a #DE after 0.16 M. Now uses `makeMachine`.
- **Pass A stepped instruction by instruction.** A hand-rolled `stepOne` loop is a different guest;
  pass A now runs the PRODUCTION path (`runSlice`) and reports the stop point in CYCLES.
- **Both passes called `tickTimer()` per slice.** The run loop owns the PIT, so calling it made the
  tick cadence depend on the SLICE SIZE — pass A (slices of 2000) and pass B (slices of 1 near the
  target) were two different runs and never met at the same cycle.

New: `STOPINT=<vector>` ends the window at a raised vector instead of a fault, for a guest that
handles what it raises (Mystic takes #DE into Turbo Pascal's error handler and exits 200). The
stopping vector is deliberately not counted as a service entry.

**The limit that stands: the traced window still uses `stepOne`, and under it the PIT never
advances.** For a short pure-CPU window that is the point — it is what makes MIRAGE and Unicorn
comparable. But a program whose next 42 instructions depend on a timer tick does not reach the same
place: Mystic's trace ran the full 2800-step budget without reaching its #DE. Lemmings and Turbo
Pascal were fine because their windows are genuinely pure CPU. **Before trusting a window, check that
the trace actually reaches the stop point** — "traced N steps, final fault=null" means it did not.
