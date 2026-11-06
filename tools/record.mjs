// record.mjs — a video of a DOS title, filmed by MIRAGE itself: an entry of tools/compat-shots.json
// run headless, a frame drawn by src/video.js (the page's own renderer) every 1/fps of GUEST time and
// the sound mixed by src/audio.js (Sound Blaster, OPL3, MIDI, PC speaker) for the same span. Nothing is
// dropped and nothing depends on the host's speed: the same command makes the same video.
//
//   node tools/record.mjs <id> [--from 0] [--for 15] [--out /tmp/record] [--fps 30] [--size 640x480]
//                              [--webp-width 480] [--webp-fps 15] [--no-webp]
//
// Writes <out>/<id>.mp4 (H.264 + AAC, for players, the site and Reddit) and <out>/<id>.webp (animated,
// muted, looping, for READMEs, by tools/webp.mjs). --from and --for are guest seconds; the run's keys are the entry's.
// Every frame is scaled (nearest) to --size, a 4:3 screen as the monitor showed 320x200 or 640x400.
// Needs ffmpeg and, for the WebP, libwebp's img2webp on the PATH (brew install ffmpeg webp).
import { spawn, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { openEntry, loadList } from './compat-entry.mjs';
import { installAudio, wav } from '../src/audio.js';
import { toWebp } from './webp.mjs';

const argv = process.argv.slice(2), id = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
if (!id) { console.error('usage: node tools/record.mjs <compat-shots id> [--from s] [--for s] [--out dir] [--fps n] [--size WxH]'); process.exit(2); }
const e = loadList().find((x) => x.id === id);
if (!e) { console.error(`no entry "${id}" in tools/compat-shots.json`); process.exit(2); }
const FROM = Number(opt('from', 0)), FOR = Number(opt('for', 15)), FPS = Number(opt('fps', 30)), RATE = 44100;
const [OW, OH] = opt('size', '640x480').split('x').map(Number), OUT = opt('out', '/tmp/record');
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg is not on the PATH (brew install ffmpeg)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

let audio = null;
const run = await openEntry(e, (mc) => { audio = installAudio(mc); });

// Up to --from: run, keep no sound (each slice's samples are pulled and dropped, so the mixer's clock
// stays with the machine's).
run.runTo(FROM, () => audio.pull(RATE));

// The frames go to ffmpeg as raw RGB at --size; the sound is gathered and muxed after.
const tmpVideo = join(OUT, `${id}.video.mkv`), tmpWav = join(OUT, `${id}.wav`);
const enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${OW}x${OH}`, '-r', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', tmpVideo], { stdio: ['pipe', 'inherit', 'inherit'] });
const ended = new Promise((res) => enc.on('close', res));
const write = (buf) => (enc.stdin.write(buf) ? null : new Promise((res) => enc.stdin.once('drain', res)));

const out = Buffer.alloc(OW * OH * 3), chunks = [];
let n = 0;
const total = Math.round(FOR * FPS);
for (; n < total && !run.stopped(); n++) {
  const t = FROM + (n + 1) / FPS;
  run.runTo(t, () => chunks.push(audio.pull(RATE)));
  run.video.frame = Math.floor(t * 70) - 1;            // blink and cursor at the VGA's 70 Hz, whatever --fps
  const { rgb, W, H } = run.frame();
  if (!W || !H) { out.fill(0); }
  else for (let y = 0; y < OH; y++) {
    const sy = Math.floor(y * H / OH) * W;
    for (let x = 0; x < OW; x++) { const s = (sy + Math.floor(x * W / OW)) * 3, d = (y * OW + x) * 3; out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2]; }
  }
  const p = write(out); if (p) await p;
  if (n % FPS === FPS - 1) process.stdout.write(`\r${((n + 1) / FPS).toFixed(0)} / ${FOR} s, ${W}x${H}   `);
}
enc.stdin.end(); await ended;
const samples = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
let at = 0; for (const c of chunks) { samples.set(c, at); at += c.length; }
writeFileSync(tmpWav, wav(samples, RATE));
console.log(`\n${n} frames (${(n / FPS).toFixed(1)} s), ${(samples.length / 2 / RATE).toFixed(1)} s of sound` +
  (run.fault ? `, stopped: ${run.fault.message}` : run.dos.programDone ? ', program ended' : ''));

const ff = (args) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (r.status !== 0) process.exit(1); };
const mp4 = join(OUT, `${id}.mp4`);
ff(['-i', tmpVideo, '-i', tmpWav, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mp4]);
console.log(mp4);
if (!argv.includes('--no-webp')) {
  const webp = join(OUT, `${id}.webp`);
  toWebp(tmpVideo, webp, { width: Number(opt('webp-width', 480)), fps: Number(opt('webp-fps', 15)) });
  console.log(webp);
}
rmSync(tmpVideo); rmSync(tmpWav);
