// webp.mjs — a video to an animated, looping, muted WebP for READMEs (GitHub shows it inline and
// plays it, as a GIF, at a fraction of a GIF's size and with every colour). Homebrew's ffmpeg has no
// WebP encoder: ffmpeg cuts and scales the frames to PNGs, libwebp's img2webp makes the animation.
//
//   node tools/webp.mjs <in.mp4> <out.webp> [--from 0] [--for 10] [--width 640] [--fps 20] [--q 70]
//
// Needs ffmpeg and img2webp on the PATH (brew install ffmpeg webp). tools/record.mjs uses it too.
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export function toWebp(src, out, { from = 0, seconds = 0, width = 640, fps = 20, q = 70 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webp-'));
  try {
    const cut = [...(from ? ['-ss', String(from)] : []), '-i', src, ...(seconds ? ['-t', String(seconds)] : [])];
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...cut, '-an', '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`, join(dir, '%05d.png')], { stdio: 'inherit' });
    if (ff.error || ff.status !== 0) throw new Error('ffmpeg failed (brew install ffmpeg)');
    const frames = readdirSync(dir).sort().map((f) => join(dir, f));
    const r = spawnSync('img2webp', ['-loop', '0', '-lossy', '-q', String(q), '-m', '6', '-min_size', '-d', String(Math.round(1000 / fps)), ...frames, '-o', out], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.error || r.status !== 0) throw new Error('img2webp failed (brew install webp)');
    return { frames: frames.length, bytes: statSync(out).size };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : Number(argv[i + 1]); };
  const [src, out] = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!src || !out) { console.error('usage: node tools/webp.mjs <in> <out.webp> [--from s] [--for s] [--width px] [--fps n] [--q 0-100]'); process.exit(2); }
  const r = toWebp(src, out, { from: opt('from', 0), seconds: opt('for', 0), width: opt('width', 640), fps: opt('fps', 20), q: opt('q', 70) });
  console.log(`${out}: ${r.frames} frames, ${(r.bytes / 1e6).toFixed(2)} MB`);
}
