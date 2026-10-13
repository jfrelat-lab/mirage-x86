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
  // Open A20 before handing over. A bare 8086 leaves it closed and real-mode code relies on the 1 MiB
  // wrap (EXEPACK stubs do), which is why it stays closed on the .COM path — but a POST that is about
  // to boot a kernel opens it, and SeaBIOS does. Leaving it closed made HimemX report "No Supported
  // A20 method detected" and install no XMS driver at all, because its "always on" detection needs to
  // find A20 already open (docs/notes/2026-09-05-mesha.md).
  if (machine.bios && machine.bios.setA20) machine.bios.setA20(true);

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

/**
 * Boot an ISO 9660 image the El Torito way (El Torito 1.0, as SeaBIOS's cdrom_boot does it).
 * The Boot Record Volume Descriptor at sector 17 points at the boot catalog; its validation entry
 * must checksum to 0 and end in 55 AA, and the initial entry (88h = bootable) gives the emulation,
 * the load segment, the count of 512-byte sectors and the image's first CD sector.
 *   - no emulation: the count is read to load-segment:0 (07C0h when 0) and entered as 0000:segment*16,
 *     DL = E0h;
 *   - floppy emulation (1.2/1.44/2.88 MB): the image becomes drive A: and boots as a diskette;
 *   - hard-disk emulation: the image becomes drive 80h (an existing 80h moves to 81h).
 * The disc stays in the ATAPI drive (machine.disk.attachCD), where protected-mode drivers find it.
 */
export function bootCD(machine, iso) {
  const disk = machine.disk;
  disk.attachCD(iso);
  const S = 2048, brvd = iso.subarray(17 * S, 18 * S);
  const id = String.fromCharCode(...brvd.subarray(1, 6)), sys = String.fromCharCode(...brvd.subarray(7, 30));
  if (brvd[0] !== 0 || id !== 'CD001' || sys !== 'EL TORITO SPECIFICATION') throw new Error('no El Torito boot record at sector 17 — not a bootable CD');
  const dv = new DataView(iso.buffer, iso.byteOffset, iso.byteLength);
  const cat = dv.getUint32(17 * S + 0x47, true) * S;
  let sum = 0; for (let i = 0; i < 32; i += 2) sum = (sum + dv.getUint16(cat + i, true)) & 0xffff;
  if (iso[cat] !== 1 || iso[cat + 30] !== 0x55 || iso[cat + 31] !== 0xaa || sum) throw new Error('El Torito boot catalog: bad validation entry');
  const e = cat + 32;
  if (iso[e] !== 0x88) throw new Error('El Torito boot catalog: the initial entry is not bootable');
  const media = iso[e + 1] & 0x0f, segment = dv.getUint16(e + 2, true) || 0x07c0;
  const count = dv.getUint16(e + 6, true), rba = dv.getUint32(e + 8, true);
  if (media === 0) {
    const bytes = iso.subarray(rba * S, rba * S + Math.max(1, count) * SECTOR);
    disk.cdBoot = { media, drive: 0xe0, rba, segment, count };
    if (machine.bios && machine.bios.setA20) machine.bios.setA20(true);
    const cpu = machine.cpu;
    machine.mem.blit(segment << 4, bytes);
    cpu.reg.fill(0);
    cpu.setSeg(CS, 0); cpu.eip = segment << 4;   // 0000:7C00 for 07C0h, as SeaBIOS enters it
    cpu.setSeg(DS, 0); cpu.setSeg(ES, 0); cpu.setSeg(SS, 0); cpu.sp = BOOT_LIN;
    cpu.dx = 0xe0;
    cpu.flags = 0x0202; cpu.halted = false;
    return { drive: 0xe0, media, linear: segment << 4 };
  }
  const size = [0, 1228800, 1474560, 2949120][media];
  const image = iso.slice(rba * S, rba * S + (size || iso.length - rba * S));
  if (media <= 3) {
    disk.attach(0x00, image);
    disk.cdBoot = { media, drive: 0x00, rba, segment, count };
    return bootSector(machine, image, { drive: 0x00 });
  }
  // Hard-disk emulation: geometry from the image's first partition, as bootshot.mjs derives it.
  const old = disk.drives.get(0x80);
  if (old) disk.attach(0x81, old.data, old.geom);
  const pe = 0x1be, eh = image[pe + 5], es = image[pe + 6] & 63;
  disk.attach(0x80, image, { cyl: Math.max(1, Math.floor(image.length / ((eh + 1) * (es || 63) * SECTOR))), heads: eh + 1, spt: es || 63, type: 3 });
  disk.cdBoot = { media, drive: 0x80, rba, segment, count };
  return bootSector(machine, image, { drive: 0x80 });
}

const FLOPPIES = [163840, 184320, 327680, 368640, 737280, 1228800, 1474560, 2949120];
/** Put a disk image in the machine as boot.html does: a floppy if it is floppy-sized (or smaller,
 *  padded to 1.44 MB), else a hard disk whose geometry is solved from its first partition entry.
 *  Returns the bytes and the BIOS drive to boot from. */
export function attachImage(mc, bytes) {
  if (bytes.length <= 2949120) {
    if (!FLOPPIES.includes(bytes.length)) { const p = new Uint8Array(1474560); p.set(bytes.subarray(0, 1474560)); bytes = p; }
    mc.disk.attach(0, bytes);
    return { bytes, drive: 0x00 };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset), e = 0x1be;
  const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true), sh = bytes[e + 1], ss = bytes[e + 2] & 63;
  const eh = bytes[e + 5], es = bytes[e + 6] & 63, ec = bytes[e + 7] | ((bytes[e + 6] & 0xc0) << 2);
  const ok = (bytes[e] === 0 || bytes[e] === 0x80) && bytes[e + 4] && n && ec;
  const spt = ok && sh ? (lba - (ss - 1)) / sh : 63;
  const heads = ok ? Math.round(((lba + n - 1 - (es - 1)) / spt - eh) / ec) : 16;
  const g = Number.isInteger(spt) && spt > 0 && heads > 0 && heads <= 255 ? { spt, heads } : { spt: 63, heads: 16 };
  mc.disk.attach(0x80, bytes, { cyl: Math.floor(bytes.length / (g.heads * g.spt * 512)), heads: g.heads, spt: g.spt, type: 3 });
  return { bytes, drive: 0x80 };
}
