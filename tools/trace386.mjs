// trace386.mjs — which assertion does test386 fail?
//
// run-test386.mjs reports the last POST code, which localises a failure to a SECTION (POST 9 =
// "Stack functionality") but not to an instruction — and that section runs dozens of assertions.
// The test signals failure by jumping to its `error:` routine, so the block executed immediately
// before that jump IS the failing assertion.
//
// Two pieces make this precise without symbols:
//   1. a ring buffer of CS:IP at every block entry (wrapping each translated block's fn once), and
//   2. the address of `error:` recovered from the ROM by its byte signature. The test's own source
//      documents the encoding: `test ax,7` is 66 A9 07 00 and `jnz $` is 75 FE, a sequence that
//      appears nowhere else.
//
//   node tools/trace386.mjs boot/test386.bin [entries]

import { readFileSync } from 'fs';
import { Machine } from '../src/machine.js';

const path = process.argv[2] || 'boot/test386.bin';
const SHOW = Number(process.argv[3] || 32);
const POST_PORT = Number(process.env.POST_PORT || 0x190);
const rom = new Uint8Array(readFileSync(path));

const mc = new Machine({ memSize: 16 << 20 });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };
mc.mem.blit(0x100000 - rom.length, rom);

// Locate `error:` — the routine is `mov ax,cs / test ax,7 / jnz $ / cli / hlt`.
const SIG = [0x66, 0xa9, 0x07, 0x00, 0x75, 0xfe];
let errIp = -1;
for (let i = 0; i + SIG.length <= rom.length; i++) {
  let ok = true;
  for (let j = 0; j < SIG.length; j++) if (rom[i + j] !== SIG[j]) { ok = false; break; }
  if (ok) { errIp = i - 2; break; }            // back up over `mov ax,cs` (8C C8)
}
const romBase = 0x100000 - rom.length;

const posts = [];
mc.onPortWrite(POST_PORT, (_p, _s, v) => { posts.push(v & 0xff); const k = ri++ & MASK; ringPost[k] = v & 0xff;
  if (SPIN_AFTER >= 0 && (v & 0xff) === SPIN_AFTER) armed = true; });
mc.onPortRead(POST_PORT, () => 0xff);
mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.MM = mc.mem.mask; mc.rec.reset(); });
mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));

// Ring buffer of block entries, with POST markers in a PARALLEL array rather than encoded as
// negative values — CS >= 0x8000 makes (cs<<16)|ip negative, so the first version reported real
// addresses as POST codes. Two arrays cannot be ambiguous.
const MASK = 8191;
const ringCs = new Int32Array(MASK + 1), ringIp = new Int32Array(MASK + 1);
const ringPost = new Int32Array(MASK + 1).fill(-1);
let ri = 0;
// A repeated block is NORMAL — every loop does it — so the detector must be armed for the section
// under investigation only, or it fires on the first delay loop (it did: POST 01, f000:039b).
const SPIN_LIMIT = Number(process.env.SPIN || 5000);
const SPIN_AFTER = process.env.SPIN_AFTER === undefined ? -1 : Number(process.env.SPIN_AFTER);
let spinCs = -1, spinIp = -1, spinN = 0, armed = SPIN_AFTER < 0;
const rec = mc.rec;
const origTranslate = rec.translate.bind(rec);
rec.translate = (...a) => {
  const b = origTranslate(...a);
  if (b && !b._traced) {
    b._traced = 1;
    const f = b.fn;
    b.fn = (c, blk) => {
      const k = ri++ & MASK; ringPost[k] = -1; ringCs[k] = c.seg[1] & 0xffff; ringIp[k] = c.eip >>> 0;
      // A tight spin fills the whole ring with one address and erases the lead-up, which is the only
      // part worth seeing. Stop the machine once the same block repeats, so the buffer still holds
      // how we got there.
      // Stopping the moment `error:` is ENTERED keeps the ring holding the assertions that led
      // there; letting it run fills the buffer with the routine's own hlt/jmp loop instead.
      if (errIp >= 0 && ringIp[k] >= errIp && ringIp[k] < errIp + 16) c.halted = true;   // a block may start a few bytes into the routine
      else if (armed && ringCs[k] === spinCs && ringIp[k] === spinIp) { if (++spinN > SPIN_LIMIT) c.halted = true; }
      else { spinCs = ringCs[k]; spinIp = ringIp[k]; spinN = 0; }
      return f(c, blk);
    };
  }
  return b;
};

cpu.reg.fill(0);
cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;
cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0);
cpu.flags = 0x0002;
cpu.halted = false;

const t0 = Date.now();
let blocks = 0;
while (blocks < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 60_000) blocks += mc.runSlice(20000);

const h = (n, w = 4) => (n >>> 0).toString(16).padStart(w, '0');
console.log(`=== ${path} — halted=${cpu.halted} fault=${fault ? fault.message : 'none'} ===`);
console.log(`POST codes: ${posts.map((p) => h(p, 2)).join(' ')}`);
console.log(`error: routine at ROM offset ${errIp < 0 ? '<signature not found>' : '0x' + h(errIp)} ` +
  `(linear 0x${h((romBase + errIp) >>> 0, 6)})`);
console.log(`\nlast ${SHOW} block entries before the stop (oldest first):`);
const start = Math.max(0, ri - SHOW);
let prev = null, runLen = 0;
for (let i = start; i < ri; i++) {
  const k = i & MASK;
  if (ringPost[k] >= 0) { console.log(`    ---- POST ${h(ringPost[k], 2)} ----`); prev = null; continue; }
  const key = ringCs[k] + ':' + ringIp[k];
  if (key === prev) { runLen++; continue; }
  if (runLen) { console.log(`      (x${runLen + 1})`); runLen = 0; }
  prev = key;
  const isErr = errIp >= 0 && ringIp[k] === errIp;
  console.log(`    ${h(ringCs[k])}:${h(ringIp[k], 8)}${isErr ? '   <<<< error:' : ''}`);
}
if (runLen) console.log(`      (x${runLen + 1})`);
