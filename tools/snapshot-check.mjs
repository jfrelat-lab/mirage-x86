// snapshot-check.mjs — prove tools/snapshot.mjs on a real workload before anything relies on it.
//
//   node tools/snapshot-check.mjs                     # Windows 3.0 `win /r`, warm to block 435000
//   node tools/snapshot-check.mjs games/DOOM DOOM.EXE 200000
//
// A rewind that silently loses state is the most expensive kind of lying instrument: every
// measurement taken after it looks clean and is wrong. So this does not merely capture and restore —
// it runs K blocks, fingerprints, rewinds, runs the SAME K blocks and demands the same fingerprint,
// and it also checks that the fingerprint MOVED over those K blocks, because a signature that never
// changes would make any capture look perfect.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { VFS } = await import(join(ROOT, 'src/vfs.js'));
const { makeMachine } = await import(join(ROOT, 'tools/harness.mjs'));
const { walk } = await import(join(ROOT, 'tools/corpus.mjs'));
const { capture, restore, verify, signature } = await import(join(ROOT, 'tools/snapshot.mjs'));

const dir = process.argv[2] || 'boot/WIN30';
const prog = process.argv[3] || 'WIN.COM';
const warm = Number(process.argv[4] || 435000);
const K = Number(process.argv[5] || 20000);
// WIN.COM without /r exits immediately, which would make the warm-up free and the check vacuous.
const tail = process.env.TAIL !== undefined ? process.env.TAIL : (prog.toUpperCase() === 'WIN.COM' ? ' /r' : '');

const tree = join(ROOT, dir);
const vfs = new VFS();
for (const rel of walk(tree)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(tree, rel))));
vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });

console.log(`charge ${dir}/${prog}${tail ? ' "' + tail.trim() + '"' : ''}, chauffe jusqu a ${warm} blocs`);
dos.load(new Uint8Array(readFileSync(join(tree, prog))), tail, 'C:\\' + prog);
const t0 = Date.now();
let b = 0, g = 0;
while (b < warm && !dos.programDone && !mc.cpu.halted && g++ < 2_000_000) b += mc.runSlice(500);
const warmMs = Date.now() - t0;
console.log(`  ${b} blocs en ${(warmMs / 1000).toFixed(1)}s  (c est ce cout que le rembobinage supprime)`);
// A warm-up that ends instantly has not run the workload: say where it stopped rather than let the
// rest of the check pass on a program that exited or is waiting for input.
console.log(`  etat: programDone=${dos.programDone} halted=${mc.cpu.halted} blocked=${mc.blocked}` +
  ` CS:IP=${mc.cpu.seg[1].toString(16)}:${(mc.cpu.eip & 0xffff).toString(16)}` +
  `  (${(b / Math.max(warmMs, 1) * 1000 / 1000).toFixed(0)}k blocs/s)`);
if (warmMs < 2000 && warm > 100000) {
  console.log('  ⚠️ la chauffe a ete instantanee pour un budget de blocs eleve : le compteur de blocs');
  console.log('     et le travail reellement execute ne coincident pas. Verifier avant de conclure.');
}

const tc = Date.now();
const snap = capture(mc);
console.log(`capture: ${(Date.now() - tc)} ms, ${snap.skipped.length} element(s) ignore(s)` +
  `${snap.skipped.length ? ': ' + snap.skipped.slice(0, 4).join(', ') : ''}`);

const tr = Date.now();
restore(mc, snap);
const restoreMs = Date.now() - tr;
console.log(`restauration: ${restoreMs} ms`);

const v = verify(mc, K);
console.log('');
console.log(`controle positif  — la signature bouge sur ${K} blocs : ${v.moved ? 'OUI' : 'NON (le test ne prouve rien)'}`);
console.log(`capture exacte    — restaurer redonne l etat capture : ${v.restoredExact ? 'OUI' : 'NON'}`);
console.log(`rejeu identique   — les memes ${K} blocs redonnent le meme etat : ${v.replayMatches ? 'OUI' : 'NON'}`);
console.log(`  ${v.detail}`);
console.log('');
if (v.ok) {
  const saved = (warmMs / Math.max(restoreMs, 1));
  console.log(`VERDICT: le rembobinage est fidele. Une sonde repart de ce point en ${restoreMs} ms`
    + ` au lieu de ${(warmMs / 1000).toFixed(1)}s — ${saved.toFixed(0)}x.`);
} else {
  console.log('VERDICT: NON FIDELE — ne rien construire dessus.');
  console.log('  Une divergence ici veut dire qu un etat mutable a echappe a la capture :');
  console.log('  typiquement une variable de fermeture, que le parcours generique ne peut pas voir.');
  process.exit(1);
}
