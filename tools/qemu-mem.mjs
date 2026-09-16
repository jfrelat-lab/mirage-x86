// qemu-mem.mjs — read a QEMU guest's PHYSICAL memory through its monitor, to feed tools/struct.mjs
// with a second (or third) independent source.
//
//   node tools/qemu-mem.mjs <image> <addr> <len> <out.bin> [seconds=12]
//   node tools/qemu-mem.mjs boot/W30HD.IMG 0x276c 48 /tmp/qemu.bin 14
//
// Two references beat one: if QEMU and v86 agree against us, the defect is ours; if they disagree
// with each other, the question itself is wrong. That is how the MS-DOS 4 BPB was settled — both
// carried the partition's BPB at 0070:206c, ours carried IO.SYS's template.
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const [img, addrArg, lenArg, out, secsArg] = process.argv.slice(2);
if (!img || !addrArg || !lenArg || !out) {
  console.error('usage: node tools/qemu-mem.mjs <image> <addr> <len> <out.bin> [seconds]');
  process.exit(2);
}
const addr = Number(addrArg), len = Number(lenArg), secs = Number(secsArg) || 12;
// Bounded from the outside the way tools/qemu-shot.mjs is: a supervisor can die, the bound must not.
const q = spawn('/bin/sh', ['-c', `ulimit -t ${secs + 60}; exec "$@"`, 'sh',
  process.env.QEMU_BIN || '/opt/homebrew/bin/qemu-system-i386', '-m', '32', '-hda', img, '-boot', 'c',
  '-display', 'none', '-monitor', 'stdio', '-no-reboot'], { stdio: ['pipe', 'pipe', 'pipe'] });
let log = '';
q.stdout.on('data', (b) => { log += b; });
q.stderr.on('data', (b) => { log += b; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(secs * 1000);
  log = '';
  q.stdin.write(`xp /${len}xb 0x${addr.toString(16)}\n`);
  await sleep(1500);
  q.stdin.write('quit\n'); await sleep(400); q.kill('SIGKILL');
  // `xp` prints "0000276c: 0xff 0xff …". Take ONLY what follows the colon: sweeping the whole
  // stream with /0x[0-9a-f]{2}/ also picked up part of the echoed address and shifted the dump by
  // one byte — which made QEMU disagree with both other emulators on every single field.
  const bytes = [];
  for (const line of log.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0 || !/^[0-9a-f]{4,}$/i.test(line.slice(0, i).trim())) continue;
    for (const m of line.slice(i + 1).matchAll(/0x([0-9a-f]{2})/g)) bytes.push(parseInt(m[1], 16));
  }
  if (bytes.length < len) {
    console.error(`QEMU returned only ${bytes.length} of ${len} bytes\n${log.slice(-400)}`);
    process.exit(1);
  }
  writeFileSync(out, Buffer.from(bytes.slice(0, len)));
  console.log(`QEMU: ${len} bytes read at 0x${addr.toString(16)} after ${secs}s -> ${out}`);
})();
