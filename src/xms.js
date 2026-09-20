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

  // Resolve one endpoint of an AH=0Bh move to an absolute linear address, checking that the whole
  // [off, off+len) range is inside the block. Without this, an out-of-range move silently scribbled
  // over a neighbouring handle — or past the end of RAM, where the write vanished with no diagnostic
  // at all. Returns a negative XMS error code on failure so the caller can report the right one.
  const CONV_TOP = 0x110000;                                   // seg:off tops out at 0x10FFEF with A20 on
  const endpoint = (handle, off, len, eHandle, eOffset) => {
    if (handle === 0) {                                        // conventional memory: far pointer seg:off
      const lin = (((off >>> 16) & 0xffff) << 4) + (off & 0xffff);
      return lin + len > CONV_TOP ? -eOffset : lin;
    }
    const b = xms.handles.get(handle);
    if (!b) return -eHandle;
    const o = off >>> 0;
    if (o > b.size || o + len > b.size) return -eOffset;
    return (b.base + o) >>> 0;
  };
  /** The lowest live block starting strictly above `base`, or Infinity — i.e. how far a block can
   *  grow in place before it would run into a neighbour. */
  const ceilingAbove = (base) => {
    let c = Infinity;
    for (const b of xms.handles.values()) if (b.base > base && b.base < c) c = b.base;
    return c;
  };
  const setA20 = (on) => { machine.mem.setA20(on); if (machine.rec) machine.rec.setMask(machine.mem.mask); };

  // The XMS dispatch — cpu.ah selects the function. Called by the recompiler at the entry address.
  const dispatch = () => {
    switch (cpu.ah) {
      case 0x00:                                               // get version → AX=3.00, BX=driver rev, DX=0 (no HMA)
        cpu.ax = 0x0300; cpu.bx = 0x0301; cpu.dx = 0; break;
      case 0x03: case 0x05: setA20(true); ok(); break;         // global / local enable A20
      case 0x04: case 0x06: ok(); break;                       // global / local disable A20 (we keep it on; harmless)
      // Query A20 state. On the failure answer (A20 off) the spec still wants an error code in BL;
      // leaving BL alone handed back whatever the PREVIOUS call had put there — Windows saw BL=91h
      // from the HMA request just before it, which is not an A20 error at all.
      case 0x07: if (machine.mem.a20) cpu.ax = 1; else { cpu.ax = 0; cpu.bx = (cpu.bx & ~0xff) | 0x00; } break;
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
        const b = xms.handles.get(cpu.dx & 0xffff);
        if (!b) { err(0xa2); break; }
        if (b.locked) { err(0xab); break; }                    // ABh: block is locked
        xms.handles.delete(cpu.dx & 0xffff); recomputeTop(); ok(); break;
      }
      case 0x0b: {                                             // move block: DS:SI → ExtMemMoveStruct
        const p = (cpu.base[DS] + (cpu.si & 0xffff)) & 0xfffff;
        const len = mem.r32(p) >>> 0;
        if (len & 1) { err(0xa7); break; }                     // A7h: length must be even
        const srcH = mem.r16(p + 4), srcOff = mem.r32(p + 6), dstH = mem.r16(p + 10), dstOff = mem.r32(p + 12);
        const s = endpoint(srcH, srcOff, len, 0xa3, 0xa4);     // A3h bad src handle / A4h bad src offset
        if (s < 0) { err(-s); break; }
        const d = endpoint(dstH, dstOff, len, 0xa5, 0xa6);     // A5h bad dst handle / A6h bad dst offset
        if (d < 0) { err(-d); break; }
        // mem.move is memmove + the SMC dirty check. The old code was an ascending byte loop writing
        // straight into u8: it corrupted any move whose destination fell inside [src, src+len), and —
        // worse — bypassed block invalidation on the one bulk path that swaps *code* overlays into
        // conventional memory, leaving stale compiled blocks live.
        mem.move(d, s, len);
        ok(); break;
      }
      case 0x0c: {                                             // lock block: DX = handle → DX:BX = 32-bit linear addr
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        if (b.locked >= 0xff) { err(0xac); break; }            // ACh: lock count overflow
        b.locked++; cpu.bx = b.base & 0xffff; cpu.dx = (b.base >>> 16) & 0xffff; cpu.ax = 1; break;
      }
      case 0x0d: {                                             // unlock block
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        if (b.locked === 0) { err(0xaa); break; }              // AAh: block is not locked
        b.locked--; ok(); break;
      }
      case 0x0e: {                                             // get handle info: DX=handle → BH=lock, BL=free handles, DX=size KB
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        cpu.bx = (b.locked << 8) | 0x3e; cpu.dx = (b.size >> 10) & 0xffff; cpu.ax = 1; break;
      }
      case 0x0f: {                                             // reallocate: BX = new KB, DX = handle
        const b = xms.handles.get(cpu.dx & 0xffff); if (!b) { err(0xa2); break; }
        if (b.locked) { err(0xab); break; }                    // ABh: a locked block can't move or resize
        const want = (cpu.bx & 0xffff) * 1024;
        if (want <= b.size) { b.size = want; recomputeTop(); ok(); break; }   // shrink: always in place
        // Grow. The old code just widened `size` in place, which silently swallowed whatever block
        // sat above — two handles then aliased the same bytes. Grow in place only up to the next
        // live block; otherwise relocate to the top of the pool and copy, as a real driver does.
        if (b.base + want <= Math.min(ceilingAbove(b.base), xms.max)) {
          b.size = want; recomputeTop(); ok(); break;
        }
        if (xms.top + want > xms.max) { err(0xa0); break; }    // A0h: all extended memory allocated
        mem.move(xms.top, b.base, b.size);
        b.base = xms.top; b.size = want; recomputeTop(); ok(); break;
      }
      // Request / release HMA. 90h ("HMA does not exist"), not 91h ("HMA already in use"): AH=00
      // above reports DX=0, i.e. no HMA, and 91h contradicts that — it tells the caller the HMA is
      // real and held by somebody else.
      case 0x01: case 0x02: err(0x90); break;
      case 0x10: case 0x11: err(0x80); break;                  // UMB — not implemented
      default: err(0x80); break;                               // 80h: function not implemented
    }
  };

  cpu.xmsCall = dispatch;
  machine.xms = xms;
  mem.u8[(XMS_ENTRY_SEG << 4) + XMS_ENTRY_OFF] = 0xcb;   // marker byte (RETF) the recompiler guards the entry on

  // INT 2Fh multiplex: only the XMS queries; everything else no-ops (as the bare IRET stub did).
  // Returning true means "served"; anything else is passed down the chain by machine.swInt to the
  // handler we displaced.
  //
  // And we STAND ASIDE once a guest handler owns the vector, because a real BIOS provides no XMS at
  // all — the guest loads one. On the boot path FreeDOS loads HimemX, and answering 4300 ourselves
  // made it report "XMS is already installed. Driver won't be installed." and step aside instead, so
  // the guest ended up on our driver rather than its own. On the HLE path nothing takes the vector
  // before its XMS client has asked, and we answer exactly as before.
  machine.hookInterrupt(0x2f, (c) => {
    if (machine.guestOwns(0x2f)) return false;
    if (c.ax === 0x4300) { c.ax = (c.ax & 0xff00) | 0x80; return true; }   // AL=80h: XMS installed
    if (c.ax === 0x4310) { c.setSeg(ES, XMS_ENTRY_SEG); c.bx = XMS_ENTRY_OFF; return true; }
    return false;
  });

  return xms;
}
