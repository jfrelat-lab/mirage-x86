// v86-test386.mjs — run test386 under v86, the reference closest to MIRAGE: also JavaScript, also a
// dynamic recompiler, also running real BIOS images.
//
//   mkdir -p /tmp/v86ref && cd /tmp/v86ref && npm init -y && npm i v86
//   V86_DIR=/tmp/v86ref node tools/v86-test386.mjs <rom.bin> [seconds]
//
// v86 is NOT committed (the same rule as boot/ and games/): install it where V86_DIR points.
// The ROM must be built with `POST_PORT equ 0x3F8` so each POST code arrives as a serial byte —
// see docs/notes/roadmap-log.md for why, and for the numbers the other engines give on the same binary.
//
// The ROM is the SAME binary the other engines ran: rebuilt with POST_PORT equ 0x3F8, so each POST
// code arrives as a serial byte. v86 surfaces those through its `serial0-output-byte` event, so no
// UART init is needed on the guest side — exactly as with QEMU's -serial file:.
import { readFileSync } from 'fs';
const S = process.env.V86_DIR || '/tmp/v86ref';
// The CJS build exports nothing (it installs globals); the ESM one exports V86 properly.
const { V86 } = await import(S + '/node_modules/v86/build/libv86.mjs');

const rom = readFileSync(process.argv[2]);
const SECS = Number(process.argv[3]) || 25;

const posts = [];
const emulator = new V86({
  wasm_path: S + '/node_modules/v86/build/v86.wasm',
  bios: { buffer: rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength) },
  memory_size: 16 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
});

// Timestamp each code: a run that simply TIMED OUT and one that is stuck look identical in a bare
// list. If the last code is seconds old while the run continued, it is stuck, not slow.
const t0 = Date.now();
emulator.add_listener('serial0-output-byte', (b) => { posts.push([b & 0xff, Date.now() - t0]); });
emulator.add_listener('emulator-stopped', () => report('arret de l emulateur'));

let done = false;
function report(why) {
  if (done) return; done = true;
  const hex = posts.map(([p, t]) => `0x${p.toString(16).padStart(2, '0')}@${(t / 1000).toFixed(1)}s`);
  console.log(`v86 — ${why}`);
  console.log(`POST codes (${posts.length}): ${hex.join(' ') || '(none)'}`);
  console.log(`dernier: ${hex.length ? hex[hex.length - 1] : '-'}`);
if (posts.length) {
  const age = (Date.now() - t0 - posts[posts.length - 1][1]) / 1000;
  console.log(`dernier code emis il y a ${age.toFixed(1)}s -> ${age > 5 ? 'BLOQUE' : 'encore en progression'}`);
}
  try { emulator.stop(); } catch (e) {}
  process.exit(0);
}
setTimeout(() => report(`${SECS}s ecoulees`), SECS * 1000);
