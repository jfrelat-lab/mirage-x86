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
      + 'sector BPB. MIRAGE now matches them: the 7 fields that come from the disk were empty for '
      + 'as long as INT 13h AH=08h zeroed the caller\'s ES:DI (src/disk.js). Treat this as a '
      + 'hypothesis about the NAMES, not the values: two references agreeing does not prove the '
      + 'fields are named right.',
    fields: [
      [0x00, U16, 'nextOff', 'offset of the next entry (FFFF = end of chain)'],
      [0x02, U16, 'nextSeg', 'segment of the next entry'],
      [0x04, U16, 'attributes', 'driver attributes'],
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
      [0x22, U8, 'unitType', '5 = fixed disk, 7 = other (compared at 0070:3ac0 and 0070:3b0e)'],
    ],
  },
  psp: {
    title: 'Program Segment Prefix — the 256 bytes DOS puts in front of every program',
    source: 'RBIL "PSP"; Microsoft MS-DOS Programmer\'s Reference. Checked against src/dos.js, which '
      + 'builds it, and against the child PSP assertions in tools/test-dos-api.js.',
    fields: [
      [0x00, U16, 'int20', 'CD 20 — an old way to exit by jumping to offset 0'],
      [0x02, U16, 'memTop', 'first paragraph PAST the block; KERNEL reads it to size its heap'],
      [0x0a, U32, 'terminateAddr', 'INT 22h vector saved at load'],
      [0x0e, U32, 'ctrlBreakAddr', 'INT 23h'],
      [0x12, U32, 'criticalAddr', 'INT 24h'],
      [0x16, U16, 'parentPsp', 'parent PSP, 0 for the root program'],
      [0x2c, U16, 'envSeg', 'environment segment'],
      [0x32, U16, 'jftSize', 'entries in the job file table (20 by default)'],
      [0x34, U32, 'jftPtr', 'far pointer to the JFT — usually back into this PSP at +18'],
      [0x50, U16, 'int21Stub', 'CD 21 — call DOS through the PSP'],
      [0x80, U8, 'cmdTailLen', 'length of the command tail that follows'],
    ],
  },
  mcb: {
    title: 'Memory Control Block — the 16-byte header one paragraph below every DOS block',
    source: 'RBIL "MCB"; checked against src/dos.js syncMCB() and against dosbox-x through '
      + 'tools/mzalloc.asm, which reads the MCB of its own block.',
    fields: [
      [0x00, STR, 'type', "'M' = another block follows, 'Z' = last of the chain", 1],
      [0x01, U16, 'ownerPsp', 'owning PSP, 0 = free'],
      [0x03, U16, 'sizeParas', 'size in paragraphs, NOT counting this header'],
      [0x08, STR, 'name', 'program name, DOS 4+', 8],
    ],
  },
  bda: {
    title: 'BIOS Data Area at 0040:0000 — the BIOS state a guest can read directly',
    source: 'RBIL "BIOS Data Area"; every field below is one we either write or were caught not '
      + 'writing. 0x75 was measured at 0 with a fixed disk attached, which is wrong on real hardware.',
    fields: [
      [0x10, U16, 'equipment', 'equipment word: bit 0 = floppy present, bits 6-7 = floppies - 1'],
      [0x13, U16, 'convKb', 'conventional memory in KB — INT 12h returns this'],
      [0x17, U8, 'kbdFlags', 'shift/lock state'],
      [0x49, U8, 'videoMode', 'current video mode'],
      [0x4a, U16, 'columns', 'text columns'],
      [0x63, U16, 'crtcBase', 'CRTC I/O base; +6 is the retrace status register'],
      [0x6c, U32, 'ticks', 'ticks since midnight, bumped by the BIOS INT 8 handler'],
      [0x70, U8, 'rollover', 'midnight rollover flag'],
      [0x75, U8, 'fixedDisks', 'number of fixed disks — a DOS kernel reads this before asking AH=08h'],
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

/** A live MIRAGE machine, built on demand: `live:<linear>` reads our own memory, which is what
 *  makes the catalogue usable as a CHECK and not only as a viewer. */
async function liveMachine() {
  const { makeMachine } = await import('./harness.mjs');
  const { VFS } = await import('../src/vfs.js');
  const vfs = new VFS();
  vfs.addFile('\\PROG.COM', new Uint8Array([0xcd, 0x20]));      // a program has to exist for a PSP to
  const { mc, dos } = makeMachine({ vfs });
  dos.load(new Uint8Array([0xcd, 0x20]), '', 'C:\\PROG.COM');
  dos.syncSFT();                                                 // publish the SFT and the JFT
  return { mc, dos };
}

async function liveBytes(linear, need) {
  const { mc, dos } = await liveMachine();
  const out = Buffer.alloc(need);
  for (let k = 0; k < need; k++) out[k] = mc.mem.r8(linear + k);
  return { buf: out, mc, dos };
}

/** Byte source: `file:path@offset`, `dump:path`, or `live:<linear>`. */
async function bytesOf(spec, need) {
  const live = /^live:(\d+|0x[0-9a-f]+)$/i.exec(spec);
  if (live) return (await liveBytes(Number(live[1]), need)).buf;
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

/** Invariants a live DOS machine must satisfy. A decoder shows what you ask for; an invariant
 *  shouts without being asked — which is the difference between a microscope and a smoke detector.
 *  Each one is written so that a PLAUSIBLE defect breaks it: the per-PSP handle table bug fixed in
 *  f7c97ec would have tripped `jft/sft agree`, and nothing in the suite noticed it for a day. */
function evaluate(mc, dos) {
  const mem = mc.mem, out = [];
  const t = (name, cond, detail) => out.push({ name, ok: !!cond, detail });

  // ---- MCB chain ----------------------------------------------------------
  // Walk it the way DOS does: each header sits one paragraph below its block, and the next header
  // is at base + size. The chain must END, and it must end on 'Z' exactly once.
  let seg = dos.blockBase - 1, hops = 0, zCount = 0, lastType = '';
  const seen = new Set();
  while (hops++ < 64) {
    const base = seg << 4, type = String.fromCharCode(mem.r8(base));
    if (type !== 'M' && type !== 'Z') { lastType = type; break; }
    if (seen.has(seg)) { lastType = 'loop'; break; }
    seen.add(seg);
    if (type === 'Z') { zCount++; lastType = 'Z'; break; }
    seg = seg + 1 + mem.r16(base + 3);
  }
  t('mcb chain terminates on a single Z', zCount === 1 && lastType === 'Z',
    `${hops} hop(s), last type ${JSON.stringify(lastType)}`);
  // No 'chain is not a loop' check: the walk is strictly increasing (next = seg + 1 + size, size
  // being unsigned), so a loop is unreachable by construction. The self-test asked for a mutation
  // that turns it red, none exists, and a guard that cannot fail is noise — see the vacuous-check
  // lesson. The `seen` set stays as a bound on a corrupted walk.
  const firstMcb = (dos.blockBase - 1) << 4;
  t('mcb owner is the running PSP', mem.r16(firstMcb + 1) === dos.psp,
    `owner ${mem.r16(firstMcb + 1).toString(16)} vs psp ${dos.psp.toString(16)}`);

  // ---- PSP ----------------------------------------------------------------
  const psp = dos.psp << 4;
  t('psp starts with INT 20h', mem.r16(psp) === 0x20cd, mem.r16(psp).toString(16));
  t('psp has the INT 21h stub at +50', mem.r16(psp + 0x50) === 0x21cd, mem.r16(psp + 0x50).toString(16));
  t('psp memTop is above the psp', mem.r16(psp + 0x02) > dos.psp,
    `${mem.r16(psp + 0x02).toString(16)} > ${dos.psp.toString(16)}`);
  t('psp jft pointer points back into the psp', mem.r16(psp + 0x36) === dos.psp && mem.r16(psp + 0x34) === 0x18,
    `${mem.r16(psp + 0x36).toString(16)}:${mem.r16(psp + 0x34).toString(16)}`);
  t('psp jft size is 20', mem.r16(psp + 0x32) === 20, String(mem.r16(psp + 0x32)));

  // ---- JFT against the VFS ------------------------------------------------
  // The published table has to describe the handles the VFS actually holds for THIS psp. This is
  // the invariant a single global handle table cannot keep once two PSPs exist.
  const vfs = dos.vfs;
  let jftOpen = 0, mismatch = [];
  for (let i = 0; i < 20; i++) {
    const slot = mem.r8(psp + 0x18 + i), live = vfs.handles.has(i);
    if (slot !== 0xff) jftOpen++;
    if ((slot !== 0xff) !== live) mismatch.push(i);
  }
  t('jft and the VFS agree on which handles are open', mismatch.length === 0,
    mismatch.length ? `slots ${mismatch.join(',')}` : `${jftOpen} open`);
  t('the five standard handles are open', jftOpen >= 5, `${jftOpen} open`);

  // ---- BDA ----------------------------------------------------------------
  t('bda conventional memory is sane', mem.r16(0x413) >= 512 && mem.r16(0x413) <= 640, `${mem.r16(0x413)} KB`);
  t('bda crtc base is a real port', [0x3d4, 0x3b4].includes(mem.r16(0x463)), mem.r16(0x463).toString(16));
  const fixed = [...(mc.disk ? mc.disk.drives.keys() : [])].filter((d) => d >= 0x80).length;
  t('bda fixed-disk count matches the attached drives', mem.r8(0x475) === fixed,
    `bda ${mem.r8(0x475)} vs attached ${fixed}`);

  return out;
}

// Each invariant ships with the MUTATION that must break it. A gate never seen red is not known to
// work — the same discipline as a probe that has never fired. `check --selftest` applies each
// mutation to a FRESH machine and demands that its invariant, and no other, turns red.
//
// ⚠️ What this proves and what it does not: corrupting memory shows the ASSERTION detects the bad
// state. It does not show that the code path producing that state is exercised anywhere. A green
// self-test means the detector works, not that the defect is covered.
const MUTATIONS = [
  ['mcb chain terminates on a single Z', (mc, dos) => mc.mem.w8((dos.blockBase - 1) << 4, 0x4d)],
  ['mcb owner is the running PSP', (mc, dos) => mc.mem.w16(((dos.blockBase - 1) << 4) + 1, 0x1234)],
  ['psp starts with INT 20h', (mc, dos) => mc.mem.w16(dos.psp << 4, 0)],
  ['psp has the INT 21h stub at +50', (mc, dos) => mc.mem.w16((dos.psp << 4) + 0x50, 0)],
  ['psp memTop is above the psp', (mc, dos) => mc.mem.w16((dos.psp << 4) + 2, 1)],
  ['psp jft pointer points back into the psp', (mc, dos) => mc.mem.w16((dos.psp << 4) + 0x34, 0x99)],
  ['psp jft size is 20', (mc, dos) => mc.mem.w16((dos.psp << 4) + 0x32, 7)],
  ['jft and the VFS agree on which handles are open', (mc, dos) => mc.mem.w8((dos.psp << 4) + 0x18 + 3, 0xff)],
  ['the five standard handles are open', (mc, dos) => { for (let i = 0; i < 20; i++) mc.mem.w8((dos.psp << 4) + 0x18 + i, 0xff); }],
  ['bda conventional memory is sane', (mc) => mc.mem.w16(0x413, 0)],
  ['bda crtc base is a real port', (mc) => mc.mem.w16(0x463, 0)],
  ['bda fixed-disk count matches the attached drives', (mc) => mc.mem.w8(0x475, 3)],
];

async function runChecks(selftest) {
  const { mc, dos } = await liveMachine();
  const out = evaluate(mc, dos);
  const bad = out.filter((x) => !x.ok);
  for (const c of out) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(46)} ${c.detail}`);
  console.log(`\nstruct check: ${out.length - bad.length} ok, ${bad.length} failed`);
  if (!selftest) process.exit(bad.length ? 1 : 0);

  console.log('\nself-test — each invariant against its own mutation (red), then clean (green):');
  let proved = 0, unproved = [];
  for (const [name, mutate] of MUTATIONS) {
    const fresh = await liveMachine();
    mutate(fresh.mc, fresh.dos);
    const after = evaluate(fresh.mc, fresh.dos);
    const target = after.find((x) => x.name === name);
    const others = after.filter((x) => x.name !== name && !x.ok).map((x) => x.name);
    const red = target && !target.ok;
    if (red) proved++; else unproved.push(name);
    console.log(`  ${red ? 'red ' : 'MUTE'} ${name.padEnd(46)}` +
      (others.length ? `  (also red: ${others.length})` : ''));
  }
  const covered = new Set(MUTATIONS.map(([n]) => n));
  const nomut = out.filter((x) => !covered.has(x.name)).map((x) => x.name);
  console.log(`\nself-test: ${proved}/${MUTATIONS.length} invariants proved able to fail` +
    (nomut.length ? `; ${nomut.length} with NO mutation: ${nomut.join(', ')}` : ''));
  process.exit(bad.length || unproved.length || nomut.length ? 1 : 0);
}

const [cmd, name, ...rest] = process.argv.slice(2);
if (cmd === 'check') { await runChecks(rest.includes('--selftest') || name === '--selftest'); }
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
  const buf = await bytesOf(rest[0], need(name));
  console.log(`${name} from ${rest[0]}:`);
  for (const f of decode(name, buf)) console.log(`  +${f.off.toString(16).padStart(2, '0')} ${f.id.padEnd(18)} ${fmt(f)}`);
} else if (cmd === 'compare') {
  const srcs = rest;
  if (srcs.length < 2) { console.error('compare needs at least two sources'); process.exit(2); }
  const cols = [];
  for (const src of srcs) cols.push(decode(name, await bytesOf(src, need(name))));
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
