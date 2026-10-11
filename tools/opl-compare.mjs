// opl-compare.mjs — src/opl.js against Nuked-OPL3, sample for sample, on one program's register writes.
//
//   NUKED=/path/to/render node tools/opl-compare.mjs <prog.com|dir> [seconds=20] [tail]
//   PROG=NAME.EXE for a directory; KEYS as in tools/record-audio.mjs.
//
// 1. The program runs headless; every write to the OPL is logged with its position in samples
//    (49716 Hz on the machine's clock).
// 2. The log is rendered by src/opl.js, driven sample by sample (opl.gen), with no clock involved.
// 3. The same log is rendered by Nuked-OPL3 (`render`, a 30-line C driver around opl3.c; Nuked is
//    LGPL and is not part of MIRAGE — it is a reference, built outside the repository: see
//    docs/TESTING.md).
// Then: the signal-to-difference ratio overall and per half second, and where they first part.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'fs';
import { join, relative, basename } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { makeMachine } from './harness.mjs';
import { VFS } from '../src/vfs.js';
import { installAudio, clock } from '../src/audio.js';
import { installOPL, OPL_RATE } from '../src/opl.js';

const [target, secsArg, tail = ''] = process.argv.slice(2);
const NUKED = process.env.NUKED;
if (!target || !NUKED) { console.error('usage: NUKED=<render binary> node tools/opl-compare.mjs <program|dir> [seconds] [tail]'); process.exit(2); }
const SECS = Number(secsArg) || 20;

// ---- 1. capture ----
const vfs = new VFS();
let exe;
if (statSync(target).isDirectory()) {
  (function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else vfs.addFile('\\' + relative(target, p).split('/').join('\\').toUpperCase(), new Uint8Array(readFileSync(p))); } })(target);
  exe = (process.env.PROG || '').toUpperCase();
} else { exe = basename(target).toUpperCase(); vfs.addFile('\\' + exe, new Uint8Array(readFileSync(target))); }
vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });
installAudio(mc);
const t0 = clock(mc), log = [], index = [0, 0];
for (const [base, bank] of [[0x388, 0], [0x38a, 1], [0x220, 0], [0x222, 1], [0x228, 0]]) {
  const wi = mc.portWrite[base], wd = mc.portWrite[base + 1];
  mc.portWrite[base] = (p, s, v) => { index[bank] = v & 0xff; return wi(p, s, v); };
  mc.portWrite[base + 1] = (p, s, v) => { log.push([Math.floor((clock(mc) - t0) * OPL_RATE), (bank << 8) | index[bank], v & 0xff]); return wd(p, s, v); };
}
dos.load(vfs.readFile('\\' + exe), tail ? ' ' + tail : '', 'C:\\' + exe);
const keys = (process.env.KEYS || '').split(';').filter(Boolean).map((k) => k.split(',').map((x) => parseInt(x, 16)));
let nextKey = t0 + 1;
while (clock(mc) - t0 < SECS && !dos.programDone) {
  if (keys.length && (clock(mc) >= nextKey || mc.blocked) && mc.keyQueue.length === 0) { const [sc, a] = keys.shift(); mc.pushScancodes([sc, sc | 0x80]); mc.keyQueue.push({ scan: sc, ascii: a }); nextKey = clock(mc) + 1; }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  mc.runSlice(4000);
  if (mc.audio) mc.audio.pull(44100);                     // keep the mixer drained
  if (mc.blocked && !keys.length) break;
}
const total = Math.floor((clock(mc) - t0) * OPL_RATE);
console.log(`${log.length} OPL writes over ${(total / OPL_RATE).toFixed(1)} s`);

// ---- 2. ours, driven by the log ----
const stub = { cpu: { cycles: 0 }, pitBase: 0x10000, audio: true, onPortWrite() {}, onPortRead() {} };
const ours = installOPL(stub);
let pos = 0;
for (const [at, reg, v] of log) { if (at > pos) { ours.gen(at - pos); pos = at; } ours.write(reg >> 8, reg & 0xff, v); }
ours.gen(total - pos);
const A = Int16Array.from(ours.pcm);

// ---- 3. Nuked ----
const dir = mkdtempSync(join(tmpdir(), 'oplcmp-')), buf = Buffer.alloc(log.length * 7);
log.forEach(([at, reg, v], i) => { buf.writeUInt32LE(at, i * 7); buf.writeUInt16LE(reg, i * 7 + 4); buf.writeUInt8(v, i * 7 + 6); });
writeFileSync(join(dir, 'log.bin'), buf);
execFileSync(NUKED, [join(dir, 'log.bin'), String(total), join(dir, 'out.raw')]);
const rb = readFileSync(join(dir, 'out.raw')), B = new Int16Array(rb.buffer, rb.byteOffset, rb.length / 2);
if (process.env.WAV) {
  const { wav } = await import('../src/audio.js');
  const f = (x) => Float32Array.from(x, (v) => v / 32768);
  writeFileSync(process.env.WAV + '-ours.wav', wav(f(A), OPL_RATE)); writeFileSync(process.env.WAV + '-nuked.wav', wav(f(B), OPL_RATE));
}

// ---- compare ----
const n = Math.min(A.length, B.length);
let first = -1, es = 0, ed = 0;
for (let i = 0; i < n; i++) { const d = A[i] - B[i]; es += B[i] * B[i]; ed += d * d; if (first < 0 && Math.abs(d) > 2) first = i; }
const db = (s, d) => (d === 0 ? Infinity : 10 * Math.log10(s / d));
console.log(`overall: signal/difference ${db(es, ed).toFixed(1)} dB, identical samples up to ${first < 0 ? 'the end' : (first / 2 / OPL_RATE).toFixed(4) + ' s (sample ' + (first >> 1) + ')'}`);
const W = OPL_RATE;                                       // half a second, stereo
const rows = [];
for (let s = 0; s < n; s += W) {
  let a = 0, b = 0, d = 0;
  for (let i = s; i < Math.min(s + W, n); i++) { a += A[i] * A[i]; b += B[i] * B[i]; d += (A[i] - B[i]) ** 2; }
  if (b < 1e3 * W && a < 1e3 * W) continue;               // silence on both sides
  rows.push(`${(s / 2 / OPL_RATE).toFixed(1).padStart(5)}s  ours ${(10 * Math.log10(a / W + 1)).toFixed(1).padStart(5)} dB  nuked ${(10 * Math.log10(b / W + 1)).toFixed(1).padStart(5)} dB  S/D ${db(b, d).toFixed(1).padStart(6)} dB`);
}
console.log(rows.join('\n'));
