// cr0.mjs — every PE transition mesha makes, in both configurations. The DPMI branch renders and the
// XMS branch draws nothing (docs/TIMING.md §14h), and PMODE4K services interrupts by dropping back to
// REAL mode rather than handling them in PM — so the switching itself is what to look at. cpu.setCR0
// is the single writer, so one hook sees them all.
import { readFileSync } from 'fs';
import { makeMachine } from '/Users/julienfrelat/Projects/mirage/tools/harness.mjs';

const MAX = Number(process.env.MAXLOG) || 40;

function run(label, opts) {
  const { mc, dos } = makeMachine(opts);
  let fault = null; mc.onError = (e) => { fault = e; };
  const cpu = mc.cpu, log = [];
  let n = 0;
  const set = cpu.setCR0.bind(cpu);
  cpu.setCR0 = (v) => {
    const was = cpu.cr0 >>> 0, now = v >>> 0;
    if ((was & 1) !== (now & 1)) {                       // PE changed: that is the switch
      n++;
      if (log.length < MAX) {
        const lin = (cpu.base[1] + (cpu.csD ? (cpu.eip >>> 0) : (cpu.eip & 0xffff))) >>> 0;
        log.push(`#${String(n).padStart(3)} PE ${was & 1}->${now & 1}  cr0 ${was.toString(16)}->${now.toString(16)}` +
          `  a lin=${lin.toString(16)} CS.D=${cpu.csD} cpl=${cpu.cpl}` +
          `  gdt=${(cpu.gdtr.base >>> 0).toString(16)}/${cpu.gdtr.limit.toString(16)}` +
          `  cyc=${cpu.cycles}`);
      }
    }
    return set(v);
  };
  dos.load(new Uint8Array(readFileSync('intros/mesha.com')), '', 'C:\\PROG');
  let t = 0;
  for (; t < 400 && !fault && !dos.programDone; t++) mc.runSlice(400000);
  console.log(`\n=== ${label}: ${n} bascules PE, ${t} ticks, termine=${dos.programDone}, faute=${fault ? fault.message : '-'}`);
  for (const l of log) console.log('   ' + l);
  if (n > log.length) console.log(`   ... (${n - log.length} de plus)`);
  return { n, log };
}

const a = run('DPMI + XMS (rend l image)', {});
const b = run('XMS seul (ecran noir)', { dpmi: false });
let i = 0; while (i < a.log.length && i < b.log.length &&
  a.log[i].replace(/cyc=\d+/, '') === b.log[i].replace(/cyc=\d+/, '')) i++;
console.log(`\n=== les deux sequences divergent a la bascule #${i + 1}`);
console.log(`   DPMI: ${a.log[i] || '(fin)'}`);
console.log(`   XMS : ${b.log[i] || '(fin)'}`);
