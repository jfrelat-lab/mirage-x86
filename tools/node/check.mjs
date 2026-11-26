// check.mjs — scripts on MIRAGE-LINUX's HLE node (src/node) and on Node itself, compared: what they
// printed (stderr too where a script asks), their status, the files they left.
//
//   node tools/node/check.mjs [name...]        NODE_ASYNC=1: the machine's side as in a page (no Atomics.wait)
//   node tools/node/check.mjs --record         Node's answers written to tools/node/expected.json, which
//                                              tools/test.js holds MIRAGE to without Node beside it
//
// The scripts are tools/node/scripts.mjs's; Node runs them in a directory of its own, `node main.js`, with
// the same environment (PATH, HOME, LANG and TZ=UTC).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { scripts } from './scripts.mjs';
import { runNode } from './mirage.mjs';

const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C', TZ: 'UTC' };
const argsOf = (p) => (p.runFile === false ? p.args : [Object.keys(p.files)[0], ...(p.args || [])]);
const runRef = (p) => {
  const w = mkdtempSync(join(tmpdir(), 'mirage-node-'));
  for (const [f, c] of Object.entries(p.files)) { mkdirSync(dirname(join(w, f)), { recursive: true }); writeFileSync(join(w, f), c); }
  const x = spawnSync(process.execPath, argsOf(p), { cwd: w, env: ENV, input: p.stdin || '', encoding: 'latin1' });
  const files = tree(w); rmSync(w, { recursive: true });
  return { out: x.stdout, err: x.stderr, status: x.status ?? 128, files };
};
const tree = (dir, at = '') => {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f), st = lstatSync(p);
    if (st.isSymbolicLink()) out[at + f] = '-> ' + readlinkSync(p);
    else if (st.isDirectory()) Object.assign(out, { [at + f + '/']: '' }, tree(p, at + f + '/'));
    else out[at + f] = readFileSync(p, 'latin1');
  }
  return out;
};
const RECORD = process.argv.includes('--record');
const picked = process.argv.slice(2).filter((a) => a !== '--record');
const names = picked.length ? picked : Object.keys(scripts);
if (RECORD) {
  const { writeFileSync: write } = await import('fs');
  const out = {};
  for (const name of names) { const p = scripts[name], n = runRef(p); out[name] = { out: n.out, status: n.status, ...(p.stderr ? { err: n.err } : {}), files: n.files }; }
  write(new URL('./expected.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log(`node: ${names.length} answers of Node ${process.version} -> tools/node/expected.json`);
  process.exit(0);
}
let same = 0, diff = 0;
for (const name of names) {
  const p = scripts[name];
  if (!p) { console.log(`${name}: no such script`); diff++; continue; }
  const m = await runNode(argsOf(p).map((a, i) => (i === 0 && p.runFile !== false ? '/w/' + a : a)), { files: p.files, stdin: p.stdin, env: ['TZ=UTC'], async: !!process.env.NODE_ASYNC, tree: true });
  const n = runRef(p);
  const view = (r) => JSON.stringify({ out: r.out, status: r.status, err: p.stderr ? r.err : undefined, files: r.files }, null, 1);
  if (view(m) === view(n)) { same++; console.log(`${name}: same`); }
  else { diff++; console.log(`${name}: DIFFERENT\n--- mirage:\n${view(m)}${p.stderr ? '' : `\n(stderr: ${JSON.stringify(m.err)})`}\n--- node ${process.version}:\n${view(n)}`); }
}
console.log(`node: ${same} same, ${diff} different (against Node ${process.version})`);
process.exitCode = diff ? 1 : 0;
