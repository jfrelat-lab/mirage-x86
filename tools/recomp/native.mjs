// native.mjs — the same generated C, built natively (clang + SDL2, tools/recomp/native/rc_sdl.c) and
// held to MIRAGE frame by frame, then timed. The third column beside MIRAGE's dynamic recompiler and
// PRISM: if native matches MIRAGE and PRISM does not, the wall is PRISM's.
//
//   node tools/recomp/native.mjs tube [--frames=60] [--bench] [--warmup=20] [--window] [--ppm=1,84]
//
// Built with -O2 -ffp-contract=off (no fused multiply-add: the x87 model is one rounding per
// operation, as MIRAGE's doubles are) -fwrapv -fno-strict-aliasing (the C reads words through byte
// pointers at any alignment, as the guest does).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { translateCom } from './x86c.mjs';
import { mirageFrames, frameHash } from './mirage-ref.mjs';
import { goldenFrame, goldenHash } from './golden-frame.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const CLANG = process.env.CC ?? '/usr/bin/clang';
const SDL2_CONFIG = process.env.SDL2_CONFIG ?? '/opt/homebrew/bin/sdl2-config';

export function buildNative(name, entry, { count = true, structured = true } = {}) {
  const com = new Uint8Array(readFileSync(join(ROOT, 'intros', `${name}.com`)));
  const tr = translateCom(com, entry, { count, structured, name: `${name}.com` });
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(join(OUT, '.gitignore'))) writeFileSync(join(OUT, '.gitignore'), '*\n');
  const tag = `${name}${count ? '' : '-nc'}${structured ? '' : '-goto'}`;
  writeFileSync(join(OUT, `${tag}.c`), tr.c);
  writeFileSync(join(OUT, 'rc.h'), readFileSync(join(HERE, 'rc.h')));
  const sdl = execFileSync(SDL2_CONFIG, ['--cflags', '--libs'], { encoding: 'utf8' }).trim().split(/\s+/);
  const exe = join(OUT, `rc_${tag}`);
  const t0 = performance.now();
  execFileSync(CLANG, ['-O2', '-ffp-contract=off', '-fwrapv', '-fno-strict-aliasing', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', '-Wno-unused-const-variable', '-o', exe,
    join(OUT, `${tag}.c`), join(HERE, 'native', 'rc_sdl.c'), ...sdl], { stdio: ['ignore', 'inherit', 'inherit'] });
  return { exe, tr, ms: performance.now() - t0 };
}

/** Run the native build; returns [{ frame, ic, ms }] and the dump directory. */
export function runNative(exe, { frames, key, dump = null, extra = [] }) {
  const args = [`--frames=${frames}`, `--key=${key}`, ...(dump ? [`--dump=${dump}`] : []), ...extra];
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${exe} exited ${r.status}: ${r.stderr}`);
  const rows = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [f, ic, ms] = l.split(' ').map(Number); return { frame: f, ic, ms }; });
  return { rows, stderr: r.stderr.trim() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const flag = (k) => args.includes(`--${k}`);
  const name = args.find((a) => !a.startsWith('--')) ?? 'tube';
  const FRAMES = +opt('frames', 30);
  const path = join(ROOT, 'intros', `${name}.com`);
  if (!flag('bench')) {
    const ref = mirageFrames(path, FRAMES);
    const { exe, tr, ms } = buildNative(name, ref.entry, { structured: !flag('goto') });
    console.log(`${name}: native ${tr.mode} build ${exe.split('/').pop()} in ${ms.toFixed(0)} ms`);
    const dump = join(OUT, `${name}-frames`);
    rmSync(dump, { recursive: true, force: true }); mkdirSync(dump, { recursive: true });
    const shots = opt('ppm', null);
    const extra = [...(flag('window') ? ['--window'] : []), ...(shots ? [`--ppm=${dump}`, `--shots=${shots}`] : [])];
    const { rows, stderr } = runNative(exe, { frames: FRAMES, key: ref.frames[0].key, dump, extra });
    const back = [...tr.ioSites.values()][0]?.index ?? 0;
    const gold = goldenFrame(name);
    let same = 0, sameIc = 0, first = null, goldOk = null, diffPx = 0;
    for (const row of rows) {
      const raw = readFileSync(join(dump, `f${String(row.frame).padStart(4, '0')}.bin`));
      const fb = raw.subarray(0, 64000), dac = raw.subarray(64000);
      if (row.frame === gold.frame) goldOk = goldenHash(fb, dac) === gold.baseline;
      const want = ref.frames[row.frame - 1];
      if (!want) continue;
      const ok = frameHash(fb, dac) === want.hash;
      if (ok) same++; else { if (first === null) first = row.frame; }
      if (row.ic - back === want.cycles) sameIc++;
      if (!ok && first === row.frame) {
        // How far apart: MIRAGE's frame, kept for the first difference only.
        const keep = mirageFrames(path, row.frame, { keep: true }).frames[row.frame - 1];
        for (let i = 0; i < 64000; i++) if (keep.fb[i] !== fb[i]) diffPx++;
      }
    }
    console.log(`${rows.length} frames: ${same} identical to MIRAGE, ${sameIc} at the same instruction count; ${stderr}`
      + (first ? `; first difference at frame ${first} (${diffPx} pixels differ)` : ''));
    console.log(`golden (tools/golden-baseline.json) is frame ${gold.frame}: ${goldOk === null ? 'not reached' : goldOk ? 'native frame hashes to the committed golden' : 'native frame DIFFERS from the committed golden'}`);
    for (const f of readdirSync(dump)) if (f.endsWith('.bin')) rmSync(join(dump, f));
  } else {
    const WARM = +opt('warmup', 10);
    const ref = mirageFrames(path, 1);
    const { exe } = buildNative(name, ref.entry, { count: !flag('no-count'), structured: !flag('goto') });
    const { rows } = runNative(exe, { frames: WARM + FRAMES, key: ref.frames[0].key });
    const s = rows.slice(WARM).map((r) => r.ms).sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const ipf = (rows.at(-1).ic - rows[WARM - 1].ic) / FRAMES;
    console.log(JSON.stringify({ name, frames: FRAMES, warmup: WARM, native: { msPerFrame: +med.toFixed(3), fps: +(1000 / med).toFixed(1), mips: +(ipf / med / 1000).toFixed(0) } }));
  }
}
