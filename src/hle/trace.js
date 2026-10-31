// trace.js — a backend that draws nothing and remembers everything: the video mode, every call by name
// (counted), the shader sources, the frames presented. For the tests and tools/linux/run.mjs
// (MIRAGE_LXHLE), where there is no WebGL; it answers what a program needs to go on — object names for
// glCreateShader and glCreateProgram, uniform locations — as a driver would. Direct3D 9's device model
// is win32/d3d9.js's recorder, its calls counted in the same summary.
import { recordD3D9 } from '../win32/d3d9.js';

export function traceBackend() {
  let next = 1;
  const t = {
    mode: null, frames: 0, calls: new Map(), shaders: new Map(), first: [], quit: false,
    trace(name, args) { t.calls.set(name, (t.calls.get(name) || 0) + 1); if (t.first.length < 400) t.first.push([name, args]); },
    setVideoMode(w, h, opengl) { t.mode = { w, h, opengl }; },
    swap() { t.frames++; },
    nextEvent() { return null; },
    d3d9() { return t.d3d || (t.d3d = recordD3D9()); },
    gl(name, a) {
      switch (name) {
        case 'glCreateShader': case 'glCreateShaderObjectARB': case 'glCreateProgram': case 'glCreateProgramObjectARB':
        case 'glGenTexture': return next++;
        case 'glGenLists': { const n = next; next += a[0]; return n; }
        case 'glShaderSource': t.shaders.set(a[0], a[1]); return 0;
        case 'glGetUniformLocation': return next++;
        default: return 0;
      }
    },
    summary() {
      return { mode: t.mode, frames: t.frames, calls: Object.fromEntries([...t.calls].sort((a, b) => b[1] - a[1])), shaders: [...t.shaders.values()],
        d3d: t.d3d ? Object.fromEntries([...t.d3d.calls].sort((a, b) => b[1] - a[1])) : null };
    },
  };
  return t;
}
