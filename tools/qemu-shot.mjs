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
import { mkdtempSync, copyFileSync, cpSync, existsSync, rmSync, statSync } from 'fs';
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
// `prog` may be a DIRECTORY: a game needs its data files beside it, and a single-file staging could
// only ever capture a self-contained .COM. QSHOT_EXE names the program to run inside it.
let runName = 'PROG.COM';
if (statSync(prog).isDirectory()) {
  if (!process.env.QSHOT_EXE) { console.error('a directory needs QSHOT_EXE=<PROGRAM.EXE>'); process.exit(2); }
  cpSync(prog, work, { recursive: true });
  runName = process.env.QSHOT_EXE;
} else copyFileSync(prog, join(work, 'PROG.COM'));
// QSHOT_DPMI=<path to CWSDPMI.EXE> installs a DPMI host before the program runs. The MS-DOS floppy
// carries neither HIMEM.SYS nor a DPMI host, so an extender that needs one — mesha's PMODE4K wants
// "XMS,DPMI (no RAW,VCPI)" — takes its InitError path and exits to the prompt in milliseconds.
// CWSDPMI is a plain TSR, so it runs off the vvfat drive and nothing has to be written into the image.
const dpmi = process.env.QSHOT_DPMI;
if (dpmi) { if (!existsSync(dpmi)) { console.error(`no CWSDPMI at ${dpmi}`); process.exit(2); }
  copyFileSync(dpmi, join(work, 'CWSDPMI.EXE'));
  // CWSPARAM comes with it and is needed for one documented case: a client that owns all of DOS
  // memory (a .COM does, and mesha's PMODE4K manages it itself) makes CWSDPMI fail its page-table
  // allocation with "could not allocate page table memory". Its own doc says to pre-allocate them
  // with run option flag 2, which only CWSPARAM can set — so ship it and let QSHOT_PRE drive it.
  const param = join(dirname(dpmi), 'CWSPARAM.EXE');
  if (existsSync(param)) copyFileSync(param, join(work, 'CWSPARAM.EXE')); }

// QEMU is bounded by a limit it CANNOT ignore, not only by the kill at the end of this script: if the
// script is interrupted or throws, a plain spawn leaves QEMU reparented to init and spinning forever.
// That is how a DOSBox orphan from this toolbox ran two days at 100% CPU and wrote 266 GB of `LOG:`
// through a stderr redirect. The supervisor can die; the bound must not depend on it.
//
// `ulimit -t`, not `perl -e 'alarm N; exec ...'`. The alarm trick works on dosbox-x, which leaves
// SIGALRM at its default, and does NOT work here: QEMU installs its own SIGALRM handler for its
// timers and swallows it — measured, `alarm 5` and it still ran 21 s and produced a capture. A CPU
// time limit survives exec, cannot be handled away, and ends in SIGKILL. It also targets exactly the
// failure that happened: a process spinning at 100% CPU. An idle one is not the problem.
const HARD_S = Number(process.env.QSHOT_TIMEOUT) || (Number(process.env.QSHOT_BOOT) || 10000) / 1000 + secs + 90;
const qemu = spawn('/bin/sh', ['-c', `ulimit -t ${Math.ceil(HARD_S)}; exec "$@"`, 'sh', QEMU,
  '-m', process.env.QSHOT_MEM || '16', '-fda', floppy, '-boot', 'a',
  '-drive', `file=fat:rw:${work},format=raw,if=ide,index=0`,
  '-display', 'none', '-monitor', 'stdio', '-no-reboot',
], { stdio: ['pipe', 'pipe', 'pipe'] });

// Capped: the monitor is chatty on error and this string is only ever used to print the tail.
let log = '';
const LOG_CAP = 64 * 1024;
const onOut = (b) => { log += b; if (log.length > LOG_CAP) log = log.slice(-LOG_CAP); };
qemu.stdout.on('data', onOut);
qemu.stderr.on('data', onOut);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mon = (cmd) => { qemu.stdin.write(cmd + '\n'); };
// `sendkey` names one key per call; a DOS command line is typed one keystroke at a time.
const type = async (s) => {
  for (const ch of s) {
    // Every character must have a key name. An unmapped one is sent as itself, QEMU rejects it, and
    // the keystroke is silently dropped — "cwsdpmi -p" arrived as "cwsdpmip" and DOS answered "Bad
    // command or file name", which looks exactly like the host failing to install.
    const KEYS = { ':': 'shift-semicolon', '\\': 'backslash', '.': 'dot', ' ': 'spc', '-': 'minus',
                   '_': 'shift-minus', '/': 'slash', '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
                   '5': '5', '6': '6', '7': '7', '8': '8', '9': '9' };
    const k = KEYS[ch] || (/^[a-z]$/i.test(ch) ? ch.toLowerCase() : null);
    if (!k) throw new Error(`qemu-shot: no sendkey name for ${JSON.stringify(ch)}`);
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
  // QSHOT_PRE runs an arbitrary sequence at the prompt before the program: entries separated by ';',
  // where '<ret>' is a bare Enter (for answering an interactive tool's prompts) and '<wait>' pauses.
  // CWSDPMI needs it for a .COM that owns all of conventional memory — see the header note.
  for (const step of (process.env.QSHOT_PRE || '').split(';').filter(Boolean)) {
    if (step === '<ret>') { mon('sendkey ret'); await sleep(400); }
    else if (step === '<wait>') { await sleep(2500); }
    else { await type(step); await sleep(900); }
  }
  if (dpmi) { await type('cwsdpmi -p'); await sleep(2500); }   // -p = stay resident for the next program
  await type(runName.replace(/\.[^.]*$/, ''));
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
