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
import { bootSector } from '/Users/julienfrelat/Projects/mirage/src/boot.js';

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
  `bytes=[${o.bytes.map((b) => h(b, 2)).join(' ')}]${o.zero ? '  <<< ZEROES' : ''}`;

function run({ dir, exe, image, boot, tail = '', budgetMs = 25000, ringSize = 30, warm }) {
  let mc, dos = null;
  if (boot) {
    // Boot path: no DOS is installed, so there is no PSP and no termination convention. Reaching a
    // derail here takes tens of millions of blocks, which single-stepping cannot do in any budget —
    // hence `warm`, a predicate that runs at full speed until the interesting part starts.
    ({ mc } = makeMachine({ dos: false, memSize: 32 << 20 }));
    const bytes = new Uint8Array(readFileSync(boot));
    mc.disk.attach(0x00, bytes);
    bootSector(mc, bytes);
  } else {
    const vfs = new VFS();
    if (dir) for (const rel of walk(dir)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
    vfs.chdir('\\');
    ({ mc, dos } = makeMachine({ vfs, memSize: 32 << 20 }));
    dos.load(image || new Uint8Array(readFileSync(join(dir, exe))), tail, 'C:\\' + (exe || 'T.COM'));
  }
  let fault = null; mc.onError = (e) => { fault = e; };
  const t0 = Date.now();
  let warmBlocks = 0;
  if (typeof warm === 'number') {
    // Run `warm` blocks at full speed, then single-step. A PREDICATE cannot work here: whatever it
    // watches for, the coarse slice that satisfies it has already run past the derail — the DPMI
    // client's whole life is shorter than one slice. So the caller measures the total first and asks
    // to stop a little short of it, which is exact and costs one extra boot.
    while (warmBlocks < warm && !fault && !(dos && dos.programDone) && Date.now() - t0 < budgetMs) {
      warmBlocks += mc.runSlice(Math.min(20000, warm - warmBlocks));
    }
  }
  const ring = [];
  let hit = null, n = 0;
  while (n++ < 5_000_000 && !(dos && dos.programDone) && !fault && Date.now() - t0 < budgetMs * 2) {
    const o = observe(mc);
    if (o.zero) { hit = o; break; }
    ring.push(o);
    if (ring.length > ringSize) ring.shift();
    mc.runSlice(1);
  }
  return { hit, ring, fault, dos, mc, n, blocks: warmBlocks + n, done: dos ? dos.programDone : false };
}

// ---- SELF-TEST: a .COM that far-jumps into a zeroed segment. The detector MUST fire. ----
const probe = new Uint8Array([0xea, 0x00, 0x00, 0x00, 0x40]);   // jmp far 4000:0000
const t = run({ image: probe, exe: 'T.COM', budgetMs: 5000 });
if (!t.hit) { console.log('SELF-TEST FAILED: the detector does not fire on a jump into empty memory — believe nothing below.'); process.exit(1); }
console.log('self-test OK — the detector fires:', fmt(t.hit));
console.log();

// ---- the real target ----
//   node tools/derailcheck.mjs HERETIC HERETIC.EXE
//   node tools/derailcheck.mjs --boot boot/FDMESHA.IMG        (steps once the guest enters protected mode)
const argv = process.argv.slice(2);
let r, target;
if (argv[0] === '--boot') {
  target = argv[1];
  // Pass 1 counts how far the boot gets before it stops; pass 2 replays and starts stepping a little
  // short of that, so the ring buffer holds the approach to the derail instead of the aftermath.
  const BACK = Number(process.env.DERAIL_BACK) || 20000;
  const probe1 = run({ boot: target, budgetMs: 60000, warm: 1e12 });
  const total = probe1.blocks;
  console.log(`pass 1: ${total.toLocaleString()} blocks before the stop (${probe1.fault ? 'FAULT' : 'end'}) — pass 2 depuis ${Math.max(0, total - BACK).toLocaleString()}`);
  r = run({ boot: target, budgetMs: 60000, warm: Math.max(0, total - BACK) });
} else {
  target = argv[0] || 'HERETIC';
  r = run({ dir: join('/Users/julienfrelat/Projects/mirage/games', target), exe: argv[1] || 'HERETIC.EXE' });
}
console.log(`${target}: ${r.done ? 'done ' + r.dos.exitCode : (r.fault ? 'FAULT' : 'running')} after ${r.n} blocks`);
if (r.fault) console.log('  ' + r.fault.message.slice(0, 160));
if (r.hit) {
  console.log('FIRST BLOCK ON ZERO BYTES:', fmt(r.hit));
  console.log('--- the 30 preceding blocks ---');
  for (const o of r.ring) console.log('  ' + fmt(o));
} else {
  console.log('no block executes zero bytes — the derail is NOT "running through empty memory".');
  console.log('--- the last 30 blocks ---');
  for (const o of r.ring) console.log('  ' + fmt(o));
}
