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
