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
const ROOT='/Users/julienfrelat/Projects/mirage';
process.env.MIRAGE_NOTIER2='1';
const { Machine } = await import(ROOT+'/src/machine.js');
const { installBIOS } = await import(ROOT+'/src/bios.js');
const { installDOS } = await import(ROOT+'/src/dos.js');
const { VFS } = await import(ROOT+'/src/vfs.js');

const GAME=process.env.GAME||'LEMMINGS', EXE=process.env.EXE||'VGALEMMI.EXE';
const TAIL=process.env.TAIL||'', MOUNT=process.env.MOUNT||'root';

function fresh() {
  const mc = new Machine({ memSize: 1<<20 });
  installBIOS(mc);
  try{ mc.font=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x16.bin')); }catch{}
  try{ mc.font8x8=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x8.bin')); }catch{}
  try{ mc.font8x14=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x14.bin')); }catch{}
  const vfs=new VFS(); const dos=installDOS(mc, vfs);
  const G=ROOT+'/games/'+GAME;
  const pre = MOUNT==='sub' ? '\\GAMES\\'+GAME+'\\' : '\\';
  (function walk(d){for(const n of readdirSync(d)){const p=join(d,n);statSync(p).isDirectory()?walk(p):vfs.addFile(pre+relative(G,p).split('/').join('\\'),new Uint8Array(readFileSync(p)));}})(G);
  vfs.chdir(pre.replace(/\\$/,'') || '\\');
  dos.load(new Uint8Array(readFileSync(G+'/'+EXE)), TAIL, 'C:'+pre+EXE);
  return { mc, dos };
}
const SNAPBACK = +(process.env.SNAPBACK||4000);
const regs = (cpu,mem)=>({cs:cpu.seg[1],ip:cpu.eip&0xffff, op:mem?[0,1,2,3].map(k=>mem.r8(((cpu.seg[1]<<4)+((cpu.eip+k)&0xffff))&0xfffff)):null, ax:cpu.reg[0]&0xffff,cx:cpu.reg[1]&0xffff,dx:cpu.reg[2]&0xffff,bx:cpu.reg[3]&0xffff,sp:cpu.reg[4]&0xffff,bp:cpu.reg[5]&0xffff,si:cpu.reg[6]&0xffff,di:cpu.reg[7]&0xffff, es:cpu.seg[0],ss:cpu.seg[2],ds:cpu.seg[3], fl:cpu.flags&0xffff});

// Pass A: run to fault, count steps + last INT step
function passA(){
  const { mc, dos } = fresh();
  const cpu=mc.cpu, rec=mc.rec; let fault=null; mc.onError=(e)=>{fault=e;};
  mc.nextTimerCycle=mc.pitReload;
  let step=0, lastInt=0;
  // Every entry into a service, not just swInt: BIOS services now run on inline far-calls to f000:n
  // (0xCF-guarded), which swInt never sees. Missing them put the "pure CPU" snapshot INSIDE a BIOS
  // call, and Unicorn — which has no BIOS — then differed on AX at the IRET. That reads as a CPU
  // divergence and is not one.
  const oSw=mc.swInt.bind(mc); mc.swInt=(n)=>{ lastInt=step; return oSw(n); };
  if (mc.biosCallback) { const oBc=mc.biosCallback.bind(mc); mc.biosCallback=(n)=>{ lastInt=step; return oBc(n); }; }
  for(; step<50_000_000 && !fault && !dos.programDone; step++){
    while(cpu.cycles>=mc.nextTimerCycle) mc.serviceTimer();
    if(mc.blocked){ mc.keyQueue.push({ascii:0x0d}); mc.blocked=false; }
    try{ rec.stepOne(); }catch(e){ fault=e; break; }
  }
  return { faultStep:step, lastInt, faultMsg:fault&&fault.message };
}
const a = passA();
const snapStep = Math.max(a.lastInt+1, a.faultStep - SNAPBACK);
console.error('passA: faultStep=%d lastInt=%d faultMsg=%s -> snapStep=%d (%d before fault)', a.faultStep, a.lastInt, a.faultMsg, snapStep, a.faultStep-snapStep);

// Pass B: run to snapStep, snapshot, then trace to fault (NO more timer INTs after snapshot -> pure CPU window)
const { mc, dos } = fresh();
const cpu=mc.cpu, rec=mc.rec; let fault=null; mc.onError=(e)=>{fault=e;};
mc.nextTimerCycle=mc.pitReload;
let step=0;
for(; step<snapStep && !fault; step++){
  while(cpu.cycles>=mc.nextTimerCycle) mc.serviceTimer();
  if(mc.blocked){ mc.keyQueue.push({ascii:0x0d}); mc.blocked=false; }
  try{ rec.stepOne(); }catch(e){ fault=e; break; }
}
// snapshot
writeFileSync('/tmp/cosim-snap.bin', Buffer.from(mc.mem.u8.buffer, 0, 1<<20));
const snap = { reg:[...cpu.reg], seg:[...cpu.seg], base:[...cpu.base], eip:cpu.eip, flags:cpu.flags, atStep:step };
writeFileSync('/tmp/cosim-mirage-snap.json', JSON.stringify(snap));
// trace from snapshot to fault, timer DISABLED (pure CPU)
const trace=[];
for(let s=0; s<SNAPBACK+2000 && !fault && !dos.programDone; s++){
  if(mc.blocked){ mc.keyQueue.push({ascii:0x0d}); mc.blocked=false; }
  trace.push(regs(cpu, mc.mem));
  try{ rec.stepOne(); }catch(e){ fault=e; trace.push({FAULT:e.message}); break; }
}
writeFileSync('/tmp/cosim-mirage-trace.json', JSON.stringify(trace));
console.error('snapshot at step %d; traced %d steps; final fault=%s', step, trace.length, fault&&fault.message);
console.error('snap CS:IP=%s:%s', snap.seg[1].toString(16), (snap.eip&0xffff).toString(16));
