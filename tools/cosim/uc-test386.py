#!/usr/bin/env python3
"""Unicorn side of the test386 protected-mode co-sim.

Replays /tmp/t386-snap.bin + the snapshot state recorded by test386-cosim.mjs, single-stepping the
same number of instructions and writing /tmp/t386-uc.json in the same shape. cosim-diff.mjs then
reports the first instruction where the two disagree.

The whole point is that Unicorn is QEMU's core and PASSES this test, so any disagreement is ours.
Restoring protected mode faithfully is what makes the comparison meaningful: GDTR/IDTR/LDTR/TR, CR0
(PE and PG) and CR3 all come from the snapshot, and the page tables live in the snapshotted RAM, so
Unicorn resolves selectors and linear addresses against exactly the same world MIRAGE did.

    python3 tools/cosim/uc-test386.py
"""
import json, struct
from unicorn import *
from unicorn.x86_const import *

SNAP = '/tmp/t386-snap.bin'
MIR = '/tmp/t386-mirage.json'
OUT = '/tmp/t386-uc.json'
MEM = 16 << 20

with open(MIR) as f:
    mir = json.load(f)
snap, ports, mtrace = mir['snap'], mir['ports'], mir['trace']
mem = open(SNAP, 'rb').read()

uc = Uc(UC_ARCH_X86, UC_MODE_32)
uc.mem_map(0, MEM)
uc.mem_write(0, mem)

# General registers, in MIRAGE's order: AX CX DX BX SP BP SI DI.
for r, v in zip([UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX,
                 UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI], snap['reg']):
    uc.reg_write(r, v & 0xffffffff)
uc.reg_write(UC_X86_REG_EFLAGS, snap['flags'] & 0xffffffff)

# Descriptor tables BEFORE the segment registers: loading a selector makes Unicorn read its
# descriptor, which must come from the same GDT/LDT MIRAGE used.
uc.reg_write(UC_X86_REG_GDTR, (0, snap['gdtr']['base'], snap['gdtr']['limit'], 0))
uc.reg_write(UC_X86_REG_IDTR, (0, snap['idtr']['base'], snap['idtr']['limit'], 0))
uc.reg_write(UC_X86_REG_CR3, snap['cr3'] & 0xffffffff)
uc.reg_write(UC_X86_REG_CR0, snap['cr0'] & 0xffffffff)
# LDTR/TR need their descriptor FLAGS, not just base+limit. Unicorn stores this word exactly as the
# descriptor's second dword, and QEMU reads the TSS type out of it: a far call through a call gate
# that switches stacks runs get_ss_esp_from_tss, which calls cpu_abort() — a hard SIGABRT, not a
# guest exception — when (type & 7) != 1. Passing 0 here made every stack-switching call gate abort
# the whole process, which is exactly the instruction POST 20 exercises.
def _desc_flags(sel):
    if (sel & 0xfffc) == 0:
        return 0
    tbl = snap['ldtr'] if (sel & 4) else snap['gdtr']
    a = tbl['base'] + (sel & 0xfff8)
    return int.from_bytes(mem[a:a + 8][4:8], 'little')

uc.reg_write(UC_X86_REG_LDTR, (snap['ldtr']['sel'], snap['ldtr']['base'], snap['ldtr']['limit'],
                               _desc_flags(snap['ldtr']['sel'])))
uc.reg_write(UC_X86_REG_TR, (snap['tr']['sel'], snap['tr']['base'], snap['tr']['limit'],
                             _desc_flags(snap['tr']['sel'])))

# Segment registers, MIRAGE order ES CS SS DS FS GS. This Unicorn takes a plain selector here and
# walks the descriptor itself — which is fine, and in fact better: it re-derives base/limit from the
# same GDT/LDT bytes, so a disagreement about a descriptor shows up as a disagreement, not as
# something we papered over by forcing our own cached values in.
SEGR = [UC_X86_REG_ES, UC_X86_REG_CS, UC_X86_REG_SS, UC_X86_REG_DS, UC_X86_REG_FS, UC_X86_REG_GS]
for i, r in enumerate(SEGR):
    uc.reg_write(r, snap['seg'][i] & 0xffff)

# Ports: replay exactly what MIRAGE returned, in order. Anything unrecorded reads 0xFF, as the
# open bus does on both sides.
port_reads = list(ports)
def on_in(uc_, port, size, user):
    for i, p in enumerate(port_reads):
        if p['p'] == port and p['s'] == size:
            return port_reads.pop(i)['v']
    return 0xffffffff >> (8 * (4 - size))
def on_out(uc_, port, size, value, user):
    return
uc.hook_add(UC_HOOK_INSN, on_in, None, 1, 0, UC_X86_INS_IN)
uc.hook_add(UC_HOOK_INSN, on_out, None, 1, 0, UC_X86_INS_OUT)

# Which exception, not just "an exception" — an unhandled-exception message with no vector is
# exactly the kind of dead end that costs hours.
seen_intr = []          # the handler itself is installed further down, with resync

trace, err = [], None
GP = [UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX,
      UC_X86_REG_ESP, UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI]

def desc_base(sel):
    """Base of a selector, read from the snapshotted GDT/LDT — Unicorn hands back only the selector,
    so the linear address emu_start needs has to be recomputed here."""
    if (sel & 0xfffc) == 0:
        return 0
    tbl = snap['ldtr'] if (sel & 4) else snap['gdtr']
    a = (tbl['base'] + (sel & 0xfff8)) & 0xffffffff
    d = uc.mem_read(a, 8)
    return d[2] | (d[3] << 8) | (d[4] << 16) | (d[7] << 24)

# Trace with a CODE hook and ONE emu_start, not a per-instruction emu_start loop.
#
# The loop version is a trap: emu_start(x) starts at linear CS.base+x, but on exit Unicorn writes the
# LINEAR pc back into EIP. Feeding that back in as the next offset re-adds the base every step, so EIP
# marched off by 0xF0000 per instruction while no instruction ever retired. A code hook sees the
# architectural state at each instruction and sidesteps the writeback entirely — and it runs far faster.
cs_base = snap['base'][1]
cs_sel = snap['seg'][1]

# QEMU re-enters the hook once per REP ITERATION, at the same PC, while MIRAGE retires the whole
# string operation as one traced step. Left alone that shows up as a fat "divergence" at every rep
# stos/movs, with ECX and EDI mid-loop. Collapsing consecutive same-PC entries to the first puts both
# traces on the same granularity. (A one-instruction self-loop such as `jmp $` also collapses; it is
# one instruction either way, so nothing real is lost.)
last_pc = [None]

def on_code(uc_, address, size, user):
    global cs_sel, cs_base
    if last_pc[0] == address:
        return
    last_pc[0] = address
    cs = uc_.reg_read(UC_X86_REG_CS)
    if cs != cs_sel:                       # CS changed: its base did too
        cs_sel, cs_base = cs, desc_base(cs)
    trace.append({
        'cs': cs, 'eip': (address - cs_base) & 0xffffffff,   # hook gives a LINEAR address
        'r': [uc_.reg_read(r) for r in GP],
        'f': uc_.reg_read(UC_X86_REG_EFLAGS),
        's': [uc_.reg_read(r) for r in SEGR],
    })
uc.hook_add(UC_HOOK_CODE, on_code)

# Unicorn STOPS on a guest exception — it has no path that walks the IDT, pushes a frame and enters
# the handler. test386 is exception-driven from POST 20 onward, so a co-sim that ends at the first
# fault ends before the interesting part.
#
# So: at each fault, resynchronise Unicorn from MIRAGE's state one step later (registers, segments,
# EFLAGS, and the stack window carrying the exception frame) and carry on. This is an EXPLICIT blind
# spot — exception DELIVERY itself is taken from MIRAGE and therefore not checked at those points —
# but everything the handler then executes is compared again, which is what we came for.
faulted = [False]

def on_intr(uc_, intno, user):
    seen_intr.append((intno, uc_.reg_read(UC_X86_REG_CS), uc_.reg_read(UC_X86_REG_EIP),
                      uc_.reg_read(UC_X86_REG_CR2), len(trace)))
    faulted[0] = True
    uc_.emu_stop()

uc.hook_add(UC_HOOK_INTR, on_intr)

def resync(i):
    """Load MIRAGE's state at trace index i into Unicorn, in place.

    KNOWN LIMIT: this patches registers but cannot reset QEMU's derived state — notably the CPL held
    in hflags, which reg_write(CS) does not necessarily recompute. The visible symptom is that after
    a resync Unicorn stops enforcing CPL-sensitive checks, so an IN/OUT that the architecture denies
    can slip through on its side. Rebuilding a fresh Uc instead was tried and does not work: Unicorn
    rejects reg_write(CS) with a ring-3 selector (only a far transfer may load CS), and the mmr tuple
    form that bypasses the checks exists only for GDTR/IDTR/LDTR/TR.

    Consequence for reading a diff: a divergence where UNICORN skips a privilege fault that MIRAGE
    takes is suspect AFTER the first resync — check the architecture before believing it."""
    global cs_sel, cs_base
    m = mtrace[i]
    for r, v in zip(GP, m['r']):
        uc.reg_write(r, v & 0xffffffff)
    uc.reg_write(UC_X86_REG_EFLAGS, m['f'] & 0xffffffff)
    for k, r in enumerate(SEGR):
        uc.reg_write(r, m['s'][k] & 0xffff)
    uc.mem_write(m['stkAt'], bytes(m['stk']))
    cs_sel, cs_base = m['cs'], m['b'][1]
    last_pc[0] = None
    return m['eip']

resyncs = []
start_eip = snap['eip'] & 0xffffffff
while len(trace) < len(mtrace):
    faulted[0] = False
    try:
        uc.emu_start(start_eip, 0, 0, len(mtrace) - len(trace))
    except UcError as e:
        err = f'{e} after {len(trace)} steps'
        break
    if not faulted[0] or len(trace) >= len(mtrace):
        break
    i = len(trace)                     # MIRAGE's next step is the handler's first instruction
    resyncs.append(i)
    start_eip = resync(i)

for (n, cs, eip, cr2, at) in seen_intr[:6]:
    name = {0: '#DE', 6: '#UD', 8: '#DF', 10: '#TS', 11: '#NP', 12: '#SS', 13: '#GP', 14: '#PF'}.get(n, f'vecteur {n}')
    print(f'  exception {name} (0x{n:x}) au pas {at}, cs=0x{cs:x} eip=0x{eip:x} cr2=0x{cr2:x}'
          '  -> resync depuis MIRAGE')
if len(seen_intr) > 6:
    print(f'  ... et {len(seen_intr) - 6} autres exceptions')
json.dump({'trace': trace, 'err': err}, open(OUT, 'w'))
print(f'unicorn: {len(trace)} steps -> {OUT}' + (f'   stopped: {err}' if err else ''))
