// check.mjs — the WASI test programs (tools/wasi/programs.mjs) on MIRAGE-LINUX and on Node's own WASI
// (node:wasi, libuv's uvwasi), compared: what they printed, their status, the files they left.
//
//   node tools/wasi/check.mjs [name...]
//
// Both see the same thing: the program at /w/<name>.wasm, /w its working directory and its files, 3
// the root and 4 "." preopened, PATH, HOME and LANG as tools/linux/run.mjs gives them. A trap's message
// is not compared (Node prints none).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, openSync, closeSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { WASI } from 'node:wasi';
import { programs } from './programs.mjs';
import { runWasi } from './mirage.mjs';

const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C' };

const tree = (dir, at = '') => {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(out, tree(p, at + f + '/'), { [at + f + '/']: '' });
    else if (!f.endsWith('.wasm')) out[at + f] = readFileSync(p, 'latin1');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

async function runNode(name, p) {
  const root = mkdtempSync(join(tmpdir(), 'wasi-')), w = join(root, 'w');
  mkdirSync(w);
  for (const [f, c] of Object.entries(p.files || {})) { mkdirSync(dirname(join(w, f)), { recursive: true }); writeFileSync(join(w, f), c); }
  writeFileSync(join(w, name + '.wasm'), p.wasm);
  writeFileSync(join(root, 'in'), p.stdin || '');
  const fds = [openSync(join(root, 'in'), 'r'), openSync(join(root, 'out'), 'w'), openSync(join(root, 'err'), 'w')];
  const wasi = new WASI({ version: 'preview1', args: ['/w/' + name + '.wasm', ...(p.args || [])], env: ENV, preopens: { '/': root, '.': w },
    stdin: fds[0], stdout: fds[1], stderr: fds[2], returnOnExit: true });
  let status;
  try {
    const inst = await WebAssembly.instantiate(await WebAssembly.compile(p.wasm), wasi.getImportObject());
    status = wasi.start(inst);
  } catch (e) { status = e instanceof WebAssembly.RuntimeError ? 134 : (() => { throw e; })(); }
  fds.forEach(closeSync);
  const r = { out: readFileSync(join(root, 'out'), 'latin1'), err: readFileSync(join(root, 'err'), 'latin1'), status, files: tree(w) };
  rmSync(root, { recursive: true });
  return r;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(programs);
let same = 0, diff = 0;
for (const name of names) {
  const p = programs[name];
  const [m, n] = [runWasi(name, p), await runNode(name, p)];
  const view = (r) => JSON.stringify({ out: p.sorted ? r.out.split('\n').filter((l) => l && l !== '.' && l !== '..').sort() : r.out, status: r.status, err: p.stderr ? undefined : r.err, files: r.files }, null, 1);
  if (view(m) === view(n)) { same++; console.log(`${name}: same`); }
  else { diff++; console.log(`${name}: DIFFERENT\n--- mirage:\n${view(m)}\n--- node:wasi:\n${view(n)}`); }
}
console.log(`wasi: ${same} same, ${diff} different`);
process.exitCode = diff ? 1 : 0;
