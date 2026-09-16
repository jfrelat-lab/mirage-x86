// snapshot.mjs — rewind a running Machine, in memory, inside one process.
//
//   import { capture, restore, verify } from './tools/snapshot.mjs';
//   const snap = capture(mc);          // once, after replaying to the interesting window
//   ...probe...
//   restore(mc, snap);                 // back to that instant, in milliseconds
//
// WHY, and why this shape. Every probe against a long workload replays the same hundreds of
// thousands of blocks before reaching the part under investigation — `win /r` spends 90-150 s
// getting to block 435000, and a session that asks fifteen questions pays that fifteen times. The
// fix is not a portable savestate: serialising to disk would mean handling closures (intHandlers,
// portRead, devices are functions), file handles and format compatibility, for a need nobody has.
// What IS needed is a rewind within one process, so only DATA has to be copied and behaviour can
// stay where it is.
//
// Two decisions follow from that, and both matter:
//
//   * Restore writes back IN PLACE, never by replacing objects. Closures all over the engine hold
//     references to `dos`, `vfs`, `mem` and friends; handing them a new object would leave them
//     driving the old one. In place also preserves aliasing for free — mem.u8 and mem.dv are two
//     views over ONE ArrayBuffer, so restoring u8 restores what dv sees.
//   * The walk is GENERIC rather than a hand-written list of fields. A list is wrong the day someone
//     adds a field, and wrong silently: the restored run diverges with no sign. Walking every
//     reachable data property captures new state automatically.
//
// The recompiler is deliberately excluded and reset instead. Its cache is compiled functions keyed by
// guest address; it is derived state, so dropping it is always correct — only slower.
//
// ⚠️ ONE THING THIS CANNOT SEE: state held in a closure variable rather than on an object. Nothing
// in src/ does that today (dos.js keeps everything on `dos`), but nothing prevents it either. That is
// exactly why `verify()` exists and why it should be run before believing any measurement built on a
// restore — a rewind that silently loses state is the most expensive kind of lying instrument.

const SKIP_KEYS = new Set([
  'rec',          // the recompiler: derived state, reset on restore
  'dv',           // a DataView over mem.buffer; restoring mem.u8 covers it
  'buffer',       // the ArrayBuffer itself, ditto
  'machine', 'mc', // back-references, reached through the roots anyway
]);

/** A deep copy of the DATA reachable from `mc`, ignoring functions and derived caches. */
export function capture(mc) {
  const seen = new Map();
  const skipped = [];
  const data = cloneValue(mc, seen, skipped, 'mc', 0);
  return { data, skipped, blocks: 0 };
}

function cloneValue(v, seen, skipped, path, depth) {
  if (v === null || typeof v !== 'object') {
    return typeof v === 'function' ? undefined : v;      // functions are behaviour, not state
  }
  if (depth > 24) { skipped.push(`${path}: profondeur > 24`); return undefined; }
  if (seen.has(v)) return { __ref: seen.get(v) };
  const id = seen.size;
  seen.set(v, id);

  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return undefined;
    return { __id: id, __typed: v.constructor.name, data: v.slice() };
  }
  if (v instanceof ArrayBuffer) return undefined;
  if (v instanceof Map) {
    const out = { __id: id, __map: [] };
    for (const [k, val] of v) out.__map.push([cloneValue(k, seen, skipped, path + '<k>', depth + 1),
      cloneValue(val, seen, skipped, path + '<v>', depth + 1)]);
    return out;
  }
  if (v instanceof Set) {
    const out = { __id: id, __set: [] };
    for (const val of v) out.__set.push(cloneValue(val, seen, skipped, path + '<s>', depth + 1));
    return out;
  }
  if (Array.isArray(v)) {
    const out = { __id: id, __arr: [] };
    for (let i = 0; i < v.length; i++) out.__arr.push(cloneValue(v[i], seen, skipped, `${path}[${i}]`, depth + 1));
    return out;
  }
  const out = { __id: id, __obj: {} };
  for (const k of Object.keys(v)) {
    if (SKIP_KEYS.has(k)) continue;
    const child = v[k];
    if (typeof child === 'function') continue;
    out.__obj[k] = cloneValue(child, seen, skipped, `${path}.${k}`, depth + 1);
  }
  return out;
}

/** Write a capture back into the SAME objects the engine is already holding. */
export function restore(mc, snap) {
  restoreValue(mc, snap.data, new Map());
  if (mc.rec && mc.rec.reset) mc.rec.reset();            // derived state: rebuild rather than restore
  if (mc.mem && mc.rec && mc.rec.setMask) mc.rec.setMask(mc.mem.mask);
}

function restoreValue(target, src, byId) {
  if (src === undefined || src === null || typeof src !== 'object') return;
  if (src.__ref !== undefined) return;                   // a shared object, already restored at its
                                                         // first occurrence — the target still points
                                                         // at the same instance, so nothing to do
  if (src.__id !== undefined) byId.set(src.__id, target);

  if (src.__typed !== undefined) {
    if (ArrayBuffer.isView(target) && target.length === src.data.length) target.set(src.data);
    return;
  }
  if (src.__map !== undefined) {
    if (!(target instanceof Map)) return;
    target.clear();
    for (const [k, v] of src.__map) target.set(plain(k, byId), plain(v, byId));
    return;
  }
  if (src.__set !== undefined) {
    if (!(target instanceof Set)) return;
    target.clear();
    for (const v of src.__set) target.add(plain(v, byId));
    return;
  }
  if (src.__arr !== undefined) {
    if (!Array.isArray(target)) return;
    target.length = src.__arr.length;
    for (let i = 0; i < src.__arr.length; i++) {
      const s = src.__arr[i];
      if (s !== null && typeof s === 'object' && s.__id !== undefined && target[i] && typeof target[i] === 'object') {
        restoreValue(target[i], s, byId);
      } else target[i] = plain(s, byId);
    }
    return;
  }
  if (src.__obj !== undefined) {
    for (const k of Object.keys(src.__obj)) {
      const s = src.__obj[k];
      const cur = target[k];
      if (s !== null && typeof s === 'object' && s.__id !== undefined && cur && typeof cur === 'object') {
        restoreValue(cur, s, byId);                      // recurse into the live object
      } else if (s === null || typeof s !== 'object') {
        target[k] = s;                                   // a primitive
      } else if (s.__ref === undefined) {
        target[k] = plain(s, byId);                      // the live side has nothing to write into
      }
    }
  }
}

/** Rebuild a captured value as a fresh object (used where the target has nothing to write into). */
function plain(s, byId) {
  if (s === null || typeof s !== 'object') return s;
  if (s.__ref !== undefined) return byId.get(s.__ref);
  if (s.__typed !== undefined) return s.data.slice();
  if (s.__map !== undefined) { const m = new Map(); byId.set(s.__id, m); for (const [k, v] of s.__map) m.set(plain(k, byId), plain(v, byId)); return m; }
  if (s.__set !== undefined) { const t = new Set(); byId.set(s.__id, t); for (const v of s.__set) t.add(plain(v, byId)); return t; }
  if (s.__arr !== undefined) { const a = []; byId.set(s.__id, a); for (const v of s.__arr) a.push(plain(v, byId)); return a; }
  const o = {}; byId.set(s.__id, o);
  for (const k of Object.keys(s.__obj)) o[k] = plain(s.__obj[k], byId);
  return o;
}

/** A cheap fingerprint of everything a run can observably change. */
export function signature(mc) {
  const cpu = mc.cpu;
  let h = 0x811c9dc5;
  const mix = (x) => { h = (Math.imul(h ^ (x >>> 0), 0x01000193)) >>> 0; };
  for (let i = 0; i < cpu.reg.length; i++) mix(cpu.reg[i]);
  for (let i = 0; i < cpu.seg.length; i++) { mix(cpu.seg[i]); mix(cpu.base[i]); }
  mix(cpu.eip); mix(cpu.flags); mix(cpu.cr0 | 0); mix(cpu.halted ? 1 : 0);
  const u = mc.mem.u8, n = Math.min(u.length, 1 << 20);
  for (let i = 0; i < n; i += 61) mix(u[i]);             // a stride, not every byte: this runs on
                                                         // every verification step and must stay cheap
  return h >>> 0;
}

/**
 * Prove the rewind before anything is built on it: capture, run K blocks and fingerprint, restore,
 * run the SAME K blocks, and compare. A mismatch means state was missed — report it, never shrug.
 *
 * The control matters as much as the check: it also confirms the fingerprint MOVES over those K
 * blocks. A signature that never changes would make any capture look perfect.
 */
export function verify(mc, blocks = 20000) {
  const before = signature(mc);
  const snap = capture(mc);
  for (let i = 0; i < blocks; i++) mc.runSlice(1);
  const after = signature(mc);
  restore(mc, snap);
  const restored = signature(mc);
  for (let i = 0; i < blocks; i++) mc.runSlice(1);
  const again = signature(mc);
  return {
    ok: restored === before && again === after && after !== before,
    moved: after !== before,                             // the control: K blocks changed something
    restoredExact: restored === before,                  // the capture round-trips
    replayMatches: again === after,                      // and the engine takes the same path again
    skipped: snap.skipped,
    detail: `before=${hex(before)} after${blocks}=${hex(after)} restored=${hex(restored)} replayed=${hex(again)}`,
  };
}

const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
