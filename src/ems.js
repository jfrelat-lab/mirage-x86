// ems.js — LIM EMS 4.0: the subset programs actually use.
//
// Two things constrain the design:
//   * Detection reads the INT 67h vector and expects the driver name "EMMXXXX0" at <that
//     segment>:000A. F000 is unusable — offset 000A there is inside the per-vector stub table — so
//     the driver takes its own segment and Machine.swInt recognises it alongside the BIOS one.
//   * Mapping COPIES rather than remaps: MIRAGE has no real-mode remapping layer. Equivalent for any
//     program that follows the spec, which forbids holding a pointer into the frame across a remap.

export const EMS_SEG = 0xf100;              // the driver's own segment (see above)
const EMS_ENTRY_OFF = 0x0020;               // where the vector points — clear of the name below
const NAME_OFF = 0x000a;                    // "EMMXXXX0", 8 bytes, fixed by the spec
const FRAME_SEG = 0xe000;                   // the 64 KB page frame
const PAGE_SIZE = 0x4000;                   // 16 KB per page, four per frame
const FRAME_PAGES = 4;

export function installEMS(machine) {
  const mem = machine.mem, cpu = machine.cpu;

  const ems = {
    frameSeg: FRAME_SEG,
    handles: new Map(),          // handle -> { pages, base, name }
    nextHandle: 1,
    mapped: new Array(FRAME_PAGES).fill(null),   // slot -> { handle, page } currently in the window
    reset() { this.handles = new Map(); this.nextHandle = 1; this.mapped = new Array(FRAME_PAGES).fill(null); },
  };

  // Pages come from the same pool as XMS, sharing its top as the bump: XMS and EMS grow up, DPMI
  // grows down, and all three agree on who owns what.
  const poolTop = () => (machine.xms ? machine.xms.top : 0x100000);
  const poolMax = () => (machine.xms ? machine.xms.max : mem.size);
  const takePool = (bytes) => {
    const base = poolTop();
    if (base + bytes > poolMax()) return -1;
    if (machine.xms) machine.xms.top = base + bytes;
    return base;
  };

  const frameLin = (slot) => ((FRAME_SEG << 4) + slot * PAGE_SIZE) >>> 0;
  const pageLin = (h, page) => (h.base + page * PAGE_SIZE) >>> 0;

  /** Write the slot back to its page's storage, so a later remap sees the changes. */
  const flush = (slot) => {
    const cur = ems.mapped[slot];
    if (!cur) return;
    const h = ems.handles.get(cur.handle);
    if (!h) return;
    mem.u8.copyWithin(pageLin(h, cur.page), frameLin(slot), frameLin(slot) + PAGE_SIZE);
  };

  const mapPage = (slot, handle, page) => {
    if (slot < 0 || slot >= FRAME_PAGES) return 0x8b;              // illegal physical page
    flush(slot);
    if (handle === 0xffff || page === 0xffff) { ems.mapped[slot] = null; return 0; }   // unmap
    const h = ems.handles.get(handle);
    if (!h) return 0x83;                                           // invalid handle
    if (page >= h.pages) return 0x8a;                              // logical page out of range
    mem.u8.copyWithin(frameLin(slot), pageLin(h, page), pageLin(h, page) + PAGE_SIZE);
    ems.mapped[slot] = { handle, page };
    return 0;
  };

  const ok = () => { cpu.ah = 0; };
  const fail = (code) => { cpu.ah = code; };

  machine.hookInterrupt(0x67, (c) => {
    switch (c.ah) {
      case 0x40: return ok();                                       // get manager status
      case 0x41: c.bx = FRAME_SEG; return ok();                     // get page frame segment

      case 0x42: {                                                  // get unallocated / total pages
        const total = Math.max(0, (poolMax() - 0x100000)) / PAGE_SIZE | 0;
        const used = [...ems.handles.values()].reduce((a, h) => a + h.pages, 0);
        c.dx = Math.min(total, 0x7fff);
        c.bx = Math.max(0, Math.min(total - used, 0x7fff));
        return ok();
      }

      case 0x43: {                                                  // allocate pages
        const n = c.bx & 0xffff;
        if (n === 0) return fail(0x89);                             // zero pages is an error in 3.2
        const base = takePool(n * PAGE_SIZE);
        if (base < 0) return fail(0x88);                            // not enough pages
        const handle = ems.nextHandle++;
        ems.handles.set(handle, { pages: n, base, name: '' });
        c.dx = handle;
        return ok();
      }

      case 0x44:                                                    // map handle page
        return fail(mapPage(c.al, c.dx & 0xffff, c.bx & 0xffff));

      case 0x45: {                                                  // deallocate handle
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        // Bump allocator: pages are not reclaimed. Drop any slot still holding this handle, or a
        // later flush writes through a handle that is gone.
        for (let i = 0; i < FRAME_PAGES; i++) if (ems.mapped[i] && ems.mapped[i].handle === (c.dx & 0xffff)) ems.mapped[i] = null;
        ems.handles.delete(c.dx & 0xffff);
        return ok();
      }

      case 0x46: c.al = 0x40; return ok();                          // version 4.0
      case 0x47: case 0x48: return ok();                            // save/restore map: nothing to keep
      case 0x4b: c.bx = ems.handles.size; return ok();              // handle count
      case 0x4c: {                                                  // pages owned by one handle
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        c.bx = h.pages; return ok();
      }
      case 0x4d: {                                                  // pages owned by all handles
        const a = (c.seg[0] << 4) + (c.reg[7] & 0xffff);            // ES:DI = array
        let i = 0;
        for (const [handle, h] of ems.handles) { mem.w16(a + i * 4, handle); mem.w16(a + i * 4 + 2, h.pages); i++; }
        c.bx = i; return ok();
      }

      case 0x51: {                                                  // reallocate pages
        const h = ems.handles.get(c.dx & 0xffff);
        if (!h) return fail(0x83);
        const want = c.bx & 0xffff;
        if (want > h.pages) {                                       // grow into a fresh block
          const base = takePool(want * PAGE_SIZE);
          if (base < 0) return fail(0x88);
          mem.u8.copyWithin(base, h.base, h.base + h.pages * PAGE_SIZE);
          h.base = base;
        }
        h.pages = want;
        return ok();
      }

      default:
        machine.unhandledInts[0x67]++;
        return fail(0x84);                                          // unsupported function
    }
  });

  // The vector must point at our own segment: that is where the name is looked for.
  machine.setVector(0x67, EMS_SEG, EMS_ENTRY_OFF);
  const nameLin = ((EMS_SEG << 4) + NAME_OFF) >>> 0;
  for (let i = 0; i < 8; i++) mem.u8[nameLin + i] = 'EMMXXXX0'.charCodeAt(i);
  mem.u8[((EMS_SEG << 4) + EMS_ENTRY_OFF) >>> 0] = 0xcf;            // a bare IRET, like the BIOS stubs

  machine.ems = ems;
  return ems;
}
