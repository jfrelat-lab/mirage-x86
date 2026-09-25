// Text-mode twin of tools/dosdiff.js: the B800 page of a .COM after K timer ticks, DOSBox-X vs MIRAGE,
// cell by cell (character and attribute).   node textdiff.mjs <prog.com> [ticks]
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const prog = process.argv[2], K = Number(process.argv[3]) || 36;
const work = mkdtempSync(join(tmpdir(), 'td-'));
execSync(`/opt/homebrew/bin/nasm -f bin -DTEXT -dKTICKS=${K} ${ROOT}/tools/grabber.asm -o ${work}/GRABBER.COM`);
copyFileSync(prog, join(work, 'PROG.COM'));
writeFileSync(join(work, 'db.conf'), `[sdl]\noutput=surface\nautolock=false\n[log]\nlogfile=\n[cpu]\ncore=normal\ncputype=pentium\ncycles=max\n[autoexec]\nmount c ${work}\nc:\nGRABBER.COM\nPROG.COM\n`);
const alarm = Math.max(7, Math.ceil(K / 18.2065 * 2) + 5);
try { execSync(`SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy perl -e 'alarm ${alarm}; exec @ARGV' /opt/homebrew/bin/dosbox-x -conf ${work}/db.conf -nomenu -fastlaunch -exit`, { stdio: 'ignore', timeout: (alarm + 5) * 1000 }); } catch { /* alarm */ }
const dbx = existsSync(join(work, 'OUT.BIN')) ? new Uint8Array(readFileSync(join(work, 'OUT.BIN'))) : null;
rmSync(work, { recursive: true, force: true });
if (!dbx || dbx.length < 4000) { console.log('DOSBox-X: no capture'); process.exit(1); }
const { mc, dos } = makeMachine();
dos.load(new Uint8Array(readFileSync(prog)), '', 'C:\\PROG.COM');
let ticks = 0, guard = 0; const tt = mc.tickTimer.bind(mc); mc.tickTimer = () => { ticks++; return tt(); };
while (ticks < K && !dos.programDone && guard++ < 4_000_000) mc.runSlice(2048);
const mir = mc.mem.u8.slice(0xb8000, 0xb8000 + 4000);
let dc = 0, da = 0; const attrs = new Map();
for (let i = 0; i < 2000; i++) {
  if (dbx[i * 2] !== mir[i * 2]) dc++;
  if (dbx[i * 2 + 1] !== mir[i * 2 + 1]) { da++; const k = `${dbx[i * 2 + 1].toString(16)}->${mir[i * 2 + 1].toString(16)}`; attrs.set(k, (attrs.get(k) || 0) + 1); }
}
const hist = (b) => { const m = new Map(); for (let i = 0; i < 2000; i++) m.set(b[i * 2 + 1], (m.get(b[i * 2 + 1]) || 0) + 1); return [...m].sort((a, c) => c[1] - a[1]).slice(0, 6).map(([a, n]) => `${a.toString(16)}:${n}`).join(' '); };
console.log(`${prog.split('/').pop()} @${K} ticks: ${dc} chars, ${da} attributes differ of 2000 cells`);
console.log(`  attributes DOSBox-X ${hist(dbx)}\n  attributes MIRAGE   ${hist(mir)}`);
if (da) console.log('  attr pairs (dbx->mirage):', [...attrs].slice(0, 8).map(([k, n]) => `${k} x${n}`).join(', '));
