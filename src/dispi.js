// dispi.js — the Bochs/QEMU "DISPI" display interface: index port 1CEh, data port 1CFh (and 1D0h,
// its alias), the registers QEMU's standard VGA answers (hw/display/vga.c, vbe_ioport_*):
//   0 ID (B0C0h-B0C5h)   1 XRES   2 YRES   3 BPP   4 ENABLE   5 BANK
//   6 VIRT_WIDTH   7 VIRT_HEIGHT   8 X_OFFSET   9 Y_OFFSET   0Ah VIDEO_MEMORY_64K
//
// A driver that knows this card programs a mode straight through these registers instead of the
// VBE BIOS: Windows NT 3.51 under QEMU sets 1024x768x8 that way, and v86 presents the same card.
// It drives the SAME framebuffer as MIRAGE's VBE BIOS (machine.vbe, at machine.vbeFbBase), and the
// registers READ from that state — a mode set through 4F02h shows here as enabled, as it does under
// QEMU, where SeaVGABIOS itself goes through these ports.
//
// ENABLE: bit 0 enabled, bit 1 GETCAPS (XRES/YRES/BPP then read as the maxima), bit 5 8-bit DAC,
// bit 6 LFB, bit 7 NOCLEARMEM. A mode that does not fit the framebuffer is refused (stays disabled).

const ID = 0, XRES = 1, YRES = 2, BPP = 3, ENABLE = 4, BANK = 5, VWIDTH = 6, VHEIGHT = 7, XOFF = 8, YOFF = 9, VMEM = 10;
const MAX_X = 16000, MAX_Y = 12000, MAX_BPP = 32;   // QEMU's VBE_DISPI_MAX_*: drivers then fit VIDEO_MEMORY
const BPPS = new Set([8, 15, 16, 24, 32]);

export function installDISPI(machine) {
  const regs = new Uint16Array(16);
  regs[ID] = 0xb0c5;
  let index = 0, caps = false;
  const fbBytes = () => machine.vbeFbBytes || (2 << 20);
  const bytesPP = (bpp) => (bpp + 7) >> 3;

  // Rebuild machine.vbe from the registers, when enabled.
  const apply = (noClear) => {
    const w = regs[XRES], h = regs[YRES], bpp = regs[BPP];
    const vw = Math.max(regs[VWIDTH] || w, w), pitch = vw * bytesPP(bpp);
    const start = regs[YOFF] * pitch + regs[XOFF] * bytesPP(bpp);
    if (!BPPS.has(bpp) || w === 0 || h === 0 || (w & 7) || start + h * pitch > fbBytes()) return false;
    const base = machine.vbeFbBase >>> 0;
    const was = machine.vbe;
    machine.vbe = { number: 0, width: w, height: h, bpp, pitch, linear: true, base: (base + start) >>> 0, bank: was ? was.bank : 0, dispi: true, fbBase: base };
    if (!noClear && !(was && was.dispi)) machine.mem.u8.fill(0, base, base + fbBytes());
    machine.vbeWindow(machine.vbe.bank);
    machine.mem.setPlanar(true);
    return true;
  };

  // The registers are plain storage, as in QEMU (0 at power-on but for ID). A mode the VBE BIOS set
  // (4F02h, machine.vbe without .dispi) reads back as SeaVGABIOS's own writes would have left them.
  const read = () => {
    const v = machine.vbe, bios = v && !v.dispi;
    if (caps && (index === XRES || index === YRES || index === BPP)) return index === XRES ? MAX_X : index === YRES ? MAX_Y : MAX_BPP;
    switch (index) {
      case XRES: return bios ? v.width : regs[XRES];
      case YRES: return bios ? v.height : regs[YRES];
      case BPP: return bios ? v.bpp : regs[BPP];
      case ENABLE: return bios ? 0x41 : regs[ENABLE];
      case BANK: return v ? v.bank : regs[BANK];
      case VWIDTH: return bios ? (v.pitch / bytesPP(v.bpp)) | 0 : regs[VWIDTH];
      case VHEIGHT: {
        const pitch = bios ? v.pitch : regs[VWIDTH] * bytesPP(regs[BPP]);
        return pitch ? Math.min(0xffff, (fbBytes() / pitch) | 0) : 0;
      }
      case VMEM: return fbBytes() >>> 16;
      default: return regs[index] ?? 0;
    }
  };

  const write = (val) => {
    val &= 0xffff;
    switch (index) {
      case ID: if (val >= 0xb0c0 && val <= 0xb0c5) regs[ID] = val; return;
      case XRES: case YRES: case BPP: regs[index] = val; return;   // take effect on the next enable
      case ENABLE: {
        caps = (val & 0x02) !== 0;
        regs[ENABLE] = val;
        if (val & 0x01) {
          // Turning it on (as QEMU: only from off) resets the virtual width and the display offset.
          if (!(machine.vbe && machine.vbe.dispi)) { regs[VWIDTH] = regs[XRES]; regs[XOFF] = regs[YOFF] = 0; }
          if (!apply(val & 0x80)) regs[ENABLE] &= ~1;
        }
        else if (machine.vbe) { machine.vbe = null; machine.mem.setPlanar(machine.bios && machine.bios.planar); }
        return;
      }
      case BANK: regs[BANK] = val; if (machine.vbe) machine.vbeWindow(val); return;
      case VWIDTH: regs[VWIDTH] = val; if (machine.vbe && machine.vbe.dispi) apply(true); return;
      case XOFF: case YOFF: regs[index] = val; if (machine.vbe && machine.vbe.dispi) apply(true); return;
      default: return;                                             // VIRT_HEIGHT, VIDEO_MEMORY: read-only
    }
  };

  machine.onPortRead(0x1ce, () => index);
  machine.onPortWrite(0x1ce, (_p, _s, v) => { index = v & 0xffff; });
  for (const p of [0x1cf, 0x1d0]) {
    machine.onPortRead(p, () => read());
    machine.onPortWrite(p, (_p, _s, v) => write(v));
  }
  machine.dispi = { regs, read: (i) => { index = i; return read(); }, write: (i, v) => { index = i; write(v); } };
  return machine.dispi;
}
