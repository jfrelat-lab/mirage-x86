// run.mjs — a Win32 .exe on MIRAGE-WIN32, headless (src/win32): its DLLs made in JavaScript, its window
// and OpenGL recorded by src/hle/trace.js; what it called is printed at the end, and how it ended.
//
//   node tools/win32/run.mjs <program.exe>
//   MIRAGE_W32SECS=<guest seconds>  stop after that long (default: until it ends, or 2e10 instructions)
//   MIRAGE_W32TRACE=1               every API call as it is made
//   MIRAGE_W32WAV=<file.wav>        what waveOut played (and <file>.midi.wav what MIDI played: midiOut, MCI)
import { readFileSync } from 'fs';
import { basename } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { installBIOS } from '../../src/bios.js';
import { loadPE, win32Memory } from '../../src/win32/index.js';
import { win32Apis } from '../../src/win32/api.js';
import { traceBackend } from '../../src/hle/trace.js';

const [prog] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/win32/run.mjs <program.exe>'); process.exit(2); }
const exe = new Uint8Array(readFileSync(prog));
const mc = new Machine({ memSize: win32Memory(exe), cpu: process.env.MIRAGE_CPU || '686' });
installBIOS(mc);
const lx = installLinux(mc, { onOutput: (fd, b) => (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b)) });
lx.epoch = Math.floor(Date.now() / 1000);
const backend = traceBackend();
if (process.env.MIRAGE_W32TRACE) { const t0 = backend.trace; backend.trace = (name, args) => { console.error('w32:', name, args.map((a) => (typeof a === 'number' && Number.isInteger(a) && a > 9 ? '0x' + (a >>> 0).toString(16) : a)).join(' ')); if (t0) t0(name, args); }; }
loadPE(lx, mc.mem, mc.cpu, exe, { path: `C:\\${basename(prog)}`, apis: win32Apis(), backend });
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
while (!lx.done && mc.cpu.cycles < LIMIT) { mc.runSlice(200000); record(); }
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
