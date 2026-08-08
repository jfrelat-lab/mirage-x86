// dos.js — the DOS kernel: INT 21h services, the Program Segment Prefix, a bump
// memory allocator, and the COM / MZ-EXE program loaders (with relocation).
// Console I/O is routed through the BIOS text routines so guest output and the
// JS shell render identically. File I/O is backed by the VFS.

import { CF, ZF, CS, DS, ES, SS } from './cpu.js';

const PSP_SEG = 0x0100;     // first program's PSP   (linear 0x1000)
const ENV_SEG = 0x00c0;     // environment block     (linear 0x0C00)
const MEM_TOP = 0xa000;     // end of conventional memory (640K), in paragraphs

export function installDOS(machine, vfs) {
  const mem = machine.mem, cpu = machine.cpu;
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
    programDone: false,
    exitCode: 0,
    findList: [], findIdx: 0,
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
    mem.w16(p, 1); p += 2;          // count of following strings
    for (let i = 0; i < progPath.length; i++) mem.w8(p++, progPath.charCodeAt(i)); mem.w8(p++, 0);
  }

  function buildPSP(seg, tail) {
    const b = seg << 4;
    for (let i = 0; i < 256; i++) mem.w8(b + i, 0);
    mem.w8(b + 0x00, 0xcd); mem.w8(b + 0x01, 0x20);   // INT 20h
    mem.w16(b + 0x02, MEM_TOP);                        // top of memory (paragraphs)
    mem.w8(b + 0x05, 0xcd); mem.w8(b + 0x06, 0x21); mem.w8(b + 0x07, 0xcb); // INT 21h; RETF
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
    const top = Math.min(dos.allocTop | 0, MEM_TOP);
    const hasFree = top < MEM_TOP - 1;
    writeMCB(PSP_SEG - 1, hasFree ? 0x4d : 0x5a, PSP_SEG, top - PSP_SEG);   // program block: 'M', or 'Z' if it owns all of memory
    if (hasFree) writeMCB(top, 0x5a, 0x0000, MEM_TOP - top - 1);            // free block: 'Z' (last), owner 0
    mem.w16((DIB_SEG << 4) + DIB_OFF - 2, PSP_SEG - 1);                     // list-of-lists: word before it = first MCB (the program's, at PSP-1)
  };
  dos.syncMCB = syncMCB;
  // INT 21h AH=52 "get list of lists" (SysVars) hands back ES:BX; the word at [ES:BX-2] is the
  // first MCB segment — the standard way MCB-walkers find the chain head. We host it in unused
  // low memory just past the BIOS data area.
  const DIB_SEG = 0x0050, DIB_OFF = 0x0026;
  // InDOS flag (AH=34h) and, one byte below it as DOS lays them out, the critical-error flag. Kept
  // in the same scratch paragraph as the list-of-lists, clear of the MCB-head word at DIB_OFF-2.
  const INDOS_OFF = 0x0021, CRITERR_OFF = 0x0020;
  mem.w8((DIB_SEG << 4) + INDOS_OFF, 0);
  mem.w8((DIB_SEG << 4) + CRITERR_OFF, 0);

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
  /** Size a program's memory block from its MZ header: DOS gives it PSP + image + up to maxalloc
   *  paragraphs (at least minalloc), capped at available memory, and leaves the rest FREE. Most EXEs
   *  set maxalloc=0xFFFF (grab everything), but some — Arctic Adventure — ask for a bounded block and
   *  then AH=48-allocate from the free memory above, which fails if we hand them all of RAM. */
  function sizeBlock(pspSeg, h) {
    const need = 0x10 + Math.ceil(h.code.length / 16);        // PSP + image, in paragraphs
    const want = need + Math.max(h.minalloc, h.maxalloc);
    return Math.min(pspSeg + Math.max(want, need + h.minalloc), MEM_TOP);
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
    const pspSeg = PSP_SEG, loadSeg = pspSeg + 0x10;
    mem.blit(loadSeg << 4, h.code);
    applyRelocs(h.relocs, loadSeg, loadSeg);
    exeEntry(pspSeg, loadSeg, h);
    dos.memFloor = sizeBlock(pspSeg, h);
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
    const childPsp = dos.allocTop;                        // first free paragraph (parent shrank via 4Ah)
    if (childPsp + 0x11 >= MEM_TOP) return 8;             // no room for even a PSP+stack
    const envSeg = mem.r16(pbLin) || ENV_SEG;             // 0 in the param block = inherit parent's env
    const tOff = mem.r16(pbLin + 2), tSeg = mem.r16(pbLin + 4), tLin = (tSeg << 4) + tOff;
    let tail = ''; const tLen = mem.r8(tLin);
    for (let i = 0; i < tLen; i++) tail += String.fromCharCode(mem.r8(tLin + 1 + i));

    dos.execStack.push({                                  // save the parent to resume on the child's exit
      reg: Array.from(cpu.reg), seg: Array.from(cpu.seg),
      eip: cpu.eip, flags: cpu.flags, psp: dos.psp, dta: dos.dta,
      allocTop: dos.allocTop, allocs: dos.allocs, memFloor: dos.memFloor,
    });
    dos.allocs = new Map(); dos.memFloor = MEM_TOP;        // the child gets a fresh heap
    machine.rec.reset();
    buildPSP(childPsp, tail);
    mem.w16((childPsp << 4) + 0x16, dos.psp);             // parent PSP link
    mem.w16((childPsp << 4) + 0x2c, envSeg);              // environment segment
    dos.psp = childPsp; dos.exitCode = 0;

    let childTop = MEM_TOP;                               // a .COM child owns the rest of memory
    if (isMZ(bytes)) {                                    // MZ-EXE child
      const h = parseMZ(bytes), loadSeg = childPsp + 0x10;
      mem.blit(loadSeg << 4, h.code);
      applyRelocs(h.relocs, loadSeg, loadSeg);
      exeEntry(childPsp, loadSeg, h);
      cpu.bx = childPsp;
      childTop = sizeBlock(childPsp, h);            // size the child's block from its own header too
    } else {                                              // .COM child (GAME.TDT is one: JMP entry, no MZ)
      mem.blit((childPsp << 4) + 0x100, bytes);
      comEntry(childPsp);
    }
    cpu.flags = 0x0202;                                   // standard entry flags (IF set)
    // The child's block is sized by its own MZ header, exactly like the parent's — this half of the
    // e_maxalloc fix (98c25f0) never made it into the EXEC path while the parser was duplicated.
    // A .COM child still owns everything, which is what DOS does.
    dos.memFloor = childTop; dos.allocTop = childTop;
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
      dos.allocs = ctx.allocs; dos.memFloor = ctx.memFloor;
      cpu.halted = false;
    } else { dos.programDone = true; cpu.halted = true; }
  };

  // ---- INT 20h / 21h ------------------------------------------------------
  machine.hookInterrupt(0x20, () => terminate(0));

  machine.hookInterrupt(0x21, (cpu) => {
    const ah = cpu.ah;
    // Real DOS clears CF on success. Most cases below just `break`, so without this they returned
    // with whatever CF the caller happened to have — and `stc` before `int 21h` is common enough
    // that `mov ah,30h / int 21h / jc no_dos` took the error branch. Start clear; the failure
    // paths (`err()` and the `default`) set it.
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
      case 0x25: machine.setVector(cpu.al, cpu.seg[DS], cpu.dx & 0xffff); break; // set vector
      case 0x2a: { cpu.cx = 1990; cpu.dx = 0x0101; cpu.al = 1; break; } // get date (fixed)
      case 0x2c: { cpu.cx = 0; cpu.dx = 0; break; }                  // get time (fixed)
      case 0x2f: { cpu.setSeg(ES, (dos.dta >> 4) & 0xffff); cpu.bx = dos.dta & 0xf; break; } // get DTA
      case 0x30: cpu.ax = (dos.version[1] << 8) | dos.version[0]; cpu.bx = 0; cpu.cx = 0; break; // version
      case 0x33: cpu.dx = 0; break;                                  // ctrl-break state
      case 0x35: { const v = machine.getVector(cpu.al); cpu.setSeg(ES, v.seg); cpu.bx = v.off; break; } // get vector
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
      case 0x3c: { const fd = vfs.openFile(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), { create: true, truncate: true }); fd < 0 ? err(3) : (cpu.ax = fd, ok()); break; }
      case 0x3d: { const fd = vfs.openFile(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), { create: false }); fd < 0 ? err(2) : (cpu.ax = fd, ok()); break; }
      case 0x3e: vfs.close(cpu.bx) ? ok() : err(6); break;            // close
      case 0x3f: {                                                   // read
        const data = vfs.read(cpu.bx, cpu.cx & 0xffff);
        if (data === null) { err(6); break; }
        let p = cpu.base[DS] + (cpu.dx & 0xffff);
        for (let i = 0; i < data.length; i++) mem.w8(p + i, data[i]);
        cpu.ax = data.length; ok(); break;
      }
      case 0x40: {                                                   // write
        const n = cpu.cx & 0xffff; let p = cpu.base[DS] + (cpu.dx & 0xffff);
        if (cpu.bx === 1 || cpu.bx === 2) { for (let i = 0; i < n; i++) out(mem.r8(p + i)); cpu.ax = n; ok(); break; }
        const buf = new Uint8Array(n); for (let i = 0; i < n; i++) buf[i] = mem.r8(p + i);
        const w = vfs.writeBytes(cpu.bx, buf); if (w === 0 && n) { err(6); break; }
        cpu.ax = w; ok(); break;
      }
      case 0x41: vfs.unlink(asciiz(cpu.base[DS] + (cpu.dx & 0xffff))) ? ok() : err(2); break; // delete
      case 0x42: { const pos = vfs.seek(cpu.bx, ((cpu.cx << 16) | cpu.dx) | 0, cpu.al); if (pos < 0) { err(6); break; } cpu.dx = (pos >>> 16) & 0xffff; cpu.ax = pos & 0xffff; ok(); break; } // lseek
      case 0x43: { ok(); cpu.cx = 0x20; break; }                     // get/set attr (stub)
      case 0x44: { cpu.ax = 0; cpu.dx = (cpu.bx <= 2) ? 0x80 : 0; ok(); break; } // ioctl
      case 0x47: { let p = cpu.base[DS] + (cpu.si & 0xffff); const s = vfs.cwd.join('\\'); for (let i = 0; i < s.length; i++) mem.w8(p + i, s.charCodeAt(i)); mem.w8(p + s.length, 0); ok(); break; } // get cwd
      case 0x48: {                                                   // allocate a block
        const par = cpu.bx & 0xffff;
        if (dos.allocTop + par > MEM_TOP) { err(8); cpu.bx = MEM_TOP - dos.allocTop; break; }
        const seg = dos.allocTop; dos.allocs.set(seg, par); dos.allocTop = seg + par; syncMCB(); cpu.ax = seg; ok(); break;
      }
      case 0x49: { dos.allocs.delete(cpu.seg[ES]); recomputeTop(); ok(); break; } // free (reclaims)
      case 0x52: { cpu.setSeg(ES, DIB_SEG); cpu.bx = DIB_OFF; break; }             // get list of lists (SysVars); [ES:BX-2] = first MCB
      // The three below were picked from tools/survey-gaps.mjs, not from reading the code: they are
      // what the corpus actually calls and did not get.
      case 0x62: cpu.bx = dos.psp; ok(); break;                      // get PSP — Jazz, Keen1, Loom, ROC, Ski or Die
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
        cpu.setSeg(ES, DIB_SEG); cpu.bx = INDOS_OFF; ok(); break;
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
      case 0x4c: terminate(cpu.al); break;                           // terminate w/ code
      case 0x4d: cpu.ax = dos.exitCode; break;                       // get return code
      case 0x4e: findFirst(); break;
      case 0x4f: findNext(); break;
      case 0x56: vfs.rename(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), asciiz(cpu.base[ES] + (cpu.di & 0xffff))) ? ok() : err(2); break;
      case 0x57: ok(); cpu.cx = 0; cpu.dx = 0; break;                // get/set file time (stub)
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

  machine.dos = dos;
  return dos;
}

export { PSP_SEG, ENV_SEG, MEM_TOP };
