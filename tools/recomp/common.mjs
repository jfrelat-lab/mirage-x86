// common.mjs — what tools/recomp/native.mjs and run.mjs share: where an intro is, the entry state
// and platform constants taken from MIRAGE, the translation (with the volatile immediates a guard
// failure revealed), and the comparison with MIRAGE at the instruction counts the C reports.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { translateCom, Refused } from './x86c.mjs';
import { mirageMachine, beamOf, oracleSnapshot } from './oracle.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT = join(HERE, 'out');

/** intros/<name>.com, or demos/<NAME>.COM (MIRAGE's own, in the repository). */
export function introPath(name) {
  for (const p of [join(ROOT, 'intros', `${name}.com`), join(ROOT, 'intros', `${name.toUpperCase()}.COM`), join(ROOT, 'demos', `${name.toUpperCase()}.COM`)]) if (existsSync(p)) return p;
  throw new Error(`no intro ${name}`);
}

/**
 * The entry state (registers, segments, flags, the low memory and PSP the program finds) and the
 * platform constants: MIRAGE's mode-13h DAC and its 3DAh beam in mode 13h, from a machine whose
 * BIOS has just set mode 13h.
 */
export async function prepare(name) {
  const path = introPath(name);
  const m = await mirageMachine(path);
  // The translator models the CPU MIRAGE gives a DOS program: a Pentium where the SDM leaves a choice
  // (SHLD/SHRD past 16, src/cpu.js shd16).
  if (m.cpu.profile?.p6) throw new Error('MIRAGE runs this machine as a P6: x86c.mjs models the Pentium choices');
  const p = await mirageMachine(path);
  p.cpu.ax = 0x13;
  p.mc.intHandlers[0x10](p.cpu, p.mc);
  const platform = { bcdAX: !!m.cpu.profile?.bcdAdjustsAX, pitBase: p.mc.pitBase, beam: beamOf(p.mc), dac13: Array.from(p.mc.bios.dac.subarray(0, 768)) };
  return { path, com: new Uint8Array(readFileSync(path)), entry: m.entry, platform };
}

/** A program found (by running it) to need the snapshot: why, kept for the next tool. */
export const snapFlag = (name) => join(OUT, `${name}.snapshot-why`);
const volFile = (name) => join(OUT, `${name}.volatile.json`);
export const loadVolatile = (name) => new Set(existsSync(volFile(name)) ? JSON.parse(readFileSync(volFile(name), 'utf8')) : []);
export const saveVolatile = (name, set) => writeFileSync(volFile(name), JSON.stringify([...set].sort((a, b) => a - b)));

/** Translate and write the C (and rc.h) to tools/recomp/out (git-ignored: it embeds the intro). */
export function translate(name, prep, { count = true, structured = true, volatile = loadVolatile(name), tag = '' } = {}) {
  const t0 = performance.now();
  let tr;
  // From the program's entry; or, when that is refused (a packed or self-relocating intro), from a
  // snapshot of MIRAGE's machine just before the first frame point (oracle.mjs oracleSnapshot).
  if (!prep.snapshot && existsSync(snapFlag(name))) { prep.entryRefused = readFileSync(snapFlag(name), 'utf8'); prep.snapshot = oracleSnapshot(prep.path); }
  if (!prep.snapshot) {
    try { tr = translateCom(prep.com, prep.entry, { count, structured, name, volatile, platform: prep.platform }); } catch (e) {
      if (!(e instanceof Refused) || process.env.RC_NOSNAP) throw e;
      prep.entryRefused = e.message;
      prep.snapshot = oracleSnapshot(prep.path);
    }
  }
  if (!tr) {
    const sn = prep.snapshot;
    const state = { reg: sn.reg, regHi: sn.regHi, seg: sn.seg, eip: sn.eip, flags: sn.flags, ftop: sn.fpu.ftop };
    // A handler the program installed before the snapshot (INT 8, 9, 1Ch): the recompiled program
    // gets no interrupt, so it would wait for ever on what the handler counts.
    for (const v of [0x08, 0x09, 0x1c]) for (let k = 0; k < 4; k++) if (sn.mem[v * 4 + k] !== prep.entry.ivt[v * 4 + k]) throw new Refused(`installs an interrupt handler (vector ${v.toString(16)}h): interrupts are not delivered to recompiled code`);
    if (sn.mode !== 0x13 || sn.planar) throw new Refused(`snapshot in video mode ${sn.mode.toString(16)}h${sn.planar ? ' (planar)' : ''}: only mode 13h is modelled`);
    tr = translateCom(prep.com, state, { count, structured, name, volatile, platform: prep.platform, snapshot: sn });
    tr.snapshot = sn.count; tr.entryRefused = prep.entryRefused;
  }
  const ms = performance.now() - t0;
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(join(OUT, '.gitignore'))) writeFileSync(join(OUT, '.gitignore'), '*\n');
  const file = `${name}${count ? '' : '-nc'}${structured ? '' : '-goto'}${tag}.c`;
  writeFileSync(join(OUT, file), tr.c);
  writeFileSync(join(OUT, 'rc.h'), readFileSync(join(HERE, 'rc.h')));
  return { tr, file, ms };
}

/** The addresses a guard reported ("self-modified code at XXXX"). */
export const guardHits = (text) => [...text.matchAll(/self-modified code at ([0-9a-f]{4})/g)].map((x) => parseInt(x[1], 16));
