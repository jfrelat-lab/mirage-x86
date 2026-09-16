// struct.mjs — a catalogue of DOS/BIOS/NE structures, DECODED and CHECKABLE.
//
//   node tools/struct.mjs list                        the known structures
//   node tools/struct.mjs show bpb                    its fields, with their source
//   node tools/struct.mjs decode bpb file:boot/W30HD.IMG@32256    from a file
//   node tools/struct.mjs decode bpb dump:mem.bin     from a dump (v86, QEMU, ourselves)
//   node tools/struct.mjs compare bpb A B [C]         side by side, differences marked
//
// WHY. A whole day went into hand-decoding structures that have been documented for forty years —
// BPB, fixed-disk parameter table, driver header, FONTINFO — and it went wrong at least twice: field
// offsets shifted enough to make a probe mute, and a font header decoded into nonsense on BOTH sides,
// which proved nothing. A catalogue written once, cited, and checkable against an emulator costs less
// than the third mistake.
//
// HOW IT PAIRS WITH THE ORACLES. The decoder takes BYTES, wherever they come from:
//   - `file:` reads a file at an offset — the disk image itself, the reference truth;
//   - `dump:` reads a raw dump — from `emu.read_memory()` under v86, from `xp` at the QEMU monitor,
//     or from our own machine.
// A documented field that disagrees between the source and three emulators is not an opinion: it is
// a defect, in one of the four. That is exactly the question this was built for — our in-memory BPB
// carries IO.SYS's template where v86 and QEMU carry the disk's.
import { readFileSync, existsSync } from 'fs';

const U8 = 1, U16 = 2, U32 = 4, STR = 's';

// Every structure cites its source. Values are CHECKED against a measurement when the source line
// says so — otherwise this is documentation, not an observation.
const CATALOG = {
  bpb: {
    title: 'BIOS Parameter Block (FAT12/16), as it appears in a boot sector at +0x0B',
    source: 'Microsoft FAT specification; RBIL "BPB"; checked against boot/W30HD.IMG (MSDOS4.0) and its in-memory BPB under v86',
    fields: [
      [0x00, U16, 'bytesPerSector', 'bytes per sector'],
      [0x02, U8, 'sectorsPerCluster', 'sectors per cluster'],
      [0x03, U16, 'reservedSectors', 'reserved sectors, including the boot sector'],
      [0x05, U8, 'numFats', 'number of FAT copies'],
      [0x06, U16, 'rootEntries', 'root directory entries'],
      [0x08, U16, 'totalSectors16', 'total sectors, 0 if > 65535 (see totalSectors32)'],
      [0x0a, U8, 'mediaDescriptor', 'media descriptor (F8 = fixed disk)'],
      [0x0b, U16, 'sectorsPerFat', 'sectors per FAT'],
      [0x0d, U16, 'sectorsPerTrack', 'sectors per track — GEOMETRY, not filesystem'],
      [0x0f, U16, 'heads', 'heads — same'],
      [0x11, U32, 'hiddenSectors', 'hidden sectors before the partition'],
      [0x15, U32, 'totalSectors32', 'total sectors when totalSectors16 is 0'],
    ],
  },
  'dos4-drvbpb': {
    title: "Entry in IO.SYS's BPB chain (MS-DOS 4), as walked by 0070:3ab4",
    source: 'RECONSTRUCTED by measurement, not documented. CONFIRMED by two independent emulators: '
      + 'v86 and QEMU return the same 16 fields at 0070:206c, all equal to the partition boot '
      + 'sector BPB. MIRAGE diverges on the 7 fields that come from the disk. Treat this as a '
      + 'hypothesis about the NAMES, not the values: two references agreeing does not prove the '
      + 'fields are named right.',
    fields: [
      [0x00, U16, 'nextOff', 'offset of the next entry (FFFF = end of chain)'],
      [0x02, U16, 'nextSeg', 'segment of the next entry'],
      [0x04, U16, 'attributs', 'driver attributes'],
      [0x06, U16, 'bytesPerSector', 'start of the BPB proper'],
      [0x08, U8, 'sectorsPerCluster', ''],
      [0x09, U16, 'reservedSectors', ''],
      [0x0b, U8, 'numFats', ''],
      [0x0c, U16, 'rootEntries', ''],
      [0x0e, U16, 'totalSectors16', ''],
      [0x10, U8, 'mediaDescriptor', ''],
      [0x11, U16, 'sectorsPerFat', ''],
      [0x13, U16, 'sectorsPerTrack', 'the divisor of the `div cx` at 0070:3aeb, together with heads'],
      [0x15, U16, 'heads', ''],
      [0x17, U32, 'hiddenSectors', ''],
      [0x1b, U32, 'totalSectors32', ''],
      [0x22, U8, 'typeUnite', '5 = fixed disk, 7 = other (compared at 0070:3ac0 and 0070:3b0e)'],
    ],
  },
  fdpt: {
    title: 'Fixed Disk Parameter Table — pointed at by INT 41h (drive 80h) and INT 46h (81h)',
    source: 'RBIL INT 41h; OSDev "Fixed Disk Parameter Table". NOT CHECKED here: installing one '
      + 'changed nothing in the MS-DOS 4 kernel under test, so its absence is not the defect being '
      + 'chased — but the absence is real (vectors 41h/46h point at the IRET stub).',
    fields: [
      [0x00, U16, 'cylinders', 'cylinders'],
      [0x02, U8, 'heads', 'heads'],
      [0x05, U16, 'writePrecomp', 'write precompensation cylinder'],
      [0x08, U8, 'controlByte', 'bit 3 = more than 8 heads'],
      [0x0c, U16, 'landingZone', 'landing zone'],
      [0x0e, U8, 'sectorsPerTrack', 'sectors per track'],
    ],
  },
  mz: {
    title: 'MZ header (DOS executable)',
    source: 'Microsoft EXE format; checked by tools/mzalloc.asm and the loader in src/dos.js',
    fields: [
      [0x00, STR, 'signature', '"MZ"', 2],
      [0x02, U16, 'cblp', 'bytes on the last page'],
      [0x04, U16, 'cp', '512-byte pages'],
      [0x06, U16, 'crlc', 'relocation entries'],
      [0x08, U16, 'cparhdr', 'header size in paragraphs'],
      [0x0a, U16, 'minalloc', 'minimum extra paragraphs'],
      [0x0c, U16, 'maxalloc', 'maximum — 0 loads the IMAGE as high as possible; the PSP stays at the bottom'],
      [0x0e, U16, 'ss', ''], [0x10, U16, 'sp', ''], [0x12, U16, 'csum', ''],
      [0x14, U16, 'ip', ''], [0x16, U16, 'cs', ''],
      [0x18, U16, 'lfarlc', 'offset of the relocation table'],
      [0x1a, U16, 'ovno', 'overlay number'],
    ],
  },
};

const rd = (buf, off, size) => size === U8 ? buf[off]
  : size === U16 ? buf[off] | (buf[off + 1] << 8)
  : size === U32 ? ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0)
  : null;

/** Byte source: `file:path@offset` or `dump:path`. */
function bytesOf(spec, need) {
  const m = /^file:([^@]+)(?:@(\d+|0x[0-9a-f]+))?$/i.exec(spec) || /^dump:(.+)$/i.exec(spec);
  if (!m) throw new Error(`unreadable source: ${spec} (expected file:path@offset or dump:path)`);
  const path = m[1];
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);
  const off = m[2] ? Number(m[2]) : 0;
  const b = readFileSync(path);
  if (off + need > b.length) throw new Error(`${path} is too short: ${b.length} bytes, ${off + need} needed`);
  return b.subarray(off, off + need);
}

const decode = (name, buf) => {
  const s = CATALOG[name];
  return s.fields.map(([off, size, id, note, len]) => {
    const v = size === STR ? String.fromCharCode(...buf.subarray(off, off + (len || 2))) : rd(buf, off, size);
    return { off, id, note, v, size };
  });
};

const need = (name) => Math.max(...CATALOG[name].fields.map(([o, s, , , l]) => o + (s === STR ? (l || 2) : s))) + 1;
const fmt = (f) => f.size === STR ? JSON.stringify(f.v) : `${f.v} (0x${(f.v >>> 0).toString(16)})`;

const [cmd, name, ...rest] = process.argv.slice(2);
if (cmd === 'list' || !cmd) {
  console.log('known structures:');
  for (const [k, s] of Object.entries(CATALOG)) console.log(`  ${k.padEnd(14)} ${s.title}`);
  console.log('\nsources: `node tools/struct.mjs show <name>`; decoding: `decode <name> file:img@offset`');
  process.exit(0);
}
if (!CATALOG[name]) { console.error(`unknown structure: ${name}`); process.exit(2); }
const S = CATALOG[name];

if (cmd === 'show') {
  console.log(`${name} — ${S.title}\nsource: ${S.source}\n`);
  for (const [off, size, id, note] of S.fields)
    console.log(`  +${off.toString(16).padStart(2, '0')}  ${String(size === STR ? 'str' : size + ' o').padEnd(5)} ${id.padEnd(18)} ${note}`);
} else if (cmd === 'decode') {
  const buf = bytesOf(rest[0], need(name));
  console.log(`${name} from ${rest[0]}:`);
  for (const f of decode(name, buf)) console.log(`  +${f.off.toString(16).padStart(2, '0')} ${f.id.padEnd(18)} ${fmt(f)}`);
} else if (cmd === 'compare') {
  const srcs = rest;
  if (srcs.length < 2) { console.error('compare needs at least two sources'); process.exit(2); }
  const cols = srcs.map((s) => decode(name, bytesOf(s, need(name))));
  console.log(`${name} — ${srcs.length} sources:\n  ` + srcs.map((s, i) => `[${i + 1}] ${s}`).join('\n  ') + '\n');
  let diffs = 0;
  for (let i = 0; i < cols[0].length; i++) {
    const vals = cols.map((c) => c[i].v);
    const same = vals.every((v) => v === vals[0]);
    if (!same) diffs++;
    console.log(`  ${same ? ' ' : '!'} +${cols[0][i].off.toString(16).padStart(2, '0')} ${cols[0][i].id.padEnd(18)} ` +
      vals.map((v) => String(v).padStart(10)).join(' '));
  }
  console.log(`\n${diffs} field(s) differ of ${cols[0].length}; the lines marked "!".`);
} else { console.error(`unknown command: ${cmd}`); process.exit(2); }
