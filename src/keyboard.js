// keyboard.js — bridge browser key events to BOTH keyboard interfaces a DOS program
// might use:
//   (1) the hardware path — make/break scancodes read from port 0x60 on each IRQ1, which
//       is what games (and QBasic's IDE) take by installing their own INT 9h handler;
//   (2) the BIOS path — (scan, ascii) pairs pushed onto machine.keyQueue, which INT 16h /
//       INT 21h read for the shell and text programs.
// A program uses one or the other; feeding both is safe (pumpKeyboard drops scancodes when
// no guest INT 9h is installed, and INT-9h games never read the keyQueue), and it means keys
// work whichever interface the program chose.

// Set-1 MAKE scancodes keyed by KeyboardEvent.code (the PHYSICAL key, layout-independent —
// so WASD/arrows land on the right scancodes regardless of the host keyboard layout).
const CODE2SCAN = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  F11: 0x57, F12: 0x58,
  // Arrows / navigation → their XT numeric-keypad scancodes, with NO E0 prefix. That is what
  // DOS-era games actually read (the 83-key XT had no separate cursor pad); games like Alley
  // Cat handle bare 0x48/0x4b/0x4d/0x50, not the E0-extended form. The numpad keys alias them.
  ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4b, ArrowRight: 0x4d,
  Home: 0x47, End: 0x4f, PageUp: 0x49, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
  // Right-hand modifiers collapse onto their left twins (games rarely distinguish, and this
  // avoids emitting an E0 prefix an XT-era ISR might not understand).
  ControlRight: 0x1d, AltRight: 0x38, NumpadEnter: 0x1c, NumpadDivide: 0x35,
};

// BIOS (scan, ascii) pairs keyed by KeyboardEvent.key, for the INT 16h / keyQueue path.
// Extended keys carry ascii 0 and a scan code, as on a real PC.
const SCAN = {
  Escape: [0x01, 0x1b], Backspace: [0x0e, 0x08], Tab: [0x0f, 0x09], Enter: [0x1c, 0x0d],
  ' ': [0x39, 0x20],
  ArrowUp: [0x48, 0], ArrowDown: [0x50, 0], ArrowLeft: [0x4b, 0], ArrowRight: [0x4d, 0],
  Home: [0x47, 0], End: [0x4f, 0], PageUp: [0x49, 0], PageDown: [0x51, 0],
  Insert: [0x52, 0], Delete: [0x53, 0],
  F1: [0x3b, 0], F2: [0x3c, 0], F3: [0x3d, 0], F4: [0x3e, 0], F5: [0x3f, 0],
  F6: [0x40, 0], F7: [0x41, 0], F8: [0x42, 0], F9: [0x43, 0], F10: [0x44, 0],
};

export class Keyboard {
  constructor(machine) {
    this.machine = machine;
    this.onBreak = null;          // Ctrl+C / Ctrl+Break callback (stop a program)
    this._down = (e) => this._onDown(e);
    this._up = (e) => this._onUp(e);
  }

  attach(el = window) {
    el.addEventListener('keydown', this._down);
    el.addEventListener('keyup', this._up);
  }
  detach(el = window) {
    el.removeEventListener('keydown', this._down);
    el.removeEventListener('keyup', this._up);
  }

  _push(scan, ascii) {
    const q = this.machine.keyQueue;
    q.push({ scan, ascii });
    if (q.length > 32) q.shift();   // BIOS buffer holds ~16; keep it bounded
  }

  _onDown(e) {
    if (e.metaKey) return;          // leave browser/OS shortcuts alone

    // (1) hardware path: MAKE scancode → port 0x60 + IRQ1 (for INT-9h games).
    const s = CODE2SCAN[e.code];
    if (s !== undefined && this.machine.pushScancodes) this.machine.pushScancodes([s]);

    // (2) BIOS path: (scan, ascii) → keyQueue (for INT 16h / the shell).
    const k = e.key;
    if (e.ctrlKey) {
      if (k === 'c' || k === 'C' || k === 'Pause') { if (this.onBreak) this.onBreak(); this._push(0x2e, 0x03); e.preventDefault(); return; }
      if (k.length === 1) { const c = k.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) { this._push(0, c - 64); e.preventDefault(); return; } }
    }
    const special = SCAN[k];
    if (special) { this._push(special[0], special[1]); e.preventDefault(); return; }
    if (k.length === 1) { this._push(s || 0, k.charCodeAt(0) & 0xff); e.preventDefault(); }
  }

  _onUp(e) {
    // hardware path: BREAK code (MAKE | 0x80) so the guest ISR sees the key released.
    const s = CODE2SCAN[e.code];
    if (s !== undefined && this.machine.pushScancodes) this.machine.pushScancodes([s | 0x80]);
  }
}
