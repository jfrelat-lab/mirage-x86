// memems.mjs — does the conclusion survive adding EMS?
//
// tools/memdispatch.mjs asked one question: how cheaply can we DETECT a device region. The page
// table lost, because detection is all it was doing. EMS is a different kind of mapping — a page
// frame is ordinary RAM that has been RELOCATED, so it needs address translation, not a handler
// call. Today's design cannot express that at all: it would need a second range test on every
// access, and a third for the next feature. The biased-offset table does relocation for free —
// `u8[ofs[p] + a]` is the same code whether the page is where it looks or somewhere else.
//
// So this measures the cost of each shape as MAPPED FEATURES ACCUMULATE, which is the question
// "et si on ajoute EMS ?" actually asks.
//
//   FEATURES=0..3 node memems.mjs      # 0 = VGA only, 1 = +EMS, 2 = +UMB remap, 3 = +ROM shadow

const MB = 16 << 20, MASK = 0xfffff;
const u8 = new Uint8Array(MB);
for (let i = 0; i < MB; i++) u8[i] = i & 0xff;
const m = { planar: true, vga: { readByte: (a) => u8[a] }, rb: (a) => u8[a] };

const FEATURES = Number(process.env.FEATURES || 1);
const N = 1 << 16;

// Windows, all 64 KB, all inside the low 1 MB — VGA at A000 (a real device: handler),
// EMS page frame at E000, a remapped UMB at D000, a shadowed ROM at C000 (relocated RAM).
const WIN = { vga: 0xa0, ems: 0xe0, umb: 0xd0, rom: 0xc0 };
// Where the relocated windows actually live in physical memory.
const emsPhys = 0x400, umbPhys = 0x500, romPhys = 0x600;   // page numbers

const addr = new Int32Array(N);
{
  let a = 0x10000, seed = 12345;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if ((seed & 31) === 0) a = 0x10000 + (seed & 0xffff);
    addr[i] = a; a = (a + 1) & MASK;
    const r = seed % 100;
    // A realistic mix: mostly ordinary RAM, a little VGA, and real traffic through each mapped
    // window that is enabled — EMS exists to be used, so it must appear in the stream.
    if (r < 2) addr[i] = (WIN.vga << 12) + (seed & 0xffff);
    else if (FEATURES >= 1 && r < 12) addr[i] = (WIN.ems << 12) + (seed & 0xffff);
    else if (FEATURES >= 2 && r < 16) addr[i] = (WIN.umb << 12) + (seed & 0xffff);
    else if (FEATURES >= 3 && r < 20) addr[i] = (WIN.rom << 12) + (seed & 0xffff);
  }
}

// Today's shape, extended honestly: one range test per mapped feature, in series.
const emsBase = new Int32Array(16), umbBase = new Int32Array(16), romBase = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  emsBase[i] = (emsPhys + ((i * 7) & 15)) << 12;   // scrambled, as a real EMS map would be
  umbBase[i] = (umbPhys + i) << 12;
  romBase[i] = (romPhys + i) << 12;
}

// The table: one entry per page, biased so `u8[ofs[a>>>12] + a]` lands in the right place.
const PAGES = MB >>> 12;
const OFS = new Int32Array(PAGES);
for (let p = 0; p < PAGES; p++) OFS[p] = 0;
for (let p = WIN.vga; p < WIN.vga + 16; p++) OFS[p] = -1;                                  // device
if (FEATURES >= 1) for (let i = 0; i < 16; i++) OFS[WIN.ems + i] = emsBase[i] - ((WIN.ems + i) << 12);
if (FEATURES >= 2) for (let i = 0; i < 16; i++) OFS[WIN.umb + i] = umbBase[i] - ((WIN.umb + i) << 12);
if (FEATURES >= 3) for (let i = 0; i < 16; i++) OFS[WIN.rom + i] = romBase[i] - ((WIN.rom + i) << 12);

// Variant A must be written as the real code WOULD be for each feature set — no dead `FEATURES >= n`
// guards, which an earlier version left in and which made A look 2.3x slower even with no features
// enabled, contradicting tools/memdispatch.mjs. Build it per level instead.
const A_LEVELS = [
  () => { let s = 0; for (let i = 0; i < N; i++) { const a = addr[i];
    s += (m.planar && (a >>> 16) === 10) ? m.vga.readByte(a) : u8[a & MASK]; } return s; },
  () => { let s = 0; for (let i = 0; i < N; i++) { const a = addr[i], hi = a >>> 16;
    s += (m.planar && hi === 10) ? m.vga.readByte(a)
       : hi === 14 ? u8[emsBase[(a >>> 12) & 15] + (a & 0xfff)] : u8[a & MASK]; } return s; },
  () => { let s = 0; for (let i = 0; i < N; i++) { const a = addr[i], hi = a >>> 16;
    s += (m.planar && hi === 10) ? m.vga.readByte(a)
       : hi === 14 ? u8[emsBase[(a >>> 12) & 15] + (a & 0xfff)]
       : hi === 13 ? u8[umbBase[(a >>> 12) & 15] + (a & 0xfff)] : u8[a & MASK]; } return s; },
  () => { let s = 0; for (let i = 0; i < N; i++) { const a = addr[i], hi = a >>> 16;
    s += (m.planar && hi === 10) ? m.vga.readByte(a)
       : hi === 14 ? u8[emsBase[(a >>> 12) & 15] + (a & 0xfff)]
       : hi === 13 ? u8[umbBase[(a >>> 12) & 15] + (a & 0xfff)]
       : hi === 12 ? u8[romBase[(a >>> 12) & 15] + (a & 0xfff)] : u8[a & MASK]; } return s; },
];

const variants = {
  "A today's shape, specialised per feature set": A_LEVELS[FEATURES],
  'B biased table, one shape for all': () => {
    let s = 0; const T = OFS, U = u8;
    for (let i = 0; i < N; i++) { const a = addr[i], o = T[a >>> 12]; s += o >= 0 ? U[o + a] : m.rb(a); }
    return s;
  },
};

const names = Object.keys(variants);
for (const n of names) for (let i = 0; i < 50; i++) variants[n]();
const times = Object.fromEntries(names.map((n) => [n, []])), sums = {};
for (let r = 0; r < 25; r++) for (const n of names) {
  const t = process.hrtime.bigint(); sums[n] = variants[n](); times[n].push(Number(process.hrtime.bigint() - t) / 1e6);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const label = ['VGA only', '+EMS', '+EMS +UMB', '+EMS +UMB +ROM'][FEATURES];
console.log(`mapped features: ${label}`);
for (const n of names) console.log(`  ${n.padEnd(40)} ${((med(times[n]) * 1e6) / N).toFixed(2).padStart(6)} ns/access`);
const bad = names.filter((n) => sums[n] !== sums[names[0]]);
console.log(bad.length ? `  ⚠️ CHECKSUM MISMATCH: ${bad.join(', ')}` : '  checksums agree');
