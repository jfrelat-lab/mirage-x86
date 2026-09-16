// win16-probe.mjs — a Win16 oracle: trap any export of KERNEL/USER/GDI/VGA.DRV inside a real
// Windows 3.0 run, and report its arguments, its return value and its actual effect.
//
//   node tools/win16-probe.mjs KERNEL @175 @177          two ordinals
//   node tools/win16-probe.mjs GDI TEXTOUT EXTTEXTOUT    by name
//   node tools/win16-probe.mjs VGA.DRV EXTTEXTOUT --planes    + effect on the pixels
//   node tools/win16-probe.mjs --census KERNEL           which exports are ACTUALLY called
//   WIN16_KEYS='38,21,a1,b8/13,93/2e,ae,26,a6,18,98,2e,ae,25,a5/1c,9c' …   Alt+F, R, "clock", Enter
//
// This file exists because every measurement that unblocked Windows 3.0 — the selector returned by
// PrestoChangoSelector, the font VGA.DRV refuses, the resource KERNEL believes is loaded — used the
// same recipe, thrown away and rewritten each time. The recipe lives here, with the four guards it
// lacked at least once each:
//
//   1. WITNESS. Every trapped entry also counts its hits WITHOUT the byte check. A zero is only a
//      result if the instrument bit elsewhere; otherwise it is a mute probe, and a mute probe looks
//      exactly like an absence of calls.
//   2. KEY DELIVERY. Under runSlice(1) injected scancodes stop being read at port 0x60: stay on wide
//      slices WHILE scancodes remain unread, and only then single-step. Several measurements were
//      taken on a run where nothing had been typed.
//   3. SIGNATURE AT +3. The first three bytes of a SINGLEDATA entry are rewritten at load time
//      (8c d8 90 -> b8 <DGROUP>): comparing from 0 rejects legitimate entries, comparing from +3
//      still separates two segments that share an IP.
//   4. "n of N". Any truncated list says so in its own output. A six-line slice read as the whole
//      population cost a wrong conclusion and a message that had to be withdrawn.
//
// PASCAL convention: on entry [SS:SP+0] and [SS:SP+2] are the return IP and CS; arguments start at
// [SS:SP+4], the LAST pushed first. The number of bytes popped is read from the SP difference
// between entry and return, which gives the argument count without having to assume it.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';
import { VFS } from '../src/vfs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = join(ROOT, 'boot', process.env.WIN30_DIR || 'WIN30');
const h = (v, n = 4) => (v === undefined || v === null ? '?'.repeat(n) : (v >>> 0).toString(16).padStart(n, '0'));

const argv = process.argv.slice(2);
const census = argv[0] === '--census';
const wantPlanes = argv.includes('--planes');
const modArg = (census ? argv[1] : argv[0]) || '';
const wanted = (census ? [] : argv.slice(1)).filter((a) => !a.startsWith('--'));
if (!modArg) {
  console.error('usage: win16-probe.mjs <MODULE> <@ordinal|NAME> [...] [--planes]\n' +
                '       win16-probe.mjs --census <MODULE>');
  process.exit(2);
}
const file = join(TREE, /\./.test(modArg) ? modArg : modArg.toUpperCase() + '.EXE');
if (!existsSync(file)) { console.error(`no ${file} — build the tree with tools/win30-install.mjs`); process.exit(2); }

// ---- NE entry table: ordinal -> { seg, off }, and the names from both tables -----------------
const nb = readFileSync(file);
const u16 = (o) => nb[o] | (nb[o + 1] << 8);
const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
const ne = u16(0x3c);
const segTab = ne + u16(ne + 0x22), align = 1 << u16(ne + 0x32);
const segFile = (n) => u16(segTab + (n - 1) * 8) * align;      // n = segment number, 1-based

const names = new Map();                                        // ordinal -> name
const readNames = (off, end) => {
  let o = off;
  while (o < end && nb[o]) {
    const n = nb[o], s = String.fromCharCode(...nb.slice(o + 1, o + 1 + n));
    names.set(u16(o + 1 + n), s); o += 1 + n + 2;
  }
};
// KERNEL's RESIDENT table holds only the module name; all its named exports live in the
// NON-RESIDENT table, whose offset is a FILE offset. Its length is NOT field 0x2a (that is the
// imported-names offset): read until the zero-length terminator.
readNames(ne + u16(ne + 0x26), nb.length);
readNames(u32(ne + 0x2c), nb.length);

const entries = new Map();                                      // ordinal -> { seg, off, movable }
{
  let o = ne + u16(ne + 0x04), ord = 1;
  const end = o + u16(ne + 0x06);
  while (o < end) {
    const cnt = nb[o], type = nb[o + 1];
    if (cnt === 0) break;
    o += 2;
    for (let i = 0; i < cnt; i++) {
      if (type === 0xff) { entries.set(ord, { seg: nb[o + 3], off: u16(o + 4), movable: true }); o += 6; }
      else if (type !== 0) { entries.set(ord, { seg: type, off: u16(o + 1), movable: false }); o += 3; }
      ord++;
    }
  }
}
/** The 4 bytes at +3 of the entry, taken from the FILE: the signature that separates two segments
 *  sharing an IP, without depending on the prologue rewritten at load time. */
const sigOf = (e) => [...nb.slice(segFile(e.seg) + e.off + 3, segFile(e.seg) + e.off + 7)];

if (census) {
  const fixed = [...entries.entries()].filter(([, e]) => !e.movable && e.seg === 1);
  console.log(`${modArg}: ${entries.size} entries, ${fixed.length} of them fixed in segment 1 (the only ones covered)`);
}

// ---- the entries to trap ---------------------------------------------------------------------
const traps = new Map();                                        // offset -> { ord, name, sig, seg }
const add = (ord) => {
  const e = entries.get(ord);
  if (!e) { console.error(`  ordinal ${ord} is not in the entry table`); return; }
  traps.set(e.off, { ord, name: names.get(ord) || `@${ord}`, sig: sigOf(e), seg: e.seg, movable: e.movable });
};
if (census) for (const [ord, e] of entries) { if (!e.movable && e.seg === 1) add(ord); }
else for (const w of wanted) {
  if (w.startsWith('@')) add(Number(w.slice(1)));
  else {
    const hit = [...names.entries()].find(([, n]) => n.toUpperCase() === w.toUpperCase());
    if (hit) add(hit[0]); else console.error(`  unknown name: ${w}`);
  }
}
if (!traps.size) { console.error('nothing to trap'); process.exit(2); }

// Guard 1b: print what is ARMED before measuring. A "witness NONE" does not separate "armed at a
// valid address that never ran" (a measurement) from "never armed, resolution failed" (no
// measurement at all) — same class as "n of N". The line below costs one line and makes the
// difference readable in the output itself.
if (!census) for (const [off, t] of traps)
  console.log(`armed: ${t.name} (@${t.ord}) -> segment ${t.seg}${t.movable ? ' MOVABLE' : ''} offset ${h(off)}` +
    `  file signature at +3: ${t.sig.map((x) => h(x, 2)).join(' ')}`);

// ---- la machine --------------------------------------------------------------------------------
const vfs = new VFS();
for (const rel of walk(TREE)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(TREE, rel))));
vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });
const cpu = mc.cpu;

// Guard 2: the key-delivery witness. Count what the guest READS at port 0x60, not what was
// injected — injection always succeeds, the read does not.
const port = [];
const origRead = mc.portRead[0x60];
mc.portRead[0x60] = (p, s) => { const v = origRead(p, s); port.push(v & 0xff); return v; };

const GROUPS = (process.env.WIN16_KEYS || '').split('/')
  .map((g) => g.split(',').map((x) => parseInt(x.trim(), 16)).filter((x) => !isNaN(x))).filter((g) => g.length);
let expectedReads = 2;                                          // the controller's two 0xfa ACKs
for (const g of GROUPS) expectedReads += g.length;

const stamp = () => {                                            // fingerprint of the four VGA planes
  const p = mc.vga && mc.vga.planes; if (!p) return 0;
  let s = 0; for (let i = 0; i < p.length; i += 7) s = (s + p[i] * (i & 255)) >>> 0; return s;
};

dos.load(new Uint8Array(readFileSync(join(TREE, 'WIN.COM'))), ' ' + (process.env.WIN16_ARGS || '/r'), 'C:\\WIN.COM');

const BLOCKS = Number(process.env.WIN16_BLOCKS) || 100_000_000;
const SECS = Number(process.env.WIN16_SECS) || 240;
const MAX = Number(process.env.WIN16_MAX) || 24;                // detailed calls kept
const bare = new Map(), calls = [], counts = new Map();
let pending = null, b = 0, guard = 0, sent = 0;
const t0 = Date.now();
const delivered = () => sent >= GROUPS.length && port.length >= expectedReads;

while (b < BLOCKS && !dos.programDone && !cpu.halted && guard++ < 200_000_000 && Date.now() - t0 < SECS * 1000) {
  if (sent < GROUPS.length && b > BLOCKS * (0.30 + 0.55 * sent / Math.max(1, GROUPS.length - 1))) {
    mc.pushScancodes(GROUPS[sent]); sent++;
  }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  // Guard 2: wide slices while scancodes remain unread; single-stepping only starts afterwards,
  // otherwise the typing never reaches the guest and we measure a run where nothing was typed.
  if (!delivered()) { b += mc.runSlice(20000); continue; }

  const ip = cpu.eip & 0xffff, t = traps.get(ip);
  if (t && !pending) {
    bare.set(t.name, (bare.get(t.name) || 0) + 1);               // guard 1: the witness, no signature
    const lin = (cpu.seg[1] << 4) + ip + 3;
    let ok = true;
    for (let k = 0; k < 4; k++) if (mc.mem.r8(lin + k) !== t.sig[k]) { ok = false; break; }
    if (ok) {
      const sp = cpu.reg[4] & 0xffff, a = (cpu.seg[2] << 4) + sp, r = (x) => mc.mem.r16(a + x);
      counts.set(t.name, (counts.get(t.name) || 0) + 1);
      pending = { name: t.name, ord: t.ord, at: b, cs: cpu.seg[1], entry: ip, ss: cpu.seg[2], sp,
        retIp: r(0), retCs: r(2), args: [r(4), r(6), r(8), r(10), r(12), r(14)],
        in: { AX: cpu.ax & 0xffff, BX: cpu.bx & 0xffff, CX: cpu.cx & 0xffff, DX: cpu.dx & 0xffff },
        planes: wantPlanes ? stamp() : null };
    }
  } else if (pending && cpu.seg[1] === pending.retCs && ip === pending.retIp) {
    if (calls.length < MAX) {
      const l2 = (pending.retCs << 4) + pending.retIp, code = [];
      for (let k = 0; k < 12; k++) code.push(mc.mem.r8(l2 + k));  // what the caller does with the result
      calls.push({ ...pending, code,
        out: { AX: cpu.ax & 0xffff, BX: cpu.bx & 0xffff, CX: cpu.cx & 0xffff, DX: cpu.dx & 0xffff },
        popped: (((cpu.reg[4] & 0xffff) - pending.sp) & 0xffff) - 4,
        painted: wantPlanes ? stamp() !== pending.planes : null });
    }
    pending = null;
  }
  b += mc.runSlice(1);
}

console.log(`${b} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
  (GROUPS.length ? `, scancodes read ${port.length}/${expectedReads}` : '') +
  ` [exit: ${dos.programDone ? 'program done' : cpu.halted ? 'CPU halted' : b >= BLOCKS ? 'budget' : 'time'}]`);
console.log(`witness (IPs alone, no byte check): ` +
  ([...bare.entries()].map(([k, v]) => `${k} x${v}`).join('  ') || '(NONE — if an expected count is zero, the probe itself may be why)'));

if (census) {
  const called = [...counts.entries()].sort((a, c) => c[1] - a[1]);
  console.log(`\nexports called: ${called.length} of ${traps.size} trapped`);
  for (const [n, c] of called.slice(0, 40)) console.log(`  ${n} x${c}`);
  console.log(`(${Math.min(40, called.length)} of ${called.length} shown)`);       // guard 4
} else {
  console.log(`\n${calls.length} detailed call(s) of ${[...counts.values()].reduce((a, c) => a + c, 0)} captured:`);
  for (const c of calls) {
    console.log(`\n  ${c.name} (@${c.ord}) at ${h(c.cs)}:${h(c.entry)}` +
      `  block ${c.at}  returns to ${h(c.retCs)}:${h(c.retIp)}  SS:SP=${h(c.ss)}:${h(c.sp)}`);
    console.log(`    stack on entry: [+4]=${h(c.args[0])} [+6]=${h(c.args[1])} [+8]=${h(c.args[2])} ` +
      `[+10]=${h(c.args[3])} [+12]=${h(c.args[4])} [+14]=${h(c.args[5])}   bytes popped: ${c.popped}`);
    const keys = ['AX', 'BX', 'CX', 'DX'];
    console.log(`    MEASURED: ` + keys.map((k) => `${k} ${h(c.in[k])}->${h(c.out[k])}`).join('  ') +
      (c.painted === null ? '' : `   pixels: ${c.painted ? 'WRITTEN' : 'none'}`));
    console.log(`    bytes at the return address: ${c.code.map((x) => h(x, 2)).join(' ')}`);
  }
  if (!calls.length) console.log('  (none — read the witness above before concluding there were no calls)');
}
