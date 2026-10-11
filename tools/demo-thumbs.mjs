// demo-thumbs.mjs — the screenshots on the home page: run each entry of examples/manifest.json
// headless for its `secs` guest seconds and draw it through src/video.js, as the browser would.
//
//   node tools/demo-thumbs.mjs            all entries → examples/thumbs/<id>.png
//   node tools/demo-thumbs.mjs tetros     one
//
// An entry may carry `type`: [[seconds, "text"], …] — keys typed at that guest second ({F3}, {ENTER}… for
// named keys), on both
// keyboard paths (the 8042's scancodes and the BIOS buffer), so an interpreter shows something.
// A program that leaves its graphics mode before exiting is captured at its last graphics frame —
// VBE always, any graphics mode when the entry says `lastFrame` (Helium plays once and exits).
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const { Video } = await import(ROOT + '/src/video.js');
const { writePNG } = await import(ROOT + '/tools/frame.mjs');
const { unzip, deice } = await import(ROOT + '/src/zip.js');

// Set-1 make codes, US layout, for what the entries type.
const MAKE = { a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17, j: 0x24, k: 0x25, l: 0x26,
  m: 0x32, n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15,
  z: 0x2c, 1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05, 5: 0x06, 6: 0x07, 7: 0x08, 8: 0x09, 9: 0x0a, 0: 0x0b, '-': 0x0c,
  '=': 0x0d, ' ': 0x39, '/': 0x35, '.': 0x34, ',': 0x33, ';': 0x27, "'": 0x28, '\n': 0x1c };
const SHIFTED = { '"': "'", '(': '9', ')': '0', '*': '8', '+': '=', ':': ';', '<': ',', '>': '.', '!': '1', '@': '2' };
// Named keys inside the text: {ENTER}, {ESC}, {SPACE}, {LEFT} {RIGHT} {UP} {DOWN}, {F1}…{F10}.
const NAMED = { ENTER: [0x1c, 13], ESC: [0x01, 27], SPACE: [0x39, 32], LEFT: [0x4b, 0], RIGHT: [0x4d, 0], UP: [0x48, 0], DOWN: [0x50, 0],
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, [0x3b + i, 0]])) };
const type = (mc, text) => {
  for (const part of text.split(/(\{[A-Z0-9]+\})/)) {
    const named = /^\{([A-Z0-9]+)\}$/.exec(part);
    if (named && NAMED[named[1]]) { const [sc, ascii] = NAMED[named[1]]; mc.pushScancodes([sc, sc | 0x80]); mc.keyQueue.push({ scan: sc, ascii }); continue; }
    typeChars(mc, part);
  }
};
const typeChars = (mc, text) => {
  for (const ch of text) {
    const base = SHIFTED[ch] ?? ch.toLowerCase(), code = MAKE[base];
    if (code === undefined) continue;
    const shift = SHIFTED[ch] !== undefined || ch !== ch.toLowerCase();
    mc.pushScancodes([...(shift ? [0x2a] : []), code, code | 0x80, ...(shift ? [0xaa] : [])]);
    mc.keyQueue.push({ scan: code, ascii: ch === '\n' ? 0x0d : ch.charCodeAt(0) });
  }
};
const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
const grab = (mc) => {
  const v = new Video(mc, canvas); v.font = mc.font; v.frame = 16; v.render();
  const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 255; rgb[i * 3 + 1] = (p >> 8) & 255; rgb[i * 3 + 2] = (p >> 16) & 255; }
  return { W, H, rgb };
};

const only = process.argv[2];
const manifest = JSON.parse(readFileSync(ROOT + '/examples/manifest.json', 'utf8'));
for (const e of manifest) {
  if (only && e.id !== only) continue;
  let bytes = new Uint8Array(readFileSync(ROOT + '/' + e.file));
  const { mc, dos, vfs } = makeMachine({ dos: e.kind !== 'boot', mem: e.mem });
  if (e.kind === 'dos') dos.load(bytes, '', 'C:\\' + e.file.split('/').pop());
  else if (e.kind === 'zip') {                       // the archive's files at the root of C:, as the player narrows it
    for (const f of await deice(await unzip(bytes))) vfs.addFile('\\' + f.path.replace(/\//g, '\\').toUpperCase(), f.bytes);
    const exe = (e.run + (/\./.test(e.run) ? '' : '.EXE')).toUpperCase();
    dos.load(vfs.resolve('\\' + exe).node.data, e.args || '', 'C:\\' + exe);
  }
  else {
    if (bytes.length < 1474560) { const p = new Uint8Array(1474560); p.set(bytes); bytes = p; }
    mc.disk.attach(0, bytes);
    bootSector(mc, bytes, { drive: 0 });
  }
  let fault = null; mc.onError = (x) => { fault = x; };
  const sec = 18.2065 * mc.pitBase, end = (e.secs || 3) * sec, keys = [...(e.type || [])];
  let lastGfx = null, slices = 0;
  while (mc.cpu.cycles < end && !fault && !(dos && dos.programDone)) {
    while (keys.length && mc.cpu.cycles >= keys[0][0] * sec) type(mc, keys.shift()[1]);
    mc.runSlice(20000); mc.pumpKeyboard();
    if (mc.vbe || (e.lastFrame && mc.mem.u8[0x449] !== 3 && ++slices % 8 === 0)) lastGfx = grab(mc);
  }
  const { W, H, rgb } = (mc.vbe || !lastGfx) ? grab(mc) : lastGfx;
  const out = `${ROOT}/examples/thumbs/${e.id}.png`;
  writePNG(out, rgb, W, H, 1);
  console.log(`${e.id.padEnd(12)} ${W}x${H}${fault ? '  FAULT ' + String(fault.message).slice(0, 80) : ''}`);
}
