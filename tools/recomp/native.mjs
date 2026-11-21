// native.mjs — the generated C built natively (clang + SDL2, tools/recomp/native/rc_sdl.c) and held to
// MIRAGE frame by frame, then timed. The third column beside MIRAGE's dynamic recompiler and PRISM:
// if native matches MIRAGE and PRISM does not, the wall is PRISM's.
//
//   node tools/recomp/native.mjs tube [--frames=60] [--bench] [--warmup=20] [--window] [--ppm=1,84]
//   node tools/recomp/native.mjs tube --play [--fps=60]   the executable (tools/recomp/out/rc_tube), run in its window
//                                                at the intro's own speed; it runs alone too, with no options
//
// A frame is a frame point of the C (a read of port 60h, an INT 16h, or the head of the main loop of a
// program that never polls): there it writes the frame and the exact instruction count, and MIRAGE is
// run to exactly that count (tools/recomp/oracle.mjs) and hashed. When the C's guard reports code the
// program rewrote, those bytes are declared volatile (out/<name>.volatile.json) and it is translated
// again -- a guard hit on anything but an immediate is a refusal.
//
// Built with -O2 -ffp-contract=off (no fused multiply-add: the x87 model is one rounding per
// operation, as MIRAGE's doubles are) -fwrapv -fno-strict-aliasing (the C reads words through byte
// pointers at any alignment, as the guest does).
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { HERE, OUT, prepare, translate, loadVolatile, saveVolatile, guardHits, snapFlag } from './common.mjs';
import { oracleHashes, frameHash } from './oracle.mjs';

const CLANG = process.env.CC ?? '/usr/bin/clang';
const SDL2_CONFIG = process.env.SDL2_CONFIG ?? '/opt/homebrew/bin/sdl2-config';

export function buildNative(name, prep, opts = {}) {
  const { tr, file } = translate(name, prep, opts);
  const sdl = execFileSync(SDL2_CONFIG, ['--cflags', '--libs'], { encoding: 'utf8' }).trim().split(/\s+/);
  const exe = join(OUT, `rc_${file.replace(/\.c$/, '')}`);
  const t0 = performance.now();
  execFileSync(CLANG, ['-O2', '-ffp-contract=off', '-fwrapv', '-fno-strict-aliasing', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', '-Wno-unused-const-variable', '-Wno-unused-function', '-o', exe,
    join(OUT, file), join(HERE, 'native', 'rc_sdl.c'), ...sdl], { stdio: ['ignore', 'inherit', 'inherit'] });
  return { exe, tr, ms: performance.now() - t0 };
}

/** Run the native build; returns its rows [{ frame, ic, ms }], exit status and output. */
export function runNative(exe, { frames, key, dump = null, extra = [] }) {
  const args = [`--frames=${frames}`, `--key=${key}`, ...(dump ? [`--dump=${dump}`] : []), ...extra];
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: +(process.env.RC_TIMEOUT || 120000) });
  const rows = r.stdout.trim().split('\n').filter((l) => /^\d+ \d+ [\d.]+$/.test(l)).map((l) => { const [f, ic, ms] = l.split(' ').map(Number); return { frame: f, ic, ms }; });
  return { rows, status: r.status, stdout: r.stdout, stderr: r.stderr.trim() };
}

/** Build and run, declaring volatile what the guard reports, until it stops reporting. */
export function buildAndRun(name, prep, { frames, key, dump, extra = [], opts = {} }) {
  for (let round = 0; ; round++) {
    const b = buildNative(name, prep, opts);
    if (dump) { rmSync(dump, { recursive: true, force: true }); mkdirSync(dump, { recursive: true }); }
    const r = runNative(b.exe, { frames, key, dump, extra });
    const hits = guardHits(r.stdout);
    if (r.status === 3 && /reached code outside the image/.test(r.stdout) && !prep.snapshot && round < 8) {
      const why = `runs code outside its image at ${r.stdout.match(/([0-9a-f]{4}): reached code outside/)[1]} (it unpacks or relocates itself)`;
      writeFileSync(snapFlag(name), why);
      console.log(`  ${why}: translating from a snapshot`);
      continue;
    }
    if (r.status === 4 && hits.length && round < 8) {
      const vol = loadVolatile(name);
      for (const a of hits) vol.add(a);
      saveVolatile(name, vol);
      console.log(`  guard: the program rewrote ${hits.map((a) => a.toString(16)).join(' ')}; declared volatile, translating again`);
      continue;
    }
    return { ...b, ...r };
  }
}

/** MIRAGE's key with nothing pressed, as its port 60h answers it. */
export const IDLE_KEY = 0x9c;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const flag = (k) => args.includes(`--${k}`);
  const name = args.find((a) => !a.startsWith('--')) ?? 'tube';
  const EVERY = +opt('every', 1);
  const FRAMES = +opt('frames', 30) * EVERY;
  const prep = await prepare(name);
  // --play: the executable built, then run as itself -- a window at the intro's own speed (the real clock),
  // the keyboard, until Esc or its own end. Its path is printed: it runs without this tool, with no options.
  if (flag('play')) {
    const { exe } = buildNative(name, prep, { structured: !flag('goto') });
    console.log(`${name}: ${exe}`);
    const r = spawnSync(exe, opt('fps', null) ? [`--fps=${opt('fps')}`] : [], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (!flag('bench')) {
    const dump = join(OUT, `${name}-frames`);
    const shots = opt('ppm', null);
    const extra = [`--every=${EVERY}`, ...(flag('window') ? ['--window'] : []), ...(shots ? [`--ppm=${dump}`, `--shots=${shots}`] : [])];
    const r = buildAndRun(name, prep, { frames: FRAMES, key: IDLE_KEY, dump, extra, opts: { structured: !flag('goto') } });
    const { tr } = r;
    console.log(`${name}: ${tr.snapshot ? `SNAPSHOT at ${tr.snapshot} (entry: ${tr.entryRefused}); ` : ""}${tr.nInsns} instructions, ${tr.nNodes} nodes, ${tr.nBlocks} blocks, ${tr.mode}${tr.structureRefused ? ` (${tr.structureRefused})` : ''}; `
      + `frame point ${tr.syncAt !== null ? `loop head ${tr.syncAt.toString(16)}` : tr.frameIns.map((x) => x.toString(16)).join(' ')}; guard ${tr.guardBytes} bytes; volatile ${[...loadVolatile(name)].map((x) => x.toString(16)).join(' ') || 'none'}`);
    const want = r.rows.length ? oracleHashes(prep.path, r.rows.map((x) => x.ic)) : [];
    let same = 0, first = null;
    for (const [i, row] of r.rows.entries()) {
      const raw = readFileSync(join(dump, `f${String(row.frame).padStart(4, '0')}.bin`));
      const ok = want[i] && want[i].hash === frameHash(raw.subarray(0, 64000), raw.subarray(64000));
      if (ok) same++; else if (first === null) first = row;
    }
    let diff = '';
    if (first) {
      const k = oracleHashes(prep.path, [first.ic], { keep: [first.ic] })[0];
      const raw = readFileSync(join(dump, `f${String(first.frame).padStart(4, '0')}.bin`));
      if (k?.fb) {
        const fb = Buffer.from(k.fb, 'base64'), dac = Buffer.from(k.dac, 'base64');
        let px = 0, dc = 0;
        for (let i = 0; i < 64000; i++) if (fb[i] !== raw[i]) px++;
        for (let i = 0; i < 768; i++) if (dac[i] !== raw[64000 + i]) dc++;
        diff = `; first difference at frame ${first.frame} (instruction ${first.ic}): ${px} pixels, ${dc} DAC bytes`;
      } else diff = `; MIRAGE did not reach instruction ${first.ic} (${JSON.stringify(k)})`;
    }
    console.log(`${r.rows.length} frames (last at instruction ${r.rows.at(-1)?.ic}): ${same} identical to MIRAGE at the same instruction count${diff}; exit ${r.status}; ${r.stderr}`);
    const tail = r.stdout.split('\n').filter((l) => l && !/^\d+ \d+ [\d.]+$/.test(l));
    if (tail.length) console.log(tail.slice(0, 10).join('\n'));
    for (const f of readdirSync(dump)) if (f.endsWith('.bin')) rmSync(join(dump, f));
    writeFileSync(join(OUT, `${name}.native.json`), JSON.stringify({ frames: r.rows.length, same, status: r.status, ic: r.rows.map((x) => x.ic) }));
  } else {
    const WARM = +opt('warmup', 10);
    const r = buildAndRun(name, prep, { frames: (WARM * EVERY) + FRAMES, key: IDLE_KEY, extra: [`--every=${EVERY}`], opts: { count: !flag('no-count'), structured: !flag('goto') } });
    const s = r.rows.slice(WARM).map((x) => x.ms).sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const ipf = (r.rows.at(-1).ic - r.rows[WARM - 1].ic) / (r.rows.length - WARM);
    console.log(JSON.stringify({ name, frames: r.rows.length - WARM, warmup: WARM, insnPerFrame: Math.round(ipf), native: { msPerFrame: +med.toFixed(3), fps: +(1000 / med).toFixed(1), mips: +(ipf / med / 1000).toFixed(0) } }));
  }
}
