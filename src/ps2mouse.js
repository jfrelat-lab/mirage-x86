// ps2mouse.js — a PS/2 mouse on the 8042's auxiliary port, and the BIOS services that drive it.
//
// A guest that brings its OWN mouse driver — CuteMouse on v86's msdos622.img — finds the mouse
// through INT 15h AX=C2xx, the BIOS "pointing device" interface, not through INT 33h (which is the
// driver it is about to become). It asked C205 ("initialise, 3-byte packets") and got "function not
// supported", so it printed "Error: device not found" where QEMU prints "Installed at PS/2 port".
//
// THE THREE LAYERS, as on an AT with a PS/2 port:
//   * the DEVICE: 3-byte packets on the 8042's aux channel — port 0x60 data, port 0x64 bit 5 says
//     the pending byte came from the aux device. Driven by machine.mouseMoveRel / mouseButton, the
//     same host-facing entry points src/mouse.js already exposes to the browser.
//   * IRQ12 on the slave PIC, vector 74h.
//   * the BIOS: INT 15h C200-C207 (RBIL), and an INT 74h handler that reads the packet from port
//     0x60 and far-calls the routine the driver registered with C207, with the words
//     status, X, Y, 0 pushed in that order (SeaBIOS's convention and the IBM one). That handler is
//     real x86 code in the BIOS segment, so it runs whatever mode the guest is in — including in V86
//     under EMM386, where the IRQ goes through the monitor and is reflected to the IVT.
//
// ONE IRQ PER PACKET, NOT PER BYTE. Real hardware interrupts once per byte and the BIOS accumulates
// the packet in the EBDA. MIRAGE has no EBDA (it reports 640 KB), so the device queues a whole
// packet, raises IRQ12 once, and the handler reads its three bytes in a row. Invisible to a driver
// that uses the BIOS interface, which is what DOS mouse drivers do; a guest that hooks IRQ12 itself
// and reads ONE byte per interrupt is not served — named here rather than discovered later.

const HANDLER_OFF = 0xe800;          // F000:E800 — the INT 74h routine (free ROM space, measured)
const CALL_PTR = HANDLER_OFF + 18;   // the far-call immediate inside it, patched by C207

// The routine, byte for byte (16-bit, 186+ for PUSHA — a PS/2 port implies an AT anyway):
//   pusha / push ds / push es
//   in al,60h / mov ah,0 / push ax        status
//   in al,60h / push ax                   X
//   in al,60h / push ax                   Y
//   xor ax,ax / push ax                   Z (always 0 on a 3-byte mouse)
//   call far 0000:0000                    the driver's handler (C207 patches it)
//   add sp,8
//   mov al,20h / out 0A0h,al / out 20h,al EOI: slave, then master (the cascade)
//   pop es / pop ds / popa / iret
const ROUTINE = [
  0x60, 0x1e, 0x06,
  0xe4, 0x60, 0xb4, 0x00, 0x50,
  0xe4, 0x60, 0x50,
  0xe4, 0x60, 0x50,
  0x31, 0xc0, 0x50,
  0x9a, 0x00, 0x00, 0x00, 0x00,
  0x83, 0xc4, 0x08,
  0xb0, 0x20, 0xe6, 0xa0, 0xe6, 0x20,
  0x07, 0x1f, 0x61, 0xcf,
];

// Sample rates by C202's BH index, and C206's report of them (RBIL).
const RATES = [10, 20, 40, 60, 80, 100, 200];

export function installPS2Mouse(machine, BIOS_SEG) {
  const mem = machine.mem;
  const base = ((BIOS_SEG << 4) + HANDLER_OFF) >>> 0;
  for (let i = 0; i < ROUTINE.length; i++) mem.u8[base + i] = ROUTINE[i];
  machine.setVector(0x74, BIOS_SEG, HANDLER_OFF);

  const ps2 = {
    enabled: false,          // data reporting (C200 BH=1, or the device's own F4)
    handler: null,           // { seg, off } from C207
    packetSize: 3,
    rate: 100, resolution: 2, scaling: 1,
    buttons: 0,
    dx: 0, dy: 0,            // motion not yet sent: coalesced while a packet is in flight
    queue: [],               // aux bytes waiting in the 8042 (a packet, or command replies)
    param: null,             // a device command waiting for its parameter byte (E8h, F3h)
  };
  machine.ps2 = ps2;

  /** Is an aux byte waiting at port 0x60? */
  ps2.pending = () => ps2.queue.length > 0;
  /** Read it (port 0x60). When a packet has been drained, the next motion may go out. */
  ps2.read = () => {
    const v = ps2.queue.length ? ps2.queue.shift() : 0;
    if (!ps2.queue.length) ps2.flush();
    return v;
  };

  /** Form the next packet from accumulated motion, if the device may report and none is in flight. */
  ps2.flush = () => {
    if (!ps2.enabled || !ps2.handler || ps2.queue.length || machine.mouseIrqPending) return;
    if (!ps2.dx && !ps2.dy && ps2.buttons === ps2.sentButtons) return;
    // PS/2 counts are 9-bit two's complement with Y UP; the host's dy is screen-down.
    const cx = Math.max(-255, Math.min(255, ps2.dx)), cy = Math.max(-255, Math.min(255, -ps2.dy));
    ps2.dx -= cx; ps2.dy += cy;
    const status = 0x08 | (ps2.buttons & 7) | (cx < 0 ? 0x10 : 0) | (cy < 0 ? 0x20 : 0);
    ps2.queue.push(status, cx & 0xff, cy & 0xff);
    ps2.sentButtons = ps2.buttons;
    machine.mouseIrqPending = true;
    machine.hwIrqPending = true;          // the run loop's cheap guard for serviceHwInts
  };
  ps2.sentButtons = 0;

  /** Host input — called by src/mouse.js alongside its own INT 33h bookkeeping. */
  ps2.motion = (dx, dy) => { ps2.dx += dx; ps2.dy += dy; ps2.flush(); };
  ps2.button = (btn, down) => {
    if (down) ps2.buttons |= 1 << btn; else ps2.buttons &= ~(1 << btn);
    ps2.flush();
  };

  const reset = () => {
    ps2.enabled = false; ps2.rate = 100; ps2.resolution = 2; ps2.scaling = 1;
    ps2.dx = 0; ps2.dy = 0; ps2.queue.length = 0; ps2.param = null;
  };

  /** A byte the guest sent to the DEVICE (8042 command D4h, then port 0x60). Replies are queued
   *  on the aux channel — ACK FAh first, as a real mouse does. */
  ps2.deviceCommand = (v) => {
    const ack = (...more) => ps2.queue.push(0xfa, ...more);
    if (ps2.param) {
      if (ps2.param === 0xe8) ps2.resolution = v & 3;
      if (ps2.param === 0xf3) ps2.rate = v;
      ps2.param = null; ack(); return;
    }
    switch (v) {
      case 0xff: reset(); ack(0xaa, 0x00); return;                       // reset: self-test OK, ID 0
      case 0xf6: reset(); ack(); return;                                 // set defaults
      case 0xf5: ps2.enabled = false; ack(); return;                     // disable reporting
      case 0xf4: ps2.enabled = true; ack(); return;                      // enable reporting
      case 0xf2: ack(0x00); return;                                      // get ID: a standard mouse
      case 0xe8: case 0xf3: ps2.param = v; ack(); return;                // parameter follows
      case 0xe6: ps2.scaling = 1; ack(); return;
      case 0xe7: ps2.scaling = 2; ack(); return;
      case 0xe9: ack((ps2.enabled ? 0x20 : 0) | (ps2.scaling === 2 ? 0x10 : 0) | (ps2.buttons & 7),
                     ps2.resolution, ps2.rate); return;                  // status request
      default: ack();                                                    // EA/F0 stream/remote, EC/EE…
    }
  };

  // ---- INT 15h AH=C2h: the BIOS pointing-device interface (RBIL INT 15/AX=C200..C207) -----------
  // Return: CF clear and AH=00 on success; CF set and AH = 01 invalid function, 02 invalid input,
  // 03 interface error, 04 resend, 05 no far call installed.
  ps2.int15 = (cpu) => {
    const ok = () => { cpu.ah = 0; cpu.flags &= ~1; };
    const err = (code) => { cpu.ah = code; cpu.flags |= 1; };
    const bh = (cpu.bx >> 8) & 0xff;
    switch (cpu.al) {
      case 0x00:                                        // enable (BH=1) / disable (BH=0)
        if (bh === 1) {
          if (!ps2.handler) return err(0x05);           // SeaBIOS refuses to enable without a handler
          ps2.enabled = true;
          // Unmask IRQ12 and the cascade, as a BIOS that enables the port does (SeaBIOS
          // enable_hwirq). Nothing else would open them if the guest never touches the PIC.
          if (machine.pic) { machine.pic.slave.imr &= ~(1 << 4); machine.pic.master.imr &= ~(1 << 2); }
          ps2.flush();
          return ok();
        }
        if (bh === 0) { ps2.enabled = false; return ok(); }
        return err(0x01);
      case 0x01:                                        // reset: BH = device ID, BL = AAh
        reset(); cpu.bx = 0x00aa; return ok();
      case 0x02:                                        // set sample rate, BH = index
        if (bh >= RATES.length) return err(0x02);
        ps2.rate = RATES[bh]; return ok();
      case 0x03:                                        // set resolution, BH = 0..3
        if (bh > 3) return err(0x02);
        ps2.resolution = bh; return ok();
      case 0x04:                                        // get device type: BH = ID
        cpu.bx = cpu.bx & 0x00ff; return ok();
      case 0x05:                                        // initialise, BH = packet size (1..8)
        if (bh < 1 || bh > 8) return err(0x02);
        ps2.packetSize = bh; reset(); return ok();
      case 0x06:                                        // extended commands
        if (bh === 0) {                                 // status: BL flags, CL resolution, DL rate
          cpu.bx = (cpu.bx & 0xff00) | (ps2.enabled ? 0x20 : 0) | (ps2.scaling === 2 ? 0x10 : 0) | (ps2.buttons & 7);
          cpu.cx = (cpu.cx & 0xff00) | ps2.resolution;
          cpu.dx = (cpu.dx & 0xff00) | (ps2.rate & 0xff);
          return ok();
        }
        if (bh === 1) { ps2.scaling = 1; return ok(); }
        if (bh === 2) { ps2.scaling = 2; return ok(); }
        return err(0x01);
      case 0x07: {                                      // set the device handler, ES:BX (0:0 removes)
        const seg = cpu.seg[0] & 0xffff, off = cpu.bx & 0xffff;
        ps2.handler = (seg || off) ? { seg, off } : null;
        if (!ps2.handler) ps2.enabled = false;
        // The INT 74h routine far-calls through an immediate: patch it. mem.w16 keeps any block
        // translated from the old bytes honest (it marks them dirty).
        mem.w16(((BIOS_SEG << 4) + CALL_PTR) >>> 0, off);
        mem.w16(((BIOS_SEG << 4) + CALL_PTR + 2) >>> 0, seg);
        return ok();
      }
      default: return err(0x01);
    }
  };

  return ps2;
}
