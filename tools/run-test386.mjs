// run-test386.mjs — run test386.asm, a self-checking x86 tester, as a BIOS ROM.
//
//   node tools/run-test386.mjs boot/test386.bin
//
// A third kind of oracle, complementary to the other two. The SingleStepTests vectors are silicon
// but 16-bit only; the Unicorn cases are a peer emulator; this is a *program* whose author read the
// manuals and encoded the expected behaviour as executable assertions, and which PCem and 86Box use
// to validate themselves. It costs nothing to try and it checks things our per-instruction harnesses
// do not: sequences, exception delivery, and the CPU's own self-consistency.
//
// It is a BIOS replacement, so no installBIOS here — the 64 KB image IS the F000 segment, entered at
// the reset vector F000:FFF0. It reports progress by writing a rising sequence of codes to the POST
// port (0x190 in the default configuration); the last code before it stops is the diagnostic.
//
// Build it: `git clone https://github.com/barotto/test386.asm && make` (needs NASM). Not committed —
// boot/ is gitignored like intros/ and games/.

import { readFileSync } from 'fs';
import { Machine } from '../src/machine.js';

const path = process.argv[2] || 'boot/test386.bin';
const POST_PORT = Number(process.env.POST_PORT || 0x190);
const rom = new Uint8Array(readFileSync(path));

const mc = new Machine({ memSize: 16 << 20 });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };

if (rom.length !== 0x10000) console.log(`note: ROM is ${rom.length} bytes, expected 65536`);
mc.mem.blit(0x100000 - rom.length, rom);

// The POST sequence is the whole report: every code it reaches, in order.
const posts = [];
mc.onPortWrite(POST_PORT, (_p, _s, v) => posts.push(v & 0xff));
mc.onPortRead(POST_PORT, () => 0xff);
// A20 — it will want the full address space on its way to protected mode.
mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.MM = mc.mem.mask; mc.rec.reset(); });
mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));
const unhandled = new Map();
const oR = cpu.ioRead, oW = cpu.ioWrite;
cpu.ioRead = (p, s) => { if (!mc.portRead[p]) unhandled.set(p, (unhandled.get(p) || 0) + 1); return oR(p, s); };
cpu.ioWrite = (p, s, v) => { if (!mc.portWrite[p]) unhandled.set(p, (unhandled.get(p) || 0) + 1); return oW(p, s, v); };

cpu.reg.fill(0);
cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;       // the reset vector
cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0);
cpu.flags = 0x0002;
cpu.halted = false;

const t0 = Date.now();
let blocks = 0;
while (blocks < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 60_000) blocks += mc.runSlice(20000);

const h = (n, w = 2) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
console.log(`=== ${path} (${rom.length} bytes) ===`);
console.log(`ran ${blocks.toLocaleString()} blocks, halted=${cpu.halted}, fault=${fault ? fault.message : 'none'}`);
console.log(`stopped at ${h(cpu.seg[1], 4)}:${h(cpu.eip >>> 0, 4)}`);
console.log(`POST codes reached (${posts.length}): ${posts.map((p) => h(p)).join(' ') || '(none)'}`);
if (posts.length) console.log(`last POST code: ${h(posts[posts.length - 1])}  <- the diagnostic`);
if (unhandled.size) {
  console.log('ports with no handler: ' +
    [...unhandled.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${h(p, 3)}x${n}`).join(' '));
}
