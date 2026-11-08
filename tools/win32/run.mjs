// run.mjs — a Win32 .exe on MIRAGE-WIN32, headless (src/win32): its DLLs made in JavaScript, its window
// and OpenGL recorded by src/hle/trace.js; what it called is printed at the end, and how it ended.
//
//   node tools/win32/run.mjs <program.exe> [arguments...]
//   MIRAGE_W32STUBS=1               an import MIRAGE-WIN32 does not make yet stops the run, named, when called
//                                   (the loader itself refuses it): what a program calls, in its order
//   MIRAGE_W32SHOTS=5,10 MIRAGE_W32SHOTPREFIX=/tmp/w   the screen (a GDI window's, on the card's framebuffer)
//                                   at those guest seconds: <prefix>-<s>s.png
//   MIRAGE_W32KEYS=12:01,14:1c       keys pressed at those guest seconds, by PC scancode (hex; e0xx for an
//                                   extended key), held a tenth of a second: WM_KEYDOWN, WM_KEYUP; 2a+ and
//                                   2a- press and release (Shift held over the keys between)
//   MIRAGE_W32DIR=<dir>             the files beside it, by base name, on the program's own disk (src/win32/api.js)
//   MIRAGE_W32SECS=<guest seconds>  stop after that long (default: until it ends, or 2e10 instructions)
//   MIRAGE_W32TRACE=1               every API call as it is made
//   MIRAGE_W32TEX=<dir>             every texture level as the program unlocks it: <dir>/NNNN.bin and index.json
//   MIRAGE_W32WAV=<file.wav>        what waveOut played (and <file>.midi.wav what MIDI played: midiOut, MCI)
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { installBIOS } from '../../src/bios.js';
import { loadPE, win32Memory } from '../../src/win32/index.js';
import { win32Apis } from '../../src/win32/api.js';
import { traceBackend } from '../../src/hle/trace.js';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/win32/run.mjs <program.exe>'); process.exit(2); }
const exe = new Uint8Array(readFileSync(prog));
const mc = new Machine({ memSize: win32Memory(exe), cpu: process.env.MIRAGE_CPU || '686' });
installBIOS(mc);
const lx = installLinux(mc, { onOutput: (fd, b) => (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b)) });
lx.epoch = Math.floor(Date.now() / 1000);
const backend = traceBackend();
// MIRAGE_W32TEX=<dir>: what the program writes into its textures, level by level, as it unlocks them.
const TEX = process.env.MIRAGE_W32TEX, texIndex = [];
if (TEX) {
  const { mkdirSync, writeFileSync } = await import('fs'), { createHash } = await import('crypto');
  mkdirSync(TEX, { recursive: true });
  backend.textureCapture = (info, bytes) => {
    const file = String(info.seq).padStart(4, '0') + '.bin';
    writeFileSync(`${TEX}/${file}`, bytes);
    texIndex.push({ ...info, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), file, cycles: mc.cpu.cycles });
    writeFileSync(`${TEX}/index.json`, JSON.stringify(texIndex, null, 1) + '\n');
  };
}
if (process.env.MIRAGE_W32TRACE) { const t0 = backend.trace; backend.trace = (name, args) => { console.error('w32:', name, args.map((a) => (typeof a === 'number' && Number.isInteger(a) && a > 9 ? '0x' + (a >>> 0).toString(16) : a)).join(' ')); if (t0) t0(name, args); }; }
const files = {};
if (process.env.MIRAGE_W32DIR) (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files[n] = new Uint8Array(readFileSync(p)); } })(process.env.MIRAGE_W32DIR);
const apis = win32Apis({ files });
if (process.env.MIRAGE_W32STUBS) {
  // The import directory read here, as the loader reads it, and every name no table makes added as a
  // function that throws: the run then stops at the first one called, and says which.
  const b = exe, u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0, u16 = (o) => b[o] | b[o + 1] << 8;
  const pe = u32(0x3c), nsec = u16(pe + 6), opt = pe + 24, secs = opt + u16(pe + 20);
  const off = (r) => { for (let i = 0; i < nsec; i++) { const sct = secs + i * 40, va = u32(sct + 12), raw = u32(sct + 20); if (r >= va && r < va + Math.max(u32(sct + 8), u32(sct + 16))) return r - va + raw; } return r; };
  const str = (o) => { let e = o; while (b[e]) e++; return new TextDecoder('latin1').decode(b.subarray(o, e)); };
  const byDll = new Map(apis.map((a) => [a.dll.toLowerCase(), a]));
  for (let d = off(u32(opt + 104)); u32(d + 12); d += 20) {
    const dll = str(off(u32(d + 12)));
    let mod = byDll.get(dll.toLowerCase());
    if (!mod) { mod = { dll, fns: {} }; apis.push(mod); byDll.set(dll.toLowerCase(), mod); }
    for (let t = off(u32(d) || u32(d + 16)); u32(t); t += 4) {
      const v = u32(t), ord = v & 0x80000000 ? v & 0xffff : 0, name = ord ? `#${ord}` : str(off(v) + 2);
      if (ord ? Object.values(mod.fns).some((f) => f[2] && f[2].ordinal === ord) : name in mod.fns) continue;
      mod.fns[name] = ['', () => { throw new Error(`mirage-win32: ${dll}!${name} is called and not made yet`); }, ord ? { ordinal: ord, noName: true } : {}];
    }
  }
}
loadPE(lx, mc.mem, mc.cpu, exe, { path: `C:\\${basename(prog)}`, args: args.join(' '), apis, backend });
const SEC = mc.cyclesPerSecond || 1e8, SECS = Number(process.env.MIRAGE_W32SECS) || 0;
const LIMIT = SECS ? SECS * SEC : 2e10;
// MIRAGE_W32WAV=<file.wav>: what waveOut played, recorded.
const WAV = process.env.MIRAGE_W32WAV, heard = [];
let wavRate = 44100;
const midiHeard = [];
let midiRate = 32000;
const record = () => {
  if (!WAV) return;
  if (mc.midi) { mc.midi.capture = true; mc.midi.render(); const m = mc.midi.drain(); midiRate = m.rate; for (const v of m.samples) midiHeard.push(v); }
  if (!mc.dsp) return;
  const { rate, samples } = mc.dsp.drain(); if (samples.length) { wavRate = rate; for (const v of samples) heard.push(v); }
};
const writeWav = (_, pcm, rate) => {
  const n = pcm.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, pcm[i])), 44 + i * 2);
  return b;
};
const SHOTS = (process.env.MIRAGE_W32SHOTS || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const shot = async (t) => {
  const v = mc.vbe; if (!v || v.bpp !== 32) { console.error(`mirage-win32: no picture at ${t} s`); return; }
  const { writePNG } = await import('../frame.mjs'), px = new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + v.base, v.width * v.height), rgb = new Uint8Array(px.length * 3);
  for (let i = 0; i < px.length; i++) { rgb[3 * i] = px[i] >> 16; rgb[3 * i + 1] = px[i] >> 8; rgb[3 * i + 2] = px[i]; }
  const f = `${process.env.MIRAGE_W32SHOTPREFIX || '/tmp/w32'}-${t}s.png`; writePNG(f, rgb, v.width, v.height, 1); console.error(`mirage-win32: ${v.width}x${v.height} at ${t} s -> ${f}`);
};
const KEYS = (process.env.MIRAGE_W32KEYS || '').split(',').filter(Boolean).flatMap((k) => {
  const [t, c] = k.split(':'), v = parseInt(c, 16), ext = v > 0xff, scan = v & 0xff, hold = c.slice(-1);
  if (hold === '+' || hold === '-') return [{ at: Number(t), down: hold === '+', scan, ext }];   // held down, let go
  return [{ at: Number(t), down: true, scan, ext }, { at: Number(t) + 0.1, down: false, scan, ext }];
}).sort((a, b) => a.at - b.at);
while (!lx.done && mc.cpu.cycles < LIMIT) {
  while (KEYS.length && mc.cpu.cycles >= KEYS[0].at * SEC) { const k = KEYS.shift(); apis.input.key(k.down, k.scan, k.ext); }
  mc.runSlice(200000); record();
  while (SHOTS.length && mc.cpu.cycles >= SHOTS[0] * SEC) await shot(SHOTS.shift());
}
if (WAV) {
  const { writeFileSync } = await import('fs');
  const n = heard.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(wavRate, 24); b.writeUInt32LE(wavRate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, heard[i])), 44 + i * 2);
  writeFileSync(WAV, b); console.error(`mirage-win32: ${(n / 2 / wavRate).toFixed(1)} s of sound -> ${WAV}`);
  if (midiHeard.some((v) => v)) { writeFileSync(WAV.replace(/\.wav$/i, '') + '.midi.wav', writeWav(null, midiHeard, midiRate)); console.error(`mirage-win32: ${(midiHeard.length / 2 / midiRate).toFixed(1)} s of MIDI -> ${WAV.replace(/\.wav$/i, '')}.midi.wav`); }
}
const t = backend.summary();
console.error('w32:', JSON.stringify({ mode: t.mode, frames: t.frames, calls: t.calls }));
for (const s of t.shaders) console.error('w32 shader:\n' + s);
if (!lx.done) { console.error(SECS ? `mirage-win32: stopped after ${SECS} guest seconds` : `mirage-win32: still running after ${LIMIT} cycles`); process.exit(SECS ? 0 : 124); }
if (lx.signal) {
  const f = lx.faultInfo;
  console.error(`mirage-win32: fault` + (f ? ` (exception ${f.n} err ${f.err} at eip ${f.eip.toString(16)}, cr2 ${f.cr2.toString(16)})` : ''));
  process.exit(1);
}
console.error(`mirage-win32: exited with ${lx.status}`);
