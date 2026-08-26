// derailcheck.mjs — a derail detector that SELF-TESTS before it is believed.
//
//   node tools/derailcheck.mjs [DIR] [EXE]        # default HERETIC/HERETIC.EXE
//
// It first runs a .COM built to derail (`jmp far 4000:0000` into zeroed memory) and refuses to
// report on the real target unless that fired. A detector nobody has seen fire proves nothing when
// it stays silent — three readings of Heretic in a row were wrong without it.
//
// The rule this exists to enforce: a detector nobody has seen fire proves nothing when it stays
// silent. Three readings in a row were wrong here because the address arithmetic assumed real mode
// (linear = seg*16 + off) while the guest was in protected mode, where CS is a SELECTOR and the
// linear address is base(CS) + EIP. So the detector reports BOTH, plus the bytes actually fetched,
// and refuses to run on a target until it has fired on a case built to make it fire.
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeMachine } from '/Users/julienfrelat/Projects/mirage/tools/harness.mjs';
import { VFS } from '/Users/julienfrelat/Projects/mirage/src/vfs.js';
import { walk } from '/Users/julienfrelat/Projects/mirage/tools/corpus.mjs';

const h = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');

/** One block-start observation, with every address expressed both ways. */
function observe(mc) {
  const cpu = mc.cpu, pe = cpu.cr0 & 1;
  const sel = cpu.seg[1] & 0xffff, eip = cpu.eip >>> 0;
  const lin = ((cpu.base[1] >>> 0) + eip) >>> 0;          // the address the CPU actually fetches from
  const rm = ((sel << 4) + (eip & 0xffff)) >>> 0;          // what it WOULD be if this were real mode
  const u = mc.mem.u8, m = lin & 0xfffff;
  const bytes = [0, 1, 2, 3].map((i) => u[(m + i) & 0xfffff]);
  return { pe, sel, eip, lin, rm, bytes, zero: bytes.every((b) => b === 0) };
}
const fmt = (o) => `PE=${o.pe} ${h(o.sel)}:${h(o.eip, 8)} lin=${h(o.lin, 6)}${o.pe ? '' : ' (=rm)'} ` +
  `octets=[${o.bytes.map((b) => h(b, 2)).join(' ')}]${o.zero ? '  <<< NULS' : ''}`;

function run({ dir, exe, image, tail = '', budgetMs = 25000, ringSize = 30 }) {
  const vfs = new VFS();
  if (dir) for (const rel of walk(dir)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
  vfs.chdir('\\');
  const { mc, dos } = makeMachine({ vfs, memSize: 32 << 20 });
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(image || new Uint8Array(readFileSync(join(dir, exe))), tail, 'C:\\' + (exe || 'T.COM'));
  const ring = [];
  let hit = null, n = 0;
  const t0 = Date.now();
  while (n++ < 5_000_000 && !dos.programDone && !fault && Date.now() - t0 < budgetMs) {
    const o = observe(mc);
    if (o.zero) { hit = o; break; }
    ring.push(o);
    if (ring.length > ringSize) ring.shift();
    mc.runSlice(1);
  }
  return { hit, ring, fault, dos, mc, n, done: dos.programDone };
}

// ---- SELF-TEST: a .COM that far-jumps into a zeroed segment. The detector MUST fire. ----
const probe = new Uint8Array([0xea, 0x00, 0x00, 0x00, 0x40]);   // jmp far 4000:0000
const t = run({ image: probe, exe: 'T.COM', budgetMs: 5000 });
if (!t.hit) { console.log('AUTO-TEST ECHOUE: le detecteur ne se declenche pas sur un saut vers du vide — ne rien croire de ce qui suit.'); process.exit(1); }
console.log('auto-test OK — le detecteur se declenche:', fmt(t.hit));
console.log();

// ---- the real target ----
const target = process.argv[2] || 'HERETIC', exe = process.argv[3] || 'HERETIC.EXE';
const r = run({ dir: join('/Users/julienfrelat/Projects/mirage/games', target), exe });
console.log(`${target}: ${r.done ? 'termine ' + r.dos.exitCode : (r.fault ? 'FAULT' : 'en cours')} apres ${r.n} blocs`);
if (r.fault) console.log('  ' + r.fault.message.slice(0, 160));
if (r.hit) {
  console.log('PREMIER BLOC SUR DES OCTETS NULS:', fmt(r.hit));
  console.log('--- les 30 blocs precedents ---');
  for (const o of r.ring) console.log('  ' + fmt(o));
} else {
  console.log('aucun bloc n execute d octets nuls — le derail n est PAS "executer du vide".');
  console.log('--- les 30 derniers blocs ---');
  for (const o of r.ring) console.log('  ' + fmt(o));
}
