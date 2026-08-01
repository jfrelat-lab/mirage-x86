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
    allocTop: PSP_SEG,
    allocs: new Map(),        // live AH=48 allocations: seg → paragraphs
    memFloor: MEM_TOP,        // bump base above the program's own block
    programDone: false,
    exitCode: 0,
    findList: [], findIdx: 0,
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
    buildEnv(progPath || 'C:\\PROGRAM');
    buildPSP(PSP_SEG, tail);
  }
  // allocTop = the top of the program block plus every live dynamic allocation. Recomputed after a
  // free/resize so reclaimed memory is actually handed back (a bump allocator that never lowered
  // allocTop made games that alloc-a-temp-then-free-it-then-alloc-the-real-heap — e.g. the SCUMM
  // interpreter — see too little free memory and bail with "Not Enough Free Memory").
  const recomputeTop = () => { let t = dos.memFloor; for (const [s, p] of dos.allocs) t = Math.max(t, s + p); dos.allocTop = t; };

  dos.loadCOM = function (bytes, tail, progPath) {
    prep(tail, progPath);
    const seg = PSP_SEG;
    mem.blit((seg << 4) + 0x100, bytes);
    cpu.setSeg(CS, seg); cpu.setSeg(DS, seg); cpu.setSeg(ES, seg); cpu.setSeg(SS, seg);
    cpu.reg.fill(0);
    cpu.eip = 0x100;
    // Match DOSBox's documented COM-entry register state — sizecoding intros rely on
    // these exact values (e.g. CX=00FF, DI=FFFE) for their initial loops/effects.
    cpu.ax = 0; cpu.bx = 0; cpu.cx = 0x00ff; cpu.dx = seg;
    cpu.si = 0x0100; cpu.di = 0xfffe; cpu.bp = 0x091c;
    cpu.sp = 0xfffe; mem.w16((seg << 4) + 0xfffe, 0); // RET → PSP:0 → INT 20h
    dos.allocTop = MEM_TOP;
    cpu.halted = false;
  };

  dos.loadEXE = function (bytes, tail, progPath) {
    prep(tail, progPath);
    const rd16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    const e_cblp = rd16(2), e_cp = rd16(4), e_crlc = rd16(6), e_cparhdr = rd16(8);
    const e_ss = rd16(0x0e), e_sp = rd16(0x10), e_ip = rd16(0x14), e_cs = rd16(0x16);
    const e_lfarlc = rd16(0x18);
    const headerBytes = e_cparhdr * 16;
    let imageBytes = e_cp * 512; if (e_cblp) imageBytes -= (512 - e_cblp);
    const code = bytes.subarray(headerBytes, imageBytes);

    const pspSeg = PSP_SEG, loadSeg = pspSeg + 0x10;
    mem.blit(loadSeg << 4, code);
    for (let i = 0; i < e_crlc; i++) {                 // apply relocations
      const off = rd16(e_lfarlc + i * 4), seg = rd16(e_lfarlc + i * 4 + 2);
      const a = ((loadSeg + seg) << 4) + off;
      mem.w16(a, (mem.r16(a) + loadSeg) & 0xffff);
    }
    cpu.reg.fill(0);
    cpu.setSeg(DS, pspSeg); cpu.setSeg(ES, pspSeg);
    cpu.setSeg(SS, (loadSeg + e_ss) & 0xffff); cpu.sp = e_sp;
    cpu.setSeg(CS, (loadSeg + e_cs) & 0xffff); cpu.eip = e_ip;
    cpu.dx = pspSeg; cpu.ax = 0;
    dos.allocTop = MEM_TOP;
    cpu.halted = false;
  };

  /** Detect format and load. bytes: Uint8Array, tail: command-line string. */
  dos.load = function (bytes, tail, progPath) {
    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) dos.loadEXE(bytes, tail, progPath);
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

    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {   // MZ-EXE child
      const rd16 = (o) => bytes[o] | (bytes[o + 1] << 8);
      const e_cblp = rd16(2), e_cp = rd16(4), e_crlc = rd16(6), e_cparhdr = rd16(8);
      const e_ss = rd16(0x0e), e_sp = rd16(0x10), e_ip = rd16(0x14), e_cs = rd16(0x16), e_lfarlc = rd16(0x18);
      let imageBytes = e_cp * 512; if (e_cblp) imageBytes -= (512 - e_cblp);
      const code = bytes.subarray(e_cparhdr * 16, imageBytes);
      const loadSeg = childPsp + 0x10;
      mem.blit(loadSeg << 4, code);
      for (let i = 0; i < e_crlc; i++) { const a = ((loadSeg + rd16(e_lfarlc + i * 4 + 2)) << 4) + rd16(e_lfarlc + i * 4); mem.w16(a, (mem.r16(a) + loadSeg) & 0xffff); }
      cpu.reg.fill(0);
      cpu.setSeg(DS, childPsp); cpu.setSeg(ES, childPsp);
      cpu.setSeg(SS, (loadSeg + e_ss) & 0xffff); cpu.sp = e_sp;
      cpu.setSeg(CS, (loadSeg + e_cs) & 0xffff); cpu.eip = e_ip;
      cpu.ax = 0; cpu.bx = childPsp; cpu.dx = childPsp;
    } else {                                              // .COM child (GAME.TDT is one: JMP entry, no MZ)
      mem.blit((childPsp << 4) + 0x100, bytes);
      cpu.reg.fill(0);
      cpu.setSeg(CS, childPsp); cpu.setSeg(DS, childPsp); cpu.setSeg(ES, childPsp); cpu.setSeg(SS, childPsp);
      cpu.eip = 0x100;
      cpu.ax = 0; cpu.bx = 0; cpu.cx = 0x00ff; cpu.dx = childPsp;
      cpu.si = 0x0100; cpu.di = 0xfffe; cpu.bp = 0x091c;
      cpu.sp = 0xfffe; mem.w16((childPsp << 4) + 0xfffe, 0);
    }
    cpu.flags = 0x0202;                                   // standard entry flags (IF set)
    dos.allocTop = MEM_TOP;                               // the child owns the rest of memory
    cpu.halted = false;
    return 0;                                             // success — cpu now points at the child
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
        const seg = dos.allocTop; dos.allocs.set(seg, par); dos.allocTop = seg + par; cpu.ax = seg; ok(); break;
      }
      case 0x49: { dos.allocs.delete(cpu.seg[ES]); recomputeTop(); ok(); break; } // free (reclaims)
      case 0x4a: {                                                   // resize memory block
        const seg = cpu.seg[ES], want = cpu.bx & 0xffff, maxPar = MEM_TOP - seg;
        if (want > maxPar) { err(8); cpu.bx = maxPar; break; }        // not enough memory; report the max
        if (dos.allocs.has(seg)) dos.allocs.set(seg, want);           // resizing a dynamic block
        else if (seg <= PSP_SEG) dos.memFloor = seg + want;           // the program shrinks/grows its own block
        recomputeTop();
        ok(); break;
      }
      case 0x4b: {                                                   // EXEC (load + execute child)
        if (cpu.al !== 0) { err(1); break; }                         // only AL=00 (load & run) supported
        const path = asciiz(cpu.base[DS] + (cpu.dx & 0xffff));
        const rc = execChild(path, cpu.base[ES] + (cpu.bx & 0xffff));
        if (rc) err(rc);   // failure → CF=1, AX=error (parent context untouched); success switched to the child
        break;
      }
      case 0x4c: terminate(cpu.al); break;                           // terminate w/ code
      case 0x4d: cpu.ax = dos.exitCode; break;                       // get return code
      case 0x4e: findFirst(); break;
      case 0x4f: findNext(); break;
      case 0x56: vfs.rename(asciiz(cpu.base[DS] + (cpu.dx & 0xffff)), asciiz(cpu.base[ES] + (cpu.di & 0xffff))) ? ok() : err(2); break;
      case 0x57: ok(); cpu.cx = 0; cpu.dx = 0; break;                // get/set file time (stub)
      default: setCF(true); cpu.ax = 1; break;                       // unsupported function
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
