// MIRAGE side of the Lemmings co-sim: reach the derail, snapshot RAM+CPU at a pure-CPU point,
// then single-step to the fault logging registers. SNAPBACK env = how many instructions before
// the fault to snapshot (default 4000). Writes /tmp/cosim-snap.bin + /tmp/cosim-mirage.json.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
const ROOT='/Users/julienfrelat/Projects/mirage';
process.env.MIRAGE_NOTIER2='1';
const { Machine } = await import(ROOT+'/src/machine.js');
const { installBIOS } = await import(ROOT+'/src/bios.js');
const { installDOS } = await import(ROOT+'/src/dos.js');
const { VFS } = await import(ROOT+'/src/vfs.js');

function fresh() {
  const mc = new Machine({ memSize: 1<<20 });
  installBIOS(mc);
  try{ mc.font=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x16.bin')); }catch{}
  try{ mc.font8x8=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x8.bin')); }catch{}
  try{ mc.font8x14=new Uint8Array(readFileSync(ROOT+'/assets/vga-rom-8x14.bin')); }catch{}
  const vfs=new VFS(); const dos=installDOS(mc, vfs);
  const G=ROOT+'/games/LEMMINGS';
  (function walk(d){for(const n of readdirSync(d)){const p=join(d,n);statSync(p).isDirectory()?walk(p):vfs.addFile('\\GAMES\\'+relative(ROOT+'/games',p).split('/').join('\\'),new Uint8Array(readFileSync(p)));}})(G);
  vfs.chdir('\\GAMES\\LEMMINGS');
  dos.load(new Uint8Array(readFileSync(G+'/VGALEMMI.EXE')), '/v', 'C:\\GAMES\\LEMMINGS\\VGALEMMI.EXE');
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
  const oSw=mc.swInt.bind(mc); mc.swInt=(n)=>{ lastInt=step; return oSw(n); };
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
