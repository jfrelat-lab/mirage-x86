// record-audio.mjs — run a DOS program headless and write what it sounds like to a WAV.
//
//   node tools/record-audio.mjs <prog.com|prog.exe|game dir> [seconds=10] [out.wav] [tail]
//   PROG=NAME.EXE        the program to run inside a game directory
//   KEYS="1c,0d;39,20"   keystrokes (scancode,ascii) fed one at a time once the program starts
//   MEM=64               a machine of that many MiB instead of the DOS player's
//
// Seconds are the MACHINE's seconds (cpu.cycles at the PIT's rate), so a recording is reproducible to
// the sample; prints the level of every second, which is how a test tells sound from silence.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';
import { makeMachine } from './harness.mjs';
import { VFS } from '../src/vfs.js';
import { installAudio, wav, clock } from '../src/audio.js';

const [target, secsArg, outArg, tail = ''] = process.argv.slice(2);
if (!target) { console.error('usage: node tools/record-audio.mjs <program|dir> [seconds] [out.wav] [tail]'); process.exit(2); }
const SECS = Number(secsArg) || 10, OUT = outArg || 'audio.wav', RATE = 44100;

const vfs = new VFS();
let exe;
if (statSync(target).isDirectory()) {
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else vfs.addFile('\\' + relative(target, p).split('/').join('\\').toUpperCase(), new Uint8Array(readFileSync(p)));
    }
  })(target);
  exe = (process.env.PROG || '').toUpperCase();
  if (!exe) { console.error('a directory needs PROG=<NAME.EXE>'); process.exit(2); }
} else {
  exe = basename(target).toUpperCase();
  vfs.addFile('\\' + exe, new Uint8Array(readFileSync(target)));
}
vfs.chdir('\\');
const { mc, dos } = makeMachine(process.env.MEM ? { vfs, memSize: Number(process.env.MEM) << 20 } : { vfs });
let fault = null; mc.onError = (e) => { fault = e; };
const audio = installAudio(mc);
dos.load(vfs.readFile('\\' + exe), tail ? ' ' + tail : '', 'C:\\' + exe);

const keys = (process.env.KEYS || '').split(';').filter(Boolean).map((k) => k.split(',').map((x) => parseInt(x, 16)));
const start = clock(mc), chunks = [];
let nextKey = start + 1;
while (clock(mc) - start < SECS && !fault && !dos.programDone) {
  // The next key once a second has passed, or at once if the program is waiting for one: a blocked
  // machine does not advance its clock.
  if (keys.length && (clock(mc) >= nextKey || mc.blocked) && mc.keyQueue.length === 0) {
    const [sc, asc] = keys.shift();
    mc.pushScancodes([sc, sc | 0x80]); mc.keyQueue.push({ scan: sc, ascii: asc });
    nextKey = clock(mc) + 1;
  }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  mc.runSlice(4000);
  chunks.push(audio.pull(RATE));
  if (mc.blocked && !keys.length) break;            // waiting for input nobody will give
}
const all = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; }
writeFileSync(OUT, wav(all, RATE));
const per = RATE * 2, levels = [];
for (let s = 0; s < all.length; s += per) {
  let sum = 0, n = 0; for (let i = s; i < Math.min(s + per, all.length); i++) { sum += all[i] * all[i]; n++; }
  levels.push(Math.sqrt(sum / Math.max(1, n)).toFixed(3));
}
console.log(`${OUT}: ${(all.length / 2 / RATE).toFixed(1)} s` + (fault ? `, stopped: ${fault.message}` : '') + (dos.programDone ? ', program ended' : ''));
console.log('RMS per second:', levels.join(' '));
