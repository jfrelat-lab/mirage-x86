// Boot an image under MIRAGE and print what the guest writes to COM1 (3F8h), until port F4h.
//   node serialboot.mjs <image> [seconds]        CDROM=<iso> puts a disc in the ATAPI drive
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const secs = Number(process.argv[3]) || 20;
const { mc } = makeMachine({ dos: false });
// VGAROM=<file>: run that VGA BIOS ROM as INT 10h (src/vgarom.js) — e.g. boot/roms/5446bv.vbi,
// to compare tools/int10gfx.asm with the same ROM under QEMU (tools/v86/cirrusboot.mjs).
if (process.env.VGAROM) {
  const { installVgaRom } = await import(ROOT + '/src/vgarom.js');
  const r = installVgaRom(mc, new Uint8Array(readFileSync(process.env.VGAROM)));
  console.error(`VGA ROM ${process.env.VGAROM}: INT 10h -> ${r.vector.seg.toString(16)}:${r.vector.off.toString(16)}`);
}
mc.disk.attach(0x00, bytes);
if (process.env.CDROM) mc.disk.attachCD(new Uint8Array(readFileSync(process.env.CDROM)));
let out = '', done = false;
// With a UART (MIRAGE_SERIAL=1, src/uart.js) the guest talks to the real device and we listen on its
// transmit side; without one, COM1 is faked here: THR captured, LSR always "empty".
if (mc.serial) mc.serial.onTx = (b) => { out += String.fromCharCode(b); };
else {
  mc.onPortRead(0x3fd, () => 0x60);
  mc.onPortWrite(0x3f8, (_p, _s, v) => { out += String.fromCharCode(v & 0xff); });
}
mc.onPortWrite(0xf4, () => { done = true; });
bootSector(mc, bytes, { drive: 0 });
// Guest seconds: the run loop drives IRQ0 off cpu.cycles, one tick per pitBase cycles.
const end = mc.cpu.cycles + secs * 18.2065 * mc.pitBase, t0 = Date.now();
while (!done && mc.cpu.cycles < end && Date.now() - t0 < 600e3) { mc.runSlice(20000); if (mc.timerAuto === false) mc.tickTimer(); }
process.stdout.write(out);
