# Minimal FAT12 reader: list a directory, or extract one file. Paths may go through subdirectories.
#   python3 fat12.py <img> [DIR/SUB]              list the root, or that directory
#   python3 fat12.py <img> DIR/NAME.EXT <out>     extract a file
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
def chain(c):
    out = b''
    while 2 <= c < 0xff8: out += d[data + (c - 2) * spc * bps:data + (c - 1) * spc * bps]; c = nxt(c)
    return out
def entries(raw):
    ents = []
    for i in range(len(raw) // 32):
        e = raw[i * 32:i * 32 + 32]
        if e[0] == 0: break
        if e[0] == 0xe5 or e[11] & 0x08 or e[11] == 0x0f: continue
        name = e[:8].decode('latin1').strip() + ('.' + e[8:11].decode('latin1').strip() if e[8:11].strip() else '')
        if name in ('.', '..'): continue
        ents.append((name, struct.unpack('<H', e[26:28])[0], struct.unpack('<I', e[28:32])[0], e[11]))
    return ents
def lookup(path):
    ents = entries(d[root:data])
    parts = [p for p in path.upper().split('/') if p]
    for i, p in enumerate(parts):
        hit = [e for e in ents if e[0] == p]
        if not hit: sys.exit(f'{path}: {p} not found')
        n, c, s, a = hit[0]
        if i == len(parts) - 1: return hit[0], ents
        ents = entries(chain(c))
    return None, ents
arg = sys.argv[2] if len(sys.argv) > 2 else ''
if len(sys.argv) < 4:
    hit, ents = lookup(arg) if arg else (None, entries(d[root:data]))
    if hit: ents = entries(chain(hit[1]))
    for n, c, s, a in ents: print(f'{n:14} {s:9} {"<DIR>" if a & 0x10 else ""}')
else:
    (n, c, s, a), _ = lookup(arg)
    open(sys.argv[3], 'wb').write(chain(c)[:s]); print('wrote', s)
