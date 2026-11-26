// mirage.mjs — a script on MIRAGE-LINUX's HLE node (src/node), as tools/linux/run.mjs would run it:
// /usr/bin/node the HLE node, the script's files in /w, /w its working directory. Returns what it printed,
// its status and the files it left in /w.
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { NODE_MAGIC } from '../../src/node/host.js';

export async function runNode(args, { files = {}, stdin = '', env = [], async = false, limit = 4000 } = {}) {
  const mc = new Machine({ memSize: 32 << 20, cpu: '686' }), lx = installLinux(mc);
  for (const d of ['/usr', '/usr/bin', '/w', '/tmp']) lx.mkdir(d);
  lx.chdir('/w');
  const enc = new TextEncoder(), magic = enc.encode(NODE_MAGIC);
  lx.addFile('/usr/bin/node', magic);
  for (const [f, c] of Object.entries(files)) {
    const parts = f.split('/'); for (let i = 1; i < parts.length; i++) lx.mkdir('/w/' + parts.slice(0, i).join('/'));
    lx.addFile('/w/' + f, typeof c === 'string' ? enc.encode(c) : c);
  }
  lx.epoch = 1700000000;
  lx.stdin = enc.encode(stdin);
  lx.nodeAsync = async;
  lx.load(magic, ['node', ...args], ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root', 'LANG=C', ...env]);
  for (let i = 0; i < limit && !lx.done; i++) { mc.runSlice(200000); if (mc.pending) await lx.settle(); }
  const dec = (b) => Buffer.from(b).toString('latin1');
  const out = { out: dec(lx.stdout), err: dec(lx.stderr), status: lx.done ? lx.status : -1 };
  const left = {};
  for (const [k, n] of [...lx.fs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!k.startsWith('/w/') || lx.gone.has(k)) continue;
    left[k.slice(3) + (n.dir ? '/' : '')] = n.dir ? '' : n.link !== undefined ? '-> ' + n.link : dec(n.data.subarray(0, n.size));
  }
  out.files = left;
  if (!lx.done) { for (const q of [lx, ...lx.procs]) if (q.wasm && q.wasm.end) q.wasm.end(); }
  mc.rec.reset();
  return out;
}
