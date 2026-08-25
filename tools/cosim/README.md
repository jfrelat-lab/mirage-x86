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

## Stopping somewhere other than a fault (2026-08-22)

A program that produces the WRONG OUTPUT never faults, so the fault and `STOPINT` triggers have
nothing to catch. `STOPTICK` + `STOPAT` + `HITS` stop at an ADDRESS instead: coarse slices until the
BIOS tick counter reaches `STOPTICK`, then one block at a time until `CS:IP` matches `STOPAT` for the
`HITS`-th time.

    GAME=DUNE EXE=DUNEDEM.EXE TAIL=" ENG VGA ADL HIM 386" \
      STOPTICK=3950 STOPAT=23a2:afa HITS=20 SNAPBACK=4000 node tools/cosim/mirage-cosim.mjs

⚠️ `TAIL` needs its **leading space**, as DOS puts in the PSP. Without it Dune got a different command
line, took a different path and derailed — a co-sim of a program behaving differently answers nothing.

## Three artifacts that are the TOOL's, not the guest's

Each of these reported a "first divergence" that was not one:

- **Undefined flags PROPAGATE.** The shift and rotate groups leave AF undefined, as MUL/DIV do. The
  diff already masked the defining instruction, but the difference stays in the flags register for
  every step afterwards — so it reported the NEXT instruction instead, a `jz`, which writes no flags
  at all. AF is now dropped from the comparison for good once something leaves it undefined.
- **`REP` is one step here and CX steps there.** MIRAGE's emitted block runs the whole repeat;
  Unicorn single-steps each iteration. Index-for-index comparison therefore reports "CS:IP differ" at
  the first `rep movsw` — which is to say immediately, in any decompressor. `cosim-diff.mjs`
  resynchronises across them, and `UCSTEPS` raises Unicorn's budget (string-heavy code needs far more
  steps on that side: 13,263 absorbed in the Dune window).
- **Port I/O ends the window.** Unicorn has no VGA, so `in al,0x3da` returns 0xFF there and a real
  beam status here. That is the same "must be pure-CPU" caveat as INT boundaries.

## 2026-08-22 result — Dune (Cryo) draws a scrambled picture

Two windows over the decompressor, ~5000 instructions in total: **no CPU divergence at all.** The
first ended cleanly, the second at the `in al,0x3da` above. Combined with `dbx-oracle` reporting no
divergence from dosbox-x on any channel, and the palette being correct, the CPU and the DOS layer are
both exonerated for this bug.

What that leaves is **timing**: Dune polls 0x3DA and is timer-paced (it reprograms PIT counter 0 to
~200 Hz), and a wrong beam would place writes at wrong moments — which is what horizontal streaking
over a correct palette looks like. That is the next hypothesis, and it is testable against the
0x3DA model rather than against the CPU.

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
