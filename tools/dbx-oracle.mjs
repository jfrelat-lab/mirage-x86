// dbx-oracle.mjs — diff MIRAGE's DOS/BIOS behaviour against DOSBox-X's own debug log.
//
// Not to be confused with dos-oracle.mjs, which records INT 21h in/out registers from a REAL DOS
// kernel booted on our BIOS. That one is the authority on what a call RETURNS; this one is the
// authority on the SEQUENCE a real program produces.
//
// DOSBox-X's `-debug -log-fileio` prints, for every program it runs, which files were opened, read,
// sought and closed, and every video mode set. That is an EXTERNAL reference for a layer the
// instruction-level co-simulator cannot reach: the co-sim proves the CPU executes correctly, and
// says nothing about whether DOS handed the program the right bytes.
//
// Both sides are normalised to the same event vocabulary and compared as a PREFIX: DOSBox is killed
// from outside and MIRAGE stops on its own budget, so the streams have different lengths and only
// the common prefix is meaningful. The first index where they disagree is the localisation.
//
// File I/O and video are compared as SEPARATE channels. They are independent subsystems, and their
// relative order is not something either emulator promises — interleaving them into one sequence
// reported a divergence for Keen 1 that was only "the mode was set a few opens later".
//
//   node tools/dbx-oracle.mjs games/DOOM DOOM.EXE          one title (log must already exist)
//   node tools/dbx-oracle.mjs --capture games/DOOM DOOM.EXE
//   node tools/dbx-oracle.mjs --sweep [filter]             the whole corpus, one line each
//   --strict   also compare byte counts and seek offsets, not just which files are touched
//
// The comparison ENDS wherever MIRAGE offers a service DOSBox does not. DOSBox answers no DPMI host
// on INT 2Fh AX=1687, so Jazz loads its bundled DPMI.000; we answer, so Jazz skips straight to
// RTM.000. Neither side is wrong and the streams part company there for good.
//
// Read sizes differ legitimately: DOSBox's EXEC reads the image through its own buffering, MIRAGE's
// loader reads it straight out of the VFS. Hence the default granularity is file-level, and --strict
// is for when you are already chasing one file.

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';
import { walk, targets, ROOT } from './corpus.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const CAPTURE = flag('--capture');
const STRICT = flag('--strict');
const SWEEP = flag('--sweep');
const SECS = Number(process.env.SECS) || 30;
// A sweep is a SCREEN, not an investigation: the first divergence is within the opening events for
// every title that has one, so a per-title budget in the hundreds of milliseconds finds the same
// answer as one in seconds. Raise it with WALL/CYCLES when drilling into a single title.
const WALL = Number(process.env.WALL) || (SWEEP ? 1200 : 6000);
const CYCLES = Number(process.env.CYCLES) || (SWEEP ? 4e7 : 3e8);
const CACHE = join(ROOT, '.dbxlogs');

const norm = (p) => basename(String(p).replace(/\\/g, '/').trim()).toUpperCase();
// Character devices are not files: their "byte count" is however much text the program chose to
// print, which legitimately differs (a free-memory figure, a version string). Compare that a write
// happened, never how long it was.
const DEVICE = /^(CON|AUX|PRN|NUL|CLOCK\$|EMMXXXX0)$/;
const strictFor = (file) => STRICT && !DEVICE.test(file);

// ---------------------------------------------------------------- the DOSBox side

/** Capture a log for one target, unless a cached one is already there. */
function dosboxLog(dir, prog, force) {
  if (!existsSync(CACHE)) mkdirSync(CACHE);
  const out = join(CACHE, `${basename(dir)}-${prog}.log`);
  if (force || !existsSync(out)) {
    execFileSync(join(ROOT, 'tools', 'dbxlog.sh'), [dir, prog, String(SECS), out], { stdio: 'ignore' });
  }
  return existsSync(out) ? readFileSync(out, 'latin1') : null;
}

/**
 * Parse a DOSBox-X debug log into events, starting at the moment it EXECs `prog`. Everything before
 * that is the shell running AUTOEXEC.BAT and MOUNT.COM, which MIRAGE has no equivalent of.
 */
function parseDosbox(text, prog) {
  const ev = { file: [], video: [], int21: [] };
  let started = false;
  // DOSBox's EXEC reads the image through INT 21h, so its loader shows up as open/read/seek/close on
  // the program file. MIRAGE's loader reads the VFS directly and emits nothing. Drop that block —
  // from the exec up to and including the matching close — on the DOSBox side.
  let loading = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[0-9: .]*(DEBUG )?/, '');
    let m;
    if ((m = line.match(/^EXEC:Execute (.+?) \d+$/))) {
      const n = norm(m[1]);
      if (n === norm(prog)) { started = true; ev.file.push(`exec ${n}`); }
      else if (started) ev.file.push(`exec ${n}`);
      if (started) loading = n;
      continue;
    }
    if (!started) continue;
    let kind = null, file = null, extra = '';
    if ((m = line.match(/^FILES:file open command (\d+) file (.+)$/))) { kind = 'open'; file = m[2]; }
    else if ((m = line.match(/^FILES:Closing file (.+)$/))) { kind = 'close'; file = m[1]; }
    else if ((m = line.match(/^FILES:Reading (\d+) bytes from (.+?)\s*$/))) { kind = 'read'; file = m[2]; extra = m[1]; }
    else if ((m = line.match(/^FILES:Writing (\d+) bytes to (.+?)\s*$/))) { kind = 'write'; file = m[2]; extra = m[1]; }
    else if ((m = line.match(/^FILES:Seeking to (-?\d+) bytes from position type \((\d)\) in (.+?)\s*$/)))
      { kind = 'seek'; file = m[3]; extra = `${m[1]} ${m[2]}`; }
    // DOSBox prints the mode in HEX and unprefixed, so "Set Video Mode D" is 0Dh, not 13.
    else if ((m = line.match(/^INT10:Set Video Mode ([0-9A-Fa-f]+)$/))) { ev.video.push(`mode ${parseInt(m[1], 16).toString(16)}`); continue; }
    // Only AH. AL is whatever the register happened to hold for functions that do not take it, so
    // comparing it reports differences that mean nothing.
    // DOSBox prints AH unpadded ("ah=e"), so pad both sides or every single-digit function reads
    // as a divergence.
    else if ((m = line.match(/^DOSMISC:Executing interrupt 21, ah=([0-9a-f]+)/))) { ev.int21.push(m[1].padStart(2, '0')); continue; }
    if (!kind) continue;
    file = norm(file);
    if (loading) {
      if (file === loading) { if (kind === 'close') loading = null; continue; }
      loading = null;                  // the loader is done; anything else belongs to the program
    }
    ev.file.push(strictFor(file) && extra ? `${kind} ${file} ${extra}` : `${kind} ${file}`);
  }
  return ev;
}

// ---------------------------------------------------------------- the MIRAGE side

function runMirage(dir, prog, { wall = WALL, cycles = CYCLES } = {}) {
  // The game directory IS the root of C:, which is what `mount c games/X` gives DOSBox — the same
  // view src/shell.js and the other tools now use. See VFS.mountAt().
  const vfs = new VFS();
  const mount = '\\';
  for (const rel of walk(dir)) {
    vfs.addFile(mount + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(dir, rel))));
  }
  vfs.chdir('\\');

  const { mc, dos } = makeMachine({ vfs });
  const cpu = mc.cpu;
  const ev = { file: [], video: [], int21: [] };
  let fault = null; mc.onError = (e) => { fault = e; };

  const asciiz = (lin) => {
    let s = '';
    for (let i = 0; i < 128; i++) { const b = mc.mem.u8[(lin + i) & 0xfffff]; if (!b) break; s += String.fromCharCode(b); }
    return s;
  };
  const nameOf = (fd) => {
    const h = vfs.handles.get(fd & 0xffff);
    if (h) return norm(h.path);
    return ({ 0: 'CON', 1: 'CON', 2: 'CON', 3: 'AUX', 4: 'PRN' })[fd & 0xffff] || `FD${fd & 0xffff}`;
  };

  const int21 = mc.intHandlers[0x21];
  mc.intHandlers[0x21] = (c, m) => {
    const ah = c.ax >> 8, dsdx = (c.seg[3] << 4) + (c.reg[2] & 0xffff);
    ev.int21.push(ah.toString(16).padStart(2, '0'));
    // Names must be read BEFORE the call for open/exec (the handler may clobber DS:DX) and handle
    // names BEFORE close (the handle is gone afterwards).
    let pre = null;
    if (ah === 0x4b) pre = `exec ${norm(asciiz(dsdx))}`;
    else if (ah === 0x3c || ah === 0x3d) pre = `open ${norm(asciiz(dsdx))}`;
    else if (ah === 0x3e) pre = `close ${nameOf(c.reg[3])}`;
    else if (ah === 0x3f) { const f = nameOf(c.reg[3]); pre = strictFor(f) ? `read ${f} ${c.reg[1] & 0xffff}` : `read ${f}`; }
    else if (ah === 0x40) { const f = nameOf(c.reg[3]); pre = strictFor(f) ? `write ${f} ${c.reg[1] & 0xffff}` : `write ${f}`; }
    else if (ah === 0x42) {
      const f = nameOf(c.reg[3]), off = ((c.reg[1] & 0xffff) << 16) | (c.reg[2] & 0xffff);
      pre = strictFor(f) ? `seek ${f} ${off | 0} ${c.ax & 0xff}` : `seek ${f}`;
    }
    const r = int21(c, m);
    // An open that FAILED opened nothing: DOSBox logs the line only on success, so a failed open on
    // our side must not appear either, or every miss shifts the whole stream by one.
    if (pre && !((ah === 0x3c || ah === 0x3d) && (c.flags & 1))) ev.file.push(pre);
    return r;
  };

  const int10 = mc.intHandlers[0x10];
  mc.intHandlers[0x10] = (c, m) => {
    if ((c.ax >> 8) === 0x00) ev.video.push(`mode ${(c.ax & 0x7f).toString(16)}`);
    return int10(c, m);
  };

  ev.file.push(`exec ${norm(prog)}`);      // dos.load bypasses INT 21h AH=4Bh, so state it explicitly
  try { dos.load(new Uint8Array(readFileSync(join(dir, prog))), '', 'C:' + mount + prog); }
  catch (e) { return { ev, stop: 'chargement impossible: ' + e.message }; }

  const t0 = Date.now();
  while (!fault && !dos.programDone) {
    mc.runSlice(2000);
    mc.tickTimer();
    if (cpu.cycles > cycles || Date.now() - t0 > wall) break;
  }
  return {
    ev,
    stop: fault ? 'FAUTE ' + fault.message : dos.programDone ? 'programme termine' : 'toujours en cours',
    mcycles: cpu.cycles / 1e6,
  };
}

// ---------------------------------------------------------------- comparison

const CHANNELS = ['file', 'video', 'int21'];

/** Index of the first disagreement, or -1 when one stream is a prefix of the other. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function compare(dir, prog, opts = {}) {
  const text = dosboxLog(dir, prog, CAPTURE);
  if (!text) return { err: 'pas de journal DOSBox' };
  const ref = parseDosbox(text, prog);
  if (!ref.file.length) return { err: `DOSBox n a jamais execute ${prog}` };
  const mine = runMirage(dir, prog, opts);
  const at = {};
  for (const ch of CHANNELS) at[ch] = firstDiff(ref[ch], mine.ev[ch]);
  return { ref, ...mine, at };
}

// ---------------------------------------------------------------- entry points

if (SWEEP) {
  const filter = argv[0];
  console.log('cible                          fichiers(dbx/mir/ok)   video   verdict');
  for (const t of targets(filter)) {
    if (!t.label.startsWith('games/')) continue;
    const r = compare(t.dir, t.prog);
    const name = `${basename(t.dir)}/${t.prog}`.padEnd(30);
    if (r.err) { console.log(`${name} ${r.err}`); continue; }
    const okOf = (ch) => r.at[ch] < 0 ? Math.min(r.ref[ch].length, r.ev[ch].length) : r.at[ch];
    const bad = CHANNELS.filter((ch) => r.at[ch] >= 0);
    const verdict = bad.length
      ? bad.map((ch) => `${ch}#${r.at[ch]}: dbx="${r.ref[ch][r.at[ch]]}" mir="${r.ev[ch][r.at[ch]] ?? '(fin)'}"`).join('  |  ')
      : 'prefixe exact';
    console.log(`${name} ${String(r.ref.file.length).padStart(5)}/${String(r.ev.file.length).padStart(5)}/` +
      `${String(okOf('file')).padStart(5)}  ${String(okOf('video')).padStart(5)}   ${verdict}`);
  }
} else {
  const dir = argv[0], prog = argv[1];
  if (!dir || !prog) { console.error('usage: dbx-oracle.mjs [--capture] [--strict] <dir> <prog>  |  --sweep [filtre]'); process.exit(1); }
  const r = compare(dir, prog);
  if (r.err) { console.error(r.err); process.exit(1); }
  console.log(`=== ${dir}/${prog} ===`);
  console.log(`arret MIRAGE: ${r.stop} (${r.mcycles?.toFixed(1)} Mcycles)\n`);
  for (const ch of CHANNELS) {
    const a = r.ref[ch], b = r.ev[ch], at = r.at[ch];
    console.log(`--- canal ${ch}: DOSBox ${a.length}, MIRAGE ${b.length} evenements`);
    if (!a.length && !b.length) { console.log('    (vide des deux cotes)\n'); continue; }
    if (at < 0) { console.log(`    aucune divergence sur les ${Math.min(a.length, b.length)} evenements communs.\n`); continue; }
    console.log(`    premiere divergence a #${at} :`);
    for (let i = Math.max(0, at - 6); i < Math.min(Math.max(a.length, b.length), at + 7); i++) {
      console.log(`  ${String(i).padStart(4)}  DOSBox ${(a[i] ?? '(fin)').padEnd(34)} MIRAGE ${b[i] ?? '(fin)'}${i === at ? ' <<<' : ''}`);
    }
    console.log('');
  }
}
