// games-manifest.mjs — (re)generate games/manifest.json by scanning the (gitignored) games/ dir.
//
//   node tools/games-manifest.mjs
//
// Each DOS game goes in its own subdirectory of games/ (e.g. games/ALLEYCAT/CAT.EXE plus any
// data files). This writes a flat list of "SUBDIR/FILE" paths that src/ui.js mounts at
// C:\GAMES\<subdir>\ on boot, so you can `CD GAMES\<subdir>` and run the game — its relative
// data-file opens then resolve against that directory. games/ is gitignored (third-party
// binaries are not committed); this script + the mount mechanism are.

import { readdirSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAMES = join(HERE, '..', 'games');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let files;
try { files = walk(GAMES); }
catch { console.error('no games/ directory — create games/<GAME>/ and drop the game files in'); process.exit(1); }

const manifest = files
  .map((p) => relative(GAMES, p).split('\\').join('/'))            // POSIX-style relative path
  .filter((f) => f !== 'manifest.json' && !/\.(zip|md)$/i.test(f)) // skip the manifest, archives, notes
  .filter((f) => f.includes('/'))                                  // only files inside a game subdir
  .sort();

writeFileSync(join(GAMES, 'manifest.json'), JSON.stringify(manifest, null, 0) + '\n');
const games = new Set(manifest.map((f) => f.split('/')[0]));
console.log(`wrote games/manifest.json — ${manifest.length} files across ${games.size} game(s): ${[...games].join(', ')}`);
