// d6-blocks.mjs — the distribution behind the compile cost.
//
// Wolf3D emits 0.6 KB per block and spends 1% of startup compiling; Turbo Pascal emits 10.7 KB per
// block and spends 65%. So the cost tracks emitted SOURCE VOLUME, not block count, and the question
// is what makes some blocks enormous: many instructions, or expensive instructions?

const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const [dir, exe, secsArg] = process.argv.slice(2);
const SECS = Number(secsArg || 5);
const MAXOPS = Number(process.env.MAXOPS || 0);   // 0 = leave the engine's default

const { readFileSync, readdirSync, statSync } = await import('fs');
const { Machine } = await import(`${ROOT}/src/machine.js`);
const { installBIOS } = await import(`${ROOT}/src/bios.js`);
const { installDOS } = await import(`${ROOT}/src/dos.js`);
const { VFS } = await import(`${ROOT}/src/vfs.js`);
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mc = new Machine({ memSize: 16 << 20 });
mc.timerAuto = true;
installBIOS(mc);
const vfs = new VFS();
const dos = installDOS(mc, vfs);
let fault = null; mc.onError = (e) => { fault = e; };
const base = `${ROOT}/games/${dir}`;
const walk = (d, pre) => {
  for (const n of readdirSync(d)) {
    const p = `${d}/${n}`;
    if (statSync(p).isDirectory()) walk(p, pre + n + '\\');
    else vfs.addFile('\\' + pre + n, new Uint8Array(readFileSync(p)));
  }
};
walk(base, '');            // games/<dir> mounted AS C:\ — see VFS.mountAt()
vfs.chdir('C:\\');

const rec = mc.rec;
const sizes = [], counts = [];
let nfMs = 0;
const RealFunction = global.Function;
let biggest = '';
class F extends RealFunction {
  constructor(...a) {
    const t = now(); super(...a); nfMs += now() - t;
    const src = String(a[a.length - 1] || ''); sizes.push(src.length);
    if (src.length > biggest.length) biggest = src;
  }
}
global.Function = F;
const orig = rec.translate.bind(rec);
rec.translate = (lin, ip0, maxOps) => {
  const b = orig(lin, ip0, MAXOPS && maxOps === undefined ? MAXOPS : maxOps);
  if (b && b.count) counts.push(b.count);
  return b;
};

dos.load(new Uint8Array(readFileSync(`${base}/${exe}`)), '', 'C:\\' + exe);
const t0 = now();
while (now() - t0 < SECS * 1000 && !fault && !dos.programDone) mc.runSlice(20000);
const total = now() - t0;
global.Function = RealFunction;

const s = [...sizes].sort((a, b) => a - b);
const q = (f) => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0;
const sum = s.reduce((a, b) => a + b, 0);
const c = [...counts].sort((a, b) => a - b);
const big = s.filter((x) => x >= 8192).reduce((a, b) => a + b, 0);
console.log(`${dir}/${exe}  maxOps=${MAXOPS || 'default'}  total ${total.toFixed(0)} ms, ` +
  `newFunction ${nfMs.toFixed(0)} ms (${((nfMs / total) * 100).toFixed(1)}%), ${(mc.cpu.cycles / 1e6).toFixed(0)} M cycles`);
console.log(`  blocks ${s.length}, source ${(sum / 1024 / 1024).toFixed(2)} MB total`);
console.log(`  source/block  p50 ${(q(0.5) / 1024).toFixed(1)} KB   p90 ${(q(0.9) / 1024).toFixed(1)} KB   ` +
  `p99 ${(q(0.99) / 1024).toFixed(1)} KB   max ${(q(1) / 1024).toFixed(1)} KB`);
console.log(`  instrs/block  p50 ${c[Math.floor(c.length * 0.5)] || 0}   p90 ${c[Math.floor(c.length * 0.9)] || 0}   ` +
  `max ${c[c.length - 1] || 0}`);
if (process.env.DUMP) {
  const { writeFileSync } = await import('fs');
  writeFileSync(process.env.DUMP, biggest);
  console.log(`  biggest block source (${(biggest.length/1024).toFixed(1)} KB) -> ${process.env.DUMP}`);
}
console.log(`  blocks >= 8 KB: ${s.filter((x) => x >= 8192).length} (${((s.filter((x) => x >= 8192).length / s.length) * 100).toFixed(1)}% of blocks) ` +
  `but ${((big / sum) * 100).toFixed(1)}% of all emitted source`);
