// mirage.mjs — one WASI test program (tools/wasi/programs.mjs) on MIRAGE-LINUX, as tools/linux/run.mjs
// would run it: the program at /w/<name>.wasm, /w its working directory. Returns what it printed, its
// status and the files it left in /w.
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';

export function runWasi(name, p) {
  const mc = new Machine({ memSize: 16 << 20, cpu: '686' }), lx = installLinux(mc);
  lx.mkdir('/w'); lx.chdir('/w');
  for (const [f, c] of Object.entries(p.files || {})) {
    const parts = f.split('/'); for (let i = 1; i < parts.length; i++) lx.mkdir('/w/' + parts.slice(0, i).join('/'));
    lx.addFile('/w/' + f, new TextEncoder().encode(c));
  }
  lx.addFile('/w/' + name + '.wasm', p.wasm);
  lx.epoch = Math.floor(Date.now() / 1000);
  lx.stdin = new TextEncoder().encode(p.stdin || '');
  lx.load(p.wasm, ['/w/' + name + '.wasm', ...(p.args || [])], ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root', 'LANG=C']);
  for (let i = 0; i < 1000 && !lx.done; i++) mc.runSlice(20000);
  const dec = (b) => Buffer.from(b).toString('latin1');
  const files = {};
  for (const [k, n] of [...lx.fs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!k.startsWith('/w/') || k.endsWith('.wasm')) continue;
    files[k.slice(3) + (n.dir ? '/' : '')] = n.dir ? '' : dec(n.data.subarray(0, n.size));
  }
  mc.rec.reset();
  return { out: dec(lx.stdout), err: dec(lx.stderr), status: lx.done ? lx.status : -1, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) };
}
