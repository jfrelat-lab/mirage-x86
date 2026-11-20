// run.mjs — recompile a .COM intro to C (x86c.mjs), compile the C with PRISM (vendor/prism), run it
// headless, and hold every frame to MIRAGE's (mirage-ref.mjs): the same 64,000 pixels and 256
// colours at the same guest instruction count.
//
//   node tools/recomp/run.mjs tube [--frames=60] [--no-count] [--bench] [--warmup=20]
//
// A frame is what each intro draws between two polls of port 0x60 (it blits, then polls). The poll is
// where both sides are sampled: MIRAGE through its port table, PRISM through src/env/ports.js. The
// key both answer is the one MIRAGE's keyboard answers with nothing pressed, until the last frame,
// where PRISM's answers ESC (1) so the intro leaves by its own exit path (mode 3, RET to INT 20h).
//
// --bench: no comparison, only time per frame after --warmup frames, for both engines in turn
// (sequentially, in this one process: MIRAGE first, then PRISM).
//
// The generated C goes to tools/recomp/out/ (git-ignored: it embeds the intro's bytes).
//
// MEASURED COST IN PRISM (a performance wall, not a correctness one): every libm call is emitted as
// `M.rt.cos(...)`, a property load on the runtime object, so V8 cannot inline the Math intrinsic.
// Rewriting the emitted `M.rt.{cos,sin,atan2,sqrt,floor}(` to `Math.x(` took lattice from 61 to
// 42 ms a frame and tube from 6.9 to 4.1; the fabs() in C2's range check alone was a fifth of
// lattice, which is why x86c.mjs writes it as two compares.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { translateCom } from './x86c.mjs';
import { mirageFrames, frameHash } from './mirage-ref.mjs';
import { goldenFrame, goldenHash } from './golden-frame.mjs';
import { buildTarget } from '../../vendor/prism/src/target.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => args.includes(`--${k}`);
const name = args.find((a) => !a.startsWith('--')) ?? 'tube';
const FRAMES = +opt('frames', 30);
const path = join(ROOT, 'intros', `${name}.com`);

/** Translate and compile; returns the PRISM program and the C. */
export function build(name, entry, { count = true, structured = true } = {}) {
  const com = new Uint8Array(readFileSync(join(ROOT, 'intros', `${name}.com`)));
  const t0 = performance.now();
  const tr = translateCom(com, entry, { count, structured, name: `${name}.com` });
  const t1 = performance.now();
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(join(OUT, '.gitignore'))) writeFileSync(join(OUT, '.gitignore'), '*\n');
  const file = `${name}${count ? '' : '-nc'}${structured ? '' : '-goto'}.c`;
  writeFileSync(join(OUT, file), tr.c);
  writeFileSync(join(OUT, 'rc.h'), readFileSync(join(HERE, 'rc.h')));
  const { program } = buildTarget({ name: `recomp/${name}`, dir: OUT, units: { list: [file] }, defines: { RC_PRISM: '1' },
    env: ['stdio', 'go32', 'ports', 'vgadac'], compile: { memory: 16 } }, { root: OUT });
  const t2 = performance.now();
  if (program.failures?.length) throw new Error(`PRISM refused: ${program.failures.map((f) => `${f.fn}: ${f.message}`).join('; ')}`);
  if (program.undefined?.length) throw new Error(`PRISM: undefined ${program.undefined.map((u) => u.name).join(', ')}`);
  writeFileSync(join(OUT, file.replace(/\.c$/, '.js')), program.src);
  return { program, tr, file, ms: { translate: t1 - t0, prism: t2 - t1 } };
}

/** Run the PRISM build; `onFrame(i, fb, dac, ic)` at each poll; returns the key to answer. */
export function runPrism(program, { frames, key, onFrame }) {
  const M = program.M;
  const ic = M.mod.symbols.get('rc_ic')?.addr;
  let n = 0;
  M.machine.onPortRead(0x60, () => {
    n++;
    const fb = M.u8.subarray(0xa0000, 0xa0000 + 64000);
    const dac = Uint8Array.from(M.dac.palette, (v) => v >> 2);
    onFrame?.(n, fb, dac, ic !== undefined ? M.mod.dv.getFloat64(ic, true) : NaN);
    return n >= frames ? 1 : key;
  });
  const r = program.run([`C:\\PROG\\${name.toUpperCase()}.COM`]);
  return { frames: n, ...r };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!flag('bench')) {
    const ref = mirageFrames(path, FRAMES);
    if (ref.fault) console.log(`MIRAGE fault: ${ref.fault}`);
    const { program, tr, file, ms } = build(name, ref.entry, { structured: !flag('goto') });
    if (tr.structureRefused) console.log(`structured emission refused (${tr.structureRefused}): gotos`);
    const lines = tr.c.split('\n').length;
    console.log(`${name}: ${tr.starts.length} instructions, ${tr.nBlocks} blocks, ${tr.mode} -> ${file}: ${lines} lines, ${tr.c.length} bytes of C; `
      + `${program.src.length} bytes of JavaScript; translate ${ms.translate.toFixed(1)} ms, PRISM ${ms.prism.toFixed(0)} ms`);
    // MIRAGE adds a block's instructions to cpu.cycles when the block ends, so at the IN it reports
    // the count at the start of the block holding it; the C counts exactly, so the IN's index in its
    // block (the same block here: both start it at the same leader) is taken off before comparing.
    const io = [...tr.ioSites.values()];
    const back = io.length === 1 ? io[0].index : 0;
    const gold = goldenFrame(name);
    let same = 0, sameIc = 0, first = null, goldOk = null;
    const key = ref.frames[0]?.key ?? 0;
    const r = runPrism(program, { frames: FRAMES, key, onFrame: (i, fb, dac, ic) => {
      if (i === gold.frame) goldOk = goldenHash(fb, dac) === gold.baseline;
      const want = ref.frames[i - 1];
      if (!want) return;
      const ok = frameHash(fb, dac) === want.hash;
      if (ok) same++; else if (first === null) first = i;
      if (ic - back === want.cycles) sameIc++;
      if (i <= 3 || !ok || i === FRAMES) console.log(`  frame ${i}: ${ok ? 'same' : 'DIFFERENT'} pixels+DAC; instructions PRISM ${ic} (block start ${ic - back}) MIRAGE ${want.cycles}`);
    } });
    console.log(`${r.frames} frames: ${same} identical to MIRAGE, ${sameIc} at the same instruction count; exit code ${r.code}${first ? `; first difference at frame ${first}` : ''}`);
    console.log(`golden (tools/golden-baseline.json) is frame ${gold.frame}: ${goldOk === null ? 'not reached' : goldOk ? 'PRISM frame hashes to the committed golden' : 'PRISM frame DIFFERS from the committed golden'}`);
    if (r.stdout) console.log(r.stdout);
  } else {
    const WARM = +opt('warmup', 10), N = FRAMES;
    // MIRAGE: time per frame between polls, after WARM frames, on its dynamic recompiler.
    const mt = [];
    let last = 0;
    const t0 = performance.now();
    const ref = mirageFrames(path, WARM + N, { onPoll: () => { const t = performance.now(); if (last) mt.push(t - last); last = t; } });
    const mirageTotal = performance.now() - t0;
    const cyc = ref.frames.map((f) => f.cycles);
    const { program, ms } = build(name, ref.entry, { count: !flag('no-count'), structured: !flag('goto') });
    const pt = [];
    last = 0;
    const t1 = performance.now();
    runPrism(program, { frames: WARM + N, key: ref.frames[0].key, onFrame: () => { const t = performance.now(); if (last) pt.push(t - last); last = t; } });
    const prismTotal = performance.now() - t1;
    const med = (a) => { const s = a.slice(WARM - 1).sort((x, y) => x - y); return s[s.length >> 1]; };
    const insPerFrame = (cyc.at(-1) - cyc[WARM - 1]) / N;
    const mm = med(mt), pm = med(pt);
    console.log(JSON.stringify({ name, frames: N, warmup: WARM, insnPerFrame: Math.round(insPerFrame),
      mirage: { msPerFrame: +mm.toFixed(2), fps: +(1000 / mm).toFixed(2), mips: +(insPerFrame / mm / 1000).toFixed(1), totalMs: Math.round(mirageTotal) },
      prism: { msPerFrame: +pm.toFixed(2), fps: +(1000 / pm).toFixed(2), mips: +(insPerFrame / pm / 1000).toFixed(1), totalMs: Math.round(prismTotal), compileMs: Math.round(ms.prism) },
      speedup: +(mm / pm).toFixed(2) }));
  }
}
