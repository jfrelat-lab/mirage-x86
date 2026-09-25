# Minimal FAT12 reader: list the root directory, or extract one file.
#   python3 fat12.py <img> [NAME.EXT out]
import sys, struct
d = open(sys.argv[1], 'rb').read()
bps, spc, rsv, nf, nroot = struct.unpack('<HBHBH', d[11:19])
spf = struct.unpack('<H', d[22:24])[0]
fat = d[rsv * bps:(rsv + spf) * bps]
root = (rsv + nf * spf) * bps
data = root + nroot * 32
def nxt(c):
    o = c * 3 // 2; v = fat[o] | (fat[o + 1] << 8)
    return (v >> 4) if c & 1 else (v & 0xfff)
ents = []
for i in range(nroot):
    e = d[root + i * 32:root + i * 32 + 32]
    if e[0] in (0, 0xe5) or e[11] & 0x08: continue
    name = e[:8].decode('latin1').strip() + ('.' + e[8:11].decode('latin1').strip() if e[8:11].strip() else '')
    ents.append((name, struct.unpack('<H', e[26:28])[0], struct.unpack('<I', e[28:32])[0], e[11]))
if len(sys.argv) < 3:
    for n, c, s, a in ents: print(f'{n:14} {s:9} {"<DIR>" if a & 0x10 else ""}')
else:
    for n, c, s, a in ents:
        if n == sys.argv[2]:
            out = b''
            while c < 0xff8: out += d[data + (c - 2) * spc * bps:data + (c - 1) * spc * bps]; c = nxt(c)
            open(sys.argv[3], 'wb').write(out[:s]); print('wrote', s)
