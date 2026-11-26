// check.mjs — WASI programs on MIRAGE-LINUX and on a reference, compared: what they printed, their
// status, the files they left.
//
//   node tools/wasi/check.mjs [name...]
//   WASI_SDK=<wasi-sdk dir> WASMTIME=<wasmtime binary> node tools/wasi/check.mjs [name...]
//
// The programs: tools/wasi/programs.mjs's, assembled by tools/wasi/wasm.mjs, and with WASI_SDK the C
// ones of tools/wasi/c (built with wasi-sdk's clang, -O2). The reference: wasmtime with WASMTIME, else
// Node's own WASI (node:wasi, libuv's uvwasi).
//
// Both see the same thing: the program at /w/<name>.wasm, /w its working directory and its files; the
// directories given as MIRAGE-LINUX gives them (src/linux.js loadWasm: "/", ".", then the root's own
// directories, here /dev, /proc, /tmp and /w); PATH, HOME and LANG as tools/linux/run.mjs gives them. A trap's
// message is not compared.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, openSync, closeSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { programs, cPrograms } from './programs.mjs';
import { runWasi } from './mirage.mjs';

const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C' };
const HERE = dirname(fileURLToPath(import.meta.url)), SDK = process.env.WASI_SDK, WASMTIME = process.env.WASMTIME;

const tree = (dir, at = '') => {
  const out = {};
  for (const f of readdirSync(dir)) {
    const p = join(dir, f), st = lstatSync(p);
    if (st.isSymbolicLink()) out[at + f] = '-> ' + readlinkSync(p);
    else if (st.isDirectory()) Object.assign(out, tree(p, at + f + '/'), { [at + f + '/']: '' });
    else if (!f.endsWith('.wasm')) out[at + f] = readFileSync(p, 'latin1');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

async function runRef(name, p) {
  const root = mkdtempSync(join(tmpdir(), 'wasi-')), w = join(root, 'w');
  for (const d of ['w', 'dev', 'proc', 'tmp']) mkdirSync(join(root, d));
  for (const [f, c] of Object.entries(p.files || {})) { mkdirSync(dirname(join(w, f)), { recursive: true }); writeFileSync(join(w, f), c); }
  writeFileSync(join(w, name + '.wasm'), p.wasm);
  writeFileSync(join(root, 'in'), p.stdin || '');
  const dirs = [['/', root], ['.', w], ['/dev', join(root, 'dev')], ['/proc', join(root, 'proc')], ['/tmp', join(root, 'tmp')], ['/w', w]];
  const argv = ['/w/' + name + '.wasm', ...(p.args || [])];
  let r;
  if (WASMTIME) {
    const args = ['run', ...dirs.flatMap(([g, h]) => ['--dir', `${h}::${g}`]), ...Object.entries(ENV).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--argv0', argv[0], join(w, name + '.wasm'), ...argv.slice(1)];
    const x = spawnSync(WASMTIME, args, { input: p.stdin || '', encoding: 'latin1', maxBuffer: 1 << 28 });
    r = { out: x.stdout, err: x.stderr, status: x.status ?? 128 + 6 };
  } else {
    const { WASI } = await import('node:wasi');
    const fds = [openSync(join(root, 'in'), 'r'), openSync(join(root, 'out'), 'w'), openSync(join(root, 'err'), 'w')];
    const wasi = new WASI({ version: 'preview1', args: argv, env: ENV, preopens: Object.fromEntries(dirs), stdin: fds[0], stdout: fds[1], stderr: fds[2], returnOnExit: true });
    let status;
    try { status = wasi.start(await WebAssembly.instantiate(await WebAssembly.compile(p.wasm), wasi.getImportObject())); }
    catch (e) { if (e instanceof WebAssembly.RuntimeError) status = 134; else throw e; }
    fds.forEach(closeSync);
    r = { out: readFileSync(join(root, 'out'), 'latin1'), err: readFileSync(join(root, 'err'), 'latin1'), status };
  }
  r.files = tree(w);
  rmSync(root, { recursive: true });
  return r;
}

/** A C program of tools/wasi/c, built with wasi-sdk (cached by its source's bytes). */
const build = (file) => {
  const src = readFileSync(join(HERE, 'c', file));
  let h = 2166136261; for (const x of src) h = Math.imul(h ^ x, 16777619);
  const out = join(tmpdir(), `mirage-wasi-${file.replace(/\.c$/, '')}-${(h >>> 0).toString(16)}.wasm`);
  if (!existsSync(out)) execFileSync(join(SDK, 'bin', 'clang'), ['--sysroot=' + join(SDK, 'share', 'wasi-sysroot'), '-O2', join(HERE, 'c', file), '-o', out, '-lm']);
  return new Uint8Array(readFileSync(out));
};

const all = { ...programs, ...(SDK ? Object.fromEntries(Object.entries(cPrograms).map(([n, p]) => [n, { ...p, get wasm() { return (this._w ||= build(p.c)); } }])) : {}) };
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all).filter((n) => !all[n].mirageOnly);
let same = 0, diff = 0;
for (const name of names) {
  const p = all[name];
  if (!p) { console.log(`${name}: no such program${SDK ? '' : ' (the C ones need WASI_SDK)'}`); diff++; continue; }
  const [m, n] = [await runWasi(name, p), await runRef(name, p)];
  const view = (r) => JSON.stringify({ out: p.sorted ? r.out.split('\n').filter((l) => l && l !== '.' && l !== '..').sort() : r.out, status: r.status, err: p.stderr ? undefined : r.err, files: r.files }, null, 1);
  if (view(m) === view(n)) { same++; console.log(`${name}: same`); }
  else { diff++; console.log(`${name}: DIFFERENT\n--- mirage:\n${view(m)}\n--- ${WASMTIME ? 'wasmtime' : 'node:wasi'}:\n${view(n)}`); }
}
console.log(`wasi: ${same} same, ${diff} different (against ${WASMTIME ? 'wasmtime' : 'node:wasi'})`);
process.exitCode = diff ? 1 : 0;
