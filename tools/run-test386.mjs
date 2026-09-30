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
import { runTest386 } from './test386-run.mjs';

const path = process.argv[2] || 'boot/test386.bin';
const POST_PORT = Number(process.env.POST_PORT || 0x190);
const rom = new Uint8Array(readFileSync(path));

const { mc, cpu, posts, fault, blocks, unhandled, unexpected } =
  runTest386(rom, { postPort: POST_PORT, irq: !!process.env.TEST386_IRQ, deadlineMs: 60_000 });

const h = (n, w = 2) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
console.log(`=== ${path} (${rom.length} bytes) ===`);
console.log(`ran ${blocks.toLocaleString()} blocks, halted=${cpu.halted}, fault=${fault ? fault.message : 'none'}`);
console.log(`stopped at ${h(cpu.seg[1], 4)}:${h(cpu.eip >>> 0, 4)}`);
console.log(`POST codes reached (${posts.length}): ${posts.map((p) => h(p)).join(' ') || '(none)'}`);
if (posts.length) console.log(`last POST code: ${h(posts[posts.length - 1])}  <- the diagnostic`);
// PASS/FAIL, stated rather than implied. test386 signals success by writing POST 0xFF at `postFF`
// and only then halting; its DefaultExcHandler ends in cli/hlt too, at 0xFE88/0xFE89 followed by
// `jmp error` at 0xFE8A. So `halted=true` alone says nothing — both outcomes halt, and reading a
// halt as success is how "20 POST codes, halted, no fault" got quoted as a healthy run for months.
const passed = posts.length > 0 && posts[posts.length - 1] === 0xff;
const ip = cpu.eip >>> 0;
const inErr = ip >= 0xfe7f && ip <= 0xfe8a;
console.log(passed ? 'RESULT: PASS — reached POST 0xFF'
  : `RESULT: FAIL — stopped at POST ${h(posts[posts.length - 1] ?? 0)}` +
    `${!inErr ? '' : unexpected
      ? `, in DefaultExcHandler: an exception it did not expect, #${unexpected.n}` +
        `${unexpected.err !== undefined ? ` err=${h(unexpected.err, 4)}` : ''}`
      : ', at `error`: a check FAILED (no exception was delivered there)'}`);
if (unhandled.size) {
  console.log('ports with no handler: ' +
    [...unhandled.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${h(p, 3)}x${n}`).join(' '));
}
