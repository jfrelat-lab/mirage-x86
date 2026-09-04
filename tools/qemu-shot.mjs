// qemu-shot.mjs — capture an unmodified DOS program's screen from OUTSIDE the guest.
//
//   node tools/qemu-shot.mjs <prog.com> [seconds=10] [out.ppm]
//
// Every other capture path in this repo runs INSIDE the guest and therefore competes with it for the
// machine: tools/grabber.asm rides the timer IRQ, and a program that takes INT 8 in protected mode —
// intros/mesha.com does, as a DPMI client — locks it out for good (docs/TIMING.md §14d/§14e). QEMU's
// monitor has `screendump`, which reads the emulated VGA from the host side: nothing to install in the
// guest, nothing to hook, and it does not care what mode the CPU is in or who owns the interrupts.
//
// The guest is FreeDOS booted off boot/FREEDOS14.IMG with the program's directory exposed as a second
// drive through QEMU's vvfat, so nothing has to be written into the floppy image. The command is typed
// at the DOS prompt with monitor `sendkey`, for the same reason: no modification of anything.
import { spawn } from 'child_process';
import { mkdtempSync, copyFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const QEMU = process.env.QEMU_BIN || '/opt/homebrew/bin/qemu-system-i386';
const prog = process.argv[2];
const secs = Number(process.argv[3]) || 10;
const out = process.argv[4] || join(ROOT, 'shot.ppm');
if (!prog) { console.error('usage: node tools/qemu-shot.mjs <prog.com> [seconds] [out.ppm]'); process.exit(2); }
if (!existsSync(QEMU)) { console.error(`no qemu at ${QEMU} — set QEMU_BIN`); process.exit(2); }
// MSDOS622.IMG, not FREEDOS14.IMG: the FreeDOS image is an INSTALLER disk that stops at
// "Do you want to proceed [Y,N]?" and never reaches a prompt — which the first capture showed,
// and which a blind harness would have reported as "the program drew nothing".
const floppy = join(ROOT, 'boot', process.env.QSHOT_IMG || 'MSDOS622.IMG');
if (!existsSync(floppy)) { console.error(`missing ${floppy}`); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'qshot-'));
copyFileSync(prog, join(work, 'PROG.COM'));

const qemu = spawn(QEMU, [
  '-m', '16', '-fda', floppy, '-boot', 'a',
  '-drive', `file=fat:rw:${work},format=raw,if=ide,index=0`,
  '-display', 'none', '-monitor', 'stdio', '-no-reboot',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let log = '';
qemu.stdout.on('data', (b) => { log += b; });
qemu.stderr.on('data', (b) => { log += b; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mon = (cmd) => { qemu.stdin.write(cmd + '\n'); };
// `sendkey` names one key per call; a DOS command line is typed one keystroke at a time.
const type = async (s) => {
  for (const ch of s) {
    const k = ch === ':' ? 'shift-semicolon' : ch === '\\' ? 'backslash' : ch === '.' ? 'dot' : ch.toLowerCase();
    mon(`sendkey ${k}`);
    await sleep(30);
  }
  mon('sendkey ret');
};

(async () => {
  await sleep(Number(process.env.QSHOT_BOOT) || 10000);   // boot, unattended
  // The floppy carries no AUTOEXEC.BAT, so MS-DOS asks for the date and then the time before it
  // gives a prompt. Without these two the commands below are typed INTO the date prompt and answered
  // with "Invalid date" — which the capture showed, and which is indistinguishable from a program
  // that drew nothing if nobody looks at the picture.
  mon('sendkey ret'); await sleep(700);
  mon('sendkey ret'); await sleep(1200);
  await type('c:');                         // vvfat is the first hard disk
  await sleep(800);
  await type('prog');
  await sleep(secs * 1000);
  mon(`screendump ${out}`);
  await sleep(1500);
  mon('quit');
  await sleep(600);
  qemu.kill('SIGKILL');
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`capture: ${out} (${statSync(out).size} o)`);
  } else {
    console.log('pas de capture — journal du monitor:');
    console.log(log.split('\n').slice(-25).join('\n'));
  }
  rmSync(work, { recursive: true, force: true });
})();
