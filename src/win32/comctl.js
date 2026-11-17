// comctl.js — comctl32's common controls for MIRAGE-WIN32, drawn as Windows 2000 draws them (measured
// against it: tools/win32/samples, its `common`, `listview` and `toolbar` samples):
//
//   msctls_progress32   a progress bar: blocks two thirds of its height wide, or smooth (PBS_SMOOTH)
//   msctls_trackbar32   a trackbar: its channel, its pointed thumb, its ticks; dragged, clicked, keyed
//                       (WM_HSCROLL / WM_VSCROLL to the parent, as Windows sends them)
//   msctls_updown32     an up-down control on its buddy (UDS_AUTOBUDDY, UDS_ALIGNRIGHT, UDS_SETBUDDYINT)
//   SysTabControl32     tabs over a raised panel; a click selects (TCN_SELCHANGING, TCN_SELCHANGE)
//   SysListView32       report view: a header of columns, rows of sub-items, the selection
//   ToolbarWindow32     raised buttons of comctl32's standard images (drawn here) or the program's
//   msctls_statusbar32  a status bar of parts at the bottom of its parent, a size grip
//
// Each is a window of the program (src/win32/api.js keeps the record); its messages come here from
// DefWindowProc. `message` answers what it knows and returns undefined for the rest.

const FACE = 0xd4d0c8, LIGHT = 0xffffff, SHADOW = 0x808080, DARK = 0x404040, HIGHLIGHT = 0x0a246a;
export const COMMON_CONTROLS = new Set(['msctls_progress32', 'msctls_trackbar32', 'msctls_updown32', 'systabcontrol32', 'syslistview32', 'toolbarwindow32', 'msctls_statusbar32']);

export function commonControls(h) {
  const { st, target, fillRect, textMetrics, textOut, dcFor, dcState, invalidate, send, win, wideRead } = h;

  // ---- drawing helpers ---------------------------------------------------------------------------
  const line = (t, x0, y0, x1, y1, c) => fillRect(t, x0, y0, x1, y1, c);
  const raised = (t, x0, y0, x1, y1) => {                              // a button's two edges
    line(t, x0, y0, x1, y0 + 1, LIGHT); line(t, x0, y0, x0 + 1, y1, LIGHT);
    line(t, x0, y1 - 1, x1, y1, DARK); line(t, x1 - 1, y0, x1, y1, DARK);
    line(t, x0 + 1, y1 - 2, x1 - 1, y1 - 1, SHADOW); line(t, x1 - 2, y0 + 1, x1 - 1, y1 - 1, SHADOW);
  };
  const sunken = (t, x0, y0, x1, y1) => {
    line(t, x0, y0, x1, y0 + 1, SHADOW); line(t, x0, y0, x0 + 1, y1, SHADOW);
    line(t, x0 + 1, y0 + 1, x1 - 1, y0 + 2, DARK); line(t, x0 + 1, y0 + 1, x0 + 2, y1 - 1, DARK);
    line(t, x0, y1 - 1, x1, y1, LIGHT); line(t, x1 - 1, y0, x1, y1, LIGHT);
    line(t, x0 + 1, y1 - 2, x1 - 1, y1 - 1, FACE); line(t, x1 - 2, y0 + 1, x1 - 1, y1 - 1, FACE);
  };
  const thinSunken = (t, x0, y0, x1, y1) => { line(t, x0, y0, x1, y0 + 1, SHADOW); line(t, x0, y0, x0 + 1, y1, SHADOW); line(t, x0, y1 - 1, x1, y1, LIGHT); line(t, x1 - 1, y0, x1, y1, LIGHT); };
  const dotted = (t, x0, y0, x1, y1) => {
    for (let X = x0; X < x1; X += 2) { if (X >= 0 && X < t.w) { if (y0 >= 0 && y0 < t.h) t.px[y0 * t.w + X] = 0; if (y1 - 1 >= 0 && y1 - 1 < t.h) t.px[(y1 - 1) * t.w + X] = 0; } }
    for (let Y = y0; Y < y1; Y += 2) { if (Y >= 0 && Y < t.h) { if (x0 >= 0 && x0 < t.w) t.px[Y * t.w + x0] = 0; if (x1 - 1 >= 0 && x1 - 1 < t.w) t.px[Y * t.w + x1 - 1] = 0; } }
  };
  /** Text in the control's font (WM_SETFONT's, else the DC's), its cell's top at Y. */
  // ...WM_SETFONT's, else DEFAULT_GUI_FONT (the message font), as comctl32 draws when given none: the
  // status bar's text was in the DC's bold System font.
  const metrics = (hdc, w) => { st.dcFonts.set(hdc, w.font || 0x01900021); return textMetrics(hdc); };
  const widthOf = (m, s) => { let n = 0; for (const c of s) n += m.font ? m.font.glyph(c.charCodeAt(0) & 255, m.ppem).cellIncX : m.avg; return n; };
  const write = (x, t, hdc, m, s, X, Y, ink, maxW = Infinity) => {
    if (!s) return;
    let str = s; while (str.length > 1 && widthOf(m, str) > maxW) str = str.slice(0, -1);
    const buf = x.win.heapAlloc(str.length + 1); x.write(buf, Uint8Array.from(str, (c) => c.charCodeAt(0) & 255));
    const d = dcState(hdc), keep = [d.bkMode, d.textColor]; d.bkMode = 1; d.textColor = ink;
    textOut(x, t, d, m, X, Y, 0, 0, buf, str.length); [d.bkMode, d.textColor] = keep; x.win.heapFree(buf);
  };
  const strAt = (x, p, wide) => (!p || p === 0xffffffff ? '' : wide ? String.fromCharCode(...wideRead(x, p, -1, true)) : x.str(p, 1024));
  const putStr = (x, buf, n, s, wide) => {
    if (!buf || n <= 0) return; const t = s.slice(0, n - 1);
    if (wide) { const b = new Uint8Array(2 * t.length + 2); for (let i = 0; i < t.length; i++) { b[2 * i] = t.charCodeAt(i) & 255; b[2 * i + 1] = t.charCodeAt(i) >> 8; } x.write(buf, b); }
    else x.write(buf, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 255));
  };
  const paintWith = (x, hwnd, w, draw) => {
    st.invalid.delete(hwnd); w.erase = false;
    const hdc = dcFor(hwnd), t = target(x, hdc); if (!t) return 0;
    draw(t, hdc); t.done(); return 0;
  };
  const notifyHdr = (x, w, code, size = 12) => { const nm = x.win.heapAlloc(size); x.write(nm, new Uint8Array(size)); x.w32(nm, w.hwnd); x.w32(nm + 4, w.id | 0); x.w32(nm + 8, code >>> 0); return nm; };
  const go = (x, msgs, r = 0) => (msgs.length ? send(x, msgs, () => r, 16) : r);
  const parentSize = (w) => { const p = win(w.parent); return p && !p.main ? { w: p.w, h: p.h } : { w: st.w, h: st.h }; };

  // ---- the progress bar --------------------------------------------------------------------------
  const pb = (w) => (w.pb ||= { min: 0, max: 100, pos: 0, step: 10 });
  const progress = (x, hwnd, w, msg, wp, lp) => {
    const P = pb(w), clamp = (v) => Math.max(P.min, Math.min(P.max, v)), packed = () => ((P.max & 0xffff) << 16 | (P.min & 0xffff)) >>> 0;
    switch (msg) {
      case 0x401: { const old = packed(); P.min = lp & 0xffff; P.max = lp >>> 16; P.pos = clamp(P.pos); invalidate(hwnd, true); return old; }   // PBM_SETRANGE
      case 0x402: { const old = P.pos; P.pos = clamp(wp | 0); invalidate(hwnd, true); return old; }        // PBM_SETPOS
      case 0x403: { const old = P.pos; P.pos = clamp(P.pos + (wp | 0)); invalidate(hwnd, true); return old; }   // PBM_DELTAPOS
      case 0x404: { const old = P.step; P.step = wp | 0; return old; }                                      // PBM_SETSTEP
      case 0x405: { const old = P.pos; P.pos += P.step; if (P.pos > P.max) P.pos = P.min + (P.pos - P.max); P.pos = clamp(P.pos); invalidate(hwnd, true); return old; }   // PBM_STEPIT: round again
      case 0x406: { const old = packed(); P.min = wp | 0; P.max = lp | 0; P.pos = clamp(P.pos); invalidate(hwnd, true); return old; }   // PBM_SETRANGE32
      case 0x407: if (lp) { x.w32(lp, P.min); x.w32(lp + 4, P.max); } return wp ? P.min : P.max;          // PBM_GETRANGE
      case 0x408: return P.pos;                                                                            // PBM_GETPOS
      case 0x409: { const old = P.bar ?? 0xff000000; P.bar = lp === 0xff000000 ? undefined : lp; invalidate(hwnd, true); return old; }   // PBM_SETBARCOLOR
      case 0x2001: { const old = P.bk ?? 0xff000000; P.bk = lp === 0xff000000 ? undefined : lp; invalidate(hwnd, true); return old; }  // PBM_SETBKCOLOR
      case 0x0f: return paintWith(x, hwnd, w, (t) => {
        // A thin sunken edge (WS_BORDER) and a pixel of face inside it, then the bar: blocks two thirds of
        // the inside's height wide, two pixels apart, as many as reach the position (PBS_SMOOTH 1: one fill).
        const b = w.style & 0x800000 || (w.ex | 0) & 0x200 ? 1 : 0, bar = P.bar !== undefined ? rgb(P.bar) : HIGHLIGHT;
        fillRect(t, 0, 0, t.w, t.h, P.bk !== undefined ? rgb(P.bk) : FACE);
        if (b) thinSunken(t, 0, 0, t.w, t.h);
        const x0 = b + 1, y0 = b + 1, x1 = t.w - b - 1, y1 = t.h - b - 1, span = Math.max(1, P.max - P.min);
        const fill = Math.round((x1 - x0) * (P.pos - P.min) / span);
        if (w.style & 1) { fillRect(t, x0, y0, x0 + fill, y1, bar); return; }
        const step = Math.max(3, Math.floor((t.h - 2 * b) * 2 / 3)), blk = step - 2;
        for (let X = x0; X < x0 + fill; X += step) fillRect(t, X, y0, Math.min(x1, X + blk), y1, bar);
      });
      default: return undefined;
    }
  };
  const rgb = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >>> 16) & 0xff);   // COLORREF -> 00RRGGBB

  // ---- the trackbar ------------------------------------------------------------------------------
  // Horizontal (TBS_VERT 2 turns it): the channel from x+8 to the end less 8, four pixels deep at y+9;
  // the thumb 11 wide, from y+2 to y+22 with its point down; a tick under each position (TBS_AUTOTICKS 1,
  // TBS_NOTICKS 10h none); the focus rectangle round it all. Measured on Windows 2000.
  const tb = (w) => (w.tb ||= { min: 0, max: 100, pos: 0, page: 0, line: 1, freq: 1, tics: [] });
  const thumbAt = (w, T) => { const vert = w.style & 2, len = vert ? w.h : w.w, span = Math.max(1, T.max - T.min); return 13 + Math.floor((T.pos - T.min) * (len - 26) / span); };   // truncated, as Windows 2000 places it
  const trackScroll = (x, w, code) => [[w.style & 2 ? 0x115 : 0x114, ((tb(w).pos & 0xffff) << 16 | code) >>> 0, w.hwnd, w.parent]];   // WM_VSCROLL / WM_HSCROLL
  const trackbar = (x, hwnd, w, msg, wp, lp) => {
    const T = tb(w), clamp = (v) => Math.max(T.min, Math.min(T.max, v)), set = (v) => { T.pos = clamp(v); invalidate(hwnd, true); };
    if (!T.page) T.page = Math.max(1, Math.floor((T.max - T.min) / 5));
    switch (msg) {
      case 0x400: return T.pos;                                                  // TBM_GETPOS
      case 0x401: return T.min; case 0x402: return T.max;                       // TBM_GETRANGEMIN, MAX
      case 0x405: set(lp | 0); return 0;                                         // TBM_SETPOS
      case 0x406: T.min = lp << 16 >> 16; T.max = lp >> 16; T.page = 0; set(T.pos); return 0;   // TBM_SETRANGE
      case 0x407: T.min = lp | 0; set(T.pos); return 0; case 0x408: T.max = lp | 0; set(T.pos); return 0;   // TBM_SETRANGEMIN, MAX
      case 0x404: T.tics.push(lp | 0); invalidate(hwnd, true); return 1;        // TBM_SETTIC
      case 0x409: T.tics = []; invalidate(hwnd, true); return 0;                 // TBM_CLEARTICS
      case 0x410: return (w.style & 0x10) ? 0 : 2 + T.tics.length;               // TBM_GETNUMTICS
      case 0x414: T.freq = Math.max(1, wp | 0); invalidate(hwnd, true); return 0;   // TBM_SETTICFREQ
      case 0x415: { const old = T.page; T.page = lp | 0; return old; } case 0x416: return T.page;   // TBM_SETPAGESIZE, GET
      case 0x417: { const old = T.line; T.line = lp | 0; return old; } case 0x418: return T.line;   // TBM_SETLINESIZE, GET
      case 0x419: { const c = thumbAt(w, T); [c - 5, 2, c + 6, 23].forEach((v, i) => x.w32(lp + 4 * i, v)); return 0; }   // TBM_GETTHUMBRECT
      case 0x41a: { [8, 9, w.w - 8, 13].forEach((v, i) => x.w32(lp + 4 * i, v)); return 0; }   // TBM_GETCHANNELRECT
      case 0x87: return 0x01;                                                     // WM_GETDLGCODE: the arrows
      case 0x07: case 0x08: invalidate(hwnd, true); return 0;                    // the focus rectangle
      case 0x201: {                                                               // a press: on the thumb drags, else a page toward it
        st.focus = hwnd; const X = w.style & 2 ? lp >> 16 : (lp << 16) >> 16, c = thumbAt(w, T);
        if (Math.abs(X - c) <= 6) { T.drag = { dx: X - c }; st.capture = hwnd; return 0; }
        set(T.pos + (X < c ? -T.page : T.page)); return go(x, [...trackScroll(x, w, X < c ? 2 : 3), ...trackScroll(x, w, 8)]);   // TB_PAGEUP, TB_PAGEDOWN, TB_ENDTRACK
      }
      case 0x200: {                                                               // dragged: TB_THUMBTRACK
        if (!T.drag) return 0; const X = (w.style & 2 ? lp >> 16 : (lp << 16) >> 16) - T.drag.dx, len = w.style & 2 ? w.h : w.w;
        const v = clamp(T.min + Math.round((X - 13) * (T.max - T.min) / Math.max(1, len - 26))); if (v === T.pos) return 0;
        set(v); return go(x, trackScroll(x, w, 5));
      }
      case 0x202: if (!T.drag) return 0; T.drag = null; if (st.capture === hwnd) st.capture = 0; return go(x, [...trackScroll(x, w, 4), ...trackScroll(x, w, 8)]);   // TB_THUMBPOSITION, TB_ENDTRACK
      case 0x100: {                                                               // the keys: TB_LINEUP/DOWN 0/1, PAGEUP/DOWN 2/3, TOP 6, BOTTOM 7
        const k = { 0x25: [-T.line, 0], 0x26: [-T.line, 0], 0x27: [T.line, 1], 0x28: [T.line, 1], 0x21: [-T.page, 2], 0x22: [T.page, 3], 0x24: [-Infinity, 6], 0x23: [Infinity, 7] }[wp];
        if (!k) return 0; set(k[0] === -Infinity ? T.min : k[0] === Infinity ? T.max : T.pos + k[0]); return go(x, [...trackScroll(x, w, k[1]), ...trackScroll(x, w, 8)]);
      }
      case 0x0f: return paintWith(x, hwnd, w, (t) => {
        fillRect(t, 0, 0, t.w, t.h, FACE);
        const vert = w.style & 2, len = vert ? t.h : t.w, c = thumbAt(w, T), span = Math.max(1, T.max - T.min);
        const at = (u, v) => (vert ? [v, u] : [u, v]), box = (u0, v0, u1, v1, col) => { const [a, b] = at(u0, v0), [cc, d] = at(u1, v1); fillRect(t, Math.min(a, cc), Math.min(b, d), Math.max(a, cc), Math.max(b, d), col); };
        // the channel: shadow and dark on top, face, light at the bottom; dark at its left, light at its right
        box(8, 9, len - 8, 10, SHADOW); box(8, 10, len - 8, 11, DARK); box(8, 11, len - 8, 12, FACE); box(8, 12, len - 8, 13, LIGHT);
        box(8, 9, 9, 13, SHADOW); box(len - 9, 9, len - 8, 13, LIGHT);
        // the ticks: each freq'th position and those set, under the thumb's point
        if (!(w.style & 0x10)) {
          const tics = new Set(T.tics); if (w.style & 1) for (let v = T.min; v <= T.max; v += T.freq) tics.add(v); tics.add(T.min); tics.add(T.max);
          for (const v of tics) { const u = 13 + Math.floor((v - T.min) * (len - 26) / span); box(u, 24, u + 1, v === T.min || v === T.max ? 28 : 26, 0); }
        }
        if (!(w.style & 0x80)) {                                                  // TBS_NOTHUMB
          const u0 = c - 5;
          box(u0, 2, u0 + 11, 18, FACE); box(u0, 2, u0 + 10, 3, LIGHT); box(u0, 2, u0 + 1, 18, LIGHT); box(u0 + 9, 3, u0 + 10, 18, SHADOW); box(u0 + 10, 2, u0 + 11, 18, DARK);
          for (let k = 0; k < 5; k++) { box(u0 + 1 + k, 18 + k, u0 + 10 - k, 19 + k, FACE); box(u0 + k + 1, 18 + k, u0 + k + 2, 19 + k, LIGHT); box(u0 + 9 - k, 18 + k, u0 + 10 - k, 19 + k, SHADOW); box(u0 + 10 - k, 18 + k, u0 + 11 - k, 19 + k, DARK); }
          box(c, 23, c + 1, 24, DARK);
        }
        if (st.focus === hwnd) dotted(t, 0, 0, t.w, t.h);
      });
      default: return undefined;
    }
  };

  // ---- the up-down control -----------------------------------------------------------------------
  // On its buddy (the window made before it, UDS_AUTOBUDDY 10h, or UDM_SETBUDDY): UDS_ALIGNRIGHT (4) /
  // UDS_ALIGNLEFT (8) put it over the buddy's edge, the buddy narrowed; UDS_SETBUDDYINT (2) writes the
  // position there. Its two buttons; a click moves by one (UDN_DELTAPOS asked first) and tells the
  // parent (WM_VSCROLL SB_THUMBPOSITION).
  const ud = (w) => (w.ud ||= { min: 100, max: 0, pos: 0 });
  const attach = (w) => {
    const U = ud(w); if (U.placed) return; U.placed = true;
    if (!U.buddy && (w.style & 0x10)) { let best = null; for (const c of st.wins.values()) if (c.parent === w.parent && c !== w && c.hwnd < w.hwnd && (!best || c.hwnd > best.hwnd)) best = c; U.buddy = best ? best.hwnd : 0; }
    const b = win(U.buddy); if (!b) return;
    // Inside the buddy's sunken edge at its right (or left), the buddy as wide as it was, as Windows 2000 shows it.
    if (w.style & 0xc) { w.x = w.style & 4 ? b.x + b.w - w.w - 2 : b.x + 2; w.y = b.y + 2; w.h = b.h - 4; w.w = Math.min(w.w, 16); invalidate(b.hwnd, true); }
  };
  const udText = (x, w) => { const U = ud(w), b = win(U.buddy); if (b && (w.style & 2)) { b.title = String(U.pos); invalidate(b.hwnd, true); } };
  const updown = (x, hwnd, w, msg, wp, lp) => {
    const U = ud(w), lo = Math.min(U.min, U.max), hi = Math.max(U.min, U.max), clamp = (v) => Math.max(lo, Math.min(hi, v));
    if (msg !== 0x0f || !U.placed) attach(w);
    switch (msg) {
      case 0x465: U.max = lp << 16 >> 16; U.min = lp >> 16; U.pos = clamp(U.pos); return 0;   // UDM_SETRANGE: MAKELPARAM(upper, lower)
      case 0x466: return ((U.min & 0xffff) << 16 | (U.max & 0xffff)) >>> 0;     // UDM_GETRANGE
      case 0x467: { const old = U.pos; U.pos = clamp(lp << 16 >> 16); udText(x, w); return old; }   // UDM_SETPOS
      case 0x468: return U.pos & 0xffff;                                         // UDM_GETPOS
      case 0x469: { const old = U.buddy || 0; U.buddy = wp; U.placed = false; attach(w); return old; }   // UDM_SETBUDDY
      case 0x46a: return U.buddy || 0;                                           // UDM_GETBUDDY
      case 0x46f: U.min = wp | 0; U.max = lp | 0; U.pos = clamp(U.pos); return 0;   // UDM_SETRANGE32
      case 0x470: if (wp) x.w32(wp, U.min); if (lp) x.w32(lp, U.max); return 0;  // UDM_GETRANGE32
      case 0x471: { const old = U.pos; U.pos = clamp(lp | 0); udText(x, w); return old; }   // UDM_SETPOS32
      case 0x472: if (wp) x.w32(wp, 0); return U.pos;                            // UDM_GETPOS32
      case 0x46b: case 0x46d: return 1;                                          // UDM_SETACCEL, UDM_SETBASE
      case 0x201: case 0x202: {
        const Y = lp >> 16, up = Y < (w.h >> 1); U.pressed = msg === 0x201 ? (up ? 1 : 2) : 0; invalidate(hwnd, true);
        if (msg === 0x202) return 0;
        const d = (up ? 1 : -1) * (U.max >= U.min ? 1 : -1), nm = notifyHdr(x, w, -722, 20); x.w32(nm + 12, U.pos); x.w32(nm + 16, d);   // UDN_DELTAPOS
        const v = clamp(U.pos + d); if (v === U.pos) return go(x, [[0x4e, w.id | 0, nm, w.parent]]);
        U.pos = v; udText(x, w);
        return go(x, [[0x4e, w.id | 0, nm, w.parent], [w.style & 0x40 ? 0x114 : 0x115, ((v & 0xffff) << 16 | 4) >>> 0, hwnd, w.parent]]);
      }
      case 0x0f: return paintWith(x, hwnd, w, (t) => {
        const half = t.h >> 1, btn = (y0, y1, down, pressed) => {
          fillRect(t, 0, y0, t.w, y1, FACE);
          if (pressed) { fillRect(t, 0, y0, t.w, y0 + 1, SHADOW); fillRect(t, 0, y0, 1, y1, SHADOW); } else raised(t, 0, y0, t.w, y1);
          const cx = (t.w >> 1) - 1 + (pressed ? 1 : 0), cy = ((y0 + y1) >> 1) - 1 + (pressed ? 1 : 0);
          for (let k = 0; k < 3; k++) fillRect(t, cx - k, down ? cy - 1 + k : cy + 1 - k, cx + k + 1, (down ? cy - 1 + k : cy + 1 - k) + 1, 0);
        };
        btn(0, half, false, U.pressed === 1); btn(half, t.h, true, U.pressed === 2);
      });
      default: return undefined;
    }
  };

  // ---- the tab control ---------------------------------------------------------------------------
  // Tabs 20 high, each its text and 6 either side; the selected one 2 higher and 2 wider either side,
  // open onto the panel under them (a raised edge round it). Measured on Windows 2000.
  const tc = (w) => (w.tc ||= { items: [], sel: 0 });
  const tabRects = (x, hwnd, w) => {
    const T = tc(w), hdc = dcFor(hwnd), m = metrics(hdc, w); let X = 2;
    return T.items.map((it) => { const r = { x: X, y: 2, w: widthOf(m, it.text) + 12, h: 18 }; X += r.w; return r; });
  };
  const tabs = (x, hwnd, w, msg, wp, lp) => {
    const T = tc(w), wide = msg === 0x133e || msg === 0x133d || msg === 0x133c;
    const readItem = (p, it) => { const mask = x.r32(p); if (mask & 1) it.text = strAt(x, x.r32(p + 12), wide); if (mask & 2) it.image = x.r32(p + 20) | 0; if (mask & 8) it.param = x.r32(p + 24); return it; };
    switch (msg) {
      case 0x1304: return T.items.length;                                        // TCM_GETITEMCOUNT
      case 0x1307: case 0x133e: { const i = Math.max(0, Math.min(T.items.length, wp | 0)); T.items.splice(i, 0, readItem(lp, { text: '', image: -1, param: 0 })); if (T.sel >= i && T.items.length > 1) T.sel++; invalidate(hwnd, true); return i; }   // TCM_INSERTITEM
      case 0x1306: case 0x133d: { const it = T.items[wp | 0]; if (!it) return 0; readItem(lp, it); invalidate(hwnd, true); return 1; }   // TCM_SETITEM
      case 0x1305: case 0x133c: { const it = T.items[wp | 0]; if (!it) return 0; const mask = x.r32(lp); if (mask & 1) putStr(x, x.r32(lp + 12), x.r32(lp + 16) | 0, it.text, wide); if (mask & 2) x.w32(lp + 20, it.image); if (mask & 8) x.w32(lp + 24, it.param); return 1; }   // TCM_GETITEM
      case 0x1308: { if (!T.items[wp | 0]) return 0; T.items.splice(wp | 0, 1); T.sel = Math.min(T.sel, Math.max(0, T.items.length - 1)); invalidate(hwnd, true); return 1; }   // TCM_DELETEITEM
      case 0x1309: T.items = []; T.sel = 0; invalidate(hwnd, true); return 1;   // TCM_DELETEALLITEMS
      case 0x130a: { const r = tabRects(x, hwnd, w)[wp | 0]; if (!r) return 0; [r.x, r.y, r.x + r.w, r.y + r.h].forEach((v, i) => x.w32(lp + 4 * i, v)); return 1; }   // TCM_GETITEMRECT
      case 0x130b: case 0x132f: return T.items.length ? T.sel : -1;              // TCM_GETCURSEL, GETCURFOCUS
      case 0x130c: case 0x1330: { const old = T.items.length ? T.sel : -1; if (wp < T.items.length) { T.sel = wp | 0; invalidate(hwnd, true); } return old; }   // TCM_SETCURSEL
      case 0x130d: { const X = x.r32(lp) | 0, Y = x.r32(lp + 4) | 0, k = tabRects(x, hwnd, w).findIndex((r) => X >= r.x && X < r.x + r.w && Y >= 0 && Y < 21); x.w32(lp + 8, k < 0 ? 1 : 6); return k; }   // TCM_HITTEST
      case 0x1328: {                                                              // TCM_ADJUSTRECT: the panel's inside from the window's, or back
        const r = [0, 4, 8, 12].map((o) => x.r32(lp + o) | 0), d = wp ? [-4, -22, 4, 4] : [4, 22, -4, -4];
        r.forEach((v, i) => x.w32(lp + 4 * i, v + d[i])); return 0;
      }
      case 0x1303: { const old = T.imgl || 0; T.imgl = lp; return old; } case 0x1302: return T.imgl || 0;   // TCM_SETIMAGELIST, GET
      case 0x1329: case 0x132b: return 0; case 0x132c: return 1;                 // TCM_SETITEMSIZE, SETPADDING, GETROWCOUNT
      case 0x201: {                                                               // a click on a tab: TCN_SELCHANGING, then TCN_SELCHANGE
        const X = (lp << 16) >> 16, Y = lp >> 16, k = tabRects(x, hwnd, w).findIndex((r) => X >= r.x - 2 && X < r.x + r.w + 2 && Y >= 0 && Y < 21);
        st.focus = hwnd; if (k < 0 || k === T.sel) return 0;
        T.sel = k; invalidate(hwnd, true);
        return go(x, [[0x4e, w.id | 0, notifyHdr(x, w, -552), w.parent], [0x4e, w.id | 0, notifyHdr(x, w, -551), w.parent]]);
      }
      case 0x0f: return paintWith(x, hwnd, w, (t, hdc) => {
        // Only its lines and tabs: what is inside the panel is its parent's face and its siblings'.
        const m = metrics(hdc, w), rs = tabRects(x, hwnd, w), top = 20;
        line(t, 0, top, t.w - 1, top + 1, LIGHT); line(t, 0, top, 1, t.h - 1, LIGHT);
        line(t, 0, t.h - 1, t.w, t.h, DARK); line(t, t.w - 1, top, t.w, t.h, DARK); line(t, 1, t.h - 2, t.w - 1, t.h - 1, SHADOW); line(t, t.w - 2, top + 1, t.w - 1, t.h - 1, SHADOW);
        const tab = (r, sel) => {
          const x0 = sel ? r.x - 2 : r.x, x1 = sel ? r.x + r.w + 2 : r.x + r.w, y0 = sel ? 0 : 2;
          fillRect(t, x0, y0, x1, sel ? top + 1 : top, FACE);
          line(t, x0, y0 + 2, x0 + 1, sel ? top + 1 : top, LIGHT); line(t, x0 + 1, y0 + 1, x0 + 2, y0 + 2, LIGHT); line(t, x0 + 2, y0, x1 - 2, y0 + 1, LIGHT);
          line(t, x1 - 2, y0 + 1, x1 - 1, sel ? top + 1 : top, SHADOW); line(t, x1 - 1, y0 + 2, x1, sel ? top + 1 : top, DARK); line(t, x1 - 2, y0 + 1, x1 - 1, y0 + 2, DARK);
          write(x, t, hdc, m, r.text, x0 + (sel ? 8 : 6), y0 + ((18 - m.height) >> 1) + 1, 0);
          if (sel && st.focus === hwnd) dotted(t, x0 + 3, y0 + 3, x1 - 3, top - 1);
        };
        rs.forEach((r, i) => { r.text = T.items[i].text; if (i !== T.sel) tab(r, false); });
        if (rs[T.sel]) tab(rs[T.sel], true);
      });
      default: return undefined;
    }
  };

  // ---- the list view (report view) ---------------------------------------------------------------
  // A header of columns (raised, the text left, centred or right as LVCFMT 0/2/1 says, its right a face
  // header to the end), rows the font's height and 1 more, each item's sub-items in its columns; the
  // selected item's label highlighted (the whole row with LVS_EX_FULLROWSELECT 20h), the focused one
  // dotted. A click selects (LVN_ITEMCHANGING / LVN_ITEMCHANGED, NM_CLICK), the arrows move.
  const lv = (w) => (w.lv ||= { cols: [], items: [], top: 0, ex: 0 });
  const lvRow = (m) => m.height + 1;
  const lvHead = (m) => m.height + 6;
  const lvBorder = (w) => ((w.ex | 0) & 0x200 ? 2 : w.style & 0x800000 ? 1 : 0);
  const lvNotify = (x, w, code, i, newS, oldS) => { const L = lv(w), nm = notifyHdr(x, w, code, 44); x.w32(nm + 12, i); x.w32(nm + 20, newS); x.w32(nm + 24, oldS); x.w32(nm + 28, 8); x.w32(nm + 40, L.items[i] ? L.items[i].param : 0); return [0x4e, w.id | 0, nm, w.parent]; };
  const lvSelect = (x, hwnd, w, i, extra = []) => {
    const L = lv(w), msgs = [];
    L.items.forEach((it, k) => { const was = it.state; const want = k === i ? (it.state | 3) : (w.style & 4 || true ? it.state & ~3 : it.state); if (want !== was) { it.state = want; msgs.push(lvNotify(x, w, -101, k, want, was)); } });   // LVN_ITEMCHANGED
    invalidate(hwnd, true); return go(x, [...msgs, ...extra]);
  };
  const listview = (x, hwnd, w, msg, wp, lp) => {
    const L = lv(w), wide = [0x104b, 0x104c, 0x104d, 0x1061, 0x1060, 0x105f, 0x1073, 0x1074, 0x1053].includes(msg);
    const readItem = (p, it) => {
      const mask = x.r32(p), sub = x.r32(p + 8) | 0;
      if (mask & 1) { const s = strAt(x, x.r32(p + 20), wide); if (sub) it.sub[sub] = s; else it.text = s; }
      if (mask & 2) it.image = x.r32(p + 28) | 0; if (mask & 4) it.param = x.r32(p + 32);
      if (mask & 8) { const sm = x.r32(p + 16); it.state = (it.state & ~sm) | (x.r32(p + 12) & sm); }
    };
    const readCol = (p, c) => { const mask = x.r32(p); if (mask & 1) c.fmt = x.r32(p + 4) & 3; if (mask & 2) c.cx = x.r32(p + 8) | 0; if (mask & 4) c.text = strAt(x, x.r32(p + 12), wide); return c; };
    switch (msg) {
      case 0x1004: return L.items.length;                                         // LVM_GETITEMCOUNT
      case 0x1007: case 0x104d: {                                                 // LVM_INSERTITEM
        const it = { text: '', sub: [], image: -1, param: 0, state: 0 }; readItem(lp, it);
        const i = Math.max(0, Math.min(L.items.length, x.r32(lp + 4) | 0)); L.items.splice(i, 0, it); invalidate(hwnd, true); return i;
      }
      case 0x1006: case 0x104c: { const it = L.items[x.r32(lp + 4) | 0]; if (!it) return 0; readItem(lp, it); invalidate(hwnd, true); return 1; }   // LVM_SETITEM
      case 0x1005: case 0x104b: {                                                 // LVM_GETITEM
        const it = L.items[x.r32(lp + 4) | 0]; if (!it) return 0; const mask = x.r32(lp), sub = x.r32(lp + 8) | 0;
        if (mask & 1) putStr(x, x.r32(lp + 20), x.r32(lp + 24) | 0, sub ? it.sub[sub] || '' : it.text, wide);
        if (mask & 2) x.w32(lp + 28, it.image); if (mask & 4) x.w32(lp + 32, it.param); if (mask & 8) x.w32(lp + 12, it.state & x.r32(lp + 16)); return 1;
      }
      case 0x102e: case 0x1074: { const it = L.items[wp | 0]; if (!it) return 0; const sub = x.r32(lp + 8) | 0, s = strAt(x, x.r32(lp + 20), msg === 0x1074); if (sub) it.sub[sub] = s; else it.text = s; invalidate(hwnd, true); return 1; }   // LVM_SETITEMTEXT
      case 0x102d: case 0x1073: { const it = L.items[wp | 0]; if (!it) return 0; const sub = x.r32(lp + 8) | 0, s = sub ? it.sub[sub] || '' : it.text; putStr(x, x.r32(lp + 20), x.r32(lp + 24) | 0, s, msg === 0x1073); return s.length; }   // LVM_GETITEMTEXT
      case 0x1008: if (!L.items[wp | 0]) return 0; L.items.splice(wp | 0, 1); invalidate(hwnd, true); return 1;   // LVM_DELETEITEM
      case 0x1009: L.items = []; L.top = 0; invalidate(hwnd, true); return 1;     // LVM_DELETEALLITEMS
      case 0x102b: {                                                              // LVM_SETITEMSTATE (-1: every item)
        const sm = x.r32(lp + 16), sv = x.r32(lp + 12), apply = (it) => { it.state = (it.state & ~sm) | (sv & sm); };
        if ((wp | 0) === -1) L.items.forEach(apply); else if (L.items[wp | 0]) apply(L.items[wp | 0]); else return 0;
        invalidate(hwnd, true); return 1;
      }
      case 0x102c: return L.items[wp | 0] ? L.items[wp | 0].state & lp : 0;      // LVM_GETITEMSTATE
      case 0x100c: {                                                               // LVM_GETNEXTITEM: LVNI_SELECTED 2, LVNI_FOCUSED 1
        for (let k = (wp | 0) + 1; k < L.items.length; k++) { const s = L.items[k].state; if (!(lp & 3) || (lp & 2 && s & 2) || (lp & 1 && s & 1)) return k; }
        return -1;
      }
      case 0x1032: return L.items.filter((it) => it.state & 2).length;            // LVM_GETSELECTEDCOUNT
      case 0x101b: case 0x1061: { const i = Math.max(0, Math.min(L.cols.length, wp | 0)); L.cols.splice(i, 0, readCol(lp, { text: '', cx: 50, fmt: 0 })); invalidate(hwnd, true); return i; }   // LVM_INSERTCOLUMN
      case 0x101a: case 0x1060: { const c = L.cols[wp | 0]; if (!c) return 0; readCol(lp, c); invalidate(hwnd, true); return 1; }   // LVM_SETCOLUMN
      case 0x1019: case 0x105f: { const c = L.cols[wp | 0]; if (!c) return 0; const mask = x.r32(lp); if (mask & 1) x.w32(lp + 4, c.fmt); if (mask & 2) x.w32(lp + 8, c.cx); if (mask & 4) putStr(x, x.r32(lp + 12), x.r32(lp + 16) | 0, c.text, msg === 0x105f); return 1; }   // LVM_GETCOLUMN
      case 0x101c: if (!L.cols[wp | 0]) return 0; L.cols.splice(wp | 0, 1); invalidate(hwnd, true); return 1;   // LVM_DELETECOLUMN
      case 0x101d: return L.cols[wp | 0] ? L.cols[wp | 0].cx : 0;                 // LVM_GETCOLUMNWIDTH
      case 0x101e: { const c = L.cols[wp | 0]; if (!c) return 0; c.cx = (lp << 16 >> 16) < 0 ? 100 : lp << 16 >> 16; invalidate(hwnd, true); return 1; }   // LVM_SETCOLUMNWIDTH (auto: 100)
      case 0x1036: { const old = L.ex; L.ex = wp ? (L.ex & ~wp) | (lp & wp) : lp; invalidate(hwnd, true); return old; }   // LVM_SETEXTENDEDLISTVIEWSTYLE
      case 0x1037: return L.ex;
      case 0x1003: { const old = (L.imgl ||= [])[wp] || 0; L.imgl[wp] = lp; return old; } case 0x1002: return (L.imgl || [])[wp] || 0;   // LVM_SETIMAGELIST, GET
      case 0x1027: return L.top;                                                  // LVM_GETTOPINDEX
      case 0x1028: { const m = metrics(dcFor(hwnd), w); return Math.max(1, Math.floor((w.h - 2 * lvBorder(w) - lvHead(m)) / lvRow(m))); }   // LVM_GETCOUNTPERPAGE
      case 0x1013: { const m = metrics(dcFor(hwnd), w), page = Math.max(1, Math.floor((w.h - 2 * lvBorder(w) - lvHead(m)) / lvRow(m))); if (wp < L.top) L.top = wp; else if (wp >= L.top + page) L.top = wp - page + 1; invalidate(hwnd, true); return 1; }   // LVM_ENSUREVISIBLE
      case 0x100e: {                                                               // LVM_GETITEMRECT
        const m = metrics(dcFor(hwnd), w), b = lvBorder(w), y = b + lvHead(m) + ((wp | 0) - L.top) * lvRow(m), full = L.cols.reduce((s, c) => s + c.cx, 0);
        [b, y, b + (x.r32(lp) === 2 ? (L.cols[0] ? L.cols[0].cx : full) : full), y + lvRow(m)].forEach((v, i) => x.w32(lp + 4 * i, v)); return 1;
      }
      case 0x1012: case 0x1039: {                                                  // LVM_HITTEST, LVM_SUBITEMHITTEST
        const m = metrics(dcFor(hwnd), w), b = lvBorder(w), X = x.r32(lp) | 0, Y = x.r32(lp + 4) | 0, k = Math.floor((Y - b - lvHead(m)) / lvRow(m)) + L.top;
        const hit = Y >= b + lvHead(m) && k >= 0 && k < L.items.length; x.w32(lp + 8, hit ? 4 : 1); x.w32(lp + 12, hit ? k : -1);
        if (msg === 0x1039) { let cx = b, sub = 0; for (; sub < L.cols.length && X >= cx + L.cols[sub].cx; sub++) cx += L.cols[sub].cx; x.w32(lp + 16, sub); }
        return hit ? k : -1;
      }
      case 0x1001: { L.bk = lp; invalidate(hwnd, true); return 1; } case 0x1000: return L.bk ?? 0xffffff;   // LVM_SETBKCOLOR, GET
      case 0x1024: case 0x1026: return 1;                                          // LVM_SETTEXTCOLOR, SETTEXTBKCOLOR
      case 0x101f: return 0;                                                       // LVM_GETHEADER: drawn here, no window
      case 0x1015: case 0x102a: case 0x102f: case 0x1030: invalidate(hwnd, true); return 1;   // LVM_REDRAWITEMS, UPDATE, SETITEMCOUNT, SORTITEMS
      case 0x87: return 0x01;                                                      // WM_GETDLGCODE
      case 0x07: case 0x08: invalidate(hwnd, true); return 0;
      case 0x201: case 0x203: {
        st.focus = hwnd; const m = metrics(dcFor(hwnd), w), b = lvBorder(w), Y = lp >> 16, k = Math.floor((Y - b - lvHead(m)) / lvRow(m)) + L.top;
        if (Y < b + lvHead(m) || k < 0 || k >= L.items.length) return 0;
        return lvSelect(x, hwnd, w, k, [[0x4e, w.id | 0, notifyHdr(x, w, msg === 0x203 ? -3 : -2), w.parent]]);   // NM_DBLCLK, NM_CLICK
      }
      case 0x100: {
        const cur = L.items.findIndex((it) => it.state & 1), n = { 0x26: cur - 1, 0x28: cur + 1, 0x24: 0, 0x23: L.items.length - 1 }[wp];
        if (n === undefined || n < 0 || n >= L.items.length) return 0; return lvSelect(x, hwnd, w, n);
      }
      case 0x0f: return paintWith(x, hwnd, w, (t, hdc) => {
        const m = metrics(hdc, w), b = lvBorder(w), hh = lvHead(m), rh = lvRow(m), bk = L.bk !== undefined && L.bk !== 0xff000000 ? rgb(L.bk) : 0xffffff;
        fillRect(t, 0, 0, t.w, t.h, bk);
        if (b === 2) sunken(t, 0, 0, t.w, t.h); else if (b === 1) { line(t, 0, 0, t.w, 1, 0); line(t, 0, t.h - 1, t.w, t.h, 0); line(t, 0, 0, 1, t.h, 0); line(t, t.w - 1, 0, t.w, t.h, 0); }
        const report = (w.style & 3) === 1;
        let X = b;
        if (report && !(w.style & 0x4000)) {                                     // LVS_NOCOLUMNHEADER
          for (const c of L.cols) {
            fillRect(t, X, b, X + c.cx, b + hh, FACE); raised(t, X, b, X + c.cx, b + hh);
            const tw = widthOf(m, c.text), tx = c.fmt === 1 ? X + c.cx - 6 - tw : c.fmt === 2 ? X + ((c.cx - tw) >> 1) : X + 6;
            write(x, t, hdc, m, c.text, tx, b + ((hh - m.height) >> 1), 0, c.cx - 12);
            X += c.cx;
          }
          if (X < t.w - b) { fillRect(t, X, b, t.w - b, b + hh, FACE); raised(t, X, b, t.w - b, b + hh); }
        }
        const y0 = b + (report && !(w.style & 0x4000) ? hh : 0), focused = st.focus === hwnd, full = L.ex & 0x20;
        for (let k = L.top, Y = y0; k < L.items.length && Y < t.h - b; k++, Y += rh) {
          const it = L.items[k], sel = it.state & 2, hot = sel && (focused || (w.style & 8));   // LVS_SHOWSELALWAYS
          let cx = b;
          (report ? L.cols : [{ cx: t.w }]).forEach((c, ci) => {
            const s = ci ? it.sub[ci] || '' : it.text, tw = widthOf(m, s), tx = c.fmt === 1 ? cx + c.cx - 6 - tw : c.fmt === 2 ? cx + ((c.cx - tw) >> 1) : cx + (ci ? 6 : 2);
            const lit = hot && (full || ci === 0), ink = lit ? (focused ? 0xffffff : 0) : 0;
            if (lit) fillRect(t, full ? cx : tx - 2, Y, full ? cx + c.cx : Math.min(cx + c.cx, tx + tw + 2), Y + rh, focused ? HIGHLIGHT : FACE);
            write(x, t, hdc, m, s, tx, Y + ((rh - m.height) >> 1), ink, c.cx - 8);
            if (ci === 0 && it.state & 1 && focused) dotted(t, full ? b : tx - 2, Y, full ? t.w - b : Math.min(cx + c.cx, tx + tw + 2), Y + rh);
            cx += c.cx;
          });
        }
      });
      default: return undefined;
    }
  };

  // ---- the toolbar -------------------------------------------------------------------------------
  // At the top of its parent (CCS_TOP, the default), as wide as it; buttons 23x22 (16x15 images) raised,
  // pressed or checked sunken (TBSTATE_PRESSED 2, CHECKED 1) with the face dithered, disabled embossed;
  // separators 8 wide. Images: comctl32's standard ones (HINST_COMMCTRL, IDB_STD_*: drawn here, as
  // Windows ships them, in outline) or a bitmap of the program's, 16 wide each.
  const STD = {                                                                  // 16x16, '.' clear; k black, w white, y yellow, b blue, g grey, n navy, r red
    0: ['', '   k     k', '   k     k', '   kk   kk', '    k   k', '    kk kk', '     k k', '      k', '     k k', '   kkk kkk', '  k  k k  k', '  k  k k  k', '  k  k k  k', '   kk   kk'],   // cut
    1: ['', ' kkkkk', ' kwwwk', ' kwkwkkkkkk', ' kwwwknwwwnk', ' kwkwknwwwwnk', ' kwwwknwkkwwn', ' kkkkknwwwwwn', '      nwkkkwn', '      nwwwwwn', '      nwkkkwn', '      nwwwwwn', '      nnnnnnn'],   // copy
    2: ['', '    kkkk', ' kkkyyykkkk', ' kyyykkyyyk', ' kyykkkkkyyk', ' kyyykkkkkk', ' kyyyknwwwwn', ' kyyyknwkkwwn', ' kyyyknwwwwwn', ' kyyyknwkkkwn', ' kyyyknwwwwwn', ' kkkkknwkkkwn', '      nwwwwwn', '      nnnnnnn'],   // paste
    3: [], 4: [], 5: [],
    6: ['', '  kkkkkkk', '  kwwwwwkk', '  kwwwwwkwk', '  kwwwwwkkkk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kwwwwwwwwk', '  kkkkkkkkkk'],   // new
    7: ['', '', '        kkk', '       k   k k', '            kk', '  kkk      kkk', ' kyyykkkkkkk', ' kyyyyyyyyyk', ' kyyykkkkkkkkk', ' kyykyyyyyyyyk', ' kykyyyyyyyyk', ' kkyyyyyyyyk', ' kkkkkkkkkkk'],   // open
    8: ['', ' kkkkkkkkkkkkk', ' knkwwwwwwwknk', ' knkwwwwwwwknk', ' knkwwwwwwwknk', ' knkwwwwwwwknk', ' knnkkkkkkknnk', ' knnnnnnnnnnnk', ' knnkkkkkkknnk', ' knnkkkkgknnnk', ' knnkkkkgknnnk', ' knnkkkkgknnnk', '  kkkkkkkkkkkk'],   // save
  };
  const COL = { k: 0, w: 0xffffff, y: 0xffff00, b: 0x0000ff, g: 0x808080, n: 0x000080, r: 0xff0000 };
  const tbr = (w) => (w.tbr ||= { btns: [], images: [], bw: 23, bh: 22 });
  const tbLayout = (w) => {
    const B = tbr(w); let X = 0; const out = [];
    for (const b of B.btns) { if (b.state & 8) { out.push(null); continue; } const sep = b.style & 1, wd = sep ? 8 : B.bw; out.push({ x: X, y: 2, w: wd, h: B.bh }); X += wd; }
    return out;
  };
  const tbPlace = (w) => { if (w.style & 0x4) return; const P = parentSize(w); w.x = 0; w.y = 0; w.w = P.w; w.h = tbr(w).bh + 6; };   // CCS_NORESIZE (4): where it is
  const toolbar = (x, hwnd, w, msg, wp, lp) => {
    const B = tbr(w), idx = (id) => B.btns.findIndex((b) => b.id === (id & 0xffff) && !(b.style & 1));
    const readBtn = (p) => ({ image: x.r32(p) | 0, id: x.r32(p + 4) & 0xffff, state: x.r8(p + 8), style: x.r8(p + 9), data: x.r32(p + 12), str: x.r32(p + 16) });
    const setState = (i, on, bit) => { if (i < 0) return 0; const b = B.btns[i]; b.state = on ? b.state | bit : b.state & ~bit; invalidate(hwnd, true); return 1; };
    switch (msg) {
      case 0x01: tbPlace(w); return 0;                                            // WM_CREATE
      case 0x41e: return 0;                                                       // TB_BUTTONSTRUCTSIZE
      case 0x413: {                                                               // TB_ADDBITMAP: TBADDBITMAP {hInst, nID}; its first image's index
        const first = B.images.length, inst = x.r32(lp), id = x.r32(lp + 4);
        if (inst === 0xffffffff) for (let i = 0; i < 15; i++) B.images.push({ std: (id & 1 ? 0 : 0) + i, set: id });   // HINST_COMMCTRL
        else { const bm = h.loadBitmap(x, inst, id); const n = Math.max(1, wp | 0); for (let i = 0; i < n; i++) B.images.push({ bm, i }); }
        return first;
      }
      case 0x414: case 0x444: { for (let i = 0; i < (wp | 0); i++) B.btns.push(readBtn(lp + 20 * i)); tbPlace(w); invalidate(hwnd, true); return 1; }   // TB_ADDBUTTONSA/W
      case 0x415: case 0x443: { const i = Math.max(0, Math.min(B.btns.length, wp | 0)); B.btns.splice(i, 0, readBtn(lp)); invalidate(hwnd, true); return 1; }   // TB_INSERTBUTTON
      case 0x416: if (!B.btns[wp | 0]) return 0; B.btns.splice(wp | 0, 1); invalidate(hwnd, true); return 1;   // TB_DELETEBUTTON
      case 0x417: { const b = B.btns[wp | 0]; if (!b) return 0; x.w32(lp, b.image); x.w32(lp + 4, b.id); x.w8(lp + 8, b.state); x.w8(lp + 9, b.style); x.w32(lp + 12, b.data); x.w32(lp + 16, b.str); return 1; }   // TB_GETBUTTON
      case 0x418: return B.btns.length;                                           // TB_BUTTONCOUNT
      case 0x419: return idx(wp);                                                 // TB_COMMANDTOINDEX
      case 0x401: return setState(idx(wp), lp & 0xffff, 4);                       // TB_ENABLEBUTTON
      case 0x402: return setState(idx(wp), lp & 0xffff, 1);                       // TB_CHECKBUTTON
      case 0x403: return setState(idx(wp), lp & 0xffff, 2);                       // TB_PRESSBUTTON
      case 0x404: return setState(idx(wp), lp & 0xffff, 8);                       // TB_HIDEBUTTON
      case 0x409: { const i = idx(wp); return i < 0 ? 0 : B.btns[i].state & 4 ? 1 : 0; }   // TB_ISBUTTONENABLED
      case 0x40a: { const i = idx(wp); return i < 0 ? 0 : B.btns[i].state & 1 ? 1 : 0; }   // TB_ISBUTTONCHECKED
      case 0x40b: { const i = idx(wp); return i < 0 ? 0 : B.btns[i].state & 2 ? 1 : 0; }   // TB_ISBUTTONPRESSED
      case 0x411: { const i = idx(wp); if (i < 0) return 0; B.btns[i].state = lp & 0xff; invalidate(hwnd, true); return 1; }   // TB_SETSTATE
      case 0x412: { const i = idx(wp); return i < 0 ? -1 : B.btns[i].state; }    // TB_GETSTATE
      case 0x41d: { const r = tbLayout(w)[wp | 0]; if (!r) return 0; [r.x, r.y, r.x + r.w, r.y + r.h].forEach((v, i) => x.w32(lp + 4 * i, v)); return 1; }   // TB_GETITEMRECT
      case 0x41f: B.bw = lp & 0xffff; B.bh = lp >>> 16; tbPlace(w); invalidate(hwnd, true); return 1;   // TB_SETBUTTONSIZE
      case 0x43a: return ((B.bh & 0xffff) << 16 | (B.bw & 0xffff)) >>> 0;        // TB_GETBUTTONSIZE
      case 0x421: case 0x05: tbPlace(w); invalidate(hwnd, true); return 0;      // TB_AUTOSIZE, WM_SIZE
      case 0x420: case 0x42f: case 0x43c: case 0x454: case 0x424: case 0x425: case 0x427: return 1;   // bitmap size, indent, text rows, extended style, tooltips, parent, rows
      case 0x455: case 0x423: return 0; case 0x428: return 1;                    // TB_GETEXTENDEDSTYLE, GETTOOLTIPS, GETROWS
      case 0x41c: case 0x44d: return 0;                                           // TB_ADDSTRING
      case 0x201: case 0x202: {                                                   // a press and a release on a button: WM_COMMAND
        const X = (lp << 16) >> 16, Y = lp >> 16, rs = tbLayout(w), i = rs.findIndex((r) => r && X >= r.x && X < r.x + r.w && Y >= r.y && Y < r.y + r.h);
        const b = B.btns[i]; if (!b || b.style & 1 || !(b.state & 4)) { B.down = -1; return 0; }
        if (msg === 0x201) { B.down = i; b.state |= 2; st.capture = hwnd; invalidate(hwnd, true); return 0; }
        if (st.capture === hwnd) st.capture = 0;
        if (B.down !== i) { B.down = -1; return 0; }
        B.down = -1; b.state &= ~2; if (b.style & 2) b.state ^= 1;                // TBSTYLE_CHECK
        invalidate(hwnd, true); return go(x, [[0x111, b.id, hwnd, w.parent]]);
      }
      case 0x0f: return paintWith(x, hwnd, w, (t) => {
        fillRect(t, 0, 0, t.w, t.h, FACE); line(t, 0, 0, t.w, 1, SHADOW); line(t, 0, 1, t.w, 2, LIGHT);   // the etched line under the menu
        tbLayout(w).forEach((r, i) => {
          const b = B.btns[i]; if (!r || b.style & 1) { if (r) { line(t, r.x + 3, r.y + 1, r.x + 4, r.y + r.h - 1, SHADOW); line(t, r.x + 4, r.y + 1, r.x + 5, r.y + r.h - 1, LIGHT); } return; }
          const down = b.state & 3, en = b.state & 4;
          if (down) {
            line(t, r.x, r.y, r.x + r.w, r.y + 1, DARK); line(t, r.x, r.y, r.x + 1, r.y + r.h, DARK); line(t, r.x + 1, r.y + 1, r.x + r.w - 1, r.y + 2, SHADOW); line(t, r.x + 1, r.y + 1, r.x + 2, r.y + r.h - 1, SHADOW);
            line(t, r.x, r.y + r.h - 1, r.x + r.w, r.y + r.h, LIGHT); line(t, r.x + r.w - 1, r.y, r.x + r.w, r.y + r.h, LIGHT);
            if (b.state & 1 && !(b.state & 2)) for (let Y = r.y + 2; Y < r.y + r.h - 1; Y++) for (let X = r.x + 2; X < r.x + r.w - 1; X++) if ((X + Y) & 1) t.px[Y * t.w + X] = LIGHT;
          } else raised(t, r.x, r.y, r.x + r.w, r.y + r.h);
          const ox = r.x + ((r.w - 16) >> 1) + (down ? 1 : 0), oy = r.y + ((r.h - 15) >> 1) + (down ? 1 : 0), img = B.images[b.image];
          const px = (X, Y, c) => { if (X >= 0 && Y >= 0 && X < t.w && Y < t.h) t.px[Y * t.w + X] = c; };
          const each = (fn) => {
            if (img && img.std !== undefined) (STD[img.std] || []).forEach((row, j) => [...row].forEach((ch, i2) => { if (COL[ch] !== undefined) fn(i2, j, COL[ch]); }));
            else if (img && img.bm) { const bm = img.bm, mask = bm.px[0]; for (let j = 0; j < Math.min(15, bm.h); j++) for (let i2 = 0; i2 < 16; i2++) { const c = bm.px[j * bm.w + img.i * 16 + i2]; if (c !== mask && c !== 0xc0c0c0) fn(i2, j, c); } }
          };
          if (en) each((i2, j, c) => px(ox + i2, oy + j, c));
          else { each((i2, j, c) => { if (c !== 0xffffff && c !== FACE) px(ox + i2 + 1, oy + j + 1, LIGHT); }); each((i2, j, c) => { if (c !== 0xffffff && c !== FACE) px(ox + i2, oy + j, SHADOW); }); }   // embossed
        });
      });
      default: return undefined;
    }
  };

  // ---- the status bar ----------------------------------------------------------------------------
  // At the bottom of its parent, the font's height and 7 high; its parts (SB_SETPARTS: their right ends,
  // -1 to the end) each a thin sunken box with its text, 2 apart; the size grip (SBARS_SIZEGRIP 100h) at
  // the bottom right, three pairs of lines.
  const sbr = (w) => (w.sbr ||= { parts: [-1], texts: [''], simple: false });
  const sbPlace = (x, hwnd, w) => {
    if (w.style & 0x4) return; const m = metrics(dcFor(hwnd), w), P = parentSize(w), H = Math.max(m.height + 7, 20);
    w.x = 0; w.y = P.h - H; w.w = P.w; w.h = H;
  };
  const statusbar = (x, hwnd, w, msg, wp, lp) => {
    const S = sbr(w), wide = msg === 0x40b || msg === 0x40d;
    switch (msg) {
      case 0x01: S.texts[0] = w.title || ''; sbPlace(x, hwnd, w); return 0;       // WM_CREATE: its title the first part's text
      case 0x05: sbPlace(x, hwnd, w); invalidate(hwnd, true); return 0;          // WM_SIZE: the parent's bottom again
      case 0x0c: S.texts[0] = w.title = lp ? x.str(lp, 1024) : ''; invalidate(hwnd, true); return 1;   // WM_SETTEXT
      case 0x401: case 0x40b: { S.texts[wp & 0xff] = strAt(x, lp, wide); invalidate(hwnd, true); return 1; }   // SB_SETTEXT
      case 0x402: case 0x40d: { const s = S.texts[wp & 0xff] || ''; if (lp) putStr(x, lp, 0x7fffffff, s, wide); return s.length; }   // SB_GETTEXT
      case 0x403: case 0x40c: return (S.texts[wp & 0xff] || '').length;         // SB_GETTEXTLENGTH
      case 0x404: { const n = Math.max(1, Math.min(256, wp | 0)); S.parts = []; for (let i = 0; i < n; i++) S.parts.push(x.r32(lp + 4 * i) | 0); invalidate(hwnd, true); return 1; }   // SB_SETPARTS
      case 0x406: { if (lp) S.parts.forEach((v, i) => { if (i < (wp | 0)) x.w32(lp + 4 * i, v); }); return S.parts.length; }   // SB_GETPARTS
      case 0x407: x.w32(lp, 0); x.w32(lp + 4, 2); x.w32(lp + 8, 2); return 1;    // SB_GETBORDERS
      case 0x409: S.simple = !!wp; invalidate(hwnd, true); return 0;             // SB_SIMPLE
      case 0x40e: return S.simple ? 1 : 0;                                       // SB_ISSIMPLE
      case 0x40a: { const r = sbRects(w)[wp | 0]; if (!r) return 0; [r.x0, 2, r.x1, w.h].forEach((v, i) => x.w32(lp + 4 * i, v)); return 1; }   // SB_GETRECT
      case 0x408: case 0x40f: case 0x410: case 0x411: return 1;                  // SB_SETMINHEIGHT, SETICON, SETTIPTEXT
      case 0x0f: return paintWith(x, hwnd, w, (t, hdc) => {
        fillRect(t, 0, 0, t.w, t.h, FACE);
        const m = metrics(hdc, w), grip = w.style & 0x100;
        sbRects(w).forEach((r, i) => {
          const x1 = Math.min(r.x1, t.w - (grip && r.x1 >= t.w ? 0 : 0));
          thinSunken(t, r.x0, 2, x1, t.h);
          write(x, t, hdc, m, (S.simple ? S.texts[0] : S.texts[i]) || '', r.x0 + 2, 2 + ((t.h - 2 - m.height) >> 1), 0, x1 - r.x0 - 4);
        });
        if (grip) for (let k = 0; k < 3; k++) for (let d = 0; d < 2; d++) { const o = 4 * k + 3 + d; for (let j = 0; j < o; j++) { const X = t.w - 2 - j, Y = t.h - 2 - (o - 1 - j); if (X >= 0 && Y >= 0) t.px[Y * t.w + X] = d ? LIGHT : SHADOW; } }
      });
      default: return undefined;
    }
  };
  const sbRects = (w) => {
    const S = sbr(w); if (S.simple) return [{ x0: 0, x1: w.w }];
    let prev = 0; return S.parts.map((p) => { const r = { x0: prev, x1: p < 0 || p > w.w ? w.w : p }; prev = r.x1 + 2; return r; });
  };

  const HANDLERS = { msctls_progress32: progress, msctls_trackbar32: trackbar, msctls_updown32: updown, systabcontrol32: tabs, syslistview32: listview, toolbarwindow32: toolbar, msctls_statusbar32: statusbar };
  return {
    /** A common control's answer to `msg`, or undefined: DefWindowProc's own then. */
    message: (x, hwnd, w, msg, wp, lp) => { const f = HANDLERS[w.cls]; return f ? f(x, hwnd, w, msg, wp, lp) : undefined; },
  };
}
