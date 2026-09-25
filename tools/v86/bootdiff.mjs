// A boot-sector image under DOSBox-X (grabber + bootcom) vs MIRAGE (booted), after K timer ticks.
// Mode 13h: A000 + DAC. Mode 4/5/6: B800 (the grabber with -DTEXT dumps 4000 bytes, so CGA uses
// -DCGA: 16000 bytes).      node bootdiff.mjs <img> [ticks] [13|cga]
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, ''), S = ROOT + '/tools/v86';
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const img = process.argv[2], K = Number(process.argv[3]) || 36, kind = process.argv[4] || '13';
const cga = kind === 'cga', LEN = cga ? 16000 : 64000;
let bytes = new Uint8Array(readFileSync(img));
if (bytes.length < 1474560) { const p = new Uint8Array(1474560); p.set(bytes); bytes = p; }
const work = mkdtempSync(join(tmpdir(), 'bd-'));
writeFileSync(join(work, 'FLOPPY.IMG'), bytes);
execSync(`/opt/homebrew/bin/nasm -f bin ${cga ? '-DCGA' : ''} -dKTICKS=${K} ${ROOT}/tools/grabber.asm -o ${work}/GRABBER.COM`);
execSync(`/opt/homebrew/bin/nasm -f bin ${S}/bootcom.asm -o ${work}/BOOTCOM.COM`);
writeFileSync(join(work, 'db.conf'), `[sdl]\noutput=surface\nautolock=false\n[log]\nlogfile=\n[dosbox]\nmachine=svga_s3\n[cpu]\ncore=normal\ncputype=pentium\ncycles=max\n[autoexec]\nmount c ${work}\nimgmount a ${work}/FLOPPY.IMG -t floppy\nc:\nGRABBER.COM\nBOOTCOM.COM\n`);
const alarm = Math.max(8, Math.ceil(K / 18.2065 * 2) + 6);
try { execSync(`SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy perl -e 'alarm ${alarm}; exec @ARGV' /opt/homebrew/bin/dosbox-x -conf ${work}/db.conf -nomenu -fastlaunch -exit`, { stdio: 'ignore', timeout: (alarm + 5) * 1000 }); } catch { /* alarm */ }
const out = join(work, 'OUT.BIN');
const dbx = existsSync(out) ? new Uint8Array(readFileSync(out)) : null;
const dpal = existsSync(join(work, 'PAL.BIN')) ? new Uint8Array(readFileSync(join(work, 'PAL.BIN'))) : null;
rmSync(work, { recursive: true, force: true });
if (!dbx || dbx.length < LEN) { console.log(`${img.split('/').pop()}: DOSBox-X no capture (${dbx ? dbx.length : 0} bytes)`); process.exit(1); }
const { mc } = makeMachine({ dos: false });
mc.disk.attach(0x00, bytes);
bootSector(mc, bytes, { drive: 0 });
let ticks = 0, guard = 0; const tt = mc.tickTimer.bind(mc); mc.tickTimer = () => { ticks++; return tt(); };
while (ticks < K && guard++ < 4_000_000) { mc.runSlice(2048); if (mc.timerAuto === false) mc.tickTimer(); }
const base = cga ? 0xb8000 : 0xa0000, mir = mc.mem.u8.slice(base, base + LEN);
let d = 0; for (let i = 0; i < LEN; i++) if (dbx[i] !== mir[i]) d++;
let pd = 0; if (!cga && dpal) for (let i = 0; i < 768; i++) if ((dpal[i] & 63) !== (mc.bios.dac[i] & 63)) pd++;
const nz = (a) => a.reduce((n, v) => n + (v ? 1 : 0), 0);
console.log(`${img.split('/').pop().padEnd(16)} @${K} ticks: ${d} of ${LEN} bytes differ; non-zero DOSBox-X ${nz(dbx.subarray(0, LEN))} MIRAGE ${nz(mir)}${cga ? '' : `; DAC entries differing ${pd}/768`}  [mode ${mc.mem.u8[0x449].toString(16)}h, ${ticks} ticks]`);
writeFileSync(`/tmp/bd_${img.split('/').pop()}.dbx`, dbx.subarray(0, LEN)); writeFileSync(`/tmp/bd_${img.split('/').pop()}.mir`, mir);
