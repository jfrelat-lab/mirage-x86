// test386-run.mjs — run test386.asm as the BIOS ROM of a bare machine, shared by
// tools/run-test386.mjs (the readable report) and tools/golden.js (the gate: its POST sequence is
// fingerprinted, so a CPU regression only test386 sees can no longer land unnoticed).
//
// Bounded by BLOCKS, never by wall clock, so the same engine always stops at the same place.
import { Machine } from '../src/machine.js';

export function runTest386(rom, { postPort = 0x190, maxBlocks = 40_000_000, irq = false, deadlineMs = Infinity } = {}) {
  const POST_PORT = postPort;
  const mc = new Machine({ memSize: 16 << 20 });
  const cpu = mc.cpu;
  let fault = null; mc.onError = (e) => { fault = e; };

  if (rom.length !== 0x10000) console.log(`note: ROM is ${rom.length} bytes, expected 65536`);
  mc.mem.blit(0x100000 - rom.length, rom);

  // The POST sequence is the whole report: every code it reaches, in order.
  const posts = [];
  mc.onPortWrite(POST_PORT, (_p, _s, v) => posts.push(v & 0xff));
  mc.onPortRead(POST_PORT, () => 0xff);
  // A20 — it will want the full address space on its way to protected mode.
  mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.setMask(mc.mem.mask); });
  mc.onPortRead(0x92, () => (mc.mem.a20 ? 0x02 : 0x00));
  const unhandled = new Map();
  const oR = cpu.ioRead, oW = cpu.ioWrite;
  cpu.ioRead = (p, s) => { if (!mc.portRead[p]) unhandled.set(p, (unhandled.get(p) || 0) + 1); return oR(p, s); };
  cpu.ioWrite = (p, s, v) => { if (!mc.portWrite[p]) unhandled.set(p, (unhandled.get(p) || 0) + 1); return oW(p, s, v); };

  // No timer interrupt. test386 IS the BIOS: it never programs the 8259 or the 8254, so a machine
  // running it has no reason to raise IRQ0 — and in protected mode the PIC's un-remapped IRQ0 lands
  // on vector 8, which is #DF. The harness was injecting one, and test386's stack section (POST 9)
  // does `sti` before a PUSHF to check that IF is captured: the invented interrupt arrived right
  // there and stopped the run four codes early. Set TEST386_IRQ=1 to put it back.
  if (!irq) mc.tickTimer = () => {};

  // DefaultExcHandler and `error` are the SAME address (0xFE7F, test386.asm line 1978-1979), so
  // stopping there says nothing about which it was. Record the exceptions delivered straight into it:
  // if none was, a check failed and jumped there; if one was, that vector is the unexpected fault.
  let unexpected = null;
  const deliver = mc.protInt.bind(mc);
  mc.protInt = (n, err, faultIp, soft) => {
    const r = deliver(n, err, faultIp, soft);
    if ((cpu.eip >>> 0) === 0xfe7f && !unexpected) unexpected = { n, err };
    return r;
  };

  cpu.reg.fill(0);
  cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;       // the reset vector
  cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0);
  cpu.flags = 0x0002;
  cpu.halted = false;

  const t0 = Date.now();
  let blocks = 0;
  while (blocks < maxBlocks && !cpu.halted && !fault && Date.now() - t0 < deadlineMs) blocks += mc.runSlice(20000);
  return { mc, cpu, posts, fault, blocks, unhandled, unexpected, ms: Date.now() - t0 };
}
