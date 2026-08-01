// xms.js — a minimal XMS (eXtended Memory Specification 3.0) driver. Games from ~1993-94
// (Realms of Chaos, Mystic Towers, Wolf3D WL6…) refuse to start without extended memory.
// The app finds us via INT 2Fh AX=4300 (installed?) / AX=4310 (entry point → ES:BX), then FAR-CALLs
// the entry with AH = function. We back XMS blocks with MIRAGE's own RAM above 1 MB (the Machine
// defaults to 16 MB) and implement the functions games actually use: query-free, alloc/free, lock,
// move, handle-info, and the A20 controls. The recompiler intercepts execution at the entry address
// (f000:XMS_ENTRY_OFF) and calls cpu.xmsCall(), which runs dispatch() and then RETFs.

import { DS, ES, CS } from './cpu.js';

export const XMS_ENTRY_SEG = 0xf000, XMS_ENTRY_OFF = 0x0100;   // far-callable driver entry
const XMS_BASE = 0x100000;                                     // extended memory starts at 1 MiB

export function installXMS(machine) {
  const mem = machine.mem, cpu = machine.cpu;
  const xms = {
    top: XMS_BASE,                 // bump allocator for extended memory
    max: mem.size,                 // top of RAM (16 MiB by default)
    handles: new Map(),            // handle → { base, size, locked }
    nextHandle: 1,
    reset() { this.top = XMS_BASE; this.handles = new Map(); this.nextHandle = 1; },
  };

  // Lower the bump pointer to the top of the still-live blocks so freed trailing space is reclaimed
  // (games alloc-a-temp / free-it / alloc-the-real-block in a LIFO-ish way — Wolf3D's PML does).
  const recomputeTop = () => { let t = XMS_BASE; for (const b of xms.handles.values()) t = Math.max(t, b.base + b.size); xms.top = t; };

  const ok = () => { cpu.ax = 1; };                            // success: AX=1
  const err = (code) => { cpu.ax = 0; cpu.bx = (cpu.bx & ~0xff) | code; };  // fail: AX=0, BL=error
  const linOf = (handle, off) => {                             // move endpoint → absolute linear byte address
    if (handle === 0) return (((off >>> 16) & 0xffff) << 4) + (off & 0xffff);  // conventional far ptr seg:off
    const b = xms.handles.get(handle); return b ? (b.base + (off >>> 0)) >>> 0 : -1;
  };
  const setA20 = (on) => { machine.mem.setA20(on); if (machine.rec) { machine.rec.MM = machine.mem.mask; machine.rec.reset(); } };

  // The XMS dispatch — cpu.ah selects the function. Called by the recompiler at the entry address.
  const dispatch = () => {
    switch (cpu.ah) {
      case 0x00:                                               // get version → AX=3.00, BX=driver rev, DX=0 (no HMA)
        cpu.ax = 0x0300; cpu.bx = 0x0301; cpu.dx = 0; break;
      case 0x03: case 0x05: setA20(true); ok(); break;         // global / local enable A20
      case 0x04: case 0x06: ok(); break;                       // global / local disable A20 (we keep it on; harmless)
      case 0x07: cpu.ax = machine.mem.a20 ? 1 : 0; break;      // query A20 state
      case 0x08: {                                             // query free extended memory (KB)
        const freeKb = Math.max(0, Math.min(0xffff, (xms.max - xms.top) >> 10));
        cpu.ax = freeKb; cpu.dx = freeKb; break;               // AX = largest block, DX = total (single pool)
      }
      case 0x09: {                                             // allocate: DX = KB requested → DX = handle
        const bytes = (cpu.dx & 0xffff) * 1024;
        if (xms.top + bytes > xms.max) { err(0xa0); break; }   // A0h: all extended memory allocated
        const base = xms.top; xms.top += bytes;
        const h = xms.nextHandle++; xms.handles.set(h, { base, size: bytes, locked: 0 });
        cpu.dx = h; ok(); break;
      }
      case 0x0a: {                                             // free block: DX = handle
        if (!xms.handles.has(cpu.dx & 0xffff)) { err(0xa2); break; }
        xms.handles.delete(cpu.dx & 0xffff); recomputeTop(); ok(); break;
      }
      case 0x0b: {                                             // move block: DS:SI → ExtMemMoveStruct
        const p = (cpu.base[DS] + (cpu.si & 0xffff)) & 0xfffff;
        const len = mem.r32(p) >>> 0;
        const srcH = mem.r16(p + 4), srcOff = mem.r32(p + 6), dstH = mem.r16(p + 10), dstOff = mem.r32(p + 12);
        const s = linOf(srcH, srcOff), d = linOf(dstH, dstOff);
        if (s < 0) { err(0xa3); break; }                       // A3h: invalid source handle
        if (d < 0) { err(0xa5); break; }                       // A5h: invalid destination handle
        const u8 = mem.u8; for (let i = 0; i < len; i++) u8[(d + i) >>> 0] = u8[(s + i) >>> 0];  // hardware-level copy
        ok(); break;
      }
      case 0x0c: {                                             // lock block: DX = handle → DX:BX = 32-bit linear addr
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        b.locked++; cpu.bx = b.base & 0xffff; cpu.dx = (b.base >>> 16) & 0xffff; cpu.ax = 1; break;
      }
      case 0x0d: {                                             // unlock block
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        if (b.locked > 0) b.locked--; ok(); break;
      }
      case 0x0e: {                                             // get handle info: DX=handle → BH=lock, BL=free handles, DX=size KB
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        cpu.bx = (b.locked << 8) | 0x3e; cpu.dx = (b.size >> 10) & 0xffff; cpu.ax = 1; break;
      }
      case 0x0f: {                                             // reallocate: BX = new KB, DX = handle
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        const want = (cpu.bx & 0xffff) * 1024;
        if (b.base + want > xms.max) { err(0xa0); break; }
        b.size = want; if (b.base + want > xms.top) xms.top = b.base + want; ok(); break;
      }
      case 0x01: case 0x02: err(0x91); break;                  // request / release HMA — we don't manage the HMA
      case 0x10: case 0x11: err(0x80); break;                  // UMB — not implemented
      default: err(0x80); break;                               // 80h: function not implemented
    }
  };

  cpu.xmsCall = dispatch;
  machine.xms = xms;
  mem.u8[(XMS_ENTRY_SEG << 4) + XMS_ENTRY_OFF] = 0xcb;   // marker byte (RETF) the recompiler guards the entry on

  // INT 2Fh multiplex: only the XMS queries; everything else no-ops (as the bare IRET stub did).
  machine.hookInterrupt(0x2f, (c) => {
    if (c.ax === 0x4300) c.ax = (c.ax & 0xff00) | 0x80;        // AL=80h: XMS driver installed
    else if (c.ax === 0x4310) { c.setSeg(ES, XMS_ENTRY_SEG); c.bx = XMS_ENTRY_OFF; }  // ES:BX = entry point
  });

  return xms;
}
