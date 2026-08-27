// moo.mjs — reader for the MOO v1 binary test format used by SingleStepTests/80386.
//
// The 8088 vectors conformance.js already runs are JSON; the 386 set is a chunked binary instead
// (github.com/dbalsom/moo). Layout: a `MOO ` header chunk, then one `TEST` chunk per case, each
// holding nested chunks. Every chunk is a 4-byte ASCII id, a uint32 little-endian length, then that
// many bytes of payload — so an unknown chunk is skipped rather than fatal, which is the point of
// the format.
//
// Registers come as a bitmask plus one value per set bit, in a FIXED order. A test states its
// initial registers in full and its final ones only where they changed, so `final` is a delta over
// `initial` — comparing a register the test does not mention is comparing against the input.

const RG16 = ['ax', 'bx', 'cx', 'dx', 'cs', 'ss', 'ds', 'es', 'sp', 'bp', 'si', 'di', 'ip', 'flags'];
const RG32 = ['cr0', 'cr3', 'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp',
  'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eip', 'eflags', 'dr6', 'dr7'];

const id = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);

/** Walk the chunks in [start, end), calling fn(type, payloadStart, payloadEnd). */
function chunks(b, start, end, fn) {
  let o = start;
  while (o + 8 <= end) {
    const t = id(b, o), len = u32(b, o + 4);
    const p = o + 8;
    if (p + len > end) break;                       // truncated tail: stop rather than misread
    fn(t, p, p + len);
    o = p + len;
  }
}

const regs = (b, p, names, width) => {
  const wide = width === 4;
  const mask = wide ? u32(b, p) : u16(b, p);
  let o = p + (wide ? 4 : 2);
  const out = {};
  for (let i = 0; i < names.length; i++) {
    if (!(mask & (1 << i))) continue;
    out[names[i]] = wide ? u32(b, o) : u16(b, o);
    o += width;
  }
  return out;
};

const ram = (b, p) => {
  const n = u32(b, p);
  const out = [];
  for (let i = 0, o = p + 4; i < n; i++, o += 5) out.push([u32(b, o), b[o + 4]]);
  return out;
};

/** Parse one state container (INIT or FINA) into { regs, regs32, ram, masks }. */
function state(b, s, e) {
  const st = { regs: {}, regs32: {}, ram: [], mask: {}, mask32: {} };
  chunks(b, s, e, (t, p) => {
    if (t === 'REGS') Object.assign(st.regs, regs(b, p, RG16, 2));
    else if (t === 'RG32') Object.assign(st.regs32, regs(b, p, RG32, 4));
    else if (t === 'RMSK') Object.assign(st.mask, regs(b, p, RG16, 2));
    else if (t === 'RM32') Object.assign(st.mask32, regs(b, p, RG32, 4));
    else if (t === 'RAM ') st.ram = ram(b, p);
  });
  return st;
}

/** Parse a whole .MOO buffer. Returns { cpu, count, tests: [...] }. */
export function parseMOO(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (id(b, 0) !== 'MOO ') throw new Error('pas un fichier MOO');
  const hdrLen = u32(b, 4);
  const out = { major: b[8], minor: b[9], count: u32(b, 12), cpu: id(b, 16).trim(), tests: [] };
  chunks(b, 8 + hdrLen, b.length, (t, s, e) => {
    if (t !== 'TEST') return;
    // The TEST payload opens with a uint32 index, then the nested chunks.
    const test = { index: u32(b, s), name: '', bytes: null, initial: null, final: null, exception: null };
    chunks(b, s + 4, e, (tt, p, pe) => {
      if (tt === 'NAME') test.name = String.fromCharCode(...b.subarray(p + 4, p + 4 + u32(b, p)));
      else if (tt === 'BYTS') test.bytes = Array.from(b.subarray(p + 4, p + 4 + u32(b, p)));
      else if (tt === 'INIT') test.initial = state(b, p, pe);
      else if (tt === 'FINA') test.final = state(b, p, pe);
      else if (tt === 'EXCP') test.exception = Array.from(b.subarray(p, pe));
    });
    out.tests.push(test);
  });
  return out;
}
