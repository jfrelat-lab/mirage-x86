// QEMU oracle for xcom144: boot, wait, then dump the DJGPP program's LINEAR range (memsave goes
// through the guest's current paging) plus the registers and a screendump.
//   node qxmem.mjs <seconds> [linbase] [size]
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
const secs = Number(process.argv[2]) || 40;
const base = process.argv[3] || '0x111000', size = process.argv[4] || '0x3e0000';
const copy = '/tmp/qx_xcom.img';
writeFileSync(copy, readFileSync(fileURLToPath(new URL('../../boot/v86/xcom144.img', import.meta.url))));
const args = ['-m', '16', '-drive', `format=raw,file=${copy},if=floppy,index=0`, '-boot', 'a',
  '-display', 'none', '-monitor', 'stdio', '-no-reboot'];
const q = spawn('/opt/homebrew/bin/qemu-system-i386', args, { stdio: ['pipe', 'pipe', 'pipe'] });
let log = ''; q.stdout.on('data', (b) => { log += b; }); q.stderr.on('data', (b) => { log += b; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(secs * 1000);
for (let tries = 0; ; tries++) {
  q.stdin.write('stop\n'); await sleep(300);
  log = '';
  q.stdin.write('info registers\n'); await sleep(500);
  const m = /CR0=([0-9a-f]+)/.exec(log);
  if ((m && (parseInt(m[1], 16) & 0x80000000) && /CS =00af/.test(log)) || tries > 60) { console.log('tries', tries); break; }
  q.stdin.write('cont\n'); await sleep(37);
}
for (let off = 0; off < Number(size); off += 0x10000) q.stdin.write(`memsave ${Number(base) + off} 0x10000 "/tmp/qx_lin_${(off >>> 16).toString(16).padStart(3, '0')}.bin"\n`);
await sleep(3000);
q.stdin.write('pmemsave 0xb8000 4000 "/tmp/qx_b8000.bin"\n');
q.stdin.write('pmemsave 0x449 1 "/tmp/qx_mode.bin"\n');
q.stdin.write('screendump /tmp/qx_screen.ppm\n'); await sleep(2000);
q.stdin.write('quit\n'); await sleep(500); q.kill('SIGKILL');
const clean = log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
console.log(clean.split('\n').filter((l) => /^(EAX|ESI|EIP|ES |CS |SS |DS |CR0|GDT|IDT|LDT)/.test(l)).join('\n'));
console.log('mode', readFileSync('/tmp/qx_mode.bin')[0].toString(16));
