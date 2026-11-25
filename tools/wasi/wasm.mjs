// wasm.mjs — a small WebAssembly assembler, for the WASI test programs (tools/wasi/programs.mjs).
//
//   module({ imports: [['wasi_snapshot_preview1', 'fd_write', ['i32','i32','i32','i32'], ['i32']], ...],
//            memory: 1, data: [[1024, 'hello\n'], ...],
//            funcs: [{ name: '_start', params: [], results: [], locals: ['i32'], export: true, body: (o) => [...] }] })
//
// A body is the bytes of its instructions, from the helpers in `o`: o.i32(5), o.call('fd_write'),
// o.get(0), o.load(), o.loop(...), and the plain opcodes (o.drop, o.add, ...). No validation beyond the
// engine's: WebAssembly.Module refuses a wrong one.

const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const uleb = (n) => { const b = []; n = BigInt(n); do { let x = Number(n & 0x7fn); n >>= 7n; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const sleb = (n) => {
  const b = []; n = BigInt(n);
  for (;;) { const x = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(x & 0x40)) || (n === -1n && (x & 0x40))) { b.push(x); return b; } b.push(x | 0x80); }
};
const str = (s) => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, bytes) => (bytes.length ? [id, ...uleb(bytes.length), ...bytes] : []);

export function module({ imports = [], funcs = [], memory = 1, data = [] }) {
  const types = [], typeOf = (p, r) => {
    const t = [0x60, ...vec(p.map((x) => [T[x]])), ...vec(r.map((x) => [T[x]]))], k = JSON.stringify(t);
    let i = types.findIndex((x) => JSON.stringify(x) === k); if (i < 0) { types.push(t); i = types.length - 1; } return i;
  };
  const index = new Map();
  imports.forEach(([, name], i) => index.set(name, i));
  funcs.forEach((f, i) => index.set(f.name, imports.length + i));
  const o = ops(index);
  const imp = imports.map(([m, n, p, r]) => [...str(m), ...str(n), 0x00, ...uleb(typeOf(p, r))]);
  const fsec = funcs.map((f) => uleb(typeOf(f.params || [], f.results || [])));
  const exps = [...str('memory'), 0x02, 0x00];
  const exports = [exps, ...funcs.filter((f) => f.export).map((f) => [...str(f.name), 0x00, ...uleb(index.get(f.name))])];
  const code = funcs.map((f) => {
    const locals = (f.locals || []).map((t) => [1, T[t]]);
    const body = [...vec(locals), ...f.body(o).flat(Infinity), 0x0b];
    return [...uleb(body.length), ...body];
  });
  const dat = data.map(([at, bytes]) => {
    const b = typeof bytes === 'string' ? [...new TextEncoder().encode(bytes)] : [...bytes];
    return [0x00, 0x41, ...sleb(at), 0x0b, ...uleb(b.length), ...b];
  });
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec(types)), ...section(2, vec(imp)), ...section(3, vec(fsec)),
    ...section(5, vec([[0x00, ...uleb(memory)]])), ...section(7, vec(exports)),
    ...section(10, vec(code)), ...section(11, vec(dat))]);
}

/** The instructions. Blocks take their body as arrays: o.block(...), o.loop(...), o.if(...). */
export function ops(index) {
  const mem = (op) => (off = 0, align = 2) => [op, align, ...uleb(off)];
  return {
    i32: (n) => [0x41, ...sleb(n)], i64: (n) => [0x42, ...sleb(n)],
    get: (i) => [0x20, ...uleb(i)], set: (i) => [0x21, ...uleb(i)], tee: (i) => [0x22, ...uleb(i)],
    call: (name) => { if (!index.has(name)) throw new Error('wasm.mjs: no function ' + name); return [0x10, ...uleb(index.get(name))]; },
    load: mem(0x28), load8: (off = 0) => [0x2d, 0, ...uleb(off)], load64: (off = 0) => [0x29, 3, ...uleb(off)],
    store: mem(0x36), store8: (off = 0) => [0x3a, 0, ...uleb(off)], store64: (off = 0) => [0x37, 3, ...uleb(off)],
    block: (...b) => [0x02, 0x40, ...b, 0x0b], loop: (...b) => [0x03, 0x40, ...b, 0x0b],
    if: (...b) => [0x04, 0x40, ...b, 0x0b], else: 0x05,
    br: (d) => [0x0c, ...uleb(d)], brIf: (d) => [0x0d, ...uleb(d)],
    drop: 0x1a, ret: 0x0f, unreachable: 0x00,
    eqz: 0x45, eq: 0x46, ne: 0x47, ltu: 0x49, gtu: 0x4b, add: 0x6a, sub: 0x6b, mul: 0x6c, divu: 0x6e, remu: 0x70,
    wrap: 0xa7, extu: 0xad, add64: 0x7c, divu64: 0x80, remu64: 0x82, eqz64: 0x50,
  };
}
