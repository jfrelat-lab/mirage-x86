// mouse.js — a minimal Microsoft-compatible mouse driver (INT 33h), enough for demos
// that steer with the mouse. A program detects the driver with AX=0000, then typically
// polls relative motion (AX=000B — "mickeys") to move a camera and button state
// (AX=0005/0003). Tim Clarke's Mars, for instance, reads AX=000B every frame to look
// around. State lives DOM-free on the machine so the browser input layer — or a headless
// test — feeds it via machine.mouseMoveRel / mouseButton, and the INT handler reads it.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function installMouse(machine) {
  const st = {
    x: 320, y: 100,              // virtual position (driver default range 0..639 x 0..199)
    buttons: 0,                  // bit0 left, bit1 right, bit2 middle
    dx: 0, dy: 0,                // motion counters (mickeys) since the last AX=000B read
    minX: 0, maxX: 639, minY: 0, maxY: 199,
    visible: 0,
    press: [{ n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }],
    release: [{ n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }],
  };
  machine.mouse = st;

  const reset = () => {
    st.x = 320; st.y = 100; st.buttons = 0; st.dx = 0; st.dy = 0;
    st.minX = 0; st.maxX = 639; st.minY = 0; st.maxY = 199; st.visible = 0;
    for (let i = 0; i < 3; i++) { st.press[i] = { n: 0, x: 0, y: 0 }; st.release[i] = { n: 0, x: 0, y: 0 }; }
  };

  // ---- host-facing input (browser events, or a headless test) ----
  machine.mouseMoveRel = (mdx, mdy) => {
    st.dx += mdx; st.dy += mdy;                       // raw motion accumulates until read
    st.x = clamp(st.x + mdx, st.minX, st.maxX);       // clamped position tracks separately
    st.y = clamp(st.y + mdy, st.minY, st.maxY);
  };
  machine.mouseMoveTo = (px, py) => machine.mouseMoveRel(px - st.x, py - st.y);
  machine.mouseButton = (btn, down) => {
    if (btn < 0 || btn > 2) return;
    if (down) { st.buttons |= 1 << btn; const p = st.press[btn]; p.n++; p.x = st.x; p.y = st.y; }
    else { st.buttons &= ~(1 << btn); const r = st.release[btn]; r.n++; r.x = st.x; r.y = st.y; }
  };

  // ---- INT 33h service ----
  machine.hookInterrupt(0x33, (cpu) => {
    switch (cpu.ax & 0xffff) {
      case 0x0000: reset(); cpu.ax = 0xffff; cpu.bx = 2; break;                 // reset + detect (present, 2 buttons)
      case 0x0001: st.visible++; break;                                         // show cursor
      case 0x0002: st.visible--; break;                                         // hide cursor
      case 0x0003: cpu.cx = st.x & 0xffff; cpu.dx = st.y & 0xffff; cpu.bx = st.buttons; break;               // get position + buttons
      case 0x0004: st.x = clamp(cpu.cx & 0xffff, st.minX, st.maxX); st.y = clamp(cpu.dx & 0xffff, st.minY, st.maxY); break; // set position
      case 0x0005: { const b = (cpu.bx & 0xffff) > 2 ? 0 : (cpu.bx & 0xffff), p = st.press[b];              // button press data
        cpu.ax = st.buttons; cpu.bx = p.n; cpu.cx = p.x & 0xffff; cpu.dx = p.y & 0xffff; p.n = 0; break; }
      case 0x0006: { const b = (cpu.bx & 0xffff) > 2 ? 0 : (cpu.bx & 0xffff), r = st.release[b];            // button release data
        cpu.ax = st.buttons; cpu.bx = r.n; cpu.cx = r.x & 0xffff; cpu.dx = r.y & 0xffff; r.n = 0; break; }
      case 0x0007: st.minX = cpu.cx & 0xffff; st.maxX = cpu.dx & 0xffff; break;  // set horizontal range
      case 0x0008: st.minY = cpu.cx & 0xffff; st.maxY = cpu.dx & 0xffff; break;  // set vertical range
      case 0x000b: cpu.cx = st.dx & 0xffff; cpu.dx = st.dy & 0xffff; st.dx = 0; st.dy = 0; break;           // read motion counters (mickeys)
      // 0x0C set event handler, 0x0F/0x1A set mickey ratios, 0x24 driver version, etc.:
      // accepted as no-ops — enough programs probe them and tolerate an IRET-style return.
      default: break;
    }
  });

  return st;
}
