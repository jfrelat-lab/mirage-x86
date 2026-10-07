// d6-profile.mjs — where does a big program's startup time actually go?
//
// ROADMAP D6 asserts that the per-block `new Function` cost dominates big-program startup. That is
// the kind of claim that decides an architecture, so it gets measured before anything is built.
// Splits the run into: time inside `new Function` (the JS engine parsing our emitted source), time
// in the rest of translate() (our decoder + emitter building that source), and time actually
// executing. Also reports emitted-source volume, since parse cost tracks bytes.
//
//   node d6-profile.mjs WOLF3D WOLF3D.EXE 4

const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const [dir, exe, secsArg] = process.argv.slice(2);
const SECS = Number(secsArg || 4);

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

// Mount the whole game directory so relative data-file opens resolve.
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

// Instrument the two halves of compilation separately. `new Function` is the JS engine parsing what
// we emitted; everything else in translate() is our own decode+emit.
const rec = mc.rec;
let nfMs = 0, nfCalls = 0, srcBytes = 0;
const RealFunction = global.Function;
class CountingFunction extends RealFunction {
  constructor(...args) {
    const t = now();
    super(...args);
    nfMs += now() - t; nfCalls++;
    srcBytes += String(args[args.length - 1] || '').length;
  }
}
global.Function = CountingFunction;

let translateMs = 0, translateCalls = 0;
const origTranslate = rec.translate.bind(rec);
rec.translate = (...a) => { const t = now(); const r = origTranslate(...a); translateMs += now() - t; translateCalls++; return r; };

dos.load(new Uint8Array(readFileSync(`${base}/${exe}`)), '', 'C:\\' + exe);

const t0 = now();
while (now() - t0 < SECS * 1000 && !fault && !dos.programDone) mc.runSlice(20000);
const total = now() - t0;

global.Function = RealFunction;
const pct = (x) => ((x / total) * 100).toFixed(1).padStart(5) + '%';
console.log(`${dir}/${exe} — ${total.toFixed(0)} ms of startup, ${(mc.cpu.cycles / 1e6).toFixed(1)} M cycles`);
console.log(`  new Function (JS engine parse) ${nfMs.toFixed(0).padStart(6)} ms  ${pct(nfMs)}   ${nfCalls} calls, ${(srcBytes / 1024).toFixed(0)} KB emitted`);
console.log(`  rest of translate (our emitter)${(translateMs - nfMs).toFixed(0).padStart(6)} ms  ${pct(translateMs - nfMs)}   ${translateCalls} blocks`);
console.log(`  executing                      ${(total - translateMs).toFixed(0).padStart(6)} ms  ${pct(total - translateMs)}`);
console.log(`  avg per block: ${(translateMs / translateCalls).toFixed(3)} ms translate, ` +
  `${(nfMs / (nfCalls || 1)).toFixed(3)} ms new Function, ${(srcBytes / (nfCalls || 1) / 1024).toFixed(1)} KB source`);
if (fault) console.log(`  FAULT: ${fault}`);
