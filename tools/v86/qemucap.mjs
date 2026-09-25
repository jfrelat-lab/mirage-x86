// The QEMU side of v86triage.mjs: boot the SAME image for the same time, then read from the host —
// the BDA video mode byte, the text buffer, and a screendump. Nothing runs inside the guest.
//
//   node qemucap.mjs <image> [seconds]
import { spawn } from 'child_process';
import { readFileSync, existsSync, statSync, copyFileSync, writeFileSync } from 'fs';
const img = process.argv[2], secs = Number(process.argv[3]) || 20;
const name = img.split('/').pop().replace(/\.[^.]+$/, '');
let size = statSync(img).size;
// Same padding rule as the MIRAGE side, so both boot the same bytes; QEMU also needs a writable
// copy because it refuses readonly on some media and we must never touch the original.
const copy = `/tmp/qcap_${name}.img`;
let bytes = readFileSync(img);
const std = [163840, 184320, 327680, 368640, 737280, 1228800, 1474560];
if (size <= 2949120 && !std.includes(size)) { const pad = Buffer.alloc(1474560); bytes.copy(pad); bytes = pad; }
writeFileSync(copy, bytes);
const hd = bytes.length > 2949120;
const args = ['-m', '16', ...(hd ? ['-drive', `format=raw,file=${copy},if=ide,index=0`, '-boot', 'c']
  : ['-drive', `format=raw,file=${copy},if=floppy,index=0`, '-boot', 'a']),
  '-display', 'none', '-monitor', 'stdio', '-no-reboot'];
const q = spawn('/bin/sh', ['-c', `ulimit -t ${secs + 60}; exec "$@"`, 'sh', '/opt/homebrew/bin/qemu-system-i386', ...args],
  { stdio: ['pipe', 'pipe', 'pipe'] });
let log = ''; q.stdout.on('data', (b) => { log += b; }); q.stderr.on('data', (b) => { log += b; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(secs * 1000);
const mem = `/tmp/qcap_${name}.b8000`, bda = `/tmp/qcap_${name}.bda`, ppm = `/tmp/qcap_${name}.ppm`;
q.stdin.write(`pmemsave 0xb8000 4000 "${mem}"\n`); q.stdin.write(`pmemsave 0x449 1 "${bda}"\n`);
q.stdin.write(`screendump ${ppm}\n`); await sleep(1500);
q.stdin.write('quit\n'); await sleep(500); q.kill('SIGKILL');
if (!existsSync(bda)) { console.log(`${name}: no capture — ${log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter((l) => /error|invalid|could not/i.test(l)).slice(-2).join(' / ').slice(0, 200)}`); process.exit(1); }
const mode = readFileSync(bda)[0];
let out = `${name.padEnd(20)} QEMU [mode ${mode.toString(16)}h]`;
if ([0, 1, 2, 3, 7].includes(mode)) {
  const t = readFileSync(mem), cols = mode <= 1 ? 40 : 80, lines = [];
  for (let y = 0; y < 25; y++) { let l = '';
    for (let x = 0; x < cols; x++) { const ch = t[(y * cols + x) * 2]; l += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ch ? '.' : ' '; }
    lines.push(l.replace(/\s+$/, '')); }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  out += '\n' + lines.filter((l, i) => l || (lines[i - 1] && lines[i + 1])).slice(-10).map((l) => '    | ' + l).join('\n');
} else out += `  screendump -> ${ppm}`;
console.log(out);
