// bench-v86.mjs — MIRAGE against v86 on the same fixed amount of guest work.
//
//   mkdir -p /tmp/v86ref && cd /tmp/v86ref && npm init -y && npm i v86
//   V86_DIR=/tmp/v86ref node tools/bench-v86.mjs <test386-rom.bin> [postCode=0x09] [runs=3]
//
// ⛔ THIS DOES NOT YIELD A USABLE BENCHMARK, and the file exists to say why. Measured: MIRAGE 61 ms
// median (61/62/25), v86 34 ms (53/34/27) to POST 0x09. The raw spreads overlap completely, so the
// medians separate nothing — at that milestone the guest work is ~30 ms and engine startup plus JIT
// warm-up dominate. There is no LATER common milestone to use: v86 stops at 0x09 and MIRAGE goes on
// to 0x12, so the shared prefix of the only workload both run identically is a few tens of
// milliseconds long.
//
// The metric is WALL-CLOCK TIME TO REACH A GIVEN POST CODE. Both engines run the same ROM and do
// the same work to get there, so the times are comparable in principle.
//
// ⚠️ Two metrics were tried and rejected before this one, both of which look reasonable and measure
// nothing:
//   * "guest ticks per real second" measures THROTTLING, not speed. v86 deliberately targets real
//     time (~18.2 ticks/s); MIRAGE headless runs unthrottled (~650/s). The ratio is a policy
//     difference, not a performance one.
//   * the BDA tick is unusable on any image whose guest takes INT 8 without chaining — boot/FDMESHA
//     runs mesha, which does exactly that, and the counter simply freezes.
//
// What a real comparison needs: a floppy BOTH engines boot (v86 does, given seabios + vgabios —
// point V86_BIOS at them), running a long deterministic workload, timed to a memory signature rather
// than to a clock. v86 boots our images; only the metric was wrong here.
//
// The ROM must be built with `POST_PORT equ 0x3F8` so both engines can observe the code; see
// docs/notes/roadmap-log.md.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V86_DIR = process.env.V86_DIR || '/tmp/v86ref';
const BIOS = process.env.V86_BIOS || (V86_DIR + '/bios');
const romPath = process.argv[2] || join(ROOT, 'boot/test386.bin');
const WANT = Number(process.argv[3] ?? 0x09);
const RUNS = Number(process.argv[4] ?? 3);
const rom = readFileSync(romPath);

// ---- MIRAGE ---------------------------------------------------------------
async function mirageOnce() {
  const { Machine } = await import(join(ROOT, 'src/machine.js'));
  const mc = new Machine({ memSize: 16 << 20 }), cpu = mc.cpu;
  let fault = null; mc.onError = (e) => { fault = e; };
  mc.mem.blit(0x100000 - rom.length, rom);
  let hit = 0;
  mc.onPortWrite(0x3f8, (_p, _s, v) => { if ((v & 0xff) === WANT && !hit) hit = Date.now(); });
  mc.onPortRead(0x3f8, () => 0x20);
  mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.setMask(mc.mem.mask); });
  mc.onPortRead(0x92, () => (mc.mem.a20 ? 2 : 0));
  mc.tickTimer = () => {};
  cpu.reg.fill(0); cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;
  cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0); cpu.flags = 2; cpu.halted = false;
  const t0 = Date.now();
  let b = 0;
  while (!hit && b < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 90_000) b += mc.runSlice(20000);
  return hit ? hit - t0 : null;
}

// ---- v86 ------------------------------------------------------------------
function v86Once() {
  return new Promise(async (resolve) => {
    const { V86 } = await import(V86_DIR + '/node_modules/v86/build/libv86.mjs');
    const t0 = Date.now();
    const emulator = new V86({
      wasm_path: V86_DIR + '/node_modules/v86/build/v86.wasm',
      bios: { buffer: rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength) },
      memory_size: 16 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
      autostart: true, disable_keyboard: true, disable_mouse: true,
    });
    let done = false;
    const finish = (ms) => { if (done) return; done = true; try { emulator.stop(); } catch (e) {} resolve(ms); };
    emulator.add_listener('serial0-output-byte', (b) => { if ((b & 0xff) === WANT) finish(Date.now() - t0); });
    setTimeout(() => finish(null), 60_000);
  });
}

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const mt = [], vt = [];
for (let i = 0; i < RUNS; i++) { mt.push(await mirageOnce()); vt.push(await v86Once()); }
const M = med(mt), V = med(vt);
console.log(`ROM ${romPath} — temps pour atteindre le POST 0x${WANT.toString(16)} (mediane de ${RUNS})`);
console.log(`  MIRAGE : ${M == null ? 'NON ATTEINT' : M + ' ms'}   (${mt.map((x) => x == null ? '-' : x).join(' ')})`);
console.log(`  v86    : ${V == null ? 'NON ATTEINT' : V + ' ms'}   (${vt.map((x) => x == null ? '-' : x).join(' ')})`);
if (M && V) console.log(`  rapport: MIRAGE = ${(M / V).toFixed(2)}x le temps de v86` +
  ` (${M < V ? 'MIRAGE plus rapide' : 'v86 plus rapide'})`);
console.log(`  ⚠️ inclut le demarrage de chaque moteur — a ce POST le travail invite est court, donc`);
console.log(`     l'amorcage pese; lire cela comme "temps jusqu'a un jalon", pas comme un debit.`);
