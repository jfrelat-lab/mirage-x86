#!/usr/bin/env node
// ne-inspect — a New Executable (NE, Win16 / OS-2 1.x) inventory tool.
//
// Parses: MZ stub, NE header, segment table (+ per-segment relocation records),
// entry table (fixed and movable bundles), resident / non-resident name tables,
// module reference table and imported-name table.
//
// Its reason to exist is question 2 of the WIN16 spike: how many DISTINCT entry
// points of KERNEL/USER/GDI/... does a Win16 app actually call. Imports in Win16
// are overwhelmingly BY ORDINAL, so the ordinal->name mapping is derived from the
// exporting NE files themselves (their resident + non-resident name tables list
// name/ordinal pairs) rather than from any hardcoded table.
//
//   node tools/ne-inspect.mjs dump    <file.exe>            full structural dump
//   node tools/ne-inspect.mjs imports <file.exe> [...]      distinct imports per file
//   node tools/ne-inspect.mjs exports <dll.exe>             ordinal -> name of a library
//   node tools/ne-inspect.mjs union   --libdir DIR  <f>...  per-app + union counts
//
// --libdir DIR (default: the directory of the first input) is scanned for NE
// files so that an imported module name ("USER") can be matched to the file that
// exports it (USER.EXE) by its own resident-name-table module name.

import fs from 'node:fs';
import path from 'node:path';

// ---- little-endian readers ---------------------------------------------------
const u8 = (b, o) => b[o];
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

/** Length-prefixed (Pascal) string, as used by every NE name table. */
function pstr(b, o) {
  const n = b[o];
  return { len: n, str: Buffer.from(b.subarray(o + 1, o + 1 + n)).toString('latin1') };
}

// NE segment flags (ns_flags)
const SEG_FLAGS = [
  [0x0001, 'DATA'], [0x0002, 'ALLOCATED'], [0x0004, 'LOADED'], [0x0010, 'MOVEABLE'],
  [0x0020, 'SHAREABLE'], [0x0040, 'PRELOAD'], [0x0080, 'RDONLY/EXECONLY'],
  [0x0100, 'RELOCINFO'], [0x1000, 'DISCARDABLE'],
];
// NE header flags (ne_flags)
const HDR_FLAGS = [
  [0x0001, 'SINGLEDATA'], [0x0002, 'MULTIPLEDATA'], [0x2000, 'LINKERROR'],
  [0x8000, 'LIBRARY'],
];
const bits = (v, tbl) => tbl.filter(([m]) => v & m).map(([, n]) => n).join('|') || '-';

const RES_TYPE = { 1: 'CURSOR', 2: 'BITMAP', 3: 'ICON', 4: 'MENU', 5: 'DIALOG', 6: 'STRING',
                   7: 'FONTDIR', 8: 'FONT', 9: 'ACCELERATOR', 10: 'RCDATA',
                   12: 'GROUP_CURSOR', 14: 'GROUP_ICON' };
const RELOC_ADDR ={ 0: 'LOBYTE', 2: 'SEGMENT', 3: 'FAR_PTR', 5: 'OFFSET', 11: 'FARPTR48', 13: 'OFFSET32' };
const RELOC_TYPE = { 0: 'INTERNALREF', 1: 'IMPORTORDINAL', 2: 'IMPORTNAME', 3: 'OSFIXUP' };

// ---- the parser --------------------------------------------------------------
export function parseNE(buf, file = '?') {
  if (u16(buf, 0) !== 0x5a4d) throw new Error(`${file}: not an MZ image`);
  const e_lfanew = u32(buf, 0x3c);
  if (e_lfanew + 0x40 > buf.length) throw new Error(`${file}: e_lfanew out of range`);
  const ne = e_lfanew;                       // every ne_* offset below is relative to this
  const sig = u16(buf, ne);
  if (sig !== 0x454e) {
    const s = String.fromCharCode(buf[ne], buf[ne + 1]);
    throw new Error(`${file}: not an NE (new-exe signature is "${s}")`);
  }
  const h = {
    file, neOff: ne,
    mz: { e_cblp: u16(buf, 2), e_cp: u16(buf, 4), e_cparhdr: u16(buf, 8), e_lfanew },
    ver: u8(buf, ne + 2), rev: u8(buf, ne + 3),
    enttab: u16(buf, ne + 4), cbenttab: u16(buf, ne + 6),
    crc: u32(buf, ne + 8), flags: u16(buf, ne + 0x0c),
    autodata: u16(buf, ne + 0x0e), heap: u16(buf, ne + 0x10), stack: u16(buf, ne + 0x12),
    csip: u32(buf, ne + 0x14), sssp: u32(buf, ne + 0x18),
    cseg: u16(buf, ne + 0x1c), cmod: u16(buf, ne + 0x1e),
    cbnrestab: u16(buf, ne + 0x20),
    segtab: u16(buf, ne + 0x22), rsrctab: u16(buf, ne + 0x24), restab: u16(buf, ne + 0x26),
    modtab: u16(buf, ne + 0x28), imptab: u16(buf, ne + 0x2a),
    nrestab: u32(buf, ne + 0x2c),            // this ONE is a FILE offset, not NE-relative
    cmovent: u16(buf, ne + 0x30), align: u16(buf, ne + 0x32) || 9,
    cres: u16(buf, ne + 0x34), exetyp: u8(buf, ne + 0x36), flagsothers: u8(buf, ne + 0x37),
    expver: u16(buf, ne + 0x3e),
  };
  const shift = h.align;

  // -- imported-name table: byte-length-prefixed strings, addressed by offset ---
  h.impName = (off) => pstr(buf, ne + h.imptab + off).str;

  // -- module reference table: words, each an offset into the imported-name table
  h.modules = [];
  for (let i = 0; i < h.cmod; i++) h.modules.push(h.impName(u16(buf, ne + h.modtab + i * 2)));

  // -- resident / non-resident name tables (name -> ordinal; these ARE the exports)
  const readNames = (start, limit) => {
    const out = [];
    let o = start;
    while (o < limit) {
      const { len, str } = pstr(buf, o);
      if (len === 0) break;
      out.push({ name: str, ord: u16(buf, o + 1 + len) });
      o += 1 + len + 2;
    }
    return out;
  };
  h.residentNames = readNames(ne + h.restab, buf.length);
  h.moduleName = h.residentNames.length ? h.residentNames[0].name : '';
  h.nonResidentNames = h.cbnrestab && h.nrestab < buf.length
    ? readNames(h.nrestab, Math.min(h.nrestab + h.cbnrestab, buf.length)) : [];
  h.description = h.nonResidentNames.length ? h.nonResidentNames[0].name : '';

  // -- segment table + relocations ---------------------------------------------
  h.segments = [];
  for (let i = 0; i < h.cseg; i++) {
    const o = ne + h.segtab + i * 8;
    const sector = u16(buf, o);
    const cb = u16(buf, o + 2) || (sector ? 0x10000 : 0);
    const s = { n: i + 1, sector, offset: sector << shift, length: cb,
                flags: u16(buf, o + 4), minalloc: u16(buf, o + 6), relocs: [] };
    if ((s.flags & 0x0100) && s.offset) {           // RELOCINFO: table follows the data
      const ro = s.offset + cb;
      if (ro + 2 <= buf.length) {
        const n = u16(buf, ro);
        for (let k = 0; k < n; k++) {
          const p = ro + 2 + k * 8;
          if (p + 8 > buf.length) break;
          const r = { addrType: u8(buf, p) & 0x0f, type: u8(buf, p + 1) & 0x03,
                      additive: !!(u8(buf, p + 1) & 0x04), off: u16(buf, p + 2),
                      w4: u16(buf, p + 4), w6: u16(buf, p + 6) };
          if (r.type === 1) { r.module = h.modules[r.w4 - 1]; r.ordinal = r.w6; }
          else if (r.type === 2) { r.module = h.modules[r.w4 - 1]; r.import = h.impName(r.w6); }
          else if (r.type === 0) {
            if ((r.w4 & 0xff) === 0xff) { r.targetSeg = 'MOVEABLE'; r.entryOrd = r.w6; }
            else { r.targetSeg = r.w4 & 0xff; r.targetOff = r.w6; }
          } else { r.osfixup = r.w4; }
          s.relocs.push(r);
        }
      }
    }
    h.segments.push(s);
  }

  // -- resource table (Win 3.x form; ne_cres counts only the OLD segment form) --
  h.resources = [];
  if (h.rsrctab && h.rsrctab !== h.restab) {
    let o = ne + h.rsrctab;
    const rshift = u16(buf, o); o += 2;
    for (;;) {
      if (o + 8 > buf.length) break;
      const tid = u16(buf, o);
      if (tid === 0) break;
      const cnt = u16(buf, o + 2);
      o += 8;
      const name = (tid & 0x8000) ? (RES_TYPE[tid & 0x7fff] || `TYPE${tid & 0x7fff}`)
                                  : pstr(buf, ne + h.rsrctab + tid).str;
      for (let i = 0; i < cnt; i++) {
        if (o + 12 > buf.length) break;
        h.resources.push({ type: name, offset: u16(buf, o) << rshift, length: u16(buf, o + 2) << rshift,
                           flags: u16(buf, o + 4), id: u16(buf, o + 6) });
        o += 12;
      }
    }
  }

  // -- entry table: bundles of fixed (3 B) or movable (6 B) entries -------------
  h.entries = [];
  {
    let o = ne + h.enttab; const end = o + h.cbenttab; let ord = 1;
    while (o < end) {
      const cnt = u8(buf, o), type = u8(buf, o + 1);
      if (cnt === 0) break;
      o += 2;
      for (let i = 0; i < cnt; i++, ord++) {
        if (type === 0) { h.entries.push({ ord, kind: 'unused' }); }        // gap in ordinal space
        else if (type === 0xff) {
          h.entries.push({ ord, kind: 'movable', flags: u8(buf, o),
                           int3f: u16(buf, o + 1), seg: u8(buf, o + 3), off: u16(buf, o + 4),
                           exported: !!(u8(buf, o) & 1) });
          o += 6;
        } else {
          h.entries.push({ ord, kind: 'fixed', flags: u8(buf, o), seg: type,
                           off: u16(buf, o + 1), exported: !!(u8(buf, o) & 1) });
          o += 3;
        }
      }
    }
  }
  return h;
}

/** ordinal -> exported name, from the module's OWN name tables (no hardcoded list). */
export function exportMap(h) {
  const m = new Map();
  for (const e of [...h.nonResidentNames, ...h.residentNames]) {
    if (e.ord) m.set(e.ord, e.name);              // resident wins on conflict
  }
  return m;
}

/** Distinct imports of one module, as a Map "MODULE" -> Set of "NAME" / "@ord". */
export function importsOf(h) {
  const byMod = new Map();
  for (const s of h.segments) {
    for (const r of s.relocs) {
      if (r.type !== 1 && r.type !== 2) continue;
      const mod = (r.module || '??').toUpperCase();
      if (!byMod.has(mod)) byMod.set(mod, new Set());
      byMod.get(mod).add(r.type === 1 ? `@${r.ordinal}` : r.import);
    }
  }
  return byMod;
}

// ---- library index: module name -> export map, built by scanning a directory --
function buildLibIndex(dir) {
  const idx = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(exe|dll|drv|fon|mod)$/i.test(f)) continue;
    let h;
    try { h = parseNE(fs.readFileSync(path.join(dir, f)), f); } catch { continue; }
    if (!(h.flags & 0x8000)) continue;             // libraries only
    const name = (h.moduleName || path.parse(f).name).toUpperCase();
    if (!idx.has(name)) idx.set(name, { file: f, map: exportMap(h), header: h });
  }
  return idx;
}

// ---- commands ----------------------------------------------------------------
function cmdDump(file) {
  const h = parseNE(fs.readFileSync(file), path.basename(file));
  const H = (s) => console.log(`\n== ${s} ${'='.repeat(Math.max(0, 60 - s.length))}`);
  console.log(`${h.file}: NE at 0x${h.neOff.toString(16)}  linker ${h.ver}.${h.rev}  ` +
              `target ${h.exetyp === 2 ? 'Windows' : h.exetyp === 1 ? 'OS/2' : h.exetyp} ` +
              `${(h.expver >> 8)}.${(h.expver & 0xff).toString().padStart(2, '0')}`);
  console.log(`module "${h.moduleName}"  ${h.description ? `desc "${h.description}"` : ''}`);
  console.log(`flags 0x${h.flags.toString(16)} (${bits(h.flags, HDR_FLAGS)})  autodata seg ${h.autodata}` +
              `  heap ${h.heap}  stack ${h.stack}  align 1<<${h.align}`);
  console.log(`entry CS:IP ${(h.csip >>> 16)}:${(h.csip & 0xffff).toString(16)}   ` +
              `SS:SP ${(h.sssp >>> 16)}:${(h.sssp & 0xffff).toString(16)}`);
  console.log(`segments ${h.cseg}  modrefs ${h.cmod}  movable entries ${h.cmovent}  resources ${h.cres}`);

  H('segment table');
  let totReloc = 0;
  for (const s of h.segments) {
    totReloc += s.relocs.length;
    console.log(`  #${String(s.n).padStart(2)}  file@0x${s.offset.toString(16).padStart(6, '0')}` +
                `  len ${String(s.length).padStart(6)}  minalloc ${String(s.minalloc).padStart(6)}` +
                `  relocs ${String(s.relocs.length).padStart(4)}  ${bits(s.flags, SEG_FLAGS)}`);
  }
  console.log(`  total relocation records: ${totReloc}`);

  H('relocation records by kind (the fixup work a loader must do)');
  const rk = {};
  for (const s of h.segments) for (const r of s.relocs) {
    const key = `${RELOC_TYPE[r.type]}${r.type === 0 && r.targetSeg === 'MOVEABLE' ? ' (via movable entry/thunk)' : ''}` +
                ` / ${RELOC_ADDR[r.addrType] || r.addrType}${r.additive ? ' +additive' : ''}`;
    rk[key] = (rk[key] || 0) + 1;
  }
  for (const k of Object.keys(rk).sort()) console.log(`  ${String(rk[k]).padStart(5)}  ${k}`);

  H('module reference table');
  h.modules.forEach((m, i) => console.log(`  ${i + 1}: ${m}`));

  H('imported-name table (distinct names actually referenced)');
  const imp = importsOf(h);
  for (const [m, set] of imp) {
    const byName = [...set].filter((x) => !x.startsWith('@')).sort();
    console.log(`  ${m}: ${set.size} distinct (${set.size - byName.length} by ordinal, ${byName.length} by name)`);
    if (byName.length) console.log(`      by name: ${byName.join(' ')}`);
  }

  H('entry table');
  const exported = h.entries.filter((e) => e.kind !== 'unused');
  const mov = exported.filter((e) => e.kind === 'movable').length;
  console.log(`  ${h.entries.length} ordinal slots, ${exported.length} defined ` +
              `(${mov} movable / ${exported.length - mov} fixed), ` +
              `${h.entries.length - exported.length} unused`);
  const emap = exportMap(h);
  for (const e of exported.slice(0, 20)) {
    console.log(`  @${String(e.ord).padStart(4)} ${e.kind.padEnd(8)} seg ${String(e.seg).padStart(3)}` +
                `:${e.off.toString(16).padStart(4, '0')}  ${emap.get(e.ord) || ''}`);
  }
  if (exported.length > 20) console.log(`  … ${exported.length - 20} more`);

  H('resource table');
  if (!h.resources.length) console.log('  (none)');
  else {
    const byType = {};
    for (const r of h.resources) byType[r.type] = (byType[r.type] || 0) + 1;
    console.log(`  ${h.resources.length} resources: ` +
                Object.keys(byType).sort().map((t) => `${t}×${byType[t]}`).join('  '));
  }

  H('name tables');
  console.log(`  resident: ${h.residentNames.length} entries (module name + ${Math.max(0, h.residentNames.length - 1)} exports)`);
  console.log(`  non-resident: ${h.nonResidentNames.length} entries (description + ${Math.max(0, h.nonResidentNames.length - 1)} exports)`);
  console.log(`  named exports total: ${new Set([...h.residentNames, ...h.nonResidentNames].filter((e) => e.ord).map((e) => e.name)).size}`);
}

function cmdExports(file) {
  const h = parseNE(fs.readFileSync(file), path.basename(file));
  const m = exportMap(h);
  console.log(`${h.file} module "${h.moduleName}": ${h.entries.filter((e) => e.kind !== 'unused').length} entry points, ${m.size} of them named`);
  for (const ord of [...m.keys()].sort((a, b) => a - b)) console.log(`  @${String(ord).padStart(4)}  ${m.get(ord)}`);
}

function resolve(libIdx, mod, sym) {
  if (!sym.startsWith('@')) return sym;
  const lib = libIdx.get(mod);
  const n = lib && lib.map.get(+sym.slice(1));
  return n ? n : sym;                                // unresolved ordinals stay "@N"
}

function cmdImports(files, libDir) {
  const libIdx = buildLibIndex(libDir);
  for (const f of files) {
    const h = parseNE(fs.readFileSync(f), path.basename(f));
    const imp = importsOf(h);
    const tot = [...imp.values()].reduce((a, s) => a + s.size, 0);
    console.log(`\n${h.file}  ("${h.moduleName}", ${h.cseg} segments, ${tot} distinct imports)`);
    for (const [m, set] of [...imp].sort()) {
      const names = [...set].map((s) => resolve(libIdx, m, s)).sort();
      console.log(`  ${m} (${set.size}): ${names.join(' ')}`);
    }
  }
}

function cmdUnion(files, libDir) {
  const libIdx = buildLibIndex(libDir);
  console.log(`library index (module name -> file, exports named in its own name tables):`);
  for (const [n, l] of [...libIdx].sort()) console.log(`  ${n.padEnd(10)} ${l.file.padEnd(14)} ${l.map.size} named of ${l.header.entries.filter((e) => e.kind !== 'unused').length} entry points`);

  const union = new Map();                          // MODULE -> Set(resolved symbol)
  const perApp = [];
  for (const f of files) {
    const h = parseNE(fs.readFileSync(f), path.basename(f));
    const imp = importsOf(h);
    const row = { file: h.file, mods: new Map(), total: 0 };
    for (const [m, set] of imp) {
      const names = new Set([...set].map((s) => resolve(libIdx, m, s)));
      row.mods.set(m, names.size); row.total += names.size;
      if (!union.has(m)) union.set(m, new Set());
      for (const n of names) union.get(m).add(n);
    }
    perApp.push(row);
  }

  const mods = [...union.keys()].sort();
  console.log(`\nper-app distinct imported entry points`);
  console.log(`  ${'app'.padEnd(14)}${mods.map((m) => m.padStart(10)).join('')}${'TOTAL'.padStart(10)}`);
  for (const r of perApp) {
    console.log(`  ${r.file.padEnd(14)}${mods.map((m) => String(r.mods.get(m) ?? 0).padStart(10)).join('')}${String(r.total).padStart(10)}`);
  }
  console.log(`  ${'UNION'.padEnd(14)}${mods.map((m) => String(union.get(m).size).padStart(10)).join('')}` +
              `${String([...union.values()].reduce((a, s) => a + s.size, 0)).padStart(10)}`);

  console.log(`\nunion, by module`);
  for (const m of mods) {
    const set = [...union.get(m)].sort();
    const unres = set.filter((s) => s.startsWith('@'));
    console.log(`\n  ${m}: ${set.length} distinct entry points` +
                (unres.length ? ` (${unres.length} ordinal(s) NOT resolvable to a name)` : ''));
    console.log('    ' + set.join(' '));
  }
}

// ---- CLI ---------------------------------------------------------------------
// Guarded so the parser above can be imported by other tools without running it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();

function main() {
const argv = process.argv.slice(2);
const cmd = argv.shift();
let libDir = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--libdir') libDir = argv[++i];
  else files.push(argv[i]);
}
if (!cmd || !files.length) {
  console.log('usage: ne-inspect.mjs dump|exports|imports|union <file...> [--libdir DIR]');
  process.exit(1);
}
libDir ||= path.dirname(path.resolve(files[0]));
if (cmd === 'dump') files.forEach(cmdDump);
else if (cmd === 'exports') files.forEach(cmdExports);
else if (cmd === 'imports') cmdImports(files, libDir);
else if (cmd === 'union') cmdUnion(files, libDir);
else { console.error(`unknown command "${cmd}"`); process.exit(1); }
}
