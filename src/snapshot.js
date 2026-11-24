// snapshot.js — a running machine kept and taken back: what a program computed (a demo's precalculation,
// a game's loading, a Python that has started) saved once and resumed at once, in place of running
// it again.
//
// What is kept is the machine's data, not its code: every object reachable from the Machine — the CPU's
// registers, the memory's buffer, each device's state, MIRAGE-LINUX's processes and files — copied as
// a graph (shared objects stay shared, cycles are kept). Functions are not kept: a snapshot is taken
// back into a machine built afresh the same way (the same image, the same options), whose installers
// made the same closures; the data is then written INTO that machine's own objects, so every closure
// that holds one of them sees the restored state. An object made while the machine ran is made again.
//
// Two things cannot be made again and are reported rather than lost: a function, or an object of a
// class this module does not know, that exists in the snapshot where the fresh machine has none
// (`restore` throws with its path). And state a module keeps in a closure's own variable (a `let` of
// an installer) is invisible here: such a module keeps it on an object instead -- tools/snapcheck.mjs
// finds them, running a machine on from its snapshot beside the machine that was not interrupted.
//
// Not kept (made again or rebuilt): the recompiler's translations (machine.rec), the memory's record
// of translated pages, the page-table caches; whatever a key in SKIP names.

const TYPED = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray, BigInt64Array, BigUint64Array };

/** Keys never kept, on any object: derived caches and the host's things (canvas, audio, workers). */
const SKIP = new Set(['rec', 'codePage', 'onError', 'canvas', 'ctx', 'audioCtx', 'worker', 'port', 'snapHooks']);
/** Classes whose instances are walked like plain objects (registered by name, recreated with their
 *  prototype). Machine, CPU, Memory and the like are always reached at the same path in a fresh
 *  machine, so only those a program can make while it runs need to be here to be made again. */
const CLASSES = new Map();
export function snapshotClass(cls) { CLASSES.set(cls.name, cls); }

const isPlain = (o) => { const p = Object.getPrototypeOf(o); return p === Object.prototype || p === null; };
const walkable = (o) => isPlain(o) || Array.isArray(o) || CLASSES.has(o.constructor && o.constructor.name) || o.__snapshot === true;
const kindOf = (o) => (Array.isArray(o) ? 'a' : o instanceof Map ? 'm' : o instanceof Set ? 's' : o instanceof ArrayBuffer ? 'b'
  : ArrayBuffer.isView(o) ? (o instanceof DataView ? 'dv' : 't') : 'o');

/**
 * The machine's data as a graph of plain values: { root, nodes } where nodes[i] is one object kept
 * ({ k: kind, c: class, f: fields } -- a field a number, string, boolean, null, undefined, a bigint, or
 * { r: i } a reference). Structured-cloneable (IndexedDB keeps it as it is; Node's v8.serialize too).
 */
export function snapshot(root, { skip = [] } = {}) {
  const skipKeys = new Set([...SKIP, ...skip]);
  const ids = new Map(), nodes = [];
  const ref = (v, path) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') return { fn: 1 };
      if (typeof v === 'symbol') return { fn: 1 };
      return v;
    }
    if (ids.has(v)) return { r: ids.get(v) };
    const k = kindOf(v);
    if (k === 'o' && !walkable(v)) return { op: v.constructor ? v.constructor.name : '?' };   // opaque: the fresh machine's own
    const id = nodes.length; ids.set(v, id);
    const n = { k }; nodes.push(n);
    if (k === 'b') n.d = v.slice(0);
    else if (k === 't' || k === 'dv') { n.c = k === 't' ? v.constructor.name : 'DataView'; n.b = ref(v.buffer, path + '.buffer'); n.o = v.byteOffset; n.n = k === 't' ? v.length : v.byteLength; }
    else if (k === 'm') n.f = [...v].map(([a, b], i) => [ref(a, path + '.key' + i), ref(b, path + '[' + String(a) + ']')]);
    else if (k === 's') n.f = [...v].map((a, i) => ref(a, path + '.item' + i));
    else if (k === 'a') { n.f = new Array(v.length); for (let i = 0; i < v.length; i++) n.f[i] = ref(v[i], path + '[' + i + ']'); }
    else {
      if (!isPlain(v)) n.c = v.constructor.name;
      n.f = {};
      for (const key of Object.keys(v)) {
        if (skipKeys.has(key)) continue;
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || d.get || d.set) continue;                                  // an accessor: derived
        n.f[key] = ref(v[key], path + '.' + key);
      }
    }
    return { r: id };
  };
  const r = ref(root, 'machine');
  return { v: 1, root: r.r, nodes };
}

/**
 * Write a snapshot into `root`, a machine built afresh as the snapshot's was. Objects the fresh machine
 * has at the same place are filled in place; others are made. Throws when a function or an opaque
 * object would be needed where the fresh machine has none.
 */
export function restore(root, snap, { skip = [] } = {}) {
  const skipKeys = new Set([...SKIP, ...skip]);
  const { nodes } = snap, made = new Map(), claimed = new Set();
  const compatible = (n, t) => {
    if (t === null || typeof t !== 'object' || claimed.has(t)) return false;
    const k = kindOf(t);
    if (k !== n.k) return false;
    if (k === 't') return t.constructor.name === n.c;
    if (k === 'o') return walkable(t) && (n.c || 'Object') === (isPlain(t) ? 'Object' : t.constructor.name);
    return true;
  };
  // The value for field `f` where the fresh machine has `cur` (at `path`).
  const value = (f, cur, path) => {
    if (f === null || typeof f !== 'object') return f;
    if (f.fn) { if (typeof cur === 'function' || typeof cur === 'symbol') return cur; throw new Error(`snapshot: ${path} is a function made at run time`); }
    if (f.op) { if (cur && typeof cur === 'object' && cur.constructor && cur.constructor.name === f.op) return cur; throw new Error(`snapshot: ${path} is a ${f.op} made at run time`); }
    return node(f.r, cur, path);
  };
  const node = (id, cur, path) => {
    if (made.has(id)) return made.get(id);
    const n = nodes[id];
    let t = compatible(n, cur) ? cur : null;
    if (n.k === 'b') {
      if (!t || t.byteLength !== n.d.byteLength) t = n.d.slice(0);
      else new Uint8Array(t).set(new Uint8Array(n.d));
      made.set(id, t); claimed.add(t); return t;
    }
    if (n.k === 't' || n.k === 'dv') {
      const buf = node(n.b.r, t ? t.buffer : undefined, path + '.buffer');
      if (!t || t.buffer !== buf || t.byteOffset !== n.o) t = n.k === 't' ? new TYPED[n.c](buf, n.o, n.n) : new DataView(buf, n.o, n.n);
      made.set(id, t); claimed.add(t); return t;
    }
    if (n.k === 'm') {
      if (!t) t = new Map();
      made.set(id, t); claimed.add(t);
      const old = new Map(t); t.clear();
      for (const [a, b] of n.f) { const key = value(a, undefined, path + '.key'); t.set(key, value(b, old.get(key), path + '[' + String(key) + ']')); }
      return t;
    }
    if (n.k === 's') {
      if (!t) t = new Set();
      made.set(id, t); claimed.add(t); t.clear();
      for (const a of n.f) t.add(value(a, undefined, path + '.item'));
      return t;
    }
    if (n.k === 'a') {
      if (!t) t = [];
      made.set(id, t); claimed.add(t);
      const old = t.slice(); t.length = n.f.length;
      for (let i = 0; i < n.f.length; i++) t[i] = value(n.f[i], old[i], path + '[' + i + ']');
      return t;
    }
    if (!t) {
      if (n.c && !CLASSES.has(n.c)) throw new Error(`snapshot: ${path} is a ${n.c} made at run time (snapshotClass it)`);
      t = n.c ? Object.create(CLASSES.get(n.c).prototype) : {};
    }
    made.set(id, t); claimed.add(t);
    for (const key of Object.keys(n.f)) {
      const d = Object.getOwnPropertyDescriptor(t, key);
      if (d && (d.get || d.set)) continue;
      t[key] = value(n.f[key], t[key], path + '.' + key);
    }
    // A data field the fresh machine has and the snapshot had not: set since, by a run, lazily.
    for (const key of Object.keys(t)) {
      if (key in n.f || skipKeys.has(key)) continue;
      const d = Object.getOwnPropertyDescriptor(t, key);
      if (!d || d.get || d.set || typeof t[key] === 'function') continue;
      delete t[key];
    }
    return t;
  };
  node(snap.root, root, 'machine');
}

/** Snapshot a Machine, and take one back into a machine built afresh: the derived state rebuilt. */
/**
 * A module whose state lives in its closure's own variables declares it here instead of moving it:
 * `snapHook(machine, 'vga-dac', () => ({ dacW, dacR }), (o) => { ({ dacW, dacR } = o); })`. `save`
 * returns plain data (kept with the snapshot), `load` takes it back after the restore.
 */
export function snapHook(machine, name, save, load) {
  if (!machine.snapHooks) machine.snapHooks = new Map();
  machine.snapHooks.set(name, { save, load });
}

const machineClasses = (mc, extra = {}) => { for (const o of [mc, mc.cpu, mc.mem, mc.dos && mc.dos.vfs, ...Object.values(extra)]) if (o) snapshotClass(o.constructor); };
// The graph's root: the Machine, or { machine, ...with } when the host keeps objects of its own beside
// it (the DOS player's shell: what runs, the prompt).
const rootOf = (mc, w) => (w ? { machine: mc, ...w } : mc);
export function saveMachine(mc, opts = {}) {
  machineClasses(mc, opts.with);
  const snap = snapshot(rootOf(mc, opts.with), opts);
  snap.wall = mc.wallClockMs ? mc.wallClockMs() : null;                 // the machine's wall clock, to go on from
  snap.hooks = {};
  if (mc.snapHooks) for (const [name, h] of mc.snapHooks) snap.hooks[name] = h.save();
  return snap;
}
export function loadMachine(mc, snap, opts = {}) {
  machineClasses(mc, opts.with);
  restore(rootOf(mc, opts.with), snap, opts);
  // The wall clock went on from where it was kept: a page's performance.now() starts at 0 each visit.
  if (snap.wall != null && mc.wallClockMs && 'wallOffset' in mc) mc.wallOffset += snap.wall - mc.wallClockMs();
  for (const [name, data] of Object.entries(snap.hooks || {})) {
    const h = mc.snapHooks && mc.snapHooks.get(name);
    if (!h) throw new Error(`snapshot: the machine has no ${name} to take its state back`);
    h.load(data);
  }
  forgetTranslations(mc);
}

/**
 * What a restored machine has not: its translations, the record of translated pages, the page-table
 * caches -- rebuilt from the state. A machine that only forgets them (tools/snapcheck.mjs's control)
 * then runs as a restored one does: MIRAGE's clock moves a block at a time, so a program that reads
 * the timer while it runs sees other values once its blocks are made again, snapshot or not.
 */
export function forgetTranslations(mc) {
  if (mc.mem.codePage) mc.mem.codePage.fill(0);
  if (mc.mem.rebuildPageTables) mc.mem.rebuildPageTables();
  if (mc.rec) {
    // What the recompiler knows besides its translations, learned from events a restore does not
    // replay: the address mask (A20 opened: setMask) and the paged strategy (paging turned on).
    mc.rec.MM = mc.mem.mask;
    if (mc.cpu.pagingOn) mc.rec.memStrategy = { read: 'paged', write: 'paged' };
    mc.rec.reset();                                                      // nothing translated yet, paged or not as the CPU now is
  }
  if (mc.cpu.setCR3 && mc.cpu.cr0 & 0x80000000) mc.cpu.setCR3(mc.cpu.cr3);
}

/** What a snapshot leaves to the fresh machine: the paths of the opaque objects it met (a class this
 *  module does not walk), for tools/snapcheck.mjs to tell what may be missing. */
export function opaquePaths(root) {
  if (root.cpu && root.mem) machineClasses(root);
  const seen = new Set(), out = [];
  const walk = (v, path, depth) => {
    if (v === null || typeof v !== 'object' || seen.has(v) || depth > 12) return;
    seen.add(v);
    const k = kindOf(v);
    if (k === 'o' && !walkable(v)) { out.push(`${path}: ${v.constructor ? v.constructor.name : '?'}`); return; }
    if (k === 'b' || k === 't' || k === 'dv') return;
    if (k === 'm') { for (const [a, b] of v) walk(b, path + '[' + String(a) + ']', depth + 1); return; }
    if (k === 's') return;
    for (const key of Object.keys(v)) if (!SKIP.has(key)) { const d = Object.getOwnPropertyDescriptor(v, key); if (d && !d.get) walk(v[key], path + '.' + key, depth + 1); }
  };
  walk(root, 'machine', 0);
  return out;
}

// ---- a snapshot as bytes: kept in the browser (Cache Storage) or a file ------------------------------
// The graph as JSON, its buffers after it, the whole gzipped (CompressionStream, in pages and Node
// alike): a DOS machine's 45 MiB, mostly zeros, keep in about a megabyte. JSON alone would lose what a
// field may hold -- undefined, NaN, the infinities, -0, a bigint -- so those are spelled out.
const MAGIC = 'MIRAGE-SNAPSHOT 1\n';
const enc = (v) => {
  if (v === undefined) return { u: 1 };
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? { n: '-0' } : v) : { n: String(v) };
  if (typeof v === 'bigint') return { big: String(v) };
  return v;
};
const dec = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.u === 1 && Object.keys(v).length === 1) return undefined;
    if ('n' in v && Object.keys(v).length === 1) return v.n === '-0' ? -0 : Number(v.n);
    if ('big' in v && Object.keys(v).length === 1) return BigInt(v.big);
  }
  return v;
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** A snapshot (saveMachine's) as gzipped bytes, with `meta` (what it is of: the image, MIRAGE's version). */
export async function packSnapshot(snap, meta = {}) {
  const bufs = [];
  const nodes = snap.nodes.map((n) => {
    const o = { ...n };
    if (n.k === 'b') { o.d = bufs.length; bufs.push(new Uint8Array(n.d)); }
    else if (n.k === 'o') { o.f = {}; for (const k of Object.keys(n.f)) o.f[k] = enc(n.f[k]); }
    else if (n.k === 'a' || n.k === 's') o.f = n.f.map(enc);
    else if (n.k === 'm') o.f = n.f.map(([a, b]) => [enc(a), enc(b)]);
    return o;
  });
  const head = new TextEncoder().encode(MAGIC + JSON.stringify({ meta, root: snap.root, hooks: snap.hooks || {}, wall: snap.wall ?? null, nodes, sizes: bufs.map((b) => b.length) }) + '\n');
  const total = head.length + bufs.reduce((s, b) => s + b.length, 0), all = new Uint8Array(total);
  all.set(head, 0); let at = head.length;
  for (const b of bufs) { all.set(b, at); at += b.length; }
  return pipe(all, new CompressionStream('gzip'));
}

/** Back from packSnapshot's bytes: { snap, meta }. */
export async function unpackSnapshot(bytes) {
  const all = await pipe(bytes, new DecompressionStream('gzip'));
  let nl = MAGIC.length; while (all[nl] !== 10) nl++;
  const td = new TextDecoder();
  if (td.decode(all.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('snapshot: not a MIRAGE snapshot');
  const h = JSON.parse(td.decode(all.subarray(MAGIC.length, nl)));
  let at = nl + 1;
  const bufs = h.sizes.map((n) => { const b = all.slice(at, at + n).buffer; at += n; return b; });
  const nodes = h.nodes.map((n) => {
    const o = { ...n };
    if (n.k === 'b') o.d = bufs[n.d];
    else if (n.k === 'o') { o.f = {}; for (const k of Object.keys(n.f)) o.f[k] = dec(n.f[k]); }
    else if (n.k === 'a' || n.k === 's') o.f = n.f.map(dec);
    else if (n.k === 'm') o.f = n.f.map(([a, b]) => [dec(a), dec(b)]);
    return o;
  });
  return { snap: { v: 1, root: h.root, hooks: h.hooks, wall: h.wall, nodes }, meta: h.meta };
}
