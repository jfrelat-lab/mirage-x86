// dmusic.js — DirectMusic for MIRAGE-WIN32: the performance, the loader, segments, their states and audio
// paths, as COM objects a program makes with CoCreateInstance (CLSID_DirectMusicPerformance, _Loader).
// GameMaker 8's runner plays its sounds so (the Undertale demo, 2013): a wave file loaded as a segment,
// played as a secondary segment, its path's volume set. Here a segment is its wave's samples, decoded
// once; a play is a voice in this module's mixer, one of the machine's sound sources (lx.setSoundSource's
// 'dmusic', beside waveOut's and DirectSound's). A MIDI or a DirectMusic style segment loads and plays
// silently: no synthesizer is wired to it yet.
//
// The vtables are dmusici.h's (Wine's include/ the oracle): each method's 32-bit words after `this`, a
// REFERENCE_TIME counting two.

const S_OK = 0, S_FALSE = 1, E_NOINTERFACE = 0x80004002, E_NOTIMPL = 0x80004001, E_POINTER = 0x80004003;
const DMUS_E_LOADER_FAILEDOPEN = 0x88781170, DMUS_E_UNSUPPORTED_STREAM = 0x88781167;
const UNK = 'QueryInterface:2 AddRef:0 Release:0';
const VTABLES = {
  IDirectMusicPerformance8: `${UNK} Init:3 PlaySegment:5 Stop:4 GetSegmentState:2 SetPrepareTime:1 GetPrepareTime:1 SetBumperLength:1
    GetBumperLength:1 SendPMsg:1 MusicToReferenceTime:2 ReferenceToMusicTime:3 IsPlaying:2 GetTime:2 AllocPMsg:2 FreePMsg:1 GetGraph:1
    SetGraph:1 SetNotificationHandle:3 GetNotificationPMsg:1 AddNotificationType:1 RemoveNotificationType:1 AddPort:1 RemovePort:1
    AssignPChannelBlock:3 AssignPChannel:4 PChannelInfo:4 DownloadInstrument:8 Invalidate:2 GetParam:6 SetParam:5 GetGlobalParam:3
    SetGlobalParam:3 GetLatencyTime:1 GetQueueTime:1 AdjustTime:2 CloseDown:0 GetResolvedTime:4 MIDIToMusic:5 MusicToMIDI:5
    TimeToRhythm:6 RhythmToTime:6 InitAudio:7 PlaySegmentEx:9 StopEx:4 ClonePMsg:2 CreateAudioPath:3 CreateStandardAudioPath:4
    SetDefaultAudioPath:1 GetDefaultAudioPath:1 GetParamEx:7`,
  IDirectMusicLoader8: `${UNK} GetObject:3 SetObject:1 SetSearchDirectory:3 ScanDirectory:3 CacheObject:1 ReleaseObject:1 ClearCache:1
    EnableCache:2 EnumObject:3 CollectGarbage:0 ReleaseObjectByUnknown:1 LoadObjectFromFile:4`,
  IDirectMusicSegment8: `${UNK} GetLength:1 SetLength:1 GetRepeats:1 SetRepeats:1 GetDefaultResolution:1 SetDefaultResolution:1 GetTrack:4
    GetTrackGroup:2 InsertTrack:2 RemoveTrack:1 InitPlay:3 GetGraph:1 SetGraph:1 AddNotificationType:1 RemoveNotificationType:1
    GetParam:6 SetParam:5 Clone:3 SetStartPoint:1 GetStartPoint:1 SetLoopPoints:2 GetLoopPoints:2 SetPChannelsUsed:2 SetTrackConfig:5
    GetAudioPathConfig:1 Compose:4 Download:1 Unload:1`,
  IDirectMusicSegmentState8: `${UNK} GetRepeats:1 GetSegment:1 GetStartTime:1 GetSeek:1 GetStartPoint:1 SetTrackConfig:5 GetObjectInPath:7`,
  IDirectMusicAudioPath: `${UNK} GetObjectInPath:7 Activate:1 SetVolume:2 ConvertPChannel:2`,
};
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));
// The interfaces each object answers to: its own and those it derives from (the same vtable serves them).
const IIDS = {
  IDirectMusicPerformance8: ['07d43d03-6523-11d2-871d-00600893b1bd', '6fc2cae0-bc78-11d2-afa6-00aa0024d8b6', '679c4137-c62e-4147-b2b4-9d569acb254c'],
  IDirectMusicLoader8: ['2ffaaca2-5dca-11d2-afa6-00aa0024d8b6', '19e7c08c-0a44-4e6a-a116-595a7cd5de8c'],
  IDirectMusicSegment8: ['f96029a2-4282-11d2-8717-00600893b1bd', 'd38894d1-c052-11d2-872f-00600893b1bd', 'c6784488-41a3-418f-aa15-b35093ba42d4'],
  IDirectMusicSegmentState8: ['a3afdcc7-d3ee-11d1-bc8d-00a0c922e6eb', 'a50e4730-0ae4-48a7-9839-bc04bfe07772'],
  IDirectMusicAudioPath: ['c87631f5-23be-4986-8836-05832fcc48f9'],
};
const IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const CLSID_PERFORMANCE = 'd2ac2881-b39b-11d1-8704-00600893b1bd', CLSID_LOADER = 'd2ac2892-b39b-11d1-8704-00600893b1bd';
const GUID_PerfMasterVolume = 'd2ac28b1-b39b-11d1-8704-00600893b1bd';

const guidOf = (x, p) => {
  const b = x.bytes(p, 16), h = (i, n) => [...b.slice(i, i + n)].map((v) => v.toString(16).padStart(2, '0')).join('');
  const r = (i, n) => h(i, n).match(/../g).reverse().join('');
  return `${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}`;
};
const wstr = (x, p, max = 520) => { let s = ''; for (let i = 0; i < max; i++) { const c = x.r16(p + 2 * i); if (!c) break; s += String.fromCharCode(c); } return s; };

/** A RIFF WAVE file's samples as stereo 16-bit frames: { rate, pcm: Int16Array (L, R, ...) }, or null. */
export function decodeWave(b) {
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0, u16 = (o) => b[o] | b[o + 1] << 8;
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = tag(o), n = u32(o + 4);
    if (id === 'fmt ') fmt = { tag: u16(o + 8), ch: u16(o + 10), rate: u32(o + 12), bits: u16(o + 22) };
    else if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + n));
    o += 8 + n + (n & 1);
  }
  if (!fmt || !data || fmt.tag !== 1 || (fmt.bits !== 8 && fmt.bits !== 16) || fmt.ch < 1 || fmt.ch > 2) return null;
  const step = fmt.ch * fmt.bits / 8, frames = Math.floor(data.length / step), pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
    const k = i * step + (fmt.ch > 1 ? c : 0) * fmt.bits / 8;
    pcm[i * 2 + c] = fmt.bits === 16 ? (data[k] | data[k + 1] << 8) << 16 >> 16 : (data[k] - 128) << 8;
  }
  return { rate: fmt.rate, pcm };
}

/**
 * The DirectMusic objects, made on `st` (st.coClasses: CoCreateInstance's classes, src/win32/classic.js)
 * with `readFile` (a file of the program's disk by its path, or null). Returns dmusic.dll's table: the
 * methods, as exports named "Interface::Method", which no program imports.
 */
export function dmusicApis(st, readFile) {
  const objs = new Map(), vtables = new Map();
  let master = 0;                                                     // GUID_PerfMasterVolume, 1/100 dB
  const make = (x, iface, props) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('dmusic.dll'), ms = METHODS[iface], v = x.win.heapAlloc(4 * ms.length);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(8); x.w32(p, vtables.get(iface)); objs.set(p, { iface, ref: 1, ...props });
    return p;
  };
  const o = (p) => objs.get(p >>> 0);
  // ---- the mixer: each play a voice, its wave resampled to 44.1 kHz, its path's volume and the master's ----
  const voices = []; let last = null, mixX = null;
  const gain = (cb) => Math.pow(10, Math.max(-9600, Math.min(0, cb)) / 2000);
  const drain = () => {
    const x = mixX; if (!x) return { rate: 44100, samples: [] };
    const now = x.lx.mono(); if (last === null) last = now;
    const frames = Math.min(44100, Math.floor((now - last) * 44100)); last += frames / 44100;
    const out = new Float32Array(frames * 2);
    for (let v = voices.length - 1; v >= 0; v--) {
      const vo = voices[v], w = vo.seg.wave, n = w.pcm.length / 2, k = w.rate / 44100, g = gain(vo.path.volume + master);
      let i = 0;
      for (; i < frames; i++) {
        let at = Math.floor(vo.pos);
        if (at >= n) {
          if (vo.repeats === 0) break;
          if (vo.repeats > 0) vo.repeats--;
          vo.pos -= n; at = Math.floor(vo.pos);
        }
        out[i * 2] += w.pcm[at * 2] * g; out[i * 2 + 1] += w.pcm[at * 2 + 1] * g;
        vo.pos += k;
      }
      if (i < frames) voices.splice(v, 1);
    }
    const samples = new Array(frames * 2);
    for (let i = 0; i < frames * 2; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(out[i])));
    return { rate: 44100, samples };
  };
  const play = (x, seg, path, ppState) => {
    const s = o(seg); if (!s || s.iface !== 'IDirectMusicSegment8') return E_POINTER;
    const state = make(x, 'IDirectMusicSegmentState8', { seg });
    if (s.wave && s.wave.pcm.length) {
      if (!mixX) { mixX = x; x.lx.setSoundSource(drain, 'dmusic'); }
      voices.push({ seg: s, segPtr: seg, state, path: o(path) || defaultPath(x), pos: 0, repeats: s.repeats === 0xffffffff ? -1 : s.repeats });
    }
    if (ppState) x.w32(ppState, state); else o(state).ref = 0;
    return S_OK;
  };
  // Stop a segment, one of its plays, the plays on an audio path, or all of them.
  const stop = (x, what) => {
    for (let v = voices.length - 1; v >= 0; v--) {
      const vo = voices[v];
      if (!what || vo.segPtr === what >>> 0 || vo.state === what >>> 0 || vo.path === o(what)) voices.splice(v, 1);
    }
    return S_OK;
  };
  let dflt = 0;
  const defaultPath = (x) => o(dflt || (dflt = make(x, 'IDirectMusicAudioPath', { volume: 0 })));
  // A segment from a file's bytes: a wave decoded, anything else (MIDI, a DirectMusic segment) silent.
  const segment = (x, bytes) => make(x, 'IDirectMusicSegment8', { wave: bytes && decodeWave(bytes), repeats: 0 });
  const loadInto = (x, bytes, riid, pp) => {
    if (!bytes) { x.w32(pp, 0); return DMUS_E_LOADER_FAILEDOPEN; }
    const p = segment(x, bytes);
    return unknown.QueryInterface(x, p, riid, pp) || (o(p).ref--, S_OK);
  };
  let searchDir = '';
  const fileBytes = (name) => readFile((/^[a-z]:|^\\/i.test(name) ? '' : searchDir) + name);

  const unknown = {
    QueryInterface: (x, self, riid, pp) => {
      const g = guidOf(x, riid), ob = o(self);
      if (!ob || (g !== IUNKNOWN && !IIDS[ob.iface].includes(g))) { if (pp) x.w32(pp, 0); return E_NOINTERFACE; }
      ob.ref++; x.w32(pp, self); return S_OK;
    },
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => { const ob = o(self); if (!ob) return 0; if (--ob.ref > 0) return ob.ref; objs.delete(self >>> 0); return 0; },
  };
  const out0 = (n, hr = S_OK) => (x, self, ...a) => { if (a[n]) x.w32(a[n], 0); return hr; };
  const performance = {
    Init: () => S_OK, InitAudio: () => S_OK, CloseDown: () => { voices.length = 0; return S_OK; },
    PlaySegment: (x, self, seg, flags, lo, hi, ppState) => play(x, seg, 0, ppState),
    PlaySegmentEx: (x, self, src, name, trans, flags, lo, hi, ppState, from, path) => play(x, src, path, ppState),
    Stop: (x, self, seg, state) => stop(x, seg || state),
    StopEx: (x, self, what) => stop(x, what),
    IsPlaying: (x, self, seg, state) => (voices.some((v) => (seg && v.segPtr === seg >>> 0) || (state && v.state === state >>> 0)) ? S_OK : S_FALSE),
    GetTime: (x, self, prt, pmt) => { const t = mixX ? mixX.lx.mono() : 0; if (prt) { const r = Math.floor(t * 1e7); x.w32(prt, r >>> 0); x.w32(prt + 4, Math.floor(r / 4294967296)); } if (pmt) x.w32(pmt, Math.floor(t * 768 * 2)); return S_OK; },
    GetSegmentState: out0(0, S_FALSE),
    SetPrepareTime: () => S_OK, GetPrepareTime: out0(0), SetBumperLength: () => S_OK, GetBumperLength: out0(0),
    SetNotificationHandle: () => S_OK, GetNotificationPMsg: out0(0, S_FALSE), AddNotificationType: () => S_OK, RemoveNotificationType: () => S_OK,
    AddPort: () => S_OK, RemovePort: () => S_OK, AssignPChannelBlock: () => S_OK, AssignPChannel: () => S_OK,
    Invalidate: () => S_OK, SetParam: () => S_OK, GetLatencyTime: out0(0), GetQueueTime: out0(0), AdjustTime: () => S_OK,
    // GUID_PerfMasterVolume: a long, in 1/100 dB.
    SetGlobalParam: (x, self, g, p, n) => { if (guidOf(x, g) === GUID_PerfMasterVolume && p && n >= 4) master = x.r32(p) | 0; return S_OK; },
    GetGlobalParam: (x, self, g, p, n) => { if (p && n >= 4) { x.write(p, new Uint8Array(n)); if (guidOf(x, g) === GUID_PerfMasterVolume) x.w32(p, master); } return S_OK; },
    CreateStandardAudioPath: (x, self, type, nch, activate, pp) => { x.w32(pp, make(x, 'IDirectMusicAudioPath', { volume: 0 })); return S_OK; },
    CreateAudioPath: (x, self, cfg, activate, pp) => { x.w32(pp, make(x, 'IDirectMusicAudioPath', { volume: 0 })); return S_OK; },
    GetDefaultAudioPath: (x, self, pp) => { defaultPath(x).ref++; x.w32(pp, dflt); return S_OK; },
    SetDefaultAudioPath: (x, self, p) => { if (p && o(p)) dflt = p >>> 0; return S_OK; },
  };
  const loader = {
    SetSearchDirectory: (x, self, cls, p) => { searchDir = p ? wstr(x, p).replace(/\\?$/, '\\') : ''; return S_OK; },
    ScanDirectory: () => S_FALSE, CacheObject: () => S_OK, ReleaseObject: () => S_OK, ClearCache: () => S_OK, EnableCache: () => S_OK,
    CollectGarbage: () => 0, ReleaseObjectByUnknown: () => S_OK, SetObject: () => S_OK, EnumObject: () => S_FALSE,
    LoadObjectFromFile: (x, self, cls, riid, path, pp) => loadInto(x, fileBytes(wstr(x, path)), riid, pp),
    // DMUS_OBJECTDESC: the object's bytes in memory (DMUS_OBJ_MEMORY, 400h) or its file (DMUS_OBJ_FILENAME, 10h).
    GetObject: (x, self, desc, riid, pp) => {
      const valid = x.r32(desc + 4);
      if (valid & 0x400) return loadInto(x, x.bytes(x.r32(desc + 840), x.r32(desc + 832)).slice(), riid, pp);
      if (valid & 0x10) return loadInto(x, fileBytes(wstr(x, desc + 312, 260)), riid, pp);
      x.w32(pp, 0); return DMUS_E_UNSUPPORTED_STREAM;
    },
  };
  const segmentImpl = {
    SetRepeats: (x, self, n) => { o(self).repeats = n >>> 0; return S_OK; },
    GetRepeats: (x, self, p) => { x.w32(p, o(self).repeats); return S_OK; },
    // A wave's length in music time, at DirectMusic's default tempo (120 beats a minute, 768 ticks a beat).
    GetLength: (x, self, p) => { const w = o(self).wave; x.w32(p, w ? Math.ceil(w.pcm.length / 2 / w.rate * 1536) : 1); return S_OK; },
    SetLength: () => S_OK, GetDefaultResolution: out0(0), SetDefaultResolution: () => S_OK,
    AddNotificationType: () => S_OK, RemoveNotificationType: () => S_OK, SetParam: () => S_OK, GetParam: () => 0x88781181,   // DMUS_E_NOT_FOUND
    SetStartPoint: () => S_OK, GetStartPoint: out0(0), SetLoopPoints: () => S_OK, GetLoopPoints: (x, self, a, b) => { x.w32(a, 0); x.w32(b, 0); return S_OK; },
    SetPChannelsUsed: () => S_OK, SetTrackConfig: () => S_OK, GetAudioPathConfig: out0(0, 0x88781181), Download: () => S_OK, Unload: () => S_OK,
  };
  const segmentState = {
    GetRepeats: out0(0), GetSegment: (x, self, pp) => { const s = o(self).seg; o(s).ref++; x.w32(pp, s); return S_OK; },
    GetStartTime: out0(0), GetSeek: out0(0), GetStartPoint: out0(0), SetTrackConfig: () => S_OK, GetObjectInPath: (x, self, ...a) => { x.w32(a[6], 0); return E_NOTIMPL; },
  };
  const audioPath = {
    Activate: () => S_OK, ConvertPChannel: (x, self, a, p) => { x.w32(p, a); return S_OK; },
    SetVolume: (x, self, vol) => { o(self).volume = vol | 0; return S_OK; },
    // The path's DirectSound buffers and the rest: not here (DMUS_E_NOT_FOUND), the pointer cleared.
    GetObjectInPath: (x, self, ...a) => { x.w32(a[6], 0); return 0x88781181; },
  };
  const IMPL = { IDirectMusicPerformance8: performance, IDirectMusicLoader8: loader, IDirectMusicSegment8: segmentImpl, IDirectMusicSegmentState8: segmentState, IDirectMusicAudioPath: audioPath };
  const fns = {}; let ord = 1;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, c] of ms) {
    const f = unknown[n] || IMPL[iface][n] || (() => { throw new Error(`mirage-win32: ${iface}::${n} is not implemented`); });
    fns[`${iface}::${n}`] = ['p' + 'u'.repeat(+c), f, { ordinal: ord++ }];
  }
  // CoCreateInstance's classes: the performance and the loader.
  st.coClasses ||= new Map();
  st.coClasses.set(CLSID_PERFORMANCE, (x, iid, pp) => { const p = make(x, 'IDirectMusicPerformance8', {}); const hr = unknown.QueryInterface(x, p, iid, pp); o(p).ref--; return hr; });
  st.coClasses.set(CLSID_LOADER, (x, iid, pp) => { const p = make(x, 'IDirectMusicLoader8', {}); const hr = unknown.QueryInterface(x, p, iid, pp); o(p).ref--; return hr; });
  return [{ dll: 'dmusic.dll', fns }];
}
