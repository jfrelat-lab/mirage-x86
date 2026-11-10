// fxmesa.js — libMesaGL.so.2 as the 3dfx Linux games of 1997-1998 found it: Mesa on Glide, OpenGL 1.1
// plus fxMesa, the calls that open the Voodoo's full screen (fxMesaCreateContext at a Glide resolution,
// fxMesaMakeCurrent, fxMesaSwapBuffers). GLQuake 0.97 links it; Quake II's ref_gl.so dlopens libGL.so
// and asks dlsym for the same names. There is no X window: the Voodoo drew on its own output, and here
// the screen is PRISM's WebGL picture, as an SDL OpenGL window's is (linuxrun.js).
//
// The GL entry points are gl.js's table (`glLib`: MIRAGE's signatures, whatever answers them: PRISM's
// gl.js in the page, a recorder in the tests). libglide2x.so is only named: GLQuake's ELF lists it as
// NEEDED, so the dynamic loader must find one, but nothing calls Glide but Mesa, and Mesa is here.

// glide.h's GrScreenResolution_t: the sizes fxMesaCreateContext is asked for.
const RES = [[320, 200], [320, 240], [400, 256], [512, 384], [640, 200], [640, 350], [640, 400], [640, 480],
  [800, 600], [960, 720], [856, 480], [512, 256], [1024, 768], [1280, 1024], [1600, 1200], [400, 300]];

export function fxmesa(glLib) {
  const st = { ctx: 0, current: 0, lastSwap: -1, palette: null };
  const open = (x, w, h) => {
    x.backend.setVideoMode(w, h, true);
    // The Voodoo's gamma, as Glide set it from the environment when the board opened: Quake II's ref_gl
    // puts its brightness there (putenv SST_GAMMA=1.6 for vid_gamma 1) and leaves its textures as they
    // are, so without it every level was a shade too dark. Unset: no correction.
    const g = parseFloat((x.lx.getenv && (x.lx.getenv('SSTV2_GAMMA') || x.lx.getenv('SST_GAMMA'))) || '');
    if (x.backend.setGamma) x.backend.setGamma(g > 0 ? g : 1);
    st.ctx = st.ctx || x.alloc(16);                         // the context: a handle the program keeps
    x.w32(st.ctx, w); x.w32(st.ctx + 4, h);
    return st.ctx;
  };
  const fns = {
    ...glLib.fns,
    fxMesaCreateContext: ['uuup', (x, win, res, refresh) => { const [w, h] = RES[res] || [640, 480]; return open(x, w, h); }],
    fxMesaCreateBestContext: ['uiip', (x, win, w, h) => open(x, w || 640, h || 480)],
    fxMesaMakeCurrent: ['p', (x, c) => { st.current = c; return 0; }],
    fxMesaGetCurrentContext: ['', () => st.current],
    fxMesaDestroyContext: ['p', (x, c) => { if (st.current === c) st.current = 0; return 0; }],
    // A Voodoo swaps on the vertical blank: no faster than sixty a second on the guest's clock.
    fxMesaSwapBuffers: ['', (x) => {
      const now = x.lx.mono();
      if (now < st.lastSwap + 1 / 60) return x.waitUntil(st.lastSwap + 1 / 60);
      st.lastSwap = now;
      x.backend.swap();
      return 0;
    }],
    fxQueryHardware: ['', () => 0],                           // GR_SSTTYPE_VOODOO
    fxMesaSetNearFar: ['ff', () => 0],
    fxMesaUpdateScreenSize: ['p', () => 0],
    // 3DFX_set_global_palette: kept, not used -- the games ask for it only when GL_EXTENSIONS names it,
    // and PRISM's does not; they then upload their textures as RGBA.
    gl3DfxSetPaletteEXT: ['p', (x, p) => { st.palette = x.bytes(p, 1024); return 0; }],
  };
  return { soname: 'libMesaGL.so.2', links: ['libMesaGL.so', 'libGL.so', 'libGL.so.1', 'libMesaGL.so.2.5', 'libMesaGL.so.2.6'], fns };
}

export function glide() {
  return { soname: 'libglide2x.so', links: ['libglide2x.so.2'], fns: { grGlideInit: ['', () => 0], grGlideShutdown: ['', () => 0] } };
}
