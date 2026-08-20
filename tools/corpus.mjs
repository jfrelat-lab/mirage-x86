// corpus.mjs — enumerate the programs the surveys run over: every game directory and every intro.
//
// Shared so survey-gaps.mjs and survey-ports.mjs cannot drift apart in what they consider "the
// corpus" — the same reason tools/harness.mjs exists. A survey is only as trustworthy as the
// agreement between what it measured and what you think it measured.

import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir`, as paths relative to it. */
export function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

/**
 * `mount` is always the root of C:. A title's directory IS the drive, the way `mount c <dir>` gives
 * it to DOSBox and the way the original media was addressed — see VFS.mountAt(). Mounting under
 * \GAMES\<TITLE>\ instead is observable from inside the guest: a program reconstructs paths from
 * argv0, so the mount point ends up in its own state (Jazz Jackrabbit branches on it), and anything
 * hard-coding C:\<file> or scanning the root cannot work at all.
 *
 * @param {string} [filter] match against the game subdirectory name (intros are skipped when set)
 * @returns {{label:string, dir:string, mount:string, prog:string}[]}
 */
export function targets(filter) {
  const out = [];
  const gamesRoot = join(ROOT, 'games');
  if (existsSync(gamesRoot)) {
    for (const sub of readdirSync(gamesRoot)) {
      const d = join(gamesRoot, sub);
      if (!statSync(d).isDirectory()) continue;
      if (filter && !sub.toUpperCase().includes(filter.toUpperCase())) continue;
      const names = readdirSync(d);
      const progs = names.filter((f) => ['.EXE', '.COM'].includes(extname(f).toUpperCase()))
        .map((f) => ({ f, size: statSync(join(d, f)).size }))
        .sort((a, b) => b.size - a.size);
      if (!progs.length) continue;
      // A .BAT beside the game names the entry point; "biggest .EXE" only guesses it, and guessed
      // wrong three times — LOOM's bundled !RAWCOPY.EXE, KEEN1's CATALOG.EXE, and Pinball Fantasies'
      // SETSOUND.EXE, which is the sound-config utility PINBALL.BAT runs BEFORE pf.exe. Comparing an
      // emulator against a reference on the wrong program tells you nothing.
      //
      // Only when the batch names exactly ONE program, though. Arctic Adventure's run.bat is a menu
      // offering four volumes: there is no single answer there, and picking the last one would have
      // swapped a title that already matches the reference for an arbitrary sibling.
      let prog = progs[0].f;
      const bat = names.find((f) => extname(f).toUpperCase() === '.BAT');
      if (bat) {
        const known = new Map(progs.map((p) => [p.f.toUpperCase().replace(/\.(EXE|COM)$/, ''), p.f]));
        const launched = new Set();
        for (const raw of readFileSync(join(d, bat), 'latin1').split(/\r?\n/)) {
          const line = raw.trim().replace(/^@/, '');
          const head = line.split(/\s+/)[0] || '';
          // A CALL is a launcher running its setup first, not the game — Pinball calls setsound.
          if (!line || line.startsWith(':') || /^(echo|cls|if|goto|rem|set|call|choice|pause|exit)$/i.test(head)) continue;
          const hit = known.get(head.toUpperCase().replace(/\.(EXE|COM)$/, ''));
          if (hit) launched.add(hit);
        }
        if (launched.size === 1) prog = [...launched][0];
      }
      out.push({ label: `games/${sub}/${prog}`, dir: d, mount: '\\', prog });
    }
  }
  const introsRoot = join(ROOT, 'intros');
  if (existsSync(introsRoot) && !filter) {
    for (const f of readdirSync(introsRoot).filter((f) => extname(f).toLowerCase() === '.com')) {
      out.push({ label: `intros/${f}`, dir: introsRoot, mount: '\\', prog: f });
    }
  }
  return out;
}
