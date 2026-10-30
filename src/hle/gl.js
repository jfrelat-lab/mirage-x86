// gl.js — libGL.so.1 (and libGLU.so.1) for MIRAGE-LINUX: the i386 entry points the Linux OpenGL intros
// call — OpenGL 1.x in immediate mode (Yellow Rose of Texas, 2003) and OpenGL 2.0's GLSL (the 1K intros
// of 2009: a fragment shader on a rectangle) — their arguments decoded from the caller's stack (the
// signatures of sdl12.js), what they point to read from guest memory (a shader's source, a uniform's
// name, pixels, vectors), and the call handed to a backend as JavaScript values.
//
// The backend is to be PRISM's src/env/gl.js (ROADMAP O9: one OpenGL for both projects, its WebGL2
// rasteriser in a page, its software one held to Mesa), with GLSL added there; today src/hle/trace.js,
// which records the calls for the tests and tools/linux/run.mjs.

// The GL entry points passed to the backend as they are: name, signature.
const PLAIN = `
glClear u; glClearColor ffff; glClearDepth d; glColor3f fff; glColor4f ffff; glColor3ub uuu; glColor4ub uuuu; glColor3d ddd;
glRecti iiii; glRects iiii; glRectf ffff; glRectd dddd; glBegin u; glEnd ; glVertex2f ff; glVertex3f fff; glVertex2i ii; glVertex3i iii; glVertex2d dd; glVertex3d ddd;
glTexCoord2f ff; glTexCoord1f f; glNormal3f fff; glMatrixMode u; glLoadIdentity ; glRotatef ffff; glRotated dddd; glTranslatef fff; glTranslated ddd; glScalef fff;
glFrustum dddddd; glOrtho dddddd; glViewport iiii; glEnable u; glDisable u; glBlendFunc uu; glLineWidth f; glPointSize f; glShadeModel u;
glDepthFunc u; glDepthMask u; glCullFace u; glFrontFace u; glPushMatrix ; glPopMatrix ; glFlush ; glFinish ; glHint uu; glPolygonMode uu;
glBindTexture uu; glTexParameteri uui; glTexParameterf uuf; glTexEnvi uui; glCopyTexSubImage2D uiiiiiii; glCopyTexImage2D uuiiiiii; glActiveTexture u;
glCreateShader u; glCompileShader u; glCreateProgram ; glAttachShader uu; glLinkProgram u; glUseProgram u; glDeleteShader u; glDeleteProgram u;
glUniform1f if; glUniform2f iff; glUniform3f ifff; glUniform4f iffff; glUniform1i ii; glUniform2i iii;
glCreateShaderObjectARB u; glCompileShaderARB u; glCreateProgramObjectARB ; glAttachObjectARB uu; glLinkProgramARB u; glUseProgramObjectARB u;
glUniform1fARB if; glUniform2fARB iff; glUniform3fARB ifff; glUniform4fARB iffff; glUniform1iARB ii;
glBindFramebuffer uu; glFramebufferTexture2D uuuui; glCheckFramebufferStatus u; glBindRenderbuffer uu; glRenderbufferStorage uuii;
glFramebufferRenderbuffer uuuu; glGenerateMipmap u; glBlitFramebuffer iiiiiiiiuu; glIsFramebuffer u; glIsRenderbuffer u;
glBindFramebufferEXT uu; glFramebufferTexture2DEXT uuuui; glCheckFramebufferStatusEXT u; glBindRenderbufferEXT uu; glRenderbufferStorageEXT uuii;
glFramebufferRenderbufferEXT uuuu; glGenerateMipmapEXT u; glBlitFramebufferEXT iiiiiiiiuu; glIsFramebufferEXT u; glIsRenderbufferEXT u;
glFogi ui; glFogf uf; glAccum uf; glClearAccum ffff; glStencilFunc uiu; glStencilOp uuu; glColorMask uuuu; glDrawBuffer u; glReadBuffer u; glCallList u; glEndList ; glNewList uu;
`;

/** The vectors some entry points take by pointer: their length in floats (or doubles, `d`). */
const VECTORS = { glVertex2fv: 2, glVertex3fv: 3, glNormal3fv: 3, glTexCoord2fv: 2, glMultMatrixf: 16, glLoadMatrixf: 16,
  glMultMatrixd: -16, glLoadMatrixd: -16 };

export function gl() {
  const fns = {};
  for (const line of PLAIN.split(';')) {
    const [name, sig = ''] = line.trim().split(/\s+/);
    if (name) fns[name] = [sig, (x, ...a) => x.backend.gl(name, a)];
  }
  for (const [name, n] of Object.entries(VECTORS)) fns[name] = ['p', (x, p) => x.backend.gl(name, [n > 0 ? x.floats(p, n) : x.doubles(p, -n)])];
  // Every other immediate-mode spelling (glVertex{2,3,4}, glTexCoord{1..4}, glNormal3, glColor{3,4},
  // glMultiTexCoord{1..4} with and without ARB, each type, scalar and v): PRISM's gl.js reads a v form's
  // pointer itself; a recorder gets the arguments as they come. Paradistance (Titan, 2009) calls
  // glTexCoord3iv.
  const SIG = { b: 'i', s: 'i', i: 'i', f: 'f', d: 'd', ub: 'u', us: 'u', ui: 'u' };
  const imm = (name, n, types) => { for (const t of types) {
    if (!fns[`${name}${n}${t}`]) fns[`${name}${n}${t}`] = [SIG[t].repeat(n), (x, ...a) => x.backend.gl(`${name}${n}${t}`, a)];
    if (!fns[`${name}${n}${t}v`]) fns[`${name}${n}${t}v`] = ['p', (x, ...a) => x.backend.gl(`${name}${n}${t}v`, a)];
  } };
  for (const n of [2, 3, 4]) imm('glVertex', n, ['s', 'i', 'f', 'd']);
  for (const n of [1, 2, 3, 4]) imm('glTexCoord', n, ['s', 'i', 'f', 'd']);
  imm('glNormal', 3, ['b', 's', 'i', 'f', 'd']);
  for (const n of [1, 2, 3, 4]) for (const t of ['s', 'i', 'f', 'd']) for (const arb of ['', 'ARB']) {
    const nm = `glMultiTexCoord${n}${t}${arb}`;
    if (!fns[nm]) fns[nm] = ['u' + SIG[t].repeat(n), (x, ...a) => x.backend.gl(nm, a)];
    if (!fns[`glMultiTexCoord${n}${t}v${arb}`]) fns[`glMultiTexCoord${n}${t}v${arb}`] = ['up', (x, ...a) => x.backend.gl(`glMultiTexCoord${n}${t}v${arb}`, a)];
  }
  if (!fns.glClientActiveTexture) fns.glClientActiveTexture = ['u', (x, ...a) => x.backend.gl('glClientActiveTexture', a)];
  // Uniforms by vector and matrix, and the ARB integer forms (kindernoiser, Rgba 2007, asks for
  // glUniform4fv and leaves when it is not there): PRISM reads the vectors through the pointer.
  const put = (name, sig) => { if (!fns[name]) fns[name] = [sig, (x, ...a) => x.backend.gl(name, a)]; };
  for (const arb of ['', 'ARB']) {
    for (const n of [1, 2, 3, 4]) { put(`glUniform${n}fv${arb}`, 'iip'); put(`glUniform${n}iv${arb}`, 'iip'); put(`glUniform${n}i${arb}`, 'i'.repeat(n + 1)); put(`glUniform${n}f${arb}`, 'i' + 'f'.repeat(n)); }
  }
  put('glUniformMatrix3fv', 'iiup'); put('glUniformMatrix4fv', 'iiup'); put('glUniformMatrix4fvARB', 'iiup');
  put('glGetIntegerv', 'up');
  // glGetString: a recorder's answer is a driver's of the time; PRISM's gl.js answers its own.
  const strs = new Map();
  fns.glGetString = ['u', (x, name) => {
    const s0 = { 0x1f00: 'PRISM', 0x1f01: 'PRISM', 0x1f02: '2.1', 0x1f03: '' }[name];
    if (s0 === undefined) return 0;
    if (!strs.has(name)) { const p = x.alloc(s0.length + 1); x.write(p, new TextEncoder().encode(s0 + '\0')); strs.set(name, p); }
    return strs.get(name);
  }];
  // glColor{3,4}{b,ub,s,us,i,ui,f,d}v: the components read from memory, then as glColor3ub and the rest.
  // Metatunnel (2009) hands glColor4ubv the address of its tick count: its shader reads the time back
  // from gl_Color.
  const READ = { b: (x, p) => (x.r8(p) << 24) >> 24, ub: (x, p) => x.r8(p), s: (x, p) => (x.r16(p) << 16) >> 16, us: (x, p) => x.r16(p),
    i: (x, p) => x.r32(p) | 0, ui: (x, p) => x.r32(p), f: (x, p) => x.f32(p), d: (x, p) => x.f64(p) };
  const STEP = { b: 1, ub: 1, s: 2, us: 2, i: 4, ui: 4, f: 4, d: 8 };
  for (const n of [3, 4]) for (const t of Object.keys(READ)) {
    fns[`glColor${n}${t}v`] = ['p', (x, p) => x.backend.gl(`glColor${n}${t}`, Array.from({ length: n }, (_, k) => READ[t](x, p + STEP[t] * k)))];
    if (!fns[`glColor${n}${t}`]) fns[`glColor${n}${t}`] = [(t === 'd' ? 'd' : t === 'f' ? 'f' : t.startsWith('u') ? 'u' : 'i').repeat(n), (x, ...a) => x.backend.gl(`glColor${n}${t}`, a)];
  }
  // glLight*v / glMaterial*v / glFogfv: a vector of up to four floats after two enums
  for (const name of ['glLightfv', 'glMaterialfv', 'glLightModelfv']) fns[name] = [name === 'glLightModelfv' ? 'up' : 'uup', (x, ...a) => {
    const p = a.pop(); return x.backend.gl(name, [...a, x.floats(p, 4)]);
  }];
  fns.glFogfv = ['up', (x, pname, p) => x.backend.gl('glFogfv', [pname, x.floats(p, 4)])];
  // glShaderSource(shader, count, strings, lengths): the source, joined
  const source = (x, sh, count, strings, lengths) => {
    let s = '';
    for (let i = 0; i < count; i++) {
      const p = x.r32(strings + 4 * i), len = lengths ? x.r32(lengths + 4 * i) | 0 : -1;
      s += len >= 0 ? x.strN(p, len) : x.str(p);
    }
    return x.backend.gl('glShaderSource', [sh, s]);
  };
  fns.glShaderSource = ['uipp', source];
  fns.glShaderSourceARB = ['uipp', source];
  fns.glGetUniformLocation = ['up', (x, prog, name) => x.backend.gl('glGetUniformLocation', [prog, x.str(name)])];
  fns.glGetUniformLocationARB = ['up', (x, prog, name) => x.backend.gl('glGetUniformLocation', [prog, x.str(name)])];
  // The queries a careful intro makes: compiled, linked — always, here; an empty log.
  fns.glGetShaderiv = ['uup', (x, o, pname, p) => { x.w32(p, 1); return 0; }];
  fns.glGetProgramiv = ['uup', (x, o, pname, p) => { x.w32(p, 1); return 0; }];
  fns.glGetObjectParameterivARB = ['uup', (x, o, pname, p) => { x.w32(p, 1); return 0; }];
  fns.glGetShaderInfoLog = ['uipp', (x, o, max, len, log) => { if (len) x.w32(len, 0); if (log && max) x.w8(log, 0); return 0; }];
  fns.glGetProgramInfoLog = fns.glGetShaderInfoLog;
  fns.glGetInfoLogARB = fns.glGetShaderInfoLog;
  fns.glGetError = ['', () => 0];
  fns.glGenTextures = ['ip', (x, n, p) => { for (let i = 0; i < n; i++) x.w32(p + 4 * i, x.backend.gl('glGenTexture', [])); return 0; }];
  fns.glGenLists = ['i', (x, n) => x.backend.gl('glGenLists', [n])];
  // Framebuffer objects (GL 3.0, ARB_ and EXT_framebuffer_object, Hartverdrahtet's render to texture):
  // names made as glGenTextures makes them; a recorder says every framebuffer is complete.
  let fbNames = 0;
  for (const k of ['Framebuffers', 'Renderbuffers']) for (const ext of ['', 'EXT']) {
    fns[`glGen${k}${ext}`] = ['ip', (x, n, p) => { for (let i = 0; i < n; i++) x.w32(p + 4 * i, ++fbNames); return 0; }];
    fns[`glDelete${k}${ext}`] = ['ip', () => 0];
  }
  for (const ext of ['', 'EXT']) fns[`glCheckFramebufferStatus${ext}`] = ['u', () => 0x8cd5];   // GL_FRAMEBUFFER_COMPLETE
  // glTexImage2D/3D: the pixels read as the format and type say (RGBA/RGB/LUMINANCE, bytes or floats)
  const texBytes = (fmt, type, w, h, d) => {
    const comps = { 0x1908: 4, 0x1907: 3, 0x1909: 1, 0x190a: 2, 0x1903: 1, 0x1906: 1 }[fmt] || 4;
    const size = type === 0x1406 ? 4 : type === 0x1403 || type === 0x1402 ? 2 : 1;
    return w * h * (d || 1) * comps * size;
  };
  fns.glTexImage2D = ['uiiiiiuup', (x, target, level, ifmt, w, h, border, fmt, type, p) =>
    x.backend.gl('glTexImage2D', [target, level, ifmt, w, h, border, fmt, type, p ? x.bytes(p, texBytes(fmt, type, w, h)) : null])];
  fns.glTexImage3D = ['uiiiiiiuup', (x, target, level, ifmt, w, h, d, border, fmt, type, p) =>
    x.backend.gl('glTexImage3D', [target, level, ifmt, w, h, d, border, fmt, type, p ? x.bytes(p, texBytes(fmt, type, w, h, d)) : null])];
  // Extensions by name: a pointer to the entry point the program asks for, when we have it.
  const proc = (x, name) => x.entry(x.str(name));
  fns.glXGetProcAddressARB = ['p', proc];
  fns.glXGetProcAddress = ['p', proc];
  return { soname: 'libGL.so.1', links: ['libGL.so'], fns };
}

export function glu() {
  return { soname: 'libGLU.so.1', links: ['libGLU.so'], fns: {
    gluPerspective: ['dddd', (x, ...a) => x.backend.gl('gluPerspective', a)],
    gluLookAt: ['ddddddddd', (x, ...a) => x.backend.gl('gluLookAt', a)],
    gluOrtho2D: ['dddd', (x, ...a) => x.backend.gl('glOrtho', [...a, -1, 1])],
  } };
}
