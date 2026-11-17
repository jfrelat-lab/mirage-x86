/**
 * MIRAGE-WIN32 -- GDI regions as sets of rectangles.
 *
 * A region is kept as Windows keeps one: rectangles that do not overlap, in bands from the top, each
 * band's rectangles from the left, joined when they touch. Combining two regions cuts the plane along
 * every edge of both and keeps the cells the operation keeps -- few rectangles in the programs of the
 * period (Storm, the library of Diablo and StarCraft, paints its dialogs through the rectangles of a
 * window's update region, GetRegionData's RGNDATA).
 *
 * Not kept: the clipping a region would make when selected into a DC (src/win32/classic.js).
 */

const NULLREGION = 1, SIMPLEREGION = 2, COMPLEXREGION = 3, ERROR = 0;

/** The rectangles of a region of `rects` cut along every edge, [l, t, r, b] each (right and bottom out). */
function normalize(cells) {
  // Rows of cells with the same top and bottom: each row's runs joined left to right, then rows that
  // have the same runs and touch joined top to bottom.
  const rows = new Map();
  for (const c of cells) { const k = `${c[1]},${c[3]}`; if (!rows.has(k)) rows.set(k, []); rows.get(k).push(c); }
  const bands = [];
  for (const row of rows.values()) {
    row.sort((a, b) => a[0] - b[0]);
    const runs = [];
    for (const c of row) { const last = runs[runs.length - 1]; if (last && last[2] === c[0]) last[2] = c[2]; else runs.push([...c]); }
    bands.push(runs);
  }
  bands.sort((a, b) => a[0][1] - b[0][1]);
  const out = [];
  for (const runs of bands) {
    const prev = out.length ? out.filter((r) => r[3] === runs[0][1]) : [];
    const same = prev.length === runs.length && prev.every((p, i) => p[0] === runs[i][0] && p[2] === runs[i][2]);
    if (same) for (const p of prev) p[3] = runs[0][3]; else out.push(...runs);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** `a` op `b` (RGN_AND 1, RGN_OR 2, RGN_XOR 3, RGN_DIFF 4, RGN_COPY 5): the rectangles of the result. */
export function combine(a, b, op) {
  if (op === 5) return a.map((r) => [...r]);
  const xs = [...new Set([...a, ...b].flatMap((r) => [r[0], r[2]]))].sort((p, q) => p - q);
  const ys = [...new Set([...a, ...b].flatMap((r) => [r[1], r[3]]))].sort((p, q) => p - q);
  const inside = (rs, x, y) => rs.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3]);
  const keep = [null, (p, q) => p && q, (p, q) => p || q, (p, q) => p !== q, (p, q) => p && !q][op];
  if (!keep) return null;
  const cells = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
    if (keep(inside(a, xs[i], ys[j]), inside(b, xs[i], ys[j]))) cells.push([xs[i], ys[j], xs[i + 1], ys[j + 1]]);
  }
  return normalize(cells);
}

/** Edges [top point, bottom point, direction] filled (ALTERNATE 1, WINDING 2): the region's rectangles. */
export function polyRects(edges, mode) {
  if (!edges.length) return [];
  const y0 = Math.min(...edges.map((e) => e[0][1])), y1 = Math.max(...edges.map((e) => e[1][1])), cells = [];
  for (let y = y0; y < y1; y++) {
    const cy = y + 0.5, xs = [];
    for (const [a, b, d] of edges) if (cy >= a[1] && cy < b[1]) xs.push([a[0] + (b[0] - a[0]) * (cy - a[1]) / (b[1] - a[1]), d]);
    xs.sort((p, q) => p[0] - q[0]);
    let w = 0;
    for (let i = 0; i + 1 < xs.length; i++) {
      w = mode === 2 ? w + xs[i][1] : w ^ 1;
      if (w) { const l = Math.ceil(xs[i][0] - 0.5), r = Math.ceil(xs[i + 1][0] - 0.5); if (r > l) cells.push([l, y, r, y + 1]); }
    }
  }
  return normalize(cells);
}

const rect = (l, t, r, b) => (r > l && b > t ? [[l, t, r, b]] : []);
const kind = (rs) => (!rs.length ? NULLREGION : rs.length === 1 ? SIMPLEREGION : COMPLEXREGION);
const box = (rs) => (rs.length ? [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))] : [0, 0, 0, 0]);

/** gdi32's region calls on `st.gdi` handles of kind 'region' ({ rects }). `updateRects(hwnd)`: the part
 *  of a window waiting to be painted, rectangles [l, t, r, b] in its client area (none: nothing waits). */
export function regionApis(st, updateRects = () => []) {
  const rgn = (h) => { const o = st.gdi.get(h); return o && o.kind === 'region' ? o : null; };
  const make = (rs) => st.newHandle('region', { rects: rs });
  const i32 = (v) => v | 0;
  const rd = (x, p) => [i32(x.r32(p)), i32(x.r32(p + 4)), i32(x.r32(p + 8)), i32(x.r32(p + 12))];
  const gdi32 = {
    CreateRectRgn: ['iiii', (x, l, t, r, b) => make(rect(l, t, r, b))],
    // CreatePolyPolygonRgn(points, counts, n, mode): the polygons filled scanline by scanline, a pixel in
    // when its centre is (ALTERNATE 1: an odd number of edges to its left; WINDING 2: a non-zero sum).
    // Winamp 2's skins shape the main window so (region.txt).
    CreatePolyPolygonRgn: ['ppii', (x, pts, cnts, n, mode) => {
      const edges = [];
      for (let k = 0, at = pts; k < n; k++) {
        const c = x.r32(cnts + 4 * k), p = [];
        for (let i = 0; i < c; i++, at += 8) p.push([i32(x.r32(at)), i32(x.r32(at + 4))]);
        for (let i = 0; i < c; i++) { const a = p[i], b = p[(i + 1) % c]; if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a, b, 1] : [b, a, -1]); }
      }
      return make(polyRects(edges, mode));
    }],
    CreatePolygonRgn: ['pii', (x, pts, c, mode) => {
      const p = []; for (let i = 0; i < c; i++) p.push([i32(x.r32(pts + 8 * i)), i32(x.r32(pts + 8 * i + 4))]);
      const edges = [];
      for (let i = 0; i < c; i++) { const a = p[i], b = p[(i + 1) % c]; if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a, b, 1] : [b, a, -1]); }
      return make(polyRects(edges, mode));
    }],
    CreateRectRgnIndirect: ['p', (x, p) => make(rect(...rd(x, p)))],
    SetRectRgn: ['piiii', (x, h, l, t, r, b) => { const o = rgn(h); if (!o) return 0; o.rects = rect(l, t, r, b); return 1; }],
    // CombineRgn(dest, a, b, op): the kind of the result, ERROR when a handle is not a region.
    CombineRgn: ['pppi', (x, d, ha, hb, op) => {
      const o = rgn(d), a = rgn(ha), b = op === 5 ? { rects: [] } : rgn(hb);
      if (!o || !a || !b) return ERROR;
      const rs = combine(a.rects, b.rects, op); if (!rs) return ERROR;
      o.rects = rs; return kind(rs);
    }],
    OffsetRgn: ['pii', (x, h, dx, dy) => { const o = rgn(h); if (!o) return ERROR; o.rects = o.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]); return kind(o.rects); }],
    GetRgnBox: ['pp', (x, h, p) => { const o = rgn(h); if (!o) return ERROR; box(o.rects).forEach((v, i) => x.w32(p + 4 * i, v)); return kind(o.rects); }],
    PtInRegion: ['pii', (x, h, X, Y) => { const o = rgn(h); return o && o.rects.some((r) => X >= r[0] && X < r[2] && Y >= r[1] && Y < r[3]) ? 1 : 0; }],
    RectInRegion: ['pp', (x, h, p) => { const o = rgn(h), [l, t, r, b] = rd(x, p); return o && o.rects.some((q) => q[0] < r && l < q[2] && q[1] < b && t < q[3]) ? 1 : 0; }],
    EqualRgn: ['pp', (x, ha, hb) => { const a = rgn(ha), b = rgn(hb); return a && b && JSON.stringify(a.rects) === JSON.stringify(b.rects) ? 1 : 0; }],
    // GetRegionData(h, size, buf): RGNDATAHEADER (dwSize 32, iType RDH_RECTANGLES 1, nCount, nRgnSize,
    // rcBound) then the rectangles; the size it needs when `buf` is null or `size` too small.
    GetRegionData: ['pup', (x, h, size, buf) => {
      const o = rgn(h); if (!o) return 0;
      const need = 32 + 16 * o.rects.length;
      if (!buf || size < need) return need;
      x.w32(buf, 32); x.w32(buf + 4, 1); x.w32(buf + 8, o.rects.length); x.w32(buf + 12, 16 * o.rects.length);
      box(o.rects).forEach((v, i) => x.w32(buf + 16 + 4 * i, v));
      o.rects.forEach((r, k) => r.forEach((v, i) => x.w32(buf + 32 + 16 * k + 4 * i, v)));
      return need;
    }],
  };
  const user32 = {
    // GetUpdateRgn(hwnd, h, erase): the window's update region into `h`.
    GetUpdateRgn: ['ppi', (x, hwnd, h) => { const o = rgn(h); if (!o) return ERROR; o.rects = updateRects(hwnd); return kind(o.rects); }],
  };
  return { gdi32, user32 };
}
