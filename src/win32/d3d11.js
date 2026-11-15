// d3d11.js — Direct3D 11 and DXGI for MIRAGE-WIN32: d3d11.dll and dxgi.dll, their COM objects made here.
// As d3d9.js: each object a program gets is a pointer into guest memory to a vtable of stubs trapping
// into the functions below, `this` their first argument; the state behind it is kept here.
//
// The drawing is PRISM's Direct3D 9 device model's (x.backend.d3d9(): src/env/d3d9.js in a page,
// recordD3D9() headless), which this module drives as a Direct3D 11 runtime drives a feature level 9
// card: the device is created at feature level 9_3 at most, and each shader a program hands over --
// DXBC, Shader Model 4 -- carries, compiled for that level, its Direct3D 9 twin (the "Aon9" chunk:
// vs_2_0 / ps_2_0 tokens, with where each constant buffer's registers go, which sampler reads which
// texture, and the runtime constant c0 that moves the position by half a pixel). That twin is what the
// model runs; a shader without one (compiled for 4_0 and up only) is kept and draws nothing. So:
//   - a constant buffer is bytes here, copied into the c registers its shader's mapping names at each
//     draw (its bool and int variables, as RDEF types them, as floats: Direct3D 9's registers are);
//   - an input layout is a vertex declaration whose element i is TEXCOORDn, n the register the vertex
//     shader's input signature (ISGN) gives its semantic -- as level 9 shaders declare their inputs;
//   - the blend, depth-stencil, rasterizer and sampler states are render and sampler states;
//   - a 2D texture is a texture (its bytes kept here too, so a box written into it is a level written
//     whole), a render target view its level 0 surface, the swap chain's buffer the back buffer.
//
// Layouts are d3d11.h's and dxgi.h's (Wine's include/ the oracle): the vtables' orders, the structures,
// the HRESULTs. The Aon9 chunk's header is as fxc 6.3 writes it (read off the shaders of GameMaker
// Studio 2's runner): its size, the D3D9 version token, the bytecode's size and offset, then pairs
// (count, offset) of the constant buffer, loop, unknown, sampler and runtime constant mappings.

const S_OK = 0, S_FALSE = 1, E_NOINTERFACE = 0x80004002, E_INVALIDARG = 0x80070057, E_NOTIMPL = 0x80004001;
const DXGI_ERROR_NOT_FOUND = 0x887a0002, DXGI_ERROR_UNSUPPORTED = 0x887a0004, DXGI_ERROR_FRAME_STATISTICS_DISJOINT = 0x887a000b;
const DXGI_STATUS_OCCLUDED = 0x087a0001;

// The vtables: each method's name and its arguments after `this` (a digit: that many 32-bit words;
// otherwise src/hle's letters, f a float by value).
const UNK = 'QueryInterface:2 AddRef:0 Release:0';
const DXGIOBJ = `${UNK} SetPrivateData:3 SetPrivateDataInterface:2 GetPrivateData:3 GetParent:2`;
const CHILD = `${UNK} GetDevice:1 GetPrivateData:3 SetPrivateData:3 SetPrivateDataInterface:2`;
const RESOURCE = `${CHILD} GetType:1 SetEvictionPriority:1 GetEvictionPriority:0`;
const SHADER_STAGE = (s) => `${s}SetShaderResources:3 ${s}SetShader:3 ${s}SetSamplers:3 ${s}SetConstantBuffers:3`;
const SHADER_GET = (s) => `${s}GetShaderResources:3 ${s}GetShader:3 ${s}GetSamplers:3 ${s}GetConstantBuffers:3`;
const VTABLES = {
  IDXGIFactory1: `${DXGIOBJ} EnumAdapters:2 MakeWindowAssociation:2 GetWindowAssociation:1 CreateSwapChain:3 CreateSoftwareAdapter:2
    EnumAdapters1:2 IsCurrent:0`,
  IDXGIAdapter1: `${DXGIOBJ} EnumOutputs:2 GetDesc:1 CheckInterfaceSupport:2 GetDesc1:1`,
  IDXGIOutput: `${DXGIOBJ} GetDesc:1 GetDisplayModeList:4 FindClosestMatchingMode:3 WaitForVBlank:0 TakeOwnership:2 ReleaseOwnership:0
    GetGammaControlCapabilities:1 SetGammaControl:1 GetGammaControl:1 SetDisplaySurface:1 GetDisplaySurfaceData:1 GetFrameStatistics:1`,
  IDXGISwapChain: `${DXGIOBJ} GetDevice:2 Present:2 GetBuffer:3 SetFullscreenState:2 GetFullscreenState:2 GetDesc:1 ResizeBuffers:5
    ResizeTarget:1 GetContainingOutput:1 GetFrameStatistics:1 GetLastPresentCount:1`,
  IDXGIDevice1: `${DXGIOBJ} GetAdapter:1 CreateSurface:5 QueryResourceResidency:3 SetGPUThreadPriority:1 GetGPUThreadPriority:1
    SetMaximumFrameLatency:1 GetMaximumFrameLatency:1`,
  IDXGISurface: `${DXGIOBJ} GetDevice:2 GetDesc:1 Map:2 Unmap:0`,
  ID3D11Device: `${UNK} CreateBuffer:3 CreateTexture1D:3 CreateTexture2D:3 CreateTexture3D:3 CreateShaderResourceView:3
    CreateUnorderedAccessView:3 CreateRenderTargetView:3 CreateDepthStencilView:3 CreateInputLayout:5 CreateVertexShader:4
    CreateGeometryShader:4 CreateGeometryShaderWithStreamOutput:9 CreatePixelShader:4 CreateHullShader:4 CreateDomainShader:4
    CreateComputeShader:4 CreateClassLinkage:1 CreateBlendState:2 CreateDepthStencilState:2 CreateRasterizerState:2
    CreateSamplerState:2 CreateQuery:2 CreatePredicate:2 CreateCounter:2 CreateDeferredContext:2 OpenSharedResource:3
    CheckFormatSupport:2 CheckMultisampleQualityLevels:3 CheckCounterInfo:1 CheckCounter:9 CheckFeatureSupport:3 GetPrivateData:3
    SetPrivateData:3 SetPrivateDataInterface:2 GetFeatureLevel:0 GetCreationFlags:0 GetDeviceRemovedReason:0 GetImmediateContext:1
    SetExceptionMode:1 GetExceptionMode:0`,
  ID3D11DeviceContext: `${CHILD} VSSetConstantBuffers:3 PSSetShaderResources:3 PSSetShader:3 PSSetSamplers:3 VSSetShader:3
    DrawIndexed:3 Draw:2 Map:5 Unmap:2 PSSetConstantBuffers:3 IASetInputLayout:1 IASetVertexBuffers:5 IASetIndexBuffer:3
    DrawIndexedInstanced:5 DrawInstanced:4 GSSetConstantBuffers:3 GSSetShader:3 IASetPrimitiveTopology:1 VSSetShaderResources:3
    VSSetSamplers:3 Begin:1 End:1 GetData:4 SetPredication:2 GSSetShaderResources:3 GSSetSamplers:3 OMSetRenderTargets:3
    OMSetRenderTargetsAndUnorderedAccessViews:7 OMSetBlendState:3 OMSetDepthStencilState:2 SOSetTargets:3 DrawAuto:0
    DrawIndexedInstancedIndirect:2 DrawInstancedIndirect:2 Dispatch:3 DispatchIndirect:2 RSSetState:1 RSSetViewports:2
    RSSetScissorRects:2 CopySubresourceRegion:8 CopyResource:2 UpdateSubresource:6 CopyStructureCount:3 ClearRenderTargetView:2
    ClearUnorderedAccessViewUint:2 ClearUnorderedAccessViewFloat:2 ClearDepthStencilView:pufu GenerateMips:1 SetResourceMinLOD:pf
    GetResourceMinLOD:1 ResolveSubresource:5 ExecuteCommandList:2 ${SHADER_STAGE('HS')} ${SHADER_STAGE('DS')}
    CSSetShaderResources:3 CSSetUnorderedAccessViews:4 CSSetShader:3 CSSetSamplers:3 CSSetConstantBuffers:3
    VSGetConstantBuffers:3 PSGetShaderResources:3 PSGetShader:3 PSGetSamplers:3 VSGetShader:3 PSGetConstantBuffers:3
    IAGetInputLayout:1 IAGetVertexBuffers:5 IAGetIndexBuffer:3 GSGetConstantBuffers:3 GSGetShader:3 IAGetPrimitiveTopology:1
    VSGetShaderResources:3 VSGetSamplers:3 GetPredication:2 GSGetShaderResources:3 GSGetSamplers:3 OMGetRenderTargets:3
    OMGetRenderTargetsAndUnorderedAccessViews:6 OMGetBlendState:3 OMGetDepthStencilState:2 SOGetTargets:2 RSGetState:1
    RSGetViewports:2 RSGetScissorRects:2 ${SHADER_GET('HS')} ${SHADER_GET('DS')} CSGetShaderResources:3 CSGetUnorderedAccessViews:3
    CSGetShader:3 CSGetSamplers:3 CSGetConstantBuffers:3 ClearState:0 Flush:0 GetType:0 GetContextFlags:0 FinishCommandList:2`,
  ID3D11Buffer: `${RESOURCE} GetDesc:1`,
  ID3D11Texture2D: `${RESOURCE} GetDesc:1`,
  ID3D11ShaderResourceView: `${CHILD} GetResource:1 GetDesc:1`,
  ID3D11RenderTargetView: `${CHILD} GetResource:1 GetDesc:1`,
  ID3D11DepthStencilView: `${CHILD} GetResource:1 GetDesc:1`,
  ID3D11VertexShader: CHILD, ID3D11PixelShader: CHILD, ID3D11GeometryShader: CHILD, ID3D11InputLayout: CHILD,
  ID3D11BlendState: `${CHILD} GetDesc:1`, ID3D11DepthStencilState: `${CHILD} GetDesc:1`, ID3D11RasterizerState: `${CHILD} GetDesc:1`,
  ID3D11SamplerState: `${CHILD} GetDesc:1`, ID3D11Query: `${CHILD} GetDataSize:0 GetDesc:1`,
};
const METHODS = Object.fromEntries(Object.entries(VTABLES).map(([i, s]) => [i, s.trim().split(/\s+/).map((t) => t.split(':'))]));
const sigOf = (s) => 'p' + (/^\d+$/.test(s) ? 'u'.repeat(+s) : s);

// The interfaces each object answers to (its own vtable serves those it derives from).
const G = {
  IUnknown: '00000000-0000-0000-c000-000000000046', IDXGIObject: 'aec22fb8-76f3-4639-9be0-28eb43a67a2e',
  IDXGIDeviceSubObject: '3d3e0379-f9de-4d58-bb6c-18d62992f1a6', IDXGIFactory: '7b7166ec-21c7-44ae-b21a-c9ae321ae369',
  IDXGIFactory1: '770aae78-f26f-4dba-a829-253c83d1b387', IDXGIAdapter: '2411e7e1-12ac-4ccf-bd14-9798e8534dc0',
  IDXGIAdapter1: '29038f61-3839-4626-91fd-086879011a05', IDXGIOutput: 'ae02eedb-c735-4690-8d52-5a8dc20213aa',
  IDXGISwapChain: '310d36a0-d2e7-4c0a-aa04-6a9d23b8886a', IDXGIDevice: '54ec77fa-1377-44e6-8c32-88fd5f44c84c',
  IDXGIDevice1: '77db970f-6276-48ba-ba28-070143b4392c', IDXGIResource: '035f3ab4-482e-4e50-b41f-8a7f8bd8960b',
  IDXGISurface: 'cafcb56c-6ac3-4889-bf47-9e23bbd260ec',
  ID3D11Device: 'db6f6ddb-ac77-4e88-8253-819df9bbf140', ID3D11DeviceChild: '1841e5c8-16b0-489b-bcc8-44cfb0d5deae',
  ID3D11DeviceContext: 'c0bfa96c-e089-44fb-8eaf-26f8796190da', ID3D11Resource: 'dc8e63f3-d12b-4952-b47b-5e45026a862d',
  ID3D11Buffer: '48570b85-d1ee-4fcd-a250-eb350722b037', ID3D11Texture2D: '6f15aaf2-d208-4e89-9ab4-489535d34f9c',
  ID3D11View: '839d1216-bb2e-412b-b7f4-a9dbebe08ed1', ID3D11ShaderResourceView: 'b0e06fe0-8192-4e1a-b1ca-36d7414710b2',
  ID3D11RenderTargetView: 'dfdba067-0b8d-4865-875b-d7b4516cc164', ID3D11DepthStencilView: '9fdac92a-1876-48c3-afad-25b94f84a9b6',
  ID3D11VertexShader: '3b301d64-d678-4289-8897-22f8928b72f3', ID3D11PixelShader: 'ea82e40d-51dc-4f33-93d4-db7c9125ae8c',
  ID3D11GeometryShader: '38325b96-effb-4022-ba02-2e795b70275c', ID3D11InputLayout: 'e4819ddc-4cf0-4025-bd26-5de82a3e07b7',
  ID3D11BlendState: '75b68faa-347d-4159-8f45-a0640f01cd9a', ID3D11DepthStencilState: '03823efb-8d8f-4e1c-9aa2-f64bb2cbfdf1',
  ID3D11RasterizerState: '9bb4ab81-ab1a-4d8f-b506-fc04200b6ee7', ID3D11SamplerState: 'da6fea51-564c-4487-9810-f0d0f9b4e3a5',
  ID3D11Asynchronous: '4b35d0cd-1e15-4258-9c98-1b1333f6dd3b', ID3D11Query: 'd6c00747-87b7-425e-b84d-44d108560afd',
};
const IIDS = {
  IDXGIFactory1: ['IUnknown', 'IDXGIObject', 'IDXGIFactory', 'IDXGIFactory1'],
  IDXGIAdapter1: ['IUnknown', 'IDXGIObject', 'IDXGIAdapter', 'IDXGIAdapter1'],
  IDXGIOutput: ['IUnknown', 'IDXGIObject', 'IDXGIOutput'],
  IDXGISwapChain: ['IUnknown', 'IDXGIObject', 'IDXGIDeviceSubObject', 'IDXGISwapChain'],
  IDXGIDevice1: ['IDXGIObject', 'IDXGIDevice', 'IDXGIDevice1'],
  IDXGISurface: ['IDXGIObject', 'IDXGIDeviceSubObject', 'IDXGISurface'],
  ID3D11Device: ['IUnknown', 'ID3D11Device'],
  ID3D11DeviceContext: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11DeviceContext'],
  ID3D11Buffer: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11Resource', 'ID3D11Buffer'],
  ID3D11Texture2D: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11Resource', 'ID3D11Texture2D'],
  ID3D11ShaderResourceView: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11View', 'ID3D11ShaderResourceView'],
  ID3D11RenderTargetView: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11View', 'ID3D11RenderTargetView'],
  ID3D11DepthStencilView: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11View', 'ID3D11DepthStencilView'],
  ID3D11Query: ['IUnknown', 'ID3D11DeviceChild', 'ID3D11Asynchronous', 'ID3D11Query'],
};
for (const i of Object.keys(VTABLES)) IIDS[i] ||= ['IUnknown', 'ID3D11DeviceChild', i];
// The interface a QueryInterface for one of these gets: another face of the same object.
const FACETS = {
  ID3D11Device: { IDXGIObject: 'IDXGIDevice1', IDXGIDevice: 'IDXGIDevice1', IDXGIDevice1: 'IDXGIDevice1' },
  IDXGIDevice1: { IUnknown: 'ID3D11Device', ID3D11Device: 'ID3D11Device' },
  ID3D11Texture2D: { IDXGIObject: 'IDXGISurface', IDXGIDeviceSubObject: 'IDXGISurface', IDXGIResource: 'IDXGISurface', IDXGISurface: 'IDXGISurface' },
  IDXGISurface: { IUnknown: 'ID3D11Texture2D', ID3D11Resource: 'ID3D11Texture2D', ID3D11Texture2D: 'ID3D11Texture2D' },
};
const BYIID = Object.fromEntries(Object.entries(G).map(([k, v]) => [v, k]));

// DXGI_FORMATs: [the D3DFORMAT a texture of it is in the model, bytes a texel]; and as a vertex element,
// its D3DDECLTYPE.
const FORMAT = {
  2: [116, 16], 10: [113, 8], 16: [115, 8], 28: [32, 4], 29: [32, 4], 34: [112, 4], 41: [114, 4], 54: [111, 2], 61: [50, 1], 65: [28, 1],
  87: [21, 4], 88: [22, 4], 91: [21, 4], 93: [22, 4],
  40: [82, 4], 45: [75, 4], 55: [80, 2],                                // depth: D32F, D24S8, D16
};
const DECLTYPE = { 41: 0, 16: 1, 6: 2, 2: 3, 87: 4, 28: 8, 30: 5, 38: 6, 14: 7, 37: 9, 13: 10, 35: 11, 11: 12, 34: 15, 10: 16 };
const DECLSIZE = { 0: 4, 1: 8, 2: 12, 3: 16, 4: 4, 5: 4, 6: 4, 7: 8, 8: 4, 9: 4, 10: 8, 11: 4, 12: 8, 15: 4, 16: 8 };
// Primitives a draw of n vertices makes, per D3D11_PRIMITIVE_TOPOLOGY (its numbers are D3DPRIMITIVETYPE's).
const PRIMS = { 1: (n) => n, 2: (n) => n >> 1, 3: (n) => Math.max(0, n - 1), 4: (n) => Math.floor(n / 3), 5: (n) => Math.max(0, n - 2) };

const guidOf = (x, p) => {
  const b = x.bytes(p, 16), h = (i, n) => [...b.slice(i, i + n)].map((v) => v.toString(16).padStart(2, '0')).join('');
  const r = (i, n) => h(i, n).match(/../g).reverse().join('');
  return `${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}`;
};
const wbytes = (s) => { const b = new Uint8Array(2 * s.length + 2); for (let i = 0; i < s.length; i++) b[2 * i] = s.charCodeAt(i); return b; };
const f32bits = (v) => { const f = new Float32Array([v]); return new Uint32Array(f.buffer)[0]; };

/**
 * A DXBC container's chunks by tag ({ Aon9, ISGN, RDEF, SHDR, ... }: Uint8Arrays of their data), or null
 * when `b` is not one.
 */
export function dxbcChunks(b) {
  if (b.length < 32 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'DXBC') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint32(28, true), out = {};
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(32 + 4 * i, true), tag = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]), len = dv.getUint32(off + 4, true);
    out[tag] = b.subarray(off + 8, off + 8 + len);
  }
  return out;
}

/**
 * The Direct3D 9 shader a level 9 DXBC shader carries (its Aon9 chunk): { tokens: Uint32Array, cb: [{ buffer,
 * start, count, target }], samplers: [{ target, sampler, resource }], fixup: the register of the position's
 * half-pixel fix or -1 }; null without one.
 */
export function aon9(chunks) {
  const a = chunks && chunks.Aon9;
  if (!a || a.length < 36) return null;
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength), u16 = (o) => dv.getUint16(o, true);
  const size = dv.getUint32(8, true), off = dv.getUint32(12, true);
  const tokens = new Uint32Array(size >> 2);
  for (let i = 0; i < tokens.length; i++) tokens[i] = dv.getUint32(off + 4 * i, true);
  const list = (at, n, step, f) => Array.from({ length: u16(at) }, (_, i) => f(u16(at + 2) + step * i)).slice(0, n);
  const cb = list(0x10, 64, 12, (o) => ({ buffer: u16(o), start: u16(o + 2), count: u16(o + 4), target: u16(o + 6) }));
  const samplers = list(0x1c, 16, 4, (o) => ({ target: a[o], sampler: a[o + 1], resource: a[o + 2] }));
  const rt = list(0x20, 8, 4, (o) => ({ kind: u16(o), target: u16(o + 2) }));
  const fix = rt.find((r) => r.kind === 0);
  return { tokens, cb, samplers, fixup: fix ? fix.target : -1 };
}

/** An input or output signature (ISGN, OSGN): [{ name, index, register }]. */
export function signature(sig) {
  if (!sig) return [];
  const dv = new DataView(sig.buffer, sig.byteOffset, sig.byteLength), n = dv.getUint32(0, true), out = [];
  const str = (o) => { let s = ''; while (o < sig.length && sig[o]) s += String.fromCharCode(sig[o++]); return s; };
  for (let i = 0; i < n; i++) { const e = 8 + 24 * i; out.push({ name: str(dv.getUint32(e, true)).toUpperCase(), index: dv.getUint32(e + 4, true), register: dv.getUint32(e + 16, true) }); }
  return out;
}

/** The bool, int and uint variables of each constant buffer (RDEF), by its bind point: [{ offset, count }]. */
export function integerVariables(rdef) {
  const out = new Map();
  if (!rdef || rdef.length < 28) return out;
  const dv = new DataView(rdef.buffer, rdef.byteOffset, rdef.byteLength), r = (o) => dv.getUint32(o, true);
  const str = (o) => { let s = ''; while (o < rdef.length && rdef[o]) s += String.fromCharCode(rdef[o++]); return s; };
  const nCb = r(0), cbAt = r(4), nBind = r(8), bindAt = r(12), v5 = rdef[17] >= 5, varSize = v5 ? 40 : 24;
  const slot = new Map();                                             // cbuffer name -> bind point
  for (let i = 0; i < nBind; i++) { const b = bindAt + 32 * i; if (r(b + 4) === 0) slot.set(str(r(b)), r(b + 20)); }
  for (let i = 0; i < nCb; i++) {
    const c = cbAt + 24 * i, name = str(r(c)), vars = [];
    for (let k = 0; k < r(c + 4); k++) {
      const v = r(c + 8) + varSize * k, t = r(v + 16), type = dv.getUint16(t + 2, true);
      if (type === 1 || type === 2 || type === 19) vars.push({ offset: r(v + 4), count: r(v + 8) >> 2 });
    }
    if (vars.length && slot.has(name)) out.set(slot.get(name), vars);
  }
  return out;
}

/** The DLLs: d3d11.dll, dxgi.dll. `st` is user32's window state (the size a swap chain of 0 by 0 takes). */
export function d3d11Apis(st) {
  const objs = new Map(), vtables = new Map();
  let model = null, arena = 0, arenaEnd = 0, lastPresent = -1;
  const getModel = (x) => model || (model = x.backend.d3d9 ? x.backend.d3d9() : null);
  const galloc = (x, n) => {
    if (!arena) { arena = 0x3a000000; arenaEnd = arena; }
    const p = arena; arena += Math.ceil(Math.max(n, 1) / 0x1000) * 0x1000;
    if (arena > arenaEnd) { x.lx.mapRange(arenaEnd, arena, true); arenaEnd = arena; }
    return p;
  };
  const make = (x, iface, props = {}) => {
    if (!vtables.has(iface)) {
      const mod = x.win.load(/^IDXGI/.test(iface) ? 'dxgi.dll' : 'd3d11.dll'), ms = METHODS[iface], v = x.win.heapAlloc(4 * ms.length);
      ms.forEach(([n], i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      vtables.set(iface, v);
    }
    const p = x.win.heapAlloc(16);
    x.w32(p, vtables.get(iface));
    objs.set(p, { iface, ref: 1, facets: {}, ...props });
    return p;
  };
  const o = (p) => objs.get(p >>> 0);
  const out = (x, pp, p) => { if (pp) x.w32(pp, p); return p ? S_OK : E_INVALIDARG; };
  const addRef = (p) => { if (p && o(p)) o(p).ref++; return p; };
  const NOT = (iface, n) => () => { throw new Error(`mirage-win32: ${iface}::${n} is not implemented`); };
  const desk = () => (st.desk ? { w: st.desk.w, h: st.desk.h } : { w: 1024, h: 768 });

  // ---- IUnknown, and the facets: an object's other interfaces, each a COM object of its own whose
  // QueryInterface leads back ----------------------------------------------------------------------------
  const unknown = {
    QueryInterface: (x, self, riid, pp) => {
      const ob = o(self), want = BYIID[guidOf(x, riid)];
      if (pp) x.w32(pp, 0);
      if (!ob) return E_NOINTERFACE;
      if (want && IIDS[ob.iface].includes(want)) { ob.ref++; x.w32(pp, self); return S_OK; }
      const other = want && FACETS[ob.iface] && FACETS[ob.iface][want];
      if (other) {
        const home = ob.home || self, h = o(home);
        let f = other === h.iface ? home : h.facets[other];
        if (!f) { f = make(x, other, { home }); h.facets[other] = f; o(f).ref = 0; }
        o(f).ref++; x.w32(pp, f); return S_OK;
      }
      if (!want) x.win.say(`d3d11: ${ob.iface}::QueryInterface({${guidOf(x, riid)}}): not here`);
      return E_NOINTERFACE;
    },
    AddRef: (x, self) => ++o(self).ref,
    Release: (x, self) => {
      const ob = o(self); if (!ob) return 0;
      if (--ob.ref > 0) return ob.ref;
      ob.ref = 0;
      if (ob.implicit || ob.home) return 0;                            // the swap chain's buffer, a facet: as long as their owner
      { const hd = ob.iface === 'ID3D11Texture2D' ? ob.h9 : ob.h; if (hd && ob.model) ob.model.release(hd); }
      objs.delete(self >>> 0);
      return 0;
    },
  };
  const privateData = { SetPrivateData: () => S_OK, SetPrivateDataInterface: () => S_OK, GetPrivateData: (x, self, g, pn) => { if (pn) x.w32(pn, 0); return DXGI_ERROR_NOT_FOUND; } };
  const child = { ...privateData, GetDevice: (x, self, pp) => { x.w32(pp, addRef(o(self).dev)); return 0; } };

  // ---- DXGI: one adapter, one output (the screen) -------------------------------------------------------
  let factory = 0;
  const modes = (fmt) => {
    const d = desk(), list = [[640, 480], [800, 600], [1024, 768], [1280, 720], [d.w, d.h]];
    return list.filter(([w, h], i) => list.findIndex(([a, b]) => a === w && b === h) === i).sort((a, b) => a[0] * a[1] - b[0] * b[1]).map(([w, h]) => ({ w, h, fmt }));
  };
  const putMode = (x, p, m) => { x.write(p, new Uint8Array(28)); x.w32(p, m.w); x.w32(p + 4, m.h); x.w32(p + 8, 60); x.w32(p + 12, 1); x.w32(p + 16, m.fmt); x.w32(p + 20, 1); };
  const dxgiFactory = {
    ...privateData, GetParent: (x, self, riid, pp) => { x.w32(pp, 0); return E_NOINTERFACE; },
    EnumAdapters: (x, self, i, pp) => { if (i) { x.w32(pp, 0); return DXGI_ERROR_NOT_FOUND; } x.w32(pp, make(x, 'IDXGIAdapter1', { factory: addRef(self) })); return S_OK; },
    EnumAdapters1: (x, self, i, pp) => dxgiFactory.EnumAdapters(x, self, i, pp),
    MakeWindowAssociation: (x, self, hwnd, flags) => { o(self).window = hwnd; return S_OK; },
    GetWindowAssociation: (x, self, p) => { x.w32(p, o(self).window || 0); return S_OK; },
    CreateSwapChain: (x, self, dev, desc, pp) => createSwapChain(x, self, dev, desc, pp),
    CreateSoftwareAdapter: (x, self, mod, pp) => { x.w32(pp, 0); return DXGI_ERROR_UNSUPPORTED; },
    IsCurrent: () => 1,
  };
  const ADAPTER = 'PRISM Direct3D 11 (feature level 9_3) on WebGL2';
  const adapter = {
    ...privateData, GetParent: (x, self, riid, pp) => unknown.QueryInterface(x, o(self).factory, riid, pp),
    EnumOutputs: (x, self, i, pp) => { if (i) { x.w32(pp, 0); return DXGI_ERROR_NOT_FOUND; } x.w32(pp, make(x, 'IDXGIOutput', { adapter: addRef(self) })); return S_OK; },
    // DXGI_ADAPTER_DESC(1): Description, the vendor's ids, 256 MiB of video memory, a LUID; Flags 0.
    GetDesc: (x, self, p) => { x.write(p, new Uint8Array(292)); x.write(p, wbytes(ADAPTER)); x.w32(p + 268, 256 << 20); x.w32(p + 284, 1); return S_OK; },
    GetDesc1: (x, self, p) => { adapter.GetDesc(x, self, p); x.w32(p + 292, 0); return S_OK; },
    CheckInterfaceSupport: () => DXGI_ERROR_UNSUPPORTED,                // asked of Direct3D 10's device only
  };
  const output = {
    ...privateData, GetParent: (x, self, riid, pp) => unknown.QueryInterface(x, o(self).adapter, riid, pp),
    // DXGI_OUTPUT_DESC: \\.\DISPLAY1, the desktop's rectangle, attached, not rotated, the monitor.
    GetDesc: (x, self, p) => { const d = desk(); x.write(p, new Uint8Array(92)); x.write(p, wbytes('\\\\.\\DISPLAY1')); x.w32(p + 72, d.w); x.w32(p + 76, d.h); x.w32(p + 80, 1); x.w32(p + 84, 1); x.w32(p + 88, 0x10001); return S_OK; },
    GetDisplayModeList: (x, self, fmt, flags, pn, p) => {
      const list = modes(fmt);
      if (!p) { x.w32(pn, list.length); return S_OK; }
      const n = Math.min(x.r32(pn), list.length); list.slice(0, n).forEach((m, i) => putMode(x, p + 28 * i, m)); x.w32(pn, n);
      return n < list.length ? 0x887a0003 : S_OK;                      // DXGI_ERROR_MORE_DATA
    },
    FindClosestMatchingMode: (x, self, want, p) => {
      const w = x.r32(want), h = x.r32(want + 4), list = modes(x.r32(want + 16) || 28);
      const m = list.reduce((b, m) => (Math.abs(m.w - w) + Math.abs(m.h - h) < Math.abs(b.w - w) + Math.abs(b.h - h) ? m : b), list[list.length - 1]);
      putMode(x, p, m); return S_OK;
    },
    // The next sixtieth of a second (the call is made again when the wait is over).
    WaitForVBlank: (x, self) => {
      const out = o(self), now = x.lx.mono();
      if (out.vblank === undefined) out.vblank = Math.ceil(now * 60 + 1e-9) / 60;
      if (now < out.vblank) return x.waitUntil(out.vblank);
      out.vblank = undefined; return S_OK;
    },
    TakeOwnership: () => S_OK, ReleaseOwnership: () => 0,
    GetGammaControlCapabilities: (x, self, p) => { x.write(p, new Uint8Array(12)); return S_OK; },
    SetGammaControl: () => S_OK, GetGammaControl: () => DXGI_ERROR_UNSUPPORTED,
    SetDisplaySurface: () => DXGI_ERROR_UNSUPPORTED, GetDisplaySurfaceData: () => DXGI_ERROR_UNSUPPORTED,
    GetFrameStatistics: () => DXGI_ERROR_FRAME_STATISTICS_DISJOINT,
  };
  const dxgiDevice = {
    ...privateData,
    GetParent: (x, self, riid, pp) => unknown.QueryInterface(x, o(o(self).home).adapter, riid, pp),
    GetAdapter: (x, self, pp) => { x.w32(pp, addRef(o(o(self).home).adapter)); return S_OK; },
    CreateSurface: (x, self, d, n, usage, shared, pp) => { x.w32(pp, 0); return E_NOTIMPL; },
    QueryResourceResidency: (x, self, res, p, n) => { for (let i = 0; i < n; i++) x.w32(p + 4 * i, 1); return S_OK; },
    SetGPUThreadPriority: () => S_OK, GetGPUThreadPriority: (x, self, p) => { x.w32(p, 0); return S_OK; },
    SetMaximumFrameLatency: (x, self, n) => { o(o(self).home).latency = n; return S_OK; },
    GetMaximumFrameLatency: (x, self, p) => { x.w32(p, o(o(self).home).latency || 3); return S_OK; },
  };
  const dxgiSurface = {
    ...privateData, GetParent: (x, self, riid, pp) => { x.w32(pp, 0); return E_NOINTERFACE; },
    GetDevice: (x, self, riid, pp) => unknown.QueryInterface(x, o(o(self).home).dev, riid, pp),
    GetDesc: (x, self, p) => { const t = o(o(self).home); x.write(p, new Uint8Array(20)); x.w32(p, t.w); x.w32(p + 4, t.ht); x.w32(p + 8, t.format); x.w32(p + 12, 1); return S_OK; },
    Map: () => DXGI_ERROR_UNSUPPORTED, Unmap: () => S_OK,
  };

  // ---- the device and its model --------------------------------------------------------------------------
  const D = (x, devPtr) => {
    const d = o(devPtr);
    if (!d.dev) {
      const m = getModel(x); if (!m) return null;
      const w = d.size ? d.size.w : st.w || 640, h = d.size ? d.size.h : st.h || 480;
      if (x.backend.setVideoMode) x.backend.setVideoMode(w, h, false);
      d.dev = m.createDevice({ width: w, height: h, backBufferFormat: 21, backBufferCount: 1, autoDepthStencilFormat: 0, windowed: true, presentInterval: 1 });
    }
    return d.dev;
  };
  const createDevice = (x, levels, n, ppDev, pLevel, ppCtx) => {
    // Feature level 9_3 at most -- the level whose shaders carry their Direct3D 9 bytecode -- of those the
    // program accepts; none of them: E_INVALIDARG, as a card without them answers (DXGI_ERROR_UNSUPPORTED).
    const asked = n && levels ? Array.from({ length: n }, (_, i) => x.r32(levels + 4 * i)) : [0xb000, 0xa100, 0xa000, 0x9300, 0x9200, 0x9100];
    const level = asked.find((l) => l <= 0x9300);
    if (!level) { if (ppDev) x.w32(ppDev, 0); if (ppCtx) x.w32(ppCtx, 0); return DXGI_ERROR_UNSUPPORTED; }
    if (pLevel) x.w32(pLevel, level);
    if (!ppDev && !ppCtx) return S_FALSE;
    if (!factory) factory = make(x, 'IDXGIFactory1');
    const adapterPtr = make(x, 'IDXGIAdapter1', { factory: addRef(factory) });
    const dev = make(x, 'ID3D11Device', { level, adapter: adapterPtr });
    const ctx = make(x, 'ID3D11DeviceContext', { dev, state: freshState() });
    o(dev).ctx = ctx; o(ctx).ref = 0;
    if (ppDev) x.w32(ppDev, dev); else o(dev).ref = 0;
    if (ppCtx) { o(ctx).ref++; x.w32(ppCtx, ctx); }
    return S_OK;
  };
  const freshState = () => ({ vs: 0, ps: 0, layout: 0, topology: 0, vb: [], ib: null, vsCb: [], psCb: [], srv: [], samplers: [],
    rtv: [], dsv: 0, blend: 0, depth: 0, raster: 0, viewport: null, scissor: null, stencilRef: 0, blendFactor: [1, 1, 1, 1] });

  // ---- the swap chain ------------------------------------------------------------------------------------
  const createSwapChain = (x, fac, devIn, desc, pp) => {
    const devPtr = o(devIn) && o(devIn).home ? o(devIn).home : devIn;
    if (!o(devPtr) || o(devPtr).iface !== 'ID3D11Device') { if (pp) x.w32(pp, 0); return E_INVALIDARG; }
    const r = (k) => x.r32(desc + 4 * k);
    let w = r(0), h = r(1); const hwnd = r(11);
    if (!w || !h) { w = st.w || 640; h = st.h || 480; }
    const d = o(devPtr); d.size = { w, h };
    st.glWindow = hwnd;
    const sc = make(x, 'IDXGISwapChain', { dev: addRef(devPtr), factory: fac, w, h, format: r(4) || 28, count: r(10), hwnd, windowed: r(12), effect: r(13), flags: r(14), fullscreen: !r(12) });
    D(x, devPtr);
    x.w32(pp, sc); return S_OK;
  };
  const swapChain = {
    ...privateData, GetParent: (x, self, riid, pp) => unknown.QueryInterface(x, o(self).factory || factory, riid, pp),
    GetDevice: (x, self, riid, pp) => unknown.QueryInterface(x, o(self).dev, riid, pp),
    // Present: a vsynced swap (sync interval 1 or more), at most one frame in flight, as d3d9.js's.
    Present: (x, self, sync, flags) => {
      if (flags & 1) return S_OK;                                      // DXGI_PRESENT_TEST: it would show
      const now = x.lx.mono(), sc = o(self);
      if (sync && lastPresent >= 0 && now < lastPresent + sync / 60) return x.waitUntil(lastPresent + sync / 60);
      if (x.backend.swapReady && !x.backend.swapReady()) return x.waitUntil(now + 0.002);
      lastPresent = now;
      const dev = D(x, sc.dev); if (dev) dev.present();
      if (x.backend.swap) x.backend.swap();
      sc.presents = (sc.presents || 0) + 1;
      return S_OK;
    },
    // The back buffer: a 2D texture whose level 0 is the model's back buffer surface.
    GetBuffer: (x, self, i, riid, pp) => {
      const sc = o(self);
      if (!sc.buffer) {
        const dev = D(x, sc.dev);
        sc.buffer = make(x, 'ID3D11Texture2D', { dev: sc.dev, implicit: true, w: sc.w, ht: sc.h, levels: 1, format: sc.format, bind: 0x20, surface: dev ? dev.getBackBuffer(0, 0) : 0, model: dev });
        o(sc.buffer).ref = 0;
      }
      return unknown.QueryInterface(x, sc.buffer, riid, pp);
    },
    SetFullscreenState: (x, self, fs) => { o(self).fullscreen = !!fs; return S_OK; },
    GetFullscreenState: (x, self, p, pp) => { if (p) x.w32(p, o(self).fullscreen ? 1 : 0); if (pp) x.w32(pp, 0); return S_OK; },
    GetDesc: (x, self, p) => {
      const sc = o(self); x.write(p, new Uint8Array(60));
      [sc.w, sc.h, 60, 1, sc.format, 0, 0, 1, 0, 0x20, sc.count, sc.hwnd, sc.fullscreen ? 0 : 1, sc.effect, sc.flags].forEach((v, i) => x.w32(p + 4 * i, v));
      return S_OK;
    },
    // A new size: kept, and the window's; the model's back buffer stays the size it was made (PRISM's
    // device has no Reset yet), the picture scaled to the canvas.
    ResizeBuffers: (x, self, n, w, h, fmt) => {
      const sc = o(self);
      if (w && h) { sc.w = w; sc.h = h; }
      if (fmt) sc.format = fmt;
      if (sc.buffer) { const b = o(sc.buffer); b.w = sc.w; b.ht = sc.h; }
      return S_OK;
    },
    ResizeTarget: () => S_OK,
    GetContainingOutput: (x, self, pp) => { x.w32(pp, make(x, 'IDXGIOutput', { adapter: addRef(o(o(self).dev).adapter) })); return S_OK; },
    GetFrameStatistics: () => DXGI_ERROR_FRAME_STATISTICS_DISJOINT,
    GetLastPresentCount: (x, self, p) => { x.w32(p, o(self).presents || 0); return S_OK; },
  };

  // ---- resources -----------------------------------------------------------------------------------------
  // D3D11_BUFFER_DESC: ByteWidth, Usage, BindFlags, CPUAccessFlags, MiscFlags, StructureByteStride.
  // A vertex or index buffer is the model's; a constant buffer is bytes here, read at each draw.
  const createBuffer = (x, self, desc, init, pp) => {
    const r = (k) => x.r32(desc + 4 * k), size = r(0), bind = r(2);
    const b = { dev: self, size, usage: r(1), bind, cpu: r(3), misc: r(4), bytes: new Uint8Array(size) };
    if (init) b.bytes.set(x.bytes(x.r32(init), size));
    const dev = (bind & 3) ? D(x, self) : null;
    if (dev) {
      b.model = dev;
      b.h = bind & 2 ? dev.createIndexBuffer(size, 0, 101) : dev.createVertexBuffer(size, 0, 0, 0);
      if (init) dev.bufferWrite(b.h, 0, b.bytes);
    }
    if (pp) x.w32(pp, make(x, 'ID3D11Buffer', b));
    return S_OK;
  };
  // D3D11_TEXTURE2D_DESC: Width, Height, MipLevels, ArraySize, Format, SampleDesc, Usage, BindFlags,
  // CPUAccessFlags, MiscFlags. Each level's bytes are kept here (a write of a box is the level written
  // whole); a depth-stencil texture is the model's depth surface.
  const levelsOf = (w, h, n) => { if (n) return n; let k = 1; while ((w >> k) || (h >> k)) k++; return k; };
  const createTexture2D = (x, self, desc, init, pp) => {
    const r = (k) => x.r32(desc + 4 * k);
    const t = { dev: self, w: r(0), ht: r(1), levels: levelsOf(r(0), r(1), r(2)), array: r(3), format: r(4), usage: r(7), bind: r(8), cpu: r(9), misc: r(10) };
    const f = FORMAT[t.format], dev = D(x, self);
    t.bpp = f ? f[1] : 4; t.lv = [];
    if (dev && f) {
      t.model = dev;
      if (t.bind & 0x40) t.surface = dev.createDepthStencilSurface(t.w, t.ht, f[0], 0, 0, 0);
      else {
        t.h9 = dev.createTexture(t.w, t.ht, t.levels, (t.bind & 0x20 ? 1 : 0) | (t.misc & 1 ? 0x400 : 0), f[0], 0);
        if (t.bind & 0x20) t.surface = dev.getSurfaceLevel(t.h9, 0);
      }
    } else if (dev && !f) x.win.say(`d3d11: CreateTexture2D: DXGI format ${t.format} is not drawn yet`);
    if (pp) {
      const p = make(x, 'ID3D11Texture2D', t);
      if (init) for (let l = 0; l < t.levels; l++) { const s = init + 12 * l; writeLevel(x, o(p), l, null, x.r32(s), x.r32(s + 4)); }
      x.w32(pp, p);
    }
    return S_OK;
  };
  const levelSize = (t, l) => [Math.max(1, t.w >> l), Math.max(1, t.ht >> l)];
  // Bytes into a level (`box`: [left, top, right, bottom] or the whole), from guest memory with that pitch.
  const writeLevel = (x, t, l, box, src, pitch) => {
    if (!src) return;
    const [w, h] = levelSize(t, l), row = w * t.bpp;
    const lv = t.lv[l] ||= new Uint8Array(row * h);
    const [x0, y0, x1, y1] = box || [0, 0, w, h], n = (Math.min(x1, w) - x0) * t.bpp;
    for (let y = y0; y < Math.min(y1, h); y++) lv.set(x.bytes(src + (y - y0) * pitch, n), y * row + x0 * t.bpp);
    if (t.h9 !== undefined && t.model) t.model.textureWrite(t.h9, l, null, lv, row);
    if (x.backend.textureCapture) x.backend.textureCapture({ seq: capSeq++, texture: t.h9 ?? 0, iface: 'texture2d', face: -1, level: l, w, h, format: t.format }, Uint8Array.from(lv));
  };
  let capSeq = 0;
  const resourceIface = { ...child, GetEvictionPriority: () => 0, SetEvictionPriority: () => 0 };
  const buffer = { ...resourceIface, GetType: (x, self, p) => { x.w32(p, 1); return 0; },
    GetDesc: (x, self, p) => { const b = o(self); [b.size, b.usage, b.bind, b.cpu, b.misc, 0].forEach((v, i) => x.w32(p + 4 * i, v)); return 0; } };
  const texture2d = { ...resourceIface, GetType: (x, self, p) => { x.w32(p, 3); return 0; },
    GetDesc: (x, self, p) => { const t = o(self); [t.w, t.ht, t.levels, t.array || 1, t.format, 1, 0, t.usage || 0, t.bind, t.cpu || 0, t.misc || 0].forEach((v, i) => x.w32(p + 4 * i, v)); return 0; } };
  // Views: what they view, and its desc (kept as the program gave it, or made for the whole resource).
  const view = (iface, size) => ({ ...child,
    GetResource: (x, self, pp) => { x.w32(pp, addRef(o(self).res)); return 0; },
    GetDesc: (x, self, p) => { const v = o(self); x.write(p, new Uint8Array(size)); if (v.desc) x.write(p, v.desc); else { x.w32(p, o(v.res).format); x.w32(p + 4, 4); } return 0; } });
  const createView = (iface, size) => (x, self, res, desc, pp) => {
    if (!o(res)) return E_INVALIDARG;
    if (pp) x.w32(pp, make(x, iface, { dev: self, res: addRef(res), desc: desc ? x.bytes(desc, size).slice() : null }));
    return S_OK;
  };

  // ---- shaders and input layouts ----------------------------------------------------------------------------
  const createShader = (iface, stage) => (x, self, code, n, linkage, pp) => {
    const bytes = x.bytes(code, n).slice(), chunks = dxbcChunks(bytes), d9 = aon9(chunks), dev = D(x, self);
    const sh = { dev: self, stage, bytes, isgn: signature(chunks && chunks.ISGN), ints: integerVariables(chunks && chunks.RDEF), d9 };
    if (d9 && dev) { sh.model = dev; sh.h = stage === 'vs' ? dev.createVertexShader(d9.tokens) : dev.createPixelShader(d9.tokens); }
    else if (!d9) x.win.say(`d3d11: ${iface}: no Direct3D 9 bytecode (Aon9) in it: it draws nothing`);
    if (pp) x.w32(pp, make(x, iface, sh));
    return S_OK;
  };
  // D3D11_INPUT_ELEMENT_DESC (28 bytes): SemanticName, SemanticIndex, Format, InputSlot, AlignedByteOffset,
  // InputSlotClass, InstanceDataStepRate. Element i is TEXCOORDn, n its semantic's register in the vertex
  // shader's input signature; the slots' strides come with IASetVertexBuffers.
  const createInputLayout = (x, self, els, n, code, size, pp) => {
    const isgn = signature(dxbcChunks(x.bytes(code, size))?.ISGN), list = [], offs = new Map();
    for (let i = 0; i < n; i++) {
      const e = els + 28 * i, name = x.str(x.r32(e), 64).toUpperCase(), index = x.r32(e + 4), fmt = x.r32(e + 8), slot = x.r32(e + 12);
      const type = DECLTYPE[fmt];
      let off = x.r32(e + 16); if (off === 0xffffffff) off = offs.get(slot) || 0;
      offs.set(slot, off + (type !== undefined ? DECLSIZE[type] : 4));
      const sig = isgn.find((s) => s.name === name && s.index === index);
      if (type === undefined) { x.win.say(`d3d11: CreateInputLayout: ${name}${index}: DXGI format ${fmt} is not a vertex element yet`); continue; }
      if (!sig) continue;                                               // the shader does not read it
      list.push({ stream: slot, offset: off, type, method: 0, usage: 5, usageIndex: sig.register });
    }
    const dev = D(x, self), lay = { dev: self, els: list };
    if (dev) { lay.model = dev; lay.h = dev.createVertexDeclaration(list.map((e) => ({ ...e, stream: 0 }))); }
    if (pp) x.w32(pp, make(x, 'ID3D11InputLayout', lay));
    return S_OK;
  };

  // ---- states: their descs kept, made into render and sampler states at each draw -------------------------
  const createState = (iface, size) => (x, self, desc, pp) => { if (pp) x.w32(pp, make(x, iface, { dev: self, desc: x.bytes(desc, size).slice() })); return S_OK; };
  const stateDesc = (size) => ({ ...child, GetDesc: (x, self, p) => { x.write(p, o(self).desc.subarray(0, size)); return 0; } });

  const device = {
    CreateBuffer: createBuffer, CreateTexture2D: createTexture2D,
    CreateTexture1D: (x, self, d, i, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    CreateTexture3D: (x, self, d, i, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    CreateShaderResourceView: createView('ID3D11ShaderResourceView', 24), CreateRenderTargetView: createView('ID3D11RenderTargetView', 20),
    CreateDepthStencilView: createView('ID3D11DepthStencilView', 24),
    CreateUnorderedAccessView: (x, self, r, d, pp) => { if (pp) x.w32(pp, 0); return E_INVALIDARG; },   // not at level 9
    CreateInputLayout: createInputLayout,
    CreateVertexShader: createShader('ID3D11VertexShader', 'vs'), CreatePixelShader: createShader('ID3D11PixelShader', 'ps'),
    CreateGeometryShader: (x, self, c, n, l, pp) => { if (pp) x.w32(pp, 0); return E_INVALIDARG; },
    CreateGeometryShaderWithStreamOutput: (x, self, ...a) => { if (a[7]) x.w32(a[7], 0); return E_INVALIDARG; },
    CreateHullShader: (x, self, c, n, l, pp) => { if (pp) x.w32(pp, 0); return E_INVALIDARG; },
    CreateDomainShader: (x, self, c, n, l, pp) => { if (pp) x.w32(pp, 0); return E_INVALIDARG; },
    CreateComputeShader: (x, self, c, n, l, pp) => { if (pp) x.w32(pp, 0); return E_INVALIDARG; },
    CreateClassLinkage: (x, self, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    CreateBlendState: createState('ID3D11BlendState', 264), CreateDepthStencilState: createState('ID3D11DepthStencilState', 52),
    CreateRasterizerState: createState('ID3D11RasterizerState', 40), CreateSamplerState: createState('ID3D11SamplerState', 52),
    // Queries: an event, done as soon as it is asked; occlusion and the rest, none.
    CreateQuery: (x, self, d, pp) => { const q = x.r32(d); if (q !== 0) { if (pp) x.w32(pp, 0); return E_NOTIMPL; } if (pp) x.w32(pp, make(x, 'ID3D11Query', { dev: self, query: q })); return S_OK; },
    CreatePredicate: (x, self, d, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    CreateCounter: (x, self, d, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    CreateDeferredContext: (x, self, f, pp) => { if (pp) x.w32(pp, 0); return DXGI_ERROR_UNSUPPORTED; },
    OpenSharedResource: (x, self, h, r, pp) => { if (pp) x.w32(pp, 0); return E_NOTIMPL; },
    // D3D11_FORMAT_SUPPORT: a format the model has textures of: texture 2D, mips, sampling, render
    // target, blending (and depth stencil for the depth formats); a vertex element's: IA vertex buffer.
    CheckFormatSupport: (x, self, fmt, p) => {
      let s = 0;
      if (FORMAT[fmt]) s |= [40, 45, 55].includes(fmt) ? 0x10020 | 0x10000 : 0x20 | 0x100 | 0x200 | 0x4000 | 0x8000 | 0x40000;
      if (DECLTYPE[fmt] !== undefined) s |= 0x2;
      if (fmt === 57 || fmt === 42) s |= 0x4;
      x.w32(p, s); return s ? S_OK : E_INVALIDARG;
    },
    CheckMultisampleQualityLevels: (x, self, fmt, n, p) => { x.w32(p, n === 1 ? 1 : 0); return S_OK; },
    CheckCounterInfo: (x, self, p) => { x.write(p, new Uint8Array(12)); return 0; },
    CheckCounter: () => E_INVALIDARG,
    // D3D11_FEATURE_THREADING (0): neither; D3D11_FEATURE_DOUBLES (1): no; the others: zeros.
    CheckFeatureSupport: (x, self, f, p, n) => { x.write(p, new Uint8Array(n)); return S_OK; },
    ...privateData,
    GetFeatureLevel: (x, self) => o(self).level, GetCreationFlags: () => 0, GetDeviceRemovedReason: () => S_OK,
    GetImmediateContext: (x, self, pp) => { x.w32(pp, addRef(o(self).ctx)); return 0; },
    SetExceptionMode: () => S_OK, GetExceptionMode: () => 0,
  };

  // ---- the immediate context: the pipeline's state, made into the model's at each draw ----------------------
  const S = (self) => o(self).state;
  const bind = (key) => (x, self, start, n, p) => { const s = S(self)[key]; for (let i = 0; i < n; i++) s[start + i] = p ? x.r32(p + 4 * i) : 0; return 0; };
  const getBound = (key) => (x, self, start, n, p) => { const s = S(self)[key]; for (let i = 0; i < n; i++) x.w32(p + 4 * i, addRef(s[start + i] || 0)); return 0; };
  const floats = (x, p, n) => Array.from({ length: n }, (_, i) => x.f32(p + 4 * i));
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const argb = ([r, g, b, a]) => ((byte(a) << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b)) >>> 0;
  // The render target views' surfaces as the model's targets (null: the back buffer at first draw).
  const surfaceOf = (v) => { const r = v && o(v) && o(o(v).res); return r ? r.surface || 0 : 0; };
  const applyTargets = (dev, s) => {
    const rt = surfaceOf(s.rtv[0]);
    if (rt && rt !== s.appliedRt) { dev.setRenderTarget(0, rt); s.appliedRt = rt; s.appliedVp = null; }
    const ds = surfaceOf(s.dsv);
    if (ds !== s.appliedDs) { dev.setDepthStencilSurface(ds); s.appliedDs = ds; }
  };
  const applyViewport = (dev, s) => {
    const v = s.viewport; if (!v || s.appliedVp === v) return;
    dev.setViewport({ x: Math.round(v[0]), y: Math.round(v[1]), width: Math.round(v[2]), height: Math.round(v[3]), minZ: v[4], maxZ: v[5] });
    s.appliedVp = v;
  };
  // A shader's constants: each mapped range of its constant buffers into its c registers; then c0's
  // half-pixel fix of a vertex shader, for the viewport.
  const applyConstants = (x, dev, sh, cbs, isVs, s) => {
    for (const m of sh.d9.cb) {
      const b = o(cbs[m.buffer]); if (!b || !m.count) continue;
      const f = new Float32Array(b.bytes.buffer.slice(16 * m.start, 16 * (m.start + m.count)));
      const ints = sh.ints.get(m.buffer);
      if (ints) {
        const u = new Int32Array(b.bytes.buffer, 0, b.bytes.length >> 2);
        for (const v of ints) for (let k = 0; k < v.count; k++) { const at = (v.offset >> 2) + k - 4 * m.start; if (at >= 0 && at < f.length) f[at] = u[(v.offset >> 2) + k]; }
      }
      (isVs ? dev.setVertexShaderConstantF : dev.setPixelShaderConstantF)(m.target, f);
    }
    if (isVs && sh.d9.fixup >= 0 && s.viewport) dev.setVertexShaderConstantF(sh.d9.fixup, Float32Array.of(-1 / s.viewport[2], 1 / s.viewport[3], 0, 0));
  };
  // D3D11_SAMPLER_DESC: Filter, AddressU/V/W, MipLODBias, MaxAnisotropy, ComparisonFunc, BorderColor, MinLOD, MaxLOD.
  const applySampler = (x, dev, stage, smp) => {
    const d = smp && o(smp) ? new DataView(o(smp).desc.buffer) : null, u = (k) => (d ? d.getUint32(4 * k, true) : [0x15, 3, 3, 3][k]);
    const filter = u(0), aniso = (filter & 0x55) === 0x55;
    dev.setSamplerState(stage, 1, u(1)); dev.setSamplerState(stage, 2, u(2)); dev.setSamplerState(stage, 3, u(3));
    dev.setSamplerState(stage, 5, aniso ? 3 : filter & 4 ? 2 : 1); dev.setSamplerState(stage, 6, aniso ? 3 : filter & 0x10 ? 2 : 1); dev.setSamplerState(stage, 7, filter & 1 ? 2 : 1);
    if (d) dev.setSamplerState(stage, 4, argb([0, 1, 2, 3].map((k) => d.getFloat32(28 + 4 * k, true))));
  };
  // D3D11_BLEND_DESC's first target, D3D11_DEPTH_STENCIL_DESC, D3D11_RASTERIZER_DESC: their numbers are D3D9's.
  const applyStates = (dev, s) => {
    const rd = (ob, k) => new DataView(ob.desc.buffer).getUint32(4 * k, true);
    const b = s.blend && o(s.blend), on = b ? rd(b, 2) : 0;
    dev.setRenderState(27, on);                                        // ALPHABLENDENABLE
    if (b) {
      dev.setRenderState(19, rd(b, 3)); dev.setRenderState(20, rd(b, 4)); dev.setRenderState(171, rd(b, 5));
      dev.setRenderState(206, 1); dev.setRenderState(207, rd(b, 6)); dev.setRenderState(208, rd(b, 7)); dev.setRenderState(209, rd(b, 8));
      dev.setRenderState(168, b.desc[36] & 15);                         // COLORWRITEENABLE
    } else dev.setRenderState(168, 15);
    dev.setRenderState(193, argb(s.blendFactor));
    const z = s.depth && o(s.depth);
    dev.setRenderState(7, z ? rd(z, 0) : 1); dev.setRenderState(14, z ? rd(z, 1) : 1); dev.setRenderState(23, z ? rd(z, 2) : 2);
    dev.setRenderState(52, z ? rd(z, 3) : 0);
    if (z && rd(z, 3)) {
      const zd = z.desc; dev.setRenderState(58, zd[16]); dev.setRenderState(59, zd[17]); dev.setRenderState(57, s.stencilRef);
      dev.setRenderState(53, rd(z, 5)); dev.setRenderState(54, rd(z, 6)); dev.setRenderState(55, rd(z, 7)); dev.setRenderState(56, rd(z, 8));
    }
    const ra = s.raster && o(s.raster), cull = ra ? rd(ra, 1) : 3, ccw = ra ? rd(ra, 2) : 0;
    dev.setRenderState(8, ra ? rd(ra, 0) : 3);
    dev.setRenderState(22, cull === 1 ? 1 : (cull === 3) !== !!ccw ? 3 : 2);   // back faces (clockwise front): CCW
    const scissor = ra ? rd(ra, 7) : 0;
    dev.setRenderState(174, scissor);
    if (scissor && s.scissor) dev.setScissorRect(...s.scissor);
  };
  // A draw: the model's state made from the context's, then its draw; nothing when a shader has no
  // Direct3D 9 twin or no model draws.
  const prepare = (x, self) => {
    const s = S(self), dev = D(x, o(self).dev), vs = o(s.vs), ps = o(s.ps), lay = o(s.layout);
    if (!dev || !vs || !ps || !vs.d9 || !ps.d9 || !lay || vs.h === undefined || ps.h === undefined) return null;
    applyTargets(dev, s); applyViewport(dev, s);
    dev.setVertexShader(vs.h); dev.setPixelShader(ps.h); dev.setVertexDeclaration(lay.h);
    applyConstants(x, dev, vs, s.vsCb, true, s); applyConstants(x, dev, ps, s.psCb, false, s);
    for (const m of ps.d9.samplers) {
      const srv = o(s.srv[m.resource]), t = srv && o(srv.res);
      dev.setTexture(m.target, t && t.h9 !== undefined ? t.h9 : 0);
      applySampler(x, dev, m.target, s.samplers[m.sampler]);
    }
    applyStates(dev, s);
    const slot = lay.els.length ? lay.els[0].stream : 0, vb = s.vb[slot], b = vb && o(vb.buf);
    if (!b || b.h === undefined) return null;
    dev.setStreamSource(0, b.h, vb.offset, vb.stride);
    return { dev, s, vb, b };
  };
  const draw = (x, self, n, start) => {
    const p = prepare(x, self), prims = PRIMS[S(self).topology];
    if (!p || !prims || !prims(n)) return 0;
    p.dev.drawPrimitive(S(self).topology, start, prims(n));
    return 0;
  };
  const drawIndexed = (x, self, n, startIndex, baseVertex) => {
    const p = prepare(x, self), s = S(self), prims = PRIMS[s.topology], ib = s.ib && o(s.ib.buf);
    if (!p || !prims || !prims(n) || !ib || ib.h === undefined) return 0;
    const size = s.ib.fmt === 42 ? 4 : 2;
    if (ib.fmtSeen !== s.ib.fmt && s.ib.fmt === 42) x.win.say('d3d11: 32-bit indices are drawn as 16-bit ones');
    ib.fmtSeen = s.ib.fmt;
    p.dev.setIndices(ib.h);
    p.dev.drawIndexedPrimitive(s.topology, baseVertex | 0, 0, Math.floor((p.b.size - p.vb.offset) / Math.max(1, p.vb.stride)), startIndex + s.ib.offset / size, prims(n));
    return 0;
  };
  // Map: guest memory holding the resource's bytes (a buffer's, a texture level's), given back at Unmap.
  const map = (x, self, res, sub, type, flags, pm) => {
    const r = o(res); if (!r) return E_INVALIDARG;
    let bytes, pitch;
    if (r.iface === 'ID3D11Buffer') { bytes = r.bytes; pitch = r.size; }
    else { const [w, h] = levelSize(r, sub); pitch = w * r.bpp; bytes = (r.lv[sub] ||= new Uint8Array(pitch * h)); }
    const m = (r.maps ||= {}); if (!m[sub]) m[sub] = galloc(x, bytes.length);
    if (type !== 4) x.write(m[sub], bytes);                            // D3D11_MAP_WRITE_DISCARD: nothing to read
    x.w32(pm, m[sub]); x.w32(pm + 4, pitch); x.w32(pm + 8, bytes.length);
    r.mapped = { sub, type };
    return S_OK;
  };
  const unmap = (x, self, res, sub) => {
    const r = o(res); if (!r || !r.mapped) return 0;
    r.mapped = null;
    // A buffer: only the bytes that changed go to the model (a dynamic vertex buffer of megabytes is mapped
    // once a batch, a few hundred bytes written each time).
    if (r.iface === 'ID3D11Buffer') {
      const now = x.bytes(r.maps[sub], r.size), was = r.bytes;
      let lo = 0, hi = r.size;
      while (lo < hi && now[lo] === was[lo]) lo++;
      while (hi > lo && now[hi - 1] === was[hi - 1]) hi--;
      if (lo < hi) { was.set(now.subarray(lo, hi), lo); if (r.h !== undefined) r.model.bufferWrite(r.h, lo, was.subarray(lo, hi)); }
    }
    else { const [w] = levelSize(r, sub); writeLevel(x, r, sub, null, r.maps[sub], w * r.bpp); }
    return 0;
  };
  // UpdateSubresource(resource, level, box, data, row pitch, depth pitch): D3D11_BOX left, top, front, right, bottom, back.
  const update = (x, self, res, sub, pBox, src, pitch) => {
    const r = o(res); if (!r) return 0;
    const box = pBox ? [x.r32(pBox), x.r32(pBox + 4), x.r32(pBox + 12), x.r32(pBox + 16)] : null;
    if (r.iface === 'ID3D11Buffer') {
      const a = box ? box[0] : 0, n = (box ? box[2] : r.size) - a;
      r.bytes.set(x.bytes(src, n), a);
      if (r.h !== undefined) r.model.bufferWrite(r.h, a, r.bytes.subarray(a, a + n));
    } else writeLevel(x, r, sub, box, src, pitch);
    return 0;
  };
  const clearRtv = (x, self, v, pc) => {
    const s = S(self), dev = D(x, o(self).dev), sf = surfaceOf(v); if (!dev || !sf) return 0;
    if (sf !== s.appliedRt) { dev.setRenderTarget(0, sf); s.appliedRt = sf; s.appliedVp = null; }
    dev.setRenderState(174, 0);
    dev.clear(null, 1, argb(floats(x, pc, 4)), 1, 0);
    return 0;
  };
  const context = {
    ...child,
    VSSetConstantBuffers: bind('vsCb'), PSSetConstantBuffers: bind('psCb'), PSSetShaderResources: bind('srv'), PSSetSamplers: bind('samplers'),
    VSSetShader: (x, self, sh) => { S(self).vs = sh; return 0; }, PSSetShader: (x, self, sh) => { S(self).ps = sh; return 0; },
    VSGetConstantBuffers: getBound('vsCb'), PSGetConstantBuffers: getBound('psCb'), PSGetShaderResources: getBound('srv'), PSGetSamplers: getBound('samplers'),
    VSGetShader: (x, self, pp, pc, pn) => { x.w32(pp, addRef(S(self).vs)); if (pn) x.w32(pn, 0); return 0; },
    PSGetShader: (x, self, pp, pc, pn) => { x.w32(pp, addRef(S(self).ps)); if (pn) x.w32(pn, 0); return 0; },
    Draw: draw, DrawIndexed: drawIndexed,
    DrawInstanced: (x, self, n, inst, start) => draw(x, self, n, start),
    DrawIndexedInstanced: (x, self, n, inst, si, bv) => drawIndexed(x, self, n, si, bv),
    Map: map, Unmap: unmap, UpdateSubresource: update,
    IASetInputLayout: (x, self, l) => { S(self).layout = l; return 0; },
    IAGetInputLayout: (x, self, pp) => { x.w32(pp, addRef(S(self).layout)); return 0; },
    IASetVertexBuffers: (x, self, start, n, pb, pstr, poff) => {
      for (let i = 0; i < n; i++) S(self).vb[start + i] = { buf: x.r32(pb + 4 * i), stride: x.r32(pstr + 4 * i), offset: x.r32(poff + 4 * i) };
      return 0;
    },
    IAGetVertexBuffers: (x, self, start, n, pb, pstr, poff) => {
      for (let i = 0; i < n; i++) { const v = S(self).vb[start + i]; if (pb) x.w32(pb + 4 * i, addRef(v ? v.buf : 0)); if (pstr) x.w32(pstr + 4 * i, v ? v.stride : 0); if (poff) x.w32(poff + 4 * i, v ? v.offset : 0); }
      return 0;
    },
    IASetIndexBuffer: (x, self, b, fmt, off) => { S(self).ib = b ? { buf: b, fmt, offset: off } : null; return 0; },
    IAGetIndexBuffer: (x, self, pp, pf, po) => { const i = S(self).ib; if (pp) x.w32(pp, addRef(i ? i.buf : 0)); if (pf) x.w32(pf, i ? i.fmt : 0); if (po) x.w32(po, i ? i.offset : 0); return 0; },
    IASetPrimitiveTopology: (x, self, t) => { S(self).topology = t; return 0; },
    IAGetPrimitiveTopology: (x, self, p) => { x.w32(p, S(self).topology); return 0; },
    OMSetRenderTargets: (x, self, n, prt, dsv) => { const s = S(self); s.rtv = Array.from({ length: n }, (_, i) => x.r32(prt + 4 * i)); s.dsv = dsv; return 0; },
    OMGetRenderTargets: (x, self, n, prt, pdsv) => { const s = S(self); for (let i = 0; i < n; i++) if (prt) x.w32(prt + 4 * i, addRef(s.rtv[i] || 0)); if (pdsv) x.w32(pdsv, addRef(s.dsv)); return 0; },
    OMSetRenderTargetsAndUnorderedAccessViews: (x, self, n, prt, dsv) => (n !== 0xffffffff ? context.OMSetRenderTargets(x, self, n, prt, dsv) : 0),
    OMSetBlendState: (x, self, b, pf, mask) => { const s = S(self); s.blend = b; s.blendFactor = pf ? floats(x, pf, 4) : [1, 1, 1, 1]; return 0; },
    OMGetBlendState: (x, self, pp, pf, pm) => { const s = S(self); if (pp) x.w32(pp, addRef(s.blend)); if (pf) s.blendFactor.forEach((v, i) => x.w32(pf + 4 * i, f32bits(v))); if (pm) x.w32(pm, 0xffffffff); return 0; },
    OMSetDepthStencilState: (x, self, d, ref) => { S(self).depth = d; S(self).stencilRef = ref; return 0; },
    OMGetDepthStencilState: (x, self, pp, pr) => { if (pp) x.w32(pp, addRef(S(self).depth)); if (pr) x.w32(pr, S(self).stencilRef); return 0; },
    RSSetState: (x, self, r) => { S(self).raster = r; return 0; },
    RSGetState: (x, self, pp) => { x.w32(pp, addRef(S(self).raster)); return 0; },
    RSSetViewports: (x, self, n, p) => { if (n) S(self).viewport = floats(x, p, 6); return 0; },
    RSGetViewports: (x, self, pn, p) => { const v = S(self).viewport; if (p && v) v.forEach((f, i) => x.w32(p + 4 * i, f32bits(f))); x.w32(pn, v ? 1 : 0); return 0; },
    RSSetScissorRects: (x, self, n, p) => { S(self).scissor = n ? [0, 1, 2, 3].map((k) => x.r32(p + 4 * k) | 0) : null; return 0; },
    RSGetScissorRects: (x, self, pn, p) => { const r = S(self).scissor; if (p && r) r.forEach((v, i) => x.w32(p + 4 * i, v)); x.w32(pn, r ? 1 : 0); return 0; },
    ClearRenderTargetView: clearRtv,
    ClearDepthStencilView: (x, self, v, flags, z, stencil) => {
      const s = S(self), dev = D(x, o(self).dev), sf = surfaceOf(v); if (!dev || !sf) return 0;
      if (sf !== s.appliedDs) { dev.setDepthStencilSurface(sf); s.appliedDs = sf; }
      dev.setRenderState(174, 0);
      dev.clear(null, (flags & 1 ? 2 : 0) | (flags & 2 ? 4 : 0), 0, z, stencil & 255);
      return 0;
    },
    // A copy between textures: their kept bytes; render targets' are not read back.
    CopyResource: (x, self, dst, src) => {
      const d = o(dst), s = o(src); if (!d || !s) return 0;
      if (d.iface === 'ID3D11Buffer') { d.bytes.set(s.bytes.subarray(0, d.size)); if (d.h !== undefined) d.model.bufferWrite(d.h, 0, d.bytes); }
      else if (s.surface && d.surface) D(x, o(self).dev).stretchRect(s.surface, null, d.surface, null, 0);
      else s.lv.forEach((lv, l) => { if (lv && d.h9 !== undefined) { d.lv[l] = lv.slice(); d.model.textureWrite(d.h9, l, null, d.lv[l], levelSize(d, l)[0] * d.bpp); } });
      return 0;
    },
    CopySubresourceRegion: (x, self, dst, dsub, dx, dy, dz, src, ssub, pBox) => {
      const d = o(dst), s = o(src); if (!d || !s) return 0;
      if (s.surface && d.surface) {
        const b = pBox ? [x.r32(pBox), x.r32(pBox + 4), x.r32(pBox + 12), x.r32(pBox + 16)] : [0, 0, s.w, s.ht];
        D(x, o(self).dev).stretchRect(s.surface, b, d.surface, [dx, dy, dx + b[2] - b[0], dy + b[3] - b[1]], 0);
      }
      return 0;
    },
    GenerateMips: () => 0, SetResourceMinLOD: () => 0, GetResourceMinLOD: () => 0, ResolveSubresource: () => 0,
    Begin: () => 0, End: () => 0,
    GetData: (x, self, q, p, n) => { if (p && n >= 4) x.w32(p, 1); return S_OK; },
    SetPredication: () => 0, GetPredication: (x, self, pp, pv) => { if (pp) x.w32(pp, 0); if (pv) x.w32(pv, 0); return 0; },
    ClearState: (x, self) => { o(self).state = freshState(); return 0; },
    Flush: () => 0, GetType: () => 0, GetContextFlags: () => 0,
  };
  for (const st2 of ['GS', 'HS', 'DS', 'CS', 'VS']) for (const k of ['SetShaderResources', 'SetSamplers', 'SetConstantBuffers', 'SetShader', 'SetUnorderedAccessViews']) {
    if (!context[st2 + k]) context[st2 + k] = () => 0;
  }
  for (const st2 of ['GS', 'HS', 'DS', 'CS', 'VS']) for (const k of ['GetShaderResources', 'GetSamplers', 'GetConstantBuffers', 'GetUnorderedAccessViews']) {
    if (!context[st2 + k]) context[st2 + k] = (x, self, start, n, p) => { for (let i = 0; i < n; i++) x.w32(p + 4 * i, 0); return 0; };
  }
  context.GSGetShader = context.HSGetShader = context.DSGetShader = context.CSGetShader = (x, self, pp, pc, pn) => { x.w32(pp, 0); if (pn) x.w32(pn, 0); return 0; };

  const IMPL = {
    IDXGIFactory1: dxgiFactory, IDXGIAdapter1: adapter, IDXGIOutput: output, IDXGISwapChain: swapChain, IDXGIDevice1: dxgiDevice, IDXGISurface: dxgiSurface,
    ID3D11Device: device, ID3D11DeviceContext: context, ID3D11Buffer: buffer, ID3D11Texture2D: texture2d,
    ID3D11ShaderResourceView: view('ID3D11ShaderResourceView', 24), ID3D11RenderTargetView: view('ID3D11RenderTargetView', 20),
    ID3D11DepthStencilView: view('ID3D11DepthStencilView', 24),
    ID3D11VertexShader: child, ID3D11PixelShader: child, ID3D11GeometryShader: child, ID3D11InputLayout: child,
    ID3D11BlendState: stateDesc(264), ID3D11DepthStencilState: stateDesc(52), ID3D11RasterizerState: stateDesc(40), ID3D11SamplerState: stateDesc(52),
    ID3D11Query: { ...child, GetDataSize: () => 4, GetDesc: (x, self, p) => { x.w32(p, o(self).query); x.w32(p + 4, 0); return 0; } },
  };
  const createFactory = (x, riid, pp) => {
    if (!factory) factory = make(x, 'IDXGIFactory1'); else o(factory).ref++;
    const hr = unknown.QueryInterface(x, factory, riid, pp); o(factory).ref--;
    return hr;
  };
  const dxgi = {
    CreateDXGIFactory: ['pp', createFactory], CreateDXGIFactory1: ['pp', createFactory],
    CreateDXGIFactory2: ['upp', (x, flags, riid, pp) => createFactory(x, riid, pp)],
  };
  const d3d11 = {
    // D3D11CreateDevice(adapter, driver type, software, flags, levels, n, SDK version, &device, &level, &context)
    D3D11CreateDevice: ['pupupuuppp', (x, ad, type, sw, flags, levels, n, sdk, ppDev, pLevel, ppCtx) => createDevice(x, levels, n, ppDev, pLevel, ppCtx)],
    D3D11CreateDeviceAndSwapChain: ['pupupuuppppp', (x, ad, type, sw, flags, levels, n, sdk, desc, ppSwap, ppDev, pLevel, ppCtx) => {
      let dev = 0;
      const tmp = x.win.heapAlloc(4);
      const hr = createDevice(x, levels, n, tmp, pLevel, ppCtx);
      if (hr) { if (ppSwap) x.w32(ppSwap, 0); if (ppDev) x.w32(ppDev, 0); return hr; }
      dev = x.r32(tmp); x.win.heapFree(tmp);
      if (ppSwap && desc) createSwapChain(x, factory, dev, desc, ppSwap);
      if (ppDev) x.w32(ppDev, dev); else unknown.Release(x, dev);
      return S_OK;
    }],
  };
  let ord = 100;
  for (const [iface, ms] of Object.entries(METHODS)) for (const [n, sg] of ms) {
    const f = unknown[n] || IMPL[iface][n] || NOT(iface, n);
    (/^IDXGI/.test(iface) ? dxgi : d3d11)[`${iface}::${n}`] = [sigOf(sg), f, { ordinal: ord++ }];
  }
  return [{ dll: 'd3d11.dll', fns: d3d11 }, { dll: 'dxgi.dll', fns: dxgi }];
}
