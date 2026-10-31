// d3d9.js — Direct3D 9 for MIRAGE-WIN32: d3d9.dll and d3dx9_24..43.dll, their COM objects made here.
// Each object a program gets is a pointer into guest memory to a vtable of stubs (dll.js's, trapping
// into the functions below, `this` their first argument), and the state behind it is a handle of the
// device model: PRISM's src/env/d3d9.js in a page (x.backend.d3d9()), which never reads guest memory —
// what a method points to is read here and handed over as typed arrays; headless, recordD3D9() below,
// which answers as a device would and remembers the calls.
//
// Layouts are d3d9.h's and d3dx9*.h's (Wine's include/ as the oracle): the vtables' orders, the
// structures (D3DPRESENT_PARAMETERS, D3DSURFACE_DESC, D3DVERTEXELEMENT9, D3DXCONSTANT_DESC), the
// HRESULTs. D3DXCompileShader compiles nothing: its "bytecode" is PRISM's blob — a version token, a
// comment holding 'PRSM', the entry point and the HLSL source, the end token — which PRISM's
// createPixelShader translates from the source.

const S_OK = 0, E_NOINTERFACE = 0x80004002, E_FAIL = 0x80004005, D3DERR_INVALIDCALL = 0x8876086c, D3DERR_NOTAVAILABLE = 0x8876086a;

// The vtables: each method's name and the signature of its arguments after `this` (a digit: that many
// 32-bit words; otherwise src/hle's letters, f a float by value).
const UNK = 'QueryInterface:2 AddRef:0 Release:0';
const RES = `${UNK} GetDevice:1 SetPrivateData:4 GetPrivateData:3 FreePrivateData:1 SetPriority:1 GetPriority:0 PreLoad:0 GetType:0`;
const BASETEX = `${RES} SetLOD:1 GetLOD:0 GetLevelCount:0 SetAutoGenFilterType:1 GetAutoGenFilterType:0 GenerateMipSubLevels:0`;
const VTABLES = {
  IDirect3D9: `${UNK} RegisterSoftwareDevice:1 GetAdapterCount:0 GetAdapterIdentifier:3 GetAdapterModeCount:2 EnumAdapterModes:4
    GetAdapterDisplayMode:2 CheckDeviceType:5 CheckDeviceFormat:6 CheckDeviceMultiSampleType:6 CheckDepthStencilMatch:5
    CheckDeviceFormatConversion:4 GetDeviceCaps:3 GetAdapterMonitor:1 CreateDevice:6`,
  IDirect3DDevice9: `${UNK} TestCooperativeLevel:0 GetAvailableTextureMem:0 EvictManagedResources:0 GetDirect3D:1 GetDeviceCaps:1
    GetDisplayMode:2 GetCreationParameters:1 SetCursorProperties:3 SetCursorPosition:3 ShowCursor:1 CreateAdditionalSwapChain:2
    GetSwapChain:2 GetNumberOfSwapChains:0 Reset:1 Present:4 GetBackBuffer:4 GetRasterStatus:2 SetDialogBoxMode:1 SetGammaRamp:3
    GetGammaRamp:2 CreateTexture:8 CreateVolumeTexture:9 CreateCubeTexture:7 CreateVertexBuffer:6 CreateIndexBuffer:6
    CreateRenderTarget:8 CreateDepthStencilSurface:8 UpdateSurface:4 UpdateTexture:2 GetRenderTargetData:2 GetFrontBufferData:2
    StretchRect:5 ColorFill:3 CreateOffscreenPlainSurface:6 SetRenderTarget:2 GetRenderTarget:2 SetDepthStencilSurface:1
    GetDepthStencilSurface:1 BeginScene:0 EndScene:0 Clear:upuufu SetTransform:2 GetTransform:2 MultiplyTransform:2 SetViewport:1
    GetViewport:1 SetMaterial:1 GetMaterial:1 SetLight:2 GetLight:2 LightEnable:2 GetLightEnable:2 SetClipPlane:2 GetClipPlane:2
    SetRenderState:2 GetRenderState:2 CreateStateBlock:2 BeginStateBlock:0 EndStateBlock:1 SetClipStatus:1 GetClipStatus:1
    GetTexture:2 SetTexture:2 GetTextureStageState:3 SetTextureStageState:3 GetSamplerState:3 SetSamplerState:3 ValidateDevice:1
    SetPaletteEntries:2 GetPaletteEntries:2 SetCurrentTexturePalette:1 GetCurrentTexturePalette:1 SetScissorRect:1 GetScissorRect:1
    SetSoftwareVertexProcessing:1 GetSoftwareVertexProcessing:0 SetNPatchMode:f GetNPatchMode:0 DrawPrimitive:3
    DrawIndexedPrimitive:6 DrawPrimitiveUP:4 DrawIndexedPrimitiveUP:8 ProcessVertices:6 CreateVertexDeclaration:2
    SetVertexDeclaration:1 GetVertexDeclaration:1 SetFVF:1 GetFVF:1 CreateVertexShader:2 SetVertexShader:1 GetVertexShader:1
    SetVertexShaderConstantF:3 GetVertexShaderConstantF:3 SetVertexShaderConstantI:3 GetVertexShaderConstantI:3
    SetVertexShaderConstantB:3 GetVertexShaderConstantB:3 SetStreamSource:4 GetStreamSource:4 SetStreamSourceFreq:2
    GetStreamSourceFreq:2 SetIndices:1 GetIndices:1 CreatePixelShader:2 SetPixelShader:1 GetPixelShader:1 SetPixelShaderConstantF:3
    GetPixelShaderConstantF:3 SetPixelShaderConstantI:3 GetPixelShaderConstantI:3 SetPixelShaderConstantB:3 GetPixelShaderConstantB:3
    DrawRectPatch:3 DrawTriPatch:3 DeletePatch:1 CreateQuery:2`,
  IDirect3DTexture9: `${BASETEX} GetLevelDesc:2 GetSurfaceLevel:2 LockRect:4 UnlockRect:1 AddDirtyRect:1`,
  IDirect3DSurface9: `${RES} GetContainer:2 GetDesc:1 LockRect:3 UnlockRect:0 GetDC:1 ReleaseDC:1`,
  IDirect3DVertexBuffer9: `${RES} Lock:4 Unlock:0 GetDesc:1`,
  IDirect3DIndexBuffer9: `${RES} Lock:4 Unlock:0 GetDesc:1`,
  IDirect3DVertexShader9: `${UNK} GetDevice:1 GetFunction:2`,
  IDirect3DPixelShader9: `${UNK} GetDevice:1 GetFunction:2`,
  IDirect3DVertexDeclaration9: `${UNK} GetDevice:1 GetDeclaration:2`,
  IDirect3DQuery9: `${UNK} GetDevice:1 GetType:0 GetDataSize:0 Issue:1 GetData:3`,
  ID3DXBuffer: `${UNK} GetBufferPointer:0 GetBufferSize:0`,
  ID3DXConstantTable: `${UNK} GetBufferPointer:0 GetBufferSize:0 GetDesc:1 GetConstantDesc:3 GetSamplerIndex:1 GetConstant:2
    GetConstantByName:2 GetConstantElement:2 SetDefaults:1 SetValue:4 SetBool:3 SetBoolArray:4 SetInt:3 SetIntArray:4 SetFloat:ppf
    SetFloatArray:4 SetVector:3 SetVectorArray:4 SetMatrix:3 SetMatrixArray:4 SetMatrixPointerArray:4 SetMatrixTranspose:3
    SetMatrixTransposeArray:4 SetMatrixTransposePointerArray:4`,
};
const sigOf = (s) => 'p' + (/^\d+$/.test(s) ? 'u'.repeat(+s) : s);
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));

// Bytes a pixel of a D3DFORMAT takes (d3d9types.h's numbers).
const BPP = { 20: 3, 21: 4, 22: 4, 23: 2, 24: 2, 25: 2, 26: 2, 28: 1, 31: 4, 32: 4, 33: 4, 34: 4, 35: 4, 36: 8, 50: 1, 51: 2,
  111: 2, 112: 4, 113: 8, 114: 4, 115: 8, 116: 16 };
// Vertices a primitive count takes: D3DPRIMITIVETYPE 1 points .. 6 fan.
const VERTS = [0, (n) => n, (n) => 2 * n, (n) => n + 1, (n) => 3 * n, (n) => n + 2, (n) => n + 2];

/**
 * recordD3D9(): the device model's interface (PRISM's createD3D9's), answering as a device would —
 * handles, a D3DCAPS9 of a shader model 3 card, the display mode — and counting every call. For the
 * tests and the headless runs.
 */
export function recordD3D9() {
  let next = 1;
  const calls = new Map(), handle = () => next++;
  const count = (name) => calls.set(name, (calls.get(name) || 0) + 1);
  const dev = new Proxy({ calls, presents: 0, last: {} }, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => {
        count(k); t.last[k] = a;
        if (k === 'present') t.presents++;
        if (/^(create|get(SurfaceLevel|BackBuffer|RenderTarget|DepthStencilSurface))/.test(k)) return handle();
        if (k === 'surfaceRead') return { bytes: new Uint8Array(16), pitch: 4 };
        return 0;
      };
    },
  });
  const caps = new Uint8Array(304), cv = new DataView(caps.buffer);
  cv.setUint32(88, 8192, true); cv.setUint32(92, 8192, true);            // MaxTextureWidth, MaxTextureHeight
  cv.setUint32(148, 8, true); cv.setUint32(152, 8, true);                // MaxTextureBlendStages, MaxSimultaneousTextures
  cv.setUint32(188, 16, true); cv.setUint32(192, 255, true);             // MaxStreams, MaxStreamStride
  cv.setUint32(196, 0xfffe0300, true); cv.setUint32(200, 256, true);     // VertexShaderVersion 3.0, MaxVertexShaderConst
  cv.setUint32(204, 0xffff0300, true);                                   // PixelShaderVersion 3.0
  return {
    device: dev, calls,
    getAdapterDisplayMode: () => ({ width: 1280, height: 720, refresh: 60, format: 22 }),
    checkDeviceFormat: () => S_OK, checkDeviceType: () => S_OK, getDeviceCaps: () => caps,
    createDevice(p) { count('createDevice'); dev.last.createDevice = [p]; return dev; },
    hlslConstants: () => [],
  };
}

/** PRISM's HLSL blob (see the top): the profile's version token, 'PRSM', entry and source, the end. */
export function hlslBlob(profile, entry, source) {
  const m = /^(ps|vs)_(\d)_(\d)/.exec(profile);
  if (!m) throw new Error(`mirage-win32: D3DXCompileShader: profile ${profile}`);
  const ver = (m[1] === 'ps' ? 0xffff0000 : 0xfffe0000) | (+m[2] << 8) | +m[3];
  const text = new TextEncoder().encode(`${entry}\0${source}\0`), n = 1 + Math.ceil(text.length / 4);
  const u = new Uint32Array(n + 3);
  u[0] = ver >>> 0; u[1] = (0xfffe | (n << 16)) >>> 0; u[2] = 0x4d535250;
  new Uint8Array(u.buffer, 12, text.length).set(text);
  u[n + 2] = 0xffff;
  return u;
}

/** The DWORDs of a shader's function: the version token to the end token, comments stepped over. */
function shaderTokens(x, p) {
  const out = [x.r32(p)], major = (out[0] >>> 8) & 0xff;
  for (let i = 1; i < 1 << 20;) {
    const t = x.r32(p + 4 * i);
    if (t === 0xffff) { out.push(t); break; }
    const n = (t & 0xffff) === 0xfffe ? t >>> 16 : major >= 2 ? (t >>> 24) & 0xf : 0;
    for (let k = 0; k <= n; k++) out.push(x.r32(p + 4 * (i + k)));
    i += n + 1;
  }
  return Uint32Array.from(out);
}

/** The Direct3D DLLs, made on `st` (user32's window state: the size a windowed device takes). */
export function d3d9Apis(st) {
  const objs = new Map();                                 // guest address -> { iface, ref, h, ... }
  const vtables = new Map();
  let d3d = null, arena = 0, arenaEnd = 0, lastPresent = -1;
  const model = (x) => d3d || (d3d = x.backend.d3d9 ? x.backend.d3d9() : recordD3D9());
  // Guest memory for what a program locks, mapped as it is handed out.
  const galloc = (x, n) => {
    if (!arena) { arena = 0x38000000; arenaEnd = arena; }
    const p = arena; arena += Math.ceil(Math.max(n, 1) / 0x1000) * 0x1000;
    if (arena > arenaEnd) { x.lx.mapRange(arenaEnd, arena, true); arenaEnd = arena; }
    return p;
  };
  const make = (x, iface, props = {}) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load('d3d9.dll'), ms = METHODS[iface], v = x.win.heapAlloc(ms.length * 4);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(16);
    x.w32(p, vtables.get(iface));
    objs.set(p, { iface, ref: 1, ...props });
    return p;
  };
  const o = (p) => objs.get(p >>> 0);
  const h = (p) => (p ? o(p)?.h ?? 0 : 0);
  const byHandle = (x, dev, hd, iface, props) => {
    if (!hd) return 0;
    for (const [p, ob] of objs) if (ob.h === hd && ob.iface === iface) { ob.ref++; return p; }
    return make(x, iface, { h: hd, dev, ...props });
  };
  const floats = (x, p, n) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = x.f32(p + 4 * i); return f; };
  const u32s = (x, p, n) => { const u = new Uint32Array(n); for (let i = 0; i < n; i++) u[i] = x.r32(p + 4 * i); return u; };
  const NOT = (iface, n) => () => { throw new Error(`mirage-win32: ${iface}::${n} is not implemented`); };
  const surfDesc = (x, p, d) => { x.write(p, new Uint8Array(32)); x.w32(p, d.format); x.w32(p + 4, d.type || 1); x.w32(p + 8, d.usage || 0);
    x.w32(p + 12, d.pool || 0); x.w32(p + 24, d.w); x.w32(p + 28, d.h); return S_OK; };

  // ---- the methods ----------------------------------------------------------------------------------
  const unknown = {
    QueryInterface: (x, self, riid, pp) => { if (pp) x.w32(pp, 0); return E_NOINTERFACE; },
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => {
      const ob = o(self); if (!ob) return 0;
      if (--ob.ref > 0) return ob.ref;
      if (ob.tex) { ob.ref = 0; return 0; }                // a texture's level lives as long as its texture
      if (ob.h && ob.dev) ob.dev.release(ob.h);
      objs.delete(self >>> 0);
      return 0;
    },
  };
  const resource = {
    GetDevice: (x, self, pp) => { const d = o(self).devPtr; o(d).ref++; x.w32(pp, d); return S_OK; },
    SetPrivateData: () => S_OK, GetPrivateData: () => D3DERR_NOTAVAILABLE, FreePrivateData: () => S_OK,
    SetPriority: () => 0, GetPriority: () => 0, PreLoad: () => 0,
    GetType: (x, self) => ({ IDirect3DSurface9: 1, IDirect3DTexture9: 3, IDirect3DVertexBuffer9: 6, IDirect3DIndexBuffer9: 7 })[o(self).iface],
    SetLOD: () => 0, GetLOD: () => 0, GetLevelCount: (x, self) => o(self).levels,
    SetAutoGenFilterType: () => S_OK, GetAutoGenFilterType: () => 2, GenerateMipSubLevels: () => 0,
  };
  const levelSize = (t, l) => [Math.max(1, t.w >> l), Math.max(1, t.h2 >> l)];
  // A lock: guest memory the program writes into, handed to the model at the unlock.
  const lockRect = (x, ob, pLocked, pRect) => {
    const bpp = BPP[ob.format] || 4;
    if (!ob.mem) ob.mem = galloc(x, ob.w * ob.h * bpp);
    const r = pRect ? [x.r32(pRect) | 0, x.r32(pRect + 4) | 0, x.r32(pRect + 8) | 0, x.r32(pRect + 12) | 0] : null;
    ob.locked = r;
    x.w32(pLocked, ob.w * bpp);
    x.w32(pLocked + 4, ob.mem + (r ? (r[1] * ob.w + r[0]) * bpp : 0));
    return S_OK;
  };
  const unlockRect = (x, ob, write) => {
    const bpp = BPP[ob.format] || 4, r = ob.locked;
    write(r, x.bytes(ob.mem, ob.w * ob.h * bpp), ob.w * bpp);
    ob.locked = undefined;
    return S_OK;
  };
  const texture = {
    GetLevelDesc: (x, self, l, p) => { const t = o(self), [w, hh] = levelSize(t, l); return surfDesc(x, p, { format: t.format, usage: t.usage, pool: t.pool, w, h: hh }); },
    GetSurfaceLevel: (x, self, l, pp) => {
      const t = o(self); t.surfaces ??= [];
      if (!t.surfaces[l] || !objs.has(t.surfaces[l])) {
        const [w, hh] = levelSize(t, l);
        t.surfaces[l] = make(x, 'IDirect3DSurface9', { h: t.dev.getSurfaceLevel(t.h, l), dev: t.dev, devPtr: t.devPtr, tex: self, level: l, w, h2: hh, format: t.format, usage: t.usage, pool: t.pool });
        o(t.surfaces[l]).ref = 0;
      }
      o(t.surfaces[l]).ref++; x.w32(pp, t.surfaces[l]); return S_OK;
    },
    LockRect: (x, self, l, pLocked, pRect) => { const t = o(self); t.lv ??= []; const [w, hh] = levelSize(t, l); t.lv[l] ??= { w, h: hh, format: t.format }; return lockRect(x, t.lv[l], pLocked, pRect); },
    UnlockRect: (x, self, l) => { const t = o(self); return unlockRect(x, t.lv[l], (r, b, pitch) => t.dev.textureWrite(t.h, l, null, b, pitch)); },
    AddDirtyRect: () => S_OK,
  };
  const surface = {
    GetContainer: (x, self, riid, pp) => { const s = o(self); if (!s.tex) return E_NOINTERFACE; o(s.tex).ref++; x.w32(pp, s.tex); return S_OK; },
    GetDesc: (x, self, p) => { const s = o(self); return surfDesc(x, p, { format: s.format, usage: s.usage, pool: s.pool, w: s.w, h: s.h2 }); },
    LockRect: (x, self, pLocked, pRect) => {
      const s = o(self), lk = s.lk ??= { w: s.w, h: s.h2, format: s.format };
      const r = lockRect(x, lk, pLocked, pRect);
      if (!s.tex) { const { bytes, pitch } = s.dev.surfaceRead(s.h); for (let y = 0; y < s.h2; y++) x.write(lk.mem + y * s.w * (BPP[s.format] || 4), bytes.subarray(y * pitch, y * pitch + s.w * (BPP[s.format] || 4))); }
      return r;
    },
    UnlockRect: (x, self) => { const s = o(self); return unlockRect(x, s.lk, (r, b, pitch) => { if (s.tex) o(s.tex).dev.textureWrite(o(s.tex).h, s.level, null, b, pitch); }); },
    GetDC: NOT('IDirect3DSurface9', 'GetDC'), ReleaseDC: NOT('IDirect3DSurface9', 'ReleaseDC'),
  };
  const buffer = {
    Lock: (x, self, off, size, pp, flags) => {
      const b = o(self);
      if (!b.mem) b.mem = galloc(x, b.length);
      b.lock = [off, size || b.length - off];
      x.w32(pp, b.mem + off); return S_OK;
    },
    Unlock: (x, self) => { const b = o(self), [off, n] = b.lock; b.dev.bufferWrite(b.h, off, x.bytes(b.mem + off, n)); return S_OK; },
    GetDesc: (x, self, p) => { const b = o(self); x.write(p, new Uint8Array(24)); x.w32(p, b.format); x.w32(p + 4, b.iface === 'IDirect3DVertexBuffer9' ? 6 : 7);
      x.w32(p + 8, b.usage); x.w32(p + 12, b.pool); x.w32(p + 16, b.length); if (b.iface === 'IDirect3DVertexBuffer9') x.w32(p + 20, b.fvf); return S_OK; },
  };
  const shaderObj = {
    GetDevice: resource.GetDevice,
    GetFunction: (x, self, p, pSize) => { const s = o(self); if (p) x.write(p, new Uint8Array(s.tokens.buffer)); x.w32(pSize, s.tokens.length * 4); return S_OK; },
    GetDeclaration: (x, self, p, pN) => { const d = o(self); if (p) x.write(p, d.bytes); x.w32(pN, d.bytes.length / 8); return S_OK; },
  };
  const query = {
    GetDevice: resource.GetDevice, GetType: (x, self) => o(self).type, GetDataSize: () => 4, Issue: () => S_OK,
    GetData: (x, self, p, n) => { if (p && n >= 4) x.w32(p, 1); return S_OK; },          // an event: done
  };
  const d3d9 = {
    RegisterSoftwareDevice: () => E_FAIL, GetAdapterCount: () => 1,
    GetAdapterIdentifier: (x, self, ad, fl, p) => { x.write(p, new Uint8Array(1100)); x.write(p, new TextEncoder().encode('prism')); x.write(p + 512, new TextEncoder().encode('PRISM Direct3D 9 on WebGL2')); return S_OK; },
    GetAdapterModeCount: () => 1,
    EnumAdapterModes: (x, self, ad, fmt, i, p) => d3d9.GetAdapterDisplayMode(x, self, ad, p),
    GetAdapterDisplayMode: (x, self, ad, p) => { const m = model(x).getAdapterDisplayMode(); x.w32(p, m.width); x.w32(p + 4, m.height); x.w32(p + 8, m.refresh); x.w32(p + 12, m.format); return S_OK; },
    CheckDeviceType: (x, self, ...a) => model(x).checkDeviceType(...a),
    CheckDeviceFormat: (x, self, ad, type, afmt, usage, rtype, fmt) => model(x).checkDeviceFormat(afmt, usage, rtype, fmt),
    CheckDeviceMultiSampleType: (x, self, ad, type, fmt, win, ms, pQ) => { if (pQ) x.w32(pQ, 1); return ms <= 1 ? S_OK : D3DERR_NOTAVAILABLE; },
    CheckDepthStencilMatch: () => S_OK, CheckDeviceFormatConversion: () => S_OK,
    GetDeviceCaps: (x, self, ad, type, p) => { x.write(p, model(x).getDeviceCaps()); return S_OK; },
    GetAdapterMonitor: () => 1,
    // D3DPRESENT_PARAMETERS: a windowed device's zero size is its window's client area.
    CreateDevice: (x, self, ad, type, hwnd, flags, pp, ppDev) => {
      const r = (k) => x.r32(pp + 4 * k), windowed = !!r(8);
      let w = r(0), hh = r(1);
      if (!w || !hh) { w = st.w || 640; hh = st.h || 480; x.w32(pp, w); x.w32(pp + 4, hh); }
      const params = { width: w, height: hh, backBufferFormat: r(2) || 22, backBufferCount: r(3) || 1, autoDepthStencilFormat: r(9) ? r(10) : 0, windowed, presentInterval: r(13) };
      if (x.backend.setVideoMode) x.backend.setVideoMode(w, hh, false);
      const dev = model(x).createDevice(params);
      const p = make(x, 'IDirect3DDevice9', { dev, d3d: self, params, created: [ad, type, hwnd, flags] });
      o(p).devPtr = p;
      o(self).ref++;
      x.w32(ppDev, p); return S_OK;
    },
  };
  const D = (self) => o(self).dev;
  const res = (x, self, iface, hd, props) => { const p = make(x, iface, { h: hd, dev: D(self), devPtr: self, ...props }); return p; };
  const device = {
    TestCooperativeLevel: () => S_OK, GetAvailableTextureMem: () => 512 << 20, EvictManagedResources: () => S_OK,
    GetDirect3D: (x, self, pp) => { const d = o(self).d3d; o(d).ref++; x.w32(pp, d); return S_OK; },
    GetDeviceCaps: (x, self, p) => { x.write(p, model(x).getDeviceCaps()); return S_OK; },
    GetDisplayMode: (x, self, sw, p) => { const q = o(self).params; x.w32(p, q.width); x.w32(p + 4, q.height); x.w32(p + 8, 60); x.w32(p + 12, q.backBufferFormat); return S_OK; },
    GetCreationParameters: (x, self, p) => { const c = o(self).created; c.forEach((v, i) => x.w32(p + 4 * i, v)); return S_OK; },
    SetCursorProperties: () => S_OK, SetCursorPosition: () => 0, ShowCursor: () => 0, SetDialogBoxMode: () => S_OK,
    SetGammaRamp: () => 0, GetGammaRamp: (x, self, sw, p) => { for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) x.w16(p + c * 512 + i * 2, i * 257); return 0; },
    GetNumberOfSwapChains: () => 1,
    GetRasterStatus: (x, self, sw, p) => { x.w32(p, 0); x.w32(p + 4, 0); return S_OK; },
    Reset: (x, self, pp) => { const r = (k) => x.r32(pp + 4 * k), q = o(self).params; q.width = r(0) || q.width; q.height = r(1) || q.height; D(self).reset({ ...q }); return S_OK; },
    // Present: a vsynced swap with one frame in flight, as gdi32's SwapBuffers (api.js).
    Present: (x, self) => {
      const now = x.lx.mono();
      if (lastPresent >= 0 && now < lastPresent + 1 / 60) return x.waitUntil(lastPresent + 1 / 60);
      if (x.backend.swapReady && !x.backend.swapReady()) return x.waitUntil(now + 0.002);
      lastPresent = now;
      D(self).present();
      if (x.backend.swap) x.backend.swap();
      return S_OK;
    },
    GetBackBuffer: (x, self, sw, i, type, pp) => { const q = o(self).params; x.w32(pp, byHandle(x, D(self), D(self).getBackBuffer(sw, i), 'IDirect3DSurface9', { devPtr: self, w: q.width, h2: q.height, format: q.backBufferFormat, usage: 1 })); return S_OK; },
    CreateTexture: (x, self, w, hh, levels, usage, fmt, pool, pp) => {
      let n = levels; if (!n) { n = 1; while ((w >> n) || (hh >> n)) n++; }
      x.w32(pp, res(x, self, 'IDirect3DTexture9', D(self).createTexture(w, hh, levels, usage, fmt, pool), { w, h2: hh, levels: n, usage, format: fmt, pool })); return S_OK;
    },
    CreateVertexBuffer: (x, self, len, usage, fvf, pool, pp) => { x.w32(pp, res(x, self, 'IDirect3DVertexBuffer9', D(self).createVertexBuffer(len, usage, fvf, pool), { length: len, usage, fvf, pool, format: 100 })); return S_OK; },
    CreateIndexBuffer: (x, self, len, usage, fmt, pool, pp) => { x.w32(pp, res(x, self, 'IDirect3DIndexBuffer9', D(self).createIndexBuffer(len, usage, fmt, pool), { length: len, usage, pool, format: fmt })); return S_OK; },
    CreateRenderTarget: (x, self, w, hh, fmt, ms, q, lockable, pp) => { x.w32(pp, res(x, self, 'IDirect3DSurface9', D(self).createRenderTarget(w, hh, fmt, ms, q, lockable), { w, h2: hh, format: fmt, usage: 1 })); return S_OK; },
    CreateDepthStencilSurface: (x, self, w, hh, fmt, ms, q, discard, pp) => { x.w32(pp, res(x, self, 'IDirect3DSurface9', D(self).createDepthStencilSurface(w, hh, fmt, ms, q, discard), { w, h2: hh, format: fmt, usage: 2 })); return S_OK; },
    StretchRect: (x, self, src, pSr, dst, pDr, filter) => {
      const rect = (p) => (p ? [x.r32(p) | 0, x.r32(p + 4) | 0, x.r32(p + 8) | 0, x.r32(p + 12) | 0] : null);
      return D(self).stretchRect(h(src), rect(pSr), h(dst), rect(pDr), filter) || S_OK;
    },
    SetRenderTarget: (x, self, i, s) => D(self).setRenderTarget(i, h(s)) || S_OK,
    GetRenderTarget: (x, self, i, pp) => { const hd = D(self).getRenderTarget(i), q = o(self).params; x.w32(pp, byHandle(x, D(self), hd, 'IDirect3DSurface9', { devPtr: self, w: q.width, h2: q.height, format: q.backBufferFormat, usage: 1 })); return hd ? S_OK : 0x8876086c; },
    SetDepthStencilSurface: (x, self, s) => D(self).setDepthStencilSurface(h(s)) || S_OK,
    GetDepthStencilSurface: (x, self, pp) => { const hd = D(self).getDepthStencilSurface(), q = o(self).params; x.w32(pp, byHandle(x, D(self), hd, 'IDirect3DSurface9', { devPtr: self, w: q.width, h2: q.height, format: q.autoDepthStencilFormat, usage: 2 })); return hd ? S_OK : 0x8876086c; },
    BeginScene: (x, self) => D(self).beginScene() || S_OK,
    EndScene: (x, self) => D(self).endScene() || S_OK,
    Clear: (x, self, count, pRects, flags, color, z, stencil) => {
      const rects = count && pRects ? Array.from({ length: count }, (_, i) => [0, 4, 8, 12].map((k) => x.r32(pRects + 16 * i + k) | 0)) : null;
      return D(self).clear(rects, flags, color >>> 0, z, stencil) || S_OK;
    },
    SetTransform: (x, self, st2, p) => D(self).setTransform(st2, floats(x, p, 16)) || S_OK,
    SetViewport: (x, self, p) => D(self).setViewport({ x: x.r32(p), y: x.r32(p + 4), width: x.r32(p + 8), height: x.r32(p + 12), minZ: x.f32(p + 16), maxZ: x.f32(p + 20) }) || S_OK,
    GetViewport: (x, self, p) => { const v = D(self).getViewport ? D(self).getViewport() : null, q = o(self).params;
      const r = v || { x: 0, y: 0, width: q.width, height: q.height, minZ: 0, maxZ: 1 };
      [r.x, r.y, r.width, r.height].forEach((v2, i) => x.w32(p + 4 * i, v2)); const f = new DataView(new ArrayBuffer(8)); f.setFloat32(0, r.minZ, true); f.setFloat32(4, r.maxZ, true);
      x.w32(p + 16, f.getUint32(0, true)); x.w32(p + 20, f.getUint32(4, true)); return S_OK; },
    SetRenderState: (x, self, s, v) => D(self).setRenderState(s, v >>> 0) || S_OK,
    GetRenderState: (x, self, s, p) => { x.w32(p, D(self).getRenderState ? D(self).getRenderState(s) : 0); return S_OK; },
    SetTexture: (x, self, stage, t) => D(self).setTexture(stage, h(t)) || S_OK,
    SetTextureStageState: (x, self, s, t, v) => D(self).setTextureStageState(s, t, v >>> 0) || S_OK,
    SetSamplerState: (x, self, s, t, v) => D(self).setSamplerState(s, t, v >>> 0) || S_OK,
    ValidateDevice: (x, self, p) => { x.w32(p, 1); return S_OK; },
    SetScissorRect: (x, self, p) => D(self).setScissorRect(x.r32(p) | 0, x.r32(p + 4) | 0, x.r32(p + 8) | 0, x.r32(p + 12) | 0) || S_OK,
    SetSoftwareVertexProcessing: () => S_OK, GetSoftwareVertexProcessing: () => 0,
    DrawPrimitive: (x, self, type, start, n) => D(self).drawPrimitive(type, start, n) || S_OK,
    DrawIndexedPrimitive: (x, self, ...a) => D(self).drawIndexedPrimitive(...a) || S_OK,
    DrawPrimitiveUP: (x, self, type, n, p, stride) => D(self).drawPrimitiveUP(type, n, x.bytes(p, VERTS[type](n) * stride), stride) || S_OK,
    DrawIndexedPrimitiveUP: (x, self, type, minIndex, numVerts, n, pIdx, ifmt, pV, stride) =>
      D(self).drawIndexedPrimitiveUP(type, minIndex, numVerts, n, x.bytes(pIdx, VERTS[type](n) * (ifmt === 102 ? 4 : 2)), ifmt, x.bytes(pV, (minIndex + numVerts) * stride), stride) || S_OK,
    // D3DVERTEXELEMENT9s to D3DDECL_END (stream 0xFF).
    CreateVertexDeclaration: (x, self, p, pp) => {
      const els = []; let n = 0;
      for (; n < 64 && x.r16(p + 8 * n) !== 0xff; n++) {
        const e = p + 8 * n;
        els.push({ stream: x.r16(e), offset: x.r16(e + 2), type: x.r8(e + 4), method: x.r8(e + 5), usage: x.r8(e + 6), usageIndex: x.r8(e + 7) });
      }
      x.w32(pp, res(x, self, 'IDirect3DVertexDeclaration9', D(self).createVertexDeclaration(els), { bytes: x.bytes(p, 8 * (n + 1)) })); return S_OK;
    },
    SetVertexDeclaration: (x, self, d) => D(self).setVertexDeclaration(h(d)) || S_OK,
    SetFVF: (x, self, fvf) => D(self).setFVF(fvf) || S_OK,
    CreateVertexShader: (x, self, p, pp) => { const t = shaderTokens(x, p); x.w32(pp, res(x, self, 'IDirect3DVertexShader9', D(self).createVertexShader(t), { tokens: t })); return S_OK; },
    CreatePixelShader: (x, self, p, pp) => { const t = shaderTokens(x, p); x.w32(pp, res(x, self, 'IDirect3DPixelShader9', D(self).createPixelShader(t), { tokens: t })); return S_OK; },
    SetVertexShader: (x, self, s) => D(self).setVertexShader(h(s)) || S_OK,
    SetPixelShader: (x, self, s) => D(self).setPixelShader(h(s)) || S_OK,
    SetVertexShaderConstantF: (x, self, start, p, n) => D(self).setVertexShaderConstantF(start, floats(x, p, 4 * n)) || S_OK,
    SetVertexShaderConstantI: (x, self, start, p, n) => D(self).setVertexShaderConstantI(start, new Int32Array(u32s(x, p, 4 * n).buffer)) || S_OK,
    SetVertexShaderConstantB: (x, self, start, p, n) => D(self).setVertexShaderConstantB(start, u32s(x, p, n)) || S_OK,
    SetPixelShaderConstantF: (x, self, start, p, n) => D(self).setPixelShaderConstantF(start, floats(x, p, 4 * n)) || S_OK,
    SetPixelShaderConstantI: (x, self, start, p, n) => D(self).setPixelShaderConstantI(start, new Int32Array(u32s(x, p, 4 * n).buffer)) || S_OK,
    SetPixelShaderConstantB: (x, self, start, p, n) => D(self).setPixelShaderConstantB(start, u32s(x, p, n)) || S_OK,
    SetStreamSource: (x, self, n, b, off, stride) => D(self).setStreamSource(n, h(b), off, stride) || S_OK,
    SetStreamSourceFreq: () => S_OK,
    SetIndices: (x, self, b) => D(self).setIndices(h(b)) || S_OK,
    // Queries: an event is done as soon as it is asked; others are not here.
    CreateQuery: (x, self, type, pp) => { if (type !== 8) return D3DERR_NOTAVAILABLE; if (pp) x.w32(pp, make(x, 'IDirect3DQuery9', { type, devPtr: self })); return S_OK; },
  };

  // ---- D3DX ---------------------------------------------------------------------------------------
  const blobObj = (x, u8) => { const d = galloc(x, u8.length); x.write(d, u8); return make(x, 'ID3DXBuffer', { ptr: d, size: u8.length }); };
  const xbuffer = { GetBufferPointer: (x, self) => o(self).ptr, GetBufferSize: (x, self) => o(self).size };
  const CLASS = { 0: 0, 1: 0, 2: 2, 3: 3 };
  const ctab = {
    GetBufferPointer: (x, self) => o(self).ptr, GetBufferSize: (x, self) => o(self).size,
    GetDesc: (x, self, p) => { x.w32(p, 0); x.w32(p + 4, o(self).version); x.w32(p + 8, o(self).consts.length); return S_OK; },
    GetConstantByName: (x, self, hc, name) => { const s = x.str(name), i = o(self).consts.findIndex((c) => c.name === s); return i < 0 ? 0 : i + 1; },
    GetConstant: (x, self, hc, i) => (i < o(self).consts.length ? i + 1 : 0),
    GetConstantElement: (x, self, hc, i) => hc,
    GetSamplerIndex: (x, self, hc) => o(self).consts[hc - 1]?.regIndex ?? -1,
    // D3DXCONSTANT_DESC: Name, RegisterSet, RegisterIndex, RegisterCount, Class, Type, Rows, Columns, Elements, StructMembers, Bytes, DefaultValue.
    GetConstantDesc: (x, self, hc, p, pCount) => {
      const c = o(self).consts[hc - 1]; if (!c) return D3DERR_INVALIDCALL;
      if (p) { x.write(p, new Uint8Array(48)); x.w32(p + 4, c.regSet); x.w32(p + 8, c.regIndex); x.w32(p + 12, c.regCount); x.w32(p + 16, c.rows > 1 ? 3 : c.columns > 1 ? 1 : 0);
        x.w32(p + 20, c.type ?? 3); x.w32(p + 24, c.rows || 1); x.w32(p + 28, c.columns || 1); x.w32(p + 32, 1); x.w32(p + 40, 4 * (c.rows || 1) * (c.columns || 1)); }
      if (pCount) x.w32(pCount, 1); return S_OK;
    },
    SetDefaults: () => S_OK,
  };
  // A constant's registers set on the device the table's shader runs on: four floats a register; a
  // matrix as fxc packs it by default (column-major: register i holds column i).
  const setRegs = (x, self, dev, hc, f4) => {
    const t = o(self), c = t.consts[hc - 1]; if (!c) return D3DERR_INVALIDCALL;
    const d = D(dev), n = Math.min(c.regCount, f4.length / 4), data = f4.subarray(0, 4 * n);
    if (c.regSet === 2) (t.ps ? d.setPixelShaderConstantF : d.setVertexShaderConstantF).call(d, c.regIndex, data);
    else if (c.regSet === 1) (t.ps ? d.setPixelShaderConstantI : d.setVertexShaderConstantI).call(d, c.regIndex, Int32Array.from(data));
    else if (c.regSet === 0) (t.ps ? d.setPixelShaderConstantB : d.setVertexShaderConstantB).call(d, c.regIndex, Uint32Array.from(data.filter((v, i) => i % 4 === 0)));
    return S_OK;
  };
  const vec4 = (vals) => { const f = new Float32Array(Math.ceil(vals.length / 4) * 4); f.set(vals); return f; };
  const matRegs = (m, transpose) => { const f = new Float32Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) f[r * 4 + c] = transpose ? m[c * 4 + r] : m[r * 4 + c]; return f; };
  Object.assign(ctab, {
    SetFloat: (x, self, dev, hc, v) => setRegs(x, self, dev, hc, vec4([v])),
    SetInt: (x, self, dev, hc, v) => setRegs(x, self, dev, hc, vec4([v | 0])),
    SetBool: (x, self, dev, hc, v) => setRegs(x, self, dev, hc, vec4([v ? 1 : 0])),
    SetVector: (x, self, dev, hc, p) => setRegs(x, self, dev, hc, floats(x, p, 4)),
    SetValue: (x, self, dev, hc, p, n) => setRegs(x, self, dev, hc, vec4(floats(x, p, n >>> 2))),
    SetFloatArray: (x, self, dev, hc, p, n) => setRegs(x, self, dev, hc, Float32Array.from({ length: 4 * n }, (_, i) => (i % 4 ? 0 : x.f32(p + i)))),
    SetVectorArray: (x, self, dev, hc, p, n) => setRegs(x, self, dev, hc, floats(x, p, 4 * n)),
    SetMatrix: (x, self, dev, hc, p) => setRegs(x, self, dev, hc, matRegs(floats(x, p, 16), true)),
    SetMatrixTranspose: (x, self, dev, hc, p) => setRegs(x, self, dev, hc, matRegs(floats(x, p, 16), false)),
  });
  const d3dxCompile = (x, src, srcLen, pDefines, pInclude, pEntry, pProfile, flags, ppShader, ppErrors, ppTable) => {
    let defs = '';
    for (let d = pDefines; d && x.r32(d); d += 8) defs += `#define ${x.str(x.r32(d))} ${x.str(x.r32(d + 4))}\n`;
    const profile = x.str(pProfile), entry = x.str(pEntry), blob = hlslBlob(profile, entry, defs + x.strN(src, srcLen));
    const bytes = new Uint8Array(blob.buffer), buf = blobObj(x, bytes);
    x.w32(ppShader, buf);
    if (ppErrors) x.w32(ppErrors, 0);
    if (ppTable) {
      const m = model(x), consts = m.hlslConstants ? m.hlslConstants(blob) : [];
      x.w32(ppTable, make(x, 'ID3DXConstantTable', { consts, ps: profile.startsWith('ps'), version: blob[0], ptr: o(buf).ptr, size: bytes.length }));
    }
    return S_OK;
  };
  const prof = (s) => (x) => { const p = x.win.heapAlloc(8); x.write(p, new TextEncoder().encode(s + '\0')); return p; };
  const d3dx = {
    D3DXCompileShader: ['puppppuppp', d3dxCompile],
    D3DXGetPixelShaderProfile: ['p', prof('ps_3_0')], D3DXGetVertexShaderProfile: ['p', prof('vs_3_0')],
    D3DXGetShaderVersion: ['p', (x, p) => x.r32(p)],
    ...d3dxMath(),
  };

  // ---- the DLLs: each method a stub of d3d9.dll's, named for its interface ------------------------------
  const IMPL = {
    IDirect3D9: d3d9, IDirect3DDevice9: device, IDirect3DTexture9: { ...resource, ...texture }, IDirect3DSurface9: { ...resource, ...surface },
    IDirect3DVertexBuffer9: { ...resource, ...buffer }, IDirect3DIndexBuffer9: { ...resource, ...buffer },
    IDirect3DVertexShader9: shaderObj, IDirect3DPixelShader9: shaderObj, IDirect3DVertexDeclaration9: shaderObj, IDirect3DQuery9: query,
    ID3DXBuffer: xbuffer, ID3DXConstantTable: ctab,
  };
  const fns = {
    Direct3DCreate9: ['u', (x, sdk) => make(x, 'IDirect3D9')],
    D3DPERF_BeginEvent: ['up', () => 0], D3DPERF_EndEvent: ['', () => 0], D3DPERF_SetMarker: ['up', () => 0], D3DPERF_GetStatus: ['', () => 0],
    D3DPERF_SetOptions: ['u', () => 0],
  };
  let ord = 1000;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, s] of ms) {
    const f = unknown[n] || IMPL[iface][n] || NOT(iface, n);
    fns[`${iface}::${n}`] = [sigOf(s), f, { ordinal: ord++ }];
  }
  const out = [{ dll: 'd3d9.dll', fns }];
  for (let v = 24; v <= 43; v++) out.push({ dll: `d3dx9_${v}.dll`, fns: d3dx });
  return out;
}

/** D3DX's math, as d3dx9math.h defines it: row vectors, row-major matrices, left- and right-handed. */
function d3dxMath() {
  const rd = (x, p) => Array.from({ length: 16 }, (_, i) => x.f32(p + 4 * i));
  const wf = (x, p, vals) => { const f = new Float32Array(vals), u = new Uint32Array(f.buffer); u.forEach((v, i) => x.w32(p + 4 * i, v)); return p; };
  const vec = (x, p, n) => Array.from({ length: n }, (_, i) => x.f32(p + 4 * i));
  const mul = (a, b) => { const r = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j]; return r; };
  const norm = (v) => { const l = Math.hypot(...v); return l ? v.map((c) => c / l) : v.map(() => 0); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a.reduce((s, c, i) => s + c * b[i], 0);
  const lookAt = (eye, z, up) => { const xa = norm(cross(up, z)), ya = cross(z, xa);
    return [xa[0], ya[0], z[0], 0, xa[1], ya[1], z[1], 0, xa[2], ya[2], z[2], 0, -dot(xa, eye), -dot(ya, eye), -dot(z, eye), 1]; };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  const inverse = (m) => {
    const a = [...m], inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let det = 1;
    for (let c = 0; c < 4; c++) {
      let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 4 + c]) > Math.abs(a[p * 4 + c])) p = r;
      if (!a[p * 4 + c]) return [null, 0];
      if (p !== c) { for (let k = 0; k < 4; k++) { [a[c * 4 + k], a[p * 4 + k]] = [a[p * 4 + k], a[c * 4 + k]]; [inv[c * 4 + k], inv[p * 4 + k]] = [inv[p * 4 + k], inv[c * 4 + k]]; } det = -det; }
      const d = a[c * 4 + c]; det *= d;
      for (let k = 0; k < 4; k++) { a[c * 4 + k] /= d; inv[c * 4 + k] /= d; }
      for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r * 4 + c]; for (let k = 0; k < 4; k++) { a[r * 4 + k] -= f * a[c * 4 + k]; inv[r * 4 + k] -= f * inv[c * 4 + k]; } }
    }
    return [inv, det];
  };
  const M = (sig, f) => [sig, (x, out, ...a) => wf(x, out, f(x, ...a))];
  return {
    D3DXMatrixIdentity: M('p', () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    D3DXMatrixMultiply: M('ppp', (x, a, b) => mul(rd(x, a), rd(x, b))),
    D3DXMatrixMultiplyTranspose: M('ppp', (x, a, b) => { const m = mul(rd(x, a), rd(x, b)); return m.map((_, i) => m[(i % 4) * 4 + (i >> 2)]); }),
    D3DXMatrixTranspose: M('pp', (x, a) => { const m = rd(x, a); return m.map((_, i) => m[(i % 4) * 4 + (i >> 2)]); }),
    D3DXMatrixInverse: ['ppp', (x, out, pDet, a) => { const [inv, det] = inverse(rd(x, a)); if (pDet) wf(x, pDet, [det]); return inv ? wf(x, out, inv) : 0; }],
    D3DXMatrixTranslation: M('pfff', (x, tx, ty, tz) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]),
    D3DXMatrixScaling: M('pfff', (x, sx, sy, sz) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]),
    D3DXMatrixRotationX: M('pf', (x, a) => rotX(a)), D3DXMatrixRotationY: M('pf', (x, a) => rotY(a)), D3DXMatrixRotationZ: M('pf', (x, a) => rotZ(a)),
    D3DXMatrixRotationYawPitchRoll: M('pfff', (x, yaw, pitch, roll) => mul(mul(rotZ(roll), rotX(pitch)), rotY(yaw))),
    D3DXMatrixRotationAxis: M('ppf', (x, pv, a) => {
      const [u, v, w] = norm(vec(x, pv, 3)), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
      return [t * u * u + c, t * u * v + s * w, t * u * w - s * v, 0, t * u * v - s * w, t * v * v + c, t * v * w + s * u, 0,
        t * u * w + s * v, t * v * w - s * u, t * w * w + c, 0, 0, 0, 0, 1];
    }),
    D3DXMatrixLookAtLH: M('pppp', (x, e, at, up) => { const eye = vec(x, e, 3); return lookAt(eye, norm(vec(x, at, 3).map((c, i) => c - eye[i])), vec(x, up, 3)); }),
    D3DXMatrixLookAtRH: M('pppp', (x, e, at, up) => { const eye = vec(x, e, 3); return lookAt(eye, norm(eye.map((c, i) => c - x.f32(at + 4 * i))), vec(x, up, 3)); }),
    D3DXMatrixPerspectiveFovLH: M('pffff', (x, fovy, asp, zn, zf) => { const ys = 1 / Math.tan(fovy / 2); return [ys / asp, 0, 0, 0, 0, ys, 0, 0, 0, 0, zf / (zf - zn), 1, 0, 0, -zn * zf / (zf - zn), 0]; }),
    D3DXMatrixPerspectiveFovRH: M('pffff', (x, fovy, asp, zn, zf) => { const ys = 1 / Math.tan(fovy / 2); return [ys / asp, 0, 0, 0, 0, ys, 0, 0, 0, 0, zf / (zn - zf), -1, 0, 0, zn * zf / (zn - zf), 0]; }),
    D3DXMatrixPerspectiveLH: M('pffff', (x, w, hh, zn, zf) => [2 * zn / w, 0, 0, 0, 0, 2 * zn / hh, 0, 0, 0, 0, zf / (zf - zn), 1, 0, 0, zn * zf / (zn - zf), 0]),
    D3DXMatrixOrthoLH: M('pffff', (x, w, hh, zn, zf) => [2 / w, 0, 0, 0, 0, 2 / hh, 0, 0, 0, 0, 1 / (zf - zn), 0, 0, 0, zn / (zn - zf), 1]),
    D3DXMatrixOrthoOffCenterLH: M('pffffff', (x, l, r, b, t, zn, zf) => [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, 1 / (zf - zn), 0,
      (l + r) / (l - r), (t + b) / (b - t), zn / (zn - zf), 1]),
    D3DXVec3Normalize: M('pp', (x, v) => norm(vec(x, v, 3))),
    D3DXVec3TransformCoord: M('ppp', (x, v, pm) => { const [a, b, c] = vec(x, v, 3), m = rd(x, pm), r = [0, 1, 2, 3].map((j) => a * m[j] + b * m[4 + j] + c * m[8 + j] + m[12 + j]); return r.slice(0, 3).map((q) => q / r[3]); }),
    D3DXVec3TransformNormal: M('ppp', (x, v, pm) => { const [a, b, c] = vec(x, v, 3), m = rd(x, pm); return [0, 1, 2].map((j) => a * m[j] + b * m[4 + j] + c * m[8 + j]); }),
    D3DXVec3Transform: M('ppp', (x, v, pm) => { const [a, b, c] = vec(x, v, 3), m = rd(x, pm); return [0, 1, 2, 3].map((j) => a * m[j] + b * m[4 + j] + c * m[8 + j] + m[12 + j]); }),
    D3DXVec4Transform: M('ppp', (x, v, pm) => { const q = vec(x, v, 4), m = rd(x, pm); return [0, 1, 2, 3].map((j) => q.reduce((s, c, k) => s + c * m[k * 4 + j], 0)); }),
  };
}
