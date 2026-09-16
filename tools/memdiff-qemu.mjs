// memdiff-qemu.mjs — diff the first 640 KB of RAM between MIRAGE and QEMU at the SAME POST code.
//
//   node tools/memdiff-qemu.mjs [rom.bin] [postCode=0x09]
//
// The QEMU counterpart of tools/memdiff-v86.mjs, and the reason for having both: two references that
// agree against us turn a disagreement into a defect; two references that disagree with each other
// mean the question is wrong. That is how the MS-DOS 4 BPB was settled.
//
// QEMU makes the dump side EASIER than v86: the monitor's `pmemsave` writes physical memory straight
// to a file, so there is no hex to parse. Parsing `xp` output is what silently shifted an earlier
// dump by one byte — the echoed address matched the byte pattern — and made QEMU disagree with both
// other emulators on every single field.
//
// ⚠️ THE SYNC POINT IS WEAKER HERE, and this is the honest limit of the tool. v86 hands us the POST
// byte in a synchronous listener, so its dump is taken at that very instant; MIRAGE's port hook does
// the same. QEMU only lets us watch the byte through a serial file, so we poll, and the guest keeps
// running between the byte being written and us reacting. `stop` is issued first, before `pmemsave`,
// which bounds the drift to one polling interval (2 ms) instead of the whole dump — but it does NOT
// make the three dumps simultaneous. MEASURED: three consecutive runs of the same ROM at the same
// POST code gave 1027, 1058 and 1075 differing bytes. So the COUNT is not a metric and this tool
// must not be a gate; what it gives is WHERE they disagree, and even that has to be confirmed
// against memdiff-v86 — whose sync point is exact — before being called a defect.
//
// THE POST PORT IS REDIRECTED HERE, which memdiff-v86 expects you to do at build time. The ROM in
// boot/ writes its codes to 0x190 (POST_PORT in its listing), a port nothing outside the guest can
// observe: this QEMU build has no I/O logging (`-d help` lists none). So the ROM is patched IN
// MEMORY, rewriting the immediate 0x190 to 0x3F8 in both encodings, and BOTH engines are handed the
// same patched image. A wrong patch would therefore hit both runs identically — it cannot invent a
// difference, only hide one.
import { spawn } from 'child_process';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QEMU = process.env.QEMU_BIN || '/opt/homebrew/bin/qemu-system-i386';
const romPath = process.argv[2] || join(ROOT, 'boot/test386.bin');
const WANT = Number(process.argv[3] ?? 0x09);
const LEN = 640 * 1024;
const romRaw = readFileSync(romPath);

/** Rewrite the POST port immediate from 0x190 to the UART data register, so the code is observable
 *  from outside the guest. Both encodings the assembler emits are covered; the count is printed
 *  because a silent zero here would look exactly like a ROM that never posts. */
function redirectPostPort(buf) {
  const out = Buffer.from(buf);
  // TWO PASSES, widest encoding first, each counted. A single pass with an else-if left the 25
  // `66 ba 90 01` (mov edx,0190) sites untouched while reporting a plausible-looking 33 — a partial
  // patch that still posts, so nothing looks wrong until a code is emitted from one of the missed
  // sites. Counting each form separately is what made it visible.
  let wide = 0, near = 0;
  for (let i = 0; i < out.length - 5; i++) {
    if (out[i] === 0x66 && out[i + 1] === 0xba && out[i + 2] === 0x90 && out[i + 3] === 0x01) {
      out[i + 2] = 0xf8; out[i + 3] = 0x03; wide++; i += 5;
    }
  }
  for (let i = 0; i < out.length - 2; i++) {
    if (out[i] === 0xba && out[i + 1] === 0x90 && out[i + 2] === 0x01) {
      out[i + 1] = 0xf8; out[i + 2] = 0x03; near++; i += 2;
    }
  }
  return { out, n: wide + near, wide, near };
}
const { out: rom, n: patched, wide: pWide, near: pNear } = redirectPostPort(romRaw);
console.log(`POST port redirected 0x190 -> 0x3f8 at ${patched} site(s) in ${romPath.split('/').pop()}` +
  ` (${pNear} x 'mov dx', ${pWide} x 'mov edx')`);
if (!patched) { console.error('no POST write found to redirect — wrong ROM?'); process.exit(2); }
const hex = (v, n = 2) => (v >>> 0).toString(16).padStart(n, '0');
if (!existsSync(QEMU)) { console.error(`no qemu at ${QEMU} — set QEMU_BIN`); process.exit(2); }

// ---- MIRAGE ---------------------------------------------------------------
// Same composition as memdiff-v86.mjs: the ROM is the only BIOS, and the snapshot is taken inside
// the port hook, so it is exactly the state at the moment the POST code is written.
const { Machine } = await import(join(ROOT, 'src/machine.js'));
function runMirage() {
  const mc = new Machine({ memSize: 16 << 20 }), cpu = mc.cpu;
  let fault = null; mc.onError = (e) => { fault = e; };
  mc.mem.blit(0x100000 - rom.length, rom);
  let snap = null;
  mc.onPortWrite(0x3f8, (_p, _s, v) => { if ((v & 0xff) === WANT && !snap) snap = mc.mem.u8.slice(0, LEN); });
  mc.onPortRead(0x3f8, () => 0x20);                       // THR empty, so a polling guest proceeds
  mc.onPortWrite(0x92, (_p, _s, v) => { mc.mem.setA20(!!(v & 2)); mc.rec.setMask(mc.mem.mask); });
  mc.onPortRead(0x92, () => (mc.mem.a20 ? 2 : 0));
  mc.tickTimer = () => {};
  cpu.reg.fill(0); cpu.setSeg(1, 0xf000); cpu.eip = 0xfff0;
  cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0); cpu.flags = 2; cpu.halted = false;
  let b = 0; const t0 = Date.now();
  while (!snap && b < 40_000_000 && !cpu.halted && !fault && Date.now() - t0 < 90_000) b += mc.runSlice(20000);
  return snap;
}

// ---- QEMU -----------------------------------------------------------------
function runQemu() {
  return new Promise((resolve) => {
    const post = join(tmpdir(), `qpost-${process.pid}.log`);
    const dump = join(tmpdir(), `qmem-${process.pid}.bin`);
    for (const f of [post, dump]) if (existsSync(f)) unlinkSync(f);
    writeFileSync(post, '');
    // Bounded from the outside: a supervisor can die, the bound must not. Same reason as qemu-shot.
    const patchedRom = join(tmpdir(), `qrom-${process.pid}.bin`);
    writeFileSync(patchedRom, rom);
    const q = spawn('/bin/sh', ['-c', 'ulimit -t 120; exec "$@"', 'sh', QEMU,
      '-bios', patchedRom, '-m', '16', '-display', 'none', '-no-reboot',
      '-monitor', 'stdio', '-serial', `file:${post}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, log = '';
    q.stdout.on('data', (b) => { log += b; });
    q.stderr.on('data', (b) => { log += b; });
    const finish = (mem) => {
      if (done) return; done = true;
      clearInterval(iv); try { q.stdin.write('quit\n'); } catch (e) {}
      setTimeout(() => { q.kill('SIGKILL'); resolve(mem); }, 300);
    };
    const iv = setInterval(() => {
      if (done) return;
      let seen;
      try { seen = readFileSync(post); } catch (e) { return; }
      if (!seen.includes(WANT)) return;
      clearInterval(iv);
      // `stop` FIRST: it pauses the CPU, so whatever pmemsave reads is the state at the pause and
      // not a moving target. The drift that remains is the polling interval, not the dump time.
      // One command per write, spaced: the monitor is a line editor, and sending `stop` and
      // `pmemsave` back to back had the second arrive mangled ("invalid char 'v' in expression",
      // the 'v' of /var). The path is quoted for the same reason.
      q.stdin.write('stop\n');
      setTimeout(() => q.stdin.write(`pmemsave 0 ${LEN} "${dump}"\n`), 150);
      setTimeout(() => {
        try { finish(new Uint8Array(readFileSync(dump))); }
        catch (e) { console.error(`pmemsave produced nothing\n${log.slice(-300)}`); finish(null); }
      }, 1200);
    }, 2);
    setTimeout(() => finish(null), 60_000);
  });
}

const mir = runMirage();
const qem = await runQemu();
if (!mir || !qem) {
  console.error(`no dump: mirage=${mir ? 'ok' : 'MISSING'} qemu=${qem ? 'ok' : 'MISSING'} ` +
    `(was POST code 0x${hex(WANT)} reached on both sides?)`);
  process.exit(2);
}

// Split by region, for the same reason memdiff-v86 does: the IVT and the BDA differ BY CONSTRUCTION
// — MIRAGE fills the vector table with its own stub (F000:FF53) and keeps a BDA, while a bare ROM
// run leaves both at zero. Counting those in one total buries the part worth reading.
const REGIONS = [
  ['IVT  0000-03ff (environment, not the CPU)', 0x000, 0x400],
  ['BDA  0400-04ff (environment, not the CPU)', 0x400, 0x500],
  ['RAM  0500-9ffff (what test386 writes)', 0x500, LEN],
];
let total = 0;
const interesting = [];
for (const [name, lo, hi] of REGIONS) {
  let n = 0;
  for (let i = lo; i < hi && i < qem.length; i++) {
    if (mir[i] !== qem[i]) { n++; if (lo >= 0x500 && interesting.length < 24) interesting.push(i); }
  }
  total += n;
  console.log(`  ${name}: ${n} bytes differ`);
}
console.log(`640 KB dump at POST 0x${hex(WANT)} — ${total} bytes differ of ${LEN}`);
if (interesting.length) {
  console.log('first differing addresses in RAM:');
  for (const a of interesting) console.log(`  ${hex(a, 5)}  mirage ${hex(mir[a])}  qemu ${hex(qem[a])}`);
}
