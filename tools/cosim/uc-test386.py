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

# Restoring a ring-3 snapshot cannot be done by writing the registers: reg_write(CS) does NOT update
# the CPL Unicorn keeps in hflags, so the following reg_write(SS) with a DPL-3 stack selector is
# rejected outright (UC_ERR_EXCEPTION). CS is accepted, ES/DS/FS/GS are accepted; SS is the one that
# fails, and it fails for the right architectural reason.
#
# So enter ring 3 the only way the architecture allows: IRET from ring 0. The stack comes from the
# TSS (SS0/ESP0 at +8/+4), which is the very stack the CPU itself would have switched to, and the
# IRET opcode is an existing 0xCF byte found in the guest's own code segment — nothing is patched
# into guest memory. The trampoline instruction is not recorded in the trace.

def _desc_base(sel):
    if (sel & 0xfffc) == 0:
        return 0
    tbl = snap['ldtr'] if (sel & 4) else snap['gdtr']
    d = mem[tbl['base'] + (sel & 0xfff8):][:8]
    return d[2] | (d[3] << 8) | (d[4] << 16) | (d[7] << 24)


def _ring0_stack():
    """SS0:ESP0 from the TSS, as linear address. The frame must be written at SS0.base + ESP0, not at
    ESP0: assuming a zero stack base put the IRET frame somewhere the IRET never read, so it popped
    garbage and landed at an unrelated address instead of the snapshot's EIP."""
    tb = snap['tr']['base']
    esp0 = int.from_bytes(mem[tb + 4:tb + 8], 'little')
    ss0 = int.from_bytes(mem[tb + 8:tb + 10], 'little')
    return ss0, esp0, (_desc_base(ss0) + esp0) & 0xffffffff

stale = []                          # segment indices Unicorn could not restore
trampoline = None
K_CS, K_SS = 0xd0, 0x118            # test386's ring-0 code/stack selectors
cpl0 = snap['seg'][1] & 3
if cpl0 != 0:
    K_SS, esp0, stack_lin = _ring0_stack()
    cs_b = snap['base'][1]
    iret_off = None
    for off in range(0x10000):       # any IRETD already in the ring-0 code segment will do
        if mem[(cs_b + off) & 0xffffff] == 0xcf:
            iret_off = off
            break
    if iret_off is None:
        raise SystemExit('aucun octet IRETD (0xCF) trouve dans le segment de code')
    frame = b''.join(x.to_bytes(4, 'little') for x in (
        snap['eip'] & 0xffffffff, snap['seg'][1] & 0xffff, snap['flags'] & 0xffffffff,
        snap['reg'][4] & 0xffffffff, snap['seg'][2] & 0xffff))
    uc.reg_write(SEGR[1], K_CS)
    uc.reg_write(SEGR[2], K_SS)
    uc.mem_write(stack_lin - 20, frame)
    uc.reg_write(UC_X86_REG_ESP, esp0 - 20)
    for i in (0, 3, 4, 5):
        sel = snap['seg'][i] & 0xffff
        if (sel & 0xfffc) or i < 4:
            uc.reg_write(SEGR[i], sel)
    trampoline = iret_off
    print(f'  entree en anneau {cpl0} via IRET a {K_CS:#06x}:{iret_off:#x} '
          f'(TSS stack {K_SS:#06x}:{esp0:#x}, linear {stack_lin:#x})')
else:
    # A segment register can legitimately hold a selector that no longer resolves: the descriptor
    # CACHE keeps whatever was loaded last, so after a real-to-protected switch FS/GS still carry
    # real-mode values (selector 0x2000, base 0x20000 = 0x2000<<4) that index far past the GDT limit.
    # MIRAGE reproduces that faithfully; Unicorn cannot, because writing a selector makes it walk the
    # GDT. Report what could not be restored instead of dying — and treat any divergence involving
    # those registers as a harness artefact.
    for i, r in enumerate(SEGR):
        try:
            uc.reg_write(r, snap['seg'][i] & 0xffff)
        except UcError:
            stale.append(i)
    if stale:
        print('  caches de segment non restaurables (selecteurs herites du mode reel): '
              + ', '.join(f"{['ES', 'CS', 'SS', 'DS', 'FS', 'GS'][i]}=0x{snap['seg'][i]:04x}"
                          for i in stale))

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
executed = [0]
skip_tramp = [trampoline is not None]
EXEC_CAP = 4_000_000        # a self-loop must not run forever; far above any honest replay

def on_code(uc_, address, size, user):
    global cs_sel, cs_base
    # Two independent stops, both BEFORE the same-PC collapse below. Recorded steps alone are not a
    # bound: a one-instruction self-loop (test386's `error:` routine is `jnz $`) is collapsed, so the
    # trace stops growing while the run continues forever. Executed instructions always advance.
    executed[0] += 1
    if len(trace) >= len(mtrace) or executed[0] > EXEC_CAP:
        uc_.emu_stop()
        return
    if skip_tramp[0]:
        skip_tramp[0] = False
        return
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
    """Load MIRAGE's state at trace index i into Unicorn, and return the EIP to restart at.

    Uses the same IRET trampoline as the initial restore whenever the target runs at CPL > 0. Writing
    the registers directly does not work there (reg_write(SS) with a DPL-3 selector is rejected) and,
    worse, would leave Unicorn's cached CPL at whatever it was — which silently disabled its
    privilege checks and made it skip faults MIRAGE correctly took."""
    global cs_sel, cs_base
    m = mtrace[i]
    for r, v in zip(GP, m['r']):
        uc.reg_write(r, v & 0xffffffff)
    uc.reg_write(UC_X86_REG_EFLAGS, m['f'] & 0xffffffff)
    uc.mem_write(m['stkAt'], bytes(m['stk']))
    cs_sel, cs_base = m['cs'], m['b'][1]
    last_pc[0] = None

    if (m['cs'] & 3) == 0:
        for k, r in enumerate(SEGR):
            uc.reg_write(r, m['s'][k] & 0xffff)
        return m['eip']

    _, esp0, stack_lin = _ring0_stack()
    frame = b''.join(x.to_bytes(4, 'little') for x in (
        m['eip'] & 0xffffffff, m['cs'] & 0xffff, m['f'] & 0xffffffff,
        m['r'][4] & 0xffffffff, m['s'][2] & 0xffff))
    uc.reg_write(SEGR[1], K_CS)
    uc.reg_write(SEGR[2], K_SS)
    uc.mem_write(stack_lin - 20, frame)
    uc.reg_write(UC_X86_REG_ESP, esp0 - 20)
    for k in (0, 3, 4, 5):
        uc.reg_write(SEGR[k], m['s'][k] & 0xffff)
    skip_tramp[0] = True
    return trampoline

resyncs = []
start_eip = trampoline if trampoline is not None else (snap['eip'] & 0xffffffff)
while len(trace) < len(mtrace):
    faulted[0] = False
    try:
        uc.emu_start(start_eip, 0, 0, 0)   # unbounded; the code hook stops at len(mtrace)
    except UcError as e:
        err = f'{e} after {len(trace)} steps'
        break
    if not faulted[0] or len(trace) >= len(mtrace):
        break
    i = len(trace)                     # MIRAGE's next step is the handler's first instruction
    try:
        start_eip = resync(i)
    except UcError as e:
        # Unicorn's reg_write cannot move between rings in either direction (a ring-3 SS is refused
        # at CPL 0, a ring-0 CS is refused at CPL 3), so a resync across a privilege change is not
        # reachable through this API. Stop cleanly and say so: the window simply ends here, and the
        # answer is to pick a SKIP window that contains no exception rather than to bridge one.
        err = f'resync impossible au pas {i} (changement d anneau): {e}'
        break
    resyncs.append(i)

for (n, cs, eip, cr2, at) in seen_intr[:6]:
    name = {0: '#DE', 6: '#UD', 8: '#DF', 10: '#TS', 11: '#NP', 12: '#SS', 13: '#GP', 14: '#PF'}.get(n, f'vecteur {n}')
    print(f'  exception {name} (0x{n:x}) au pas {at}, cs=0x{cs:x} eip=0x{eip:x} cr2=0x{cr2:x}'
          '  -> resync depuis MIRAGE')
if len(seen_intr) > 6:
    print(f'  ... et {len(seen_intr) - 6} autres exceptions')
json.dump({'trace': trace, 'err': err, 'stale': stale}, open(OUT, 'w'))
print(f'unicorn: {len(trace)} steps -> {OUT}' + (f'   stopped: {err}' if err else ''))
