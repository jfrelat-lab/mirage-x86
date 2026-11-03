// dsound.js — DirectSound 8 for MIRAGE-WIN32: dsound.dll, its COM objects made here as d3d9.js makes
// Direct3D's (a pointer to a vtable of stubs that trap into the functions below, `this` first).
//
// A program creates the device, a primary buffer (its format) and secondary buffers it writes PCM into,
// usually one looping buffer it keeps refilling behind the play cursor (.kkrieger, 2004). The play
// cursor runs on the guest's clock from Play, at the buffer's rate, wrapping when the buffer loops; the
// buffer that plays is read from guest memory as the cursor reaches it, through the same sound source
// waveOut uses (lx.setSoundSource), so it is heard. Only 8- and 16-bit PCM, one buffer heard at a time:
// the last one played. Layouts: dsound.h (Wine's include/ as the oracle).

const S_OK = 0, E_NOINTERFACE = 0x80004002, DSERR_INVALIDPARAM = 0x80070057;

const UNK = 'QueryInterface:2 AddRef:0 Release:0';
const VTABLES = {
  IDirectSound8: `${UNK} CreateSoundBuffer:3 GetCaps:1 DuplicateSoundBuffer:2 SetCooperativeLevel:2 Compact:0
    GetSpeakerConfig:1 SetSpeakerConfig:1 Initialize:1 VerifyCertification:1`,
  IDirectSoundBuffer8: `${UNK} GetCaps:1 GetCurrentPosition:2 GetFormat:3 GetVolume:1 GetPan:1 GetFrequency:1 GetStatus:1
    Initialize:2 Lock:7 Play:3 SetCurrentPosition:1 SetFormat:1 SetVolume:1 SetPan:1 SetFrequency:1 Stop:0 Unlock:4 Restore:0
    SetFX:3 AcquireResources:3 GetObjectInPath:4`,
};
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));

export function dsoundApis() {
  const objs = new Map(), vtables = new Map();
  let heard = null;                                     // the buffer the sound source reads
  const make = (x, iface, props) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('dsound.dll'), ms = METHODS[iface], v = x.win.heapAlloc(ms.length * 4);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(16);
    x.w32(p, vtables.get(iface));
    objs.set(p, { iface, ref: 1, ...props });
    return p;
  };
  const o = (p) => objs.get(p >>> 0);
  // WAVEFORMATEX: tag, channels, rate, bytes a second, block align, bits.
  const format = (x, p) => (p ? { tag: x.r16(p), ch: x.r16(p + 2), rate: x.r32(p + 4), align: x.r16(p + 12) || 4, bits: x.r16(p + 14) } : null);
  // Where the play cursor is, in bytes, at guest time `now`.
  const cursor = (b, now) => {
    if (!b.playing) return b.pos;
    const n = Math.floor((now - b.t0) * b.fmt.rate) * b.fmt.align + b.pos0;
    if (b.loop) return n % b.size;
    if (n >= b.size) { b.playing = false; b.pos = 0; return 0; }
    return n;
  };
  // The sound source: what the playing buffer holds between the last read and the cursor.
  const drain = () => {
    const b = heard;
    if (!b || !b.playing || !b.x) return { rate: 44100, samples: [] };
    const x = b.x, now = x.lx.mono(), f = b.fmt, step = f.align;
    const total = Math.floor((now - b.t0) * f.rate) * step + b.pos0;
    let from = Math.max(b.read, total - f.rate * step);         // a second at most, should nobody listen
    const samples = [];
    for (; from + step <= total; from += step) {
      if (!b.loop && from >= b.size) break;
      const at = b.mem + (from % b.size), v = x.bytes(at, step);
      const s = (c) => (f.bits === 16 ? (v[c * 2] | (v[c * 2 + 1] << 8)) << 16 >> 16 : (v[c] - 128) << 8);
      const l = s(0); samples.push(l, f.ch > 1 ? s(1) : l);
    }
    b.read = total;
    return { rate: f.rate, samples };
  };
  const unknown = {
    QueryInterface: (x, self, riid, pp) => { if (pp) x.w32(pp, self); o(self).ref++; return S_OK; },   // IDirectSoundBuffer8 from a buffer: itself
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => { const ob = o(self); if (!ob) return 0; if (--ob.ref > 0) return ob.ref; if (heard === ob) heard = null; objs.delete(self >>> 0); return 0; },
  };
  const IMPL = {
    IDirectSound8: {
      // DSBUFFERDESC: size, flags, bytes, reserved, lpwfxFormat. DSBCAPS_PRIMARYBUFFER (1): the format holder.
      CreateSoundBuffer: (x, self, desc, pp) => {
        const flags = x.r32(desc + 4), primary = !!(flags & 1), bytes = x.r32(desc + 8), fmt = format(x, x.r32(desc + 16));
        if (!primary && (!fmt || fmt.tag !== 1 || (fmt.bits !== 8 && fmt.bits !== 16) || !bytes)) return DSERR_INVALIDPARAM;
        const mem = primary ? 0 : x.win.heapAlloc(bytes);
        if (mem) x.write(mem, new Uint8Array(bytes));
        x.w32(pp, make(x, 'IDirectSoundBuffer8', { primary, size: bytes, mem, fmt: fmt || { tag: 1, ch: 2, rate: 44100, align: 4, bits: 16 }, playing: false, pos: 0, pos0: 0, t0: 0, read: 0, loop: false, vol: 0, pan: 0 }));
        return S_OK;
      },
      GetCaps: (x, self, p) => { const n = x.r32(p); x.write(p + 4, new Uint8Array(Math.max(0, n - 4))); x.w32(p + 4, 0x0f00); return S_OK; },
      DuplicateSoundBuffer: (x, self, src, pp) => { x.w32(pp, make(x, 'IDirectSoundBuffer8', { ...o(src), ref: 1, playing: false })); return S_OK; },
      SetCooperativeLevel: () => S_OK, Compact: () => S_OK, GetSpeakerConfig: (x, self, p) => { x.w32(p, 5); return S_OK; },   // DSSPEAKER_STEREO
      SetSpeakerConfig: () => S_OK, Initialize: () => S_OK, VerifyCertification: (x, self, p) => { x.w32(p, 0); return S_OK; },
    },
    IDirectSoundBuffer8: {
      GetCaps: (x, self, p) => { const b = o(self); x.w32(p + 4, b.primary ? 1 : 0x8); x.w32(p + 8, b.size); return S_OK; },
      GetCurrentPosition: (x, self, pPlay, pWrite) => {
        const b = o(self), c = b.primary ? 0 : cursor(b, x.lx.mono());
        if (pPlay) x.w32(pPlay, c);
        if (pWrite) x.w32(pWrite, b.size ? (c + Math.min(b.size, b.fmt.rate * b.fmt.align / 100)) % b.size : 0);   // 10 ms ahead
        return S_OK;
      },
      GetFormat: (x, self, p, size, pWritten) => {
        const f = o(self).fmt;
        if (p) { x.w16(p, f.tag); x.w16(p + 2, f.ch); x.w32(p + 4, f.rate); x.w32(p + 8, f.rate * f.align); x.w16(p + 12, f.align); x.w16(p + 14, f.bits); if (size >= 18) x.w16(p + 16, 0); }
        if (pWritten) x.w32(pWritten, 18);
        return S_OK;
      },
      GetVolume: (x, self, p) => { x.w32(p, o(self).vol); return S_OK; }, GetPan: (x, self, p) => { x.w32(p, o(self).pan); return S_OK; },
      GetFrequency: (x, self, p) => { x.w32(p, o(self).fmt.rate); return S_OK; },
      GetStatus: (x, self, p) => { const b = o(self); if (b.playing) cursor(b, x.lx.mono()); x.w32(p, b.playing ? (b.loop ? 5 : 1) : 0); return S_OK; },   // PLAYING | LOOPING
      Initialize: () => S_OK,
      // Lock(offset, bytes, ppv1, pn1, ppv2, pn2, flags): the buffer's own memory, in two parts where it wraps.
      Lock: (x, self, off, n, pp1, pn1, pp2, pn2, flags) => {
        const b = o(self);
        if (!b.size) return DSERR_INVALIDPARAM;
        if (flags & 1) off = cursor(b, x.lx.mono());           // DSBLOCK_FROMWRITECURSOR
        if (flags & 2) n = b.size;                             // DSBLOCK_ENTIREBUFFER
        off %= b.size; n = Math.min(n, b.size);
        const first = Math.min(n, b.size - off);
        x.w32(pp1, b.mem + off); x.w32(pn1, first);
        if (pp2) x.w32(pp2, first < n ? b.mem : 0);
        if (pn2) x.w32(pn2, n - first);
        return S_OK;
      },
      Play: (x, self, r1, prio, flags) => {
        const b = o(self);
        if (b.primary) return S_OK;
        b.x = x; b.loop = !!(flags & 1); b.t0 = x.lx.mono(); b.pos0 = b.pos; b.read = b.pos; b.playing = true;
        heard = b; x.lx.setSoundSource(drain);
        return S_OK;
      },
      SetCurrentPosition: (x, self, pos) => { const b = o(self); b.pos = pos % (b.size || 1); if (b.playing) { b.t0 = x.lx.mono(); b.pos0 = b.pos; b.read = b.pos; } return S_OK; },
      SetFormat: (x, self, p) => { const f = format(x, p); if (f) o(self).fmt = f; return S_OK; },
      SetVolume: (x, self, v) => { o(self).vol = v | 0; return S_OK; }, SetPan: (x, self, v) => { o(self).pan = v | 0; return S_OK; },
      SetFrequency: (x, self, hz) => { const b = o(self); if (hz) b.fmt = { ...b.fmt, rate: hz }; return S_OK; },
      Stop: (x, self) => { const b = o(self); b.pos = cursor(b, x.lx.mono()); b.playing = false; return S_OK; },
      Unlock: () => S_OK, Restore: () => S_OK,
      SetFX: () => E_NOINTERFACE, AcquireResources: () => S_OK, GetObjectInPath: () => E_NOINTERFACE,
    },
  };
  const sigOf = (s) => 'p' + 'u'.repeat(+s);
  const fns = {
    // DirectSoundCreate8(guid, ppDS8, outer) and DirectSoundCreate: the one device.
    DirectSoundCreate8: ['ppp', (x, guid, pp) => { x.w32(pp, make(x, 'IDirectSound8', {})); return S_OK; }, { ordinal: 11 }],
    DirectSoundCreate: ['ppp', (x, guid, pp) => { x.w32(pp, make(x, 'IDirectSound8', {})); return S_OK; }, { ordinal: 1 }],
  };
  let ord = 1000;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, s] of ms) {
    const f = unknown[n] || IMPL[iface][n] || (() => { throw new Error(`mirage-win32: ${iface}::${n} is not implemented`); });
    fns[`${iface}::${n}`] = [sigOf(s), f, { ordinal: ord++ }];
  }
  return { dll: 'dsound.dll', fns };
}
