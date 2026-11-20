// mirage-ref.mjs — the oracle for tools/recomp: run a .COM intro on MIRAGE's dynamic recompiler and
// record, at every read of port 0x60 (the keyboard poll both intros make once per frame, after the
// blit), the guest instruction count and the frame: mode-13h framebuffer and DAC.
//
//   node tools/recomp/mirage-ref.mjs intros/tube.com --frames=200 [--out=ref.json] [--dump=dir]
//
// The machine is composed as tools/bench.js composes it (1 MiB, BIOS, DOS, timerAuto off), so the
// timer ISR does not run in the middle of the counts. It also reports the entry state (registers,
// segments, flags) so the translated program starts where MIRAGE's does.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { Machine } from '../../src/machine.js';
import { installBIOS } from '../../src/bios.js';
import { installDOS } from '../../src/dos.js';
import { VFS } from '../../src/vfs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The frame a hash names: 64,000 bytes of A000 and the 768 of the DAC (6-bit, MIRAGE's layout). */
export const frameHash = (fb, dac) => createHash('sha1').update(fb).update(dac).digest('hex');

export function mirageFrames(path, frames, { dump = null, keep = false, onPoll = null, maxCycles = Infinity } = {}) {
  const mc = new Machine({ memSize: 1 << 20 });
  mc.timerAuto = false;
  installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(new Uint8Array(readFileSync(path)), '', 'C:\\PROG');
  const cpu = mc.cpu;
  const entry = { reg: Array.from(cpu.reg.slice(0, 8), (v) => v & 0xffff), seg: Array.from(cpu.seg.slice(0, 6)), eip: cpu.eip, flags: cpu.flags };
  const out = [];
  const prev = mc.portRead[0x60];
  let stop = false;
  mc.onPortRead(0x60, (p, s) => {
    const v = prev ? prev(p, s) : 0xff;
    if (onPoll) { onPoll(); out.push({ cycles: cpu.cycles, key: v & 0xff }); if (out.length >= frames) stop = true; return v; }
    const fb = mc.mem.u8.subarray(0xa0000, 0xa0000 + 64000);
    const dac = Buffer.from(mc.bios.dac.buffer, mc.bios.dac.byteOffset, 768);
    out.push({ cycles: cpu.cycles, hash: frameHash(fb, dac), key: v & 0xff, ...(keep ? { fb: Buffer.from(fb), dac: Buffer.from(dac) } : {}) });
    if (dump) writeFileSync(join(dump, `f${String(out.length).padStart(4, '0')}.bin`), Buffer.concat([Buffer.from(fb), dac]));
    if (out.length >= frames) stop = true;
    return v;
  });
  while (!stop && !fault && !dos.programDone && cpu.cycles < maxCycles) mc.runSlice(20000);
  return { entry, frames: out, fault: fault ? String(fault.message) : null, mc };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const file = args.find((a) => !a.startsWith('--'));
  const dump = opt('dump', null);
  if (dump) mkdirSync(dump, { recursive: true });
  const r = mirageFrames(resolve(ROOT, file), +opt('frames', 100), { dump });
  const o = opt('out', null);
  if (o) writeFileSync(o, JSON.stringify({ entry: r.entry, frames: r.frames, fault: r.fault }, null, 1));
  console.log(JSON.stringify(r.entry));
  for (let i = 0; i < Math.min(5, r.frames.length); i++) console.log(i + 1, r.frames[i]);
  console.log(`${r.frames.length} frames, last at ${r.frames.at(-1)?.cycles} instructions${r.fault ? ' FAULT ' + r.fault : ''}`);
}
