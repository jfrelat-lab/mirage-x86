// trace-diff.mjs — the first DIVERGENT BLOCK between two configurations of the same engine.
//
//   node tools/trace-diff.mjs <prog.com> <out.txt>        # run once per configuration, then diff
//   MIRAGE_LOCKUD=1 node tools/trace-diff.mjs <prog.com> <out2.txt>
//   diff <(head -N out.txt) out2.txt
//
// The other two debuggers answer different questions. `tools/trace.js` steps block by block and can
// watch an address or dump a block's decoded body; `tools/cosim/` single-steps MIRAGE against
// Unicorn and diffs registers per instruction. Neither compares MIRAGE against ITSELF, which is what
// a behaviour flag needs: same program, same engine, one env var changed.
//
// Records ip0 PLUS a register fingerprint per block. An ip-only trace says where the paths parted;
// it does not say that the state had already drifted while the path still matched, which is the
// usual case and the one that misleads.
//
// ⚠️ Do not set MIRAGE_NOTIER2 or MIRAGE_KEEP_SRC here to get readable bodies: both change block
// boundaries, so the trace you compare is no longer the run you are debugging.
import { readFileSync, writeFileSync } from 'fs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { VFS } = await import(ROOT + '/src/vfs.js');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const img = new Uint8Array(readFileSync(process.argv[2]));
const vfs = new VFS(); vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });
dos.load(img, '', 'C:\\PROG.COM');
const cpu = mc.cpu, rec = mc.rec;
const hex = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');

const trace = [];
const LIMIT = Number(process.env.TRACE_N) || 400000;
// ⚠️ ONE BLOCK PER STEP, via runSlice(1). `rec.run` is called once per SLICE — it loops over blocks
// internally — so hooking it records one entry per slice, not per block. A first version of this file
// did exactly that, labelled the entries "blocks", and a divergence reported as "block 14" was really
// "somewhere inside slice 14", up to 2000 blocks wide.
const oldRun = rec.run.bind(rec);
rec.run = (...a) => {
  if (trace.length < LIMIT) {
    trace.push(`${hex(cpu.seg[1])}:${hex(cpu.eip & 0xffff)} ` +
      `a=${hex(cpu.reg[0] & 0xffff)} b=${hex(cpu.reg[3] & 0xffff)} c=${hex(cpu.reg[1] & 0xffff)} ` +
      `d=${hex(cpu.reg[2] & 0xffff)} si=${hex(cpu.reg[6] & 0xffff)} di=${hex(cpu.reg[7] & 0xffff)} ` +
      `sp=${hex(cpu.reg[4] & 0xffff)} f=${hex(cpu.flags & 0xfff)}`);
  }
  return oldRun(...a);
};
try { let n = 0; while (n++ < LIMIT && !dos.programDone && trace.length < LIMIT) mc.runSlice(1); }
catch (e) { /* the flag-on run dies; the trace up to that point is what matters */ }
writeFileSync(process.argv[3], trace.join('\n') + '\n');
console.log(`${trace.length} blocks -> ${process.argv[3]}`);
