// disk.js — INT 13h disk services over attachable sector images.
//
// Until now INT 13h had no handler at all, which is the audit's worst finding made concrete: an
// unhandled INT returns with CF and the registers untouched, so a guest that asks the BIOS to read a
// sector is told nothing went wrong and parses whatever was already in its buffer. Reporting "drive
// not ready" for a drive with no image is not a lesser service than reading — it is the difference
// between a program that says "insert disk" and one that walks off into uninitialised RAM.
//
// It is also the rung above the boot handoff (src/boot.js): a single-sector prod needs no INT 13h
// because the BIOS already read the whole program, but anything that loads more of itself — every
// real bootloader, and therefore any DOS kernel — needs this.

import { CF, ES } from './cpu.js';

// Standard floppy geometries, keyed by image size. A raw sector image carries no geometry of its
// own, and CHS addressing is meaningless without one.
const GEOMETRY = new Map([
  [ 163840, { cyl: 40, heads: 1, spt: 8,  type: 1 }],   // 160K
  [ 184320, { cyl: 40, heads: 1, spt: 9,  type: 1 }],   // 180K
  [ 327680, { cyl: 40, heads: 2, spt: 8,  type: 1 }],   // 320K
  [ 368640, { cyl: 40, heads: 2, spt: 9,  type: 1 }],   // 360K
  [ 737280, { cyl: 80, heads: 2, spt: 9,  type: 2 }],   // 720K
  [1228800, { cyl: 80, heads: 2, spt: 15, type: 2 }],   // 1.2M
  [1474560, { cyl: 80, heads: 2, spt: 18, type: 2 }],   // 1.44M
  [2949120, { cyl: 80, heads: 2, spt: 36, type: 2 }],   // 2.88M
]);
const SECTOR = 512;

// The diskette parameter table: 11 bytes the BIOS keeps, INT 1Eh points at, and INT 13h AH=08
// hands back in ES:DI. Values are the standard 1.44M set a PC BIOS ships with.
const DPT_SEG = 0xf000, DPT_OFF = 0xefc7;
const DPT = [0xaf, 0x02, 0x25, 0x02, 18, 0x1b, 0xff, 0x6c, 0xf6, 0x0f, 0x08];

export function installDisk(machine) {
  const mem = machine.mem, cpu = machine.cpu;
  for (let i = 0; i < DPT.length; i++) mem.w8((DPT_SEG << 4) + DPT_OFF + i, DPT[i]);
  machine.setVector(0x1e, DPT_SEG, DPT_OFF);      // INT 1Eh is a data pointer, not code
  const disk = {
    drives: new Map(),       // drive number (0x00 = A:, 0x80 = first hard disk) -> {data, geom}
    lastStatus: 0,           // AH=01 reports the previous operation's status
    /**
     * Attach a raw sector image to a drive.
     * @param {number} drive 0x00/0x01 floppies, 0x80+ hard disks
     * @param {Uint8Array} data
     * @param {{cyl:number,heads:number,spt:number,type?:number}} [geom] required if the size is not
     *        a standard floppy format
     */
    attach(drive, data, geom) {
      const g = geom || GEOMETRY.get(data.length);
      if (!g) throw new Error(`no standard geometry for a ${data.length}-byte image — pass one explicitly`);
      disk.drives.set(drive & 0xff, { data, geom: g });
      return g;
    },
    detach(drive) { disk.drives.delete(drive & 0xff); },
  };
  machine.disk = disk;

  /** How many drives of the same class (floppy vs fixed) are attached — what AH=08 returns in DL. */
  const countDrives = (drive) => {
    let n = 0;
    for (const k of disk.drives.keys()) if ((k & 0x80) === (drive & 0x80)) n++;
    return n;
  };
  const ok = () => { disk.lastStatus = 0; cpu.ah = 0; cpu.flags &= ~CF; };
  const fail = (code) => { disk.lastStatus = code; cpu.ah = code; cpu.flags |= CF; };

  /** CHS -> byte offset, or -1 if the address is outside the geometry. */
  const chsOffset = (g, cyl, head, sector) => {
    if (sector < 1 || sector > g.spt || head >= g.heads || cyl >= g.cyl) return -1;
    return ((cyl * g.heads + head) * g.spt + (sector - 1)) * SECTOR;
  };

  machine.hookInterrupt(0x13, (c) => {
    const drive = c.dx & 0xff;
    const d = disk.drives.get(drive);
    const ah = c.ah;

    // AH=01 answers about the *previous* call, so it must work even with no media.
    if (ah === 0x01) { c.ah = disk.lastStatus; c.flags &= ~CF; return; }
    // 80h = timeout / drive not ready. This is what a real BIOS says about an empty drive, and
    // saying it is the whole point: the alternative is a guest that believes it read something.
    if (!d) { fail(0x80); return; }
    const g = d.geom;

    switch (ah) {
      case 0x00: ok(); return;                                  // reset controller
      case 0x02: case 0x03: case 0x04: {                        // read / write / verify sectors
        const count = c.al & 0xff;
        // CL bits 0-5 = sector (1-based), CL bits 6-7 = cylinder bits 8-9, CH = cylinder bits 0-7.
        const cl = c.cx & 0xff, ch = (c.cx >> 8) & 0xff;
        const sector = cl & 0x3f;
        const cyl = ch | ((cl & 0xc0) << 2);
        const head = (c.dx >> 8) & 0xff;
        const off = chsOffset(g, cyl, head, sector);
        if (off < 0 || off + count * SECTOR > d.data.length) { c.al = 0; fail(0x04); return; }  // sector not found
        const lin = (c.seg[ES] << 4) + (c.bx & 0xffff);
        if (ah === 0x02) mem.blit(lin, d.data.subarray(off, off + count * SECTOR));
        else if (ah === 0x03) for (let i = 0; i < count * SECTOR; i++) d.data[off + i] = mem.r8(lin + i);
        c.al = count; ok(); return;                             // AH=04 verify: geometry check only
      }
      case 0x08: {                                              // get drive parameters
        const maxCyl = g.cyl - 1;
        c.cx = ((maxCyl & 0xff) << 8) | (((maxCyl >> 8) & 3) << 6) | (g.spt & 0x3f);
        c.dx = (((g.heads - 1) & 0xff) << 8) | countDrives(drive);
        c.bx = (c.bx & 0xff00) | (g.type || 4);                 // BL = drive type (04 = 1.44M)
        // A real BIOS returns ES:DI = the diskette parameter table — the same 11 bytes INT 1Eh
        // points at — and a guest is entitled to read it. We used to answer 0000:0000, which is a
        // null pointer dressed as an answer: the caller has no way to know it is not a table.
        if (drive < 0x80) { c.setSeg(ES, DPT_SEG); c.di = DPT_OFF; }
        else { c.setSeg(ES, 0); c.di = 0; }                      // fixed disks use a different table
        ok(); return;
      }
      case 0x15: {                                              // get disk type
        const sectors = (d.data.length / SECTOR) | 0;
        c.cx = (sectors >> 16) & 0xffff; c.dx = sectors & 0xffff;
        c.ah = drive < 0x80 ? 0x01 : 0x03;                      // 01 = floppy, no change line; 03 = fixed disk
        c.flags &= ~CF; disk.lastStatus = 0; return;
      }
      default:
        // Not implemented — and counted, so tools/survey-gaps.mjs keeps reporting INT 13h until the
        // subfunctions that matter are covered rather than falling silent the moment it has a handler.
        machine.unhandledInts[0x13]++;
        fail(0x01);                                             // 01h = invalid command
    }
  });

  return disk;
}
