// d3d7.js — Direct3D 7 for MIRAGE-WIN32: the interfaces a program reaches from IDirectDraw7
// (QueryInterface for IID_IDirect3D7), made on the same device model as Direct3D 8 and 9 (PRISM's
// src/env/d3d9.js in a page, recordD3D9() headless). ddraw.js keeps the surfaces -- the flip chain the
// device renders into, its z-buffer, the textures and their mipmap levels, all memory of the program's --
// and this file turns what Direct3D 7 says into what the model takes:
//
//   - the device is the model's, its back buffer the flip chain's, a depth buffer if one is attached;
//     a Flip of the primary (or a copy of the back buffer onto it) presents;
//   - a texture is the top surface of a mipmap chain: what the program wrote into its levels (Lock,
//     Blt, Load) goes to the model as A8R8G8B8 at the next SetTexture, converted by the pixel format's
//     masks -- PRISM's model has no 16-bit formats, which is what Direct3D 7 games use;
//   - DrawPrimitive and its indexed and vertex-buffer forms take a vertex count where Direct3D 9 takes
//     primitives, and an FVF with each call;
//   - render states are Direct3D 9's numbers where both have them; the texture stage states 12 to 21
//     (addressing, filters, LOD) are Direct3D 9's sampler states, the filters with other values.
//
// Layouts are d3d.h, d3dtypes.h and d3dcaps.h (Wine's include/ the oracle). Unreal Tournament's
// D3DDrv.dll (1999) is the first program here to use it.

export const D3D7_VTABLES = {
  IDirect3D7: 'QueryInterface:2 AddRef:0 Release:0 EnumDevices:2 CreateDevice:3 CreateVertexBuffer:3 EnumZBufferFormats:3 EvictManagedTextures:0',
  IDirect3DDevice7: `QueryInterface:2 AddRef:0 Release:0 GetCaps:1 EnumTextureFormats:2 BeginScene:0 EndScene:0 GetDirect3D:1
    SetRenderTarget:2 GetRenderTarget:1 Clear:upuufu SetTransform:2 GetTransform:2 SetViewport:1 MultiplyTransform:2 GetViewport:1
    SetMaterial:1 GetMaterial:1 SetLight:2 GetLight:2 SetRenderState:2 GetRenderState:2 BeginStateBlock:0 EndStateBlock:1
    PreLoad:1 DrawPrimitive:5 DrawIndexedPrimitive:7 SetClipStatus:1 GetClipStatus:1 DrawPrimitiveStrided:5
    DrawIndexedPrimitiveStrided:7 DrawPrimitiveVB:5 DrawIndexedPrimitiveVB:7 ComputeSphereVisibility:5 GetTexture:2
    SetTexture:2 GetTextureStageState:3 SetTextureStageState:3 ValidateDevice:1 ApplyStateBlock:1 CaptureStateBlock:1
    DeleteStateBlock:1 CreateStateBlock:2 Load:5 LightEnable:2 GetLightEnable:2 SetClipPlane:2 GetClipPlane:2 GetInfo:3`,
  IDirect3DVertexBuffer7: 'QueryInterface:2 AddRef:0 Release:0 Lock:3 Unlock:0 ProcessVertices:7 GetVertexBufferDesc:1 Optimize:2 ProcessVerticesStrided:7',
};

export const IID_D3D7 = {
  'f5049e77-4861-11d2-a407-00a0c90629a8': 'IDirect3D7',
  '84e63de0-46aa-11cf-816f-0000c020156e': 'HAL', 'f5049e78-4861-11d2-a407-00a0c90629a8': 'TnLHAL', 'a4665c60-2673-11cf-a31a-00aa00b93356': 'RGB',
};
const HAL_GUID = [0x84e63de0, 0x11cf46aa, 0x00006f81, 0x6e15c020];

const D3D_OK = 0, DDERR_INVALIDPARAMS = 0x80070057, D3DERR_INVALIDCALL = 0x8876086c;

// Vertices a count of primitives takes, and the other way round: D3DPRIMITIVETYPE 1 points .. 6 fan.
const PRIMS = [0, (n) => n, (n) => n >> 1, (n) => n - 1, (n) => (n / 3) | 0, (n) => n - 2, (n) => n - 2];

// The render states Direct3D 9 has under the same number and meaning (d3d9types.h). The others are
// Direct3D 7's own -- the legacy texture handle and its filters, stipples, colour keying, the z bias --
// and stay here. D3DRS_FOGENABLE is kept back: PRISM's fixed function has no fog yet.
const SAME_RS = new Set([7, 8, 9, 14, 15, 16, 19, 20, 22, 23, 24, 25, 26, 27, 29, 34, 35, 36, 37, 38, 48,
  52, 53, 54, 55, 56, 57, 58, 59, 60, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 139, 140, 141, 142, 143,
  145, 146, 147, 148, 151, 152]);
// Texture stage states that became sampler states, with Direct3D 7's filter values in Direct3D 9's:
// MAGFILTER D3DTFG_ POINT 1 LINEAR 2 FLATCUBIC 3 GAUSSIANCUBIC 4 ANISOTROPIC 5; MINFILTER D3DTFN_ POINT 1
// LINEAR 2 ANISOTROPIC 3; MIPFILTER D3DTFP_ NONE 1 POINT 2 LINEAR 3 -- to D3DTEXF_ NONE 0 POINT 1 LINEAR 2
// ANISOTROPIC 3.
const TSS_SAMPLER = {
  13: [1], 14: [2], 12: [1, 2], 15: [4], 19: [8], 20: [9], 21: [10],
  16: [5, (v) => [0, 1, 2, 2, 2, 3][v] ?? 2], 17: [6, (v) => [0, 1, 2, 3][v] ?? 2], 18: [7, (v) => [0, 0, 1, 2][v] ?? 0],
};

/**
 * The Direct3D 7 interfaces, on ddraw.js's objects: `dd` is what it lends -- o (the object at a
 * pointer), make, as, st, send, and texels(x, surface) (a surface's pixels as B, G, R, A bytes).
 */
export function d3d7Impl(dd) {
  const { o, make, st, send } = dd;
  let model = null, lastPresent = -1;
  const modelOf = (x) => model || (model = x.backend.d3d9 ? x.backend.d3d9() : dd.record());
  const devices = new Set();
  const D = (self) => o(self).dev;
  const floats = (x, p, n) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = x.f32(p + 4 * i); return f; };
  const wf = (x, p, v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); x.w32(p, b.getUint32(0, true)); };

  // D3DDEVICEDESC7 (236 bytes): a card of 2000 with hardware rasterization and no T&L, its primitive caps
  // (D3DPRIMCAPS, 56 bytes) for lines and triangles alike.
  const putDeviceDesc = (x, p) => {
    x.write(p, new Uint8Array(236));
    x.w32(p, 0x1 | 0x10 | 0x40 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x8000 | 0x80000);   // dwDevCaps
    for (const q of [p + 4, p + 60]) {
      x.w32(q, 56);
      x.w32(q + 4, 0x2 | 0x10 | 0x20 | 0x40);                         // misc: MASKZ, CULLNONE, CULLCW, CULLCCW
      x.w32(q + 8, 0x1 | 0x10 | 0x80 | 0x100 | 0x2000 | 0x4000 | 0x10000 | 0x20000 | 0x100000 | 0x200000);   // raster: dither, z test, fog, LOD bias, z bias, anisotropy, w/z fog
      x.w32(q + 12, 0xff); x.w32(q + 16, 0x1fff); x.w32(q + 20, 0x1fff); x.w32(q + 24, 0xff);   // z compare, blends, alpha compare
      x.w32(q + 28, 0x1ffff);                                        // shade
      x.w32(q + 32, 0x1 | 0x2 | 0x4 | 0x8 | 0x400);                   // texture: perspective, pow2, alpha, transparency, projected
      x.w32(q + 36, 0x0303073f);                                     // filters
      x.w32(q + 40, 0xff); x.w32(q + 44, 0x1f);                       // legacy blend, address
    }
    x.w32(p + 116, 0x400 | 0x100);                                   // render depths: DDBD_16, DDBD_32
    x.w32(p + 120, 0x400 | 0x200 | 0x100);                           // z depths: 16, 24, 32
    x.w32(p + 124, 1); x.w32(p + 128, 1); x.w32(p + 132, 2048); x.w32(p + 136, 2048);
    x.w32(p + 140, 2048); x.w32(p + 144, 2048); x.w32(p + 148, 16);
    x.w32(p + 172, 0xff); x.w32(p + 176, 8); x.w32(p + 180, 0xffffff);   // stencil, FVF (8 coordinate sets), texture ops
    x.w16(p + 184, 8); x.w16(p + 186, 4); x.w32(p + 188, 8);              // blend stages, textures at once, lights
    wf(x, p + 192, 1e10);
    HAL_GUID.forEach((v, i) => x.w32(p + 196 + 4 * i, v));
    x.w16(p + 212, 6); x.w16(p + 214, 0); x.w32(p + 216, 0x3f);
  };
  // DDPIXELFORMAT (32 bytes): RGB with its masks, and DDPF_ALPHAPIXELS with an alpha mask.
  const putPixelFormat = (x, p, bits, r, g, b, a) => {
    x.write(p, new Uint8Array(32)); x.w32(p, 32); x.w32(p + 4, 0x40 | (a ? 1 : 0)); x.w32(p + 12, bits);
    x.w32(p + 16, r); x.w32(p + 20, g); x.w32(p + 24, b); x.w32(p + 28, a);
  };
  // The texture formats offered: 5:6:5, 1:5:5:5, 4:4:4:4, 8:8:8:8 -- no palettes.
  const TEX_FORMATS = [[16, 0xf800, 0x7e0, 0x1f, 0], [16, 0x7c00, 0x3e0, 0x1f, 0x8000], [16, 0xf00, 0xf0, 0xf, 0xf000],
    [32, 0xff0000, 0xff00, 0xff, 0xff000000], [32, 0xff0000, 0xff00, 0xff, 0]];

  // A texture's model texture: made the first time it is set, its levels sent again when written since.
  const textureOf = (x, dev, top) => {
    const t = o(top); if (!t) return 0;
    const mips = t.mips || [top];
    if (!t.model || t.model.dev !== dev) t.model = { dev, h: dev.createTexture(t.w, t.h, mips.length, 0, 21, 1) }, mips.forEach((m) => { o(m).dirty = true; });
    mips.forEach((m, l) => {
      const s = o(m); if (!s.dirty) return;
      s.dirty = false;
      dev.textureWrite(t.model.h, l, null, dd.texels(x, s), s.w * 4);
    });
    return t.model.h;
  };

  // Present: the model's picture to the screen, at most 60 times a second, as Direct3D 9's Present.
  const present = (x) => {
    const dev = [...devices][0]; if (!dev) return null;
    const now = x.lx.mono();
    if (lastPresent >= 0 && now < lastPresent + 1 / 60) return x.waitUntil(lastPresent + 1 / 60);
    if (x.backend.swapReady && !x.backend.swapReady()) return x.waitUntil(now + 0.002);
    lastPresent = now;
    o(dev).dev.present();
    if (x.backend.swap) x.backend.swap();
    return D3D_OK;
  };

  // Vertices from the program's memory: `n` of the FVF's size `size`, from `p`.
  const verts = (x, p, n, size) => x.bytes(p, n * size);
  const draw = (x, self, type, fvf, bytes, n) => {
    const dev = D(self), prims = PRIMS[type] ? PRIMS[type](n) : 0;
    if (prims <= 0) return D3D_OK;
    if (o(self).fvf !== fvf) { o(self).fvf = fvf; dev.setFVF(fvf); }
    dev.drawPrimitiveUP(type, prims, bytes, dd.fvfSize(fvf));
    return D3D_OK;
  };
  const drawIndexed = (x, self, type, fvf, bytes, nv, idx, ni) => {
    const dev = D(self), prims = PRIMS[type] ? PRIMS[type](ni) : 0;
    if (prims <= 0) return D3D_OK;
    if (o(self).fvf !== fvf) { o(self).fvf = fvf; dev.setFVF(fvf); }
    dev.drawIndexedPrimitiveUP(type, 0, nv, prims, idx, 101, bytes, dd.fvfSize(fvf));
    return D3D_OK;
  };

  const IDirect3D7 = {
    // One device, the HAL: (description, name, D3DDEVICEDESC7, context), stdcall.
    EnumDevices: (x, self, cb, ctx) => {
      const p = x.win.heapAlloc(400), enc = (s) => new TextEncoder().encode(`${s}\0`);
      x.write(p, enc('Microsoft Direct3D Hardware acceleration through Direct3D HAL')); x.write(p + 128, enc('Direct3D HAL'));
      putDeviceDesc(x, p + 160);
      return send(x, [{ fn: cb, args: [p, p + 128, p + 160, ctx] }], () => D3D_OK, 12);
    },
    // EnumZBufferFormats(device IID, callback(DDPIXELFORMAT, context), context): 16, 24 and 24 with 8 of stencil.
    EnumZBufferFormats: (x, self, riid, cb, ctx) => {
      const calls = [[16, 0xffff, 0], [24, 0xffffff, 0], [32, 0xffffff, 0xff000000]].map(([bits, z, s]) => {
        const p = x.win.heapAlloc(32); x.write(p, new Uint8Array(32)); x.w32(p, 32);
        x.w32(p + 4, 0x400 | (s ? 0x4000 : 0)); x.w32(p + 12, bits); x.w32(p + 16, s ? 8 : 0); x.w32(p + 20, z); x.w32(p + 24, s);
        return { fn: cb, args: [p, ctx] };
      });
      return send(x, calls, () => D3D_OK, 16);
    },
    // CreateDevice(IID, the render target surface, &device): the model's device, the size of the surface.
    CreateDevice: (x, self, riid, surf, pp) => {
      const rt = o(surf); if (!rt) return DDERR_INVALIDPARAMS;
      const z = rt.zbuffer && o(rt.zbuffer);
      const params = { width: rt.w, height: rt.h, backBufferFormat: 22, backBufferCount: 1, autoDepthStencilFormat: z ? (z.bpp === 16 ? 80 : 75) : 0, windowed: !st.modeSet, presentInterval: 0 };
      st.glWindow = dd.deviceWindow();
      if (x.backend.setVideoMode) x.backend.setVideoMode(rt.w, rt.h, false);
      const dev = modelOf(x).createDevice(params);
      const p = make(x, 'IDirect3DDevice7', { dev, d3d: self, target: surf >>> 0, params, transforms: new Map(), tex: [], tss: [] });
      devices.add(p); o(self).ref++;
      x.w32(pp, p); return D3D_OK;
    },
    // D3DVERTEXBUFFERDESC: size, caps, FVF, vertex count -- memory of the program's.
    CreateVertexBuffer: (x, self, d, pp) => {
      const fvf = x.r32(d + 8), n = x.r32(d + 12), size = dd.fvfSize(fvf), mem = x.win.heapAlloc(Math.max(1, n * size));
      x.w32(pp, make(x, 'IDirect3DVertexBuffer7', { fvf, n, size, mem, caps: x.r32(d + 4) })); return D3D_OK;
    },
    EvictManagedTextures: () => D3D_OK,
  };

  const IDirect3DDevice7 = {
    GetCaps: (x, self, p) => { putDeviceDesc(x, p); return D3D_OK; },
    // EnumTextureFormats(callback(DDPIXELFORMAT, context), context)
    EnumTextureFormats: (x, self, cb, ctx) => {
      const calls = TEX_FORMATS.map((f) => { const p = x.win.heapAlloc(32); putPixelFormat(x, p, ...f); return { fn: cb, args: [p, ctx] }; });
      return send(x, calls, () => D3D_OK, 12);
    },
    BeginScene: (x, self) => D(self).beginScene() || D3D_OK,
    EndScene: (x, self) => D(self).endScene() || D3D_OK,
    GetDirect3D: (x, self, pp) => { const d = o(self).d3d; o(d).ref++; x.w32(pp, d); return D3D_OK; },
    SetRenderTarget: (x, self, s) => { o(self).target = s >>> 0; return D3D_OK; },
    GetRenderTarget: (x, self, pp) => { const s = o(self).target; o(s).ref++; x.w32(pp, s); return D3D_OK; },
    Clear: (x, self, count, pRects, flags, color, z, stencil) => {
      const rects = count && pRects ? Array.from({ length: count }, (_, i) => [0, 4, 8, 12].map((k) => x.r32(pRects + 16 * i + k) | 0)) : null;
      return D(self).clear(rects, flags, color >>> 0, z, stencil) || D3D_OK;
    },
    // D3DTRANSFORMSTATE_WORLD is 1 here, 256 in Direct3D 9 (D3DTS_WORLD); VIEW, PROJECTION and TEXTUREn the same.
    SetTransform: (x, self, t, p) => { const m = floats(x, p, 16); o(self).transforms.set(t, m); return D(self).setTransform(t === 1 ? 256 : t, m) || D3D_OK; },
    GetTransform: (x, self, t, p) => { const m = o(self).transforms.get(t) || Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); m.forEach((v, i) => wf(x, p + 4 * i, v)); return D3D_OK; },
    MultiplyTransform: (x, self, t, p) => {
      const a = floats(x, p, 16), b = o(self).transforms.get(t) || Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), m = new Float32Array(16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) m[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
      o(self).transforms.set(t, m); return D(self).setTransform(t === 1 ? 256 : t, m) || D3D_OK;
    },
    // D3DVIEWPORT7 is D3DVIEWPORT9: x, y, width, height, minZ, maxZ.
    SetViewport: (x, self, p) => {
      const v = { x: x.r32(p), y: x.r32(p + 4), width: x.r32(p + 8), height: x.r32(p + 12), minZ: x.f32(p + 16), maxZ: x.f32(p + 20) };
      o(self).viewport = v; return D(self).setViewport(v) || D3D_OK;
    },
    GetViewport: (x, self, p) => {
      const q = o(self).params, v = o(self).viewport || { x: 0, y: 0, width: q.width, height: q.height, minZ: 0, maxZ: 1 };
      x.w32(p, v.x); x.w32(p + 4, v.y); x.w32(p + 8, v.width); x.w32(p + 12, v.height); wf(x, p + 16, v.minZ); wf(x, p + 20, v.maxZ); return D3D_OK;
    },
    // D3DMATERIAL7 and D3DLIGHT7 are Direct3D 9's layouts.
    SetMaterial: (x, self, p) => {
      const f = floats(x, p, 17); o(self).material = x.bytes(p, 68).slice();
      return (D(self).setMaterial && D(self).setMaterial({ diffuse: f.slice(0, 4), ambient: f.slice(4, 8), specular: f.slice(8, 12), emissive: f.slice(12, 16), power: f[16] })) || D3D_OK;
    },
    GetMaterial: (x, self, p) => { x.write(p, o(self).material || new Uint8Array(68)); return D3D_OK; },
    SetLight: (x, self, i, p) => {
      const f = floats(x, p + 4, 25), L = { type: x.r32(p), diffuse: f.slice(0, 4), specular: f.slice(4, 8), ambient: f.slice(8, 12),
        position: f.slice(12, 15), direction: f.slice(15, 18), range: f[18], falloff: f[19], attenuation: f.slice(20, 23), theta: f[23], phi: f[24] };
      (o(self).lights ??= new Map()).set(i, x.bytes(p, 104).slice());
      return (D(self).setLight && D(self).setLight(i, L)) || D3D_OK;
    },
    GetLight: (x, self, i, p) => { const l = o(self).lights?.get(i); if (!l) return D3DERR_INVALIDCALL; x.write(p, l); return D3D_OK; },
    LightEnable: (x, self, i, on) => { (o(self).lit ??= new Map()).set(i, !!on); return (D(self).lightEnable && D(self).lightEnable(i, !!on)) || D3D_OK; },
    GetLightEnable: (x, self, i, p) => { x.w32(p, o(self).lit?.get(i) ? 1 : 0); return D3D_OK; },
    SetRenderState: (x, self, s, v) => {
      const dev = o(self); (dev.rs ??= new Map()).set(s, v >>> 0);
      if (s === 8 && v !== 3) return D3D_OK;                         // wireframe and points: not in PRISM's model
      if (SAME_RS.has(s)) D(self).setRenderState(s, v >>> 0);
      return D3D_OK;
    },
    GetRenderState: (x, self, s, p) => { x.w32(p, o(self).rs?.get(s) ?? 0); return D3D_OK; },
    BeginStateBlock: () => D3D_OK, EndStateBlock: (x, self, p) => { x.w32(p, 1); return D3D_OK; },
    ApplyStateBlock: () => D3D_OK, CaptureStateBlock: () => D3D_OK, DeleteStateBlock: () => D3D_OK, CreateStateBlock: (x, self, t, p) => { x.w32(p, 1); return D3D_OK; },
    PreLoad: () => D3D_OK,
    SetClipStatus: () => D3D_OK, GetClipStatus: (x, self, p) => { x.write(p, new Uint8Array(28)); return D3D_OK; },
    // DrawPrimitive(type, FVF, vertices, count, flags)
    DrawPrimitive: (x, self, type, fvf, p, n) => draw(x, self, type, fvf, verts(x, p, n, dd.fvfSize(fvf)), n),
    // DrawIndexedPrimitive(type, FVF, vertices, vertex count, WORD indices, index count, flags)
    DrawIndexedPrimitive: (x, self, type, fvf, p, nv, pi, ni) => drawIndexed(x, self, type, fvf, verts(x, p, nv, dd.fvfSize(fvf)), nv, x.bytes(pi, 2 * ni), ni),
    // DrawPrimitiveVB(type, buffer, first vertex, count, flags)
    DrawPrimitiveVB: (x, self, type, vb, start, n) => { const b = o(vb); return draw(x, self, type, b.fvf, verts(x, b.mem + start * b.size, n, b.size), n); },
    // DrawIndexedPrimitiveVB(type, buffer, first vertex, vertex count, indices, index count, flags): indices from the first.
    DrawIndexedPrimitiveVB: (x, self, type, vb, start, nv, pi, ni) => { const b = o(vb); return drawIndexed(x, self, type, b.fvf, verts(x, b.mem + start * b.size, nv, b.size), nv, x.bytes(pi, 2 * ni), ni); },
    GetTexture: (x, self, stage, pp) => { const t = o(self).tex[stage] || 0; if (t) o(t).ref++; x.w32(pp, t); return D3D_OK; },
    SetTexture: (x, self, stage, s) => {
      const dev = o(self); dev.tex[stage] = s >>> 0;
      return D(self).setTexture(stage, s ? textureOf(x, D(self), s >>> 0) : 0) || D3D_OK;
    },
    GetTextureStageState: (x, self, stage, t, p) => { x.w32(p, o(self).tss[stage]?.get(t) ?? 0); return D3D_OK; },
    SetTextureStageState: (x, self, stage, t, v) => {
      (o(self).tss[stage] ??= new Map()).set(t, v >>> 0);
      const smp = TSS_SAMPLER[t];
      if (smp) { const [first, ...rest] = smp, conv = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null; for (const s of [first, ...rest]) D(self).setSamplerState(stage, s, conv ? conv(v >>> 0) : v >>> 0); return D3D_OK; }
      return D(self).setTextureStageState(stage, t, v >>> 0) || D3D_OK;
    },
    ValidateDevice: (x, self, p) => { if (p) x.w32(p, 1); return D3D_OK; },
    // Load(destination texture, point, source texture, rect, flags): the source's pixels copied in.
    Load: (x, self, dst, pt, src, rc, flags) => { dd.copySurface(x, dst >>> 0, src >>> 0); return D3D_OK; },
    SetClipPlane: () => D3D_OK, GetClipPlane: () => D3D_OK, GetInfo: () => 1,
    ComputeSphereVisibility: () => D3D_OK,
  };

  const IDirect3DVertexBuffer7 = {
    // Lock(flags, &pointer, &size)
    Lock: (x, self, flags, pp, psize) => { const b = o(self); x.w32(pp, b.mem); if (psize) x.w32(psize, b.n * b.size); return D3D_OK; },
    Unlock: () => D3D_OK,
    GetVertexBufferDesc: (x, self, p) => { const b = o(self); x.w32(p, 16); x.w32(p + 4, b.caps); x.w32(p + 8, b.fvf); x.w32(p + 12, b.n); return D3D_OK; },
    Optimize: () => D3D_OK,
  };

  const release = (self) => { devices.delete(self >>> 0); };
  return { IMPL: { IDirect3D7, IDirect3DDevice7, IDirect3DVertexBuffer7 }, present, release, devices };
}
