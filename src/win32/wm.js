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
// The main window's menu bar (st.menu, src/win32/classic.js) is the window manager's too: drawn under
// the caption, a press on one of its items opens its popup over the window (the program told first, by
// WM_INITMENU and WM_INITMENUPOPUP, so that its check marks are right), and a click on a command posts
// WM_COMMAND with its id; anywhere else closes it.
//
// An OpenGL or Direct3D window's client area is drawn by WebGL, not here: the page puts that layer at
// clientRect() over this screen (src/linuxrun.js), as a driver draws into its window's rectangle.

const DESKTOP = 0x3a6ea5;
const MENU_H = 19;                                          // SM_CYMENU: the bar's height, its bottom line included                                   // the classic desktop's blue
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
    const s = st.style | 0, captioned = (s & 0xc00000) === 0xc00000, menu = captioned && st.menu ? MENU_H : 0;
    return { b: s & 0xc00000 ? 3 : s & 0x800000 ? 1 : 0, cap: (captioned ? 19 : 0) + menu, menu };
  };
  /** Shown framed on the desktop: a caption, visible, and no display mode of the program's own. */
  wm.captioned = () => (st.style & 0xc00000) === 0xc00000;
  // ...or a window with no caption the program put somewhere on the desktop, smaller than it: a splash (Jazz
  // Jackrabbit 2's Epic banner, 600x120 in the screen's middle) is on the desktop, not the whole screen.
  // A popup at the corner, or as big as the screen, is the screen (the intros, full-screen games).
  const splash = () => !!st.placed && ((st.x | 0) > 0 || (st.y | 0) > 0) && st.w < st.desk.w && st.h < st.desk.h;
  wm.framed = () => (wm.captioned() || splash()) && !st.modeSet && !!st.shown && !st.destroyed;
  wm.outer = () => { const { b, cap } = wm.frame(); return { x: st.x | 0, y: st.y | 0, w: st.w + 2 * b, h: st.h + 2 * b + cap }; };
  wm.client = () => { const { b, cap } = wm.frame(); return { x: (st.x | 0) + b, y: (st.y | 0) + b + cap, w: st.w, h: st.h }; };
  const caption = () => { const o = wm.outer(), { b } = wm.frame(); return { x: o.x + b, y: o.y + b, w: o.w - 2 * b, h: 18 }; };
  const closeBox = () => { const c = caption(); return { x: c.x + c.w - 2 - 16, y: c.y + 2, w: 16, h: 14 }; };
  const inside = (r, X, Y) => X >= r.x && X < r.x + r.w && Y >= r.y && Y < r.y + r.h;

  // ---- the menu bar and its popup -------------------------------------------------------------------
  const menuItems = (h) => { const m = h && st.gdi && st.gdi.get(h); return m && m.kind === 'menu' ? m.items : []; };
  const label = (t) => t.replace(/&(.)/g, '$1');            // "&Game" shows as Game (its mnemonic not underlined here)
  wm.menuBar = () => { const o = wm.outer(), { b } = wm.frame(); return { x: o.x + b, y: o.y + b + 19, w: o.w - 2 * b, h: MENU_H }; };
  /** The bar's items: where each is drawn, in screen coordinates. */
  wm.menuLayout = () => {
    if (!wm.frame().menu) return [];
    const bar = wm.menuBar(); let X = bar.x + 1;
    return menuItems(st.menu).map((it, i) => { const w = label(it.text.split('\t')[0]).length * 8 + 14, r = { i, it, x: X, y: bar.y + 1, w, h: MENU_H - 2 }; X += w; return r; });
  };
  wm.menuItemRect = (pos) => wm.menuLayout()[pos] || null;
  /** The open popup: under item `i` of the bar, its rows (separators 8 pixels, items 18). */
  wm.popup = null;
  const popupRows = () => {
    const p = wm.popup; if (!p) return null;
    const items = menuItems(p.menu);
    const cols = items.map((it) => { const [a, k = ''] = label(it.text).split('\t'); return { a, k }; });
    const w = Math.max(80, ...cols.map((c) => (c.a.length + (c.k ? c.k.length + 3 : 0)) * 8 + 40));
    let Y = p.y + 3;
    const rows = items.map((it, i) => { const h = it.flags & 0x800 ? 8 : 18, r = { i, it, ...cols[i], y: Y, h }; Y += h; return r; });
    return { x: p.x, y: p.y, w, h: Y - p.y + 3, rows };
  };
  /** Where a point is in the popup: its row's index, -1 inside it on no item, null outside. */
  wm.popupHit = (X, Y) => {
    const g = popupRows(); if (!g || !inside(g, X, Y)) return null;
    const r = g.rows.find((q) => Y >= q.y && Y < q.y + q.h && !(q.it.flags & 0x800));
    return r ? r.i : -1;
  };
  wm.openPopup = (i) => { const l = wm.menuLayout()[i]; if (!l || !(l.it.flags & 0x10)) return null; wm.popup = { bar: i, menu: l.it.sub, x: l.x, y: l.y + l.h + 1, hover: -1 }; wm.dirty = true; return wm.popup; };
  wm.closePopup = () => { if (wm.popup) { wm.popup = null; wm.dirty = true; } };

  /** Where a point of the screen is: 'close', 'caption', 'client', 'frame' or 'desktop'. */
  wm.hit = (X, Y) => {
    if (!wm.framed()) return 'client';
    if (!wm.captioned()) return inside(wm.client(), X, Y) ? 'client' : 'desktop';
    if (inside(closeBox(), X, Y)) return 'close';
    if (inside(caption(), X, Y)) return 'caption';
    if (wm.frame().menu && inside(wm.menuBar(), X, Y)) return 'menu';
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
    if (!wm.captioned()) { fill(fb, S, wm.client().x, wm.client().y, st.w, st.h, 0); return; }   // a splash: no caption
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
    if (wm.frame().menu) {
      const bar = wm.menuBar(), open = wm.popup ? wm.popup.bar : -1;
      for (const l of wm.menuLayout()) {
        if (l.i === open) { fill(fb, S, l.x, l.y, l.w, 1, SHADOW); fill(fb, S, l.x, l.y, 1, l.h, SHADOW); fill(fb, S, l.x, l.y + l.h - 1, l.w, 1, LIGHT); fill(fb, S, l.x + l.w - 1, l.y, 1, l.h, LIGHT); }
        text(fb, S, font, label(l.it.text.split('\t')[0]), l.x + 7, l.y + 1, l.w, l.it.flags & 3 ? SHADOW : 0);
      }
      fill(fb, S, bar.x, bar.y + bar.h - 1, bar.w, 1, FACE);
    }
    fill(fb, S, wm.client().x, wm.client().y, st.w, st.h, 0);
  };
  /** The program's other top-level windows (src/win32/api.js popupLayers: a dialog), over its main one:
   *  each its frame -- raised, its caption in the active gradient with its title -- and its pixels. */
  // (dx, dy): where the screen's origin is in `fb` -- the main client area's corner negated when the screen is
  // the window alone (a program that set a display mode: Half-Life's launcher and its difficulty dialog).
  const drawLayers = (fb, S, font, dx = 0, dy = 0) => {
    for (const l0 of st.popupLayers ? st.popupLayers() : []) {
      const l = dx || dy ? { ...l0, x: l0.x + dx, y: l0.y + dy } : l0;
      const W = l.w + 2 * l.b, H = l.h + 2 * l.b + l.cap;
      fill(fb, S, l.x, l.y, W, H, FACE);
      if (l.b >= 3) raised(fb, S, l.x, l.y, W, H, FACE, LIGHT);
      if (l.cap) {
        const cw = W - 2 * l.b;
        for (let i = 0; i < cw; i++) fill(fb, S, l.x + l.b + i, l.y + l.b, 1, 18, lerp(CAPTION_L, CAPTION_R, cw > 1 ? i / (cw - 1) : 0) | 0);
        text(fb, S, font, l.title, l.x + l.b + 4, l.y + l.b + 1, cw - 8, 0xffffff);
      }
      const cx = l.x + l.b, cy = l.y + l.b + l.cap;
      for (let j = 0; j < l.h; j++) {
        const Y = cy + j; if (Y < 0 || Y >= S.h) continue;
        const x0 = Math.max(0, -cx), x1 = Math.min(l.w, S.w - cx);
        if (x1 > x0) fb.set(l.px.subarray(j * l.w + x0, j * l.w + x1), Y * S.w + cx + x0);
      }
    }
  };
  /** The open popup, over everything but the cursor. */
  const drawPopup = (fb, S, font) => {
    const g = popupRows(); if (!g) return;
    fill(fb, S, g.x, g.y, g.w, g.h, FACE); raised(fb, S, g.x, g.y, g.w, g.h, FACE, LIGHT);
    for (const r of g.rows) {
      if (r.it.flags & 0x800) { fill(fb, S, g.x + 3, r.y + 3, g.w - 6, 1, SHADOW); fill(fb, S, g.x + 3, r.y + 4, g.w - 6, 1, LIGHT); continue; }
      const hot = r.i === wm.popup.hover && !(r.it.flags & 3), c = r.it.flags & 3 ? SHADOW : hot ? 0xffffff : 0;
      if (hot) fill(fb, S, g.x + 3, r.y, g.w - 6, r.h, CAPTION_L);
      if (r.it.flags & 8) [3, 4, 5, 4, 3, 2, 1].forEach((d, k) => fill(fb, S, g.x + 6 + k, r.y + 4 + d, 1, 3, c));   // the check mark
      text(fb, S, font, r.a, g.x + 20, r.y + 1, g.w - 24, c);
      if (r.k) text(fb, S, font, r.k, g.x + g.w - 8 - r.k.length * 8, r.y + 1, r.k.length * 8, c);
    }
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
      // The screen the window's size, its width rounded up to the card's 8 pixels (black beyond); its
      // dialogs over it where they are on the screen, the window's client area at the screen's corner.
      const layers = st.popupLayers ? st.popupLayers() : [];
      if (!client && layers.length) client = st.screen || null;
      if (client && client.w >= 1 && client.h >= 1) {
        const W = Math.max(320, (client.w + 7) & ~7), H = Math.max(200, client.h), fb = lx.fbView(W, H);
        if (W === client.w && H === client.h) fb.set(client.px.subarray(0, client.w * client.h));
        else for (let j = 0; j < client.h; j++) fb.set(client.px.subarray(j * client.w, (j + 1) * client.w), j * W);
        if (layers.length) { const r = wm.client(); drawLayers(fb, { w: W, h: H }, lx.romFont && lx.romFont(), -r.x, -r.y); }
        wm.view = { fb, w: W, h: H }; cover();
      }
      wm.dirty = true;
      return;
    }
    const S = st.desk, fb = lx.fbView(S.w, S.h);
    wm.view = { fb, w: S.w, h: S.h };
    if (wm.dirty) { wm.draw(fb, S, lx.romFont && lx.romFont()); wm.dirty = false; client = client || st.screen || null; }
    // No pixels of its own yet (Spider asks its difficulty before it draws): its dialogs and menu still go on top.
    if (!client) { drawLayers(fb, S, lx.romFont && lx.romFont()); drawPopup(fb, S, lx.romFont && lx.romFont()); cover(); return; }
    const r = wm.client();
    for (let j = 0; j < client.h; j++) {
      const Y = r.y + j; if (Y < 0 || Y >= S.h) continue;
      const x0 = Math.max(0, -r.x), x1 = Math.min(client.w, S.w - r.x);
      if (x1 > x0) fb.set(client.px.subarray(j * client.w + x0, j * client.w + x1), Y * S.w + r.x + x0);
    }
    drawLayers(fb, S, lx.romFont && lx.romFont());
    drawPopup(fb, S, lx.romFont && lx.romFont());
    cover();
  };
  /**
   * A dialog application's screen: the desktop, its windows drawn on it where they are (src/win32/api.js
   * deskMode), `desk` the whole of it.
   */
  wm.presentDesk = (lx, desk) => {
    wm.lx = lx; wm.presented = (wm.presented | 0) + 1;
    if (!lx || !lx.fbView) return;
    uncover();
    const fb = lx.fbView(desk.w, desk.h); fb.set(desk.px);
    wm.view = { fb, w: desk.w, h: desk.h }; cover();
  };
  /** Redraw now, from the host (a drag): the frame, and the client area as last drawn. */
  wm.redraw = () => { wm.dirty = true; if (wm.lx) wm.present(wm.lx, null); };
  return wm;
}
