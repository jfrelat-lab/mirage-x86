// memdispatch.mjs — which memory-dispatch shape is actually fastest IN JAVASCRIPT?
//
// DOSBox's page table is one implementation in C. The costs that make it good there (pointer
// arithmetic is free, a predictable branch is ~1 cycle) are not the costs here, and JS has options
// C does not: out-of-bounds typed-array reads return `undefined` instead of faulting, and property
// loads are markedly more expensive than local variable reads. So measure the candidates rather than
// port the C one on faith.
//
// Every variant answers the same question — "read a byte of guest memory, routing A0000-AFFFF to a
// device when a planar mode is active" — over the same address stream, and returns a checksum so
// nothing can be optimised away.
//
// CAVEAT, stated up front: these are tight loops, so V8 can hoist the `m.planar` property load out
// of variant A in a way it cannot in a real emitted block (which contains calls). That FLATTERS the
// current design. If a table still wins here, it wins for real.

const MB = 16 << 20, MASK = 0xfffff;
const u8 = new Uint8Array(MB);
for (let i = 0; i < MB; i++) u8[i] = i & 0xff;

const m = { planar: true, vga: { readByte: (a) => u8[a] }, rb: (a) => u8[a] };

// Address stream: runs of sequential access (how real code walks buffers) punctuated by jumps,
// all inside the low 1 MB, none in A0000-AFFFF so every variant takes its fast path.
const DEVPCT = Number(process.env.DEVPCT || 0);   // % of accesses that hit a device page
const N = 1 << 16;
const addr = new Int32Array(N);
{
  let a = 0x10000, seed = 12345;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if ((seed & 31) === 0) a = 0x10000 + (seed & 0xffff);   // jump — same 64 KB span as the device window
    addr[i] = a; a = (a + 1) & MASK;
    if (addr[i] >= 0xa0000 && addr[i] < 0xb0000) addr[i] -= 0x30000;
    // Deliberately steer some accesses INTO the device window: variant D loads unconditionally and
    // tests the loaded value, so it is the one that could deoptimise when `undefined` shows up often.
    if (DEVPCT && (seed % 100) < DEVPCT) addr[i] = 0xa0000 + (seed & 0xffff);
  }
}

const PAGES = MB >>> 12;
// Biased offsets, DOSBox-style: RD[p] = base - (p<<12), so `u8[RD[p] + a]` needs no offset mask.
// Identity mapping makes that 0 for plain RAM; -1 marks a device page.
const RD = new Int32Array(PAGES);
for (let p = 0; p < PAGES; p++) RD[p] = (p >= 0xa0 && p < 0xb0) ? -1 : 0;
// Bank + mask: separate attribute and base tables.
const ATTR = new Uint8Array(PAGES), BASE = new Int32Array(PAGES);
for (let p = 0; p < PAGES; p++) { ATTR[p] = (p >= 0xa0 && p < 0xb0) ? 1 : 0; BASE[p] = p << 12; }
// Out-of-range sentinel: a device page is mapped past the end of the array, so the READ ITSELF
// reports it as `undefined`. No C analogue — an out-of-bounds pointer there is undefined behaviour.
const OOR = new Int32Array(PAGES);
for (let p = 0; p < PAGES; p++) OOR[p] = (p >= 0xa0 && p < 0xb0) ? MB : 0;

const variants = {
  'A today: planar test + &MM': () => {
    let s = 0;
    for (let i = 0; i < N; i++) { const a = addr[i]; s += (m.planar && (a >>> 16) === 10) ? m.vga.readByte(a) : u8[a & MASK]; }
    return s;
  },
  'B biased table (DOSBox)': () => {
    let s = 0;
    for (let i = 0; i < N; i++) { const a = addr[i], o = RD[a >>> 12]; s += o >= 0 ? u8[o + a] : m.rb(a); }
    return s;
  },
  'C bank+mask (attr+base)': () => {
    let s = 0;
    for (let i = 0; i < N; i++) { const a = addr[i], p = a >>> 12; s += ATTR[p] === 0 ? u8[BASE[p] | (a & 0xfff)] : m.rb(a); }
    return s;
  },
  'D out-of-range sentinel': () => {
    let s = 0;
    for (let i = 0; i < N; i++) { const a = addr[i], v = u8[OOR[a >>> 12] + a]; s += v !== undefined ? v : m.rb(a); }
    return s;
  },
  'E unconditional u8[a]': () => {           // the ceiling: what "reads never test" would cost
    let s = 0;
    for (let i = 0; i < N; i++) s += u8[addr[i]];
    return s;
  },
  'F biased table, hoisted': () => {         // same as B but the table is a local, not a property
    let s = 0; const T = RD, U = u8;
    for (let i = 0; i < N; i++) { const a = addr[i], o = T[a >>> 12]; s += o >= 0 ? U[o + a] : m.rb(a); }
    return s;
  },
};

const names = Object.keys(variants);
for (const n of names) for (let i = 0; i < 50; i++) variants[n]();      // warm up every variant

const times = Object.fromEntries(names.map((n) => [n, []]));
const sums = {};
for (let round = 0; round < 25; round++) {
  for (const n of names) {                                              // alternate: controls for drift
    const t = process.hrtime.bigint();
    sums[n] = variants[n]();
    times[n].push(Number(process.hrtime.bigint() - t) / 1e6);
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const base = med(times[names[0]]);
console.log(`${N.toLocaleString()} reads per round, ${DEVPCT}% into the device window, 25 rounds, median\n`);
console.log('  variant                        ms      vs today   ns/access');
for (const n of names) {
  const t = med(times[n]);
  console.log(`  ${n.padEnd(28)} ${t.toFixed(3).padStart(7)}   ${((t / base) * 100).toFixed(0).padStart(6)}%   ` +
    `${((t * 1e6) / N).toFixed(2).padStart(7)}`);
}
const bad = names.filter((n) => sums[n] !== sums[names[0]]);
console.log(bad.length ? `\n  ⚠️  DIFFERENT CHECKSUMS: ${bad.join(', ')} — not comparing the same work` : '\n  all variants agree on the checksum');
