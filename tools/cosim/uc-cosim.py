# Unicorn reference for the Lemmings co-sim: load MIRAGE's snapshot, single-step, log registers.
import json, struct
from unicorn import *
from unicorn.x86_const import *

RAM = open('/tmp/cosim-snap.bin','rb').read()
snap = json.load(open('/tmp/cosim-mirage-snap.json'))
reg = snap['reg']; seg = snap['seg']   # reg[AX,CX,DX,BX,SP,BP,SI,DI] ; seg[ES,CS,SS,DS,FS,GS]

uc = Uc(UC_ARCH_X86, UC_MODE_16)
uc.mem_map(0, 0x110000)                 # 1 MiB + a bit (HMA wrap area)
uc.mem_write(0, RAM)

# GP regs (16-bit)
uc.reg_write(UC_X86_REG_AX, reg[0]&0xffff); uc.reg_write(UC_X86_REG_CX, reg[1]&0xffff)
uc.reg_write(UC_X86_REG_DX, reg[2]&0xffff); uc.reg_write(UC_X86_REG_BX, reg[3]&0xffff)
uc.reg_write(UC_X86_REG_SP, reg[4]&0xffff); uc.reg_write(UC_X86_REG_BP, reg[5]&0xffff)
uc.reg_write(UC_X86_REG_SI, reg[6]&0xffff); uc.reg_write(UC_X86_REG_DI, reg[7]&0xffff)
# segments (Unicorn real-mode sets base=sel<<4 on write)
uc.reg_write(UC_X86_REG_ES, seg[0]); uc.reg_write(UC_X86_REG_CS, seg[1])
uc.reg_write(UC_X86_REG_SS, seg[2]); uc.reg_write(UC_X86_REG_DS, seg[3])
uc.reg_write(UC_X86_REG_FS, seg[4]); uc.reg_write(UC_X86_REG_GS, seg[5])
uc.reg_write(UC_X86_REG_EFLAGS, snap['flags'] & 0xffff)
uc.reg_write(UC_X86_REG_IP, snap['eip'] & 0xffff)

# port hooks: 0x60 -> Enter scancode, else 0xff
def in_hook(uc, port, size, ud):
    return 0x1c if port==0x60 else 0xff
uc.hook_add(UC_HOOK_INSN, in_hook, None, 1, 0, UC_X86_INS_IN)
def out_hook(uc, port, size, value, ud): pass
uc.hook_add(UC_HOOK_INSN, out_hook, None, 1, 0, UC_X86_INS_OUT)

def rd():
    cs=uc.reg_read(UC_X86_REG_CS); ip=uc.reg_read(UC_X86_REG_IP)
    return dict(cs=cs, ip=ip,
        ax=uc.reg_read(UC_X86_REG_AX)&0xffff, cx=uc.reg_read(UC_X86_REG_CX)&0xffff,
        dx=uc.reg_read(UC_X86_REG_DX)&0xffff, bx=uc.reg_read(UC_X86_REG_BX)&0xffff,
        sp=uc.reg_read(UC_X86_REG_SP)&0xffff, bp=uc.reg_read(UC_X86_REG_BP)&0xffff,
        si=uc.reg_read(UC_X86_REG_SI)&0xffff, di=uc.reg_read(UC_X86_REG_DI)&0xffff,
        es=uc.reg_read(UC_X86_REG_ES), ss=uc.reg_read(UC_X86_REG_SS), ds=uc.reg_read(UC_X86_REG_DS),
        fl=uc.reg_read(UC_X86_REG_EFLAGS)&0xffff)

trace=[]
for step in range(2500):
    st = rd(); trace.append(st)
    begin = ((st['cs']<<4) + st['ip']) & 0xfffff
    try:
        uc.emu_start(begin, 0x10ffff, 0, 1)
    except UcError as e:
        trace.append(dict(FAULT=str(e), at_cs=st['cs'], at_ip=st['ip']))
        break
json.dump(trace, open('/tmp/cosim-uc-trace.json','w'))
print('unicorn: traced', len(trace), 'steps; last', trace[-1])
# dump runtime memory at the divergence (0110:066d = 0x176d)
last = trace[-2] if 'FAULT' in trace[-1] else trace[-1]
lin = ((last.get('cs',0)<<4)+last.get('ip',0)) & 0xfffff if 'cs' in last else 0x176d
try:
    b = uc.mem_read(0x176d, 8); print('UC runtime bytes @0x176d:', ' '.join('%02x'%x for x in b))
except Exception as e: print('memread fail', e)
