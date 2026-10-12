// run.mjs — run a static i386 Linux program on MIRAGE-LINUX (src/linux.js), from the command line.
//
//   node tools/linux/run.mjs <program> [args...]
//
// Its stdout and stderr go to ours and its exit status becomes ours, so a run compares directly with
// the oracle: `docker run --rm --platform linux/386 -v $PWD:/w i386/debian /w/<program> [args...]`.
// The program's directory is mounted at /w and is the working directory, as with `-v dir:/w -w /w`;
// our stdin is the program's. MIRAGE_CPU (default 686), MIRAGE_LXMEM (MiB of RAM, default 64), MIRAGE_LXTRACE=1 lists the system
// calls that were not answered, MIRAGE_LXWALLCLOCK=1 gives the program the host's clock (benchmarks).
import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/linux/run.mjs <program> [args...]'); process.exit(2); }
const mc = new Machine({ memSize: (Number(process.env.MIRAGE_LXMEM) || 64) << 20, cpu: process.env.MIRAGE_CPU || '686' });
const lx = installLinux(mc, { realTime: !!process.env.MIRAGE_LXWALLCLOCK, onOutput: (fd, b) => (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b)) });
const mount = (dir, at) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f), st = statSync(p);
    if (st.isDirectory()) { lx.mkdir(at + '/' + f); mount(p, at + '/' + f); } else if (st.size < 64 << 20) lx.addFile(at + '/' + f, readFileSync(p));
  }
};
lx.mkdir('/w'); lx.mkdir('/tmp'); mount(dirname(prog), '/w'); lx.chdir('/w');
if (!process.stdin.isTTY) { try { lx.stdin = new Uint8Array(readFileSync(0)); } catch { /* no stdin */ } }
lx.load(new Uint8Array(readFileSync(prog)), ['/w/' + basename(prog), ...args], ['PATH=/usr/bin:/bin', 'HOME=/root']);
const LIMIT = 2e10;
while (!lx.done && mc.cpu.cycles < LIMIT) mc.runSlice(200000);
if (!lx.done) { console.error('mirage-linux: still running after', LIMIT, 'cycles'); process.exit(124); }
if (lx.signal) {
  const f = lx.faultInfo;
  console.error(`mirage-linux: signal ${lx.signal}` + (f ? ` (exception ${f.n} err ${f.err} at eip ${f.eip.toString(16)}, cr2 ${f.cr2.toString(16)})` : ''));
}
if (process.env.MIRAGE_LXTRACE && lx.unimplemented.size) console.error('unanswered system calls:', [...lx.unimplemented].map(([n, c]) => `${n}x${c}`).join(' '));
process.exitCode = lx.status;
