// mirage-cosim-boot.mjs — the boot-image variant of mirage-cosim.mjs.
//
//   node tools/cosim/mirage-cosim-boot.mjs [image]   # then uc-cosim.py, then cosim-diff.mjs
//   SNAPBACK=8000 TRIG=2cc:04db node tools/cosim/mirage-cosim-boot.mjs
//
// Same method as the game version — run to a trigger, snapshot RAM+CPU at a point with no INT after
// it, then single-step logging registers so Unicorn can replay the identical window — but the guest
// is a booted kernel rather than a DOS program. Written for the MS-DOS 6.22 derail (see
// docs/COMPAT.md): three service-level hypotheses were tested and refuted, and the CPU had never
// been checked, which given this project's history (the 0x67 prefix, the trap flag, push-dword) is
// exactly the class left standing.
//
// TRIG is `cs:ip` in hex; the default is the device-chain walk the derail traces back to.

import { readFileSync, writeFileSync } from 'fs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
process.env.MIRAGE_NOTIER2 = '1';
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');

const IMG = process.argv[2] || ROOT + '/boot/MSDOS622.IMG';
const SNAPBACK = +(process.env.SNAPBACK || 6000);
const [TCS, TIP] = (process.env.TRIG || '2cc:04db').split(':').map((x) => parseInt(x, 16));

function fresh() {
  const { mc } = makeMachine({ dos: false });
  const img = new Uint8Array(readFileSync(IMG));
  mc.disk.attach(0x00, img);
  bootSector(mc, img);
  mc.nextTimerCycle = mc.pitReload;
  return mc;
}
const regs = (cpu) => ({
  cs: cpu.seg[1], ip: cpu.eip & 0xffff,
  ax: cpu.reg[0] & 0xffff, cx: cpu.reg[1] & 0xffff, dx: cpu.reg[2] & 0xffff, bx: cpu.reg[3] & 0xffff,
  sp: cpu.reg[4] & 0xffff, bp: cpu.reg[5] & 0xffff, si: cpu.reg[6] & 0xffff, di: cpu.reg[7] & 0xffff,
  es: cpu.seg[0], ss: cpu.seg[2], ds: cpu.seg[3], fl: cpu.flags & 0xffff,
});

/** Pass A: how many instructions to the trigger, and when the last INT before it was. */
function passA() {
  const mc = fresh(), cpu = mc.cpu, rec = mc.rec;
  let fault = null; mc.onError = (e) => { fault = e; };
  let step = 0, lastInt = 0, trigStep = -1;
  const oSw = mc.swInt.bind(mc); mc.swInt = (n) => { lastInt = step; return oSw(n); };
  for (; step < 20_000_000 && !fault && !cpu.halted; step++) {
    if (cpu.seg[1] === TCS && (cpu.eip & 0xffff) === TIP) { trigStep = step; break; }
    while (cpu.cycles >= mc.nextTimerCycle) mc.serviceTimer();
    try { rec.stepOne(); } catch (e) { fault = e; break; }
  }
  return { trigStep, lastInt, faultMsg: fault && fault.message };
}

const a = passA();
if (a.trigStep < 0) { console.error(`trigger ${TCS.toString(16)}:${TIP.toString(16)} never reached (fault=${a.faultMsg})`); process.exit(2); }
// The window no longer has to avoid INTs. uc-cosim-boot.py vectors them itself and bridges only the
// f000 BIOS stubs from this trace, so the snapshot can sit anywhere — which matters here, because
// IO.SYS init calls the BIOS constantly and the INT-free windows were 50-100 instructions long.
const snapStep = Math.max(0, a.trigStep - SNAPBACK);
console.error(`passA: trigger at step ${a.trigStep} (last INT ${a.lastInt}) -> snapshot at ${snapStep}, window ${a.trigStep - snapStep} instructions`);

/** Pass B: re-run to the snapshot point, dump RAM+CPU, then trace. */
const mc = fresh(), cpu = mc.cpu, rec = mc.rec;
let fault = null; mc.onError = (e) => { fault = e; };
let step = 0;
for (; step < snapStep && !fault && !cpu.halted; step++) {
  while (cpu.cycles >= mc.nextTimerCycle) mc.serviceTimer();
  try { rec.stepOne(); } catch (e) { fault = e; break; }
}
writeFileSync('/tmp/cosim-snap.bin', Buffer.from(mc.mem.u8.buffer, 0, 1 << 20));
writeFileSync('/tmp/cosim-mirage-snap.json', JSON.stringify({
  reg: [...cpu.reg], seg: [...cpu.seg], base: [...cpu.base], eip: cpu.eip, flags: cpu.flags, atStep: step,
}));
const trace = [];
for (let s = 0; s < SNAPBACK + 2000 && !fault && !cpu.halted; s++) {
  trace.push(regs(cpu));
  try { rec.stepOne(); } catch (e) { fault = e; trace.push({ FAULT: e.message }); break; }
}
writeFileSync('/tmp/cosim-mirage-trace.json', JSON.stringify(trace));
console.error(`snapshot at step ${step} (CS:IP=${cpu.seg[1].toString(16)}:${(cpu.eip & 0xffff).toString(16)} at trace start); traced ${trace.length} steps`);
