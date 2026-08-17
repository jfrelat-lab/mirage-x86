// corpus.mjs — enumerate the programs the surveys run over: every game directory and every intro.
//
// Shared so survey-gaps.mjs and survey-ports.mjs cannot drift apart in what they consider "the
// corpus" — the same reason tools/harness.mjs exists. A survey is only as trustworthy as the
// agreement between what it measured and what you think it measured.

import { readdirSync, statSync, existsSync } from 'fs';
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
      // One entry point per game: the biggest .EXE/.COM at the top level is nearly always it.
      // (Nearly — for LOOM it picks the bundled !RAWCOPY.EXE, so read the labels, not just totals.)
      const progs = readdirSync(d).filter((f) => ['.EXE', '.COM'].includes(extname(f).toUpperCase()))
        .map((f) => ({ f, size: statSync(join(d, f)).size }))
        .sort((a, b) => b.size - a.size);
      if (progs.length) out.push({ label: `games/${sub}/${progs[0].f}`, dir: d, mount: '\\', prog: progs[0].f });
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
