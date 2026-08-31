# uc-capture.py — run the x86 cases in Unicorn (QEMU's TCG core) and emit the expected end state.
# Unicorn is the oracle for the 386 instruction semantics that our other gates cannot reach:
# conformance.js is real-8088 silicon but 16-bit-only, and golden.js only hashes framebuffers.
#
# Driven by tools/test-x86-uc.mjs --capture, which hands us cases.json and reads back expected.json.
# The result is committed, so the gate itself runs with neither Python nor Unicorn installed.

import json, sys
from unicorn import *
from unicorn.x86_const import *

CS, DS, SS = 0x1000, 0x2000, 0x3000
CODE, DATA, STACK = CS << 4, DS << 4, SS << 4
SCRATCH = 256
FLAGMASK = 0x8d5                      # CF PF AF ZF SF OF

GP = [('eax', UC_X86_REG_EAX), ('ecx', UC_X86_REG_ECX), ('edx', UC_X86_REG_EDX), ('ebx', UC_X86_REG_EBX),
      ('esp', UC_X86_REG_ESP), ('ebp', UC_X86_REG_EBP), ('esi', UC_X86_REG_ESI), ('edi', UC_X86_REG_EDI)]

def pattern(i): return (i * 7 + 3) & 0xff

def run(case):
    uc = Uc(UC_ARCH_X86, UC_MODE_16)
    uc.mem_map(0, 0x100000)
    # SSE is #UD unless the OS has enabled it: CR0.EM clear, CR0.MP set, CR4.OSFXSR set. Without this
    # every XMM case comes back as {'error': ...} — which the gate SKIPS, so they would all "pass"
    # without ever running. Verified inert for the pre-SSE cases: re-capturing with these three bits
    # set reproduced the committed expectations byte for byte.
    uc.reg_write(UC_X86_REG_CR0, (uc.reg_read(UC_X86_REG_CR0) & ~0x4) | 0x2)
    uc.reg_write(UC_X86_REG_CR4, uc.reg_read(UC_X86_REG_CR4) | (1 << 9))
    # deterministic scratch at DS:0, code at CS:0
    uc.mem_write(DATA, bytes(pattern(i) for i in range(SCRATCH)))
    code = bytes(case['code'])
    uc.mem_write(CODE, code)

    uc.reg_write(UC_X86_REG_CS, CS); uc.reg_write(UC_X86_REG_DS, DS)
    uc.reg_write(UC_X86_REG_ES, DS); uc.reg_write(UC_X86_REG_SS, SS)
    for name, reg in GP:
        uc.reg_write(reg, case.get('regs', {}).get(name, 0))
    if 'esp' not in case.get('regs', {}):
        uc.reg_write(UC_X86_REG_ESP, 0x1000)
    # bit 1 is always set in FLAGS; add whatever the case seeds (e.g. CF/AF for BCD)
    uc.reg_write(UC_X86_REG_EFLAGS, 0x2 | case.get('flags', 0))
    uc.reg_write(UC_X86_REG_IP, 0)

    # Bound the run: sequences may loop (LOOP / DEC+JNZ), and an unterminated one must not hang the
    # capture. 4096 instructions is far above any case here; the MIRAGE side has its own guard.
    try:
        uc.emu_start(CODE, CODE + len(code), 0, 4096)
    except UcError as e:
        return {'error': str(e)}
    if uc.reg_read(UC_X86_REG_IP) != len(code):
        return {'error': f'did not reach the end (IP={uc.reg_read(UC_X86_REG_IP):#x})'}

    out = {'regs': {name: uc.reg_read(reg) & 0xffffffff for name, reg in GP},
           'flags': uc.reg_read(UC_X86_REG_EFLAGS) & FLAGMASK,
           'mem': list(uc.mem_read(DATA, SCRATCH))}
    return out

cases = json.load(open(sys.argv[1]))
json.dump([run(c) for c in cases], open(sys.argv[2], 'w'))
print(f'unicorn: captured {len(cases)} cases')
