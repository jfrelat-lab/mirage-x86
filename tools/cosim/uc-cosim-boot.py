# uc-cosim-boot.py — Unicorn side of the co-sim for a booted kernel, where a pure-CPU window does
# not exist. IO.SYS calls the BIOS constantly, and mostly by *inline far call* to f000:n rather than
# by INT — which is why the plain harness found only ~50-100 instruction windows and then diverged on
# the first BIOS entry, Unicorn having no BIOS.
#
# The fix is to stop pretending Unicorn can service them: whenever execution arrives in the BIOS stub
# segment, adopt MIRAGE's post-state for that step from its trace and carry on. Every instruction
# BETWEEN BIOS calls is still executed independently by Unicorn, so a register divergence anywhere
# else is a genuine CPU difference — which is the thing we are hunting. The BIOS calls themselves are
# not verified here; the DOS/VGA oracles cover that ground separately.
#
#   node tools/cosim/mirage-cosim-boot.mjs && python3 tools/cosim/uc-cosim-boot.py && node tools/cosim/cosim-diff.mjs

import json
from unicorn import *
from unicorn.x86_const import *

RAM = open('/tmp/cosim-snap.bin', 'rb').read()
snap = json.load(open('/tmp/cosim-mirage-snap.json'))
M = json.load(open('/tmp/cosim-mirage-trace.json'))
reg = snap['reg']; seg = snap['seg']
BIOS_SEG = 0xf000

uc = Uc(UC_ARCH_X86, UC_MODE_16)
uc.mem_map(0, 0x110000)
uc.mem_write(0, RAM)

R = [UC_X86_REG_AX, UC_X86_REG_CX, UC_X86_REG_DX, UC_X86_REG_BX,
     UC_X86_REG_SP, UC_X86_REG_BP, UC_X86_REG_SI, UC_X86_REG_DI]
for i, r in enumerate(R):
    uc.reg_write(r, reg[i] & 0xffff)
for r, v in [(UC_X86_REG_ES, seg[0]), (UC_X86_REG_CS, seg[1]), (UC_X86_REG_SS, seg[2]),
             (UC_X86_REG_DS, seg[3]), (UC_X86_REG_FS, seg[4]), (UC_X86_REG_GS, seg[5])]:
    uc.reg_write(r, v)
uc.reg_write(UC_X86_REG_EFLAGS, snap['flags'] & 0xffff)
uc.reg_write(UC_X86_REG_IP, snap['eip'] & 0xffff)

# Unicorn does not vector INT in real mode by itself — it raises an unhandled exception. Do the
# 8086 sequence here (push FLAGS/CS/IP, clear IF+TF, load CS:IP from the IVT) so a guest ISR runs
# in Unicorn exactly as it does in MIRAGE. Only the f000 BIOS stubs are bridged from the trace;
# everything the guest itself executes stays independently verified, which is the whole point.
def intr_hook(u, intno, ud):
    fl = u.reg_read(UC_X86_REG_EFLAGS)
    cs = u.reg_read(UC_X86_REG_CS)
    ip = u.reg_read(UC_X86_REG_IP)
    sp = u.reg_read(UC_X86_REG_SP)
    ss = u.reg_read(UC_X86_REG_SS)
    def push(v):
        nonlocal sp
        sp = (sp - 2) & 0xffff
        u.mem_write((ss << 4) + sp, bytes([v & 0xff, (v >> 8) & 0xff]))
    push(fl); push(cs); push(ip)
    u.reg_write(UC_X86_REG_SP, sp)
    u.reg_write(UC_X86_REG_EFLAGS, fl & ~0x300)          # clear IF and TF
    vec = u.mem_read(intno * 4, 4)
    u.reg_write(UC_X86_REG_IP, vec[0] | (vec[1] << 8))
    u.reg_write(UC_X86_REG_CS, vec[2] | (vec[3] << 8))
uc.hook_add(UC_HOOK_INTR, intr_hook)

uc.hook_add(UC_HOOK_INSN, lambda u, p, s, d: 0xff, None, 1, 0, UC_X86_INS_IN)
uc.hook_add(UC_HOOK_INSN, lambda u, p, s, v, d: None, None, 1, 0, UC_X86_INS_OUT)

def rd():
    return dict(cs=uc.reg_read(UC_X86_REG_CS), ip=uc.reg_read(UC_X86_REG_IP),
                ax=uc.reg_read(UC_X86_REG_AX) & 0xffff, cx=uc.reg_read(UC_X86_REG_CX) & 0xffff,
                dx=uc.reg_read(UC_X86_REG_DX) & 0xffff, bx=uc.reg_read(UC_X86_REG_BX) & 0xffff,
                sp=uc.reg_read(UC_X86_REG_SP) & 0xffff, bp=uc.reg_read(UC_X86_REG_BP) & 0xffff,
                si=uc.reg_read(UC_X86_REG_SI) & 0xffff, di=uc.reg_read(UC_X86_REG_DI) & 0xffff,
                es=uc.reg_read(UC_X86_REG_ES), ss=uc.reg_read(UC_X86_REG_SS),
                ds=uc.reg_read(UC_X86_REG_DS), fl=uc.reg_read(UC_X86_REG_EFLAGS) & 0xffff)

def adopt(m):
    """Take MIRAGE's state wholesale — used only for the BIOS-serviced steps."""
    for i, k in enumerate(['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di']):
        uc.reg_write(R[i], m[k])
    for r, k in [(UC_X86_REG_ES, 'es'), (UC_X86_REG_CS, 'cs'), (UC_X86_REG_SS, 'ss'), (UC_X86_REG_DS, 'ds')]:
        uc.reg_write(r, m[k])
    uc.reg_write(UC_X86_REG_EFLAGS, m['fl'])
    uc.reg_write(UC_X86_REG_IP, m['ip'])

def is_bios_int(cs, ip):
    b = uc.mem_read(((cs << 4) + ip) & 0xfffff, 2)
    if b[0] != 0xcd:
        return False
    vec = uc.mem_read(b[1] * 4, 4)
    return (vec[2] | (vec[3] << 8)) == BIOS_SEG

PREFIXES = (0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0)
def is_rep(cs, ip):
    b = uc.mem_read(((cs << 4) + ip) & 0xfffff, 8)
    i = 0
    while i < 6 and b[i] in PREFIXES:
        i += 1
    return b[i] in (0xf2, 0xf3)

trace = []
bridged = 0
for step in range(len(M)):
    st = rd()
    trace.append(st)
    # Two ways a BIOS service is reached, and MIRAGE retires BOTH as a single step:
    #   `INT n` whose vector still points at f000 — swInt runs the JS handler and execution simply
    #     continues past the CD nn, with no IRET frame ever pushed;
    #   an inline far call that lands in the f000 stub segment — biosCallback runs the handler and
    #     pops the frame the guest pushed.
    # Unicorn would faithfully vector the first and execute the stub for the second, so its trace
    # would slip a step and everything after would read as a divergence. Bridge both.
    if st['cs'] == BIOS_SEG or is_bios_int(st['cs'], st['ip']):
        nxt = M[step + 1] if step + 1 < len(M) else None
        if nxt is None or 'FAULT' in nxt:
            break
        # Re-sync memory too: a BIOS handler writes to RAM (the BDA, a disk buffer) and Unicorn
        # cannot know what. Without this the next instructions read stale data and diverge for a
        # reason that is not the CPU.
        adopt(nxt)
        bridged += 1
        continue
    try:
        # Granularity: MIRAGE retires a whole REP string op as ONE step, Unicorn does one iteration
        # per step. Without this the traces desynchronise on the first `rep movsb` — which in a boot
        # image is the boot sector relocating itself, i.e. instruction 17. Run the REP to completion
        # so both sides mean the same thing by "one step".
        if is_rep(st['cs'], st['ip']):
            for _ in range(200000):
                uc.emu_start((uc.reg_read(UC_X86_REG_CS) << 4) + uc.reg_read(UC_X86_REG_IP), 0, 0, 1)
                if uc.reg_read(UC_X86_REG_IP) != st['ip']:
                    break
        else:
            uc.emu_start((st['cs'] << 4) + st['ip'], 0, 0, 1)
    except UcError as e:
        trace.append({'FAULT': str(e), 'at_cs': st['cs'], 'at_ip': st['ip']})
        break

json.dump(trace, open('/tmp/cosim-uc-trace.json', 'w'))
print(f'unicorn: traced {len(trace)} steps, {bridged} BIOS calls bridged from the MIRAGE trace')
