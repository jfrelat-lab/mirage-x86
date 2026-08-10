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
mc.onPortWrite(POST_PORT, (_p, _s, v) => { posts.push(v & 0xff); ring[ri++ & MASK] = -1 - (v & 0xff); });
mc.onPortRead(POST_PORT, () => 0xff);
mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.MM = mc.mem.mask; mc.rec.reset(); });
mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));

// Ring buffer of block entries. Negative entries are POST-code markers, so the trace shows which
// section each block belongs to without a second pass.
const MASK = 8191;
const ring = new Int32Array(MASK + 1).fill(0);
let ri = 0;
const rec = mc.rec;
const origTranslate = rec.translate.bind(rec);
rec.translate = (...a) => {
  const b = origTranslate(...a);
  if (b && !b._traced) {
    b._traced = 1;
    const f = b.fn;
    b.fn = (c, blk) => { ring[ri++ & MASK] = ((c.seg[1] & 0xffff) * 0x10000 + (c.eip & 0xffff)) | 0; return f(c, blk); };
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
for (let i = start; i < ri; i++) {
  const v = ring[i & MASK];
  if (v < 0) { console.log(`    ---- POST ${h(-1 - v, 2)} ----`); continue; }
  const cs = (v >>> 16) & 0xffff, ip = v & 0xffff;
  const lin = (cpu.base[1] === (cs << 4) ? (cs << 4) + ip : null);   // only meaningful in real mode
  const isErr = errIp >= 0 && ip === errIp;
  console.log(`    ${h(cs)}:${h(ip)}${isErr ? '   <<<< error: — the block BEFORE this is the failing assertion' : ''}` +
    (lin !== null ? `   lin=0x${h(lin, 6)}` : ''));
}
