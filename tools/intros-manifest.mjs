// intros-manifest.mjs — (re)generate intros/manifest.json by scanning the (gitignored) intros/ dir.
//
//   node tools/intros-manifest.mjs
//
// intros/ holds third-party demoscene productions (.com / .exe), mounted flat at C:\INTROS\ by
// src/ui.js on boot (so you can `CD INTROS` + run one, or `?run=INTROS\NAME`). This writes a flat
// JSON array of filenames. intros/ is gitignored (third-party binaries are not committed); this
// script + the mount mechanism are. Mirrors tools/games-manifest.mjs.

import { readdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTROS = join(HERE, '..', 'intros');

const files = readdirSync(INTROS)
  .filter((f) => /\.(com|exe)$/i.test(f))
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

writeFileSync(join(INTROS, 'manifest.json'), JSON.stringify(files, null, 0) + '\n');
console.log(`wrote intros/manifest.json — ${files.length} productions: ${files.map((f) => f.replace(/\.(com|exe)$/i, '')).join(', ')}`);
