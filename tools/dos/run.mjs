// run.mjs — run a DOS program on MIRAGE-DOS from the command line, as tools/linux/run.mjs does a
// Linux one: what it prints through DOS goes to our stdout, our stdin is its keyboard, and its
// return code (INT 21h AH=4Ch's AL) becomes our exit status.
//
//   node tools/dos/run.mjs <PROG.EXE|PROG.COM> [args...]
//
// The program's directory is the root of C: (`mount c <dir>`, the drive a program shipped expecting;
// argv0 is C:\PROG.EXE) and the current directory. Output is DOS's own bytes, CR LF included.
// Text a program writes straight to video memory or through INT 10h never reaches DOS: with
// MIRAGE_DOSSCREEN=1 the final text screen is printed (to stderr) as well.
// MIRAGE_CPU (default 586), MIRAGE_DOSMEM (MiB, the player's machine), MIRAGE_DOSCYCLES (cap, 2e10).
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { VFS } from '../../src/vfs.js';
import { makeMachine } from '../harness.mjs';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/dos/run.mjs <program> [args...]'); process.exit(2); }

const vfs = new VFS();
const root = dirname(prog);
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 64 << 20) vfs.addFile('\\' + relative(root, p).split('/').join('\\').toUpperCase(), new Uint8Array(readFileSync(p)));
  }
};
walk(root);
vfs.chdir('\\');

const { mc, dos } = makeMachine({ vfs, cpu: process.env.MIRAGE_CPU || '586', ...(process.env.MIRAGE_DOSMEM ? { mem: Number(process.env.MIRAGE_DOSMEM) } : {}) });
let fault = null; mc.onError = (e) => { fault = e; };
const outBuf = [];
dos.onPrint = (ch) => { outBuf.push(ch & 0xff); if (outBuf.length >= 4096) flush(); };
const flush = () => { if (outBuf.length) { process.stdout.write(Buffer.from(outBuf)); outBuf.length = 0; } };

// Our stdin, typed on its keyboard: LF becomes Enter. It is TYPED, not redirected: DOS echoes a line
// read with AH=0Ah as it would at the keyboard, where `prog < file` would not. When it runs out, a program waiting for a key
// has nothing more coming, and the run ends.
let input = [];
if (!process.stdin.isTTY) { try { input = [...readFileSync(0)]; } catch { /* none */ } }
const typeNext = () => {
  const c = input.shift();
  if (c === undefined) return false;
  mc.keyQueue.push(c === 10 ? { scan: 0x1c, ascii: 13 } : { scan: 0, ascii: c });
  return true;
};

const tail = args.length ? ' ' + args.join(' ') : '';
dos.load(new Uint8Array(readFileSync(prog)), tail, 'C:\\' + basename(prog).toUpperCase());
const LIMIT = Number(process.env.MIRAGE_DOSCYCLES) || 2e10;
let why = '';
while (!dos.programDone && !fault) {
  mc.runSlice(200000);
  if (mc.blocked && mc.keyQueue.length === 0 && !typeNext()) { why = 'waiting for a key, and stdin is done'; break; }
  if (mc.cpu.cycles > LIMIT) { why = `still running after ${LIMIT} cycles`; break; }
}
flush();

if (process.env.MIRAGE_DOSSCREEN) {
  const cols = mc.mem.r16(0x44a) || 80, rows = (mc.mem.r8(0x484) || 24) + 1, lines = [];
  for (let r = 0; r < rows; r++) {
    let s = ''; for (let c = 0; c < cols; c++) s += String.fromCharCode(mc.mem.u8[0xb8000 + (r * cols + c) * 2] || 32);
    lines.push(s.trimEnd());
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  process.stderr.write('---- screen ----\n' + lines.join('\n') + '\n');
}
if (fault) { console.error('mirage-dos:', String(fault.message || fault).split('\n')[0]); process.exitCode = 125; }
else if (!dos.programDone) { console.error('mirage-dos:', why); process.exitCode = 124; }
else process.exitCode = dos.exitCode;
