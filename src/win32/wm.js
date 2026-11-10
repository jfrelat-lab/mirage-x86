// wm.js — MIRAGE-WIN32's window manager: the screen a Windows program's window sits on, drawn on the
// card's framebuffer as Windows draws its own, so the page, the headless tools and every recording
// show the same thing.
//
// A window with a caption (WS_CAPTION) on the desktop is shown framed: XP's "Windows Classic" desktop
// at 1024x768, the window where the program put it (or the visitor dragged it), its 3-pixel border,
// its 18-pixel caption in the active gradient with its title, a close button, and its client area --
// what the program draws. A window with no caption (a popup) or a program that set a display mode is
// shown alone, the screen its size, as before: the intros and full-screen games.
//
// The frame is the window manager's, as on Windows: a press on the caption drags the window (the
// program learns it moved from WM_MOVE and GetWindowRect), the close button posts WM_CLOSE. What is
// in the client area is the program's, and its mouse messages carry client coordinates.
//
// An OpenGL or Direct3D window's client area is drawn by WebGL, not here: the page puts that layer at
// clientRect() over this screen (src/linuxrun.js), as a driver draws into its window's rectangle.

const DESKTOP = 0x3a6ea5;                                   // the classic desktop's blue
const FACE = 0xd4d0c8, LIGHT = 0xffffff, SHADOW = 0x808080, DARK = 0x404040;   // 3D objects
const CAPTION_L = 0x0a246a, CAPTION_R = 0xa6caf0;           // the active caption's gradient
// The standard arrow (IDC_ARROW), 12x19: 1 its black outline, 2 its white body.
const ARROW = ['1', '11', '121', '1221', '12221', '122221', '1222221', '12222221', '122222221', '1222222221',
  '12222211111', '1221221', '121 1221', '11  1221', '1    1221', '     1221', '      1221', '      1221', '       11'];

export function windowManager(st) {
  const wm = { dirty: true, drag: null, closeArmed: false, lx: null, view: null, under: null };
  st.desk = { w: 1024, h: 768 };

  /** The frame round the client area: border width and caption height, as AdjustWindowRectEx adds. */
  wm.frame = () => {
    const s = st.style | 0;
    return { b: s & 0xc00000 ? 3 : s & 0x800000 ? 1 : 0, cap: (s & 0xc00000) === 0xc00000 ? 19 : 0 };
  };
  /** Shown framed on the desktop: a caption, visible, and no display mode of the program's own. */
  wm.framed = () => (st.style & 0xc00000) === 0xc00000 && !st.modeSet && !!st.shown && !st.destroyed;
  wm.outer = () => { const { b, cap } = wm.frame(); return { x: st.x | 0, y: st.y | 0, w: st.w + 2 * b, h: st.h + 2 * b + cap }; };
  wm.client = () => { const { b, cap } = wm.frame(); return { x: (st.x | 0) + b, y: (st.y | 0) + b + cap, w: st.w, h: st.h }; };
  const caption = () => { const o = wm.outer(), { b } = wm.frame(); return { x: o.x + b, y: o.y + b, w: o.w - 2 * b, h: 18 }; };
  const closeBox = () => { const c = caption(); return { x: c.x + c.w - 2 - 16, y: c.y + 2, w: 16, h: 14 }; };
  const inside = (r, X, Y) => X >= r.x && X < r.x + r.w && Y >= r.y && Y < r.y + r.h;

  /** Where a point of the screen is: 'close', 'caption', 'client', 'frame' or 'desktop'. */
  wm.hit = (X, Y) => {
    if (!wm.framed()) return 'client';
    if (inside(closeBox(), X, Y)) return 'close';
    if (inside(caption(), X, Y)) return 'caption';
    if (inside(wm.client(), X, Y)) return 'client';
    return inside(wm.outer(), X, Y) ? 'frame' : 'desktop';
  };

  // ---- drawing ------------------------------------------------------------------------------------
  const fill = (fb, S, x, y, w, h, c) => {
    const x0 = Math.max(0, x), x1 = Math.min(S.w, x + w), y0 = Math.max(0, y), y1 = Math.min(S.h, y + h);
    // Nothing when the rectangle is off the screen: a negative end would count from the array's end
    // (a window at x = -3, Quake II's 640x480 placed so its client area is the screen's corner, had
    // its frame's left edge fill the whole screen white).
    if (x1 <= x0) return;
    for (let j = y0; j < y1; j++) fb.fill(c, j * S.w + x0, j * S.w + x1);
  };
  // A raised edge, as DrawEdge(EDGE_RAISED) draws it: light then face on the top and left, dark then
  // shadow on the bottom and right.
  const raised = (fb, S, x, y, w, h, outerTL, innerTL) => {
    fill(fb, S, x, y, w, 1, outerTL); fill(fb, S, x, y, 1, h, outerTL);
    fill(fb, S, x, y + h - 1, w, 1, DARK); fill(fb, S, x + w - 1, y, 1, h, DARK);
    fill(fb, S, x + 1, y + 1, w - 2, 1, innerTL); fill(fb, S, x + 1, y + 1, 1, h - 2, innerTL);
    fill(fb, S, x + 1, y + h - 2, w - 2, 1, SHADOW); fill(fb, S, x + w - 2, y + 1, 1, h - 2, SHADOW);
  };
  const text = (fb, S, font, str, x, y, maxW, c) => {
    if (!font) return;
    for (let i = 0; i < str.length && (i + 1) * 8 <= maxW; i++) {
      const g = str.charCodeAt(i) & 0xff;
      for (let r = 0; r < 16; r++) {
        const bits = font[g * 16 + r], Y = y + r;
        if (Y < 0 || Y >= S.h) continue;
        for (let k = 0; k < 8; k++) if (bits & (0x80 >> k)) { const X = x + i * 8 + k; if (X >= 0 && X < S.w) fb[Y * S.w + X] = c; }
      }
    }
  };
  const lerp = (a, b, t) => (((a >> 16 & 255) + ((b >> 16 & 255) - (a >> 16 & 255)) * t) << 16) | (((a >> 8 & 255) + ((b >> 8 & 255) - (a >> 8 & 255)) * t) << 8) | ((a & 255) + ((b & 255) - (a & 255)) * t);
  wm.draw = (fb, S, font) => {
    fb.fill(DESKTOP);
    const o = wm.outer(), { b } = wm.frame();
    fill(fb, S, o.x, o.y, o.w, o.h, FACE);
    if (b >= 3) raised(fb, S, o.x, o.y, o.w, o.h, FACE, LIGHT);
    const c = caption();
    for (let i = 0; i < c.w; i++) fill(fb, S, c.x + i, c.y, 1, c.h, lerp(CAPTION_L, CAPTION_R, c.w > 1 ? i / (c.w - 1) : 0) | 0);
    text(fb, S, font, st.title || '', c.x + 4, c.y + 1, c.w - 26, 0xffffff);
    const k = closeBox();
    fill(fb, S, k.x, k.y, k.w, k.h, FACE); raised(fb, S, k.x, k.y, k.w, k.h, LIGHT, FACE);
    const d = wm.closeArmed ? 1 : 0;                         // pressed: the cross one pixel down and right
    for (let i = 0; i < 7; i++) {                            // the cross, two pixels thick
      fill(fb, S, k.x + 4 + i + d, k.y + 3 + i + d, 2, 1, 0);
      fill(fb, S, k.x + 9 - i + d, k.y + 3 + i + d, 2, 1, 0);
    }
    fill(fb, S, wm.client().x, wm.client().y, st.w, st.h, 0);
  };

  // ---- the cursor: drawn over everything, what it covers kept and put back before the screen changes
  // under it. Shown while the visitor's pointer is over the screen and the program has not hidden it.
  const cursorShown = () => st.pointerIn && (st.cursorCount | 0) >= 0 && st.mouseX !== undefined;
  const uncover = () => {
    const u = wm.under, v = wm.view; wm.under = null;
    if (!u || !v || u.at !== v.fb.byteOffset || u.w !== v.w) return;   // the same screen (fbView makes a new view each time)
    for (const [i, c] of u.px) v.fb[i] = c;
  };
  const cover = () => {
    const v = wm.view; if (!v || !cursorShown()) return;
    const px = [], X = st.mouseX | 0, Y = st.mouseY | 0;
    ARROW.forEach((row, j) => [...row].forEach((ch, i) => {
      const x = X + i, y = Y + j; if (ch === ' ' || x < 0 || y < 0 || x >= v.w || y >= v.h) return;
      const k = y * v.w + x; px.push([k, v.fb[k]]); v.fb[k] = ch === '1' ? 0 : 0xffffff;
    }));
    wm.under = { at: v.fb.byteOffset, w: v.w, px };
  };
  /** The pointer moved or the program showed or hid the cursor: draw it again, now. */
  wm.moveCursor = () => { uncover(); cover(); };

  /**
   * The screen, after the program drew into its window (`client`: the client area's pixels, or null
   * when WebGL draws it): the window alone at its own size when it is not framed, else the desktop
   * and the frame (redrawn when they changed) and the client area at its place.
   */
  wm.present = (lx, client) => {
    wm.lx = lx;
    if (client) wm.presented = (wm.presented | 0) + 1;              // a frame the program drew (the page's fps)
    if (!lx || !lx.fbView) return;
    uncover();
    if (!wm.framed()) {
      // The screen the window's size, its width rounded up to the card's 8 pixels (black beyond).
      if (client && client.w >= 1 && client.h >= 1) {
        const W = Math.max(320, (client.w + 7) & ~7), H = Math.max(200, client.h), fb = lx.fbView(W, H);
        if (W === client.w && H === client.h) fb.set(client.px.subarray(0, client.w * client.h));
        else for (let j = 0; j < client.h; j++) fb.set(client.px.subarray(j * client.w, (j + 1) * client.w), j * W);
        wm.view = { fb, w: W, h: H }; cover();
      }
      wm.dirty = true;
      return;
    }
    const S = st.desk, fb = lx.fbView(S.w, S.h);
    wm.view = { fb, w: S.w, h: S.h };
    if (wm.dirty) { wm.draw(fb, S, lx.romFont && lx.romFont()); wm.dirty = false; client = client || st.screen || null; }
    if (!client) { cover(); return; }
    const r = wm.client();
    for (let j = 0; j < client.h; j++) {
      const Y = r.y + j; if (Y < 0 || Y >= S.h) continue;
      const x0 = Math.max(0, -r.x), x1 = Math.min(client.w, S.w - r.x);
      if (x1 > x0) fb.set(client.px.subarray(j * client.w + x0, j * client.w + x1), Y * S.w + r.x + x0);
    }
    cover();
  };
  /** Redraw now, from the host (a drag): the frame, and the client area as last drawn. */
  wm.redraw = () => { wm.dirty = true; if (wm.lx) wm.present(wm.lx, null); };
  return wm;
}
