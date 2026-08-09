// browser-loop.mjs — run a program under a faithful copy of ui.js's animation-frame loop, in Node.
//
// The browser pane in this session stays document.hidden, so requestAnimationFrame never fires and
// the real loop cannot be measured there. Rather than measure something else and call it the same
// thing, this reproduces the loop exactly: the same FRAME_BUDGET_MS cap, the same per-frame virtual
// cycle budget, the same "at most one PIT tick per inner iteration", the same 20000-cycle slice, and
// a real wall clock for both the tick pacing and the 0x3DA beam. A ~60 Hz timer stands in for rAF.
//
//   VCPU=8000000 node browser-loop.mjs demos/CPUSPEED.COM
//   VCPU=0 node browser-loop.mjs demos/CPUSPEED.COM     # 0 = uncapped, today's default

const ROOT = process.env.ROOT || '/Users/julienfrelat/Projects/mirage';
const prog = process.argv[2] || 'demos/CPUSPEED.COM';
const VCPU = Number(process.env.VCPU || 0) || null;      // null = uncapped
const TICK_MS = 1000 / 18.2065, FRAME_BUDGET_MS = 12;

const { readFileSync } = await import('fs');
const { Machine } = await import(`${ROOT}/src/machine.js`);
const { installBIOS } = await import(`${ROOT}/src/bios.js`);
const { installDOS } = await import(`${ROOT}/src/dos.js`);
const { VFS } = await import(`${ROOT}/src/vfs.js`);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const mc = new Machine({ memSize: 16 << 20 });
mc.timerAuto = false;                 // the loop paces the PIT to wall-clock, as ui.js does
mc.vcpuHz = VCPU;
mc.wallClockMs = now;                 // anchors the 0x3DA beam to real time
installBIOS(mc);
const vfs = new VFS();
const dos = installDOS(mc, vfs);
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(`${ROOT}/${prog}`)), '', 'C:\\PROG');

let lastTick = now(), lastLoop = now();
const started = now();

function frame() {
  const t = now();
  const tickMs = Math.max(3, TICK_MS * (mc.pitReload / 0x10000));
  if (t - lastTick > 250) lastTick = t;
  let dt = t - lastLoop; if (dt > 50 || dt < 0) dt = 50;
  lastLoop = t;
  const cycleBudget = VCPU ? Math.max(1, (VCPU * dt / 1000) | 0) : Infinity;
  const cyc0 = mc.cpu.cycles;
  let w = t;
  while (w - t < FRAME_BUDGET_MS) {
    if (w - lastTick >= tickMs) { mc.tickTimer(); lastTick += tickMs; }
    const slice = Math.min(20000, cycleBudget - (mc.cpu.cycles - cyc0));
    if (slice <= 0) break;
    mc.runSlice(slice);
    if (mc.blocked || dos.programDone || mc.cpu.halted) break;
    w = now();
  }
}

const timer = setInterval(() => {
  frame();
  if (dos.programDone || fault || now() - started > 30000) {
    clearInterval(timer);
    const out = vfs.readFile('C:\\SPEED.TXT');
    const units = out ? String(Buffer.from(out)).trim() : '<no result>';
    const secs = (now() - started) / 1000;
    console.log(`${(VCPU ? (VCPU / 1e6) + ' MHz cap' : 'uncapped').padEnd(16)} ${String(units).padStart(7)} units` +
      `   (ran ${secs.toFixed(1)}s, ${(mc.cpu.cycles / secs / 1e6).toFixed(1)} Mcycles/s${fault ? ', FAULT ' + fault : ''})`);
  }
}, 16);
