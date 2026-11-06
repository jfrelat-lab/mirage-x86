// compat-shots.mjs — the pictures of docs/COMPATIBILITY.md: each DOS title of tools/compat-shots.json
// run headless and drawn by src/video.js, the browser's own renderer (text in the VGA ROM font, CGA,
// EGA, Mode X, VESA), at the moments the list names, with the keys it names in between.
//
//   node tools/compat-shots.mjs [outdir=/tmp/compat-shots] [id ...]
//
// The entries, their keys and their times are described in tools/compat-entry.mjs.
// Writes <outdir>/<id>-<name>.png at the frame's own size, and prints one line per picture.
import { mkdirSync } from 'fs';
import { openEntry, loadList } from './compat-entry.mjs';
import { writePNG } from './frame.mjs';

const [outdir = '/tmp/compat-shots', ...only] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const list = loadList().filter((e) => !only.length || only.includes(e.id));

for (const e of list) {
  const run = await openEntry(e), { mc, dos } = run;
  for (const [t, name] of e.shots) {
    run.runTo(t);
    run.video.frame = 16;                             // the text cursor and blinking attributes shown
    const { rgb, W, H } = run.frame();
    writePNG(`${outdir}/${e.id}-${name}.png`, rgb, W, H, 1);
    console.log(`${e.id}-${name}: ${t} s, mode ${mc.mem.u8[0x449].toString(16)}h ${W}x${H}${run.fault ? ' FAULT ' + String(run.fault.message).slice(0, 120) : dos.programDone ? ' (ended)' : ''}`);
    if (run.fault || dos.programDone) break;
  }
}
