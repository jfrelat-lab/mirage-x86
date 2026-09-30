// Boot a hard-disk image, wait for a string on the text screen, then TYPE lines on the keyboard —
// real make/break scancodes through the 8042 and IRQ1, as src/ui.js feeds them in the browser — and
// print the screen after each line.
//
//   node typeboot.mjs <image> "<wait-for text>" "<line 1>" "<line 2>" ...   (MIRAGE_CPU=586 for Linux)
//   e.g. node typeboot.mjs boot/v86/bl3-5.img "press Enter" "" "uname -a" "ls /"
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const [img, waitFor, ...lines] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(img));
const { mc } = makeMachine({ dos: false, memSize: Number(process.env.MEM || 16) << 20 });
const dv = new DataView(bytes.buffer), e = 0x1be;
const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true), sh = bytes[e + 1], ss = bytes[e + 2] & 63;
const eh = bytes[e + 5], es = bytes[e + 6] & 63, ec = bytes[e + 7] | ((bytes[e + 6] & 0xc0) << 2);
// Only a plausible partition entry says anything about geometry (as in bootshot.mjs): 386BSD's disk
// has none, and the garbage it holds there gave a geometry under which its pager divided by zero.
const ok = (bytes[e] === 0 || bytes[e] === 0x80) && bytes[e + 4] && n && ec;
const spt = ok && sh ? (lba - (ss - 1)) / sh : 63, hd = ok ? Math.round(((lba + n - 1 - (es - 1)) / spt - eh) / ec) : 16;
mc.disk.attach(0x80, bytes, { cyl: Math.floor(bytes.length / (hd * spt * 512)), heads: hd, spt, type: 3 });
let fault = null; mc.onError = (x) => { fault = x; };
bootSector(mc, bytes, { drive: 0x80 });
const c = mc.cpu, sec = 18.2065 * mc.pitBase;

// Set-1 make codes for what a shell line needs (US layout); shift for the upper row where required.
const MAKE = { a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17, j: 0x24, k: 0x25, l: 0x26,
  m: 0x32, n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15,
  z: 0x2c, 1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05, 5: 0x06, 6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0a, 0: 0x0b, '-': 0x0c,
  '=': 0x0d, ' ': 0x39, '/': 0x35, '.': 0x34, ',': 0x33, ';': 0x27, "'": 0x28, '\n': 0x1c };
const SHIFTED = { '|': '\\', '>': '.', '<': ',', ':': ';', '"': "'", '_': '-', '+': '=', '!': '1', '*': '8', '&': '7' };
MAKE['\\'] = 0x2b; MAKE['\x1b'] = 0x01;   // Esc: pass it as $'\e' from the shell
const scancodes = (text) => {
  const out = [];
  for (const ch of text) {
    const base = SHIFTED[ch] ?? ch.toLowerCase(), code = MAKE[base];
    if (code === undefined) continue;
    const shift = SHIFTED[ch] !== undefined || (ch !== ch.toLowerCase());
    if (shift) out.push(0x2a);
    out.push(code, code | 0x80);
    if (shift) out.push(0xaa);
  }
  return out;
};
const screen = () => {
  const base = 0xb8000 + ((mc.vga.startAddr() * 2) & 0x7fff), rows = [];
  for (let y = 0; y < 25; y++) { let l = ''; for (let x = 0; x < 80; x++) { const ch = mc.mem.u8[base + (y * 80 + x) * 2]; l += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; } rows.push(l.trimEnd()); }
  return rows;
};
const run = (secs, until) => {
  const end = c.cycles + secs * sec;
  while (!fault && c.cycles < end) {
    mc.runSlice(20000); mc.pumpKeyboard();
    if (until && screen().join('\n').includes(until)) return true;
  }
  return false;
};
const t0 = Date.now();
console.log(`waiting for "${waitFor}": ${run(600, waitFor) ? 'seen' : 'NOT seen'} at ${(c.cycles / sec).toFixed(0)} s guest, ${((Date.now() - t0) / 1000) | 0} s host`);
for (const line of lines) {
  mc.pushScancodes(scancodes(line + '\n'));
  // ...and the BIOS path, as src/keyboard.js feeds both: a program reading INT 16h (a boot loader in
  // real mode) never sees the hardware scancodes, which are dropped when no guest INT 9 handler exists.
  for (const ch of line + '\n') {
    const base = SHIFTED[ch] ?? ch.toLowerCase(), code = MAKE[base];
    if (code !== undefined) mc.keyQueue.push({ scan: code, ascii: ch === '\n' ? 0x0d : ch.charCodeAt(0) });
  }
  run(Number(process.env.STEP || 30));
  console.log(`---- after typing "${line}" ----`);
  console.log(screen().filter((l, i, a) => l || a.slice(i).some(Boolean)).slice(-12).join('\n'));
}
if (fault) console.log('FAULT', String(fault.message).slice(0, 200));
