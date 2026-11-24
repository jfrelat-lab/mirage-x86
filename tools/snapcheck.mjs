// snapcheck.mjs — does a snapshot hold the whole machine? For each DOS program: a machine runs it for
// `before` ticks, is snapshotted (packed into bytes and unpacked, as the page keeps it), and the snapshot is taken
// back into a machine built afresh. Beside it, the control: the same program run as long, which only
// forgets its translations there (forgetTranslations) -- what a restored machine has not either, and
// what changes a timer-reading program's timeline by itself (MIRAGE's clock moves a block at a time).
// Both run `after` ticks more and are compared: all of memory, the registers, the cycle count, the
// VGA's planes, the DAC. State a module keeps where src/snapshot.js cannot see it (a closure's own
// variable) shows as a difference. Whether the uninterrupted run differs too is said, not counted.
//
//   node tools/snapcheck.mjs                    the golden set's DOS programs
//   node tools/snapcheck.mjs intros/tube.com    one program; games/DOOM/DOOM.EXE a game, its directory as C:
//   SNAP_BEFORE=30 SNAP_AFTER=30 (ticks of 400000 instructions); SNAP_OPAQUE=1 lists what is not walked
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { VFS } from '../src/vfs.js';
import { fileURLToPath } from 'node:url';
import { makeMachine } from './harness.mjs';
import { saveMachine, loadMachine, opaquePaths, forgetTranslations, packSnapshot, unpackSnapshot } from '../src/snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEFORE = Number(process.env.SNAP_BEFORE) || 30, AFTER = Number(process.env.SNAP_AFTER) || 30, BUDGET = 400000;
const DEFAULT = ['demos/PLASMA13.COM', 'demos/XORMUNCH.COM', 'demos/PLANAR.COM', 'demos/CGA.COM', 'demos/VESA.COM',
  ...['256b', '256bytef', 'above', 'abstract', 'animate', 'chaosequ', 'difze', 'dirojed', 'endless', 'crevenge', 'freality',
    'intoanew', 'intro', 'intro256', 'kaneda', 'lattice', 'memories', 'mesha', 'mirrors', 'nibble', 'oktaeder', 'omniscent',
    'paleozoa', 'paralaxa', 'pitman', 'puls', 'qblove', 'revitro', 'rv256', 'soullost', 'starport', 'symetrie', 'tube', 'upup',
    'warp', 'worm'].map((n) => `intros/${n}.com`), 'intros/mars.exe'];

// A game, games/<dir>/<PROG.EXE>: its directory mounted as the root of C:, as tools/run-game.mjs does.
const mountGame = (vfs, dir) => {
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else vfs.addFile('\\' + relative(dir, p).split('/').join('\\'), new Uint8Array(readFileSync(p))); } };
  walk(dir); vfs.chdir('\\');
};
const start = (rel) => {
  const game = /^games\/([^/]+)\/([^/]+)$/.exec(rel), vfs = game ? new VFS() : undefined;
  if (game) mountGame(vfs, join(ROOT, 'games', game[1]));
  const m = makeMachine(vfs ? { vfs } : {});
  m.mc.onError = (e) => { m.fault = e; };
  m.dos.load(new Uint8Array(readFileSync(join(ROOT, rel))), process.env.SNAP_TAIL || '', game ? 'C:\\' + game[2] : 'C:\\PROG');
  return m;
};
const run = (m, ticks) => { for (let t = 0; t < ticks && !m.fault && !m.dos.programDone; t++) m.mc.runSlice(BUDGET); };
/** The state compared, by part: a digest each, so a difference says where it is. */
const parts = (m) => {
  const { mc } = m, c = mc.cpu, h = (b) => createHash('sha1').update(b).digest('hex').slice(0, 12);
  const out = {
    regs: h(Buffer.from(JSON.stringify([[...c.reg], [...c.seg], c.eip, c.flags, c.cr0, c.halted]))),
    cycles: String(c.cycles),
    low: h(mc.mem.u8.subarray(0, 0xa0000)), video: h(mc.mem.u8.subarray(0xa0000, 0xc0000)), high: h(mc.mem.u8.subarray(0x100000)),
    fault: String(m.fault ? m.fault.message : ''), done: String(!!m.dos.programDone),
  };
  if (mc.vga && mc.vga.planes) out.planes = h(mc.vga.planes);
  if (mc.bios && mc.bios.dac) out.dac = h(Buffer.from(mc.bios.dac.buffer, mc.bios.dac.byteOffset, 768));
  return out;
};

/** The first fields where two snapshots differ, by path (memory buffers by their first differing byte). */
const diffSnaps = (sa, sb, max = 12) => {
  const out = [], seen = new Set();
  const walk = (fa, fb, path) => {
    if (out.length >= max) return;
    if (fa === null || typeof fa !== 'object' || fb === null || typeof fb !== 'object') { if (fa !== fb && !(Number.isNaN(fa) && Number.isNaN(fb))) out.push(`${path}: ${String(fa).slice(0, 40)} / ${String(fb).slice(0, 40)}`); return; }
    if (fa.fn || fa.op) return;
    if (!('r' in fa) || !('r' in fb)) { out.push(`${path}: shape`); return; }
    const key = fa.r + ':' + fb.r; if (seen.has(key)) return; seen.add(key);
    const na = sa.nodes[fa.r], nb = sb.nodes[fb.r];
    if (na.k !== nb.k) { out.push(`${path}: kind ${na.k}/${nb.k}`); return; }
    if (na.k === 'b') { const a = new Uint8Array(na.d), b = new Uint8Array(nb.d); if (a.length !== b.length) { out.push(`${path}: ${a.length}/${b.length} bytes`); return; } for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { out.push(`${path}: byte ${i.toString(16)}h ${a[i]}/${b[i]}`); return; } return; }
    if (na.k === 't' || na.k === 'dv') return walk(na.b, nb.b, path);
    if (na.k === 'a' || na.k === 's') { if (na.f.length !== nb.f.length) out.push(`${path}: length ${na.f.length}/${nb.f.length}`); for (let i = 0; i < Math.min(na.f.length, nb.f.length); i++) walk(na.f[i], nb.f[i], `${path}[${i}]`); return; }
    if (na.k === 'm') { if (na.f.length !== nb.f.length) out.push(`${path}: size ${na.f.length}/${nb.f.length}`); for (let i = 0; i < Math.min(na.f.length, nb.f.length); i++) walk(na.f[i][1], nb.f[i][1], `${path}[${String(na.f[i][0])}]`); return; }
    for (const k of new Set([...Object.keys(na.f), ...Object.keys(nb.f)])) walk(na.f[k], nb.f[k], path + '.' + k);
  };
  walk({ r: sa.root }, { r: sb.root }, 'machine');
  for (const k of Object.keys(sa.hooks || {})) if (JSON.stringify(sa.hooks[k]) !== JSON.stringify((sb.hooks || {})[k])) out.push(`hook ${k}`);
  return out;
};

const list = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
let same = 0, diff = 0, failed = 0;
for (const rel of list) {
  if (!existsSync(join(ROOT, rel))) { console.log(`${rel}: skipped (absent)`); continue; }
  const a = start(rel);
  run(a, BEFORE);
  if (process.env.SNAP_OPAQUE) console.log(opaquePaths(a.mc).join('\n'));
  const at = `${(a.mc.cpu.cycles / 1e6).toFixed(0)} M instructions, mode ${a.mc.mem.r8(0x449).toString(16)}h${a.mc.cpu.cr0 & 1 ? ', protected' : ''}${a.mc.cpu.halted ? ', halted' : ''}${a.fault ? ', fault: ' + String(a.fault.message).slice(0, 60) : ''}${a.dos.programDone ? ', exited' : ''}`;
  let b, bytes = 0;
  try {
    const blob = await packSnapshot(saveMachine(a.mc), { image: rel }); bytes = blob.length;
    b = start(rel);
    loadMachine(b.mc, (await unpackSnapshot(blob)).snap);
    b.fault = a.fault;
  } catch (e) { failed++; console.log(`${rel}: FAILED ${e.message}`); continue; }
  const c = start(rel); run(c, BEFORE); forgetTranslations(c.mc);
  run(a, AFTER); run(b, AFTER); run(c, AFTER);
  const pa = parts(a), pb = parts(b), pc = parts(c), bad = Object.keys(pc).filter((k) => pc[k] !== pb[k]);
  const timing = Object.keys(pa).some((k) => pa[k] !== pc[k]) ? ', its timeline moved by the translations made again' : '';
  if (bad.length) {
    diff++; console.log(`${rel}: DIFF ${bad.map((k) => `${k} ${pc[k]}/${pb[k]}`).join(' ')}`);
    if (process.env.SNAP_WHERE) console.log('  ' + diffSnaps(saveMachine(c.mc), saveMachine(b.mc)).join('\n  '));
  }
  else { same++; console.log(`${rel}: same (snapshot at ${at}; ${(bytes / 1024).toFixed(0)} KiB packed${timing})`); }
}
console.log(`snapcheck: ${same} same, ${diff} different, ${failed} failed`);
process.exit(diff || failed ? 1 : 0);
