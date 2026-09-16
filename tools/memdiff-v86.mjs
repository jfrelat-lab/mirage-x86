// memdiff-v86.mjs — diff the first 640 KB of RAM between MIRAGE and v86 at the SAME POST code.
//
//   mkdir -p /tmp/v86ref && cd /tmp/v86ref && npm init -y && npm i v86
//   V86_DIR=/tmp/v86ref node tools/memdiff-v86.mjs <rom.bin> [postCode=0x09]
//
// This is test386's own recommended method, and it works even though NO engine here reaches POST
// 0xFF: the program is deterministic, so at a given POST code the RAM content is fixed. Comparing
// POST COUNTS says only who stopped first; comparing memory says WHERE they disagree, to the byte.
//
// The dump is taken at the instant the code is written to the POST port, so what is being compared
// is the state at ENTRY to that section — i.e. everything the preceding sections produced.
//
// ⚠️ The ROM must be built with `POST_PORT equ 0x3F8` (the UART data register) so both engines can
// observe the code: v86 reports it through `serial0-output-byte`, MIRAGE through a port hook. That
// redirection was checked not to perturb either engine — see docs/ROADMAP.md.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V86_DIR = process.env.V86_DIR || '/tmp/v86ref';
const romPath = process.argv[2] || join(ROOT, 'boot/test386.bin');
const WANT = Number(process.argv[3] ?? 0x09);
const LEN = 640 * 1024;
const rom = readFileSync(romPath);
const hex = (v, n = 2) => (v >>> 0).toString(16).padStart(n, '0');

// ---- MIRAGE ---------------------------------------------------------------
const { Machine } = await import(join(ROOT, 'src/machine.js'));
function runMirage() {
  const mc = new Machine({ memSize: 16 << 20 }), cpu = mc.cpu;
  let fault = null; mc.onError = (e) => { fault = e; };
  mc.mem.blit(0x100000 - rom.length, rom);
  let snap = null;
  mc.onPortWrite(0x3f8, (_p, _s, v) => { if ((v & 0xff) === WANT && !snap) snap = mc.mem.u8.slice(0, LEN); });
  mc.onPortRead(0x3f8, () => 0x20);                       // THR empty, so a polling guest proceeds
  mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.setMask(mc.mem.mask); });
  mc.onPortRead(0x92, () => (mc.mem.a20 ? 2 : 0));
  mc.tickTimer = () => {};
  cpu.reg.fill(0); cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;
  cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0); cpu.flags = 2; cpu.halted = false;
  let b = 0; const t0 = Date.now();
  while (!snap && b < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 90_000) b += mc.runSlice(20000);
  return snap;
}

// ---- v86 ------------------------------------------------------------------
function runV86() {
  return new Promise(async (resolve) => {
    const { V86 } = await import(V86_DIR + '/node_modules/v86/build/libv86.mjs');
    const emulator = new V86({
      wasm_path: V86_DIR + '/node_modules/v86/build/v86.wasm',
      bios: { buffer: rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength) },
      memory_size: 16 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
      autostart: true, disable_keyboard: true, disable_mouse: true,
    });
    let done = false;
    const finish = (mem) => { if (done) return; done = true; try { emulator.stop(); } catch (e) {} resolve(mem); };
    emulator.add_listener('serial0-output-byte', (b) => {
      if ((b & 0xff) === WANT) {
        // read_memory is synchronous, so the dump is taken on this very event — the same instant
        // MIRAGE's port hook takes its own.
        try { finish(Uint8Array.from(emulator.read_memory(0, LEN))); } catch (e) { finish(null); }
      }
    });
    setTimeout(() => finish(null), 60_000);
  });
}

const mir = runMirage();
const v86 = await runV86();
if (!mir || !v86) {
  console.error(`no dump: mirage=${mir ? 'ok' : 'MISSING'} v86=${v86 ? 'ok' : 'MISSING'} ` +
    `(was POST code 0x${hex(WANT)} reached on both sides?)`);
  process.exit(2);
}

// Split by region. The IVT and BDA differ BY CONSTRUCTION and always will: MIRAGE fills the vector
// table with its own dummy handler (F000:FF53) and keeps a BDA, while v86 runs test386 as the only
// BIOS and leaves both at zero. Counting those in a single total buries whatever the CPU actually
// disagrees about — which is the only part worth reading.
const REGIONS = [
  ['IVT  0000-03ff (environment, not the CPU)', 0x000, 0x400],
  ['BDA  0400-04ff (environment, not the CPU)', 0x400, 0x500],
  ['RAM  0500-9ffff (what test386 writes)', 0x500, LEN],
];
let total = 0;
const interesting = [];
for (const [name, lo, hi] of REGIONS) {
  let n = 0;
  for (let i = lo; i < hi; i++) if (mir[i] !== v86[i]) { n++; if (lo >= 0x500 && interesting.length < 24) interesting.push(i); }
  total += n;
  console.log(`  ${name}: ${n} bytes differ`);
}
console.log(`640 KB dump at POST 0x${hex(WANT)} — ${total} bytes differ of ${LEN}`);
if (interesting.length) {
  console.log('first differences OUTSIDE the environment regions:');
  for (const a of interesting) console.log(`  ${hex(a, 6)}: mirage=${hex(mir[a])} v86=${hex(v86[a])}`);
} else console.log('AUCUN ecart hors IVT/BDA — les deux moteurs produisent la meme RAM.');
writeFileSync('/tmp/memdiff-mirage.bin', mir); writeFileSync('/tmp/memdiff-v86.bin', v86);
console.log('dumps: /tmp/memdiff-mirage.bin /tmp/memdiff-v86.bin');
