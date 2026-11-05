// compat-shots.mjs — the pictures of docs/COMPATIBILITY.md: each DOS title of tools/compat-shots.json
// run headless and drawn by src/video.js, the browser's own renderer (text in the VGA ROM font, CGA,
// EGA, Mode X, VESA), at the moments the list names, with the keys it names in between.
//
//   node tools/compat-shots.mjs [outdir=/tmp/compat-shots] [id ...]
//
// An entry: { id, dir (under games/), zip (a path in the repository, e.g. examples/games/4keen.zip) or
// files (single programs, e.g. ["intros/tube.com"]),
// exe, args?, mem?, keys?: [[seconds, "1c,9c"], ...], shots: [[seconds, name], ...] }.
// Times are guest seconds (CPU cycles), not BIOS ticks: a game that takes INT 8 over freezes those.
// Keys are set-1 scancodes, make and break; the DOS half (scan, ASCII) is queued too, as a real
// keypress does (src/keyboard.js), for the programs that read INT 16h or INT 21h -- arrows and
// function keys too, with no character: Unreal moves its sound-card choice by INT 16h.
// Writes <outdir>/<id>-<name>.png at the frame's own size, and prints one line per picture.
import { readFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { VFS } from '../src/vfs.js';
import { Video } from '../src/video.js';
import { unzip, deice } from '../src/zip.js';
import { makeMachine } from './harness.mjs';
import { writePNG } from './frame.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outdir = '/tmp/compat-shots', ...only] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const list = JSON.parse(readFileSync(join(ROOT, 'tools/compat-shots.json'), 'utf8')).filter((e) => !only.length || only.includes(e.id));

// Scancode -> ASCII for the DOS half of a keypress: letters, digits, Enter, Esc, space, Backspace, Tab.
const ASCII = { 0x01: 27, 0x0e: 8, 0x0f: 9, 0x1c: 13, 0x39: 32 };
'1234567890'.split('').forEach((c, i) => { ASCII[0x02 + i] = c.charCodeAt(0); });
['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].forEach((row, r) => row.split('').forEach((c, i) => { ASCII[[0x10, 0x1e, 0x2c][r] + i] = c.charCodeAt(0); }));

const walk = (dir, base = '') => readdirSync(dir).flatMap((f) => { const p = join(dir, f), r = base ? `${base}/${f}` : f; return statSync(p).isDirectory() ? walk(p, r) : [r]; });

for (const e of list) {
  const vfs = new VFS();
  if (e.zip) {                                        // as the DOS player mounts one (src/ui.js mountZip)
    const files = await deice(await unzip(new Uint8Array(readFileSync(join(ROOT, e.zip)))));
    const tops = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
    const strip = tops.size === 1 && !tops.has('') ? [...tops][0].length + 1 : 0;
    for (const f of files) { const rel = f.path.slice(strip).split('/').filter(Boolean).map((x) => VFS.dosName(x)).join('\\'); if (rel) vfs.addFile('\\' + rel, f.bytes); }
    for (const a of e.add || []) vfs.addFile('\\' + VFS.dosName(a.split('/').pop()), new Uint8Array(readFileSync(join(ROOT, a))));
  }
  else if (e.files) for (const f of e.files) vfs.addFile('\\' + VFS.dosName(f.split('/').pop()), new Uint8Array(readFileSync(join(ROOT, f))));   // single programs: intros/
  else { const dir = join(ROOT, 'games', e.dir); for (const r of walk(dir)) vfs.addFile('\\' + r.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, r)))); }
  vfs.chdir('\\' + (e.cwd || ''));
  const { mc, dos } = makeMachine({ vfs, ...(e.mem ? { mem: e.mem } : {}), ...(e.cpu ? { cpu: e.cpu } : {}) });
  let fault = null; mc.onError = (x) => { fault = x; };
  const exe = e.exe.split('/').join('\\');
  dos.load(vfs.readFile('\\' + exe), e.args ? ' ' + e.args : '', 'C:\\' + exe);
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const v = new Video(mc, canvas); v.font = mc.font;
  const sec = 18.2065 * mc.pitBase, c = mc.cpu;
  const keys = (e.keys || []).map(([t, k]) => ({ at: t * sec, codes: k.split(',').map((x) => parseInt(x, 16)) }));
  for (const [t, name] of e.shots) {
    while (!fault && !dos.programDone && c.cycles < t * sec && !(c.halted && !(c.flags & 0x200))) {
      while (keys.length && c.cycles >= keys[0].at) {
        const { codes } = keys.shift(); mc.pushScancodes(codes);
        // The BIOS half as src/keyboard.js pushes it: a key with no character (an arrow, F1) as (scan, 0).
        for (const s of codes) if (s !== 0xe0 && !(s & 0x80)) mc.keyQueue.push({ scan: s, ascii: ASCII[s] ?? 0 });
      }
      mc.runSlice(20000); mc.pumpKeyboard();
    }
    v.frame = 16; v.render();
    const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 0xff; rgb[i * 3 + 1] = (p >> 8) & 0xff; rgb[i * 3 + 2] = (p >> 16) & 0xff; }
    writePNG(`${outdir}/${e.id}-${name}.png`, rgb, W, H, 1);
    console.log(`${e.id}-${name}: ${t} s, mode ${mc.mem.u8[0x449].toString(16)}h ${W}x${H}${fault ? ' FAULT ' + String(fault.message).slice(0, 120) : dos.programDone ? ' (ended)' : ''}`);
    if (fault || dos.programDone) break;
  }
}
