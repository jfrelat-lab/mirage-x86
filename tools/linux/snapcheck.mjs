// snapcheck.mjs — does a snapshot hold a whole MIRAGE-LINUX machine? An OASIS Linux image is started as
// the page starts it (its entry, its console), run, given keys, snapshotted (packed into bytes and
// unpacked, as the page keeps it) and taken back into a machine built afresh; then both are given the
// same keys again and run on. Beside them the control, run as long, which only forgets its translations
// at the snapshot (src/snapshot.js forgetTranslations). Compared at the end: all of memory, the
// registers, the cycles, what the program wrote. State MIRAGE-LINUX keeps where src/snapshot.js cannot
// see it shows as a difference (SNAP_WHERE=1 says where). Exact under MIRAGE_MAXOPS=1.
//
//   node tools/linux/snapcheck.mjs linux/docker-python-3.12-alpine 'x = 6 * 7\n' 'print(x)\n'
//   node tools/linux/snapcheck.mjs linux/docker-busybox 'echo a | wc -c\n' 'ls /\n'
//
// Arguments after the image: what is typed before the snapshot, and what after it (\n a newline).
// SNAP_SECS (default 30): guest seconds run before each key line and after the last, at most (a machine
// whose processes all wait for a key stops sooner); SNAP_SHOW=1 prints what the kept and the restored
// machines wrote; SNAP_SIZES=1 what the snapshot holds; SNAP_VERBOSE=1 each step's time.
import { createHash } from 'node:crypto';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { installBIOS } from '../../src/bios.js';
import { VtConsole } from '../../src/vtconsole.js';
import { saveMachine, loadMachine, forgetTranslations, packSnapshot, unpackSnapshot } from '../../src/snapshot.js';
import { findImage, linuxRoot, hostOver } from '../oasis.mjs';

const [name, before = '', after = ''] = process.argv.slice(2);
if (!name) { console.error('usage: node tools/linux/snapcheck.mjs <image> [typed before] [typed after]'); process.exit(2); }
const img = findImage(name), root = await linuxRoot(img), e = img.entry || {}, m = img.machine || {};
const SECS = Number(process.env.SNAP_SECS) || 30;
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

/** The image's machine, as src/linuxrun.js makes it (the guest's clock, not the wall's). */
const build = () => {
  const ram = (m.mem || 64) << 20;
  const mc = new Machine({ memSize: ram, ramSize: ram, cpu: m.cpu || '686' });
  installBIOS(mc);
  const out = [];
  const lx = installLinux(mc, { onOutput: (fd, b) => out.push(...b) });
  lx.host = hostOver(root);
  lx.epoch = 1700000000;
  lx.chdir(e.cwd || '/');
  if (e.console) { lx.consoleStdio(); lx.console = new VtConsole(mc.mem.u8, mc.vga); lx.console.clear(); lx.console.row = 0; lx.console.col = 0; lx.console.syncCursor(); }
  const as = e.user ? lx.runAs(e.user) : null, home = (e.env && e.env.HOME) || (as ? as.home : '/root');
  const env = ['PATH=/usr/local/bin:/usr/bin:/bin', `HOME=${home}`, 'LANG=C', ...Object.entries(e.env || {}).filter(([k]) => k !== 'HOME').map(([k, v]) => `${k}=${v}`)];
  lx.load(lx.readFile(e.run), [e.run, ...(e.args || [])], env);
  return { mc, lx, out };
};
const SEC = 1e8;
// Until the guest seconds are run, or every process waits for a key (the machine blocked, no key typed
// yet: its clock stops) -- as src/linuxrun.js runs it, which goes on while typed keys wait to be read.
const run = (x, secs) => { const end = x.mc.cpu.cycles + secs * SEC; while (!x.lx.done && !(x.mc.blocked && !x.lx.ttyIn.length) && x.mc.cpu.cycles < end) x.mc.runSlice(200000); };
const type = (x, s) => { if (s) { x.lx.ttyInput([...new TextEncoder().encode(unescape(s))]); x.mc.blocked = false; } };
const parts = (x) => {
  const c = x.mc.cpu, h = (b) => createHash('sha1').update(b).digest('hex').slice(0, 12);
  return { regs: h(Buffer.from(JSON.stringify([[...c.reg], [...c.seg], c.eip, c.flags, c.cr0, c.cr3]))), cycles: String(c.cycles),
    mem: h(x.mc.mem.u8), out: h(Uint8Array.from(x.out)), done: String(x.lx.done) };
};

const T0 = performance.now(), say = (t) => { if (process.env.SNAP_VERBOSE) console.error(`${((performance.now() - T0) / 1000).toFixed(0)} s: ${t}`); };
// One machine at a time, each forgetting its translations when it is done: a second machine ran ten
// times slower while the first one's thousands of compiled blocks were alive (V8), snapshot or not.
const sizes = (a) => {                              // what the snapshot holds: memory's pages written, the files' bytes
  const u32 = new Uint32Array(a.mc.mem.u8.buffer); let pages = 0;
  for (let p = 0; p < u32.length / 1024; p++) for (let i = p * 1024; i < p * 1024 + 1024; i++) if (u32[i]) { pages++; break; }
  let files = 0, host = 0;
  for (const [, n] of a.lx.fs) if (n.data) { files += n.data.length; if (typeof n.host === 'string') host += n.data.length; }
  const own = new Set(); for (const q of [a.lx, ...(a.lx.procs || [])]) if (q.pages) for (const pg of q.pages.values()) own.add(pg.frame);
  let mapped = 0; for (const f of own) for (let i = f >> 2; i < (f >> 2) + 1024; i++) if (u32[i]) { mapped++; break; }
  console.log(`processes' pages: ${own.size} (${mapped} not zeros); frames taken: ${((a.lx.nextFrame - 0x100000) / 4096) | 0}, ${a.lx.freeFrames.length} free`);
  console.log(`memory: ${pages} pages of 4 KiB written (${(pages * 4 / 1024).toFixed(1)} MiB); files: ${(files / 1048576).toFixed(1)} MiB, ${(host / 1048576).toFixed(1)} MiB of them read from the image`);
};
// SNAP_PAGES=1: each physical page's digest and who maps it (a process's virtual page), to say where
// memory differs.
const pageMap = (x) => {
  const u8 = x.mc.mem.u8, h = [], owner = new Map();
  for (const q of [x.lx, ...(x.lx.procs || [])]) if (q.pages) for (const [vpn, pg] of q.pages) owner.set(pg.frame >>> 12, `pid ${q.pid} va ${(vpn * 4096).toString(16)}`);
  for (let p = 0; p < u8.length >>> 12; p++) h.push(createHash('sha1').update(u8.subarray(p << 12, (p + 1) << 12)).digest('hex').slice(0, 8));
  return { h, owner, text: u8.slice(0xb8000, 0xb8000 + 4000) };
};
const ending = (x, n) => { type(x, after); run(x, SECS); say(`${n} ran on, ${(x.mc.cpu.cycles / 1e6).toFixed(0)} M${x.mc.blocked ? ', waiting' : ''}`); const r = { parts: parts(x), text: new TextDecoder().decode(Uint8Array.from(x.out)), pages: process.env.SNAP_PAGES ? pageMap(x) : null }; x.mc.rec.reset(); return r; };
let blob, at, ra, rb, rc;
{
  const a = build();
  run(a, SECS); say(`started, ${(a.mc.cpu.cycles / 1e6).toFixed(0)} M`); type(a, before); run(a, SECS); say(`typed, ${(a.mc.cpu.cycles / 1e6).toFixed(0)} M`);
  blob = await packSnapshot(saveMachine(a.mc, { with: { out: a.out } }), { image: name });
  say(`packed, ${blob.length} bytes`);
  if (process.env.SNAP_SIZES) sizes(a);
  at = `${(a.mc.cpu.cycles / 1e6).toFixed(0)} M instructions, ${a.lx.procs ? a.lx.procs.length + 1 : 1} processes`;
  ra = ending(a, 'kept');
}
{ const c = build(); run(c, SECS); type(c, before); run(c, SECS); forgetTranslations(c.mc); say(`control at ${(c.mc.cpu.cycles / 1e6).toFixed(0)} M`); rc = ending(c, 'control'); }
{
  const b = build();
  loadMachine(b.mc, (await unpackSnapshot(blob)).snap, { with: { out: b.out } });
  say('restored');
  rb = ending(b, 'restored');
}
if (process.env.SNAP_SHOW) for (const [n, r] of [['kept', ra], ['restored', rb]]) console.log(`--- ${n}:\n${r.text}`);
const pa = ra.parts, pb = rb.parts, pc = rc.parts, bad = Object.keys(pc).filter((k) => pc[k] !== pb[k]);
const timing = Object.keys(pa).some((k) => pa[k] !== pc[k]) ? ', its timeline moved by the translations made again' : '';
if (bad.length) console.log(`${name}: DIFF ${bad.map((k) => `${k} ${pc[k]}/${pb[k]}`).join(' ')}`);
if (bad.length && rc.pages) {
  const d = rc.pages.h.map((v, p) => (v !== rb.pages.h[p] ? p : -1)).filter((p) => p >= 0);
  console.log(`  ${d.length} pages differ: ` + d.slice(0, 16).map((p) => `${(p * 4096).toString(16)}h (${rc.pages.owner.get(p) || '-'} / ${rb.pages.owner.get(p) || '-'})`).join(', '));
  if (d.includes(0xb8)) {                          // the text screen: where, and what each has there
    const A = rc.pages.text, B = rb.pages.text, at = []; for (let i = 0; i < 4000 && at.length < 8; i++) if (A[i] !== B[i]) at.push(`${(i >> 1) / 80 | 0}:${(i >> 1) % 80}${i & 1 ? ' attr' : ''} ${A[i].toString(16)}/${B[i].toString(16)}`);
    console.log('  text screen: ' + at.join(', '));
  }
}
else console.log(`${name}: same (snapshot at ${at}; ${(blob.length / 1024).toFixed(0)} KiB packed${timing})`);
process.exit(bad.length ? 1 : 0);
