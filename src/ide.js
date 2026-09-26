// ide.js — the primary ATA (IDE) channel, PIO only: ports 1F0h-1F7h, 3F6h, IRQ 14.
//
// The BIOS path (INT 13h, src/disk.js) is enough for DOS and for every boot loader, but a protected-
// mode kernel talks to the controller itself. Linux 2.2 (v86's bl3-5.img) boots through LILO and our
// INT 13h, then mounts /dev/hda1 through this port interface — without it: "VFS: Unable to mount root
// fs on 03:01". The same image the BIOS serves as drive 80h is the master here, so both views agree.
//
// Implemented from the ATA/ATAPI-4 register model, the part an old driver uses:
//   1F0 data (16-bit PIO)   1F1 error / features   1F2 sector count   1F3-1F5 LBA / sector+cylinder
//   1F6 drive/head (bit 4 = device, bit 6 = LBA)   1F7 status / command   3F6 alt status / device control
//   Commands: IDENTIFY (ECh), READ/WRITE SECTORS (20h/21h, 30h/31h), READ/WRITE MULTIPLE (C4h/C5h) with
//   SET MULTIPLE (C6h), INITIALIZE DEVICE PARAMETERS (91h), RECALIBRATE (1xh), SEEK (7xh), VERIFY
//   (40h/41h), SET FEATURES (EFh), FLUSH CACHE (E7h), the power commands (E0h-E5h), EXECUTE DEVICE
//   DIAGNOSTIC (90h). Anything else is aborted (ERR, error = ABRT).
// Transfers complete instantly (no seek or rotational timing): status is never busy when read.

const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;
const ABRT = 0x04;
const SECTOR = 512;

export function installIDE(machine) {
  const disk = machine.disk;
  const ide = {
    features: 0, count: 0, sector: 0, cylLo: 0, cylHi: 0, head: 0xa0,
    status: DRDY | DSC, error: 0x01, control: 0,
    buf: new Uint8Array(SECTOR * 256), bufLen: 0, bufPos: 0,
    writing: false, remaining: 0, lba: 0, multiple: 0, perIrq: 1,
    heads: 0, spt: 0,                                // the translation INITIALIZE DEVICE PARAMETERS set
  };
  machine.ide = ide;

  const drive = () => (disk && disk.drives.get((ide.head & 0x10) ? 0x81 : 0x80)) || null;
  const geom = () => { const d = drive(); return d ? d.geom : null; };
  const irq = () => { if (!(ide.control & 0x02)) machine.raiseIRQ(14); };   // nIEN masks the line
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

  // IDENTIFY DEVICE: 256 words. Strings are byte-swapped per word, as the standard lays them out.
  const identify = () => {
    const g = geom(), d = drive(), w = new Uint16Array(256);
    const total = Math.floor(d.data.length / SECTOR);
    const str = (at, len, s) => { s = s.padEnd(len * 2); for (let i = 0; i < len; i++) w[at + i] = (s.charCodeAt(2 * i) << 8) | s.charCodeAt(2 * i + 1); };
    w[0] = 0x0040;                                     // fixed disk
    w[1] = Math.min(g.cyl, 16383); w[3] = g.heads; w[6] = g.spt;
    str(10, 10, 'MIRAGE0000000001'); str(23, 4, '1.0'); str(27, 20, 'MIRAGE ATA DISK');
    w[47] = 0x8010;                                    // READ/WRITE MULTIPLE, up to 16 sectors
    w[49] = 0x0200;                                    // LBA supported
    w[51] = 0x0200; w[53] = 0x0001;                    // PIO timing mode 2; words 54-58 valid
    w[54] = Math.min(g.cyl, 16383); w[55] = ide.heads || g.heads; w[56] = ide.spt || g.spt;
    const cur = w[54] * w[55] * w[56]; w[57] = cur & 0xffff; w[58] = cur >>> 16;
    if (ide.multiple) w[59] = 0x0100 | ide.multiple;
    w[60] = total & 0xffff; w[61] = total >>> 16;
    w[80] = 0x001e;                                    // ATA-1..4
    new Uint16Array(ide.buf.buffer, 0, 256).set(w);
    ide.bufLen = SECTOR; ide.bufPos = 0; ide.remaining = 0;
    ide.status = DRDY | DSC | DRQ; irq();
  };

  const command = (cmd) => {
    ide.error = 0;
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
    if (!drive()) return 0;                           // nothing answers for an absent device
    machine.lowerIRQ(14);                             // reading STATUS acknowledges INTRQ
    return ide.status;
  };
  const dataRead = (size) => {
    if (!(ide.status & DRQ)) return size === 2 ? 0xffff : 0xff;
    let v = ide.buf[ide.bufPos++];
    if (size === 2) v |= ide.buf[ide.bufPos++] << 8;
    if (size === 4) { v |= ide.buf[ide.bufPos++] << 8; v |= ide.buf[ide.bufPos++] << 16; v |= ide.buf[ide.bufPos++] << 24; v >>>= 0; }
    if (ide.bufPos >= ide.bufLen) {
      if (ide.remaining > 0 && !ide.writing) readBlock(); else ide.status = DRDY | DSC;
    }
    return v;
  };
  const dataWrite = (size, v) => {
    if (!(ide.status & DRQ) || !ide.writing) return;
    ide.buf[ide.bufPos++] = v & 0xff;
    if (size >= 2) ide.buf[ide.bufPos++] = (v >>> 8) & 0xff;
    if (size === 4) { ide.buf[ide.bufPos++] = (v >>> 16) & 0xff; ide.buf[ide.bufPos++] = (v >>> 24) & 0xff; }
    if (ide.bufPos >= ide.bufLen) { ide.status = DRDY | DSC | BSY; commitWriteBlock(); }
  };

  // With no hard disk attached there is no controller either: every register floats at FFh, which is
  // how DOS software tells there is none — the behaviour these ports had before this device existed.
  const present = () => !!(disk && disk.drives.has(0x80));
  const reg = (fn) => (p, s) => (present() ? fn(p, s) : (s === 2 ? 0xffff : s === 4 ? 0xffffffff : 0xff));
  const wreg = (fn) => (p, s, v) => { if (present()) fn(p, s, v); };
  const onR = (port, fn) => machine.onPortRead(port, reg(fn)), onW = (port, fn) => machine.onPortWrite(port, wreg(fn));
  onR(0x1f0, (_p, s) => dataRead(s));
  onW(0x1f0, (_p, s, v) => dataWrite(s, v));
  onR(0x1f1, () => ide.error);
  onR(0x1f2, () => ide.count);
  onR(0x1f3, () => ide.sector);
  onR(0x1f4, () => ide.cylLo);
  onR(0x1f5, () => ide.cylHi);
  onR(0x1f6, () => ide.head);
  onR(0x1f7, readStatus);
  onR(0x3f6, () => (drive() ? ide.status : 0));      // alternate status: no acknowledge
  onW(0x1f1, (_p, _s, v) => { ide.features = v & 0xff; });
  onW(0x1f2, (_p, _s, v) => { ide.count = v & 0xff; });
  onW(0x1f3, (_p, _s, v) => { ide.sector = v & 0xff; });
  onW(0x1f4, (_p, _s, v) => { ide.cylLo = v & 0xff; });
  onW(0x1f5, (_p, _s, v) => { ide.cylHi = v & 0xff; });
  onW(0x1f6, (_p, _s, v) => { ide.head = (v & 0xff) | 0xa0; });
  onW(0x1f7, (_p, _s, v) => command(v & 0xff));
  onW(0x3f6, (_p, _s, v) => {
    const was = ide.control; ide.control = v & 0xff;
    if ((was & 0x04) && !(v & 0x04)) {                // SRST released: diagnostic passed, signature
      ide.error = 0x01; signature(); ide.status = DRDY | DSC; ide.head = 0xa0;
    } else if (v & 0x04) ide.status = BSY;
  });
  return ide;
}
