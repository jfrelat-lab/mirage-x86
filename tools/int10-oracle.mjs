// int10-oracle.mjs — diff our INT 10h against a REAL VGA BIOS ROM, call by call.
//
//   node tools/int10-oracle.mjs boot/vgabios-stdvga.bin
//   node tools/int10-oracle.mjs boot/vgabios-stdvga.bin dac      # only cases whose name matches
//
// tools/vga-rom.mjs established the method — load SeaVGABIOS at C000:0, let the POST take the INT 10h
// vector, and compare the device state a real mode-set leaves against ours. This generalises it from
// one mode-set into a CASE TABLE, so every service we implement can be asked the same question:
// registers out, device state, and the bytes a call writes to memory.
//
// It exists because of a defect no other gate could see. INT 10h AH=10h AL=12h took the starting DAC
// register from BX, where hardware takes BL — port 0x3C8 is eight bits wide. `intros/mesha.com` calls
// it with BX = 0x100 and BL = 0, so its whole palette upload silently did nothing and every frame it
// drew was the wrong colour (docs/notes/2026-09-05-mesha.md). golden was 43/43 through the fix, conformance is a CPU
// oracle and never touches INT 10h, and test-dos-api.js compares our BIOS against itself. Only a real
// ROM can answer "what does this call actually do".
//
// Each case runs on TWO fresh machines: one with the ROM POSTed (the vector points into C000, so the
// guest's `int 10h` runs real 16-bit code against our device model) and one plain (the vector points
// at f000:10, so it reaches our JS handler). Same registers in, same memory in, diff everything out.
import { readFileSync } from 'fs';
import { makeMachine } from './harness.mjs';

const romPath = process.argv[2] || 'boot/vgabios-stdvga.bin';
const filter = process.argv[3] || '';
const rom = new Uint8Array(readFileSync(romPath));

const BUF = 0x30000;             // ES:DX scratch, well clear of the BIOS and of video memory
const STUB = 0x50000;            // where the `int 10h ; hlt` stub is planted

// A palette that is obviously not the power-on DAC, so a call that silently does nothing shows up.
const SRC = new Uint8Array(768);
for (let i = 0; i < 256; i++) { SRC[i * 3] = i & 63; SRC[i * 3 + 1] = (i * 5) & 63; SRC[i * 3 + 2] = (63 - i) & 63; }

const CASES = [
  { name: 'mode-13h', seq: [{ ax: 0x0013 }] },
  { name: 'mode-12h', seq: [{ ax: 0x0012 }] },
  { name: 'mode-03h', seq: [{ ax: 0x0003 }] },
  { name: 'get-mode-0Fh', seq: [{ ax: 0x0013 }, { ax: 0x0f00 }] },
  { name: 'dac-set-one-1010h', seq: [{ ax: 0x0013 }, { ax: 0x1010, bx: 0x0005, dx: 0x2a00, cx: 0x1508 }] },
  // The case that motivated the tool: BX = 0x100, BL = 0. Hardware writes BL to the eight-bit port
  // 0x3C8, so this must set 256 registers starting at 0 — not fail, and not start at 256.
  { name: 'dac-set-block-1012h-bx0100', seq: [{ ax: 0x0013 }, { ax: 0x1012, bx: 0x0100, cx: 0x0100, dx: BUF & 0xf, es: BUF >> 4 }], src: true },
  { name: 'dac-set-block-1012h-bx0002', seq: [{ ax: 0x0013 }, { ax: 0x1012, bx: 0x0002, cx: 0x0010, dx: BUF & 0xf, es: BUF >> 4 }], src: true },
  { name: 'dac-get-block-1017h-bx0100', seq: [{ ax: 0x0013 }, { ax: 0x1017, bx: 0x0100, cx: 0x0100, dx: BUF & 0xf, es: BUF >> 4 }], out: 768 },
  { name: 'dac-get-block-1017h-bx0002', seq: [{ ax: 0x0013 }, { ax: 0x1017, bx: 0x0002, cx: 0x0010, dx: BUF & 0xf, es: BUF >> 4 }], out: 48 },
  { name: 'attr-set-one-1000h', seq: [{ ax: 0x0003 }, { ax: 0x1000, bx: 0x0c03 }] },
  { name: 'attr-set-all-1002h', seq: [{ ax: 0x0003 }, { ax: 0x1002, dx: BUF & 0xf, es: BUF >> 4 }], src: true },
  { name: 'border-0Bh', seq: [{ ax: 0x0003 }, { ax: 0x0b00, bx: 0x0004 }] },
  { name: 'ega-info-12h-BL10', seq: [{ ax: 0x1200, bx: 0x0010 }] },
];

function boot(withRom) {
  const { mc } = makeMachine({ dos: false });
  let fault = null; mc.onError = (e) => { fault = e; };
  if (withRom) {
    mc.mem.blit(0xc0000, rom);
    mc.mem.w8(0x7c00, 0xf4);                                  // HLT for the POST's far RET
    mc.cpu.reg.fill(0);
    mc.cpu.setSeg(2, 0x9000); mc.cpu.sp = 0xfff0;
    mc.cpu.setSeg(3, 0); mc.cpu.setSeg(0, 0);
    mc.cpu.flags = 0x0202;
    mc.cpu.push16(0x0000); mc.cpu.push16(0x7c00);
    mc.cpu.setSeg(1, 0xc000); mc.cpu.eip = 0x0003; mc.cpu.halted = false;
    const t0 = Date.now();
    while (!mc.cpu.halted && !fault && Date.now() - t0 < 20000) mc.runSlice(10000);
    if (mc.getVector(0x10).seg !== 0xc000) throw new Error('the ROM did not take the INT 10h vector');
  }
  return { mc, fault: () => fault };
}

/** Run one `int 10h` with the given registers, and report what came back. */
function call(mc, r) {
  const cpu = mc.cpu;
  mc.mem.blit(STUB, Uint8Array.from([0xcd, 0x10, 0xf4]));     // int 10h ; hlt
  cpu.reg.fill(0);
  cpu.reg[0] = r.ax >>> 0;
  if (r.bx !== undefined) cpu.reg[3] = r.bx >>> 0;
  if (r.cx !== undefined) cpu.reg[1] = r.cx >>> 0;
  if (r.dx !== undefined) cpu.reg[2] = r.dx >>> 0;
  cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0;
  cpu.setSeg(3, 0); cpu.setSeg(0, r.es !== undefined ? r.es : 0);
  cpu.setSeg(1, STUB >> 4); cpu.eip = 0; cpu.flags = 0x0202; cpu.halted = false;
  const t0 = Date.now();
  let guard = 0;
  while (!cpu.halted && Date.now() - t0 < 20000 && guard++ < 4000) mc.runSlice(10000);
  return { ax: cpu.reg[0] & 0xffff, bx: cpu.reg[3] & 0xffff, cx: cpu.reg[1] & 0xffff, dx: cpu.reg[2] & 0xffff };
}

function state(mc, outBytes) {
  const s = {
    mode: mc.mem.r8(0x449),
    dac: Array.from(mc.bios.dac),
    pal: Array.from(mc.vga.palette),
    crtc: Array.from(mc.vga.crtc).map((v) => v & 0xff),
    gc: Array.from(mc.vga.gc).map((v) => v & 0xff),
  };
  if (outBytes) s.out = Array.from(mc.mem.u8.subarray(BUF, BUF + outBytes));
  return s;
}

function runCase(c, withRom) {
  const { mc } = boot(withRom);
  if (c.src || c.out) mc.mem.blit(BUF, c.src ? SRC : new Uint8Array(c.out).fill(0xee));
  let regs = null;
  for (const r of c.seq) regs = call(mc, r);
  return { regs, st: state(mc, c.out) };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hx = (n, w = 4) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
let pass = 0, fail = 0;
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue;
  let real, ours, err = null;
  try { real = runCase(c, true); ours = runCase(c, false); }
  catch (e) { err = e.message; }
  if (err) { console.log(`  ${c.name.padEnd(30)} ERREUR ${err}`); fail++; continue; }
  const diffs = [];
  for (const k of ['ax', 'bx', 'cx', 'dx']) if (real.regs[k] !== ours.regs[k]) diffs.push(`${k.toUpperCase()} reelle ${hx(real.regs[k])} nous ${hx(ours.regs[k])}`);
  for (const k of ['mode', 'dac', 'pal', 'crtc', 'gc', 'out']) {
    if (real.st[k] === undefined) continue;
    if (eq(real.st[k], ours.st[k])) continue;
    if (Array.isArray(real.st[k])) {
      const idx = [];
      for (let i = 0; i < real.st[k].length; i++) if (real.st[k][i] !== ours.st[k][i]) idx.push(i);
      diffs.push(`${k}: ${idx.length} bytes differ, first at [${idx[0]}] real ${hx(real.st[k][idx[0]] | 0, 2)} nous ${hx(ours.st[k][idx[0]] | 0, 2)}`);
    } else diffs.push(`${k}: reelle ${hx(real.st[k], 2)} nous ${hx(ours.st[k], 2)}`);
  }
  if (diffs.length) { console.log(`  ${c.name.padEnd(30)} DIFFERE  ${diffs.join('  |  ')}`); fail++; }
  else { console.log(`  ${c.name.padEnd(30)} ok`); pass++; }
}
console.log(`\nINT 10h against the real ROM: ${pass} identical, ${fail} different`);
process.exit(fail ? 1 : 0);
