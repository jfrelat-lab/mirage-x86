// node tools/recomp/walls/wall.mjs tools/recomp/walls/fmod.c : build a C file with PRISM (env stdio), run it
// three times (statics are not reset between runs), print its output and the time of each run.
import { buildTarget } from '../../../vendor/prism/src/target.js';
import { dirname, basename } from 'path';
const f = process.argv[2];
const { program } = buildTarget({ name: `wall/${basename(f)}`, dir: dirname(f), units: { list: [basename(f)] }, env: ['stdio'], compile: { memory: 16 } }, { root: dirname(f) });
if (program.failures?.length) throw new Error(JSON.stringify(program.failures));
for (let k = 0; k < 3; k++) {
  const t = performance.now();
  const r = program.run([basename(f)]);
  console.log(`${basename(f)}: ${(performance.now() - t).toFixed(1)} ms  ${String(r.stdout).trim()}`);
}
