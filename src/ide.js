// ide.js — the two ATA (IDE) channels, PIO only: the primary at 1F0h-1F7h/3F6h on IRQ 14 with the
// hard disks, the secondary at 170h-177h/376h on IRQ 15 with an ATAPI CD-ROM drive.
//
// The BIOS path (INT 13h, src/disk.js) is enough for DOS and for every boot loader, but a protected-
// mode kernel talks to the controller itself. Linux 2.2 (v86's bl3-5.img) boots through LILO and our
// INT 13h, then mounts /dev/hda1 through this port interface — without it: "VFS: Unable to mount root
// fs on 03:01". The same image the BIOS serves as drive 80h is the master here, so both views agree.
//
// Implemented from the ATA/ATAPI-4 register model, the part an old driver uses:
//   +0 data (16-bit PIO)   +1 error / features   +2 sector count   +3..+5 LBA / sector+cylinder
//   +6 drive/head (bit 4 = device, bit 6 = LBA)   +7 status / command   ctl: alt status / device control
//   ATA commands: IDENTIFY (ECh), READ/WRITE SECTORS (20h/21h, 30h/31h), READ/WRITE MULTIPLE (C4h/C5h)
//   with SET MULTIPLE (C6h), INITIALIZE DEVICE PARAMETERS (91h), RECALIBRATE (1xh), SEEK (7xh), VERIFY
//   (40h/41h), SET FEATURES (EFh), FLUSH CACHE (E7h), the power commands (E0h-E5h), EXECUTE DEVICE
//   DIAGNOSTIC (90h). Anything else is aborted (ERR, error = ABRT).
// Transfers complete instantly (no seek or rotational timing): status is never busy when read.
//
// THE ATAPI DEVICE (the secondary master, when a drive is fitted: machine.disk.cd) answers the ATA
// commands an ATAPI device does — IDENTIFY DEVICE aborted with the 14h/EBh signature in the cylinder
// registers, which is how every driver tells a CD from a disk, IDENTIFY PACKET DEVICE (A1h), DEVICE
// RESET (08h), PACKET (A0h) — and, through PACKET, the MMC commands drivers send to a CD-ROM: TEST UNIT
// READY, REQUEST SENSE, INQUIRY, MODE SENSE (10, not 6, which ATAPI lacks: pages 01h, 2Ah, 3Fh), START STOP UNIT, PREVENT
// ALLOW MEDIUM REMOVAL, READ CAPACITY, READ (10 and 12), READ CD (user data or raw 2352-byte
// sectors), SEEK, READ TOC (formats 0 and 1), GET CONFIGURATION, GET EVENT STATUS NOTIFICATION, READ
// DISC INFORMATION, MECHANISM STATUS, SET CD SPEED. Data comes back in DRQ blocks no larger than the
// byte count the host put in the cylinder registers, the interrupt reason in the sector count (CoD,
// IO), as ATA/ATAPI-4 §9.8 lays out and QEMU's hw/ide/atapi.c behaves; tools/atapiprobe.asm compares
// the two. No DMA: IDENTIFY PACKET does not offer it, and a PACKET asking for it is aborted.

const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;
const ABRT = 0x04;
const SECTOR = 512, CDSECTOR = 2048;

// SCSI sense keys and additional sense codes the drive reports.
const NOT_READY = 0x02, ILLEGAL_REQUEST = 0x05, UNIT_ATTENTION = 0x06;
const ASC_NO_MEDIUM = 0x3a, ASC_INVALID_OPCODE = 0x20, ASC_LBA_RANGE = 0x21, ASC_INVALID_FIELD = 0x24, ASC_MEDIUM_CHANGED = 0x28;

export function installIDE(machine) {
  const disk = machine.disk;
  // Primary: the hard disks the BIOS also serves, 80h master and 81h slave. With no drive 80h there is
  // no controller either: every register floats at FFh, which is how DOS software tells there is none.
  machine.ide = channel(machine, {
    base: 0x1f0, ctl: 0x3f6, irq: 14,
    device: (n) => { const d = disk && disk.drives.get(n ? 0x81 : 0x80); return d ? { ata: d } : null; },
    present: () => !!(disk && disk.drives.has(0x80)),
  });
  // Secondary: the CD-ROM drive, when one is fitted (disk.cd, see attachCD in src/disk.js). A machine
  // without one has no secondary channel, the behaviour these ports had before the drive existed.
  machine.ide2 = channel(machine, {
    base: 0x170, ctl: 0x376, irq: 15,
    device: (n) => (!n && disk && disk.cd ? { cd: disk.cd } : null),
    present: () => !!(disk && disk.cd),
  });
  return machine.ide;
}

function channel(machine, cfg) {
  const ide = {
    features: 0, count: 0, sector: 0, cylLo: 0, cylHi: 0, head: 0xa0,
    status: DRDY | DSC, error: 0x01, control: 0,
    buf: new Uint8Array(SECTOR * 256), bufLen: 0, bufPos: 0,
    writing: false, remaining: 0, lba: 0, multiple: 0, perIrq: 1,
    heads: 0, spt: 0,                                // the translation INITIALIZE DEVICE PARAMETERS set
    // ATAPI: 'packet' while the 12 command bytes come in, 'in' while data goes out in DRQ blocks.
    atapi: null, packet: new Uint8Array(12), packetLen: 0,
    xfer: null, xpos: 0, xend: 0, chunkEnd: 0, limit: 0,
  };

  const dev = () => cfg.device((ide.head >> 4) & 1);
  const drive = () => { const d = dev(); return d && d.ata ? d.ata : null; };
  const cd = () => { const d = dev(); return d && d.cd ? d.cd : null; };
  const geom = () => { const d = drive(); return d ? d.geom : null; };
  const irq = () => { if (!(ide.control & 0x02)) machine.raiseIRQ(cfg.irq); };   // nIEN masks the line
  const done = () => { ide.status = DRDY | DSC; irq(); };
  const abort = () => { ide.error = ABRT; ide.status = DRDY | DSC | ERR; irq(); };

  // The sector a command addresses: LBA (drive/head bit 6) or CHS in the current translation.
  const address = () => {
    if (ide.head & 0x40) return (((ide.head & 0x0f) << 24) | (ide.cylHi << 16) | (ide.cylLo << 8) | ide.sector) >>> 0;
    const g = geom(), heads = ide.heads || g.heads, spt = ide.spt || g.spt;
    const cyl = (ide.cylHi << 8) | ide.cylLo;
    return (cyl * heads + (ide.head & 0x0f)) * spt + ide.sector - 1;
  };
  // Write back where the transfer ended, as the registers read after a command.
  const setAddress = (lba) => {
    if (ide.head & 0x40) {
      ide.sector = lba & 0xff; ide.cylLo = (lba >>> 8) & 0xff; ide.cylHi = (lba >>> 16) & 0xff;
      ide.head = (ide.head & 0xf0) | ((lba >>> 24) & 0x0f);
      return;
    }
    const g = geom(), heads = ide.heads || g.heads, spt = ide.spt || g.spt;
    const cyl = Math.floor(lba / (heads * spt)), r = lba % (heads * spt);
    ide.cylLo = cyl & 0xff; ide.cylHi = (cyl >> 8) & 0xff;
    ide.head = (ide.head & 0xf0) | (Math.floor(r / spt) & 0x0f); ide.sector = (r % spt) + 1;
  };

  // Stage the next block of a READ into the data buffer, raising DRQ and the interrupt.
  const readBlock = () => {
    const d = drive(), n = Math.min(ide.remaining, ide.perIrq);
    const off = ide.lba * SECTOR;
    if (!d || off + n * SECTOR > d.data.length) { abort(); return; }
    ide.buf.set(d.data.subarray(off, off + n * SECTOR), 0);
    ide.bufLen = n * SECTOR; ide.bufPos = 0;
    ide.lba += n; ide.remaining -= n; setAddress(ide.lba - 1);
    ide.status = DRDY | DSC | DRQ; irq();
  };
  const beginWriteBlock = () => {
    ide.bufLen = Math.min(ide.remaining, ide.perIrq) * SECTOR; ide.bufPos = 0;
    ide.status = DRDY | DSC | DRQ;
  };
  const commitWriteBlock = () => {
    const d = drive(), n = ide.bufLen / SECTOR, off = ide.lba * SECTOR;
    if (!d || off + n * SECTOR > d.data.length) { abort(); return; }
    d.data.set(ide.buf.subarray(0, n * SECTOR), off);
    ide.lba += n; ide.remaining -= n; setAddress(ide.lba - 1);
    if (ide.remaining > 0) { beginWriteBlock(); irq(); } else done();
  };

  // Strings in IDENTIFY data are byte-swapped per word, as the standard lays them out.
  const str = (w, at, len, s) => { s = s.padEnd(len * 2); for (let i = 0; i < len; i++) w[at + i] = (s.charCodeAt(2 * i) << 8) | s.charCodeAt(2 * i + 1); };
  const sendIdentify = (w) => {
    new Uint16Array(ide.buf.buffer, 0, 256).set(w);
    ide.bufLen = SECTOR; ide.bufPos = 0; ide.remaining = 0;
    ide.status = DRDY | DSC | DRQ; irq();
  };
  // IDENTIFY DEVICE: 256 words.
  const identify = () => {
    const g = geom(), d = drive(), w = new Uint16Array(256);
    const total = Math.floor(d.data.length / SECTOR);
    w[0] = 0x0040;                                     // fixed disk
    w[1] = Math.min(g.cyl, 16383); w[3] = g.heads; w[6] = g.spt;
    str(w, 10, 10, 'MIRAGE0000000001'); str(w, 23, 4, '1.0'); str(w, 27, 20, 'MIRAGE ATA DISK');
    w[47] = 0x8010;                                    // READ/WRITE MULTIPLE, up to 16 sectors
    w[49] = 0x0200;                                    // LBA supported
    w[51] = 0x0200; w[53] = 0x0001;                    // PIO timing mode 2; words 54-58 valid
    w[54] = Math.min(g.cyl, 16383); w[55] = ide.heads || g.heads; w[56] = ide.spt || g.spt;
    const cur = w[54] * w[55] * w[56]; w[57] = cur & 0xffff; w[58] = cur >>> 16;
    if (ide.multiple) w[59] = 0x0100 | ide.multiple;
    w[60] = total & 0xffff; w[61] = total >>> 16;
    w[80] = 0x001e;                                    // ATA-1..4
    sendIdentify(w);
  };
  // IDENTIFY PACKET DEVICE: ATAPI (bits 15:14 = 10), CD-ROM (12:8 = 05h), removable, DRQ within 50 us
  // of PACKET (6:5 = 10), 12-byte packets. LBA but no DMA; PIO modes 3 and 4.
  const identifyPacket = () => {
    const w = new Uint16Array(256);
    w[0] = 0x85c0;
    str(w, 10, 10, 'MIRAGE0000000002'); str(w, 23, 4, '1.0'); str(w, 27, 20, 'MIRAGE ATAPI CD-ROM');
    w[49] = 0x0200; w[51] = 0x0200; w[53] = 0x0002;    // LBA; words 64-70 valid
    w[64] = 0x0003; w[67] = 120; w[68] = 120;          // PIO 3 and 4, 120 ns cycles
    w[80] = 0x001e;
    sendIdentify(w);
  };

  // ---- ATAPI -------------------------------------------------------------------------------------
  const sense = { key: 0, asc: 0, ascq: 0 };
  const cdSignature = () => { ide.count = 1; ide.sector = 1; ide.cylLo = 0x14; ide.cylHi = 0xeb; ide.head &= 0xf0; };
  // CHECK CONDITION: the sense key goes in the error register's high nibble, the reason says "status".
  const checkCondition = (key, asc, ascq = 0) => {
    sense.key = key; sense.asc = asc; sense.ascq = ascq;
    ide.error = key << 4; ide.count = 0x03; ide.status = DRDY | ERR; ide.atapi = null; irq();   // 41h, as QEMU
  };
  const atapiDone = () => { ide.error = 0; ide.count = 0x03; ide.status = DRDY | DSC; ide.atapi = null; irq(); };
  // Send `data` (bytes) to the host, at most `alloc` of them, in DRQ blocks the byte count limits.
  const atapiSend = (data, alloc = data.length) => {
    const n = Math.min(data.length, alloc);
    if (n === 0) { atapiDone(); return; }
    ide.xfer = data; ide.xpos = 0; ide.xend = n; ide.atapi = 'in';
    nextChunk();
  };
  const nextChunk = () => {
    const left = ide.xend - ide.xpos;
    let size = left;
    if (size > ide.limit) size = ide.limit & ~1;       // a block that is not the last is even
    ide.chunkEnd = ide.xpos + size;
    ide.cylLo = size & 0xff; ide.cylHi = (size >> 8) & 0xff;
    ide.count = 0x02;                                  // IO: to the host, data
    ide.status = DRDY | DSC | DRQ; irq();
  };
  const be16 = (b, i) => (b[i] << 8) | b[i + 1];
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const put16 = (b, i, v) => { b[i] = (v >> 8) & 0xff; b[i + 1] = v & 0xff; };
  const put32 = (b, i, v) => { b[i] = (v >>> 24) & 0xff; b[i + 1] = (v >>> 16) & 0xff; b[i + 2] = (v >>> 8) & 0xff; b[i + 3] = v & 0xff; };
  const ascii = (b, at, len, s) => { for (let i = 0; i < len; i++) b[at + i] = i < s.length ? s.charCodeAt(i) : 0x20; };
  const lba2msf = (b, i, lba) => { lba += 150; b[i] = 0; b[i + 1] = Math.floor(lba / 4500); b[i + 2] = Math.floor(lba / 75) % 60; b[i + 3] = lba % 75; };
  const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10));

  // The mode pages a CD-ROM reports: 01h read error recovery, 2Ah capabilities (as QEMU's).
  const modePage = (page, d) => {
    if (page === 0x01) return [0x01, 0x06, 0x00, 0x05, 0, 0, 0, 0];
    if (page === 0x2a) {
      const p = new Array(22).fill(0);
      p[0] = 0x2a; p[1] = 0x14; p[2] = 0x3b; p[4] = 0x71; p[5] = 3 << 5;
      p[6] = 0x01 | 0x08 | 0x20 | (d.locked ? 0x02 : 0);   // lock, eject, tray loader; locked
      p[8] = 0x02; p[9] = 0xc0;                            // maximum speed 704 KB/s (4x)
      p[11] = 2;                                           // two volume levels
      p[12] = 0x02; p[13] = 0x00;                          // 512 KB buffer
      p[14] = 0x02; p[15] = 0xc0;                          // current speed
      return p;
    }
    return null;
  };
  const modeSense = (b, ten) => {
    const d = cd(), page = b[2] & 0x3f, pc = b[2] >> 6, alloc = ten ? be16(b, 7) : b[4];
    if (pc === 3) { checkCondition(ILLEGAL_REQUEST, 0x39); return; }   // saved values: not supported
    const pages = page === 0x3f ? [0x01, 0x2a] : [page];
    const body = [];
    for (const p of pages) { const m = modePage(p, d); if (!m) { checkCondition(ILLEGAL_REQUEST, ASC_INVALID_FIELD); return; } body.push(...m); }
    const medium = 0x70;                                 // the medium type QEMU reports, disc or none
    const hdr = ten ? [0, 0, medium, 0, 0, 0, 0, 0] : [0, medium, 0, 0];
    const out = new Uint8Array([...hdr, ...body]);
    if (ten) put16(out, 0, out.length - 2); else out[0] = out.length - 1;
    atapiSend(out, alloc);
  };
  const readTOC = (b) => {
    const d = cd(), total = d.data.length / CDSECTOR, msf = b[1] & 2, track = b[6], alloc = be16(b, 7);
    const format = (b[2] & 0x0f) || (b[9] >> 6);
    const out = [0, 0, 1, 1];
    const desc = (ctl, n, lba) => { const e = [0, ctl, n, 0, 0, 0, 0, 0]; if (msf) lba2msf(e, 4, lba); else put32(e, 4, lba); out.push(...e); };
    if (format === 0) {
      if (track > 1 && track !== 0xaa) { checkCondition(ILLEGAL_REQUEST, ASC_INVALID_FIELD); return; }
      if (track <= 1) desc(0x14, 1, 0);                  // track 1: data, ADR 1
      desc(0x16, 0xaa, total);                           // the lead-out
    } else if (format === 1) desc(0x14, 1, 0);           // multisession: one session, starting at track 1
    else { checkCondition(ILLEGAL_REQUEST, ASC_INVALID_FIELD); return; }
    const a = new Uint8Array(out); put16(a, 0, a.length - 2);
    atapiSend(a, alloc);
  };
  // READ (10/12) and READ CD: sectors straight from the image. Raw sectors (READ CD flags F8h) are
  // built as mode 1: sync, BCD MSF header, the 2048 bytes, and a zero EDC/ECC area.
  const readSectors = (lba, n, raw) => {
    const d = cd(), total = d.data.length / CDSECTOR;
    if (lba + n > total) { checkCondition(ILLEGAL_REQUEST, ASC_LBA_RANGE); return; }
    if (!raw) { atapiSend(d.data.subarray(lba * CDSECTOR, (lba + n) * CDSECTOR)); return; }
    const out = new Uint8Array(n * 2352);
    for (let i = 0; i < n; i++) {
      const o = i * 2352, a = lba + i + 150;
      out.fill(0xff, o + 1, o + 11);
      out[o + 12] = bcd(Math.floor(a / 4500)); out[o + 13] = bcd(Math.floor(a / 75) % 60); out[o + 14] = bcd(a % 75); out[o + 15] = 1;
      out.set(d.data.subarray((lba + i) * CDSECTOR, (lba + i + 1) * CDSECTOR), o + 16);
    }
    atapiSend(out);
  };
  const NEEDS_MEDIUM = new Set([0x00, 0x25, 0x28, 0xa8, 0xbe, 0x43, 0x51, 0x2b]);
  const execPacket = () => {
    const b = ide.packet, op = b[0], d = cd();
    // A disc inserted since the last command: the first command that is not REQUEST SENSE or INQUIRY
    // (or GET CONFIGURATION / GET EVENT STATUS, which must not consume it) is told the medium changed.
    if (d.changed && op !== 0x03 && op !== 0x12 && op !== 0x46 && op !== 0x4a) {
      d.changed = false; checkCondition(UNIT_ATTENTION, ASC_MEDIUM_CHANGED); return;
    }
    if (NEEDS_MEDIUM.has(op) && !d.data) { checkCondition(NOT_READY, ASC_NO_MEDIUM); return; }
    switch (op) {
      case 0x00: atapiDone(); return;                                          // TEST UNIT READY
      case 0x03: {                                                             // REQUEST SENSE
        const out = new Uint8Array(18);
        out[0] = 0xf0; out[2] = sense.key; out[7] = 10; out[12] = sense.asc; out[13] = sense.ascq;
        sense.key = sense.asc = sense.ascq = 0;
        atapiSend(out, b[4]); return;
      }
      case 0x12: {                                                             // INQUIRY
        const out = new Uint8Array(36);
        out[0] = 0x05; out[1] = 0x80; out[2] = 0x00; out[3] = 0x21; out[4] = 31;
        ascii(out, 8, 8, 'MIRAGE'); ascii(out, 16, 16, 'CD-ROM'); ascii(out, 32, 4, '1.0');
        atapiSend(out, b[4]); return;
      }
      case 0x5a: modeSense(b, true); return;
      case 0x1b: {                                                             // START STOP UNIT
        if ((b[4] & 3) === 2 && !d.locked) { d.data = null; }                  // eject
        atapiDone(); return;
      }
      case 0x1e: d.locked = !!(b[4] & 1); atapiDone(); return;                 // PREVENT ALLOW MEDIUM REMOVAL
      case 0x25: {                                                             // READ CAPACITY
        const out = new Uint8Array(8);
        put32(out, 0, d.data.length / CDSECTOR - 1); put32(out, 4, CDSECTOR);
        atapiSend(out); return;
      }
      case 0x28: readSectors(be32(b, 2), be16(b, 7), false); return;          // READ (10)
      case 0xa8: readSectors(be32(b, 2), be32(b, 6), false); return;          // READ (12)
      case 0xbe: {                                                             // READ CD
        const n = (b[6] << 16) | (b[7] << 8) | b[8], flags = b[9];
        if (flags === 0x10) readSectors(be32(b, 2), n, false);
        else if (flags === 0xf8) readSectors(be32(b, 2), n, true);
        else if (flags === 0) atapiDone();
        else checkCondition(ILLEGAL_REQUEST, ASC_INVALID_FIELD);
        return;
      }
      case 0x2b: case 0xbb: atapiDone(); return;                               // SEEK, SET CD SPEED
      case 0x43: readTOC(b); return;
      case 0x46: {                                                             // GET CONFIGURATION: the header
        const out = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0,                   // and feature 0000h, the
          0, 0, 0x03, 4, 0x00, 0x08, d.data ? 1 : 0, 0]);                      // profile list: CD-ROM (0008h)
        put32(out, 0, out.length - 4); put16(out, 6, d.data ? 0x0008 : 0);
        atapiSend(out, be16(b, 7)); return;
      }
      case 0x4a: {                                                             // GET EVENT STATUS NOTIFICATION
        if (!(b[1] & 1)) { checkCondition(ILLEGAL_REQUEST, ASC_INVALID_FIELD); return; }   // polled only
        if (b[4] & 0x10) atapiSend(new Uint8Array([0, 4, 0x04, 0x10, 0, d.data ? 0x02 : 0, 0, 0]), be16(b, 7));
        else atapiSend(new Uint8Array([0, 2, 0x80, 0x10]), be16(b, 7));        // no event of a requested class
        return;
      }
      case 0x51: {                                                             // READ DISC INFORMATION
        const out = new Uint8Array(34);
        put16(out, 0, 32); out[2] = 0x0e; out[3] = 1; out[4] = 1; out[5] = 1; out[6] = 1; out[7] = 0x20;
        atapiSend(out, be16(b, 7)); return;
      }
      case 0xbd: {                                                             // MECHANISM STATUS
        const out = new Uint8Array(8); out[5] = 1;
        atapiSend(out, be16(b, 8)); return;
      }
      default: checkCondition(ILLEGAL_REQUEST, ASC_INVALID_OPCODE);
    }
  };
  const atapiCommand = (cmd) => {
    switch (cmd) {
      case 0xa0: {                                                             // PACKET
        if (ide.features & 1) { ide.error = ABRT; ide.status = DRDY | ERR; irq(); return; }   // DMA: not offered
        ide.limit = (ide.cylHi << 8) | ide.cylLo;
        if (ide.limit === 0 || ide.limit === 0xffff) ide.limit = 0xfffe;
        ide.atapi = 'packet'; ide.packetLen = 0;
        ide.count = 0x01;                                                      // CoD: the host sends a command
        ide.status = DRDY | DSC | DRQ;                                         // no interrupt for the packet
        return;
      }
      case 0xa1: identifyPacket(); return;
      case 0x08: cdSignature(); ide.error = 0x01; ide.status = 0; ide.atapi = null; return;   // DEVICE RESET
      case 0x90: ide.error = 0x01; cdSignature(); ide.status = 0; irq(); return;             // DIAGNOSTIC
      case 0xef: case 0xe7: case 0x00:
        done(); return;
      default:
        if (cmd >= 0xe0 && cmd <= 0xe5) { if (cmd === 0xe5) ide.count = 0xff; done(); return; }
        cdSignature(); ide.error = ABRT; ide.status = DRDY | ERR; irq();   // IDENTIFY DEVICE, every disk command
    }
  };

  const command = (cmd) => {
    ide.error = 0;
    if (cd()) { atapiCommand(cmd); return; }
    if (!drive()) {                                   // the selected device is not there: nobody takes
      if (cmd === 0x90) { ide.error = 0x01; done(); }  // the command, and the master's status is its own
      return;                                         // (it read 00h back for the master after a slave probe)
    }
    switch (true) {
      case cmd === 0xec: identify(); return;
      case cmd === 0x20 || cmd === 0x21 || cmd === 0xc4: {
        ide.remaining = ide.count || 256; ide.lba = address(); ide.writing = false;
        ide.perIrq = cmd === 0xc4 ? (ide.multiple || 1) : 1;
        if (cmd === 0xc4 && !ide.multiple) { abort(); return; }
        readBlock(); return;
      }
      case cmd === 0x30 || cmd === 0x31 || cmd === 0xc5: {
        ide.remaining = ide.count || 256; ide.lba = address(); ide.writing = true;
        ide.perIrq = cmd === 0xc5 ? (ide.multiple || 1) : 1;
        if (cmd === 0xc5 && !ide.multiple) { abort(); return; }
        beginWriteBlock(); return;                     // the first block needs no interrupt
      }
      case cmd === 0xc6: {                            // SET MULTIPLE MODE
        const n = ide.count;
        if (n === 0 || n > 16 || (n & (n - 1))) { abort(); return; }
        ide.multiple = n; done(); return;
      }
      case cmd === 0x91:                              // INITIALIZE DEVICE PARAMETERS
        ide.heads = (ide.head & 0x0f) + 1; ide.spt = ide.count; done(); return;
      case (cmd & 0xf0) === 0x10:                     // RECALIBRATE
        ide.cylLo = 0; ide.cylHi = 0; done(); return;
      case (cmd & 0xf0) === 0x70:                     // SEEK
      case cmd === 0x40 || cmd === 0x41:              // READ VERIFY
      case cmd === 0xef: case cmd === 0xe7:           // SET FEATURES, FLUSH CACHE
      case cmd >= 0xe0 && cmd <= 0xe5:                // standby / idle / check power
        if (cmd === 0xe5) ide.count = 0xff;           // CHECK POWER MODE: active
        done(); return;
      case cmd === 0x90:                              // EXECUTE DEVICE DIAGNOSTIC
        ide.error = 0x01; signature(); done(); return;
      default: abort();
    }
  };
  const signature = () => { ide.count = 1; ide.sector = 1; ide.cylLo = 0; ide.cylHi = 0; ide.head &= 0xf0; };

  const readStatus = () => {
    if (!dev()) return 0;                             // nothing answers for an absent device
    machine.lowerIRQ(cfg.irq);                        // reading STATUS acknowledges INTRQ
    return ide.status;
  };
  const atapiRead = (size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v |= (ide.xpos < ide.chunkEnd ? ide.xfer[ide.xpos++] : 0) << (8 * i);
    if (ide.xpos >= ide.chunkEnd) { if (ide.xpos < ide.xend) nextChunk(); else atapiDone(); }
    return v >>> 0;
  };
  const dataRead = (size) => {
    if (!(ide.status & DRQ)) return size === 2 ? 0xffff : size === 4 ? 0xffffffff : 0xff;
    if (ide.atapi === 'in') return atapiRead(size);
    let v = ide.buf[ide.bufPos++];
    if (size === 2) v |= ide.buf[ide.bufPos++] << 8;
    if (size === 4) { v |= ide.buf[ide.bufPos++] << 8; v |= ide.buf[ide.bufPos++] << 16; v |= ide.buf[ide.bufPos++] << 24; v >>>= 0; }
    if (ide.bufPos >= ide.bufLen) {
      if (ide.remaining > 0 && !ide.writing) readBlock(); else ide.status = DRDY | DSC;
    }
    return v;
  };
  const dataWrite = (size, v) => {
    if (ide.atapi === 'packet' && (ide.status & DRQ)) {
      for (let i = 0; i < size && ide.packetLen < 12; i++) ide.packet[ide.packetLen++] = (v >>> (8 * i)) & 0xff;
      if (ide.packetLen >= 12) { ide.status = DRDY | DSC | BSY; ide.atapi = null; execPacket(); }
      return;
    }
    if (!(ide.status & DRQ) || !ide.writing) return;
    ide.buf[ide.bufPos++] = v & 0xff;
    if (size >= 2) ide.buf[ide.bufPos++] = (v >>> 8) & 0xff;
    if (size === 4) { ide.buf[ide.bufPos++] = (v >>> 16) & 0xff; ide.buf[ide.bufPos++] = (v >>> 24) & 0xff; }
    if (ide.bufPos >= ide.bufLen) { ide.status = DRDY | DSC | BSY; commitWriteBlock(); }
  };

  const B = cfg.base;
  const reg = (fn) => (p, s) => (cfg.present() ? fn(p, s) : (s === 2 ? 0xffff : s === 4 ? 0xffffffff : 0xff));
  const wreg = (fn) => (p, s, v) => { if (cfg.present()) fn(p, s, v); };
  const onR = (port, fn) => machine.onPortRead(port, reg(fn)), onW = (port, fn) => machine.onPortWrite(port, wreg(fn));
  onR(B, (_p, s) => dataRead(s));
  onW(B, (_p, s, v) => dataWrite(s, v));
  onR(B + 1, () => ide.error);
  onR(B + 2, () => ide.count);
  onR(B + 3, () => ide.sector);
  onR(B + 4, () => ide.cylLo);
  onR(B + 5, () => ide.cylHi);
  onR(B + 6, () => ide.head);
  onR(B + 7, readStatus);
  onR(cfg.ctl, () => (dev() ? ide.status : 0));      // alternate status: no acknowledge
  onW(B + 1, (_p, _s, v) => { ide.features = v & 0xff; });
  onW(B + 2, (_p, _s, v) => { ide.count = v & 0xff; });
  onW(B + 3, (_p, _s, v) => { ide.sector = v & 0xff; });
  onW(B + 4, (_p, _s, v) => { ide.cylLo = v & 0xff; });
  onW(B + 5, (_p, _s, v) => { ide.cylHi = v & 0xff; });
  onW(B + 6, (_p, _s, v) => { ide.head = (v & 0xff) | 0xa0; });
  onW(B + 7, (_p, _s, v) => command(v & 0xff));
  onW(cfg.ctl, (_p, _s, v) => {
    const was = ide.control; ide.control = v & 0xff;
    if ((was & 0x04) && !(v & 0x04)) {                // SRST released: diagnostic passed, signature
      ide.error = 0x01; ide.head = 0xa0; ide.atapi = null;
      if (cd()) { cdSignature(); ide.status = 0; } else { signature(); ide.status = DRDY | DSC; }
    } else if (v & 0x04) ide.status = BSY;
  });
  return ide;
}
