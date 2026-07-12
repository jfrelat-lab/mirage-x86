// trace.js — dynamic execution tracer / analyzer for debugging the emulator against real
// programs. MIRAGE already decodes x86 into a readable JS `body` per basic block; this steps
// execution one basic block at a time (tier-1 forced, so 1 step = 1 block) and lets you:
//
//   node tools/trace.js <prog> --watch=0xLIN [--hits=N] [--ticks=N] [--per=N]
//       Report every block that CHANGES the byte at linear address LIN — with the old→new
//       value, CPU registers at that point, and the block's decoded body. Finds who writes
//       a given pixel/variable (works through inlined u8[] stores: it diffs, doesn't hook).
//
//   node tools/trace.js <prog> --dump=0xLIN [--ip=0xIP] [--ticks=N]
//       Run, then print the decoded body of the cached block at linear address LIN.
//
// Tier-2 is disabled so each step is one basic block and every block has a readable body.
process.env.MIRAGE_NOTIER2 = '1';
import { readFileSync } from 'fs';
const { Machine } = await import('../src/machine.js');
const { installBIOS } = await import('../src/bios.js');
const { installDOS } = await import('../src/dos.js');
const { VFS } = await import('../src/vfs.js');

const args = process.argv.slice(2);
const prog = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const num = (k, d) => { const v = opt(k, null); return v == null ? d : (v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10)); };
if (!prog) { console.error('usage: node tools/trace.js <prog> --watch=0xLIN | --dump=0xLIN'); process.exit(2); }

const watch = num('watch', null), dump = num('dump', null);
const HITS = num('hits', 6), TICKS = num('ticks', 400), PER = num('per', 200000);

const mc = new Machine({ memSize: 1 << 20 });
installBIOS(mc); const dos = installDOS(mc, new VFS());
const cpu = mc.cpu, rec = mc.rec, u8 = mc.mem.u8, MM = mc.mem.mask;
let fault = null; mc.onError = (e) => { fault = e; };
dos.load(new Uint8Array(readFileSync(prog)), '', 'C:\\PROG');

const regs = () => `AX=${(cpu.ax).toString(16)} BX=${cpu.bx.toString(16)} CX=${cpu.cx.toString(16)} DX=${cpu.dx.toString(16)} SI=${cpu.si.toString(16)} DI=${cpu.di.toString(16)} BP=${cpu.bp.toString(16)} DS=${cpu.seg[3].toString(16)} ES=${cpu.seg[0].toString(16)}`;
const blkAt = () => { const ip0 = cpu.eip & 0xffff, lin = (cpu.base[1] + ip0) & MM; const pg = rec.blockPages[lin >>> 12]; return pg ? pg[lin & 0xfff] : undefined; };

let hits = 0, steps = 0;
outer:
for (let t = 0; t < TICKS && !fault && !cpu.halted && !dos.programDone; t++) {
  for (let i = 0; i < PER && !cpu.halted && !dos.programDone; i++) {
    const before = watch != null ? u8[watch & MM] : 0;
    const b = blkAt();                    // the block about to run (has its decoded body)
    const csip = ((cpu.base[1] >>> 4) & 0xffff).toString(16) + ':' + (cpu.eip & 0xffff).toString(16);
    try { rec.step(); } catch (e) { fault = e; break outer; }
    steps++;
    if (watch != null && u8[watch & MM] !== before) {
      console.log(`\n#${hits + 1} @ ${csip} (step ${steps}): [0x${(watch & MM).toString(16)}] ${before.toString(16)} -> ${u8[watch & MM].toString(16)}`);
      console.log('  ' + regs());
      if (b && b.body) console.log('  --- decoded block ---\n' + b.body.split('\n').map((l) => '    ' + l).join('\n'));
      if (++hits >= HITS) break outer;
    }
  }
  mc.tickTimer();
}
console.log(`\n[trace] ${steps} blocks, ${hits} watch-hits, fault=${fault ? fault.message : 'none'}`);

if (dump != null) {
  const pg = rec.blockPages[(dump & MM) >>> 12]; const b = pg ? pg[(dump & MM) & 0xfff] : undefined;
  if (b && b.body) console.log(`\n=== block @ 0x${(dump & MM).toString(16)} ===\n` + b.body); else console.log(`no cached block at 0x${(dump & MM).toString(16)}`);
}
