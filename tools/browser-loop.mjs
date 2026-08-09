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
const TICK_MS = 1000 / 18.2065;
// Default 12 ms = the browser loop's real allowance. Raise it to compare ENGINE against ENGINE
// (DOSBox in these runs is not giving up the CPU to a compositor, so 12/16.7 handicaps MIRAGE).
const FRAME_BUDGET_MS = Number(process.env.BUDGET_MS || 12);

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
// Count 0x3DA reads: a vsync-locked intro polls it constantly and its animation rate is then fixed
// at 70 Hz whatever the CPU speed; a raw-speed-bound one never touches it and scales with cycles.
// Hook cpu.ioRead, not machine.portRead[]: the run loop captures the port tables, so a late
// replacement of one entry is not observed. Must be installed before any block is translated.
// Count EVERY port read, not just 0x3DA. A previous version counted only 0x3DA, reported 0, and
// gave me no way to tell "this program never polls vsync" from "my hook is not wired up" — the
// control that was missing. The per-port total is that control.
let vsyncPolls = 0; const portHits = new Map();
const _oR = mc.cpu.ioRead;
mc.cpu.ioRead = (p, sz) => {
  portHits.set(p, (portHits.get(p) || 0) + 1);
  if (p === 0x3da || p === 0x3ba) vsyncPolls++;
  return _oR(p, sz);
};
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

let frames = 0, busyMs = 0;
const timer = setInterval(() => {
  const _b = now(); frame(); busyMs += now() - _b; frames++;
  if (dos.programDone || fault || now() - started > (Number(process.env.SECS || 0) * 1000 || 30000)) {
    clearInterval(timer);
    const out = vfs.readFile('C:\\SPEED.TXT');
    const units = out ? String(Buffer.from(out)).trim() : '<no result>';
    const secs = (now() - started) / 1000;
    let fb = 0; const vm = mc.mem.u8; for (let i = 0xa0000; i < 0xa0000 + 64000; i += 7) fb = (fb * 31 + vm[i]) >>> 0;
    console.log(`${(VCPU ? (VCPU / 1e6) + ' MHz cap' : 'uncapped').padEnd(16)} ${String(units).padStart(7)} units` +
      `  vsyncPolls=${String(vsyncPolls).padStart(9)}  fbHash=${fb.toString(16).padStart(8,'0')}` +
      `  frameCPU=${(busyMs / frames).toFixed(1)}ms/16.7ms` +
      `  ports[${[...portHits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([p,n])=>'0x'+p.toString(16)+':'+n).join(' ') || 'NONE — HOOK IS DEAD'}]` +
      `  (${secs.toFixed(1)}s, ${(mc.cpu.cycles / secs / 1e6).toFixed(1)} Mcyc/s${fault ? ', FAULT ' + fault : ''})`);
  }
}, 16);
