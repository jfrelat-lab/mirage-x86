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

/**
 * SETUP writes SYSTEM.INI from SYSTEM.SRC and fills in the machine's drivers. The template's [boot]
 * and [keyboard] keys are EMPTY — "the templates already default to a plain VGA machine" was wrong,
 * and an empty [boot] is what made WIN386 answer "Cannot find the system initialization file needed
 * to run Windows; run Setup again" even though SYSTEM.INI opened fine four times. [386Enh] does come
 * filled in, which is why the file looked complete at a glance.
 *
 * These are the choices SETUP makes for a plain VGA machine, and every file named here is on the
 * disks. Note 3.0's grabber extensions: .GR3 is the 386 grabber, .GR2 the 286 one.
 */
const BOOT = {
  'shell': 'progman.exe', 'display.drv': 'vga.drv', 'system.drv': 'system.drv',
  'comm.drv': 'comm.drv', 'network.drv': '', 'oemfonts.fon': 'vgaoem.fon',
  'fonts.fon': 'vgasys.fon', 'fixedfon.fon': 'vgafix.fon', '386grabber': 'vga.gr3',
  '286grabber': 'vgacolor.gr2', 'mouse.drv': 'mouse.drv', 'keyboard.drv': 'keyboard.drv',
  'sound.drv': 'sound.drv', 'language.dll': '',
};
const KEYBOARD = { 'type': '4', 'subtype': '', 'keyboard.dll': '', 'oemansi.bin': '' };

/** Fill the empty `key =` lines of one section, leaving every other line byte-identical. */
function fillSection(text, section, values) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[')) { inSection = t.toLowerCase().startsWith('[' + section); continue; }
    if (!inSection) continue;
    const m = lines[i].match(/^(\s*)([\w.]+)(\s*=\s*)(.*)$/);
    if (m && m[4].trim() === '' && values[m[2].toLowerCase()] !== undefined) {
      lines[i] = m[1] + m[2] + m[3].replace(/\s+$/, ' ') + values[m[2].toLowerCase()];
    }
  }
  return lines.join('\r\n');
}

let systemIni = need('SYSTEM.SRC').toString('latin1');
systemIni = fillSection(systemIni, 'boot', BOOT);
systemIni = fillSection(systemIni, 'keyboard', KEYBOARD);
writeFileSync(join(out, 'SYSTEM.INI'), Buffer.from(systemIni, 'latin1'));
writeFileSync(join(out, 'WIN.INI'), Buffer.from(need('WIN.SRC')));

// PROGMAN.INI has no template on the disks — SETUP composes it, so this tool has to as well.
// Without it Program Manager opens C:\PROGMAN.INI, gets "file not found", and retries forever:
// measured as a loop of open / 19h / three IOCTLs / 5700h / close with an hourglass on screen, which
// reads as a hang and is not one. With it, the file is honoured — the window stops being maximised
// and takes the geometry below, which is how one can tell it was actually read.
//
// [Groups] is deliberately EMPTY: the .GRP files are SETUP's own work and nothing here can invent
// their contents. An empty Program Manager is then the correct picture, not a defect.
writeFileSync(join(out, 'PROGMAN.INI'), Buffer.from(
  '[Settings]\r\nWindow=68 48 570 330 1\r\ndisplay.drv=vga.drv\r\nOrder=\r\n\r\n[Groups]\r\n', 'latin1'));

const sz = (n) => { const f = all.get(n); return f ? f.length : 0; };
console.log(`\n  -> ${out}`);
console.log(`     WIN.COM ${readFileSync(join(out, 'WIN.COM')).length} = WIN.CNF ${sz('WIN.CNF')} + VGALOGO.LGO ${sz('VGALOGO.LGO')} + VGALOGO.RLE ${sz('VGALOGO.RLE')}`);
console.log(`     noyau : KERNEL.EXE ${sz('KERNEL.EXE')}  GDI.EXE ${sz('GDI.EXE')}  USER.EXE ${sz('USER.EXE')}  VGA.DRV ${sz('VGA.DRV')}`);
console.log(`     ecrits par nous, comme SETUP : SYSTEM.INI, WIN.INI, PROGMAN.INI (groupes vides)`);
console.log(`     ${all.size} fichiers au total`);
