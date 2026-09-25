// QEMU with the vendor Cirrus CL-GD5446 VGA BIOS (86Box/roms video/cirruslogic/5446bv.vbi, in
// boot/roms/, never committed) instead of SeaVGABIOS: a third BIOS lineage for the INT 10h oracles.
//
//   node cirrusboot.mjs banner                 text page ~1 s after power-on (positive control:
//                                              the Cirrus sign-on must be there)
//   node cirrusboot.mjs <image> [seconds]      boot a floppy image, print what it writes to COM1
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const ROM = ROOT + '/boot/roms/5446bv.vbi';
if (!existsSync(ROM)) { console.error(`missing ${ROM} (see ROADMAP H1)`); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QEMU = '/opt/homebrew/bin/qemu-system-i386';
const vga = ['-vga', 'none', '-device', `cirrus-vga,romfile=${ROM}`];

if (process.argv[2] === 'banner') {
  const q = spawn(QEMU, [...vga, '-display', 'none', '-monitor', 'stdio', '-no-reboot'],
    { stdio: ['pipe', 'ignore', 'inherit'] });
  const out = '/tmp/cirrus_b8000.bin';
  await sleep(Number(process.argv[3]) * 1000 || 1000);
  q.stdin.write('stop\n');
  q.stdin.write(`pmemsave 0xb8000 4000 "${out}"\n`);
  await sleep(700);
  q.stdin.write('quit\n');
  await new Promise((r) => q.on('exit', r));
  const m = readFileSync(out);
  for (let r = 0; r < 25; r++) {
    let s = ''; for (let c = 0; c < 80; c++) { const ch = m[(r * 80 + c) * 2]; s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; }
    if (s.trim()) console.log(s.trimEnd());
  }
} else {
  const img = process.argv[2], secs = Number(process.argv[3]) || 30;
  let bytes = readFileSync(img);
  const copy = '/tmp/cirrus_boot.img';
  if (statSync(img).size < 1474560) { const p = Buffer.alloc(1474560); bytes.copy(p); bytes = p; }
  writeFileSync(copy, bytes);
  const q = spawn(QEMU, [...vga, '-drive', `format=raw,file=${copy},if=floppy`, '-serial', 'stdio',
    '-display', 'none', '-device', 'isa-debug-exit,iobase=0xf4,iosize=4', '-no-reboot'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  q.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/\r/g, '')));
  const t = setTimeout(() => q.kill('SIGKILL'), secs * 1000);
  await new Promise((r) => q.on('exit', r)); clearTimeout(t);
}
