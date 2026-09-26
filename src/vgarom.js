// vgarom.js — run a REAL VGA BIOS option ROM as the machine's INT 10h, instead of our own.
//
// The ROM is copied to C000:0 and entered by a far call to C000:0003, exactly as a POST does; it
// programs the card, points INT 10h (and INT 1Fh/43h) at itself and returns. From then on a guest's
// INT 10h runs the vendor's 16-bit code against MIRAGE's VGA device model, so the ROM becomes an
// oracle for the DEVICE rather than for the BIOS: tools/int10gfx.asm printing the same lines under
// QEMU and under MIRAGE, both with the Cirrus CL-GD5446 ROM (ROADMAP H1), means our registers,
// planes and latches behave like QEMU's card for everything that ROM does.
//
// Opt-in and headless for now. Our INT 10h keeps state the renderer and other services read
// (bios.mode, the text cursor, the DAC); with a ROM those live in the BDA and the card instead, and
// the VGA device switches to register-derived routing (vga.hw, see vga.js). The browser renderer does
// not follow that yet.
//
//   installVgaRom(machine, romBytes) -> { vector, blocks }

export function installVgaRom(machine, rom) {
  if (rom[0] !== 0x55 || rom[1] !== 0xaa) throw new Error('not an option ROM: no 55AA signature');
  const cpu = machine.cpu, mem = machine.mem;
  mem.blit(0xc0000, rom);
  if (machine.vga) machine.vga.hw = true;

  // Enter it the way a POST does: a far CALL, with a HLT parked where its RETF will land.
  const save = { reg: Array.from(cpu.reg), seg: Array.from(cpu.seg), eip: cpu.eip, flags: cpu.flags };
  const RET = 0x7c00, stub = mem.r8(RET);
  mem.w8(RET, 0xf4);
  cpu.reg.fill(0);
  cpu.setSeg(2, 0x9000); cpu.sp = 0xfff0;
  cpu.setSeg(3, 0); cpu.setSeg(0, 0);
  cpu.flags = 0x0202;
  cpu.push16(0); cpu.push16(RET);
  cpu.setSeg(1, 0xc000); cpu.eip = 0x0003;
  cpu.halted = false;
  let blocks = 0, fault = null;
  const onErr = machine.onError; machine.onError = (e) => { fault = e; };
  while (!cpu.halted && !fault && blocks < 20_000_000) blocks += machine.runSlice(10000);
  machine.onError = onErr;
  mem.w8(RET, stub);
  if (fault) throw new Error(`the VGA ROM faulted during its init: ${fault.message || fault}`);
  if (!cpu.halted) throw new Error('the VGA ROM did not return from its init');

  // Hand the CPU back as it was; the caller boots next.
  save.seg.forEach((v, i) => cpu.setSeg(i, v));
  cpu.reg.set(save.reg); cpu.eip = save.eip; cpu.flags = save.flags; cpu.halted = false;
  return { vector: machine.getVector(0x10), blocks };
}
