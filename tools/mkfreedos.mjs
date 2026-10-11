// mkfreedos.mjs — build the FreeDOS hard disk of the home page from the FreeDOS project's own packages.
//
//   node tools/mkfreedos.mjs <dir of package zips> <out.img.gz>
//
// The packages are the 1.4 repository's, unmodified (their SHA-256 is pinned below), fetched from
//   https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.4/<group>/<name>.zip
// Each zip holds the program, its APPINFO/*.LSM (the licence), and usually its SOURCE/: the image
// gets everything but SOURCE/, placed as the FreeDOS installer places it — BIN, DOC, APPINFO, NLS,
// HELP and LINKS under C:\FREEDOS, the rest (DEVEL, GAMES) at the root. Ours (MIT): FDCONFIG.SYS,
// AUTOEXEC.BAT, the menu in C:\README.TXT and the MBR (tools/mbr.asm).
//
// The disk: 64 MB, 130 cylinders x 16 heads x 63 sectors, one active FAT16 partition from sector 63,
// 2 KB clusters. Its boot sector is FreeDOS's own (boot/boot.asm in the kernel package's sources,
// assembled for FAT16, as SYS.COM installs it) with the BPB written in. Every file is dated
// 2025-04-06 (FreeDOS 1.4) and laid out in a fixed order, so the same packages give the same image.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import { unzip } from '../src/zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const [pkgDir, out] = process.argv.slice(2);
if (!pkgDir || !out) { console.error('usage: node tools/mkfreedos.mjs <package dir> <out.img.gz>'); process.exit(2); }

const PACKAGES = {
  // base
  kernel: '43ed55fec6e795bb24e658302c7fae9eec9eb8dfeaba15734317b3f8302706d6',
  freecom: '3a7cfa03cce242031926cd67b69e1fd030d1c27127885d927629945f3137b6f0',
  himemx: '99b44e5bbb878105486e172675a460f645cdfb5a86cc1cf1e0e549fa31f29ce6',
  ctmouse: 'fd47069fb3d9559604dcaef34ca4f3705a7f2f2cff3e4b205e361b79f10a8200',
  edit: '6fc7bb68283f22387d0d5f310bf0cfc40af37324ad6bea7a574b57287bbb9841',
  mem: 'ec98eb5e7afa15f587e0f85f4a748611c398cbe88bf571b17e6341532b9b746d',
  more: 'a968c39b4de3a946f0d8e3138668991b97c328c8c95f2a380e249e6fd11da91e',
  deltree: 'af3867c4c2c98369da497ecf50c9a6b45fea1fb5967e9333a3420d5dda5cc521',
  xcopy: 'd075f4e59c3c7008c0f4d8c0c8b5b2dd06210e7c4e0b53eec646db66f7e5ddaf',
  attrib: '6a32c47d5319c11f1e748ab320d678704166f34d0cd6ef4b857fdaf182f4ed69',
  find: '75dd5bf90821b9ecff67fad36d9da342e48bfb1073e1835e53c9bf560ac5099c',
  tree: 'a3d11398d116654df293eccf6fbbcf543c799bced21f8045056a28cecccfa10b',
  choice: 'c64ce36b900feaf98741fb1e0a560106928926ab02e8158d403e5fee91edd8aa',
  mode: 'c92e07e9bea8f132437c542184c0cadc7fbabe3543174209c2799407ab671bdb',
  sort: '3c9ed55ef7425272c313431ac3e02605d1e9ce1ce1d8e32cefb575e36077d6cf',
  fc: 'bad0b8e74bd9c1d02c3065a2acbd1d4a54a0a7efa0771ce00700556bafa7d48a',
  // devel
  bwbasic: '45a37e14e06d5dd2972a5799519148c119c1562523160b8a44c507f7fe6e2318',
  fbc: '2eadc6d87d6e95fdaff8ba147c87f3a3eaf397cb3ca4fc48c40ffe24237b6328',
  nasm: 'f3497ec94f76b508a74904926a479cf33d75f6da332c432dfa72d5aaa2903cbe',
  lua: 'ff640089921398182ee9b92aefa97662f90c279f8476234360643990e32361d5',
  // games
  vitetris: '53a0be1c42ae9f2cb3e501d9cbf5e4b9d1d829b934966e2ca0d6ab0486dd7843',
  flpybird: 'a6f5c0c1bf5aa1746c9a335714c58835d4ce1ed90caa8de9072d9fb7f1d08ac9',
  sudoku86: '12c13caecd098748f5a8ace6667bbcacc333da209a70f26e49504fd11cb21eb3',
  liquiwar: '5ad1a6507883f9aacb0ad1914b7dbc266afc640f081797a0638e7e8de92f9ad9',
};
const UNDER_DOSDIR = new Set(['BIN', 'DOC', 'APPINFO', 'NLS', 'HELP', 'LINKS', 'BATLINKS', 'CPI']);

const crlf = (s) => new TextEncoder().encode(s.replace(/\r?\n/g, '\r\n'));
const FDCONFIG = `!COUNTRY=001,437,C:\\FREEDOS\\BIN\\COUNTRY.SYS
!LASTDRIVE=Z
!BUFFERS=20
!FILES=40
DOS=HIGH,UMB
DEVICE=C:\\FREEDOS\\BIN\\HIMEMX.EXE
SHELL=C:\\COMMAND.COM C:\\ /E:1024 /P=C:\\AUTOEXEC.BAT
`;
const AUTOEXEC = `@ECHO OFF
SET DOSDIR=C:\\FREEDOS
SET LANG=EN
SET NLSPATH=C:\\FREEDOS\\NLS
SET HELPPATH=C:\\FREEDOS\\HELP
SET TEMP=C:\\TEMP
SET TMP=C:\\TEMP
SET BLASTER=A220 I7 D1 H5 T6
SET PATH=C:\\FREEDOS\\BIN;C:\\FREEDOS\\LINKS;C:\\FREEDOS\\BATLINKS;C:\\DEVEL\\BWBASIC;C:\\DEVEL\\FBC;C:\\DEVEL\\NASM;C:\\DEVEL\\LUA\\BIN
CTMOUSE > NUL
TYPE C:\\README.TXT
`;
const README = `
  FreeDOS 1.4, built for MIRAGE from the FreeDOS project's own packages.

  Write a program  EDIT HELLO.BAS, then BWBASIC HELLO.BAS   (Bywater BASIC)
                   FBC HELLO.BAS, then HELLO                 (FreeBASIC)
                   LUA          NASM
  Play             CD \\GAMES\\VITETRIS, then TETRIS
                   CD \\GAMES\\SUDOKU86, then SUDOKU86
                   CD \\GAMES\\LIQUIWAR, then LWDOS
                   FLPYBIRD
  Look around      DIR   TREE \\GAMES   MEM   the manuals in C:\\FREEDOS\\DOC
  Licences         C:\\FREEDOS\\APPINFO\\*.LSM   sources: C:\\SOURCES.TXT
`;
const SOURCES = `The programs on this disk are the FreeDOS 1.4 packages listed below, unmodified, from
https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.4/
Each package zip there holds the program's source code (its SOURCE directory) beside the binaries
copied here; the licence of each is in C:\\FREEDOS\\APPINFO\\<name>.LSM.

${Object.entries(PACKAGES).map(([n, h]) => `  ${n.padEnd(9)} sha256 ${h}`).join('\n')}

FDCONFIG.SYS, AUTOEXEC.BAT, README.TXT, this file and the master boot record were written for
MIRAGE (MIT).
`;

// ---- the files ----
const files = new Map();   // DOS path (no leading backslash, uppercase) -> bytes
const add = (path, bytes) => {
  const p = path.toUpperCase();
  for (const seg of p.split('\\')) {
    const m = seg.match(/^([^.]{1,8})(\.([^.]{1,3}))?$/);
    if (!m || /[ "*+,/:;<=>?[\]|]/.test(seg)) throw new Error(`not an 8.3 name: ${path}`);
  }
  if (files.has(p)) throw new Error(`two files at ${p}`);
  files.set(p, bytes);
};
let kernelSrc = null;
for (const [name, sha] of Object.entries(PACKAGES)) {
  const zip = new Uint8Array(readFileSync(join(pkgDir, name + '.zip')));
  const got = createHash('sha256').update(zip).digest('hex');
  if (got !== sha) throw new Error(`${name}.zip: sha256 ${got}, expected ${sha}`);
  for (const f of await unzip(zip)) {
    const parts = f.path.split('/').filter(Boolean);
    if (!parts.length || f.path.endsWith('/')) continue;
    if (parts[0].toUpperCase() === 'SOURCE') { if (name === 'kernel' && /SOURCES\.ZIP$/i.test(f.path)) kernelSrc = f.bytes; continue; }
    const top = parts[0].toUpperCase();
    add((UNDER_DOSDIR.has(top) ? 'FREEDOS\\' : '') + parts.join('\\'), f.bytes);
  }
}
add('KERNEL.SYS', files.get('FREEDOS\\BIN\\KERNL386.SYS'));
add('COMMAND.COM', files.get('FREEDOS\\BIN\\COMMAND.COM'));
add('FDCONFIG.SYS', crlf(FDCONFIG));
add('AUTOEXEC.BAT', crlf(AUTOEXEC));
add('README.TXT', crlf(README));
add('SOURCES.TXT', crlf(SOURCES));
const dirsOnly = new Set(['TEMP']);

// ---- the boot code ----
const work = mkdtempSync(join(tmpdir(), 'mkfreedos-'));
execFileSync('nasm', ['-f', 'bin', join(HERE, 'mbr.asm'), '-o', join(work, 'mbr.bin')]);
if (!kernelSrc) throw new Error('the kernel package has no SOURCE/KERNEL/SOURCES.ZIP');
const bootAsm = (await unzip(kernelSrc)).find((f) => /^boot\/boot\.asm$/i.test(f.path));
writeFileSync(join(work, 'boot.asm'), bootAsm.bytes);
execFileSync('nasm', ['-f', 'bin', '-dISFAT16', join(work, 'boot.asm'), '-o', join(work, 'fat16.bin')]);
const MBR = readFileSync(join(work, 'mbr.bin')), VBR = readFileSync(join(work, 'fat16.bin'));
if (MBR.length !== 512 || VBR.length !== 512) throw new Error('boot code is not 512 bytes');

// ---- the disk ----
const HEADS = 16, SPT = 63, CYLS = 130, TOTAL = CYLS * HEADS * SPT, START = SPT, PSECT = TOTAL - START;
const SPC = 4, RESERVED = 1, NFATS = 2, ROOTENT = 512, ROOTSECT = ROOTENT * 32 / 512;
let fatSect = 1;
for (;;) {   // the FAT must cover the clusters the rest of the partition holds
  const clusters = Math.floor((PSECT - RESERVED - NFATS * fatSect - ROOTSECT) / SPC);
  const need = Math.ceil((clusters + 2) * 2 / 512);
  if (need <= fatSect) break;
  fatSect = need;
}
const DATA = RESERVED + NFATS * fatSect + ROOTSECT;
const CLUSTERS = Math.floor((PSECT - DATA) / SPC);
if (CLUSTERS < 4085 || CLUSTERS > 65524) throw new Error(`${CLUSTERS} clusters is not FAT16`);
const img = new Uint8Array(TOTAL * 512), P = START * 512;
const dv = new DataView(img.buffer);

// MBR and its partition table
img.set(MBR, 0);
const chs = (lba) => { const c = Math.floor(lba / (HEADS * SPT)), h = Math.floor(lba / SPT) % HEADS, s = lba % SPT + 1; return [h, s | ((c >> 2) & 0xc0), c & 0xff]; };
img.set([0x80, ...chs(START), 0x06, ...chs(TOTAL - 1)], 0x1be);
dv.setUint32(0x1be + 8, START, true); dv.setUint32(0x1be + 12, PSECT, true);

// the partition's boot sector, with its BPB
img.set(VBR, P);
const w16 = (o, v) => dv.setUint16(P + o, v, true), w32 = (o, v) => dv.setUint32(P + o, v, true);
img.set(new TextEncoder().encode('FRDOS4.1'), P + 3);
w16(0x0b, 512); img[P + 0x0d] = SPC; w16(0x0e, RESERVED); img[P + 0x10] = NFATS; w16(0x11, ROOTENT);
w16(0x13, 0); img[P + 0x15] = 0xf8; w16(0x16, fatSect); w16(0x18, SPT); w16(0x1a, HEADS);
w32(0x1c, START); w32(0x20, PSECT);
img[P + 0x24] = 0x80; img[P + 0x25] = 0; img[P + 0x26] = 0x29; w32(0x27, 0x4d495247);
img.set(new TextEncoder().encode('FREEDOS    FAT16   '), P + 0x2b);
dv.setUint16(P + 510, 0xaa55, true);

// FAT16 contents: directories first, then files, all in path order, each contiguous.
const fat = new Uint16Array(CLUSTERS + 2); fat[0] = 0xfff8; fat[1] = 0xffff;
let next = 2;
const clusterAt = (c) => P + (DATA + (c - 2) * SPC) * 512;
const alloc = (bytes) => {
  const n = Math.max(1, Math.ceil(bytes / (SPC * 512))), first = next;
  if (next + n > CLUSTERS + 2) throw new Error('the disk is full');
  for (let i = 0; i < n; i++) fat[first + i] = i === n - 1 ? 0xffff : first + i + 1;
  next += n; return first;
};
const DATE = ((2025 - 1980) << 9) | (4 << 5) | 6, TIME = 12 << 11;
const entry = (buf, o, name, attr, cluster, size) => {
  const [base, ext = ''] = name === '.' || name === '..' ? [name, ''] : name.split('.');
  const nm = new TextEncoder().encode(base.padEnd(8) + ext.padEnd(3));
  buf.set(nm, o); buf[o + 11] = attr;
  const d = new DataView(buf.buffer, buf.byteOffset);
  d.setUint16(o + 22, TIME, true); d.setUint16(o + 24, DATE, true);
  d.setUint16(o + 26, cluster, true); d.setUint32(o + 28, size, true);
};
// The tree.
const tree = { kids: new Map(), files: [] };
for (const p of [...files.keys(), ...[...dirsOnly].map((d) => d + '\\')].sort()) {
  const segs = p.split('\\'), leaf = segs.pop();
  let t = tree;
  for (const s of segs) { if (!t.kids.has(s)) t.kids.set(s, { kids: new Map(), files: [] }); t = t.kids.get(s); }
  if (leaf) t.files.push(leaf); else { /* a directory of its own */ }
}
// Allocate directory clusters first (sizes known from their entry counts), then file data.
const dirs = [];
const plan = (t, parent) => {
  for (const [name, k] of [...t.kids].sort()) {
    k.name = name; k.parent = parent;
    k.cluster = alloc((2 + k.kids.size + k.files.length) * 32);
    dirs.push(k); plan(k, k);
  }
};
plan(tree, null);
const dirBuf = (t) => (t === tree ? img.subarray(P + (RESERVED + NFATS * fatSect) * 512, P + DATA * 512) : null);
const write = (t, path) => {
  let n = 0;
  const slot = () => {
    if (t === tree) { if (n >= ROOTENT) throw new Error('root directory full'); return [img, P + (RESERVED + NFATS * fatSect) * 512 + 32 * n++]; }
    return [img, clusterAt(t.cluster) + 32 * n++];   // contiguous clusters: the offset runs on
  };
  if (t !== tree) {
    let [b, o] = slot(); entry(b, o, '.', 0x10, t.cluster, 0);
    [b, o] = slot(); entry(b, o, '..', 0x10, t.parent ? t.parent.cluster : 0, 0);
  } else {
    const [b, o] = slot(); b.set(new TextEncoder().encode('FREEDOS    '), o); b[o + 11] = 0x08;   // volume label
  }
  for (const [name, k] of [...t.kids].sort()) { const [b, o] = slot(); entry(b, o, name, 0x10, k.cluster, 0); }
  for (const name of t.files.sort()) {
    const bytes = files.get((path ? path + '\\' : '') + name);
    const c = bytes.length ? alloc(bytes.length) : 0;
    if (bytes.length) img.set(bytes, clusterAt(c));
    const [b, o] = slot(); entry(b, o, name, name === 'KERNEL.SYS' ? 0x07 : 0x20, c, bytes.length);
  }
  for (const [name, k] of [...t.kids].sort()) write(k, (path ? path + '\\' : '') + name);
};
dirBuf(tree);
write(tree, '');
for (let f = 0; f < NFATS; f++) img.set(new Uint8Array(fat.buffer), P + (RESERVED + f * fatSect) * 512);

writeFileSync(out, gzipSync(img, { level: 9 }));
console.log(`${files.size} files, ${dirs.length} directories, ${next - 2} of ${CLUSTERS} clusters used (${((next - 2) * SPC / 2 / 1024).toFixed(1)} MB) -> ${out}`);
