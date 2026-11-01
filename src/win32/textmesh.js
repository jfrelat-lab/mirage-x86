// textmesh.js — D3DXCreateText's mesh, as Wine's d3dx9_36/mesh.c makes it (the oracle: no Microsoft
// code): each glyph's outline, its curves cut until they stray less than `deviation` from the spline,
// its points marked corners or smooth; the glyph's face triangulated by a sweep from right to left into
// monotone polygons; then the sides (a quad an outline segment, two normals at a corner) and the back
// (z = 0) and front (z = -extrusion) faces. Units are the em: GDI's outline at a cell height of one em,
// divided by it.

const CURVE = 0, CORNER = 1, CURVE_START = 2, CURVE_END = 3, CURVE_MIDDLE = 4;
const COS_HALF = Math.cos(0.5 * Math.PI / 180), COS_45 = Math.cos(Math.PI / 4), COS_90 = Math.cos(Math.PI / 2);

const unit = (a, b) => { const x = b.x - a.x, y = b.y - a.y, l = Math.hypot(x, y); return l ? { x: x / l, y: y / l } : { x: 0, y: 0 }; };
const similar = (a, b, cos) => a.x * b.x + a.y * b.y > cos;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// An outline is { items, count }: Wine's dynamic array, whose items past `count` are still there to read.
const add = (ol, p, corner) => { ol.items[ol.count++] = { x: p.x, y: p.y, corner }; };

function addBezier(ol, p1, p2, p3, maxDev2) {
  const s1 = mid(p1, p2), s2 = mid(p2, p3), m = mid(s1, s2);
  if ((m.x - p2.x) ** 2 + (m.y - p2.y) ** 2 < maxDev2) add(ol, p2, CURVE);
  else { addBezier(ol, p1, s1, m, maxDev2); addBezier(ol, m, s2, p3, maxDev2); }
}

// attempt_line_merge: the point at `i` dropped (the outline's last) when the line on to `next` goes on as the one into it.
function lineMerge(ol, i, next, toCurve) {
  const pt = ol.items[i], prev = ol.items[(i - 1 + ol.count) % ol.count];
  if (toCurve) pt.corner = pt.corner !== CORNER ? CURVE_MIDDLE : CURVE_START;
  if (ol.count < 2) return false;
  if (!similar(unit(prev, pt), unit(pt, next), COS_HALF)) return false;
  ol.count--;
  if (pt.corner === CURVE_END) prev.corner = pt.corner;
  if (prev.corner === CURVE_END && toCurve) prev.corner = CURVE_MIDDLE;
  return true;
}

// create_outline: GGO_NATIVE's contours (pixels) as outlines in ems.
function createOutlines(contours, em, maxDev2) {
  const outlines = [], P = ([x, y]) => ({ x: x / em, y: y / em });
  for (const c of contours) {
    const ol = { items: [], count: 0 };
    outlines.push(ol);
    add(ol, P(c.start), CORNER);
    for (const cv of c.curves) {
      if (!cv.pts.length) continue;
      const pts = cv.pts.map(P), toCurve = cv.spline && pts.length > 1;
      let start = { x: ol.items[ol.count - 1].x, y: ol.items[ol.count - 1].y };
      lineMerge(ol, ol.count - 1, pts[0], toCurve);
      if (toCurve) {
        let j = 0;
        for (let n = pts.length; n > 2; n--, j++) { const end = mid(pts[j], pts[j + 1]); addBezier(ol, start, pts[j], end, maxDev2); start = end; }
        addBezier(ol, start, pts[j], pts[j + 1], maxDev2);
        add(ol, pts[j + 1], CURVE_END);
      } else for (const p of pts) add(ol, p, CORNER);
    }
    if (ol.count >= 3) {
      const pt = ol.items[0], last = ol.items[ol.count - 1];
      if (pt.x === last.x && pt.y === last.y) {
        if (last.corner === CURVE_END) pt.corner = pt.corner === CURVE_START ? CURVE_MIDDLE : CURVE_END;
        ol.count--;
      } else lineMerge(ol, ol.count - 1, pt, false);
      const first = ol.items[0], toCurve = first.corner !== CORNER && first.corner !== CURVE_END;
      if (first.corner === CURVE_START) first.corner = CORNER;
      if (lineMerge(ol, 0, ol.items[1], toCurve)) ol.items[0] = { ...ol.items[ol.count] };
    }
    let pt = ol.items[0], lastDir = unit(ol.items[ol.count - 1], pt);
    for (let j = 0; j < ol.count; j++) {
      const lastPt = pt;
      pt = ol.items[(j + 1) % ol.count];
      const dir = unit(lastPt, pt);
      if (lastPt.corner === CURVE_START || lastPt.corner === CURVE_END) { if (!similar(lastDir, dir, COS_45)) lastPt.corner = CORNER; }
      else if (lastPt.corner === CURVE_MIDDLE) lastPt.corner = similar(lastDir, dir, COS_90) ? CURVE : CORNER;
      lastDir = dir;
    }
  }
  return outlines;
}

const yDist = (a, b, p) => p.y - (a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x));

// triangulate: the glyph's faces, over its ordered vertices (indices into `ordered`, Wine's ordered_vertices).
function triangulate(outlines) {
  const ordered = [], faces = [];
  for (const ol of outlines) { ordered.push({ ol, v: 0 }); for (let j = ol.count - 1; j > 0; j--) ordered.push({ ol, v: j }); }
  const glyph = { outlines, ordered, faces };
  if (!outlines.length) return glyph;
  // Native seems to make a fan from the first point when a glyph has one outline (Wine's note).
  if (outlines.length === 1) {
    const ol = outlines[0], base = ol.items[0];
    let last = ol.items[1], ccw = 0;
    for (let i = 2; i < ol.count; i++) {
      const next = ol.items[i], v1 = { x: base.x - last.x, y: base.y - last.y }, v2 = { x: last.x - next.x, y: last.y - next.y };
      ccw = v1.x * v2.y - v1.y * v2.x;
      if (ccw > 0) break;
      last = next;
    }
    if (ccw <= 0) { for (let i = 0; i < ol.count - 2; i++) faces.push([0, i + 1, i + 2]); return glyph; }
  }
  ordered.sort((a, b) => {
    const p = a.ol.items[a.v], q = b.ol.items[b.v];
    let d = p.x - q.x;
    if (d === 0) d = p.y - q.y;
    return d === 0 ? 0 : d > 0 ? -1 : 1;
  });
  const ov = (i) => ordered[i].ol.items[ordered[i].v];
  const T = [];                                                       // the triangulations: { stack, lastOnTop, merging }
  const next = (t, onTop) => {
    const pi = ordered[t.stack[t.lastOnTop === onTop ? t.stack.length - 1 : 0]], n = pi.ol.count;
    return pi.ol.items[onTop ? (pi.v + n - 1) % n : (pi.v + 1) % n];
  };
  const addPoint = (ti, vtx, toTop) => {
    const t = T[ti], [f1, f2] = t.lastOnTop ? [1, 2] : [2, 1];
    if (t.lastOnTop !== toTop && t.stack.length > 1) {
      let last = t.stack[0];
      for (let i = 1; i < t.stack.length; i++) { const f = [vtx, 0, 0]; f[f1] = last; f[f2] = last = t.stack[i]; faces.push(f); }
      t.stack = [last];
    } else if (t.stack.length > 1) {
      let i = t.stack.length - 1, topIdx = t.stack[i--], topPt = ov(topIdx);
      const point = ov(vtx);
      while (i >= 0) {
        const prevIdx = t.stack[i--], prevPt = ov(prevIdx);
        if (prevPt.x !== topPt.x && ((toTop && yDist(prevPt, topPt, point) > 0) || (!toTop && yDist(prevPt, topPt, point) < 0))) break;
        const f = [vtx, 0, 0]; f[f1] = prevIdx; f[f2] = topIdx; faces.push(f);
        topPt = prevPt; topIdx = prevIdx; t.stack.pop();
      }
    }
    t.lastOnTop = toTop;
    t.stack.push(vtx);
    if (!t.merging) return ti;
    let t2 = toTop ? ti - 1 : ti + 1;
    T[t2].merging = false;
    t2 = addPoint(t2, vtx, toTop);
    T.splice(ti, 1);
    return t2 > ti ? t2 - 1 : t2;
  };
  for (let sweep = 0; sweep < ordered.length; sweep++) {
    let start = 0, end = T.length;
    while (start < end) {
      const sv = ov(sweep), cur = (start + end) >> 1;
      let ti = cur, onTop = false;
      const topNext = T[ti].merging && T[ti].lastOnTop ? next(T[ti + 1], true) : next(T[ti], true);
      if (sv === topNext) {
        if (T[ti].merging && T[ti].lastOnTop) ti++;
        ti = addPoint(ti, sweep, true);
        if (ti + 1 < T.length && next(T[ti + 1], false) === sv) {
          const t2 = addPoint(ti + 1, sweep, false);                   // also on the bottom of the triangulation above
          T[ti].merging = true; T[t2].merging = true;
        }
        onTop = true;
      }
      const bottomNext = T[ti].merging && !T[ti].lastOnTop ? next(T[ti - 1], false) : next(T[ti], false);
      if (sv === bottomNext) {
        if (T[ti].merging && !T[ti].lastOnTop) ti--;
        if (onTop) { T.splice(ti, 1); break; }                          // the outline is finished
        ti = addPoint(ti, sweep, false);
        if (ti > 0 && next(T[ti - 1], true) === sv) {
          const t2 = addPoint(ti - 1, sweep, true);                    // also on the top of the triangulation below
          ti = t2 + 1;
          T[ti].merging = true; T[t2].merging = true;
        }
        break;
      }
      if (onTop) break;
      const t = T[ti], s = t.stack;
      const [topIdx, bottomIdx] = t.lastOnTop ? [s[s.length - 1], s[0]] : [s[0], s[s.length - 1]];
      if (yDist(ov(topIdx), topNext, sv) > 0) start = cur + 1;          // above
      else if (yDist(ov(bottomIdx), bottomNext, sv) < 0) end = cur;     // below
      else if (t.merging) {                                             // inside: the merge is off
        const t2 = t.lastOnTop ? ti + 1 : ti - 1;
        t.merging = false; T[t2].merging = false;
        addPoint(ti, sweep, t.lastOnTop);                               // no merge left: the indices stay
        addPoint(t2, sweep, T[t2].lastOnTop);
        break;
      } else {                                                          // inside: split into two monotone parts
        const t2 = { stack: [s[s.length - 1], sweep], lastOnTop: !t.lastOnTop, merging: false };
        if (t.lastOnTop) T.splice(ti + 1, 0, t2); else { T.splice(ti, 0, t2); ti++; }
        addPoint(ti, sweep, t.lastOnTop);
        break;
      }
    }
    if (start >= end) T.splice(start, 0, { stack: [sweep], lastOnTop: false, merging: false });
  }
  return glyph;
}

/**
 * The mesh of `text` (a string) in `font` (truetype.js), `deviation` and `extrusion` in ems (0: one
 * em-square unit, flat): { verts: Float32Array (x y z nx ny nz each), faces: Uint16Array, nVerts, nFaces,
 * metrics: [{ blackBoxX, ..., cellIncX }] }, or null for a text with no outline at all.
 */
export function textMesh(font, ppem, text, deviation, extrusion) {
  const em = font.em;
  if (deviation === 0) deviation = 1 / em;
  const maxDev2 = deviation * deviation, glyphs = [], metrics = [];
  let offsetX = 0, any = false;
  for (const ch of text) {
    const gm = font.glyph(ch.codePointAt(0), ppem);
    if (gm.contours.length) any = true;
    const g = triangulate(createOutlines(gm.contours, em, maxDev2));
    g.offsetX = offsetX;
    glyphs.push(g);
    metrics.push({ blackBoxX: gm.blackBoxX / em, blackBoxY: gm.blackBoxY / em, originX: gm.originX / em, originY: gm.originY / em, cellIncX: gm.cellIncX / em });
    offsetX += gm.cellIncX / em;
  }
  if (!any) return null;
  let corners = 0, points = 0, front = 0;
  for (const g of glyphs) {
    points += g.ordered.length; front += g.faces.length;
    for (const ol of g.outlines) { corners++; for (let k = 1; k < ol.count; k++) if (ol.items[k].corner) corners++; }
  }
  const nVerts = (points + corners) * 2 + points * 2, nFaces = points * 2 + front * 2;
  const V = new Float32Array(6 * nVerts), F = new Uint16Array(3 * nFaces);
  let vi = 0, fi = 0;
  const vtx = (x, y, z, nx, ny, nz) => { V.set([x, y, z, nx, ny, nz], 6 * vi++); };
  const face = (a, b, c) => { F.set([a, b, c], 3 * fi++); };
  const [f1, f2] = extrusion === 0 ? [1, 2] : [2, 1];
  const z = -extrusion;
  for (const g of glyphs) {
    // the sides
    for (const ol of g.outlines) {
      const first = vi;
      let prev = ol.items[ol.count - 1], pt = ol.items[0];
      for (let k = 1; k <= ol.count; k++) {
        const nx = ol.items[k % ol.count], idx = vi;
        let d = pt.corner === CURVE_START ? unit(prev, pt) : pt.corner ? unit(pt, nx) : unit(prev, nx);
        vtx(pt.x + g.offsetX, pt.y, 0, -d.y, d.x, 0);
        vtx(pt.x + g.offsetX, pt.y, z, -d.y, d.x, 0);
        if (pt.corner && nx.corner && nx.corner !== CURVE_END) {
          vtx(nx.x + g.offsetX, nx.y, z, -d.y, d.x, 0);
          vtx(nx.x + g.offsetX, nx.y, 0, -d.y, d.x, 0);
          face(idx, idx + 2, idx + 1); face(idx, idx + 3, idx + 2);
        } else {
          if (nx.corner) {
            d = nx.corner === CURVE_END ? unit(nx, ol.items[(k + 1) % ol.count]) : unit(pt, nx);
            vtx(nx.x + g.offsetX, nx.y, 0, -d.y, d.x, 0);
            vtx(nx.x + g.offsetX, nx.y, z, -d.y, d.x, 0);
          }
          face(idx, idx + 3, idx + 1); face(idx, idx + 2, idx + 3);
        }
        prev = pt; pt = nx;
      }
      if (!pt.corner) { V.copyWithin(6 * vi, 6 * first, 6 * (first + 2)); vi += 2; }
    }
    // the back, then the front
    const back = vi, backFaces = fi;
    for (let j = 0; j < g.ordered.length; j++) { const p = g.ordered[j].ol.items[g.ordered[j].v]; vtx(p.x + g.offsetX, p.y, 0, 0, 0, 1); }
    for (const f of g.faces) face(f[0] + back, f[1] + back, f[2] + back);
    const n = vi - back;
    for (let j = 0; j < n; j++) vtx(V[6 * (back + j)], V[6 * (back + j) + 1], z, 0, 0, extrusion === 0 ? 1 : -1);
    for (let j = backFaces, e = fi; j < e; j++) { const b = [F[3 * j], F[3 * j + 1], F[3 * j + 2]]; face(b[0] + n, b[f1] + n, b[f2] + n); }
  }
  return { verts: V, faces: F, nVerts, nFaces, metrics };
}
