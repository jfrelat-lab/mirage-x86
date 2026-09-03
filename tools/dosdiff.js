// dosdiff.js — compare a DOS mode-13h program's output in real DOSBox-X vs MIRAGE.
//
//   node tools/dosdiff.js <prog.com> [ticks] [outdir]
//
// A tiny resident grabber (grabber.asm) snapshots the framebuffer + DAC after K timer
// ticks in headless DOSBox-X without modifying the program; MIRAGE runs the same
// program for K ticks. Both frames are rendered to PNG (<name>-dosbox/-mirage/-diff)
// and a similarity % is reported. Note: x87 is float64 here vs 80-bit on real silicon,
// and animated effects can be a frame out of phase, so expect <100% on raytracers —
// the side-by-side + diff image are the real signal; integer effects should be ~100%.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, cpSync, existsSync, rmSync, mkdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { tmpdir } from 'os';
import { deflateSync } from 'zlib';
import { makeMachine } from './harness.mjs';
import { VFS } from '../src/vfs.js';
import { walk } from './corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NASM = '/opt/homebrew/bin/nasm', DOSBOX = '/opt/homebrew/bin/dosbox-x';
const prog = process.argv[2], K = Number(process.argv[3]) || 24, outdir = process.argv[4] || '/tmp/dosdiff';
if (!prog) { console.error('usage: node tools/dosdiff.js <prog.com> [ticks] [outdir]'); process.exit(2); }
mkdirSync(outdir, { recursive: true });
const name = (process.env.DDEXE || basename(prog)).replace(/\.[^.]+$/, '').toLowerCase();

function dosboxCapture() {
  const work = mkdtempSync(join(tmpdir(), 'dd-'));
  try {
    execSync(`${NASM} -f bin -dKTICKS=${K} "${join(HERE, 'grabber.asm')}" -o "${join(work, 'GRABBER.COM')}"`, { stdio: 'ignore' });
    // `prog` may be a DIRECTORY: a game needs its data files beside it, and the single-file staging
    // could only ever capture a self-contained .COM. Dune is the case that needed it — DUNEDEM.EXE
    // reads a dozen .SQZ/.HSQ archives and takes a command line (DDEXE / DDTAIL).
    let run;
    if (statSync(prog).isDirectory()) {
      cpSync(prog, work, { recursive: true });
      const exe = process.env.DDEXE;
      if (!exe) throw new Error('a directory needs DDEXE=<PROGRAM.EXE> (and optionally DDTAIL="...")');
      run = process.env.DDTAIL ? `${exe} ${process.env.DDTAIL}` : exe;
    } else {
      copyFileSync(prog, join(work, 'PROG.COM'));
      run = 'PROG.COM';
    }
    writeFileSync(join(work, 'db.conf'),
      `[sdl]\noutput=surface\nautolock=false\n[dosbox]\nlogfile=\n[cpu]\ncore=normal\ncputype=pentium\ncycles=max\n[autoexec]\nmount c ${work}\nc:\nGRABBER.COM\n${run}\n`);
    // The grabber snapshots after K TIMER ticks, i.e. K/18.2 seconds of EMULATED time, so the wall
    // clock DOSBox needs grows with K. A fixed 7 s silently produced "no capture" for every workload
    // pinned past ~120 ticks — mesha (400) reads as "hooks INT 8" when it hooks no vector at all.
    // Scale with K, with a floor for short runs, and let DDALARM override.
    const alarm = Number(process.env.DDALARM) || Math.max(7, Math.ceil(K / 18.2065 * 2) + 5);
    try { execSync(`SDL_VIDEODRIVER=dummy perl -e 'alarm ${alarm}; exec @ARGV' ${DOSBOX} -conf "${join(work, 'db.conf')}" -exit`, { stdio: 'ignore', timeout: (alarm + 5) * 1000 }); }
    catch { /* the alarm kills DOSBox — expected */ }
    const out = join(work, 'OUT.BIN'), pal = join(work, 'PAL.BIN');
    if (!existsSync(out) || !existsSync(pal) || statSync(out).size < 64000) return null;
    return { fb: new Uint8Array(readFileSync(out)).subarray(0, 64000), dac: new Uint8Array(readFileSync(pal)).subarray(0, 768) };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function mirageCapture() {
  // Composed like the browser — see harness.mjs. Comparing a fontless MIRAGE against a real DOSBox
  // was comparing a screen we never show a player.
  let vfs, img, tail = '', path = 'C:\\PROG';
  if (statSync(prog).isDirectory()) {
    // Same staging as DOSBox above: the whole directory becomes C:, and DDEXE is the program.
    vfs = new VFS();
    for (const rel of walk(prog)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(prog, rel))));
    vfs.chdir('\\');
    const exe = process.env.DDEXE;
    img = new Uint8Array(readFileSync(join(prog, exe)));
    tail = process.env.DDTAIL ? ' ' + process.env.DDTAIL : '';
    path = 'C:\\' + exe.toUpperCase();
  } else {
    img = new Uint8Array(readFileSync(prog));
  }
  const { mc, dos } = makeMachine(vfs ? { vfs } : undefined);
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(img, tail, path);
  // Both sides must mean the same thing by "K ticks". The DOSBox grabber hooks INT 8 and snapshots
  // after K TIMER ticks, i.e. K/18.2 seconds of emulated time. This side used to run K slices of
  // 1.5 M blocks and FORCE a tickTimer() after each, which ignored pitReload entirely, double-drove
  // the timer (the run loop delivers its own), and executed several times a tick's worth of work per
  // "tick" — so the two frames were never sampled at the same emulated instant, and the mismatch
  // moved with any change to the machine's speed. Count the timer ticks the run loop actually
  // delivers instead, in small slices so we stop near the K-th.
  let ticks = 0, guard = 0;
  const tickTimer = mc.tickTimer.bind(mc);
  mc.tickTimer = () => { ticks++; return tickTimer(); };
  while (ticks < K && !fault && !dos.programDone && guard++ < 4_000_000) mc.runSlice(2048);
  return { fb: mc.mem.u8.slice(0xa0000, 0xa0000 + 64000), dac: mc.bios.dac.slice(), fault: fault ? fault.message : null };
}

const scale6 = (v) => Math.round((v & 63) * 255 / 63);
function toRGB(fb, dac) { const o = new Uint8Array(64000 * 3); for (let i = 0; i < 64000; i++) { const p = fb[i]; o[i * 3] = scale6(dac[p * 3]); o[i * 3 + 1] = scale6(dac[p * 3 + 1]); o[i * 3 + 2] = scale6(dac[p * 3 + 2]); } return o; }

function writePNG(file, rgb320, S = 2) {
  const W = 320 * S, H = 200 * S, buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = (((y / S) | 0) * 320 + ((x / S) | 0)) * 3, d = (y * W + x) * 3; buf[d] = rgb320[s]; buf[d + 1] = rgb320[s + 1]; buf[d + 2] = rgb320[s + 2]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = W * 3, raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  const crc32 = (b) => { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(body)); return Buffer.concat([L, body, C]); };
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

console.log(`# dosdiff ${name} (K=${K} ticks)`);
const db = dosboxCapture();
if (!db) { console.log(`  DOSBox: no capture — the grabber never wrote OUT.BIN. Causes, in the order worth checking: DOSBox did not reach ${K} ticks inside its ${Number(process.env.DDALARM) || Math.max(7, Math.ceil(K / 18.2065 * 2) + 5)}s alarm (raise DDALARM), the program took over INT 8, it ran with interrupts disabled, or it crashed.`); process.exit(1); }
const mi = mirageCapture();
const dbRGB = toRGB(db.fb, db.dac), miRGB = toRGB(mi.fb, mi.dac);
writePNG(join(outdir, name + '-dosbox.png'), dbRGB);
writePNG(join(outdir, name + '-mirage.png'), miRGB);

// similarity + diff image (TOL on summed channel delta)
const TOL = 72, diff = new Uint8Array(64000 * 3); let match = 0;
for (let i = 0; i < 64000; i++) {
  const d = Math.abs(dbRGB[i * 3] - miRGB[i * 3]) + Math.abs(dbRGB[i * 3 + 1] - miRGB[i * 3 + 1]) + Math.abs(dbRGB[i * 3 + 2] - miRGB[i * 3 + 2]);
  if (d <= TOL) { match++; diff[i * 3] = dbRGB[i * 3] >> 2; diff[i * 3 + 1] = dbRGB[i * 3 + 1] >> 2; diff[i * 3 + 2] = dbRGB[i * 3 + 2] >> 2; }
  else { diff[i * 3] = 255; diff[i * 3 + 1] = 0; diff[i * 3 + 2] = 80; }
}
writePNG(join(outdir, name + '-diff.png'), diff);
console.log(`  match: ${(match / 64000 * 100).toFixed(1)}%${mi.fault ? '  (MIRAGE FAULT: ' + mi.fault + ')' : ''}  → ${outdir}/${name}-{dosbox,mirage,diff}.png`);
