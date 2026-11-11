// classic.js — the Win32 a Windows 95 application of the MFC years calls beyond what the intros and
// the games' engines need: kernel32's strings, atoms, profiles and resources. Half-Life's launcher
// (hldemo.exe, MFC 4.2, 1999) is the first: its menus are a dialog of its own, its strings and
// pictures in HL_Res.dll. Merged into api.js's tables under the names api.js does not answer itself.
//
// Resources are read where Windows reads them, from the image in memory: a module's .rsrc directory
// (its data directory 2), three levels -- type, name, language -- of IMAGE_RESOURCE_DIRECTORY, names
// either numbers (MAKEINTRESOURCE) or counted UTF-16 strings compared without case. An HRSRC is the
// address of the data entry, an HGLOBAL from LoadResource the data itself.

const RT = { CURSOR: 1, BITMAP: 2, ICON: 3, MENU: 4, DIALOG: 5, STRING: 6, ACCELERATOR: 9, RCDATA: 10, GROUP_CURSOR: 12, GROUP_ICON: 14, VERSION: 16 };
export { RT };

/** The resource `type`/`name` (numbers, or strings) of the module at `base`: { at, size } or null. */
export function findResource(x, base, type, name) {
  const pe = base + x.r32(base + 0x3c), rva = x.r32(pe + 24 + 96 + 8 * 2);
  if (!rva) return null;
  const root = base + rva;
  const entry = (dir, key) => {
    const named = x.r16(dir + 12), ids = x.r16(dir + 14);
    for (let i = 0; i < named + ids; i++) {
      const e = dir + 16 + 8 * i, n = x.r32(e), off = x.r32(e + 4);
      if (key === null) return off;                                         // any (the first language)
      if (typeof key === 'number' ? !(n & 0x80000000) && n === key : (n & 0x80000000) && nameAt(root + (n & 0x7fffffff)) === key) return off;
    }
    return -1;
  };
  const nameAt = (p) => { let s = ''; const len = x.r16(p); for (let i = 0; i < len; i++) s += String.fromCharCode(x.r16(p + 2 + 2 * i)); return s.toUpperCase(); };
  let off = entry(root, type);
  if (off < 0 || !(off & 0x80000000)) return null;
  off = entry(root + (off & 0x7fffffff), name);
  if (off < 0 || !(off & 0x80000000)) return null;
  off = entry(root + (off & 0x7fffffff), null);
  if (off < 0 || off & 0x80000000) return null;
  const data = root + off;
  return { entry: data, at: base + x.r32(data), size: x.r32(data + 4) };
}

/** A resource id as a program passes it: a number under 10000h, else a string ("#123" a number too). */
export function resId(x, p) {
  if (p < 0x10000) return p;
  const s = x.str(p);
  return s[0] === '#' ? parseInt(s.slice(1), 10) : s.toUpperCase();
}

/** The string `id` of a module's string table (RT_STRING, sixteen counted UTF-16 strings a block). */
export function loadString(x, base, id) {
  const r = findResource(x, base, RT.STRING, (id >>> 4) + 1);
  if (!r) return null;
  let p = r.at;
  for (let i = 0; i < (id & 15); i++) p += 2 + 2 * x.r16(p);
  const len = x.r16(p);
  let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(x.r16(p + 2 + 2 * i));
  return s;
}

/**
 * A packed DIB in memory (BITMAPINFOHEADER, its colour table, its bits: a bitmap resource, a .bmp after
 * its file header) as { w, h, px }: 0x00RRGGBB, top row first. 1, 4, 8, 24 and 32 bits, uncompressed.
 */
export function decodeDib(x, at) {
  const hs = x.r32(at), w = x.r32(at + 4) | 0, h0 = x.r32(at + 8) | 0, bpp = x.r16(at + 14), comp = x.r32(at + 16);
  if (hs < 40 || w <= 0 || !h0 || comp !== 0 && comp !== 3) return null;
  const h = Math.abs(h0), n = bpp <= 8 ? (x.r32(at + 32) || 1 << bpp) : 0, pal = new Uint32Array(256);
  for (let i = 0; i < n; i++) pal[i] = x.r32(at + hs + 4 * i) & 0xffffff;
  const bits = at + hs + 4 * n + (comp === 3 ? 12 : 0), stride = ((w * bpp + 31) >> 5) << 2, raw = x.bytes(bits, stride * h), px = new Uint32Array(w * h);
  for (let r = 0; r < h; r++) {
    const y = h0 > 0 ? h - 1 - r : r, o = r * stride;
    for (let i = 0; i < w; i++) {
      let v;
      if (bpp === 8) v = pal[raw[o + i]];
      else if (bpp === 4) v = pal[(raw[o + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15];
      else if (bpp === 1) v = pal[(raw[o + (i >> 3)] >> (7 - (i & 7))) & 1];
      else if (bpp === 24) v = raw[o + 3 * i + 2] << 16 | raw[o + 3 * i + 1] << 8 | raw[o + 3 * i];
      else if (bpp === 32) v = raw[o + 4 * i + 2] << 16 | raw[o + 4 * i + 1] << 8 | raw[o + 4 * i];
      else if (bpp === 16) { const q = raw[o + 2 * i] | raw[o + 2 * i + 1] << 8; v = ((q >> 10) & 31) << 19 | ((q >> 5) & 31) << 11 | (q & 31) << 3; }
      px[y * w + i] = v >>> 0;
    }
  }
  return { w, h, px };
}

export function classicApis({ st }) {
  const atoms = new Map(), atomNames = new Map();                        // name (upper) -> atom, atom -> name
  const atomOf = (name) => {
    const k = name.toUpperCase();
    if (!atoms.has(k)) { const a = 0xc000 + atoms.size; atoms.set(k, a); atomNames.set(a, name); }
    return atoms.get(k);
  };
  const putStr = (x, buf, n, s) => { if (!buf || n <= 0) return 0; const b = Uint8Array.from(s.slice(0, n - 1), (c) => c.charCodeAt(0) & 0xff); x.write(buf, b); x.w8(buf + b.length, 0); return b.length; };
  const lower = (s) => s.toLowerCase();
  const menus = new Map();                                               // window -> its menu (SetMenu)
  const menu = (m) => { const o = st.gdi.get(m); return o && o.kind === 'menu' ? o : null; };
  const dropItem = (m, at, flags) => {
    const mn = menu(m), i = !mn ? -1 : flags & 0x400 ? (at < mn.items.length ? at : -1) : mn.items.indexOf(at);
    if (i < 0) return 0;
    mn.items.splice(i, 1); return 1;
  };
  const kernel32 = {
    GetProcessVersion: ['u', () => 0x00040000],                         // Windows 95's 4.0, for every process
    lstrlenA: ['p', (x, p) => (p ? x.str(p).length : 0)],
    lstrcpyA: ['pp', (x, d, s) => { const t = x.str(s); x.write(d, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 0xff)); return d; }],
    lstrcpynA: ['ppi', (x, d, s, n) => { if (n <= 0) return d; putStr(x, d, n, x.str(s)); return d; }],
    lstrcatA: ['pp', (x, d, s) => { const t = x.str(d) + x.str(s); x.write(d, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 0xff)); return d; }],
    lstrcmpA: ['pp', (x, a, b) => { const s = x.str(a), t = x.str(b); return s < t ? -1 : s > t ? 1 : 0; }],
    lstrcmpiA: ['pp', (x, a, b) => { const s = lower(x.str(a)), t = lower(x.str(b)); return s < t ? -1 : s > t ? 1 : 0; }],
    MulDiv: ['iii', (x, a, b, c) => (c ? Math.round((a * b) / c) : -1)],
    IsBadReadPtr: ['pu', (x, p) => (p ? 0 : 1)], IsBadWritePtr: ['pu', (x, p) => (p ? 0 : 1)], IsBadCodePtr: ['p', (x, p) => (p ? 0 : 1)],
    GetThreadLocale: ['', () => 0x409], GetUserDefaultLCID: ['', () => 0x409], GetUserDefaultLangID: ['', () => 0x409],
    IsValidLocale: ['uu', () => 1], IsValidCodePage: ['u', () => 1],
    GetStringTypeExA: ['uupip', (x, lcid, type, src, n, out) => {
      const s = n < 0 ? x.str(src) + '\0' : String.fromCharCode(...x.bytes(src, n));
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        x.w16(out + 2 * i, (c >= 65 && c <= 90 ? 0x181 : c >= 97 && c <= 122 ? 0x182 : c >= 48 && c <= 57 ? 0x84 : c === 32 ? 0x48 : c < 32 ? 0x20 : 0x10));
      }
      return 1;
    }],
    GlobalAddAtomA: ['p', (x, p) => (p < 0x10000 ? p : atomOf(x.str(p)))],
    GlobalFindAtomA: ['p', (x, p) => (p < 0x10000 ? p : atoms.get(x.str(p).toUpperCase()) || 0)],
    GlobalGetAtomNameA: ['upi', (x, a, buf, n) => putStr(x, buf, n, atomNames.get(a) || (a < 0xc000 ? '#' + a : ''))],
    GlobalDeleteAtom: ['u', () => 0],
    CreateMutexA: ['pup', () => 0x3800], ReleaseMutex: ['p', () => 1], OpenMutexA: ['uup', () => 0],
    // Profiles: no WIN.INI and no program .ini but those on its disk; what is asked for is the default.
    GetPrivateProfileIntA: ['ppip', (x, sec, key, def) => def],
    GetPrivateProfileStringA: ['ppppup', (x, sec, key, def, buf, n) => putStr(x, buf, n, def ? x.str(def) : '')],
    GetProfileStringA: ['ppppu', (x, sec, key, def, buf, n) => putStr(x, buf, n, def ? x.str(def) : '')],
    GetProfileIntA: ['ppi', (x, sec, key, def) => def],
    WritePrivateProfileStringA: ['pppp', () => 1], WriteProfileStringA: ['ppp', () => 1],
    SetCurrentDirectoryA: ['p', () => 1],
    GetVolumeInformationA: ['ppupppp' + 'u', (x, root, name, nn, serial, maxlen, flags, fs, nfs) => {
      if (name) putStr(x, name, nn, 'MIRAGE'); if (serial) x.w32(serial, 0x19990212);
      if (maxlen) x.w32(maxlen, 255); if (flags) x.w32(flags, 3); if (fs) putStr(x, fs, nfs, 'FAT32'); return 1;
    }],
    SetFileAttributesA: ['pu', () => 1],
    CompareFileTime: ['pp', (x, a, b) => { const d = x.r32(a + 4) - x.r32(b + 4) || x.r32(a) - x.r32(b); return d < 0 ? -1 : d > 0 ? 1 : 0; }],
    GetFileTime: ['pppp', (x, h, c, a, w) => { for (const p of [c, a, w]) if (p) { x.w32(p, 0); x.w32(p + 4, 0x01be7d00); } return 1; }],   // 1999
    LocalLock: ['p', (x, h) => h], LocalUnlock: ['p', () => 1], GlobalFlags: ['p', () => 0], GlobalHandle: ['p', (x, p) => p],
    FatalAppExitA: ['up', (x, a, msg) => { throw new Error(`mirage-win32: FatalAppExit: ${x.str(msg)}`); }],
    SetConsoleCtrlHandler: ['pu', () => 1],
    WinExec: ['pu', () => 2],                                             // ERROR_FILE_NOT_FOUND: nothing else runs here
    CreateFileMappingA: ['ppuuup', () => 0], OpenFileMappingA: ['uup', () => 0],
    // SYSTEM_INFO: an x86 with 4 KiB pages, one Pentium Pro-class processor, 64 KiB allocation granularity.
    GetSystemInfo: ['p', (x, p) => {
      x.write(p, new Uint8Array(36));
      x.w32(p + 4, 4096); x.w32(p + 8, 0x10000); x.w32(p + 12, 0x7ffeffff); x.w32(p + 16, 1); x.w32(p + 20, 1);
      x.w32(p + 24, 586); x.w32(p + 28, 0x10000); x.w16(p + 32, 6); x.w16(p + 34, 0x0101); return 0;
    }],
    // MEMORY_BASIC_INFORMATION for the page at an address: committed, read-write, private (the C runtime asks
    // about its stack's guard page).
    VirtualQuery: ['ppu', (x, a, mbi, n) => {
      if (n < 28) return 0;
      const page = a & ~0xfff;
      [page, page, 4, 0x1000, 0x1000, 4, 0x20000].forEach((v, i) => x.w32(mbi + 4 * i, v));
      return 28;
    }],
    InterlockedExchange: ['pi', (x, p, v) => { const old = x.r32(p); x.w32(p, v); return old; }],
    // FILETIME: 100-ns intervals since 1601, the guest's clock.
    GetSystemTimeAsFileTime: ['p', (x, p) => {
      const t = BigInt(Math.floor((x.lx.epoch + x.lx.mono()) * 1e7)) + 116444736000000000n;
      x.w32(p, Number(t & 0xffffffffn)); x.w32(p + 4, Number(t >> 32n)); return 0;
    }],
    // Resources, from the image in memory.
    FindResourceA: ['ppp', (x, mod, name, type) => { const r = findResource(x, mod || x.win.base, resId(x, type), resId(x, name)); return r ? r.entry : 0; }],
    FindResourceExA: ['pppu', (x, mod, type, name) => { const r = findResource(x, mod || x.win.base, resId(x, type), resId(x, name)); return r ? r.entry : 0; }],
    LoadResource: ['pp', (x, mod, h) => (h ? (mod || x.win.base) + x.r32(h) : 0)],
    LockResource: ['p', (x, h) => h],
    SizeofResource: ['pp', (x, mod, h) => (h ? x.r32(h + 4) : 0)],
    FreeResource: ['p', () => 0],
  };
  // ---- user32: rectangles, and what a window is asked that needs no window manager ----------------
  const rect = (x, p) => [x.r32(p) | 0, x.r32(p + 4) | 0, x.r32(p + 8) | 0, x.r32(p + 12) | 0];
  const setRect = (x, p, l, t, r, b) => { x.w32(p, l); x.w32(p + 4, t); x.w32(p + 8, r); x.w32(p + 12, b); return 1; };
  const empty = ([l, t, r, b]) => r <= l || b <= t;
  const props = new Map();                                              // hwnd + name -> value
  const propKey = (x, h, name) => h + ':' + (name < 0x10000 ? '#' + name : x.str(name).toUpperCase());
  const user32 = {
    SetRect: ['piiii', (x, p, l, t, r, b) => setRect(x, p, l, t, r, b)],
    SetRectEmpty: ['p', (x, p) => setRect(x, p, 0, 0, 0, 0)],
    CopyRect: ['pp', (x, d, s) => setRect(x, d, ...rect(x, s))],
    EqualRect: ['pp', (x, a, b) => (rect(x, a).join() === rect(x, b).join() ? 1 : 0)],
    IsRectEmpty: ['p', (x, p) => (empty(rect(x, p)) ? 1 : 0)],
    InflateRect: ['pii', (x, p, dx, dy) => { const [l, t, r, b] = rect(x, p); return setRect(x, p, l - dx, t - dy, r + dx, b + dy); }],
    OffsetRect: ['pii', (x, p, dx, dy) => { const [l, t, r, b] = rect(x, p); return setRect(x, p, l + dx, t + dy, r + dx, b + dy); }],
    IntersectRect: ['ppp', (x, d, a, b) => {
      const [l1, t1, r1, b1] = rect(x, a), [l2, t2, r2, b2] = rect(x, b), q = [Math.max(l1, l2), Math.max(t1, t2), Math.min(r1, r2), Math.min(b1, b2)];
      if (empty(q)) { setRect(x, d, 0, 0, 0, 0); return 0; } return setRect(x, d, ...q);
    }],
    UnionRect: ['ppp', (x, d, a, b) => {
      const p = rect(x, a), q = rect(x, b);
      if (empty(p)) return setRect(x, d, ...q); if (empty(q)) return setRect(x, d, ...p);
      return setRect(x, d, Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3]));
    }],
    PtInRect: ['pii', (x, p, X, Y) => { const [l, t, r, b] = rect(x, p); return X >= l && X < r && Y >= t && Y < b ? 1 : 0; }],
    GetSysColorBrush: ['i', (x, i) => 0x01a00000 + i],
    CharNextA: ['p', (x, p) => (x.r8(p) ? p + 1 : p)],
    CharPrevA: ['pp', (x, s, p) => (p > s ? p - 1 : s)],
    CharUpperA: ['p', (x, p) => {
      if (p < 0x10000) return String.fromCharCode(p).toUpperCase().charCodeAt(0);
      const t = x.str(p).toUpperCase(); x.write(p, Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff)); return p;
    }],
    CharLowerA: ['p', (x, p) => {
      if (p < 0x10000) return String.fromCharCode(p).toLowerCase().charCodeAt(0);
      const t = x.str(p).toLowerCase(); x.write(p, Uint8Array.from(t, (c) => c.charCodeAt(0) & 0xff)); return p;
    }],
    IsWindowUnicode: ['p', () => 0],
    GetMessageTime: ['', (x) => Math.floor(x.lx.mono() * 1000) >>> 0],
    GetMessagePos: ['', () => (((st.mouseY | 0) & 0xffff) << 16) | ((st.mouseX | 0) & 0xffff)],
    SetPropA: ['ppp', (x, h, name, v) => { props.set(propKey(x, h, name), v); return 1; }],
    GetPropA: ['pp', (x, h, name) => props.get(propKey(x, h, name)) || 0],
    RemovePropA: ['pp', (x, h, name) => { const k = propKey(x, h, name), v = props.get(k) || 0; props.delete(k); return v; }],
    // A bitmap of the module's resources (RT_BITMAP: a DIB without its file header), as a GDI bitmap.
    LoadBitmapA: ['pp', (x, mod, name) => {
      const r = findResource(x, mod || x.win.base, RT.BITMAP, resId(x, name)), d = r && decodeDib(x, r.at);
      return d ? st.newHandle('bitmap', d) : 0;
    }],
    // LoadImageA(module, name, type, cx, cy, flags): a bitmap of the resources as LoadBitmapA's, or of a
    // .bmp file (LR_LOADFROMFILE: its BITMAPFILEHEADER, then the DIB -- Cave Story's pictures, .pbm files
    // that are BMPs); an icon or a cursor the stock one LoadIconA and LoadCursorA give.
    LoadImageA: ['ppuiiu', (x, mod, name, type, cx, cy, flags) => {
      if (type === 1) return 0x10002;
      if (type === 2) return 0x10003;
      if (type !== 0) return 0;
      if (!(flags & 0x10)) return user32.LoadBitmapA[1](x, mod, name);
      const f = st.diskFile && st.diskFile(x.str(name, 260));
      if (!f || !f.bytes || f.size < 54 || f.bytes[0] !== 0x42 || f.bytes[1] !== 0x4d) return 0;
      const at = x.win.heapAlloc(f.size); x.write(at, f.bytes.subarray(0, f.size));
      const d = decodeDib(x, at + 14); x.win.heapFree(at);
      return d ? st.newHandle('bitmap', d) : 0;
    }],
    GetMenuCheckMarkDimensions: ['', () => (13 << 16) | 13],
    // Menus: handles a program builds and attaches (Jazz Jackrabbit 2's window has one), kept, not drawn --
    // a window's menu bar takes no room here.
    // Their items are counted (a program empties a menu by deleting its first item until that fails), by
    // command id: DeleteMenu/RemoveMenu by position (MF_BYPOSITION) or by id.
    CreateMenu: ['', () => st.newHandle('menu', { items: [] })], CreatePopupMenu: ['', () => st.newHandle('menu', { items: [] })],
    DestroyMenu: ['p', (x, m) => (menu(m) ? (st.gdi.delete(m), 1) : 0)],
    DeleteMenu: ['puu', (x, m, at, flags) => dropItem(m, at, flags)], RemoveMenu: ['puu', (x, m, at, flags) => dropItem(m, at, flags)],
    // MENUITEMINFOA: fMask's MIIM_ID (2) gives wID (at +16); fByPosition: `at` a position, else the item it goes before.
    InsertMenuItemA: ['puip', (x, m, at, byPos, mii) => {
      const mn = menu(m); if (!mn) return 0;
      const id = x.r32(mii + 4) & 2 ? x.r32(mii + 16) : 0, i = byPos ? at : mn.items.indexOf(at);
      mn.items.splice(i < 0 || i > mn.items.length ? mn.items.length : i, 0, id); return 1;
    }],
    AppendMenuA: ['pupp', (x, m, flags, id) => { const mn = menu(m); if (!mn) return 0; mn.items.push(flags & 0x10 ? 0 : id); return 1; }],
    GetMenuItemCount: ['p', (x, m) => (menu(m) ? menu(m).items.length : -1)],
    DrawMenuBar: ['p', () => 1],
    SetMenu: ['pp', (x, h, m) => { menus.set(h, m); return 1; }], GetMenu: ['p', (x, h) => menus.get(h) || 0],
    // Drawn controls' parts and icons: nothing drawn.
    DrawFrameControl: ['ppuu', () => 1], DrawIconEx: ['piipiiupu', () => 1],
    WinHelpA: ['ppuu', () => 1],
    LockWindowUpdate: ['p', () => 1],
  };
  const gdi32 = {
    SaveDC: ['p', () => 1], RestoreDC: ['pi', () => 1],
    SetMapMode: ['pi', () => 1],
    SetViewportOrgEx: ['piip', (x, dc, X, Y, p) => { if (p) { x.w32(p, 0); x.w32(p + 4, 0); } return 1; }],
    OffsetViewportOrgEx: ['piip', (x, dc, X, Y, p) => { if (p) { x.w32(p, 0); x.w32(p + 4, 0); } return 1; }],
    SetViewportExtEx: ['piip', () => 1], SetWindowExtEx: ['piip', () => 1],
    ScaleViewportExtEx: ['piiiip', () => 1], ScaleWindowExtEx: ['piiiip', () => 1],
    DPtoLP: ['ppi', () => 1],
    PtVisible: ['pii', () => 1], RectVisible: ['pp', () => 1],
    // Clipping regions: none kept -- a DC draws over its whole surface. GetClipRgn: the DC has none (0).
    CreateRectRgnIndirect: ['p', () => st.newHandle('region', {})], GetClipRgn: ['pp', () => 0],
    SelectClipRgn: ['pp', () => 2], ExcludeClipRect: ['piiii', () => 2], OffsetClipRgn: ['pii', () => 2],
  };
  // ---- advapi32: a registry in memory, for the run -- keys made and opened, values written and read
  // back (Half-Life's launcher keeps its settings under HKEY_LOCAL_MACHINE\Software\Valve and gives up
  // when it cannot make the key). Predefined keys 80000000h-80000005h; others are handles here.
  const keys = new Map(), handles = new Map();                          // path -> { values }, handle -> path
  const ROOTS = { 0x80000000: 'HKCR', 0x80000001: 'HKCU', 0x80000002: 'HKLM', 0x80000003: 'HKU', 0x80000005: 'HKCC' };
  let nextKey = 0x5000;
  const pathOf = (x, hk, sub) => {
    const base = ROOTS[hk >>> 0] || handles.get(hk);
    if (!base) return null;
    const s = sub ? x.str(sub).replace(/^\\+|\\+$/g, '') : '';
    return (s ? base + '\\' + s : base).toLowerCase();
  };
  const openKey = (x, path, out) => { const h = nextKey; nextKey += 4; handles.set(h, path); if (out) x.w32(out, h); return 0; };
  const make = (path) => { const parts = path.split('\\'); for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join('\\'); if (!keys.has(p)) keys.set(p, { values: new Map() }); } };
  for (const r of Object.values(ROOTS)) make(r.toLowerCase());
  const create = (x, hk, sub, out, disp) => {
    const p = pathOf(x, hk, sub); if (!p) return 6;                      // ERROR_INVALID_HANDLE
    const had = keys.has(p); make(p); if (disp) x.w32(disp, had ? 2 : 1);
    return openKey(x, p, out);
  };
  const open = (x, hk, sub, out) => { const p = pathOf(x, hk, sub); if (!p) return 6; if (!keys.has(p)) return 2; return openKey(x, p, out); };
  const valueName = (x, p) => (p ? x.str(p).toLowerCase() : '');
  const query = (x, hk, name, type, data, cb) => {
    const k = keys.get(handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase()); if (!k) return 6;
    const v = k.values.get(valueName(x, name)); if (!v) return 2;
    if (type) x.w32(type, v.type);
    if (!cb) return data ? 87 : 0;
    const room = x.r32(cb); x.w32(cb, v.data.length);
    if (!data) return 0;
    if (room < v.data.length) return 234;                               // ERROR_MORE_DATA
    x.write(data, v.data); return 0;
  };
  const advapi32 = {
    RegCreateKeyExA: ['ppupuuppp', (x, hk, sub, r, cls, opt, sam, sa, out, disp) => create(x, hk, sub, out, disp)],
    RegCreateKeyA: ['ppp', (x, hk, sub, out) => create(x, hk, sub, out, 0)],
    RegOpenKeyExA: ['ppuup', (x, hk, sub, opt, sam, out) => open(x, hk, sub, out)],
    RegOpenKeyA: ['ppp', (x, hk, sub, out) => open(x, hk, sub, out)],
    RegCloseKey: ['p', (x, hk) => { handles.delete(hk); return 0; }],
    RegFlushKey: ['p', () => 0],
    RegQueryValueExA: ['pppppp', (x, hk, name, r, type, data, cb) => query(x, hk, name, type, data, cb)],
    RegSetValueExA: ['ppuupu', (x, hk, name, r, type, data, cb) => {
      const k = keys.get(handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase()); if (!k) return 6;
      k.values.set(valueName(x, name), { type, data: data ? x.bytes(data, cb) : new Uint8Array(0) }); return 0;
    }],
    RegDeleteValueA: ['pp', (x, hk, name) => { const k = keys.get(handles.get(hk)); return k && k.values.delete(valueName(x, name)) ? 0 : 2; }],
    RegDeleteKeyA: ['pp', (x, hk, sub) => { const p = pathOf(x, hk, sub); return p && keys.delete(p) ? 0 : 2; }],
    // The subkeys one by one: their names (ERROR_NO_MORE_ITEMS, 259, after the last).
    RegEnumKeyExA: ['pupppppp', (x, hk, i, name, cb) => {
      const p = handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase();
      const kids = [...keys.keys()].filter((k) => k.startsWith(p + '\\') && !k.slice(p.length + 1).includes('\\'));
      if (i >= kids.length) return 259;
      const n = kids[i].slice(p.length + 1), room = x.r32(cb);
      if (room <= n.length) return 234;
      x.write(name, new TextEncoder().encode(n + '\0')); x.w32(cb, n.length); return 0;
    }],
  };
  // ---- winmm: MCI by strings. No CD drive: "open cdaudio" and the rest answer MCIERR_INVALID_DEVICE_NAME,
  // which a game takes for a machine without its music. The command goes to the log.
  const winmm = {
    mciSendStringA: ['ppup', (x, cmd, ret, n) => { x.win.say(`mciSendStringA("${x.str(cmd, 200)}")`); if (ret && n) x.w8(ret, 0); return 263; }],
    mciGetErrorStringA: ['upu', (x, err, buf, n) => putStr(x, buf, n, err === 263 ? 'The specified device is not open or is not recognized by MCI.' : 'MCI error ' + err) ? 1 : 0],
    mciGetDeviceIDA: ['p', () => 0],
  };
  // ---- version.dll: no version resource is read here (a program asks, and goes on without);
  // ---- ole32.dll: COM started, and no class registered (REGDB_E_CLASSNOTREG) -- Half-Life's engine
  // asks for DirectX's and the shell's objects, and does without.
  // The program's own file is read (its VS_VERSIONINFO resource, RT_VERSION 16): Cave Story shows its
  // version on its title screen from it. VerQueryValue answers "\\" (VS_FIXEDFILEINFO, after the
  // block's header and its key L"VS_VERSION_INFO", on a 4-byte boundary); other files have none here.
  const ownVersion = (x, f) => {
    const name = x.str(f, 260).split('\\').pop().toLowerCase();
    if (name !== x.win.path.split('\\').pop().toLowerCase()) return null;
    return findResource(x, x.win.base, 16, 1);
  };
  const version = {
    GetFileVersionInfoSizeA: ['pp', (x, f, h) => { if (h) x.w32(h, 0); const r = ownVersion(x, f); return r ? r.size : 0; }],
    GetFileVersionInfoA: ['puup', (x, f, h, n, buf) => { const r = ownVersion(x, f); if (!r) return 0; x.write(buf, x.bytes(r.at, Math.min(n, r.size))); return 1; }],
    VerQueryValueA: ['pppp', (x, block, sub, pp, plen) => {
      if (x.str(sub, 64) !== '\\' || x.r16(block + 2) < 52) return 0;
      x.w32(pp, block + 40); x.w32(plen, 52); return 1;
    }],
  };
  const ole32 = {
    CoInitialize: ['p', () => 0], CoInitializeEx: ['pu', () => 0], CoUninitialize: ['', () => 0],
    CoCreateInstance: ['ppupp', (x, clsid, outer, ctx, iid, pp) => { if (pp) x.w32(pp, 0); return 0x80040154; }],
  };
  // ---- shlwapi.dll: the path helpers (Cave Story finds its data from its own path).
  const shlwapi = {
    // PathRemoveFileSpecA: the path less its last component ("C:\\dir\\a.exe" -> "C:\\dir"; a root stays).
    PathRemoveFileSpecA: ['p', (x, p) => {
      const s = x.str(p, 260), i = s.lastIndexOf('\\');
      const t = i < 0 ? '' : i === 2 && s[1] === ':' ? s.slice(0, 3) : s.slice(0, i);
      putStr(x, p, 261, t); return t !== s ? 1 : 0;
    }],
  };
  // ---- shell32.dll: files dropped on the window (none ever is), and documents opened (none is: there
  // is no shell to open them with -- SE_ERR_NOASSOC).
  const shell32 = {
    DragAcceptFiles: ['pi', () => 0], DragFinish: ['p', () => 0],
    DragQueryFileA: ['pupu', () => 0],
    ShellExecuteA: ['ppppppi', () => 31],
  };
  // ---- imm32.dll: no input method -- a window has no input context.
  const imm32 = {
    ImmGetContext: ['p', () => 0], ImmReleaseContext: ['pp', () => 1], ImmSetOpenStatus: ['pi', () => 0], ImmAssociateContext: ['pp', () => 0],
  };
  return { kernel32, user32, gdi32, advapi32, winmm, version, ole32, shlwapi, shell32, imm32 };
}
