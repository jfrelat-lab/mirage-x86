// boot.js — run a boot sector instead of a DOS program: the INT 19h handoff.
//
// MIRAGE's only entry point until now was the DOS loader (`dos.load`), which builds a PSP and hands
// control to a .COM/.EXE. A boot-sector prod is not a DOS program at all — BootChess (RSi, 512 b)
// and its kind are what the BIOS loads and jumps to, with no DOS anywhere in the picture. Booting
// one is a *narrower* environment than the DOS path, not a wider one: no PSP, no INT 21h, no
// program-termination convention. `installDOS` is simply not called.
//
// A single-sector prod needs nothing else: the whole program is inside the 512 bytes the BIOS has
// already read, so there is no INT 13h in this path. Multi-sector boot (a real DOS kernel) is the
// next rung and does need one.

import { CS, DS, ES, SS } from './cpu.js';

export const BOOT_LIN = 0x7c00;          // where the BIOS puts the sector, always
const SECTOR = 512;

/** True if `bytes` looks like a boot sector: at least one sector, ending in the 55 AA signature. */
export function isBootSector(bytes) {
  return bytes.length >= SECTOR && bytes[510] === 0x55 && bytes[511] === 0xaa;
}

/**
 * Load a boot sector and set up the CPU exactly as a BIOS INT 19h would, then return.
 * @param {import('./machine.js').Machine} machine
 * @param {Uint8Array} bytes  the disk image (only the first sector is loaded, like a real BIOS)
 * @param {{drive?: number, strict?: boolean}} opts  drive → DL (0x00 = A:, 0x80 = first hard disk)
 */
export function bootSector(machine, bytes, opts = {}) {
  const { drive = 0x00, strict = true } = opts;
  if (bytes.length < SECTOR) throw new Error(`boot image is ${bytes.length} bytes, need at least ${SECTOR}`);
  // A real BIOS refuses to boot a sector without the signature. Keep that check on by default: a
  // silent boot of a non-bootable image would look like a MIRAGE bug rather than a bad image.
  if (strict && !isBootSector(bytes)) throw new Error('no 55 AA boot signature at offset 510 — not a bootable sector');

  const cpu = machine.cpu, mem = machine.mem;
  mem.blit(BOOT_LIN, bytes.subarray(0, SECTOR));

  cpu.reg.fill(0);
  cpu.setSeg(CS, 0); cpu.eip = BOOT_LIN;    // 0000:7C00 — the other convention, 07C0:0000, is the
  cpu.setSeg(DS, 0); cpu.setSeg(ES, 0);     // same linear address, and sectors that care set CS
  cpu.setSeg(SS, 0);                        // themselves with a far jump before touching anything
  cpu.sp = BOOT_LIN;                        // stack grows down from just below the sector
  cpu.dx = drive & 0xff;                    // DL = boot drive; DH = 0
  cpu.flags = 0x0202;                       // IF set, as after the BIOS's own STI
  cpu.halted = false;
  return { drive, linear: BOOT_LIN };
}
