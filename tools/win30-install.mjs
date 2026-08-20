// win30-install.mjs — build a runnable Windows 3.0 REAL-MODE tree out of the four install floppies,
// without running SETUP.
//
// The files are SZDD-compressed — Microsoft's LZSS — even though the names carry no trailing
// underscore, which is the convention that made me assume otherwise at first. WIN.CNF starts with
// the literal bytes "SZDD". So expanding is part of the job; EXPAND.EXE on disk 2 is the period tool
// and this is the same format.
//
// Beyond that the three pieces SETUP would assemble are on the disks in plain sight:
//   WIN.COM    = WIN.CNF + <logo>.LGO + <logo>.RLE, concatenated in that order
//   SYSTEM.INI = SYSTEM.SRC   WIN.INI = WIN.SRC
// So the whole install is a copy plus one concatenation. Automating SETUP's dialogs through DOSBox
// AUTOTYPE would take longer and tell us nothing we want to know.
//
//   node tools/win30-install.mjs [outDir=boot/WIN30]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readImage } from './fat12.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(ROOT, 'boot', 'WIN30');
mkdirSync(out, { recursive: true });

/**
 * Expand one SZDD stream. 14-byte header: 8 magic, mode 'A', the character stripped from the name,
 * then the expanded length. The body is LZSS over a 4096-byte ring pre-filled with spaces, the
 * window starting 16 bytes from its end — an emitted byte goes to the ring as well as the output.
 */
function expandSZDD(buf) {
  const magic = [0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33];
  if (buf.length < 14 || !magic.every((b, i) => buf[i] === b)) return buf;   // not compressed
  const out = Buffer.alloc(buf[10] | (buf[11] << 8) | (buf[12] << 16) | (buf[13] << 24));
  const ring = Buffer.alloc(4096, 0x20);
  let p = 14, o = 0, w = 4096 - 16;
  while (p < buf.length && o < out.length) {
    const ctrl = buf[p++];
    for (let bit = 0; bit < 8 && p < buf.length && o < out.length; bit++) {
      if (ctrl & (1 << bit)) {                       // 1 = a literal byte
        const b = buf[p++];
        out[o++] = b; ring[w] = b; w = (w + 1) & 4095;
      } else {                                       // 0 = a (offset, length) pair
        const lo = buf[p++], hi = buf[p++];
        let pos = lo | ((hi & 0xf0) << 4);
        const len = (hi & 0x0f) + 3;
        for (let i = 0; i < len && o < out.length; i++) {
          const b = ring[pos & 4095]; pos++;
          out[o++] = b; ring[w] = b; w = (w + 1) & 4095;
        }
      }
    }
  }
  return out.subarray(0, o);
}

const all = new Map();
for (let d = 1; d <= 4; d++) {
  const p = join(ROOT, 'boot', `WIN30_D${d}.IMG`);
  if (!existsSync(p)) { console.error(`manque ${p}`); process.exit(1); }
  const { files } = readImage(new Uint8Array(readFileSync(p)));
  // The extractor keys paths from the root, so they carry a leading backslash.
  for (const [name, data] of files) all.set(name.toUpperCase().replace(/^\\+/, ''), expandSZDD(Buffer.from(data)));
  console.log(`  disque ${d}: ${files.size} fichiers`);
}

for (const [name, data] of all) writeFileSync(join(out, name.replace(/\\/g, '_')), Buffer.from(data));

// WIN.COM. The logo pair is per display; VGA is what we emulate best (and the only one our planar
// path is measured against). A missing piece would leave a WIN.COM that loads and shows nothing.
const need = (n) => { const d = all.get(n); if (!d) { console.error(`absent des disques: ${n}`); process.exit(1); } return Buffer.from(d); };
writeFileSync(join(out, 'WIN.COM'), Buffer.concat([need('WIN.CNF'), need('VGALOGO.LGO'), need('VGALOGO.RLE')]));

// SETUP writes these from the .SRC templates; it also substitutes the chosen drivers, which the
// templates already default to for a plain VGA machine.
writeFileSync(join(out, 'SYSTEM.INI'), Buffer.from(need('SYSTEM.SRC')));
writeFileSync(join(out, 'WIN.INI'), Buffer.from(need('WIN.SRC')));

const sz = (n) => { const f = all.get(n); return f ? f.length : 0; };
console.log(`\n  -> ${out}`);
console.log(`     WIN.COM ${readFileSync(join(out, 'WIN.COM')).length} = WIN.CNF ${sz('WIN.CNF')} + VGALOGO.LGO ${sz('VGALOGO.LGO')} + VGALOGO.RLE ${sz('VGALOGO.RLE')}`);
console.log(`     noyau : KERNEL.EXE ${sz('KERNEL.EXE')}  GDI.EXE ${sz('GDI.EXE')}  USER.EXE ${sz('USER.EXE')}  VGA.DRV ${sz('VGA.DRV')}`);
console.log(`     ${all.size} fichiers au total`);
