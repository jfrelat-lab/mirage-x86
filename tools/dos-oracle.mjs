// dos-oracle.mjs — capture INT 21h behaviour from a REAL DOS kernel, then check ours against it.
//
//   node tools/dos-oracle.mjs capture [image]   # boot the kernel, record every INT 21h in -> out
//   node tools/dos-oracle.mjs check             # replay the recording into our HLE DOS and diff
//
// Why: `test-dos-api.js` states its expectations by hand, and three of its early cases were wrong
// because I derived them by hand. The fix that worked for the CPU was to stop deriving and start
// observing — Unicorn for 386 semantics, real-8088 vectors for flags. This is the same move for the
// DOS layer, and it became possible the day a real kernel booted on our BIOS (roadmap F2d): boot
// FreeDOS, let its own kernel, shell and installer make their thousands of INT 21h calls, and record
// what went in and what came out.
//
// The honest limit, stated up front: most INT 21h calls depend on state we do not replicate — open
// handles, the file the caller just created, where its PSP is. Replaying those would produce
// mismatches that say nothing. So the comparison runs over a whitelist of calls whose answer depends
// on little or no prior state, and everything else is captured but only counted. Widening that
// whitelist means replicating state deliberately, one function at a time — not loosening the filter.
//
// FreeDOS is a peer, not an authority. Where it and MS-DOS differ, neither is automatically right;
// what this catches is our answers being differently shaped from a real kernel's, which is a
// different and more tractable question than "which DOS is correct".

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeMachine } from './harness.mjs';
import { bootSector } from '../src/boot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RECORDING = join(HERE, 'dos-oracle-capture.json');
const CF = 1;

// Functions whose answer is (near enough) independent of file/handle/memory state. Everything else
// is recorded but not compared — see the note above.
// The first pass of this list was too generous, and the run said so loudly. Four entries came out:
//   AH=19h  current drive — the captured machine booted from A:, ours runs from C:. Environment.
//   AH=35h  get vector    — the answer is a pointer into a kernel that isn't ours. Environment.
//   AH=25h  set vector    — same family; nothing to compare.
//   AH=30h  version       — we report 5.00 and FreeDOS 7.10, deliberately. A difference by choice
//                           is not a defect, and leaving it in would train us to ignore the output.
// What is left is genuinely answerable without shared state.
const STATELESS = new Set([
  0x2b, 0x2d,   // set date, set time — validation only, and the result is a status byte
  0x33,         // ctrl-break state
  0x37,         // get/set switch character
  0x54,         // get verify flag
]);

const REG = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const snap = (cpu) => ({
  r: Array.from(cpu.reg, (v) => v & 0xffff),
  s: Array.from(cpu.seg),
  f: cpu.flags & 0x0fd5,
});

// ---------------------------------------------------------------- capture
function capture(imgPath) {
  const img = new Uint8Array(readFileSync(imgPath));
  const { mc } = makeMachine({ dos: false });          // no HLE DOS: the image brings its own kernel
  mc.disk.attach(0x00, img);
  let fault = null; mc.onError = (e) => { fault = e; };
  bootSector(mc, img);

  const cpu = mc.cpu;
  const records = [];
  const open = [];                                     // INT 21h calls whose IRET we are still waiting for

  // An INT 21h serviced by the guest's own kernel goes swInt -> realInt, which pushes FLAGS/CS/IP and
  // jumps. There is no "handler returned" callback to hook, so remember where the frame will unwind
  // to and watch for the CPU to arrive back there with the stack restored.
  const origSwInt = cpu.swInt;
  cpu.swInt = (n) => {
    if (n === 0x21) {
      open.push({
        inRegs: snap(cpu),
        retIP: cpu.eip & 0xffff, retCS: cpu.seg[1],
        sp: cpu.sp & 0xffff, ss: cpu.seg[2],
      });
    }
    return origSwInt(n);
  };

  const t0 = Date.now();
  let blocks = 0, fed = 0, since = 0, ticks = 0;
  const KEYS = [0x4e, 0x0d];                           // answer the installer: N, Enter
  // runSlice(1), not rec.step(): one block through the PRODUCTION run loop, which is what services
  // hardware IRQs and the cycle-driven PIT. Stepping the recompiler directly skips both, and FreeDOS
  // never got past its first disk read.
  while (blocks < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 120_000) {
    blocks += mc.runSlice(1);
    // Has the innermost open call come back?
    if (open.length) {
      const top = open[open.length - 1];
      if ((cpu.sp & 0xffff) === top.sp && cpu.seg[2] === top.ss &&
          cpu.seg[1] === top.retCS && (cpu.eip & 0xffff) === top.retIP) {
        open.pop();
        records.push({ in: top.inRegs, out: snap(cpu) });
      }
    }
    if ((blocks % 50000) === 0) {
      mc.tickTimer(); ticks++;
      if (fed < KEYS.length && ticks > 40 && ++since > 8) { mc.keyQueue.push({ ascii: KEYS[fed], scan: KEYS[fed] }); fed++; since = 0; }
    }
  }

  let text = '';
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) { const c = mc.mem.u8[0xb8000 + (row * 80 + col) * 2]; line += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
    if (line.trim()) text += line.trimEnd() + '\n';
  }
  return { records, blocks, fault: fault ? fault.message : null, text };
}

// ---------------------------------------------------------------- check
/** Replay one captured call into our HLE DOS and return the differences. */
function replay(rec) {
  const { mc, dos } = makeMachine();
  dos.load(Uint8Array.from([0xcd, 0x20]), '', 'C:\\T.COM');
  const cpu = mc.cpu;
  for (let i = 0; i < 8; i++) cpu.reg[i] = rec.in.r[i];
  for (let i = 0; i < rec.in.s.length; i++) if (i !== 1 && i !== 2) cpu.setSeg(i, rec.in.s[i]);
  // Replay the captured flags EXACTLY rather than poisoning CF. Poisoning is right for a hand-written
  // test asserting "this clears CF on success", but it makes the opposite behaviour — leaving CF
  // alone, which is what AH=37h does — impossible to detect: our answer would always read as 0. The
  // kernel is the authority on which of the two a function does, so give it the same input.
  cpu.flags = rec.in.f;
  mc.intHandlers[0x21](cpu, mc);
  const got = snap(cpu);

  const diffs = [];
  const ah = (rec.in.r[0] >> 8) & 0xff;
  // Compare AX and CF always; BX/CX/DX only where the captured call changed them, since a function
  // that leaves a register alone and one that happens to write the same value are indistinguishable.
  const hex = (v) => '0x' + (v >>> 0).toString(16);
  if (got.r[0] !== rec.out.r[0]) diffs.push(`AX=${hex(got.r[0])} want ${hex(rec.out.r[0])}`);
  if ((got.f & CF) !== (rec.out.f & CF)) diffs.push(`CF=${got.f & CF} want ${rec.out.f & CF}`);
  for (const i of [1, 2, 3, 6, 7]) {
    if (rec.out.r[i] !== rec.in.r[i] && got.r[i] !== rec.out.r[i]) {
      diffs.push(`${REG[i].toUpperCase()}=${hex(got.r[i])} want ${hex(rec.out.r[i])}`);
    }
  }
  return { ah, diffs };
}

// ---------------------------------------------------------------- main
const mode = process.argv[2] || 'check';

if (mode === 'capture') {
  const img = process.argv[3] || join(ROOT, 'boot', 'FREEDOS14.IMG');
  if (!existsSync(img)) { console.error(`no boot image at ${img} — see docs/TESTING.md`); process.exit(2); }
  console.log(`booting ${img} and recording every INT 21h …`);
  const { records, blocks, fault, text } = capture(img);
  console.log(text.split('\n').slice(-4).join('\n'));
  console.log(`${blocks.toLocaleString()} blocks, ${records.length} complete INT 21h calls${fault ? ', FAULT ' + fault : ''}`);
  const byAh = new Map();
  for (const r of records) { const ah = (r.in.r[0] >> 8) & 0xff; byAh.set(ah, (byAh.get(ah) || 0) + 1); }
  const comparable = records.filter((r) => STATELESS.has((r.in.r[0] >> 8) & 0xff));
  console.log('captured: ' + [...byAh.entries()].sort((a, b) => b[1] - a[1])
    .map(([ah, n]) => `${ah.toString(16).padStart(2, '0')}h x${n}`).join(' '));
  console.log(`${comparable.length} of them are in the state-light set and will be compared`);
  writeFileSync(RECORDING, JSON.stringify({ image: img.split('/').pop(), records: comparable }));
  console.log(`wrote ${RECORDING}`);
  process.exit(0);
}

if (!existsSync(RECORDING)) { console.error('no capture yet — run: node tools/dos-oracle.mjs capture'); process.exit(2); }
const { image, records } = JSON.parse(readFileSync(RECORDING, 'utf8'));
console.log(`replaying ${records.length} calls captured from ${image} into our INT 21h\n`);

const fails = new Map();
let pass = 0;
for (const rec of records) {
  const { ah, diffs } = replay(rec);
  if (!diffs.length) { pass++; continue; }
  const key = `AH=${ah.toString(16).padStart(2, '0')}h  ${diffs.join(', ')}`;
  fails.set(key, (fails.get(key) || 0) + 1);
}
console.log(`mirage vs a real DOS kernel: ${pass} matched, ${records.length - pass} differed`);
if (fails.size) {
  console.log('\nDifferences (distinct shapes, with how often each occurred):');
  for (const [k, n] of [...fails.entries()].sort((a, b) => b[1] - a[1])) console.log(`  x${String(n).padStart(5)}  ${k}`);
  process.exit(1);
}
console.log('all matched ✓');
