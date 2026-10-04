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

import { CF, ES, DS } from './cpu.js';

// Standard floppy geometries, keyed by image size. A raw sector image carries no geometry of its
// own, and CHS addressing is meaningless without one.
// `type` is what INT 13h AH=08h returns in BL, and the codes are the IBM ones, not a size class:
// 01 = 360K 5.25", 02 = 1.2M 5.25", 03 = 720K 3.5", 04 = 1.44M 3.5", 06 = 2.88M. Three rows used
// to say 02 for everything 720K and up, which told a guest that a 1.44M drive was a 1.2M one:
// MS-DOS 4's SYSINIT builds its drive table from this byte, and on the wrong code it fell back to
// a 360K template (9 sectors, 1 head) for a 1.44M disk and then retried a bad read forever.
// Checked against SeaBIOS, which answers BX=0004 CX=4F12 DX=0102 for a 1.44M floppy.
const GEOMETRY = new Map([
  [ 163840, { cyl: 40, heads: 1, spt: 8,  type: 1 }],   // 160K
  [ 184320, { cyl: 40, heads: 1, spt: 9,  type: 1 }],   // 180K
  [ 327680, { cyl: 40, heads: 2, spt: 8,  type: 1 }],   // 320K
  [ 368640, { cyl: 40, heads: 2, spt: 9,  type: 1 }],   // 360K
  [ 737280, { cyl: 80, heads: 2, spt: 9,  type: 3 }],   // 720K
  [1228800, { cyl: 80, heads: 2, spt: 15, type: 2 }],   // 1.2M
  [1474560, { cyl: 80, heads: 2, spt: 18, type: 4 }],   // 1.44M
  [2949120, { cyl: 80, heads: 2, spt: 36, type: 6 }],   // 2.88M
]);
const SECTOR = 512;

// The diskette parameter table: 11 bytes the BIOS keeps, INT 1Eh points at, and INT 13h AH=08
// hands back in ES:DI. Values are the standard 1.44M set a PC BIOS ships with.
const DPT_SEG = 0xf000, DPT_OFF = 0xefc7;
const FDPT_SEG = 0xf000, FDPT_OFF = 0x3f00;   // the two Fixed Disk Parameter Tables (INT 41h / 46h)
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
      // A hard disk's parameters also live in the Fixed Disk Parameter Table that INT 41h (drive 80h)
      // and INT 46h (81h) point at (RBIL #03196): cylinders, heads, precompensation, control, landing
      // zone, sectors per track. Linux reads it in its setup code; without it, "hd0: C/H/S=207/0/0
      // from BIOS ignored" (v86's bl3-5.img).
      // BDA 0475h counts the hard disks, as the POST leaves it: NetBSD's bootstrap takes any BIOS drive
      // at or above 80h + that count for a CD, and with our 0 it booted "cd0a:netbsd" off drive 80h.
      if ((drive & 0xff) >= 0x80) mem.w8(0x475, [...disk.drives.keys()].filter((k) => k >= 0x80).length);
      if ((drive & 0xff) === 0x80 || (drive & 0xff) === 0x81) {
        const off = (drive & 0xff) === 0x80 ? FDPT_OFF : FDPT_OFF + 16, a = (FDPT_SEG << 4) + off;
        const t = [g.cyl & 0xff, (g.cyl >> 8) & 0xff, g.heads, 0, 0, 0xff, 0xff, 0, g.heads > 8 ? 0x08 : 0, 0, 0, 0,
          g.cyl & 0xff, (g.cyl >> 8) & 0xff, g.spt, 0];
        t.forEach((b, i) => mem.w8(a + i, b));
        machine.setVector((drive & 0xff) === 0x80 ? 0x41 : 0x46, FDPT_SEG, off);
      }
      return g;
    },
    detach(drive) { disk.drives.delete(drive & 0xff); },
    // The CD-ROM drive, the secondary master of src/ide.js: `cd` is null when no drive is fitted,
    // { data: null } when the drive is empty. A disc put in a running machine (changed) is reported
    // to the next command as UNIT ATTENTION, as a real drive does; one there at power-on is not.
    cd: null,
    fitCD() { if (!disk.cd) disk.cd = { data: null, changed: false, locked: false }; return disk.cd; },
    attachCD(data, { changed = false } = {}) {
      if (data && data.length % 2048) throw new Error(`a CD image is whole 2048-byte sectors, not ${data.length} bytes`);
      const d = disk.fitCD(); d.data = data; d.changed = changed; return d;
    },
  };
  machine.disk = disk;

  /** How many drives of the same class (floppy vs fixed) are attached — what AH=08 returns in DL. */
  const countDrives = (drive) => {
    let n = 0;
    for (const k of disk.drives.keys()) if ((k & 0x80) === (drive & 0x80)) n++;
    return n + (drive < 0x80 && !disk.drives.has(0) ? 1 : 0);   // drive A is fitted even when empty
  };
  // Drive A with no diskette in it. CMOS 10h and the equipment word say it is fitted (src/rtc.js:
  // Windows 98's HSFLOP.PDR needs it), so the BIOS still describes the DRIVE — AH=00h resets,
  // AH=08h gives the 1.44 MB geometry and the parameter table, AH=15h "diskette, no change line" —
  // and whatever needs the medium times out (80h), as SeaBIOS answers for an empty drive.
  const EMPTY_A = { geom: { cyl: 80, heads: 2, spt: 18, type: 4 }, data: new Uint8Array(0) };
  const DRIVE_ONLY = (ah) => ah === 0x00 || ah === 0x08 || ah === 0x15;
  const ok = () => { disk.lastStatus = 0; cpu.ah = 0; cpu.flags &= ~CF; };
  const fail = (code) => { disk.lastStatus = code; cpu.ah = code; cpu.flags |= CF; };

  /** CHS -> byte offset, or -1 if the address is outside the geometry. */
  const chsOffset = (g, cyl, head, sector) => {
    if (sector < 1 || sector > g.spt || head >= g.heads || cyl >= g.cyl) return -1;
    return ((cyl * g.heads + head) * g.spt + (sector - 1)) * SECTOR;
  };

  // ---- The CD-ROM as BIOS drive E0h (El Torito "no emulation", SeaBIOS's number) ---------------
  // Reached by LBA only, in 2048-byte sectors: EDD 41h/42h/44h/47h/48h, 43h refused (write protected),
  // and 4Bh, which hands back the specification packet the boot was made from (src/boot.js bootCD).
  const CD_SECTOR = 2048;
  const cdInt13 = (c, ah) => {
    const d = disk.cd;
    switch (ah) {
      case 0x00: case 0x0d: ok(); return;
      case 0x41:
        if ((c.bx & 0xffff) !== 0x55aa) { fail(0x01); return; }
        c.bx = 0xaa55; c.ah = 0x30; c.cx = 0x0007;               // fixed-disk access, locking/ejecting, EDD
        c.flags &= ~CF; return;
      case 0x42: case 0x44: case 0x47: {
        const pkt = ((c.seg[DS] << 4) + (c.si & 0xffff)) >>> 0;
        const count = mem.r16(pkt + 2);
        let buf = (((mem.r16(pkt + 6) << 4) + mem.r16(pkt + 4)) >>> 0);
        if (mem.r8(pkt) >= 0x18 && mem.r32(pkt + 4) === 0xffffffff) buf = mem.r32(pkt + 0x10) >>> 0;
        const lba = mem.r32(pkt + 8) + mem.r32(pkt + 12) * 0x100000000;
        if (!d.data) { fail(0xaa); return; }                     // drive not ready
        if ((lba + (ah === 0x47 ? 1 : count)) * CD_SECTOR > d.data.length) { mem.w16(pkt + 2, 0); fail(0x0c); return; }   // as SeaBIOS
        if (ah === 0x42) mem.blit(buf, d.data.subarray(lba * CD_SECTOR, (lba + count) * CD_SECTOR));
        ok(); return;
      }
      case 0x43: fail(0x03); return;                            // write protected
      case 0x48: {
        const r = ((c.seg[DS] << 4) + (c.si & 0xffff)) >>> 0, size = mem.r16(r);
        if (size < 0x1a) { fail(0x01); return; }
        mem.w16(r, 0x1a);
        mem.w16(r + 2, 0x0074);                                 // removable, change line, lockable
        mem.w32(r + 4, 0xffffffff); mem.w32(r + 8, 0xffffffff); mem.w32(r + 12, 0xffffffff);
        mem.w32(r + 16, 0xffffffff); mem.w32(r + 20, 0xffffffff);   // size unknown, as SeaBIOS says of a CD
        mem.w16(r + 24, CD_SECTOR);
        ok(); return;
      }
      case 0x4b: {                                              // AL=00 terminate emulation, 01 status:
        const b = disk.cdBoot;                                  // both return the specification packet
        if ((c.al & 0xff) > 1 || !b) { fail(0x01); return; }
        const r = ((c.seg[DS] << 4) + (c.si & 0xffff)) >>> 0;
        for (let i = 0; i < 0x13; i++) mem.w8(r + i, 0);
        mem.w8(r, 0x13); mem.w8(r + 1, b.media); mem.w8(r + 2, b.drive); mem.w8(r + 3, 1);   // controller 1: the secondary channel
        mem.w32(r + 4, b.rba); mem.w16(r + 12, b.segment); mem.w16(r + 14, b.count);
        ok(); return;
      }
      default: machine.unhandledInts[0x13]++; fail(0x01);
    }
  };

  machine.hookInterrupt(0x13, (c) => {
    const drive = c.dx & 0xff;
    const ah = c.ah;
    if (drive === 0xe0 && disk.cd && ah !== 0x01) { cdInt13(c, ah); return; }
    const d = disk.drives.get(drive) || (drive === 0 && DRIVE_ONLY(ah) ? EMPTY_A : undefined);

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
        //
        // FIXED DISKS GET NEITHER: ES and DI are CALLER-SAVED here. Zeroing them is not a harmless
        // "no table available" — MS-DOS 4's IO.SYS keeps its drive-table pointer in DI across the
        // call and stores the geometry straight into it (`mov [di+15h],dh` / `mov [di+13h],cl` at
        // 0070:37be). With DI zeroed, heads and sectors-per-track were written into the IVT instead
        // and the BPB kept IO.SYS's template zeros, so the `mul`/`div cx` at 0070:3aeb divided by
        // zero. Checked against two references on the same boot sector: SeaBIOS under QEMU and
        // under v86 both return ES:DI exactly as passed in (BEEF:1234).
        if (drive < 0x80) { c.setSeg(ES, DPT_SEG); c.di = DPT_OFF; }
        ok(); return;
      }
      case 0x15: {                                              // get disk type
        // CX:DX = the sector count is a FIXED-DISK answer only. On a floppy the call reports the
        // type in AH and touches nothing else: SeaBIOS returns AX=0100 CX=5555 DX=0001 for a probe
        // that went in with CX=5555 and DL=1, so both are the caller's. Returning the count anyway
        // cost MS-DOS 4 its loop variable — its drive-table builder keeps the drive number in DL
        // across this call (0070:34ab) and read back 0x40, the low byte of 2880 sectors, so both
        // floppy entries were built for drive 0x40 with a 360K template and every later read
        // retried forever on a drive that does not exist.
        if (drive >= 0x80) {
          const sectors = (d.data.length / SECTOR) | 0;
          c.cx = (sectors >> 16) & 0xffff; c.dx = sectors & 0xffff;
          c.ah = 0x03;                                          // 03 = fixed disk, sector count valid
        } else c.ah = 0x01;                                     // 01 = floppy, no change-line support
        c.flags &= ~CF; disk.lastStatus = 0; return;
      }
      // ---- The EDD extensions (Phoenix / IBM "INT 13h Extensions", EDD 3.0), hard disks only ----
      // Windows 95 OSR2/98 FAT32 boot sectors and NetBSD's bootstrap read by LBA through these; without
      // them: "Disk I/O error" and "/boot load failed". Shapes follow SeaBIOS (disk.c).
      case 0x41: {                                              // installation check
        if (drive < 0x80 || (c.bx & 0xffff) !== 0x55aa) { fail(0x01); return; }
        c.bx = 0xaa55; c.ah = 0x30;                              // EDD 3.0
        c.cx = 0x0005;                                          // fixed-disk access (42h-44h,47h,48h) + EDD (48h)
        c.flags &= ~CF; return;
      }
      case 0x42: case 0x43: case 0x44: case 0x47: {             // extended read / write / verify / seek
        if (drive < 0x80) { fail(0x01); return; }
        const pkt = ((c.seg[DS] << 4) + (c.si & 0xffff)) >>> 0;
        const count = mem.r16(pkt + 2);
        let buf = (((mem.r16(pkt + 6) << 4) + mem.r16(pkt + 4)) >>> 0);
        if (mem.r8(pkt) >= 0x18 && mem.r32(pkt + 4) === 0xffffffff) buf = mem.r32(pkt + 0x10) >>> 0;   // flat 64-bit address
        const lba = mem.r32(pkt + 8) + mem.r32(pkt + 12) * 0x100000000;
        if (ah === 0x47) { if (lba * SECTOR >= d.data.length) { fail(0x04); return; } ok(); return; }
        if (lba * SECTOR + count * SECTOR > d.data.length) { mem.w16(pkt + 2, 0); fail(0x04); return; }   // sector not found
        const off = lba * SECTOR;
        if (ah === 0x42) mem.blit(buf, d.data.subarray(off, off + count * SECTOR));
        else if (ah === 0x43) for (let i = 0; i < count * SECTOR; i++) d.data[off + i] = mem.r8(buf + i);
        ok(); return;                                           // the packet's count stays: all of it moved
      }
      case 0x48: {                                              // get drive parameters (result buffer at DS:SI)
        if (drive < 0x80) { fail(0x01); return; }
        const r = ((c.seg[DS] << 4) + (c.si & 0xffff)) >>> 0, size = mem.r16(r);
        if (size < 0x1a) { fail(0x01); return; }
        const total = Math.floor(d.data.length / SECTOR);
        mem.w16(r, size >= 0x1e ? 0x1e : 0x1a);
        mem.w16(r + 2, 0x0002);                                 // CHS information valid
        mem.w32(r + 4, g.cyl); mem.w32(r + 8, g.heads); mem.w32(r + 12, g.spt);
        mem.w32(r + 16, total >>> 0); mem.w32(r + 20, Math.floor(total / 0x100000000));
        mem.w16(r + 24, SECTOR);
        if (size >= 0x1e) mem.w32(r + 26, 0xffffffff);          // no EDD configuration parameters
        ok(); return;
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
