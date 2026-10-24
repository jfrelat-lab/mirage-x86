// memory.js — a Linux guest's memory as a JavaScript library sees it: read and write at the program's
// own (virtual) addresses, through MIRAGE-LINUX's page map. The libraries made in JavaScript (src/hle)
// take their arguments' pointers here; the same accessors are what PRISM's environment modules will
// read guest memory through on MIRAGE (ROADMAP O9), where PRISM's own memory is one flat array.
// A pointer to an unmapped page reads 0 and drops a write, as a library would not, but a guest's
// fault inside a library call has nowhere to go: the call is JavaScript.

export function guestMemory(lx, mem) {
  const u8 = mem.u8, dv = mem.dv || new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const at = (p) => lx.phys(p >>> 0);
  // A value of `n` bytes: straight from memory when it does not cross a page, byte by byte when it does.
  const same = (p, n) => ((p >>> 0) & 0xfff) <= 0x1000 - n;
  const r8 = (p) => { const a = at(p); return a < 0 ? 0 : u8[a]; };
  const w8 = (p, v) => { const a = at(p); if (a >= 0) u8[a] = v; };
  const r16 = (p) => { if (same(p, 2)) { const a = at(p); return a < 0 ? 0 : dv.getUint16(a, true); } return r8(p) | (r8(p + 1) << 8); };
  const r32 = (p) => { if (same(p, 4)) { const a = at(p); return a < 0 ? 0 : dv.getUint32(a, true); } return (r16(p) | (r16(p + 2) << 16)) >>> 0; };
  const w16 = (p, v) => { w8(p, v); w8(p + 1, v >>> 8); };
  const w32 = (p, v) => { if (same(p, 4)) { const a = at(p); if (a >= 0) dv.setUint32(a, v >>> 0, true); return; } w16(p, v); w16(p + 2, v >>> 16); };
  const bytes = (p, n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n;) {
      const a = at(p + i), take = Math.min(n - i, 0x1000 - ((p + i) & 0xfff));
      if (a >= 0) out.set(u8.subarray(a, a + take), i);
      i += take;
    }
    return out;
  };
  const write = (p, b) => {
    for (let i = 0; i < b.length;) {
      const a = at(p + i), take = Math.min(b.length - i, 0x1000 - ((p + i) & 0xfff));
      if (a >= 0) u8.set(b.subarray(i, i + take), a);
      i += take;
    }
  };
  const tmp = new DataView(new ArrayBuffer(8));
  const f32 = (p) => { tmp.setUint32(0, r32(p), true); return tmp.getFloat32(0, true); };
  const f64 = (p) => { tmp.setUint32(0, r32(p), true); tmp.setUint32(4, r32(p + 4), true); return tmp.getFloat64(0, true); };
  const dec = new TextDecoder('latin1');
  const strN = (p, n) => dec.decode(bytes(p, n));
  const str = (p, max = 1 << 20) => { if (!p) return ''; let n = 0; while (n < max && r8(p + n)) n++; return strN(p, n); };
  return { r8, r16, r32, w8, w16, w32, f32, f64, bytes, write, str, strN, alloc: (n) => lx.alloc(n),
    floats: (p, n) => Array.from({ length: n }, (_, i) => f32(p + 4 * i)),
    doubles: (p, n) => Array.from({ length: n }, (_, i) => f64(p + 8 * i)) };
}
