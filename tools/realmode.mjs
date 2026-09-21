// realmode.mjs — run kvm-unit-tests' x86/realmode against MIRAGE's CPU.
//
//   node tools/realmode.mjs [boot/realmode.flat]
//
// 51 real-mode tests written by the KVM people to catch emulator bugs, which is exactly what this
// is. It complements boot/test386.bin rather than repeating it: test386 walks a POST sequence and
// stops at the first section that fails, so everything after the stop is unmeasured; this one runs
// every case and prints PASS or FAIL for each, so a single defect does not hide fifty results.
//
// HOW TO BUILD IT. The binary is not committed — boot/ is gitignored, like every third-party image
// here. It needs an i386 gcc with -m16, which this machine has not got, so it is built in a
// container:
//
//   git clone --depth 1 https://gitlab.com/kvm-unit-tests/kvm-unit-tests.git /tmp/kut
//   docker run --rm --platform linux/386 -v /tmp/kut:/src -w /src i386/debian:bookworm \
//     bash -c "apt-get update -qq && apt-get install -y -qq gcc make binutils && \
//              ./configure --arch=i386 && make x86/realmode.flat"
//   cp /tmp/kut/x86/realmode.flat boot/
//
// HOW IT IS STARTED, and why not at its own entry point. `realmode.flat` is an ELF whose entry at
// `start` is a MULTIBOOT kernel: 32-bit protected mode, flat selectors, a GDT of its own — its only
// job is to drop back to real mode and jump to `realmode_entry`. QEMU gets there through -kernel.
// Reproducing that here would test our protected-mode entry, not the real-mode cases, so the loader
// below does what the stub would have done: map the PT_LOAD segments, zero the bss, and start in
// REAL MODE at `realmode_entry` with a flat zero segment base and ESP at `stacktop`.
//
// The guest talks through COM1: each case prints "PASS: name" or "FAIL: name", and exit() writes the
// exit code to port F4h and then "--- DONE: n ---". Port 3FDh answers "transmit register empty" so
// its UART polling proceeds.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = process.argv[2] || join(ROOT, 'boot/realmode.flat');
const SECS = Number(process.env.SECS) || 60;
let elf;
try { elf = new Uint8Array(readFileSync(path)); }
catch (e) { console.error(`no ${path} — build it first (see the header of this file)`); process.exit(2); }
if (elf[0] !== 0x7f || elf[1] !== 0x45) { console.error(`${path} is not an ELF`); process.exit(2); }

const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
const phoff = dv.getUint32(28, true), phentsize = dv.getUint16(42, true), phnum = dv.getUint16(44, true);

// The suite executes CPUID unconditionally, so it needs a part that has one: the '586' profile.
// MIRAGE_CPU overrides, which is how to check that a 386 answers #UD rather than crashing.
const mc = new Machine({ memSize: 16 << 20, cpu: process.env.MIRAGE_CPU || '586' });
installBIOS(mc);
const cpu = mc.cpu;

// PT_LOAD only, at its PHYSICAL address, and memsz > filesz means bss: it must be zeroed, or the
// test's own pass/fail counters start as whatever was in memory.
let loaded = 0;
for (let i = 0; i < phnum; i++) {
  const o = phoff + i * phentsize;
  if (dv.getUint32(o, true) !== 1) continue;
  const off = dv.getUint32(o + 4, true), paddr = dv.getUint32(o + 12, true);
  const filesz = dv.getUint32(o + 16, true), memsz = dv.getUint32(o + 20, true);
  mc.mem.blit(paddr, elf.subarray(off, off + filesz));
  for (let k = filesz; k < memsz; k++) mc.mem.w8(paddr + k, 0);
  loaded += memsz;
}

// The symbols the multiboot stub would have used. Read from the ELF rather than hard-coded: the
// addresses move whenever the file is rebuilt, and a stale constant would start the guest inside an
// instruction rather than on one.
const shoff = dv.getUint32(32, true), shentsize = dv.getUint16(46, true), shnum = dv.getUint16(48, true);
let symtab = null, strtab = null;
for (let i = 0; i < shnum; i++) {
  const o = shoff + i * shentsize;
  if (dv.getUint32(o + 4, true) !== 2) continue;                    // SHT_SYMTAB
  symtab = { off: dv.getUint32(o + 16, true), size: dv.getUint32(o + 20, true), entsize: dv.getUint32(o + 36, true) };
  const so = shoff + dv.getUint32(o + 24, true) * shentsize;        // sh_link -> the string table
  strtab = dv.getUint32(so + 16, true);
}
const symbols = new Map();
if (symtab) for (let k = 0; k < symtab.size / symtab.entsize; k++) {
  const o = symtab.off + k * symtab.entsize;
  let n = '', p = strtab + dv.getUint32(o, true);
  while (elf[p]) n += String.fromCharCode(elf[p++]);
  symbols.set(n, dv.getUint32(o + 4, true));
}
const entry = symbols.get('realmode_entry'), stacktop = symbols.get('stacktop');
if (entry === undefined || stacktop === undefined) {
  console.error('realmode_entry / stacktop not found — is the binary stripped?'); process.exit(2);
}

let out = '', exitCode = null;
mc.onPortWrite(0x3f8, (_p, _s, v) => { out += String.fromCharCode(v & 0xff); });
mc.onPortRead(0x3fd, () => 0x20);                    // transmit holding register empty
mc.onPortWrite(0xf4, (_p, _s, v) => { if (exitCode === null) exitCode = v & 0xff; });

cpu.reg.fill(0);
cpu.setSeg(1, 0); cpu.eip = entry >>> 0;             // CS:IP — a flat zero base, as the stub leaves it
cpu.setSeg(0, 0); cpu.setSeg(2, 0); cpu.setSeg(3, 0); cpu.setSeg(4, 0); cpu.setSeg(5, 0);
cpu.reg[4] = stacktop >>> 0;
cpu.flags = 2; cpu.halted = false;
let fault = null; mc.onError = (e) => { fault = e; };

console.log(`${path.split('/').pop()}: ${loaded} bytes loaded, CPU profile ${cpu.profile.name}, ` +
  `entry realmode_entry ${entry.toString(16)}, stack ${stacktop.toString(16)}`);
let blocks = 0; const t0 = Date.now();
while (!cpu.halted && !fault && exitCode === null && blocks < 2_000_000_000 && Date.now() - t0 < SECS * 1000) {
  blocks += mc.runSlice(20000);
  mc.tickTimer();                                    // some cases HLT and wait for the timer IRQ
}

// Strip everything outside printable ASCII before matching: the guest's UART setup leaves a stray
// byte at the head of the stream, and "PASS: null" then failed to match `startsWith('PASS:')` — it
// was counted as an unrecognised line and reported as "never reached".
const lines = out.split('\n').map((l) => l.replace(/[^\x20-\x7e]/g, '')).filter((l) => l.trim());
const pass = lines.filter((l) => l.startsWith('PASS:')).map((l) => l.slice(6));
const fail = lines.filter((l) => l.startsWith('FAIL:')).map((l) => l.slice(6));
for (const l of lines) if (!l.startsWith('PASS:')) console.log('  ' + l);

// The reference, BY NAME. A count is not a result here: this run stops at the first thing MIRAGE
// cannot do, so "104 passed" says nothing about which of the 127 cases were never reached. The list
// was recorded from QEMU, and v86 produced exactly the same 127 — two references agreeing.
let expected = [];
try { expected = readFileSync(join(ROOT, 'tools/realmode-expected.txt'), 'utf8').split('\n').filter((l) => l.trim()); }
catch (e) { /* no baseline: fall back to counts alone */ }
const hx = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
// Which routine it stopped in: the nearest symbol at or below the address. "0000:8280" alone says
// nothing; "test_sti_inhibit+12" says which case to read.
const where = (addr) => {
  let best = null;
  for (const [n, v] of symbols) if (v <= addr && (!best || v > best[1]) && n && !n.startsWith('.')) best = [n, v];
  return best ? `${best[0]}+${(addr - best[1]).toString(16)}` : '(no symbol)';
};
console.log(`${blocks.toLocaleString('en-US')} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s; ` +
  `stopped ${cpu.halted ? 'on HLT' : exitCode !== null ? 'at exit()' : fault ? 'on a fault' : 'at the time limit'}` +
  ` at ${hx(cpu.seg[1])}:${hx(cpu.eip >>> 0, 8)} — ${where(((cpu.seg[1] << 4) + (cpu.eip >>> 0)) >>> 0)}` +
  `${fault ? `\n  FAULT: ${(fault.message || fault).slice(0, 200)}` : ''}`);
if (expected.length) {
  const got = new Set(pass);
  const failed = new Set(fail);
  const missing = expected.filter((n) => !got.has(n) && !failed.has(n));
  console.log(`realmode: ${pass.length}/${expected.length} of the reference's cases pass` +
    `, ${fail.length} fail, ${missing.length} never reached`);
  if (fail.length) console.log('  FAILED: ' + fail.join(', '));
  if (missing.length) console.log(`  first never reached: ${missing[0]}` +
    (missing.length > 1 ? ` (then ${missing.length - 1} more)` : ''));
} else {
  console.log(`realmode: ${pass.length} passed, ${fail.length} failed` +
    (exitCode === null ? ' — THE GUEST NEVER REACHED ITS EXIT, so this is a prefix, not a result' : `, exit code ${exitCode}`));
}
// A run that never reached exit() has not finished, and a count of passes from a prefix is not a
// score: it is whatever ran before the guest stopped.
process.exit(fail.length || exitCode === null || exitCode !== 0 ? 1 : 0);
