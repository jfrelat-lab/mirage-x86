// truetype.js — a TrueType font's outlines as GDI's GetGlyphOutline(GGO_NATIVE) gives them, for
// MIRAGE-WIN32's gdi32 and D3DXCreateText. MIRAGE ships no Windows font: the page hands over the
// visitor's own (Tahoma from the system, through the Local Font Access API) or a free one (DejaVu Sans).
// The glyphs are not hinted: at the sizes D3DX asks for (an em of some 1700 pixels) hinting moves a
// point by a fraction of a pixel in thousands.

/** The font in `bytes` (a .ttf): { em, winAscent, winDescent, glyph(code) }. */
export function parseTrueType(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const r = 12 + 16 * i, tag = String.fromCharCode(...bytes.subarray(r, r + 4));
    tables[tag] = dv.getUint32(r + 8);
  }
  for (const t of ['head', 'maxp', 'cmap', 'loca', 'glyf', 'hhea', 'hmtx']) if (tables[t] === undefined) throw new Error(`truetype: no '${t}' table`);
  const em = dv.getUint16(tables.head + 18), longLoca = dv.getInt16(tables.head + 50) === 1;
  const numGlyphs = dv.getUint16(tables.maxp + 4), numH = dv.getUint16(tables.hhea + 34);
  const os2 = tables['OS/2'];
  const winAscent = os2 !== undefined ? dv.getUint16(os2 + 74) : dv.getInt16(tables.hhea + 4);
  const winDescent = os2 !== undefined ? dv.getUint16(os2 + 76) : -dv.getInt16(tables.hhea + 6);
  const loca = (g) => (longLoca ? dv.getUint32(tables.loca + 4 * g) : 2 * dv.getUint16(tables.loca + 2 * g));
  const advance = (g) => dv.getUint16(tables.hmtx + 4 * Math.min(g, numH - 1));

  // cmap: the Unicode subtable, format 4 (the BMP) or 12.
  let map = () => 0;
  const cm = tables.cmap;
  for (let i = 0, n = dv.getUint16(cm + 2); i < n; i++) {
    const pid = dv.getUint16(cm + 4 + 8 * i), eid = dv.getUint16(cm + 6 + 8 * i), at = cm + dv.getUint32(cm + 8 + 8 * i);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const format = dv.getUint16(at);
    if (format === 4) {
      const segs = dv.getUint16(at + 6) / 2, ends = at + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, offs = deltas + 2 * segs;
      map = (c) => {
        for (let s = 0; s < segs; s++) {
          if (dv.getUint16(ends + 2 * s) < c) continue;
          const first = dv.getUint16(starts + 2 * s);
          if (c < first) return 0;
          const ro = dv.getUint16(offs + 2 * s);
          if (!ro) return (c + dv.getInt16(deltas + 2 * s)) & 0xffff;
          const g = dv.getUint16(offs + 2 * s + ro + 2 * (c - first));
          return g ? (g + dv.getInt16(deltas + 2 * s)) & 0xffff : 0;
        }
        return 0;
      };
      if (pid === 3 && eid === 1) break;
    } else if (format === 12) {
      const groups = dv.getUint32(at + 12);
      map = (c) => {
        for (let k = 0; k < groups; k++) {
          const g = at + 16 + 12 * k, a = dv.getUint32(g), b = dv.getUint32(g + 4);
          if (c >= a && c <= b) return dv.getUint32(g + 8) + c - a;
        }
        return 0;
      };
    }
  }

  // A glyph's contours, in font units: [[{ x, y, on }]]; a composite's components placed and scaled.
  const contours = (g, depth = 0) => {
    if (g >= numGlyphs || depth > 8) return [];
    const at = tables.glyf + loca(g);
    if (loca(g + 1) === loca(g)) return [];
    const n = dv.getInt16(at);
    if (n < 0) {
      const out = [];
      for (let p = at + 10, more = true; more;) {
        const flags = dv.getUint16(p), comp = dv.getUint16(p + 2);
        p += 4;
        let e, f;
        if (flags & 1) { e = dv.getInt16(p); f = dv.getInt16(p + 2); p += 4; } else { e = dv.getInt8(p); f = dv.getInt8(p + 1); p += 2; }
        let a = 1, b = 0, c = 0, d = 1;
        const f2 = (o) => dv.getInt16(o) / 16384;
        if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
        if (!(flags & 2)) e = f = 0;                                        // matched points: not met in a text font
        for (const k of contours(comp, depth + 1)) out.push(k.map((q) => ({ x: a * q.x + c * q.y + e, y: b * q.x + d * q.y + f, on: q.on })));
        more = !!(flags & 0x20);
      }
      return out;
    }
    const ends = Array.from({ length: n }, (_, i) => dv.getUint16(at + 10 + 2 * i));
    const count = n ? ends[n - 1] + 1 : 0;
    let p = at + 10 + 2 * n;
    p += 2 + dv.getUint16(p);                                               // the instructions
    const fl = [];
    while (fl.length < count) {
      const f = dv.getUint8(p++);
      fl.push(f);
      if (f & 8) for (let r = dv.getUint8(p++); r > 0; r--) fl.push(f);
    }
    const coord = (short, same) => {
      let v = 0;
      return fl.map((f) => {
        if (f & short) { const d = dv.getUint8(p++); v += f & same ? d : -d; } else if (!(f & same)) { v += dv.getInt16(p); p += 2; }
        return v;
      });
    };
    const xs = coord(2, 16), ys = coord(4, 32);
    const out = [];
    for (let i = 0, s = 0; i < n; s = ends[i] + 1, i++) out.push(Array.from({ length: ends[i] + 1 - s }, (_, k) => ({ x: xs[s + k], y: ys[s + k], on: !!(fl[s + k] & 1) })));
    return out;
  };

  /**
   * The character `code` at `ppem` pixels an em, as GGO_NATIVE gives it: { contours: [{ start, curves:
   * [{ spline, pts }] }], cellIncX, blackBoxX, blackBoxY, originX, originY } — points [x, y] in pixels
   * (y up, to 1/64), a curve TT_PRIM_LINE or a TT_PRIM_QSPLINE whose points are its off-curve ones and,
   * last, its end; the metrics in whole pixels, as GLYPHMETRICS. Wine's get_native_glyph_outline:
   * a run of points of one kind is one curve, a spline ends on the next point on the curve (the contour's
   * start, at its end); a contour of one point is left out.
   */
  const glyph = (code, ppem) => {
    const g = map(code), s = ppem / em, px = (q) => [Math.round(q.x * s * 64) / 64, Math.round(q.y * s * 64) / 64];
    const out = [];
    for (let pts of contours(g)) {
      if (pts.length < 2) continue;
      // A contour that starts off the curve starts at its last point if that is on it, else between the two.
      if (!pts[0].on) {
        const last = pts[pts.length - 1];
        pts = last.on ? [last, ...pts.slice(0, -1)] : [{ x: (last.x + pts[0].x) / 2, y: (last.y + pts[0].y) / 2, on: true }, ...pts];
      }
      const curves = [];
      for (let i = 1; i < pts.length;) {
        const spline = !pts[i].on, c = [];
        do c.push(px(pts[i++])); while (i < pts.length && pts[i].on === pts[i - 1].on);
        if (i >= pts.length && !pts[i - 1].on) c.push(px(pts[0]));
        else if (spline && i < pts.length) c.push(px(pts[i++]));
        curves.push({ spline, pts: c });
      }
      out.push({ start: px(pts[0]), curves });
    }
    // the black box: the control points' bounds, to whole pixels
    const all = out.flatMap((c) => [c.start, ...c.curves.flatMap((cv) => cv.pts)]);
    const [x0, x1, y0, y1] = all.length ? [Math.floor(Math.min(...all.map((q) => q[0]))), Math.ceil(Math.max(...all.map((q) => q[0]))),
      Math.floor(Math.min(...all.map((q) => q[1]))), Math.ceil(Math.max(...all.map((q) => q[1])))] : [0, 0, 0, 0];
    return { contours: out, cellIncX: Math.round(advance(g) * s), blackBoxX: x1 - x0, blackBoxY: y1 - y0, originX: x0, originY: y1 };
  };
  return { em, winAscent, winDescent, glyph };
}

/** GDI's pixels an em for a LOGFONT height `h` > 0, the cell height (Wine's calc_ppem_for_height). */
export function ppemForHeight(font, h) {
  return Math.round(font.em * h / (font.winAscent + font.winDescent));
}
