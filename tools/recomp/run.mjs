// run.mjs — recompile a DOS intro to C (x86c.mjs), compile the C with PRISM (vendor/prism), run it
// headless, and hold every frame to MIRAGE's at the same guest instruction count (oracle.mjs).
//
//   node tools/recomp/run.mjs tube [--frames=60] [--goto] [--bench] [--warmup=20] [--no-count]
//
// A frame is a frame point of the C (port 60h, INT 16h, or a never-polling program's main-loop head:
// rc.h turns all three into a read of port 60h), sampled through PRISM's port table. The key
// answered is MIRAGE's with nothing pressed, until the last frame, where it is ESC (1) so the intro
// leaves by its own exit path. The volatile immediates are those native.mjs found
// (out/<name>.volatile.json): run it first for a program that rewrites its code.
//
// --bench: no comparison; ms per frame over the same instruction counts for MIRAGE's dynamic
// recompiler (in this process, its normal configuration) and then PRISM, sequentially.
//
// History of a PRISM wall: libm calls used to be emitted as `M.rt.cos(...)`, a property load V8 could
// not inline through (lattice 61 -> 42 ms a frame once rewritten as Math.cos); PRISM 6391e47 emits
// Math.x itself.
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { OUT, prepare, translate } from './common.mjs';
import { oracleHashes, frameHash, mirageMachine } from './oracle.mjs';
import { IDLE_KEY } from './native.mjs';
import { buildTarget } from '../../vendor/prism/src/target.js';

/** Translate and compile with PRISM; returns the PRISM program. */
export function build(name, prep, opts = {}) {
  const { tr, file, ms: tms } = translate(name, prep, opts);
  const t1 = performance.now();
  const { program } = buildTarget({ name: `recomp/${name}`, dir: OUT, units: { list: [file] }, defines: { RC_PRISM: '1' },
    env: ['stdio', 'go32', 'ports', 'vgadac'], compile: { memory: 16 } }, { root: OUT });
  const t2 = performance.now();
  if (program.failures?.length) throw new Error(`PRISM refused: ${program.failures.map((f) => `${f.fn}: ${f.message}`).join('; ')}`);
  if (program.undefined?.length) throw new Error(`PRISM: undefined ${program.undefined.map((u) => u.name).join(', ')}`);
  writeFileSync(join(OUT, file.replace(/\.c$/, '.js')), program.src);
  return { program, tr, file, ms: { translate: tms, prism: t2 - t1 } };
}

/** Run the PRISM build; `onFrame(i, fb, dac, ic)` at each frame point. */
export function runPrism(program, { frames, key = IDLE_KEY, onFrame, argv0 = 'PROG' }) {
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
  const r = program.run([`C:\\PROG\\${argv0.toUpperCase()}.COM`]);
  return { frames: n, ...r };
}

/** MIRAGE (normal configuration, this process): ms for each stretch between the given counts. */
export async function mirageTimes(path, counts) {
  const m = await mirageMachine(path);
  const t = [];
  let last = performance.now();
  for (const n of counts) {
    while (!m.fault() && !m.dos.programDone && m.cpu.cycles < n) m.mc.runSlice(Math.max(1, Math.floor((n - m.cpu.cycles) / 192)));
    const now = performance.now(); t.push(now - last); last = now;
  }
  return t;
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const flag = (k) => args.includes(`--${k}`);
  const name = args.find((a) => !a.startsWith('--')) ?? 'tube';
  const FRAMES = +opt('frames', 30);
  const prep = await prepare(name);
  if (!flag('bench')) {
    const { program, tr, file, ms } = build(name, prep, { structured: !flag('goto') });
    console.log(`${name}: ${tr.nInsns} instructions, ${tr.nBlocks} blocks, ${tr.mode}${tr.structureRefused ? ` (${tr.structureRefused})` : ''} -> ${file}: ${tr.c.length} bytes of C; `
      + `${program.src.length} bytes of JavaScript; translate ${ms.translate.toFixed(1)} ms, PRISM ${ms.prism.toFixed(0)} ms`);
    const got = [];
    const r = runPrism(program, { frames: FRAMES, argv0: name, onFrame: (i, fb, dac, ic) => got.push({ i, ic, hash: frameHash(fb, dac) }) });
    const want = got.length ? oracleHashes(prep.path, got.map((g) => g.ic)) : [];
    let same = 0, first = null;
    got.forEach((g, k) => { if (want[k]?.hash === g.hash) same++; else if (!first) first = g; });
    console.log(`${got.length} frames (last at instruction ${got.at(-1)?.ic}): ${same} identical to MIRAGE at the same instruction count; exit code ${r.code}`
      + `${first ? `; first difference at frame ${first.i} (instruction ${first.ic})` : ''}`);
    if (r.stdout) console.log(r.stdout.trim().split('\n').slice(0, 10).join('\n'));
    writeFileSync(join(OUT, `${name}.prism.json`), JSON.stringify({ frames: got.length, same, code: r.code, ic: got.map((g) => g.ic) }));
  } else {
    const WARM = +opt('warmup', 10), N = FRAMES;
    const { program, ms } = build(name, prep, { count: !flag('no-count'), structured: !flag('goto') });
    const pt = [], ics = [];
    let last = performance.now();
    runPrism(program, { frames: WARM + N, argv0: name, onFrame: (i, fb, dac, ic) => { const t = performance.now(); pt.push(t - last); ics.push(ic); last = t; } });
    // MIRAGE over the same counts (when the C counts; --no-count gives no counts to follow).
    let mm = null;
    if (!flag('no-count')) { const mt = await mirageTimes(prep.path, ics); mm = med(mt.slice(WARM)); }
    const pm = med(pt.slice(WARM));
    const ipf = (ics.at(-1) - ics[WARM - 1]) / N;
    console.log(JSON.stringify({ name, frames: N, warmup: WARM, insnPerFrame: Math.round(ipf),
      mirage: mm && { msPerFrame: +mm.toFixed(2), mips: +(ipf / mm / 1000).toFixed(1) },
      prism: { msPerFrame: +pm.toFixed(2), mips: +(ipf / pm / 1000).toFixed(1), compileMs: Math.round(ms.prism) },
      speedup: mm && +(mm / pm).toFixed(2) }));
  }
}
