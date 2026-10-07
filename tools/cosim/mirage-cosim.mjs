// MIRAGE side of the DOS-program co-sim: reach the derail, snapshot RAM+CPU at a pure-CPU point,
// then single-step to the fault logging registers. Writes /tmp/cosim-snap.bin + /tmp/cosim-mirage.json.
//
// Parameterised rather than edited per game, which is how it was used before — one derail per copy
// of the file loses the previous wiring every time.
//   GAME=TURBOPAS EXE=TURBO.EXE node tools/cosim/mirage-cosim.mjs
//   GAME=LEMMINGS EXE=VGALEMMI.EXE TAIL=/v MOUNT=sub node tools/cosim/mirage-cosim.mjs
// MOUNT=sub keeps the old \GAMES\<NAME>\ layout; the default mounts the game AS the root of C:,
// which is what src/shell.js now gives a program and what the reference runs.
// SNAPBACK = instructions before the fault to snapshot (default 4000).
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
const ROOT=new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
process.env.MIRAGE_NOTIER2='1';
const { VFS } = await import(ROOT+'/src/vfs.js');
const { makeMachine } = await import(ROOT+'/tools/harness.mjs');

const GAME=process.env.GAME||'LEMMINGS', EXE=process.env.EXE||'VGALEMMI.EXE';
const TAIL=process.env.TAIL||'', MOUNT=process.env.MOUNT||'root';

function fresh() {
  // Through makeMachine, like every other game-level tool. Building a machine here instead — 1 MiB,
  // no mouse, no ROM fonts — reproduced a DIFFERENT guest: Mystic Towers ran 50 M instructions
  // without terminating, where the real harness has it exit on a #DE after 0.16 M. A co-sim of a
  // program that behaves differently answers nothing. (harness.mjs exists for exactly this; only
  // the instruction-level tools should build bare machines.)
  const vfs = new VFS();
  const G = ROOT + '/games/' + GAME;
  const pre = MOUNT === 'sub' ? '\\GAMES\\' + GAME + '\\' : '\\';
  (function walk(d){for(const n of readdirSync(d)){const p=join(d,n);statSync(p).isDirectory()?walk(p):vfs.addFile(pre+relative(G,p).split('/').join('\\'),new Uint8Array(readFileSync(p)));}})(G);
  vfs.chdir(pre.replace(/\\$/,'') || '\\');
  const { mc, dos } = makeMachine({ vfs });
  dos.load(new Uint8Array(readFileSync(G + '/' + EXE)), TAIL, 'C:' + pre + EXE);
  return { mc, dos };
}

const SNAPBACK = +(process.env.SNAPBACK||4000);
const STOPINT = process.env.STOPINT === undefined ? -1 : Number(process.env.STOPINT);
// Stop at an ADDRESS, not only at a fault or an INT. A program that produces the WRONG OUTPUT never
// faults, so there is nothing for the fault trigger to catch — Dune's decompressor draws a scrambled
// picture and runs on perfectly happily. STOPTICK gets us cheaply into the neighbourhood (BIOS ticks,
// coarse slices), then STOPAT single-blocks until CS:IP matches, HITS times.
//   STOPTICK=4100 STOPAT=23a2:1074 HITS=200 GAME=DUNE EXE=DUNEDEM.EXE …
const STOPAT = process.env.STOPAT ? process.env.STOPAT.split(':').map((x) => parseInt(x, 16)) : null;
const STOPTICK = process.env.STOPTICK ? Number(process.env.STOPTICK) : 0;
const HITS = Number(process.env.HITS || 1);
const STOPPED = { stopped: 1 };
const regs = (cpu,mem)=>({cs:cpu.seg[1],ip:cpu.eip&0xffff, op:mem?[0,1,2,3].map(k=>mem.r8(((cpu.seg[1]<<4)+((cpu.eip+k)&0xffff))&0xfffff)):null, ax:cpu.reg[0]&0xffff,cx:cpu.reg[1]&0xffff,dx:cpu.reg[2]&0xffff,bx:cpu.reg[3]&0xffff,sp:cpu.reg[4]&0xffff,bp:cpu.reg[5]&0xffff,si:cpu.reg[6]&0xffff,di:cpu.reg[7]&0xffff, es:cpu.seg[0],ss:cpu.seg[2],ds:cpu.seg[3], fl:cpu.flags&0xffff});

// Pass A runs on the PRODUCTION path (runSlice), not stepOne. A hand-rolled stepOne loop is not the
// same guest: Mystic Towers ran 50 M instructions without terminating under it, where runSlice has it
// raise #DE after 0.16 M. Pass A only needs WHERE to stop, expressed in cycles; the instruction-level
// trace still uses stepOne, over the short pure-CPU window where the two agree.
function passA(){
  const { mc, dos } = fresh();
  const cpu=mc.cpu; let fault=null; mc.onError=(e)=>{fault=e;};
  let stopCycles=-1, lastIntCycles=0;
  const oSw=mc.swInt.bind(mc);
  // The stopping vector must not count as a service entry, and pass A must END there — letting it
  // run on updated lastInt past the point of interest and made the window negative.
  mc.swInt=(n,ni,fi)=>{ if(n===STOPINT){ stopCycles=cpu.cycles; throw STOPPED; } lastIntCycles=cpu.cycles; return oSw(n,ni,fi); };
  if (mc.biosCallback) { const oBc=mc.biosCallback.bind(mc); mc.biosCallback=(n)=>{ lastIntCycles=cpu.cycles; return oBc(n); }; }
  const bios = () => (mc.mem.r16(0x46c) | (mc.mem.r16(0x46e) << 16)) >>> 0;
  let g=0;
  while(stopCycles<0 && !fault && !dos.programDone && g++<200000){
    if (STOPAT && bios() >= STOPTICK) {                       // in the neighbourhood: one block at a time
      let hit = 0;
      while (stopCycles < 0 && !fault && !dos.programDone && g++ < 20000000) {
        try { mc.runSlice(1); } catch (e) { if (e === STOPPED) break; fault = e; break; }
        if (cpu.seg[1] === STOPAT[0] && (cpu.eip & 0xffff) === STOPAT[1] && ++hit >= HITS) stopCycles = cpu.cycles;
      }
      break;
    }
    try{ mc.runSlice(2000); }catch(e){ if(e===STOPPED) break; fault=e; break; }
  }
  return { stopCycles: stopCycles<0 ? cpu.cycles : stopCycles, lastIntCycles,
           why: stopCycles>=0 ? (STOPAT ? `reached ${process.env.STOPAT} (hit ${HITS})` : `INT ${STOPINT} raised`) : fault ? fault.message : dos.programDone ? 'program exited' : 'budget' };
}
const a = passA();
const snapCycles = Math.max(a.lastIntCycles+1, a.stopCycles - SNAPBACK);
console.error('passA: stop at %d cycles (%s), lastInt at %d -> snapshot at %d (%d cycles before)',
  a.stopCycles, a.why, a.lastIntCycles, snapCycles, a.stopCycles-snapCycles);

// Pass B: production path up to the snapshot, then instruction-level tracing from there.
const { mc, dos } = fresh();
const cpu=mc.cpu, rec=mc.rec; let fault=null; mc.onError=(e)=>{fault=e;};
let stopped=false;
if (STOPINT >= 0) { const o=mc.swInt.bind(mc); mc.swInt=(n,ni,fi)=>{ if(n===STOPINT){ stopped=true; throw STOPPED; } return o(n,ni,fi); }; }
let g=0;
// runSlice takes a BLOCK budget, so a slice of 200 blows straight past a 42-instruction window.
// Coarse until close, then one block at a time.
//
// And NO tickTimer() in either pass: the run loop owns the PIT. Calling it per slice made the tick
// cadence depend on the SLICE SIZE, so pass A (slices of 2000) and pass B (slices of 1 near the
// target) were two different guests and never met at the same cycle.
while(cpu.cycles<snapCycles && !fault && !dos.programDone && !stopped && g++<2000000){
  try{ mc.runSlice(cpu.cycles < snapCycles-2000 ? 200 : 1); }catch(e){ if(e===STOPPED) break; fault=e; break; }
}
let step=0;
// snapshot
writeFileSync('/tmp/cosim-snap.bin', Buffer.from(mc.mem.u8.buffer, 0, 1<<20));
const snap = { reg:[...cpu.reg], seg:[...cpu.seg], base:[...cpu.base], eip:cpu.eip, flags:cpu.flags, atStep:step };
writeFileSync('/tmp/cosim-mirage-snap.json', JSON.stringify(snap));
// trace from snapshot to fault, timer DISABLED (pure CPU)
const trace=[];
for(let s=0; s<SNAPBACK+2000 && !fault && !dos.programDone; s++){
  if(mc.blocked){ mc.keyQueue.push({ascii:0x0d}); mc.blocked=false; }
  trace.push(regs(cpu, mc.mem));
  try{ rec.stepOne(); }catch(e){ if(e===STOPPED){ trace.push({FAULT:`INT ${STOPINT} raised`}); break; } fault=e; trace.push({FAULT:e.message}); break; }
}
writeFileSync('/tmp/cosim-mirage-trace.json', JSON.stringify(trace));
console.error('snapshot at step %d; traced %d steps; final fault=%s', step, trace.length, fault&&fault.message);
console.error('snap CS:IP=%s:%s', snap.seg[1].toString(16), (snap.eip&0xffff).toString(16));
