// vga-rom.mjs — run a REAL VGA BIOS option ROM inside MIRAGE and diff it against our own INT 10h.
//
//   node tools/vga-rom.mjs boot/vgabios-stdvga.bin          # init + a mode-13h set, compared
//   MODE=0x12 node tools/vga-rom.mjs boot/vgabios-stdvga.bin
//   MODE=0x0d DUMP=1 node tools/vga-rom.mjs boot/...        # print the register table for one mode
//
// The point is to turn the question around. Asking "is our INT 10h AH=00 correct?" has no oracle —
// we wrote both the question and the answer. Loading a real ROM asks instead: **does the real
// mode-set code produce the right register state on our VGA?** Any difference is then in our
// hardware model, not in our approximation of a BIOS, which is a far more falsifiable thing.
//
// The ROM is loaded at C000:0 and entered by a far call to C000:0003, exactly as a POST does. It
// programs the card, points the INT 10h vector at itself, and returns; from then on an INT 10h runs
// real 16-bit code against our device model. SeaVGABIOS also narrates itself on port 0x402 (the
// QEMU/Bochs debug console), which this prints — the ROM telling us what it thinks it found.
//
// Get the ROM: it ships prebuilt with QEMU as pc-bios/vgabios-stdvga.bin (LGPL, SeaVGABIOS). Not
// committed — boot/ is gitignored like intros/ and games/.

import { readFileSync } from 'fs';
import { makeMachine } from './harness.mjs';

const romPath = process.argv[2];
const rom = new Uint8Array(readFileSync(romPath));
const { mc } = makeMachine({ dos: false });
const cpu = mc.cpu;
let fault = null; mc.onError = (e) => { fault = e; };

console.log(`ROM ${romPath}: ${rom.length} bytes, sig ${rom[0].toString(16)}${rom[1].toString(16)}, ${rom[2]} blocks`);
mc.mem.blit(0xc0000, rom);

// Watch what it does to the I/O bus and which ports have no handler.
const wrote = new Map(), miss = new Map();
const oR = cpu.ioRead, oW = cpu.ioWrite;
cpu.ioRead = (p, s) => { if (!mc.portRead[p]) miss.set(p, (miss.get(p) || 0) + 1); return oR(p, s); };
cpu.ioWrite = (p, s, v) => { if (!mc.portWrite[p]) miss.set(p, (miss.get(p) || 0) + 1); wrote.set(p, (wrote.get(p) || 0) + 1); return oW(p, s, v); };

// Port 0x402 is the QEMU/Bochs debug console: the ROM narrates what it is doing there.
let romLog = '';
mc.onPortWrite(0x402, (_p, _s, v) => { romLog += String.fromCharCode(v & 0xff); });
const v10before = mc.getVector(0x10);

// POST hands control with a far CALL. Park a HLT where it will RETF back to.
const RET_SEG = 0x0000, RET_OFF = 0x7c00;
mc.mem.w8((RET_SEG << 4) + RET_OFF, 0xf4);              // HLT
cpu.reg.fill(0);
cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0;                  // a stack of its own
cpu.setSeg(3, 0x0000); cpu.setSeg(0, 0x0000);
cpu.flags = 0x0202;
cpu.push16(RET_SEG); cpu.push16(RET_OFF);                // the far return address
cpu.setSeg(1, 0xc000); cpu.eip = 0x0003;
cpu.halted = false;

const t0 = Date.now();
let blocks = 0;
while (!cpu.halted && !fault && blocks < 20_000_000 && Date.now() - t0 < 30_000) blocks += mc.runSlice(10000);

const v10after = mc.getVector(0x10);
const h = (n, w = 4) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
console.log(`ran ${blocks.toLocaleString()} blocks, halted=${cpu.halted}, fault=${fault ? fault.message : 'none'}`);
console.log(`stopped at ${h(cpu.seg[1])}:${h(cpu.eip & 0xffff)}`);
console.log(`INT 10h vector: ${h(v10before.seg)}:${h(v10before.off)} -> ${h(v10after.seg)}:${h(v10after.off)}` +
            (v10after.seg === 0xc000 ? '   (the ROM took it over)' : ''));
console.log(`ports written: ${[...wrote.keys()].sort((a, b) => a - b).map((p) => h(p, 3)).join(' ') || '(none)'}`);
console.log(`ports with NO handler: ${[...miss.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${h(p, 3)}x${n}`).join(' ') || '(none)'}`);
if (romLog.trim()) console.log('--- the ROM\'s own log (port 0x402) ---\n' + romLog.trim().split('\n').map((l) => '  ' + l).join('\n'));
console.log(`BDA 0449 mode=${h(mc.mem.r8(0x449), 2)}  0463 crtc=${h(mc.mem.r16(0x463))}  0410 equip=${h(mc.mem.r16(0x410))}`);

// ---- the actual experiment: let the REAL mode-set code drive our VGA ----
const MODE = Number(process.env.MODE || 0x13);
mc.mem.blit(0x50000, Uint8Array.from([0xb8, MODE, 0x00, 0xcd, 0x10, 0xf4]));   // mov ax,00xx ; int 10h ; hlt
cpu.reg.fill(0); cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0;
cpu.setSeg(1, 0x5000); cpu.eip = 0; cpu.flags = 0x0202; cpu.halted = false;
let b2 = 0; const t1 = Date.now();
while (!cpu.halted && !fault && b2 < 20_000_000 && Date.now() - t1 < 30_000) b2 += mc.runSlice(10000);
const dump = (m) => ({
  mode: m.mem.r8(0x449), planar: !!m.mem.planar,
  crtc: Array.from(m.vga.crtc).map((v) => v & 0xff),
  seq: [m.vga.mapMask, m.vga.memMode], gc: Array.from(m.vga.gc).map((v) => v & 0xff),
  pal: Array.from(m.vga.palette), dac0: Array.from(m.bios.dac.subarray(0, 48)),
});
console.log(`\nmode set 0x${MODE.toString(16)} through the REAL ROM: ${b2.toLocaleString()} blocks, fault=${fault ? fault.message : 'none'}`);
const real = dump(mc);

// The same call through our own INT 10h, on a fresh machine.
const { mc: mc2 } = makeMachine({ dos: false });
mc2.cpu.ax = MODE; mc2.intHandlers[0x10](mc2.cpu, mc2);
const hle = dump(mc2);

if (process.env.DUMP) {
  const hx = (a) => a.map((v) => '0x' + (v & 0xff).toString(16).padStart(2, '0')).join(', ');
  console.log(`  [0x${MODE.toString(16)}]: { crtc: [${hx(real.crtc)}], gc: [${hx(real.gc)}] },`);
  process.exit(0);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(`  BDA mode : real ${h(real.mode, 2)}   ours ${h(hle.mode, 2)}   ${real.mode === hle.mode ? 'ok' : 'DIFFER'}`);
console.log(`  planar   : real ${real.planar}   ours ${hle.planar}   ${real.planar === hle.planar ? 'ok' : 'DIFFER'}`);
for (const k of ['crtc', 'seq', 'gc', 'pal', 'dac0']) {
  if (same(real[k], hle[k])) { console.log(`  ${k.padEnd(9)}: identical`); continue; }
  const diffs = [];
  for (let i = 0; i < Math.max(real[k].length, hle[k].length); i++) {
    if (real[k][i] !== hle[k][i]) diffs.push(`[${i}] real ${h(real[k][i] | 0, 2)} ours ${h(hle[k][i] | 0, 2)}`);
  }
  console.log(`  ${k.padEnd(9)}: ${diffs.length} differ — ${diffs.slice(0, 8).join('  ')}${diffs.length > 8 ? ' …' : ''}`);
}
