// run.mjs — run a static i386 Linux program on MIRAGE-LINUX (src/linux.js), from the command line.
//
//   node tools/linux/run.mjs <program> [args...]
//
// Its stdout and stderr go to ours and its exit status becomes ours, so a run compares directly with
// the oracle: `docker run --rm --platform linux/386 -v $PWD:/w i386/debian /w/<program> [args...]`.
// The program's directory is mounted at /w and is the working directory, as with `-v dir:/w -w /w`;
// our stdin is the program's. With MIRAGE_LXROOT=<dir> that directory is the root file system instead
// (a Debian i386 tree from `docker export`), read as the program asks for it, and <program> is a path
// in it: MIRAGE_LXROOT=rootfs node tools/linux/run.mjs /bin/ls -l /etc. MIRAGE_LXCWD sets the
// working directory there. MIRAGE_VGA=cirrus puts a Cirrus CL-GD5446 on the VGA. MIRAGE_CPU (default 686), MIRAGE_LXMEM (MiB of RAM, default 64), MIRAGE_LXTRACE=1 lists the system
// calls that were not answered, MIRAGE_LXWALLCLOCK=1 gives the program the host's clock (benchmarks).
// MIRAGE_LXSHOT=<dir> writes the screen as PNG every MIRAGE_LXSTEP guest seconds (default 10), through
// src/video.js as the browser draws it; MIRAGE_LXSECS stops the run after that many guest seconds —
// for programs that never exit on their own (Quake, DOOM). MIRAGE_LXWAV=<file.wav> records what the
// program played on /dev/dsp, at the rate it set — what a listener would have heard. MIRAGE_LXCOMMIT=<dir>
// writes what a successful run changed in the file tree into <dir> (an OASIS `run` layer).
import { readFileSync, readdirSync, statSync, lstatSync, readlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { installBIOS } from '../../src/bios.js';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/linux/run.mjs <program> [args...]'); process.exit(2); }
const mc = new Machine({ memSize: (Number(process.env.MIRAGE_LXMEM) || 64) << 20, cpu: process.env.MIRAGE_CPU || '686' });
installBIOS(mc);                                   // the PC's devices: the VGA SVGAlib programs, the keyboard
const lx = installLinux(mc, { realTime: !!process.env.MIRAGE_LXWALLCLOCK, onOutput: (fd, b) => (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b)) });
const mount = (dir, at) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f), st = statSync(p);
    if (st.isDirectory()) { lx.mkdir(at + '/' + f); mount(p, at + '/' + f); } else if (st.size < 64 << 20) lx.addFile(at + '/' + f, readFileSync(p));
  }
};
const ROOT = process.env.MIRAGE_LXROOT, SPEC = process.env.MIRAGE_LXROOTSPEC;
if (SPEC) {                                    // an OASIS image's layers (tools/oasis.mjs): several roots, files and links on top
  const { hostOver } = await import('../oasis.mjs');
  const s = JSON.parse(readFileSync(SPEC, 'utf8'));
  lx.host = hostOver({ dirs: s.dirs, files: new Map(s.files), links: new Map(s.links), mkdirs: new Set(s.mkdirs) });
  lx.chdir(process.env.MIRAGE_LXCWD || '/');
} else if (ROOT) {
  const at = (p) => join(ROOT, p);
  lx.host = {
    lstat: (p) => {
      let st; try { st = lstatSync(at(p)); } catch { return null; }
      const meta = { mode: st.mode, mtime: Math.floor(st.mtimeMs / 1000), nlink: st.nlink };
      return st.isSymbolicLink() ? { type: 'link', target: readlinkSync(at(p)), ...meta }
        : st.isDirectory() ? { type: 'dir', ...meta } : { type: 'file', size: st.size, ...meta };
    },
    read: (p) => new Uint8Array(readFileSync(at(p))),
    list: (p) => { try { return readdirSync(at(p)); } catch { return []; } },
  };
  lx.chdir(process.env.MIRAGE_LXCWD || '/');
} else { lx.mkdir('/w'); lx.mkdir('/tmp'); mount(dirname(prog), '/w'); lx.chdir('/w'); }
// The guest's clock starts at the host's present, as the oracle's does (ls -l prints a recent file's
// time and an older one's year); it then runs with the guest's cycles, or the wall clock.
lx.epoch = Math.floor(Date.now() / 1000);
if (!process.stdin.isTTY) { try { lx.stdin = new Uint8Array(readFileSync(0)); } catch { /* no stdin */ } }
const image = ROOT || SPEC ? lx.readFile(prog) : new Uint8Array(readFileSync(prog));
if (!image) { console.error(`mirage-linux: ${prog}: not found under ${ROOT || 'the image'}`); process.exit(127); }
if (process.env.MIRAGE_LXCONSOLE) lx.consoleStdio();   // stdio on /dev/tty1, a virtual console (SVGAlib wants one)
const extraEnv = Object.entries(JSON.parse(process.env.MIRAGE_LXENV || '{}')).map(([k, v]) => `${k}=${v}`);
if (process.env.MIRAGE_LXUSER) { const u = lx.setUser(process.env.MIRAGE_LXUSER); extraEnv.push(`USER=${u}`, `LOGNAME=${u}`); }   // the user's name (oasis run: the host's)
lx.load(image, [ROOT || SPEC ? prog : '/w/' + basename(prog), ...args], ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root', 'LANG=C', ...extraEnv]);
const SEC = 18.2065 * mc.pitBase, SECS = Number(process.env.MIRAGE_LXSECS) || 0;
const LIMIT = SECS ? SECS * SEC : 2e10;
const SHOT = process.env.MIRAGE_LXSHOT, STEP = (Number(process.env.MIRAGE_LXSTEP) || 10) * SEC;
let shoot = null;
if (SHOT) {
  const { mkdirSync } = await import('fs');
  const { Video } = await import('../../src/video.js');
  const { writePNG } = await import('../frame.mjs');
  mkdirSync(SHOT, { recursive: true });
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const v = new Video(mc, canvas); v.font = mc.font;
  let next = STEP;
  shoot = (last = false) => {
    if (!last && mc.cpu.cycles < next) return;
    const t = last ? 'end' : Math.round(next / SEC); if (!last) next += STEP;
    v.frame = 16; v.render();                    // as tools/v86/bootshot.mjs: v.u32 holds the picture
    const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 0xff; rgb[i * 3 + 1] = (p >> 8) & 0xff; rgb[i * 3 + 2] = (p >> 16) & 0xff; }
    writePNG(join(SHOT, `${basename(prog)}-${String(t).padStart(5, '0')}.png`), rgb, W, H, 1);   // and -00end.png when the run ends
    console.error(`mirage-linux: ${t}s ${W}x${H} -> ${SHOT}`);
  };
}
const WAV = process.env.MIRAGE_LXWAV, played = [];
let wavRate = 0;
const record = () => { if (!WAV || !mc.dsp) return; const { rate, samples } = mc.dsp.drain(); if (samples.length) { wavRate = rate; for (const v of samples) played.push(v); } };
while (!lx.done && mc.cpu.cycles < LIMIT) { mc.runSlice(200000); if (shoot) shoot(); record(); }
if (shoot) shoot(true);                         // the screen as the run left it
if (WAV) {
  const { writeFileSync } = await import('fs');
  const n = played.length, b = Buffer.alloc(44 + n * 2), r = wavRate || 11025;
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(r, 24); b.writeUInt32LE(r * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, played[i])), 44 + i * 2);
  writeFileSync(WAV, b); console.error(`mirage-linux: ${(n / 2 / r).toFixed(1)} s of sound at ${r} Hz -> ${WAV}`);
}
if (!lx.done && SECS) { console.error(`mirage-linux: stopped after ${SECS} guest seconds`); process.exit(0); }
if (!lx.done) { console.error('mirage-linux: still running after', LIMIT, 'cycles'); process.exit(124); }
if (lx.signal) {
  const f = lx.faultInfo;
  console.error(`mirage-linux: signal ${lx.signal}` + (f ? ` (exception ${f.n} err ${f.err} at eip ${f.eip.toString(16)}, cr2 ${f.cr2.toString(16)})` : ''));
}
const COMMIT = process.env.MIRAGE_LXCOMMIT;
if (COMMIT && lx.done && !lx.signal && lx.status === 0) {      // an OASIS `run` layer: what the run changed, as a tree
  const { mkdirSync, writeFileSync, symlinkSync, chmodSync, utimesSync, rmSync } = await import('fs');
  const c = lx.changes(), at = (p) => join(COMMIT, p);
  for (const d of c.dirs) { mkdirSync(at(d.path), { recursive: true }); if (d.mode !== undefined) chmodSync(at(d.path), d.mode | 0o700); }
  for (const f of c.files) {
    mkdirSync(dirname(at(f.path)), { recursive: true }); writeFileSync(at(f.path), f.bytes);
    chmodSync(at(f.path), f.mode === undefined ? 0o644 : f.mode | 0o600);
    if (f.mtime) utimesSync(at(f.path), f.mtime, f.mtime);           // make compares them: a built file stays newer than its source
  }
  for (const l of c.links) { mkdirSync(dirname(at(l.path)), { recursive: true }); rmSync(at(l.path), { force: true }); symlinkSync(l.target, at(l.path)); }
  writeFileSync(join(COMMIT, '.oasis-gone'), JSON.stringify(c.removed));
  console.error(`mirage-linux: committed ${c.files.length} files, ${c.dirs.length} directories, ${c.links.length} links, ${c.removed.length} removals -> ${COMMIT}`);
}
if (process.env.MIRAGE_LXTRACE && lx.unimplemented.size) console.error('unanswered system calls:', [...lx.unimplemented].map(([n, c]) => `${n}x${c}`).join(' '));
process.exitCode = lx.status;
