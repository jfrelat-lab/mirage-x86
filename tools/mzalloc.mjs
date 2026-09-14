// mzalloc.mjs — run tools/mzalloc.asm's two builds under MIRAGE and print the same three numbers
// DOSBox-X prints, so the answers line up side by side.
//
//   nasm -f bin tools/mzalloc.asm -o /tmp/MZZERO.EXE
//   nasm -f bin -dMAXALLOC=0xffff tools/mzalloc.asm -o /tmp/MZFULL.EXE
//   node tools/mzalloc.mjs /tmp/MZFULL.EXE /tmp/MZZERO.EXE
//
// Measured on dosbox-x, 2026-09-14:
//
//   maxalloc=FFFF (control)  PSP=0814  PSP0002=9FFF  LARGEST-FREE-PARAS=0000
//   maxalloc=0000 (subject)  PSP=9F91  PSP0002=0000  LARGEST-FREE-PARAS=0000
//
// The control is there because a probe nobody has seen read a KNOWN case right is measuring itself.
// Its three numbers are the ordinary-MZ answers, so when the subject differs, the difference is DOS's
// and not the probe's.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { VFS } = await import(join(ROOT, 'src/vfs.js'));
const { makeMachine } = await import(join(ROOT, 'tools/harness.mjs'));

for (const path of process.argv.slice(2)) {
  const vfs = new VFS();
  const name = path.split('/').pop().toUpperCase();
  const bytes = new Uint8Array(readFileSync(path));
  vfs.addFile('\\' + name, bytes);
  vfs.chdir('\\');
  const { mc, dos } = makeMachine({ vfs });
  // The guest writes through AH=02h (one character) and AH=09h ($-terminated string); capture both
  // rather than relying on a video-memory read, which would also pick up the shell's own output.
  let out = '';
  const h21 = mc.intHandlers[0x21];
  mc.intHandlers[0x21] = (cpu, m) => {
    const ah = (cpu.ax >> 8) & 0xff;
    if (ah === 0x02) out += String.fromCharCode(cpu.dx & 0xff);
    else if (ah === 0x09) {
      let a = (cpu.seg[3] << 4) + (cpu.dx & 0xffff);
      for (let i = 0; i < 256; i++) { const c = m.mem.r8(a + i); if (c === 0x24) break; out += String.fromCharCode(c); }
    }
    return h21(cpu, m);
  };
  dos.load(bytes, '', 'C:\\' + name);
  let b = 0, g = 0;
  while (b < 20_000_000 && !dos.programDone && g++ < 200_000) b += mc.runSlice(2000);
  console.log(`${name.padEnd(12)} ${out.replace(/[\r\n]+/g, ' ').trim() || '(aucune sortie)'}`);
}
