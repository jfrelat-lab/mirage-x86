// tput.mjs — emulated throughput, in guest cycles per wall-second.
//
// Blocks-per-slice is a misleading unit: a tier-2 region loops internally and still counts as one
// block, so "1 block in 34 ms" says nothing about whether the engine is slow. Guest cycles per wall
// second is the number that maps to what a user sees (a 386-33 is ~33M cycles/s; DOSBox's default
// 3000 cycles/ms is 3M/s).
//
//   ROOT=<tree> SECS=2 node tput.mjs intros/tube.com

const ROOT = process.env.ROOT;
const prog = process.argv[2] || 'intros/tube.com';
const SECS = Number(process.env.SECS) || 2;
const AUTO = process.env.TIMER_AUTO === '1';        // 1 = like the browser (PIT paced), 0 = raw
const { readFileSync } = await import('fs');

const { Machine } = await import(`${ROOT}/src/machine.js`);
const { installBIOS } = await import(`${ROOT}/src/bios.js`);
const { installDOS } = await import(`${ROOT}/src/dos.js`);
const { VFS } = await import(`${ROOT}/src/vfs.js`);

const mc = new Machine({ memSize: 1 << 20 });
mc.timerAuto = AUTO;
installBIOS(mc);
const dos = installDOS(mc, new VFS());
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(`${ROOT}/${prog}`)), '', 'C:\\PROG');

const step = () => { mc.runSlice(100_000); if (!AUTO) mc.tickTimer(); };
for (let i = 0; i < 200; i++) step();                                  // warm up / let V8 tier up

const c0 = mc.cpu.cycles, t0 = process.hrtime.bigint();
let iters = 0;
while (Number(process.hrtime.bigint() - t0) / 1e9 < SECS) { step(); iters++; }
const secs = Number(process.hrtime.bigint() - t0) / 1e9;
const cyc = mc.cpu.cycles - c0;

console.log(`${ROOT.split('/').pop().padEnd(10)} ${(cyc / secs / 1e6).toFixed(2).padStart(8)} Mcycles/s   ` +
  `(${iters} slices in ${secs.toFixed(2)}s, ${(iters / secs).toFixed(0)} slices/s)${fault ? '  FAULT: ' + fault : ''}`);
