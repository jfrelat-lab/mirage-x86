// keyboard.js — translate browser key events into the BIOS (scan, ascii) pairs
// that INT 16h / INT 21h expect, and push them onto machine.keyQueue. Extended
// keys (arrows, function keys) carry ascii 0 and a scan code, as on a real PC.

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
    this._handler = (e) => this._onKey(e);
  }

  attach(el = window) { el.addEventListener('keydown', this._handler); }
  detach(el = window) { el.removeEventListener('keydown', this._handler); }

  _push(scan, ascii) {
    const q = this.machine.keyQueue;
    q.push({ scan, ascii });
    if (q.length > 32) q.shift();   // BIOS buffer holds ~16; keep it bounded
  }

  _onKey(e) {
    if (e.metaKey) return;          // leave browser/OS shortcuts alone
    const k = e.key;

    if (e.ctrlKey) {
      if (k === 'c' || k === 'C' || (k === 'Pause')) { if (this.onBreak) this.onBreak(); this._push(0x2e, 0x03); e.preventDefault(); return; }
      if (k.length === 1) { const c = k.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) { this._push(0, c - 64); e.preventDefault(); return; } }
    }

    const special = SCAN[k];
    if (special) { this._push(special[0], special[1]); e.preventDefault(); return; }

    if (k.length === 1) { this._push(0, k.charCodeAt(0) & 0xff); e.preventDefault(); }
  }
}
