// qboot.mjs — boot a floppy image in QEMU and screendump after N seconds. The image's own AUTOEXEC
// runs the program, so nothing has to be typed.
import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
const [img, secsArg, out] = process.argv.slice(2);
const secs = Number(secsArg) || 20;
const HARD = Math.ceil(secs + 60);
const q = spawn('/bin/sh', ['-c', `ulimit -t ${HARD}; exec "$@"`, 'sh',
  '/opt/homebrew/bin/qemu-system-i386', '-m', '16', '-fda', img, '-boot', 'a',
  '-display', 'none', '-monitor', 'stdio', '-no-reboot'], { stdio: ['pipe', 'pipe', 'pipe'] });
let log = ''; const cap = (b) => { log += b; if (log.length > 65536) log = log.slice(-65536); };
q.stdout.on('data', cap); q.stderr.on('data', cap);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(6000);
  q.stdin.write('sendkey ret\n'); await sleep(700);      // FreeDOS asks date then time
  q.stdin.write('sendkey ret\n');
  await sleep(secs * 1000);
  q.stdin.write(`screendump ${out}\n`); await sleep(2000);
  q.stdin.write('quit\n'); await sleep(600); q.kill('SIGKILL');
  console.log(existsSync(out) ? `capture: ${out} (${statSync(out).size} o)` : `pas de capture\n${log.split('\n').slice(-12).join('\n')}`);
})();
