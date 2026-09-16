// dos.js — the DOS kernel: INT 21h services, the Program Segment Prefix, a bump
// memory allocator, and the COM / MZ-EXE program loaders (with relocation).
// Console I/O is routed through the BIOS text routines so guest output and the
// JS shell render identically. File I/O is backed by the VFS.

import { CF, ZF, CS, DS, ES, SS } from './cpu.js';
import { DOS_MTIME } from './vfs.js';

// Where a real DOS puts the first program, measured rather than chosen (ROADMAP G1). Two independent
// oracles: dosbox-x's DOS gives a .COM `CS = DX = 0x0814` (tools/regs.asm, identical across memsize
// 16 and 32 MiB and with EMS/XMS on and off), and a booted FreeDOS 1.4 kernel builds an MCB chain
// whose first program block owns PSP 0x1108. We used 0x0100, handing every program ~29 KiB of
// conventional memory it would not have on a real machine — which is exactly what the SCUMM titles'
// AH=48/49 free-memory binary search measures, and the only place their event streams diverge from
// the reference. 0x0814 matches the oracle the corpus is diffed against.
const PSP_SEG = 0x0814;     // first program's PSP
const ENV_SEG = 0x00c0;     // environment block     (linear 0x0C00) — inside DOS's own arena, as it is on a real machine
// One PAST the last usable paragraph. 0x9fff, not 0xa000: measured with tools/mem.asm, dosbox-x
// offers a program that shrank to 0x100 paragraphs a largest-free block of 0x96EA, which is
// 0x9fff - allocTop - 1 (the -1 being the free block's own MCB header). We answered 0x96EC.
const MEM_TOP = 0x9fff;     // end of conventional memory, in paragraphs

export function installDOS(machine, vfs) {
  const mem = machine.mem, cpu = machine.cpu;
  // The EMS driver answers to its name in the device chain, and that — not the INT 67h vector — is
  // how Wolf3D and Doom test for it. DOS is installed after the BIOS, so machine.ems is already set.
  if (machine.ems) vfs.addDevice('EMMXXXX0');
  const dos = {
    machine, vfs,
    psp: PSP_SEG,
    dta: (PSP_SEG << 4) + 0x80,
    version: [5, 0],
    unhandledFn: new Uint32Array(256),   // AH -> count of INT 21h calls that fell through to default
    /** Human-readable list of the INT 21h functions this run asked for and did not get. */
    unhandledFnReport() {
      const out = [];
      for (let n = 0; n < 256; n++) if (this.unhandledFn[n]) out.push(`AH=${n.toString(16).padStart(2, '0')}h x${this.unhandledFn[n]}`);
      return out;
    },
    allocTop: PSP_SEG,
    allocs: new Map(),        // live AH=48 allocations: seg → paragraphs
    memFloor: MEM_TOP,        // bump base above the program's own block
    blockBase: PSP_SEG,       // first paragraph of the running program's block (MCB at base-1)
    programDone: false,
    exitCode: 0,
    findList: [], findIdx: 0,
    switchChar: 0x2f,         // AH=37h: '/' — what DOS reports as the command-line option prefix
    date: null, time: null,   // AH=2Bh/2Dh: a guest-set date/time, if any
    allocStrategy: 0,         // AH=58h: 0 = first fit. Remembered, not honoured — see the handler.
    umbLink: 0,               // AH=58h AL=02/03: UMBs are not in the allocation chain
    onPrint: null,            // optional tap for headless capture
  };

  const bios = () => machine.bios;
  const out = (ch) => { if (dos.onPrint) dos.onPrint(ch); bios().teletype(ch); };
  const setCF = (on) => { if (on) cpu.flags |= CF; else cpu.flags &= ~CF; };
  const err = (code) => { setCF(true); cpu.ax = code; };
  const ok = () => setCF(false);
  const asciiz = (lin) => String.fromCharCode(...mem.readCStr(lin));

  // ---- PSP / environment --------------------------------------------------
  function buildEnv(progPath) {
    let p = ENV_SEG << 4;
    const put = (s) => { for (let i = 0; i < s.length; i++) mem.w8(p++, s.charCodeAt(i)); mem.w8(p++, 0); };
    put('PATH=C:\\'); put('COMSPEC=C:\\COMMAND.COM'); put('PROMPT=$p$g');
    // Sound Blaster config — many games (Hocus Pocus, Apogee titles) refuse to start
    // without BLASTER set, even when they fall back to no sound.
    put('BLASTER=A220 I7 D1 H5 T6');
    mem.w8(p++, 0);                 // end of env vars
    setEnvProgramPath(ENV_SEG, progPath);
  }

  /**
   * Write the program path that follows an environment block: after the strings' terminating double
   * NUL comes a word 1 and then the ASCIIZ full path of the program that owns the block. Programs
   * find their own file through it — Jazz Jackrabbit derives its extender's path from it, and
   * Windows 3.0's WIN386 REOPENS ITSELF that way to load the VxDs out of its own image.
   *
   * It has to be rewritten on EXEC. DOS gives a child a COPY of the environment ending in the
   * CHILD's path; we hand over the parent's block, so the path in it was the parent's — and worse,
   * WIN.COM appends `windir=` to that block in place, which overwrote the word and the path
   * outright. WIN386 then opened a zero-length filename and reported "Unable to start Windows in
   * 386 enhanced mode".
   *
   * @param {number} envSeg  the block's segment
   * @param {string} path    full path of the program that will own it
   */
  function setEnvProgramPath(envSeg, path) {
    let p = envSeg << 4;
    for (let guard = 0; guard < 0x8000; guard++) {        // scan to the strings' double NUL
      if (mem.r8(p) === 0) break;
      while (mem.r8(p) !== 0) p++;                        // skip this string
      p++;                                                // and its terminator
    }
    p++;                                                  // past the empty string that ends the block
    mem.w16(p, 1); p += 2;                                // count of following strings
    for (let i = 0; i < path.length; i++) mem.w8(p++, path.charCodeAt(i));
    mem.w8(p, 0);
  }

  function buildPSP(seg, tail) {
    const b = seg << 4;
    for (let i = 0; i < 256; i++) mem.w8(b + i, 0);
    mem.w8(b + 0x00, 0xcd); mem.w8(b + 0x01, 0x20);   // INT 20h
    mem.w16(b + 0x02, MEM_TOP);                        // top of memory (paragraphs)
    mem.w8(b + 0x05, 0xcd); mem.w8(b + 0x06, 0x21); mem.w8(b + 0x07, 0xcb); // INT 21h; RETF
    // 0A/0E/12 are the INT 22h/23h/24h vectors AS THEY STOOD when the program was loaded. DOS saves
    // them here so a program can restore them on exit — and they are read, not just stored: DOS4GW
    // takes PSP:000A as the address it returns through when the extender finishes, hooks its own in
    // its place, and then IRETs to what it read. Leaving these zero made that IRET load the null
    // selector, and Heretic ran off from linear 0 for 20000 blocks (tools/derailcheck.mjs).
    mem.w32(b + 0x0a, mem.r32(0x22 * 4));              // terminate address
    mem.w32(b + 0x0e, mem.r32(0x23 * 4));              // Ctrl-Break handler
    mem.w32(b + 0x12, mem.r32(0x24 * 4));              // critical-error handler
    mem.w16(b + 0x2c, ENV_SEG);                        // environment segment
    mem.w8(b + 0x50, 0xcd); mem.w8(b + 0x51, 0x21); mem.w8(b + 0x52, 0xcb);
    const t = (tail || '').slice(0, 126);
    mem.w8(b + 0x80, t.length);
    for (let i = 0; i < t.length; i++) mem.w8(b + 0x81 + i, t.charCodeAt(i));
    mem.w8(b + 0x81 + t.length, 0x0d);
    dos.dta = b + 0x80;
  }

  // ---- program loaders ----------------------------------------------------
  function prep(tail, progPath) {
    machine.rec.reset();
    dos.programDone = false; dos.exitCode = 0;
    dos.allocs = new Map();      // seg → paragraphs for live AH=48 blocks
    dos.memFloor = MEM_TOP;      // bump base above the program's own block (lowered when it shrinks)
    dos.blockBase = PSP_SEG;     // the paragraph its MCB describes; differs from the PSP when loaded high
    if (machine.xms) machine.xms.reset();   // a fresh program gets a clean extended-memory pool
    buildEnv(progPath || 'C:\\PROGRAM');
    buildPSP(PSP_SEG, tail);
  }
  // ---- MCB (Memory Control Block) chain ----------------------------------
  // Some programs size free memory by walking the DOS MCB chain directly — starting at their own
  // MCB (PSP-1), following each block's `size` word to the next MCB, until the 'Z' (last) block —
  // instead of asking via AH=48/4A (Ski or Die's loader does exactly this; Moktar's protection too).
  // Model the layout as two blocks: the program (owns everything from its PSP up to allocTop) and
  // one free block above it. Rebuilt whenever allocTop moves so a re-walk sees the current free size.
  const writeMCB = (seg, sig, owner, size) => {
    const b = seg << 4;
    mem.w8(b, sig); mem.w16(b + 1, owner & 0xffff); mem.w16(b + 3, size & 0xffff);
    for (let i = 5; i < 16; i++) mem.w8(b + i, 0);        // reserved + 8-byte owner name (blank)
  };
  const syncMCB = () => {
    // One block per program that is loaded: every frame on the EXEC stack, oldest first, then the
    // program running now, then whatever is left above as a single free block. A chain of exactly two
    // blocks was fine until EXEC, which left the child's block undescribed — and worse, put the
    // child's PSP ON the free block's MCB header, so the header read as the child's first opcode.
    // Windows 3.0's WIN386 walks the chain and refused with "conventional memory is fragmented".
    // base, not psp: an e_maxalloc=0 program sits HIGH inside its block, and its MCB stays at the
    // block's base. The reference finds no MCB in the paragraph below such a program's own PSP.
    const progs = dos.execStack.map((f) => ({ base: f.blockBase | 0 || f.psp, psp: f.psp, top: Math.min(f.allocTop | 0, MEM_TOP) }));
    progs.push({ base: dos.blockBase | 0 || dos.psp, psp: dos.psp, top: Math.min(dos.allocTop | 0, MEM_TOP) });
    const top = progs[progs.length - 1].top;
    const hasFree = top < MEM_TOP - 1;
    for (let i = 0; i < progs.length; i++) {
      const last = i === progs.length - 1 && !hasFree;
      writeMCB(progs[i].base - 1, last ? 0x5a : 0x4d, progs[i].psp, progs[i].top - progs[i].base);
    }
    if (hasFree) writeMCB(top, 0x5a, 0x0000, MEM_TOP - top - 1);            // free block: 'Z' (last), owner 0
    mem.w16((LOL_SEG << 4) + LOL_OFF - 2, PSP_SEG - 1);                     // list-of-lists: word before it = first MCB (the program's, at PSP-1)
    // PSP:0002 is "first paragraph past this program's block", and it was hard-wired to 0xA000 —
    // i.e. every program was told it owned all of conventional memory no matter how it had been
    // sized or how much it had already shrunk. A program that sizes its heap from this word (rather
    // than asking AH=48h) computed it from a number that was never true after an AH=4Ah.
    // NOT PSP:0002. That word is the top of the program's block AT LOAD TIME, and DOS never revises
    // it: measured with tools/mem.asm, dosbox-x still reports 0x9FFF after the program has shrunk to
    // 0x100 paragraphs. It is written once, by the loader, from the block it actually handed over.
  };
  dos.syncMCB = syncMCB;
  // INT 21h AH=52 "get list of lists" (SysVars) hands back ES:BX; the word at [ES:BX-2] is the
  // first MCB segment — the standard way MCB-walkers find the chain head. We host it in unused
  // low memory just past the BIOS data area.
  const DIB_SEG = 0x0050, DIB_OFF = 0x0026;
  // ...but the List of Lists itself lives where a real DOS puts it, measured rather than chosen:
  // tools/sftprobe.asm asks DOS for it and follows the SFT pointer, and under DOSBox-X reports
  //   LOL 0071:0026   SFT 0071:00CC   ("PRN" at offset 0x20 of an entry)
  // — same offset we had, different segment. 0050:0026 sat in the low scratch area small intros use
  // as a buffer: oktaeder reads 0x52A and derails on anything non-zero there, and it took exactly
  // one four-byte SFT pointer to break it.
  const LOL_SEG = 0x0071, LOL_OFF = 0x0026;
  // InDOS flag (AH=34h) and, one byte below it as DOS lays them out, the critical-error flag. Kept
  // in the same scratch paragraph as the list-of-lists, clear of the MCB-head word at DIB_OFF-2.
  //
  // ⚠️ They live in the LIST-OF-LISTS segment, not in the BIOS data area, and that is not cosmetic.
  // Windows 3.0 real mode interrogates INT 21h, INT 2Fh and the InDOS flag and then refuses with
  // "Incorrect DOS version" — a misleading message: AH=30h is answered 5.00 and accepted. Measured
  // against FreeDOS under QEMU (`tools/dosvec.asm`), which reaches the Program Manager on the same
  // tree:
  //     FreeDOS  INT21=00D8:129A  INT2F=029D:00D0  INDOS=00D8:0321
  //     MIRAGE   INT21=F000:0021  INT2F=F000:002F  INDOS=0050:0021   (before this)
  // A real DOS keeps all of it in ONE low-RAM kernel segment: its InDOS flag sits in the same
  // segment as its INT 21h handler. Ours were three unrelated places, two of them in ROM.
  // InDOS sits BELOW the entry points, as it does on a real kernel: FreeDOS answers InDOS 0x0321
  // against an INT 21h handler at 0x129A. Having it above them is the one shape difference left
  // against the reference, and a kernel that locates itself by walking down from the handler
  // would not find it.
  const INDOS_OFF = 0x0490, CRITERR_OFF = 0x048f;
  mem.w8((LOL_SEG << 4) + INDOS_OFF, 0);
  mem.w8((LOL_SEG << 4) + CRITERR_OFF, 0);

  // The INT 21h and INT 2Fh entry points, as a real DOS has them: in RAM, in the kernel segment.
  // Each is a far JMP to the service stub that still does the work — the recompiler guards those on
  // the LINEAR address, so jumping in from RAM lands on the same handler. Placed above the SFT,
  // which ends near offset 0x482.
  const K21_OFF = 0x0500, K2F_OFF = 0x0508;
  const kstub = (off, vec) => {
    const a = (LOL_SEG << 4) + off;
    mem.w8(a, 0xea); mem.w16(a + 1, vec); mem.w16(a + 3, 0xf000);   // JMP FAR F000:vec
  };
  kstub(K21_OFF, 0x21);
  kstub(K2F_OFF, 0x2f);

  // ---- System File Table --------------------------------------------------
  // DOS keeps its open files in a chain of SFT blocks, and the List of Lists points at the first
  // one (LoL+04h). A program does not have to go through INT 21h to learn about a handle: DJGPP's
  // fstat() walks the PSP's job file table to turn a handle into an SFT index, then walks the SFT
  // chain to that entry and reads the size and name straight out of it. With no SFT the walk found
  // nothing, so `open` succeeded and `fstat` returned -1 — Quake stops on
  // "Error: Error fstating c:/id1/pak0.pak" with no DOS call having reported an error at all.
  //
  // Entries are the DOS 4+ 59-byte layout, which is what our reported version (5.0) implies.
  // The SFT sits in the same segment as the List of Lists, at the offset the probe reports. Sixteen
  // entries is what fits below the environment block at 0x0C00; a real DOS chains several smaller
  // blocks instead, and a chain of one is a chain.
  const SFT_OFF = 0x00cc, SFT_ENTRIES = 16, SFT_ENTRY = 0x3b;
  const SFT_BASE = (LOL_SEG << 4) + SFT_OFF;
  const LOL = (LOL_SEG << 4) + LOL_OFF;
  for (let i = 0; i < 0xd0; i++) mem.w8(LOL + i, 0);            // the LoL fields we do not fill
  mem.w32(LOL + 0x04, ((LOL_SEG << 16) | SFT_OFF) >>> 0);       // first SFT block

  /** FCB-style 8.3 name — eight characters, three, space padded, no dot. */
  const fcbName = (path) => {
    const leaf = String(path || '').split(/[\\/]/).pop() || '';
    const dot = leaf.lastIndexOf('.');
    const stem = (dot < 0 ? leaf : leaf.slice(0, dot)).slice(0, 8).toUpperCase();
    const ext = (dot < 0 ? '' : leaf.slice(dot + 1)).slice(0, 3).toUpperCase();
    return stem.padEnd(8, ' ') + ext.padEnd(3, ' ');
  };

  /**
   * Rebuild the SFT and the current PSP's job file table from the live handle map.
   *
   * Called after every service that CHANGES the handle map, not only from AH=52h. A program does not
   * have to ask DOS about a handle: Windows 3.0's kernel opens CON five times and then reads the JFT
   * directly to map those handles to SFT entries — DOSBox's INT 21h log shows that inspection as a
   * pause with no calls at all. With the table only refreshed on AH=52h it read all zeros, did not
   * find its handles, ran the whole five-open loop a SECOND time and gave up. The reference does five
   * opens; we did ten.
   */
  function syncSFT() {
    mem.w32(SFT_BASE, 0xffffffff);                              // a single block, no next
    mem.w16(SFT_BASE + 4, SFT_ENTRIES);
    const psp = dos.psp << 4;
    for (let i = 0; i < 20; i++) mem.w8(psp + 0x18 + i, 0xff);  // JFT: every slot closed
    mem.w16(psp + 0x32, 20);                                    // its size, and where it lives —
    mem.w32(psp + 0x34, ((dos.psp << 16) | 0x18) >>> 0);        // a program may follow this instead
    for (let i = 0; i < SFT_ENTRIES; i++) {
      const e = SFT_BASE + 6 + i * SFT_ENTRY;
      for (let k = 0; k < SFT_ENTRY; k++) mem.w8(e + k, 0);
      const h = vfs.handles.get(i);
      if (!h) continue;
      mem.w8(psp + 0x18 + i, i);                                // handle i -> entry i
      const isDev = !h.node;
      mem.w16(e + 0x00, 1);                                     // handles referring to this file
      mem.w16(e + 0x02, h.write ? 2 : 0);                       // open mode
      mem.w8(e + 0x04, isDev ? 0 : 0x20);                       // attribute: archive
      mem.w16(e + 0x05, isDev ? 0x80d3 : 0);                    // device info; bit 7 = character device
      mem.w32(e + 0x11, isDev ? 0 : (h.node.data.length >>> 0));  // size
      mem.w32(e + 0x15, h.pos >>> 0);                           // current offset
      const nm = fcbName(h.path);
      for (let k = 0; k < 11; k++) mem.w8(e + 0x20 + k, nm.charCodeAt(k));
      mem.w16(e + 0x31, dos.psp);                               // owning PSP
    }
  }
  dos.syncSFT = syncSFT;

  /** Bytes of a DS:DX transfer that fit before the segment wraps. */
  const segCap = (count, off) => Math.min(count, 0x10000 - off);

  // allocTop = the top of the program block plus every live dynamic allocation. Recomputed after a
  // free/resize so reclaimed memory is actually handed back (a bump allocator that never lowered
  // allocTop made games that alloc-a-temp-then-free-it-then-alloc-the-real-heap — e.g. the SCUMM
  // interpreter — see too little free memory and bail with "Not Enough Free Memory").
  const recomputeTop = () => { let t = dos.memFloor; for (const [s, p] of dos.allocs) t = Math.max(t, s + p); dos.allocTop = t; syncMCB(); };

  // ---- MZ (.EXE) image handling, shared by all three loaders -----------------------------------
  // loadEXE, the AH=4B EXEC'd child and the AH=4B AL=03 overlay each used to carry their own copy of
  // this header parsing. They drifted: the e_maxalloc block-sizing fix (98c25f0) was only ever
  // applied to loadEXE, so an EXEC'd child still got all of memory.
  const isMZ = (b) => b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a;
  function parseMZ(bytes) {
    const rd16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    const e_cblp = rd16(2), e_cp = rd16(4), e_crlc = rd16(6), e_cparhdr = rd16(8), e_lfarlc = rd16(0x18);
    let imageBytes = e_cp * 512; if (e_cblp) imageBytes -= (512 - e_cblp);   // last page is partial
    const relocs = [];
    for (let i = 0; i < e_crlc; i++) relocs.push({ off: rd16(e_lfarlc + i * 4), seg: rd16(e_lfarlc + i * 4 + 2) });
    return { code: bytes.subarray(e_cparhdr * 16, imageBytes), relocs,
             minalloc: rd16(0x0a), maxalloc: rd16(0x0c),
             ss: rd16(0x0e), sp: rd16(0x10), ip: rd16(0x14), cs: rd16(0x16) };
  }
  /** Fix up the relocation table. `addend` is the load segment for a normal load, but the caller's
   *  own factor for an overlay (AH=4B AL=03), which relocates into a segment it already owns. */
  function applyRelocs(relocs, loadSeg, addend) {
    for (const r of relocs) {
      const a = ((loadSeg + r.seg) << 4) + r.off;
      mem.w16(a, (mem.r16(a) + addend) & 0xffff);
    }
  }
  /** Where DOS puts a program and how big its block is, from its MZ header.
   *
   *  Normally it gets PSP + image + up to maxalloc paragraphs (at least minalloc), capped at
   *  available memory, with the rest left FREE — most EXEs set maxalloc=0xFFFF (grab everything),
   *  but some (Arctic Adventure) ask for a bounded block and then AH=48-allocate above it.
   *
   *  e_maxalloc = 0 is a DIFFERENT case, not a small block: DOS hands over the whole free region and
   *  loads the IMAGE as high as it fits inside it — but the PSP stays at the BASE of that block,
   *  exactly where an ordinary program's would be. Measured against dosbox-x with tools/mzalloc.asm,
   *  which carries an ordinary-MZ control that reads identically on both engines, so the difference
   *  below is DOS's and not the probe's:
   *
   *    maxalloc=FFFF   PSP=0814 CS=0824  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000
   *    maxalloc=0000   PSP=0814 CS=9FA1  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000
   *    maxalloc=0000, KERNEL-sized image (68 KB)
   *                    PSP=0814 CS=8F21  PSP0002=9FFF  MCB=Z OWNER=0814 SIZE=97EB  free=0000
   *
   *  So only CS moves: same PSP, same block, same MCB, nothing free either way.
   *
   *  ⚠️ The earlier reading of this measurement — "the PSP goes high too" — came from the probe
   *  taking its PSP as CS - 0x10. Under "image loaded high" that points into the middle of the
   *  block, and the zeros it found there (PSP0002=0000, MCB=-) were read as DOS's answer. The probe
   *  takes the PSP from ES at entry now.
   *
   *  This is not a detail for Windows 3.0: KERNEL.EXE lays its global heap over PSP+0x10 .. PSP:0002
   *  (seg 1, 0x9260). With the PSP low that is the whole 600 KB block with the image sitting high
   *  inside it; with the PSP high it is just the image, ~67 KB, and the first GlobalAlloc fails.
   *
   *  Returns { base, psp, load, top }: the block runs base..top-1 with its MCB at base-1, and the
   *  image goes at `load` — which is base+0x10 for everyone except the e_maxalloc=0 case. */
  function placeProgram(baseSeg, h) {
    const img = Math.ceil(h.code.length / 16);                // the image alone, in paragraphs
    const need = 0x10 + img;                                  // PSP + image
    if (h.maxalloc === 0) {
      return { base: baseSeg, psp: baseSeg, load: Math.max(baseSeg + 0x10, MEM_TOP - img), top: MEM_TOP };
    }
    const want = need + Math.max(h.minalloc, h.maxalloc);
    const top = Math.min(baseSeg + Math.max(want, need + h.minalloc), MEM_TOP);
    return { base: baseSeg, psp: baseSeg, load: baseSeg + 0x10, top };
  }
  /** Entry register state for an MZ image loaded at `loadSeg` with PSP `psp`. */
  function exeEntry(psp, loadSeg, h) {
    cpu.reg.fill(0);
    cpu.setSeg(DS, psp); cpu.setSeg(ES, psp);
    cpu.setSeg(SS, (loadSeg + h.ss) & 0xffff); cpu.sp = h.sp;
    cpu.setSeg(CS, (loadSeg + h.cs) & 0xffff); cpu.eip = h.ip;
    cpu.ax = 0; cpu.dx = psp;
  }
  /** Entry register state for a .COM at `seg`. These exact values are DOSBox-documented and
   *  sizecoding intros depend on them (CX=00FF, DI=FFFE, BP=091C). */
  function comEntry(seg) {
    cpu.reg.fill(0);
    cpu.setSeg(CS, seg); cpu.setSeg(DS, seg); cpu.setSeg(ES, seg); cpu.setSeg(SS, seg);
    cpu.eip = 0x100;
    cpu.ax = 0; cpu.bx = 0; cpu.cx = 0x00ff; cpu.dx = seg;
    cpu.si = 0x0100; cpu.di = 0xfffe; cpu.bp = 0x091c;
    cpu.sp = 0xfffe; mem.w16((seg << 4) + 0xfffe, 0);   // RET → PSP:0 → INT 20h
  }

  dos.loadCOM = function (bytes, tail, progPath) {
    prep(tail, progPath);
    const seg = PSP_SEG;
    mem.blit((seg << 4) + 0x100, bytes);
    comEntry(seg);
    dos.allocTop = MEM_TOP; syncMCB();
    cpu.halted = false;
  };

  dos.loadEXE = function (bytes, tail, progPath) {
    prep(tail, progPath);
    const h = parseMZ(bytes);
    const place = placeProgram(PSP_SEG, h);
    const pspSeg = place.psp, loadSeg = place.load;
    dos.blockBase = place.base;
    mem.blit(loadSeg << 4, h.code);
    applyRelocs(h.relocs, loadSeg, loadSeg);
    exeEntry(pspSeg, loadSeg, h);
    dos.memFloor = place.top;
    // PSP:0002 = the top of the block the loader hands over. For a .COM that is the top of memory;
    // for an MZ it is bounded by e_maxalloc, and writing the top of memory there told a program that
    // sizes its heap from this word that it owned everything.
    mem.w16((pspSeg << 4) + 0x02, dos.memFloor);
    dos.allocTop = dos.memFloor; syncMCB();
    cpu.halted = false;
  };

  /** Detect format and load. bytes: Uint8Array, tail: command-line string. */
  dos.load = function (bytes, tail, progPath) {
    if (isMZ(bytes)) dos.loadEXE(bytes, tail, progPath);
    else dos.loadCOM(bytes, tail, progPath);
  };

  // ---- INT 21h AH=4B: load and execute a child program (EXEC) -------------
  // Loader-stub games (a tiny .COM that shrinks its own block then EXECs the real
  // binary — e.g. Moktar's MOKTAR.COM -> GAME.TDT) need this. We can't "run the child
  // to completion and return" synchronously, so instead: save the parent's full CPU
  // context, load + switch to the child, and let the run loop execute it. When the
  // child terminates, terminate() below pops the context and resumes the parent right
  // after its INT 21h — DOS's INT 22h return, modelled without a real IRET.
  dos.execStack = [];

  function execChild(path, pbLin) {
    const bytes = vfs.readFile(path) || vfs.readFile('\\' + path);
    if (!bytes) return 2;                                 // file not found
    // +1: the MCB header of the block being handed to the child lives in the paragraph BELOW its PSP,
    // exactly as the parent's does at PSP_SEG - 1. Putting the child's PSP on that paragraph
    // overwrote the header, and the chain then read as corrupt from there on.
    const childBase = dos.allocTop + 1;                   // first free paragraph (parent shrank via 4Ah)
    if (childBase + 0x11 >= MEM_TOP) return 8;            // no room for even a PSP+stack
    // The header has to be parsed BEFORE the child is placed: an e_maxalloc=0 child's IMAGE goes
    // high inside its block, so where it lands is a function of its own size. Its PSP does not
    // move — it sits at the block base like everyone else's.
    const childHdr = isMZ(bytes) ? parseMZ(bytes) : null;
    const childPlace = childHdr ? placeProgram(childBase, childHdr)
                                : { base: childBase, psp: childBase, load: childBase + 0x10, top: MEM_TOP };
    const childPsp = childPlace.psp;
    const envSeg = mem.r16(pbLin) || ENV_SEG;             // 0 in the param block = inherit parent's env
    setEnvProgramPath(envSeg, path.startsWith('C:') || path.startsWith('\\') ? path : 'C:\\' + path.replace(/^\\/, ''));
    const tOff = mem.r16(pbLin + 2), tSeg = mem.r16(pbLin + 4), tLin = (tSeg << 4) + tOff;
    let tail = ''; const tLen = mem.r8(tLin);
    for (let i = 0; i < tLen; i++) tail += String.fromCharCode(mem.r8(tLin + 1 + i));

    dos.execStack.push({                                  // save the parent to resume on the child's exit
      reg: Array.from(cpu.reg), seg: Array.from(cpu.seg),
      eip: cpu.eip, flags: cpu.flags, psp: dos.psp, dta: dos.dta,
      allocTop: dos.allocTop, allocs: dos.allocs, memFloor: dos.memFloor, blockBase: dos.blockBase,
    });
    dos.allocs = new Map(); dos.memFloor = MEM_TOP;        // the child gets a fresh heap
    machine.rec.reset();
    buildPSP(childPsp, tail);
    mem.w16((childPsp << 4) + 0x16, dos.psp);             // parent PSP link
    mem.w16((childPsp << 4) + 0x2c, envSeg);              // environment segment
    dos.psp = childPsp; dos.exitCode = 0;

    dos.blockBase = childPlace.base;
    let childTop = MEM_TOP;                               // a .COM child owns the rest of memory
    if (childHdr) {                                       // MZ-EXE child
      const h = childHdr, loadSeg = childPlace.load;
      mem.blit(loadSeg << 4, h.code);
      applyRelocs(h.relocs, loadSeg, loadSeg);
      exeEntry(childPsp, loadSeg, h);
      cpu.bx = childPsp;
      childTop = childPlace.top;                    // size the child's block from its own header too
      mem.w16((childPsp << 4) + 0x02, childTop);   // and its PSP:0002, once, as the loader does
    } else {                                              // .COM child (GAME.TDT is one: JMP entry, no MZ)
      mem.blit((childPsp << 4) + 0x100, bytes);
      comEntry(childPsp);
    }
    cpu.flags = 0x0202;                                   // standard entry flags (IF set)
    // The child's block is sized by its own MZ header, exactly like the parent's — this half of the
    // e_maxalloc fix (98c25f0) never made it into the EXEC path while the parser was duplicated.
    // A .COM child still owns everything, which is what DOS does.
    dos.memFloor = childTop; dos.allocTop = childTop;
    syncMCB();                                            // the child's block joins the chain
    cpu.halted = false;
    return 0;                                             // success — cpu now points at the child
  }

  // AH=4B AL=03: load an overlay. Load the EXE image at the segment the caller names in the param
  // block (word[0]) and fix its relocations by the caller's factor (word[2]) — no PSP, no allocation,
  // no register change. The caller keeps control and far-calls the overlay's entry itself. Ski or Die's
  // SKI.EXE is a chain-loader that overlays SKIEGA over itself this way.
  function loadOverlay(path, pbLin) {
    const bytes = vfs.readFile(path) || vfs.readFile('\\' + path);
    if (!bytes) return 2;
    const loadSeg = mem.r16(pbLin), relocFactor = mem.r16(pbLin + 2);
    if (isMZ(bytes)) {                                                  // MZ-EXE overlay
      const h = parseMZ(bytes);
      mem.blit(loadSeg << 4, h.code);
      applyRelocs(h.relocs, loadSeg, relocFactor);   // an overlay relocates by the CALLER's factor
    } else {
      mem.blit(loadSeg << 4, bytes);                                    // raw / .COM overlay
    }
    machine.rec.reset();                                                // the loaded region was code — flush stale compiled blocks
    return 0;
  }

  const terminate = (code) => {
    dos.exitCode = code & 0xff;
    const ctx = dos.execStack.pop();
    if (ctx) {                                            // a child of an EXEC — resume the parent
      machine.rec.reset();
      cpu.reg.set(ctx.reg);
      for (const s of [ES, CS, SS, DS]) cpu.setSeg(s, ctx.seg[s]);
      cpu.eip = ctx.eip; cpu.flags = ctx.flags & ~CF;    // EXEC succeeded → CF clear for the parent
      dos.psp = ctx.psp; dos.dta = ctx.dta; dos.allocTop = ctx.allocTop;
      dos.allocs = ctx.allocs; dos.memFloor = ctx.memFloor; dos.blockBase = ctx.blockBase;
      syncMCB();                                          // the child's block goes back to the free pool
      cpu.halted = false;
    } else { dos.programDone = true; cpu.halted = true; }
  };

  // Terminate but KEEP the program's block (AH=31h, and INT 27h for the .COM-era form). The parent
  // resumes exactly as after a normal exit; the difference is that the resident paragraphs stay
  // allocated, so the next EXEC or AH=48h loads ABOVE them instead of over a handler that is still
  // hooked into the IVT. The reservation goes into the PARENT's alloc map — the block starts one
  // paragraph below the child's PSP, which is where EXEC put its MCB header.
  const terminateResident = (code, keepPara) => {
    const psp = dos.psp, hadParent = dos.execStack.length > 0;
    terminate(code);
    if (hadParent) { dos.allocs.set(psp - 1, Math.max(1, keepPara) + 1); recomputeTop(); }
  };

  // ---- INT 20h / 21h ------------------------------------------------------
  machine.hookInterrupt(0x20, () => terminate(0));
  // An unhandled DIVIDE ERROR terminates the program. Measured, not assumed: tools/divzero.asm
  // writes a marker to a file, closes it, divides by zero, and writes a second marker — under
  // DOSBox-X only the first survives, so DOS aborts rather than resuming. MIRAGE had no INT 00h
  // handler at all, so the vector pointed at the BIOS dummy IRET, the CPU returned to the faulting
  // DIV and raised again for ever; the engine gave up with "re-raised 100000x at the same address",
  // which is an engine error where a real machine has a program that simply ended. A guest that
  // installs its own INT 00h still wins — hookInterrupt only serves vectors still pointing at us.
  machine.hookInterrupt(0x00, () => { for (const ch of 'Divide overflow\r\n') out(ch.charCodeAt(0)); terminate(0xff); });
  // INT 27h takes DX as the offset PAST the last byte to keep, in the current segment (CS == PSP for
  // the .COM programs that use it), where AH=31h takes paragraphs outright.
  machine.hookInterrupt(0x27, (cpu) => terminateResident(0, ((cpu.dx & 0xffff) + 15) >> 4));

  machine.hookInterrupt(0x21, (cpu) => {
    const ah = cpu.ah;
    // Real DOS clears CF on success. Most cases below just `break`, so without this they returned
    // with whatever CF the caller happened to have — and `stc` before `int 21h` is common enough
    // that `mov ah,30h / int 21h / jc no_dos` took the error branch. Start clear; the failure
    // paths (`err()` and the `default`) set it. A handler that must PRESERVE the caller's CF instead
    // — AH=37h is one, confirmed over 1406 captured kernel calls — restores it from here.
    const entryCF = cpu.flags & CF;
    cpu.flags &= ~CF;
    switch (ah) {
      case 0x00: terminate(0); break;
      case 0x01: { // read char with echo (blocking)
        if (!machine.keyQueue.length) return machine.block(2);
        const k = machine.keyQueue.shift(); cpu.al = k.ascii; out(k.ascii); break;
      }
      case 0x02: out(cpu.dx & 0xff); break;                          // write char (DL)
      case 0x06: {                                                   // direct console I/O
        const dl = cpu.dx & 0xff;
        if (dl === 0xff) {
          if (!machine.keyQueue.length) { cpu.flags |= ZF; cpu.al = 0; }
          else { cpu.flags &= ~ZF; cpu.al = machine.keyQueue.shift().ascii; }
        } else out(dl);
        break;
      }
      case 0x07: case 0x08: { // read char, no echo (blocking)
        if (!machine.keyQueue.length) return machine.block(2);
        cpu.al = machine.keyQueue.shift().ascii; break;
      }
      case 0x09: { // write '$'-terminated string at DS:DX
        let p = cpu.base[DS] + (cpu.dx & 0xffff);
        for (let i = 0; i < 65535; i++) { const c = mem.r8(p + i); if (c === 0x24) break; out(c); }
        cpu.al = 0x24; break;
      }
      case 0x0a: bufferedInput(); break;
      case 0x0b: cpu.al = machine.keyQueue.length ? 0xff : 0x00; break; // stdin status
      case 0x0c: { machine.keyQueue.length = 0; const fn = cpu.al; cpu.ah = fn; if (fn === 1 || fn === 7 || fn === 8) { if (!machine.keyQueue.length) return machine.block(2); cpu.al = machine.keyQueue.shift().ascii; } break; }
      case 0x0e: cpu.al = 1; break;                                  // select disk → 1 drive
      case 0x19: cpu.al = 2; break;                                  // current drive = C
      case 0x1a: dos.dta = cpu.base[DS] + (cpu.dx & 0xffff); break;  // set DTA
      // Set/get vector. For a DPMI client running in protected mode these address the client's
      // PROTECTED-MODE vector table, not the real-mode IVT: DS:(E)DX is a selector:offset. Writing
      // that to the IVT puts a selector where a segment belongs, and the IRQ then arrives through
      // realInt with a 16-bit frame. Mesha's PMODE4K installs its 32-bit timer ISR exactly here
      // (AX=2508h, DS = its code32 selector); its POPAD/IRETD epilogue popped that frame as three
      // dwords and took a garbage CS.
      case 0x25:
        if (machine.dpmi && machine.dpmi.active && (cpu.cr0 & 1)) {
          machine.dpmi.pmVec[cpu.al] = { sel: cpu.seg[DS], off: machine.dpmi.is32 ? (cpu.reg[2] >>> 0) : (cpu.dx & 0xffff) };
          break;
        }
        machine.setVector(cpu.al, cpu.seg[DS], cpu.dx & 0xffff); break;
      case 0x2a: { cpu.cx = 1990; cpu.dx = 0x0101; cpu.al = 1; break; } // get date (fixed)
      case 0x2c: {                                                    // get time
        // Derived from the BDA tick at 0040:006C, not from the host clock: the tick is advanced by
        // our own BIOS INT 8, so the time a guest reads is a function of the emulated run and stays
        // reproducible for the golden fingerprints.
        //
        // A CONSTANT here is not a harmless approximation. Windows 3.0 launching an application
        // polls AH=2Ch 439664 times waiting for it to move; with a frozen clock it waits for ever.
        const hs = Math.floor((mem.r32(0x46c) >>> 0) * 5493 / 1000) % 8640000;  // 18.2065 Hz -> 1/100 s
        cpu.cx = (((hs / 360000) | 0) << 8) | (((hs / 6000) | 0) % 60);
        cpu.dx = ((((hs / 100) | 0) % 60) << 8) | (hs % 100);
        break;
      }
      case 0x2f: { cpu.setSeg(ES, (dos.dta >> 4) & 0xffff); cpu.bx = dos.dta & 0xf; break; } // get DTA
      case 0x30: cpu.ax = (dos.version[1] << 8) | dos.version[0]; cpu.bx = 0; cpu.cx = 0; break; // version
      case 0x33: cpu.dx = 0; break;                                  // ctrl-break state
      case 0x35: {                                                    // get vector — see 0x25 above
        if (machine.dpmi && machine.dpmi.active && (cpu.cr0 & 1)) {
          const p = machine.dpmi.pmVec[cpu.al];
          if (p) { cpu.setSeg(ES, p.sel); if (machine.dpmi.is32) cpu.reg[3] = p.off >>> 0; else cpu.bx = p.off & 0xffff; break; }
        }
        const v = machine.getVector(cpu.al); cpu.setSeg(ES, v.seg); cpu.bx = v.off; break; }
      case 0x36: { cpu.ax = 4; cpu.bx = 0x4000; cpu.cx = 512; cpu.dx = 0xffff; break; } // free space
      // Directory operations. The VFS has done this all along — the shell's own MD and CD call
      // straight into it — but a *program* got "invalid function" from the default arm, so an
      // installer or a game creating its SAVES\ directory on first run was told no.
      case 0x39: {                                                   // mkdir: DS:DX = ASCIIZ path
        const p = asciiz(cpu.base[DS] + (cpu.dx & 0xffff));
        if (vfs.exists(p)) { err(5); break; }                        // 5: access denied — already there
        vfs.mkdir(p) ? ok() : err(3); break;                         // 3: path not found (bad parent)
      }
      case 0x3a: {                                                   // rmdir: DS:DX = ASCIIZ path
        const p = asciiz(cpu.base[DS] + (cpu.dx & 0xffff));
        const kids = vfs.isDir(p) ? vfs.list(p) : null;
        if (!kids) { err(3); break; }                                // 3: no such directory
        if (kids.length) { err(5); break; }                          // 5: access denied — not empty
        vfs.rmdir(p) ? ok() : err(16);                               // 16: that's the current directory
        break;
      }
      case 0x3b: vfs.chdir(asciiz(cpu.base[DS] + (cpu.dx & 0xffff))) ? ok() : err(3); break;   // chdir
      case 0x3c: { const fd = vfs.openFile(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), { create: true, truncate: true }); fd < 0 ? err(3) : (cpu.ax = fd, ok()); syncSFT(); break; }
      case 0x3d: { const fd = vfs.openFile(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), { create: false }); fd < 0 ? err(2) : (cpu.ax = fd, ok()); syncSFT(); break; }
      // Closing a standard stream (0-4) must succeed: we do not model the per-process handle table,
      // so there is nothing to free, but reporting "invalid handle" is wrong and FreeDOS's shell
      // does it five times during a boot (tools/dos-oracle.mjs).
      case 0x3e: vfs.close(cpu.bx) ? ok() : err(6); syncSFT(); break;   // close (0-4 are real entries: see VFS.openStdHandles)
      // A transfer stops at the end of the buffer's SEGMENT: DOS never wraps DS:DX and never runs on
      // past 64 KB. Keen asks for a hard-coded 0FFFFh into a buffer at offset 4 and must get 65532.
      case 0x3f: {                                                   // read
        const n = segCap(cpu.cx & 0xffff, cpu.dx & 0xffff);
        const data = vfs.read(cpu.bx, n);
        if (data === null) { err(6); break; }
        let p = cpu.base[DS] + (cpu.dx & 0xffff);
        for (let i = 0; i < data.length; i++) mem.w8(p + i, data[i]);
        cpu.ax = data.length; ok(); break;
      }
      case 0x40: {                                                   // write
        const n = segCap(cpu.cx & 0xffff, cpu.dx & 0xffff); let p = cpu.base[DS] + (cpu.dx & 0xffff);
        const dev = vfs.handles.get(cpu.bx & 0xffff);
        // stdout/stderr, or a handle opened on CON, goes to the screen; the other devices swallow it.
        if (cpu.bx === 1 || cpu.bx === 2 || (dev && dev.device === 'CON')) { for (let i = 0; i < n; i++) out(mem.r8(p + i)); cpu.ax = n; ok(); break; }
        if (dev && dev.device) { cpu.ax = n; ok(); break; }
        const buf = new Uint8Array(n); for (let i = 0; i < n; i++) buf[i] = mem.r8(p + i);
        const w = vfs.writeBytes(cpu.bx, buf); if (w === 0 && n) { err(6); break; }
        cpu.ax = w; ok(); break;
      }
      case 0x41: vfs.unlink(asciiz(cpu.base[DS] + (cpu.dx & 0xffff))) ? ok() : err(2); break; // delete
      case 0x42: { const pos = vfs.seek(cpu.bx, ((cpu.cx << 16) | cpu.dx) | 0, cpu.al); if (pos < 0) { err(6); break; } cpu.dx = (pos >>> 16) & 0xffff; cpu.ax = pos & 0xffff; ok(); break; } // lseek
      // get/set file attributes. This used to succeed unconditionally with CX=0x20, which made every
      // path a program probed look like an existing file. Turbo Pascal asks about TURBO.REZ, which is
      // not in its directory: real DOS answers "file not found" and it moves on to its next candidate,
      // where we said "here it is" and sent it to open a file that does not exist.
      case 0x43: {
        const path = asciiz((cpu.seg[DS] << 4) + (cpu.dx & 0xffff));
        if (!vfs.exists(path)) { err(2); break; }                  // 2 = file not found
        if (cpu.al === 0x01) { ok(); break; }                      // set: accepted and ignored — we store no attributes
        ok(); cpu.cx = vfs.isDir(path) ? 0x10 : 0x20;              // directory bit, else archive
        break;
      }
      case 0x44:                                                     // IOCTL — AL selects the subfunction
        // AL was ignored, so AL=06/07 (input/output status) always answered "ready". A program that
        // polls a handle until it reports ready spins forever on the answer it wanted; one that
        // polls until NOT ready never leaves. Answer per handle instead: the three standard streams
        // are character devices and always ready, a file is always ready to read and write.
        switch (cpu.al) {
          // DOS opens FIVE standard handles: 0-2 are the console streams, 3 is AUX, 4 is PRN, and all
          // five are character devices.
          // Bit 7 says "character device", and a handle opened on a driver by name is one — Wolf3D
          // opens EMMXXXX0 and abandons EMS unless this bit comes back set.
          // The word is more than its device bit. Measured with tools/ioc.asm: dosbox-x answers
          // 0x80D3 for a character device — bit 0 stdin, bit 1 stdout, bit 4 special (the INT 29h
          // fast console), bit 6 not-at-EOF, bit 7 device, bit 15 reserved-set — and a plain FILE
          // answers its drive number with bit 7 CLEAR. We answered a bare 0x0080 for devices and 0
          // for files, so a program reading the flags saw a device that was neither stdin nor
          // stdout and was sitting at EOF.
          case 0x00: {
            const hd = vfs.handles.get(cpu.bx & 0xffff);
            const isDev = (cpu.bx & 0xffff) <= 4 || (hd && hd.device);
            cpu.dx = isDev ? 0x80d3 : (2 & 0x3f);        // files: the drive they live on (C: = 2)
            cpu.ax = cpu.dx; ok(); break;
          }
          case 0x01: ok(); break;                                                        // set device info
          case 0x06: case 0x07:                                                          // input / output status
            cpu.al = (cpu.bx <= 4 || vfs.handles.has(cpu.bx & 0xffff)) ? 0xff : 0x00;    // FF = ready, 00 = not
            if (cpu.bx > 4 && !vfs.handles.has(cpu.bx & 0xffff)) { err(6); break; }       // invalid handle
            ok(); break;
          case 0x08: cpu.ax = 1; ok(); break;                                            // removable? 1 = fixed
          // Windows 3.0's Program Manager asks these two about the drive holding PROGMAN.INI before
          // it will use the file, and loops — open, 19h, 4409h, 4408h, 440Eh, 5700h, close, again —
          // as long as either answers "invalid function". Both are cheap and both have one right
          // answer for a local, single-letter drive.
          case 0x09: cpu.dx = 0; ok(); break;    // block device remote? DX bit 12 clear = local
          case 0x0e: cpu.al = 0; ok(); break;    // logical drive map: 0 = this letter is the only one
          default: err(1); break;
        }
        break;
      case 0x47: { let p = cpu.base[DS] + (cpu.si & 0xffff); const s = vfs.cwd.join('\\'); for (let i = 0; i < s.length; i++) mem.w8(p + i, s.charCodeAt(i)); mem.w8(p + s.length, 0); ok(); break; } // get cwd
      case 0x48: {                                                   // allocate a block
        const par = cpu.bx & 0xffff;
        // The size reported on failure is the largest block that could actually be HANDED OUT, so it
        // excludes the paragraph its MCB header would take. Ours reported the raw span, which is one
        // more than our own MCB chain says — the allocator and the chain disagreed with each other.
        const avail = Math.max(0, MEM_TOP - dos.allocTop - 1);
        if (par > avail) { err(8); cpu.bx = avail; break; }
        const seg = dos.allocTop; dos.allocs.set(seg, par); dos.allocTop = seg + par; syncMCB(); cpu.ax = seg; ok(); break;
      }
      case 0x49: {                                                   // free a block (reclaims)
        // Freeing a segment we never handed out used to report success, so a double free — or a
        // free of a bogus pointer — looked fine and quietly left the allocator's idea of memory
        // wrong. Real DOS returns error 9, "invalid memory block address".
        const seg = cpu.seg[ES];
        if (!dos.allocs.has(seg)) { err(9); break; }
        dos.allocs.delete(seg); recomputeTop(); ok(); break;
      }
      // The SFT is rebuilt HERE rather than kept in step on every file call: a program walks it
      // immediately after asking for the List of Lists, and rebuilding 20 entries on every read
      // would be paid by every program to serve the few that look.
      case 0x52: { syncSFT(); cpu.setSeg(ES, LOL_SEG); cpu.bx = LOL_OFF; break; }  // get list of lists (SysVars); [ES:BX-2] = first MCB
      // The three below were picked from tools/survey-gaps.mjs, not from reading the code: they are
      // what the corpus actually calls and did not get.
      // Found by tools/dos-oracle.mjs, not by the corpus survey: no game we have calls these, but a
      // real DOS environment leans on them — FreeDOS's own shell asks for the switch character 1406
      // times during a single boot. Note the convention these three share: AH is left alone and AL
      // carries the status, so writing the whole of AX would be wrong.
      case 0x37:                                                     // get/set switch character
        if (cpu.al === 0x00) { cpu.al = 0; cpu.dx = (cpu.dx & 0xff00) | dos.switchChar; }
        else if (cpu.al === 0x01) { dos.switchChar = cpu.dx & 0xff; cpu.al = 0; }
        else if (cpu.al === 0x02) { cpu.al = 0; cpu.dx = (cpu.dx & 0xff00) | 0; }   // device-availability char (obsolete)
        else if (cpu.al === 0x03) { cpu.al = 0; }
        else cpu.al = 0xff;
        // The kernel leaves CF exactly as the caller had it — 1406 captured calls, CF preserved in
        // every one (tools/dos-oracle.mjs) — so undo the dispatch head's clear rather than ok().
        cpu.flags |= entryCF;
        break;
      case 0x2b: {                                                   // set date: CX=year DH=month DL=day
        const y = cpu.cx & 0xffff, mo = (cpu.dx >> 8) & 0xff, d = cpu.dx & 0xff;
        const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (y < 1980 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]) { cpu.al = 0xff; ok(); break; }
        dos.date = { y, mo, d };
        cpu.al = 0; ok(); break;
      }
      case 0x2d: {                                                   // set time: CH:CL=h:m DH:DL=s:hundredths
        const h = (cpu.cx >> 8) & 0xff, mi = cpu.cx & 0xff, sec = (cpu.dx >> 8) & 0xff, hs = cpu.dx & 0xff;
        if (h > 23 || mi > 59 || sec > 59 || hs > 99) { cpu.al = 0xff; ok(); break; }
        dos.time = { h, mi, sec, hs };
        cpu.al = 0; ok(); break;
      }
      // AH=DCh — MS-NET "get station number". No network here, so the station is 0, and AL is what
      // matters: Windows 3.0's kernel calls AH=30h straight after WITHOUT reloading AL, so whatever
      // DCh leaves there selects which version query it makes. Leaving AL alone sent it down the
      // OEM path (30h/01h) and it concluded "Incorrect DOS version". Compared against DOSBox-X,
      // which answers AL=0 and gets 30h/00h — the sequences agree for twelve calls once we do too.
      case 0xdc: cpu.al = 0; cpu.cx = 0; ok(); break;
      case 0x62: cpu.bx = dos.psp; ok(); break;                      // get PSP — Jazz, Keen1, Loom, ROC, Ski or Die
      // 51h is the older twin of 62h, and 50h its setter. An extender moves the current PSP around
      // the client it loads, so it needs both halves: a getter alone loses the set silently.
      case 0x51: cpu.bx = dos.psp; ok(); break;
      case 0x50: dos.psp = cpu.bx & 0xffff; ok(); break;
      case 0x29: {                                                   // parse filename into an FCB — Ski or Die
        // DS:SI = text, ES:DI = FCB. Fill drive (0 = default, else 1-based), then the 8.3 name
        // blank-padded and uppercased. AL returns 1 if the name held a wildcard, else 0; SI is left
        // past the last character consumed, which is what a caller parsing a command tail relies on.
        let p = cpu.base[DS] + (cpu.si & 0xffff);
        const start = p;
        const skipLead = cpu.al & 1;
        if (skipLead) while (mem.r8(p) === 0x20 || mem.r8(p) === 0x09) p++;
        const isSep = (ch) => ch === 0 || ' \t.:;,=+<>|/"[]'.includes(String.fromCharCode(ch));
        const fcb = cpu.base[ES] + (cpu.di & 0xffff);
        let drive = 0;
        if (mem.r8(p + 1) === 0x3a) {                                // "X:" drive prefix
          drive = (String.fromCharCode(mem.r8(p)).toUpperCase().charCodeAt(0) - 64) & 0xff;
          p += 2;
        }
        mem.w8(fcb, drive);
        let wild = 0;
        const field = (len, off) => {
          for (let i = 0; i < len; i++) mem.w8(fcb + off + i, 0x20);
          for (let i = 0; i < len; ) {
            const ch = mem.r8(p);
            if (isSep(ch)) break;
            p++;
            if (ch === 0x3f) { wild = 1; mem.w8(fcb + off + i, 0x3f); i++; }
            else if (ch === 0x2a) { wild = 1; for (; i < len; i++) mem.w8(fcb + off + i, 0x3f); }
            else { mem.w8(fcb + off + i, String.fromCharCode(ch).toUpperCase().charCodeAt(0)); i++; }
          }
          while (!isSep(mem.r8(p))) p++;                             // drop anything past the field
        };
        field(8, 1);
        if (mem.r8(p) === 0x2e) { p++; field(3, 9); } else for (let i = 0; i < 3; i++) mem.w8(fcb + 9 + i, 0x20);
        for (let i = 0; i < 25; i++) mem.w8(fcb + 12 + i, 0);        // current block/size/date fields
        cpu.al = wild;
        cpu.si = (cpu.si & 0xffff) + (p - start);
        break;                                                       // AH=29h does not use CF
      }
      case 0x38: {                                                   // get country info — OMF
        // AL=00 asks for the current country. We are a US machine: MM/DD/YY, '$', decimal '.', and
        // 12-hour time off. The caller reads the 34-byte block at DS:DX; BX returns the country code.
        if ((cpu.dx & 0xffff) === 0xffff) { err(2); break; }         // set-country form: no such country
        let p = cpu.base[DS] + (cpu.dx & 0xffff);
        for (let i = 0; i < 34; i++) mem.w8(p + i, 0);
        mem.w16(p, 0);                                               // date format 0 = MM/DD/YY
        mem.w8(p + 2, 0x24);                                         // currency symbol "$"
        mem.w8(p + 7, 0x2c);                                         // thousands separator ","
        mem.w8(p + 9, 0x2e);                                         // decimal separator "."
        mem.w8(p + 11, 0x2d);                                        // date separator "-"
        mem.w8(p + 13, 0x3a);                                        // time separator ":"
        mem.w8(p + 17, 2);                                           // currency: 2 decimal places
        cpu.bx = 1;                                                  // country code 1 = USA
        ok(); break;
      }
      case 0x58:                                                     // get/set memory allocation strategy
        // MathRescue/WordRescue set it before allocating. Our allocator is a bump allocator, so
        // there is no first/best/last fit to honour — we remember the value and hand it back, which
        // is what the caller checks. Reporting failure here would be worse: the program concludes
        // it is on a DOS too old to ask.
        if (cpu.al === 0x00) { cpu.ax = dos.allocStrategy; ok(); }
        else if (cpu.al === 0x01) { dos.allocStrategy = cpu.bx & 0xffff; ok(); }
        else if (cpu.al === 0x02) { cpu.ax = dos.umbLink; ok(); }     // UMB link state (we have no UMBs)
        else if (cpu.al === 0x03) { dos.umbLink = cpu.bx & 1; ok(); }
        else err(1);
        break;
      case 0x34:                                                     // get InDOS flag address -> ES:BX
        // Keen1 reads it. A TSR uses the flag to know whether DOS is re-entrant right now; since our
        // INT 21h handlers are atomic JS, it is always 0 — but the pointer has to be real, because
        // the caller dereferences it.
        cpu.setSeg(ES, LOL_SEG); cpu.bx = INDOS_OFF; ok(); break;
      case 0x4a: {                                                   // resize memory block
        const seg = cpu.seg[ES], want = cpu.bx & 0xffff, maxPar = MEM_TOP - seg;
        if (want > maxPar) { err(8); cpu.bx = maxPar; break; }        // not enough memory; report the max
        if (dos.allocs.has(seg)) dos.allocs.set(seg, want);           // resizing a dynamic block
        else if (seg === dos.psp) dos.memFloor = seg + want;          // the *current* program (parent OR an EXEC'd child)
                                                                      // shrinks/grows its own block — needed so a child
                                                                      // can free memory for its own sub-EXEC (Pinball
                                                                      // Fantasies' multi-stage launcher chains EXECs)
        recomputeTop();
        ok(); break;
      }
      case 0x4b: {                                                   // EXEC: AL=00 load & run, AL=03 load overlay
        const path = asciiz(cpu.base[DS] + (cpu.dx & 0xffff));
        const pb = cpu.base[ES] + (cpu.bx & 0xffff);
        if (cpu.al === 3) { const rc = loadOverlay(path, pb); if (rc) err(rc); else ok(); break; }
        if (cpu.al !== 0) { err(1); break; }
        const rc = execChild(path, pb);
        if (rc) err(rc);   // failure → CF=1, AX=error (parent context untouched); success switched to the child
        break;
      }
      case 0x31: terminateResident(cpu.al, cpu.dx & 0xffff); break;  // TSR — keep DX paragraphs
      case 0x4c: terminate(cpu.al); break;                           // terminate w/ code
      case 0x4d: cpu.ax = dos.exitCode; break;                       // get return code
      case 0x4e: findFirst(); break;
      case 0x4f: findNext(); break;
      case 0x56: vfs.rename(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), asciiz(cpu.base[ES] + (cpu.di & 0xffff))) ? ok() : err(2); break;
      case 0x57: {                                                   // get/set file date & time
        const hnd = vfs.handles.get(cpu.bx & 0xffff);
        if (!hnd) { err(6); break; }
        if (cpu.al === 1) { if (hnd.node) hnd.node.mtime = (((cpu.dx & 0xffff) << 16) | (cpu.cx & 0xffff)) >>> 0; ok(); break; }
        // Character devices have no timestamp; DOS still answers without error.
        const t = hnd.node ? hnd.node.mtime >>> 0 : DOS_MTIME;
        cpu.cx = t & 0xffff; cpu.dx = (t >>> 16) & 0xffff; ok(); break;
      }
      // Unsupported function. Reporting "invalid function" is at least an honest failure, but the
      // count is what makes the gap visible: `dos.unhandledFnReport()` over the whole games/ tree
      // says which functions are actually missing instead of us guessing from a reading of the code.
      default: dos.unhandledFn[ah]++; setCF(true); cpu.ax = 1; break;
    }
  });

  function bufferedInput() {
    const p = cpu.base[DS] + (cpu.dx & 0xffff);
    const max = mem.r8(p);
    let cnt = mem.r8(p + 1);
    while (machine.keyQueue.length) {
      const k = machine.keyQueue.shift();
      if (k.ascii === 0x0d) { mem.w8(p + 2 + cnt, 0x0d); mem.w8(p + 1, cnt); out(0x0d); out(0x0a); return; }
      if (k.ascii === 0x08) { if (cnt > 0) { cnt--; out(0x08); out(0x20); out(0x08); } continue; }
      if (cnt < max - 1) { mem.w8(p + 2 + cnt, k.ascii); cnt++; out(k.ascii); }
    }
    mem.w8(p + 1, cnt);
    machine.block(2);   // wait for the rest of the line
  }

  function wildcardToRegExp(spec) {
    const esc = spec.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + esc + '$', 'i');
  }

  function fillDTA(node) {
    const d = dos.dta;
    mem.w8(d + 0x15, node.attr);
    mem.w16(d + 0x16, 0); mem.w16(d + 0x18, 0x21);     // time / date
    mem.w32(d + 0x1a, node.type === 'file' ? node.data.length : 0);
    const name = node.name; let i = 0;
    for (; i < name.length && i < 12; i++) mem.w8(d + 0x1e + i, name.charCodeAt(i));
    mem.w8(d + 0x1e + i, 0);
  }

  function findFirst() {
    const spec = asciiz(cpu.base[DS] + (cpu.dx & 0xffff));
    const slash = Math.max(spec.lastIndexOf('\\'), spec.lastIndexOf('/'));
    const dir = slash >= 0 ? spec.slice(0, slash + 1) : '.';
    const pat = (slash >= 0 ? spec.slice(slash + 1) : spec) || '*.*';
    const re = wildcardToRegExp(pat === '*.*' ? '*' : pat);
    const entries = vfs.list(dir) || [];
    dos.findList = entries.filter(e => re.test(e.name) || (pat === '*.*'));
    dos.findIdx = 0;
    findNext();
  }
  function findNext() {
    if (dos.findIdx >= dos.findList.length) { err(18); return; }   // no more files
    fillDTA(dos.findList[dos.findIdx++]); ok();
  }

  // Repoint the vectors LAST: hookInterrupt() sets them to BIOS_SEG:n, and XMS and DPMI hook INT 2Fh
  // after DOS does, so doing this any earlier would be undone by whichever installed next.
  machine.dosKernelSeg = LOL_SEG;          // swInt must recognise this as ours — see machine.js
  // ⚠️ OPT-IN. Pointing the vectors at the RAM trampolines is what makes Windows 3.0 real mode stop
  // refusing — measured: with them in ROM it prints "Incorrect DOS version", with them in RAM it does
  // not. But it also changes four bytes of the IVT, and two 256-byte intros read the vector table as
  // data: `intros/oktaeder.com` then DERAILS (INT 05h re-raised, the decoder walking in 0x180 steps)
  // and `intros/mesha.com` renders differently. Golden goes 43 -> 41. Isolated: moving the InDOS flag
  // costs nothing, the four IVT bytes cost both.
  //
  // Left off by default because oktaeder's is a FAULT, not a fingerprint drift — that is a functional
  // regression, not a re-baselining question. A real DOS does keep these in RAM (FreeDOS answers
  // INT21=00D8:129A), so the flag is the correct behaviour and the default is the safe one.
  if (process.env.MIRAGE_DOSKSEG) {
    machine.setVector(0x21, LOL_SEG, K21_OFF);
    machine.setVector(0x2f, LOL_SEG, K2F_OFF);
  }

  machine.dos = dos;
  return dos;
}

export { PSP_SEG, ENV_SEG, MEM_TOP };
