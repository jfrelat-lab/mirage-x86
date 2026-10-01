// pci.js — a PCI bus, as QEMU's `-M pc` presents one: an i440FX host bridge (00.0), a PIIX3 ISA
// bridge (01.0), the PIIX3 IDE function (01.1), reached through configuration mechanism #1
// (CF8h address, CFCh-CFFh data), and its display (02.0), plus what SeaBIOS adds around them — the PCI BIOS (INT 1Ah
// AH=B1h), the "$PIR" IRQ routing table and the ELCR (4D0h/4D1h).
//
// Optional, like the difference between QEMU's two machines: `installBIOS(machine, { pci: true })`
// (MIRAGE_PCI=1 in the tools). Windows NT 3.51 and 9legacy boot under QEMU -M pc and not under
// -M isapc — NT stops with INACCESSIBLE_BOOT_DEVICE, Plan 9 reboots in a loop — so for them the bus
// is the boot device's parent, not an extra. ISA-era systems keep the machine they always had.
//
// Every value below was READ from QEMU -M pc with tools/pcidump.asm (configuration space, ELCR,
// B101h/B102h, the $PIR bytes), not taken from a datasheet. The IDE function is in legacy mode
// (prog-if 80h: the channels sit at 1F0h/170h on IRQ 14/15, where src/ide.js already answers), and
// its bus-master registers (BAR4, C000h) are present but move no data: a PIO driver never starts
// them, and a DMA driver sees the engine idle.

const BUS_MASTER_BASE = 0xc000;
const PIR_OFF = 0xd000;                         // F000:D000 — free ROM, measured (tools: romfree)

// The $PIR table QEMU's SeaBIOS builds for -M pc: router 00:01.0 (8086:122E-compatible), six slots
// (devices 1-6) with the four PIRQ links rotating, IRQ bitmap DEF8h, checksum 37h.
const PIR = [
  0x24, 0x50, 0x49, 0x52, 0x00, 0x01, 0x80, 0x00, 0x00, 0x08, 0x00, 0x00, 0x86, 0x80, 0x2e, 0x12,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x37,
  0x00, 0x08, 0x60, 0xf8, 0xde, 0x61, 0xf8, 0xde, 0x62, 0xf8, 0xde, 0x63, 0xf8, 0xde, 0x00, 0x00,
  0x00, 0x10, 0x61, 0xf8, 0xde, 0x62, 0xf8, 0xde, 0x63, 0xf8, 0xde, 0x60, 0xf8, 0xde, 0x01, 0x00,
  0x00, 0x18, 0x62, 0xf8, 0xde, 0x63, 0xf8, 0xde, 0x60, 0xf8, 0xde, 0x61, 0xf8, 0xde, 0x02, 0x00,
  0x00, 0x20, 0x63, 0xf8, 0xde, 0x60, 0xf8, 0xde, 0x61, 0xf8, 0xde, 0x62, 0xf8, 0xde, 0x03, 0x00,
  0x00, 0x28, 0x60, 0xf8, 0xde, 0x61, 0xf8, 0xde, 0x62, 0xf8, 0xde, 0x63, 0xf8, 0xde, 0x04, 0x00,
  0x00, 0x30, 0x61, 0xf8, 0xde, 0x62, 0xf8, 0xde, 0x63, 0xf8, 0xde, 0x60, 0xf8, 0xde, 0x05, 0x00,
];

/** One PCI function: 256 bytes of configuration space and, per byte, the bits software may write. */
class Fn {
  constructor(devfn, dwords, writable = {}) {
    this.devfn = devfn;
    this.cfg = new Uint8Array(256);
    this.wmask = new Uint8Array(256);
    const dv = new DataView(this.cfg.buffer);
    dwords.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
    this.wmask[0x04] = 0x07;                     // command: I/O, memory, bus master
    this.wmask[0x0c] = 0xff; this.wmask[0x0d] = 0xff;   // cache line size, latency timer
    this.wmask[0x3c] = 0xff;                     // interrupt line
    for (const [off, mask] of Object.entries(writable)) this.wmask[Number(off)] = mask;
    this.bars = [];                              // { off, size, io, onMove }
  }
  get vendor() { return this.cfg[0] | (this.cfg[1] << 8); }
  get device() { return this.cfg[2] | (this.cfg[3] << 8); }
  get classCode() { return (this.cfg[0x09] | (this.cfg[0x0a] << 8) | (this.cfg[0x0b] << 16)) >>> 0; }
  read(off, size) {
    let v = 0;
    for (let i = 0; i < size; i++) v |= this.cfg[(off + i) & 0xff] << (8 * i);
    return v >>> 0;
  }
  write(off, size, v) {
    for (let i = 0; i < size; i++) {
      const o = (off + i) & 0xff, b = (v >>> (8 * i)) & 0xff, m = this.wmask[o];
      // Status (06h-07h) is write-one-to-clear: no bit of ours is ever set, so nothing to clear.
      this.cfg[o] = (this.cfg[o] & ~m) | (b & m);
    }
    for (const bar of this.bars) if (off <= bar.off + 3 && off + size > bar.off) {
      const dv = new DataView(this.cfg.buffer);
      // A BAR decodes only the address bits above its size: writing FFFFFFFFh and reading back is how
      // software sizes it (PCI 2.1 §6.2.5.1).
      const raw = dv.getUint32(bar.off, true);
      const base = (raw & ~(bar.size - 1)) >>> 0;
      dv.setUint32(bar.off, (base | (bar.io ? 1 : (bar.type ?? 0x08))) >>> 0, true);
      if (bar.onMove) bar.onMove(bar.io ? base & 0xffff : base);
    }
  }
}

export function installPCI(machine) {
  const mem = machine.mem;
  // 00.0 i440FX host bridge, 01.0 PIIX3 ISA bridge, 01.1 PIIX3 IDE — dwords 00h-3Fh as QEMU shows them.
  const host = new Fn(0x00, [0x12378086, 0x00000103, 0x06000002, 0x00000000, 0, 0, 0, 0, 0, 0, 0, 0x11001af4, 0, 0, 0, 0]);
  // The host bridge's 50h-5Fh and 70h-73h as SeaBIOS leaves them: DRB at 57h, the PAM registers
  // (59h-5Fh: BIOS and option-ROM areas shadowed read/write) and SMRAM at 72h. Stored, not acted on:
  // MIRAGE's ROM area is RAM already, which is what shadowing makes it.
  const hdv = new DataView(host.cfg.buffer);
  hdv.setUint32(0x54, 0x08000000, true); hdv.setUint32(0x58, 0x11111000, true); hdv.setUint32(0x5c, 0x33111111, true);
  hdv.setUint32(0x70, 0x000a0000, true);
  for (let o = 0x59; o <= 0x5f; o++) host.wmask[o] = 0x33;
  host.wmask[0x72] = 0x78;
  const isa = new Fn(0x08, [0x70008086, 0x02000103, 0x06010000, 0x00800000, 0, 0, 0, 0, 0, 0, 0, 0x11001af4, 0, 0, 0, 0],
    { 0x60: 0x8f, 0x61: 0x8f, 0x62: 0x8f, 0x63: 0x8f });   // PIRQRC[A-D]: IRQ in bits 0-3, bit 7 = disable
  // The rest of the ISA bridge as QEMU leaves it: 4Ch-4Fh, the PIRQ routing SeaBIOS programmed
  // (A,B -> IRQ 10, C,D -> IRQ 11, matching ELCR 0C00h), 68h-6Bh and 70h-77h.
  const idv = new DataView(isa.cfg.buffer);
  idv.setUint32(0x4c, 0x0003004d, true); idv.setUint32(0x60, 0x0b0b0a0a, true); idv.setUint32(0x68, 0x00000200, true);
  idv.setUint32(0x70, 0x00000080, true); idv.setUint32(0x74, 0x0c0c0000, true); idv.setUint32(0x78, 0x00000002, true);
  const ide = new Fn(0x09, [0x70108086, 0x02800103, 0x01018000, 0x00000000, 0, 0, 0, 0, 0x0000c001, 0, 0, 0x11001af4, 0, 0, 0, 0],
    { 0x20: 0xf0, 0x21: 0xff, 0x22: 0xff, 0x23: 0xff, 0x40: 0xff, 0x41: 0xff, 0x42: 0xff, 0x43: 0xff });
  new DataView(ide.cfg.buffer).setUint32(0x40, 0x80008000, true);   // IDETIM: both channels decode

  // Bus-master IDE: command, status and the PRD pointer for each channel, 8 bytes apart. Registers
  // only — see the header.
  const bm = new Uint8Array(16);
  let bmBase = -1;
  const mapBM = (base) => {
    if (bmBase >= 0) for (let p = 0; p < 16; p++) { machine.onPortRead(bmBase + p, null); machine.onPortWrite(bmBase + p, null); }
    bmBase = base;
    if (!base) { bmBase = -1; return; }
    for (let p = 0; p < 16; p++) {
      machine.onPortRead(base + p, (_q, size) => { let v = 0; for (let i = 0; i < size; i++) v |= bm[(p + i) & 15] << (8 * i); return v; });
      machine.onPortWrite(base + p, (_q, size, v) => {
        for (let i = 0; i < size; i++) {
          const r = (p + i) & 15, b = (v >>> (8 * i)) & 0xff;
          if ((r & 7) === 2) bm[r] = (bm[r] & ~(b & 0x06)) & ~0x60 | (b & 0x60);   // status: IRQ/error W1C, drive-DMA bits RW
          else bm[r] = b;
        }
      });
    }
  };
  ide.bars.push({ off: 0x20, size: 16, io: true, onMove: mapBM });
  mapBM(BUS_MASTER_BASE);

  // 02.0 the display, with QEMU's identity (1234:1111, class 0300h) so a guest that looks for a VGA
  // on the bus finds one — 9legacy otherwise says "no vga; serial console only", and MIRAGE has no
  // UART to answer it on. BAR0 is the VBE framebuffer installBIOS reserved at the top of RAM (QEMU's
  // is at FD000000h); 2 MiB, prefetchable, and 2 MiB-aligned by construction. QEMU's BAR2 (the Bochs
  // DISPI registers) has nothing behind it here and stays unimplemented.
  const fb = (machine.vbeFbBase >>> 0) || 0;
  const vga = new Fn(0x10, [0x11111234, 0x00000103, 0x03000002, 0x00000000, (fb | 0x08) >>> 0, 0, 0, 0, 0, 0, 0, 0x11001af4, 0, 0, 0, 0],
    { 0x10: 0x00, 0x11: 0x00, 0x12: 0xe0, 0x13: 0xff });
  vga.bars.push({ off: 0x10, size: 2 << 20, io: false });
  new DataView(vga.cfg.buffer).setUint32(0x10, (fb | 0x08) >>> 0, true);

  const fns = [host, isa, ide, vga];
  const find = (devfn) => fns.find((f) => f.devfn === devfn);

  // ---- configuration mechanism #1 ----
  let addr = 0;
  const target = () => {
    if (!(addr & 0x80000000)) return null;
    if ((addr >>> 16) & 0xff) return null;                  // bus 0 only
    return find((addr >>> 8) & 0xff);
  };
  machine.onPortRead(0xcf8, (_p, size) => (size === 4 ? addr >>> 0 : 0xffffffff));
  machine.onPortWrite(0xcf8, (_p, size, v) => { if (size === 4) addr = (v & 0x80fffffc) >>> 0; });
  for (let k = 0; k < 4; k++) {
    machine.onPortRead(0xcfc + k, (_p, size) => {
      const f = target();
      if (!f) return size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
      return f.read((addr & 0xfc) + k, size);
    });
    machine.onPortWrite(0xcfc + k, (_p, size, v) => { const f = target(); if (f) f.write((addr & 0xfc) + k, size, v); });
  }

  // ---- ELCR: IRQs 10 and 11 level-triggered, as SeaBIOS leaves it for its PIRQ routing ----
  const elcr = [0x00, 0x0c];
  machine.onPortRead(0x4d0, () => elcr[0]);
  machine.onPortRead(0x4d1, () => elcr[1]);
  machine.onPortWrite(0x4d0, (_p, _s, v) => { elcr[0] = v & 0xf8; });   // IRQ 0-2 are always edge
  machine.onPortWrite(0x4d1, (_p, _s, v) => { elcr[1] = v & 0xde; });   // as are 8 and 13

  // ---- the $PIR table, in ROM ----
  PIR.forEach((b, i) => { mem.u8[0xf0000 + PIR_OFF + i] = b; });
  // ---- "PCI " somewhere in the F000 segment ----
  // Windows NT 3.51's NTDETECT.COM looks for the four bytes "PCI " in F000:0000-FFFC (a byte-wise
  // scan downwards from FFFCh, at 5406h in the file) BEFORE it dares INT 1Ah B101h; without them it
  // records no PCI adapter, the HAL builds no PCI bus handler (it wants a MultifunctionAdapter whose
  // Identifier is "PCI"), atapi.sys never sees the controller, and the kernel stops with
  // INACCESSIBLE_BOOT_DEVICE. SeaBIOS happens to carry the string; our ROM carries it on purpose.
  [...'PCI '].forEach((ch, i) => { mem.u8[0xf0000 + PIR_OFF + 0x80 + i] = ch.charCodeAt(0); });

  // ---- PCI BIOS, real mode (INT 1Ah AH=B1h; PCI BIOS Specification 2.1) ----
  // No BIOS32 service directory: a protected-mode caller finds none and uses mechanism #1 itself.
  const prev = machine.intHandlers[0x1a];
  const CF = 1;
  machine.intHandlers[0x1a] = (cpu, m) => {
    if (cpu.ah !== 0xb1) return prev ? prev(cpu, m) : undefined;
    const ok = (ah = 0) => { cpu.ah = ah; cpu.flags &= ~CF; };
    const fail = (ah) => { cpu.ah = ah; cpu.flags |= CF; };
    const al = cpu.reg[0] & 0xff;
    const fnAt = () => (((cpu.bx >> 8) & 0xff) === 0 ? find(cpu.bx & 0xff) : null);
    switch (al) {
      case 0x01:                                    // installation check
        cpu.reg[2] = 0x20494350;                    // EDX = "PCI "
        cpu.reg[0] = (cpu.reg[0] & 0xffff0000) | 0x0001;   // AH = 0, AL = mechanism #1
        cpu.bx = 0x0210;                            // version 2.10
        cpu.reg[1] = (cpu.reg[1] & ~0xff) | 0;      // CL = last bus
        cpu.reg[7] = 0;                             // EDI: no protected-mode entry point
        cpu.flags &= ~CF; return;
      case 0x02: case 0x03: {                       // find device (CX, DX) / find class (ECX)
        let n = cpu.si & 0xffff;
        for (const f of fns) {
          const hit = al === 0x02 ? (f.device === (cpu.cx & 0xffff) && f.vendor === (cpu.dx & 0xffff))
            : f.classCode === ((cpu.reg[1] >>> 0) & 0xffffff);
          if (hit && n-- === 0) { cpu.bx = f.devfn; return ok(); }
        }
        return fail(0x86);                          // DEVICE_NOT_FOUND
      }
      case 0x08: case 0x09: case 0x0a: {            // read configuration byte / word / dword
        const f = fnAt(), size = al === 0x08 ? 1 : al === 0x09 ? 2 : 4, reg = cpu.di & 0xff;
        if (reg & (size - 1)) return fail(0x87);    // BAD_REGISTER_NUMBER
        const v = f ? f.read(reg, size) : 0xffffffff;
        if (size === 4) cpu.reg[1] = v >>> 0; else if (size === 2) cpu.cx = v & 0xffff; else cpu.reg[1] = (cpu.reg[1] & ~0xff) | (v & 0xff);
        return ok();
      }
      case 0x0b: case 0x0c: case 0x0d: {            // write configuration byte / word / dword
        const f = fnAt(), size = al === 0x0b ? 1 : al === 0x0c ? 2 : 4, reg = cpu.di & 0xff;
        if (reg & (size - 1)) return fail(0x87);
        if (f) f.write(reg, size, size === 4 ? cpu.reg[1] >>> 0 : size === 2 ? cpu.cx & 0xffff : cpu.reg[1] & 0xff);
        return ok();
      }
      default: return fail(0x81);                   // FUNC_NOT_SUPPORTED
    }
  };

  machine.pci = { fns, find, elcr, bm };
  return machine.pci;
}
