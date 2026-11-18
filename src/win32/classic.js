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
// Of a resource's languages, as Windows' FindResource picks: the one asked (FindResourceEx), else neutral
// (0), the user's (resourceLang: the visitor's browser's, src/win32/api.js), its primary language's, English
// (United States), any English, the first -- Flash Player 8 keeps its menu in a dozen languages, the first
// Chinese, and showed that.
export const resourceLang = { id: 0x409 };
export function findResource(x, base, type, name, lang = null) {
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
  const langs = root + (off & 0x7fffffff), ids = [];
  for (let i = 0, n = x.r16(langs + 12) + x.r16(langs + 14); i < n; i++) ids.push(x.r32(langs + 16 + 8 * i));
  const user = resourceLang.id, primary = ids.findIndex((v) => (v & 0x3ff) === (user & 0x3ff));
  const pick = [lang, 0, user, 0x400, 0x800].filter((v) => v !== null && v !== undefined).map((v) => ids.indexOf(v)).find((i) => i >= 0)
    ?? (primary >= 0 ? primary : ids.indexOf(0x409) >= 0 ? ids.indexOf(0x409) : ids.findIndex((v) => (v & 0x3ff) === 0x09) >= 0 ? ids.findIndex((v) => (v & 0x3ff) === 0x09) : 0);
  off = ids.length ? x.r32(langs + 16 + 8 * pick + 4) : -1;
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
 * its file header) as { w, h, px }: 0x00RRGGBB, top row first. 1, 4, 8, 16, 24 and 32 bits, uncompressed; 8 and 4 bits RLE too.
 */
/**
 * BI_RLE8 / BI_RLE4 bits (bottom row first) unpacked into uncompressed rows of `stride` bytes. A run is a
 * count and a value (RLE4: two nibbles alternating); 0 escapes: 0 ends a row, 1 the bitmap, 2 skips right
 * and up by the next two bytes, 3 and up are that many literal values (padded to a 16-bit word). What is
 * skipped stays colour 0. Winamp 2's built-in skin is kept so.
 */
function unRle(src, w, h, stride, bpp) {
  const out = new Uint8Array(stride * h), put = (px, row, v) => {
    if (px >= w || row >= h) return;
    if (bpp === 8) out[row * stride + px] = v;
    else { const o = row * stride + (px >> 1); out[o] = px & 1 ? (out[o] & 0xf0) | (v & 15) : (out[o] & 15) | (v << 4); }
  };
  let i = 0, px = 0, row = 0;
  while (i + 1 < src.length && row < h) {
    const n = src[i++], v = src[i++];
    if (n) { for (let k = 0; k < n; k++, px++) put(px, row, bpp === 8 ? v : k & 1 ? v & 15 : v >> 4); continue; }
    if (v === 0) { px = 0; row++; } else if (v === 1) break;
    else if (v === 2) { px += src[i++] || 0; row += src[i++] || 0; } else {
      const bytes = bpp === 8 ? v : (v + 1) >> 1;
      for (let k = 0; k < v; k++, px++) put(px, row, bpp === 8 ? src[i + k] : k & 1 ? src[i + (k >> 1)] & 15 : src[i + (k >> 1)] >> 4);
      i += bytes + (bytes & 1);
    }
  }
  return out;
}

export function decodeDib(x, at) {
  // BITMAPCOREHEADER (12 bytes, OS/2 1.x's): 16-bit sizes, RGBTRIPLE colours -- Windows' own cards.dll keeps
  // its cards so. BITMAPINFOHEADER (40 and up) otherwise.
  const core = x.r32(at) === 12;
  const hs = x.r32(at), w = core ? x.r16(at + 4) : x.r32(at + 4) | 0, h0 = core ? x.r16(at + 6) : x.r32(at + 8) | 0;
  const bpp = core ? x.r16(at + 10) : x.r16(at + 14), comp = core ? 0 : x.r32(at + 16), cs = core ? 3 : 4;
  const rle = (comp === 1 && bpp === 8) || (comp === 2 && bpp === 4);
  if ((hs < 40 && !core) || w <= 0 || !h0 || comp !== 0 && comp !== 3 && !rle || rle && h0 < 0) return null;
  const h = Math.abs(h0), n = bpp <= 8 ? ((core ? 0 : x.r32(at + 32)) || 1 << bpp) : 0, pal = new Uint32Array(256);
  for (let i = 0; i < n; i++) pal[i] = (x.r8(at + hs + cs * i + 2) << 16) | (x.r8(at + hs + cs * i + 1) << 8) | x.r8(at + hs + cs * i);
  const bits = at + hs + cs * n + (comp === 3 ? 12 : 0), stride = ((w * bpp + 31) >> 5) << 2, px = new Uint32Array(w * h);
  const raw = rle ? unRle(x.bytes(bits, x.r32(at + 20)), w, h, stride, bpp) : x.bytes(bits, stride * h);
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

export function classicApis({ st, wm }) {
  const atoms = new Map(), atomNames = new Map();                        // name (upper) -> atom, atom -> name
  const atomOf = (name) => {
    const k = name.toUpperCase();
    if (!atoms.has(k)) { const a = 0xc000 + atoms.size; atoms.set(k, a); atomNames.set(a, name); }
    return atoms.get(k);
  };
  // INI files on the program's disk (see GetPrivateProfileStringA): sections by lower-case name, each its
  // own name and its [key, value] lines in order.
  const iniPath = (x, file) => { const n = file ? x.str(file, 260) : 'win.ini'; return /[\\/:]/.test(n) ? n : `C:\\WINDOWS\\${n}`; };
  const ini = (x, file) => {
    const secs = new Map(), f = st.diskFile && st.diskFile(iniPath(x, file));
    if (!f || !f.bytes) return secs;
    let cur = null;
    for (const raw of new TextDecoder('latin1').decode(f.bytes.subarray(0, f.size)).split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l[0] === ';') continue;
      const m = /^\[(.*)\]/.exec(l);
      if (m) { const k = m[1].trim().toLowerCase(); cur = secs.get(k) || { name: m[1].trim(), entries: [] }; secs.set(k, cur); continue; }
      const eq = l.indexOf('=');
      if (cur && eq > 0) cur.entries.push([l.slice(0, eq).trim(), l.slice(eq + 1).trim()]);
    }
    return secs;
  };
  const iniGet = (x, file, sec, key) => {
    const s = ini(x, file).get(x.str(sec).trim().toLowerCase()), k = x.str(key).trim().toLowerCase();
    const e = s && s.entries.find(([n]) => n.toLowerCase() === k);
    return e ? e[1] : null;
  };
  // A list (section or key names, a section's lines): each string then 0, and a last 0; cut to the room.
  const putList = (x, buf, n, list) => {
    if (!buf || n < 2) return 0;
    let at = 0;
    for (const s of list) { const t = s.slice(0, Math.max(0, n - 2 - at)); for (let i = 0; i < t.length; i++) x.w8(buf + at + i, t.charCodeAt(i) & 0xff); at += t.length; x.w8(buf + at++, 0); if (at >= n - 1) { at = n - 2; break; } }
    x.w8(buf + at, 0); if (!list.length) x.w8(buf + 1, 0);
    return at;
  };
  const iniString = (x, file, sec, key, def, buf, n) => {
    if (!sec) return putList(x, buf, n, [...ini(x, file).values()].map((s) => s.name));
    if (!key) { const s = ini(x, file).get(x.str(sec).trim().toLowerCase()); return putList(x, buf, n, s ? s.entries.map(([k]) => k) : []); }
    let v = iniGet(x, file, sec, key);
    if (v === null) v = def ? x.str(def).trim() : '';
    if (v.length > 1 && /^(["']).*\1$/.test(v)) v = v.slice(1, -1);   // a quoted value: its quotes off
    return putStr(x, buf, n, v);
  };
  const iniWrite = (x, file, sec, key, val) => {
    if (!sec) return 0;
    const secs = ini(x, file), k = x.str(sec).trim(), s = secs.get(k.toLowerCase()) || { name: k, entries: [] };
    secs.set(k.toLowerCase(), s);
    if (!key) secs.delete(k.toLowerCase());
    else {
      const name = x.str(key).trim(), i = s.entries.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
      if (!val) { if (i >= 0) s.entries.splice(i, 1); }
      else if (i >= 0) s.entries[i][1] = x.str(val); else s.entries.push([name, x.str(val)]);
    }
    const text = [...secs.values()].map((t) => `[${t.name}]\r\n${t.entries.map(([a, b]) => `${a}=${b}\r\n`).join('')}`).join('\r\n');
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    st.disk.set(st.relPath(iniPath(x, file)), { bytes, size: bytes.length });
    return 1;
  };
  const putStr = (x, buf, n, s) => { if (!buf || n <= 0) return 0; const b = Uint8Array.from(s.slice(0, n - 1), (c) => c.charCodeAt(0) & 0xff); x.write(buf, b); x.w8(buf + b.length, 0); return b.length; };
  const lower = (s) => s.toLowerCase();
  /*
   * Menus: a handle each, its items { id, text, flags, sub } -- flags as MF_* has them (MF_GRAYED 1,
   * MF_DISABLED 2, MF_CHECKED 8, MF_POPUP 10h, MF_SEPARATOR 800h), `sub` a popup's own menu. The main
   * window's menu bar (st.menu) is drawn and used by the window manager (src/win32/wm.js); another
   * window's is kept. An item is named by its position (MF_BYPOSITION, 400h) or by its command, found
   * in the popups too, as Windows searches them.
   */
  const menus = new Map();                                               // window -> its menu (SetMenu)
  const mciVideos = new Map();                                           // an opened video's alias -> its device id (st.video's, api.js)
  const menu = (m) => { const o = st.gdi.get(m); return o && o.kind === 'menu' ? o : null; };
  const newMenu = () => st.newHandle('menu', { items: [] });
  /** The item `at` names in menu `m`: { list, i } (its menu's items and its index), or null. */
  const itemOf = (m, at, flags) => {
    const mn = menu(m); if (!mn) return null;
    if (flags & 0x400) return at < mn.items.length ? { list: mn.items, i: at } : null;
    for (let i = 0; i < mn.items.length; i++) {
      const it = mn.items[i];
      if (!(it.flags & 0x10) && it.id === (at & 0xffff)) return { list: mn.items, i };
      if (it.flags & 0x10) { const r = itemOf(it.sub, at, flags); if (r) return r; }
    }
    return null;
  };
  const dropItem = (m, at, flags) => { const r = itemOf(m, at, flags); if (!r) return 0; r.list.splice(r.i, 1); return 1; };
  /** RT_MENU (4): MENUHEADER (version 0), then items -- a popup's flags (MF_POPUP) and text, its items
   *  after it; a command's flags, id and text; MF_END (80h) the last of a level. Texts are UTF-16. */
  const loadMenu = (x, inst, name) => {
    const r = findResource(x, inst || x.win.base, 4, resId(x, name)); if (!r) return 0;
    let p = r.at + 4 + x.r16(r.at + 2);
    const wtext = () => { let t = ''; for (let c; (c = x.r16(p)); p += 2) t += String.fromCharCode(c); p += 2; return t; };
    const level = () => {
      const h = newMenu(), items = menu(h).items;
      for (;;) {
        const f = x.r16(p); p += 2;
        if (f & 0x10) { const text = wtext(); items.push({ id: 0, text, flags: f & ~0x80, sub: level() }); }
        else { const id = x.r16(p); p += 2; const text = wtext(); items.push({ id, text, flags: (f & ~0x80) | (!id && !text ? 0x800 : 0), sub: 0 }); }
        if (f & 0x80) return h;
      }
    };
    return level();
  };
  st.loadMenu = loadMenu;
  /** A window's menu changed: the main window's bar is the window manager's to draw, the client area
   *  under it the smaller (WM_SIZE), as Windows keeps the window's own rectangle. */
  const setMenu = (h, m) => {
    menus.set(h, m);
    if (h !== st.hwnd) { const o = st.wins && st.wins.get(h); if (o) o.bar = m || 0; return 1; }   // its bar, for when it is the screen's
    const was = st.menu ? 19 : 0, now = m ? 19 : 0;
    st.menu = m || 0;
    if (was !== now) { st.h = Math.max(1, st.h + was - now); st.msgs.push({ msg: 0x05, wp: 0, lp: ((st.h & 0xffff) << 16 | (st.w & 0xffff)) >>> 0 }); }
    wm.dirty = true; return 1;
  };
  st.setMenu = setMenu;
  const kernel32 = {
    // Winamp 2's start: the drives (C:, the program's disk), a thread's priority (normal), the instruction
    // cache (nothing to flush: the recompiler sees code written).
    GetLogicalDrives: ['', () => 4], GetThreadPriority: ['p', () => 0], FlushInstructionCache: ['ppu', () => 1],
    GetProcessVersion: ['u', () => 0x00040000],                         // Windows 95's 4.0, for every process
    lstrlenA: ['p', (x, p) => (p ? x.str(p).length : 0)],
    lstrcpyA: ['pp', (x, d, s) => { const t = x.str(s); x.write(d, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 0xff)); return d; }],
    lstrcpynA: ['ppi', (x, d, s, n) => { if (n <= 0) return d; putStr(x, d, n, x.str(s)); return d; }],
    lstrcatA: ['pp', (x, d, s) => { const t = x.str(d) + x.str(s); x.write(d, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 0xff)); return d; }],
    lstrcmpA: ['pp', (x, a, b) => { const s = x.str(a), t = x.str(b); return s < t ? -1 : s > t ? 1 : 0; }],
    lstrcmpiA: ['pp', (x, a, b) => { const s = lower(x.str(a)), t = lower(x.str(b)); return s < t ? -1 : s > t ? 1 : 0; }],
    MulDiv: ['iii', (x, a, b, c) => (c ? Math.round((a * b) / c) : -1)],
    IsBadReadPtr: ['pu', (x, p) => (p ? 0 : 1)], IsBadWritePtr: ['pu', (x, p) => (p ? 0 : 1)], IsBadCodePtr: ['p', (x, p) => (p ? 0 : 1)],
    GetThreadLocale: ['', () => st.lang || 0x409], GetUserDefaultLCID: ['', () => st.lang || 0x409], GetUserDefaultLangID: ['', () => st.lang || 0x409],   // the visitor's language (api.js)
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

    // Profiles: the INI files on the program's disk ([section], then key=value lines), a name with no path
    // in Windows' directory; WIN.INI none until written. Quake III's demo installer (Installer VISE) reads
    // its wizard's every text from its language file so: answered with the defaults, the wizard was blank.
    GetPrivateProfileIntA: ['ppip', (x, sec, key, def, file) => { const v = iniGet(x, file, sec, key); const n = v === null ? NaN : parseInt(v, 10); return Number.isNaN(n) ? def : n; }],
    GetPrivateProfileStringA: ['ppppup', (x, sec, key, def, buf, n, file) => iniString(x, file, sec, key, def, buf, n)],
    GetPrivateProfileSectionA: ['ppup', (x, sec, buf, n, file) => {
      const s = ini(x, file).get(x.str(sec).trim().toLowerCase());
      return putList(x, buf, n, s ? s.entries.map(([k, v]) => `${k}=${v}`) : []);
    }],
    GetProfileStringA: ['ppppu', (x, sec, key, def, buf, n) => iniString(x, 0, sec, key, def, buf, n)],
    GetProfileIntA: ['ppi', (x, sec, key, def) => { const v = iniGet(x, 0, sec, key); const n = v === null ? NaN : parseInt(v, 10); return Number.isNaN(n) ? def : n; }],
    WritePrivateProfileStringA: ['pppp', (x, sec, key, val, file) => iniWrite(x, file, sec, key, val)],
    // A structure as the profile keeps one: its bytes in hexadecimal, then a byte of their sum; read back only
    // whole and summing right (Winamp keeps its windows' places so).
    GetPrivateProfileStructA: ['pppup', (x, sec, key, buf, n, file) => {
      const v = iniGet(x, file, sec, key);
      if (v === null || v.length !== 2 * n + 2 || !/^[0-9a-f]*$/i.test(v)) return 0;
      const b = Uint8Array.from({ length: n + 1 }, (_, i) => parseInt(v.substr(2 * i, 2), 16));
      if ((b.subarray(0, n).reduce((a, c) => a + c, 0) & 255) !== b[n]) return 0;
      x.write(buf, b.subarray(0, n)); return 1;
    }],
    WritePrivateProfileStructA: ['pppup', (x, sec, key, buf, n, file) => {
      if (!buf) return iniWrite(x, file, sec, key, 0);
      const b = x.bytes(buf, n), hex = [...b, b.reduce((a, c) => a + c, 0) & 255].map((c) => c.toString(16).toUpperCase().padStart(2, '0')).join('');
      const tmp = x.win.heapAlloc(hex.length + 1); x.write(tmp, Uint8Array.from(hex + '\0', (c) => c.charCodeAt(0)));
      const r = iniWrite(x, file, sec, key, tmp); x.win.heapFree(tmp); return r;
    }],
    WriteProfileStringA: ['ppp', (x, sec, key, val) => iniWrite(x, 0, sec, key, val)],
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
    FindResourceExA: ['pppu', (x, mod, type, name, lang) => { const r = findResource(x, mod || x.win.base, resId(x, type), resId(x, name), lang || null); return r ? r.entry : 0; }],
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
    // No input waiting in the queue's bits (GetQueueStatus), the system font's dialog units (8x16), a window's
    // parent changed (SetParent: the old one returned).
    GetQueueStatus: ['u', () => 0], GetDialogBaseUnits: ['', () => (16 << 16) | 8],
    SetParent: ['pp', (x, h, p) => { const w = st.wins.get(h); if (!w) return 0; const old = w.parent || 0; w.parent = p; return old; }],
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
      // A 1-bit DIB is a monochrome bitmap: drawn onto colour in the DC's text and background colours.
      if (d) d.mono = (x.r32(r.at) === 12 ? x.r16(r.at + 10) : x.r16(r.at + 14)) === 1;
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
    // A shortcut menu: none shown here -- the call returns as if it were dismissed (0, no command).
    TrackPopupMenu: ['puiiipp', () => 0], TrackPopupMenuEx: ['puiipp', () => 0],
    // Menus (above): made, loaded from the resources, filled, changed, attached to a window. A program
    // empties a menu by deleting its first item until that fails (Jazz Jackrabbit 2).
    CreateMenu: ['', () => newMenu()], CreatePopupMenu: ['', () => newMenu()],
    LoadMenuA: ['pp', (x, inst, name) => loadMenu(x, inst, name)],
    /*
     * Keyboard accelerators (RT_ACCELERATOR, 9: ACCELTABLEENTRY's flags, key, command, 8 bytes each, 80h
     * on the last): Minesweeper's F2 for a new game. TranslateAccelerator matches a key message (a
     * virtual key with FVIRTKEY, 1, and its Shift 4, Ctrl 8 and Alt 10h held as the entry says; else a
     * character) and posts WM_COMMAND with 1 in its high word, as from an accelerator.
     */
    LoadAcceleratorsA: ['pp', (x, inst, name) => {
      const r = findResource(x, inst || x.win.base, 9, resId(x, name)); if (!r) return 0;
      const keys = [];
      for (let p = r.at; p < r.at + r.size; p += 8) { const f = x.r16(p); keys.push({ f, key: x.r16(p + 2), id: x.r16(p + 4) }); if (f & 0x80) break; }
      return st.newHandle('accel', { keys });
    }],
    TranslateAcceleratorA: ['ppp', (x, hwnd, h, m) => {
      const a = st.gdi.get(h), msg = x.r32(m + 4), wp = x.r32(m + 8);
      if (!a || a.kind !== 'accel' || (msg !== 0x100 && msg !== 0x104 && msg !== 0x102)) return 0;
      const held = (vk) => st.keys.has(vk);
      const k = a.keys.find((e) => (e.f & 1
        ? msg !== 0x102 && e.key === wp && !!(e.f & 4) === held(0x10) && !!(e.f & 8) === held(0x11) && !!(e.f & 0x10) === held(0x12)
        : msg === 0x102 && e.key === wp));
      if (!k) return 0;
      st.msgs.push({ msg: 0x111, wp: (1 << 16 | k.id) >>> 0, lp: 0, ...(hwnd && hwnd !== st.hwnd ? { hwnd } : {}) });
      return 1;
    }],
    DestroyMenu: ['p', (x, m) => (menu(m) ? (st.gdi.delete(m), 1) : 0)],
    DeleteMenu: ['puu', (x, m, at, flags) => dropItem(m, at, flags)], RemoveMenu: ['puu', (x, m, at, flags) => dropItem(m, at, flags)],
    // MENUITEMINFOA: fMask's MIIM_STATE (1) fState at +12, MIIM_ID (2) wID at +16, MIIM_SUBMENU (4)
    // hSubMenu at +20, MIIM_TYPE (10h) fType at +8 and its text at +36; fByPosition: `at` a position.
    // SetMenuItemInfoA: InsertMenuItemA's fields set on an item there.
    SetMenuItemInfoA: ['puip', (x, m, at, byPos, mii) => {
      const r = itemOf(m, at, byPos ? 0x400 : 0); if (!r) return 0;
      const it = r.list[r.i], mask = x.r32(mii + 4), type = mask & 0x110 ? x.r32(mii + 8) : it.flags & 0x800, data = x.r32(mii + 36);
      if (mask & 1) it.flags = (it.flags & ~0x0b) | (x.r32(mii + 12) & 0x0b);
      if (mask & 2) it.id = x.r32(mii + 16) & 0xffff;
      if (mask & 4) { it.sub = x.r32(mii + 20); it.flags = it.sub ? it.flags | 0x10 : it.flags & ~0x10; }
      if (mask & 0x110) it.flags = (it.flags & ~0x800) | (type & 0x800);
      if (mask & 0x50 && !(type & 0x804)) it.text = data ? x.str(data, 256) : '';
      if (m === st.menu) wm.dirty = true; return 1;
    }],
    InsertMenuItemA: ['puip', (x, m, at, byPos, mii) => {
      const mn = menu(m); if (!mn) return 0;
      const mask = x.r32(mii + 4), type = mask & 0x110 ? x.r32(mii + 8) : 0, data = x.r32(mii + 36);
      const it = { id: mask & 2 ? x.r32(mii + 16) & 0xffff : 0, flags: (mask & 1 ? x.r32(mii + 12) & 0x0b : 0) | (type & 0x800), sub: mask & 4 ? x.r32(mii + 20) : 0,
        text: mask & 0x50 && !(type & 0x804) && data ? x.str(data, 256) : '' };
      if (it.sub) it.flags |= 0x10;
      const r = byPos ? null : itemOf(m, at, 0), i = byPos ? at : r && r.list === mn.items ? r.i : mn.items.length;
      mn.items.splice(Math.min(i, mn.items.length), 0, it); return 1;
    }],
    AppendMenuA: ['pupp', (x, m, flags, id, text) => {
      const mn = menu(m); if (!mn) return 0;
      mn.items.push({ id: flags & 0x10 ? 0 : id & 0xffff, sub: flags & 0x10 ? id : 0, flags: flags & 0x81b, text: flags & 0x804 || !text ? '' : x.str(text, 256) });
      return 1;
    }],
    // GetMenuItemInfoA: InsertMenuItemA's fields read back (cch at +40 the buffer's size, then the length).
    GetMenuItemInfoA: ['puip', (x, m, at, byPos, mii) => {
      const r = itemOf(m, at, byPos ? 0x400 : 0); if (!r) return 0;
      const it = r.list[r.i], mask = x.r32(mii + 4);
      if (mask & 1) x.w32(mii + 12, it.flags & 0x0b);
      if (mask & 2) x.w32(mii + 16, it.id);
      if (mask & 4) x.w32(mii + 20, it.flags & 0x10 ? it.sub : 0);
      if (mask & 0x110) x.w32(mii + 8, it.flags & 0x800);
      if (mask & 0x50) {
        const buf = x.r32(mii + 36), n = x.r32(mii + 40);
        if (buf && n) putStr(x, buf, n, it.text);
        x.w32(mii + 40, it.text.length);
      }
      return 1;
    }],
    GetMenuItemCount: ['p', (x, m) => (menu(m) ? menu(m).items.length : -1)],
    // InsertMenuA (before an item, by position or command) and ModifyMenuA (an item replaced); an item's text.
    InsertMenuA: ['puupp', (x, m, at, flags, id, text) => {
      const mn = menu(m); if (!mn) return 0;
      const it = { id: flags & 0x10 ? 0 : id & 0xffff, sub: flags & 0x10 ? id : 0, flags: flags & 0x81b, text: flags & 0x804 || !text ? '' : x.str(text, 256) };
      const r = at === 0xffffffff ? null : itemOf(m, at, flags), list = r ? r.list : mn.items;
      list.splice(r ? r.i : list.length, 0, it); return 1;
    }],
    ModifyMenuA: ['puupp', (x, m, at, flags, id, text) => {
      const r = itemOf(m, at, flags); if (!r) return 0;
      r.list[r.i] = { id: flags & 0x10 ? 0 : id & 0xffff, sub: flags & 0x10 ? id : 0, flags: flags & 0x81b, text: flags & 0x804 || !text ? '' : x.str(text, 256) };
      if (m === st.menu) wm.dirty = true; return 1;
    }],
    GetMenuStringA: ['puupu', (x, m, at, buf, n, flags) => { const r = itemOf(m, at, flags); return r ? putStr(x, buf, n, r.list[r.i].text) || r.list[r.i].text.length * !buf : 0; }],
    SetMenuItemBitmaps: ['puupp', () => 1],                             // check-mark bitmaps: the standard mark kept
    GetSubMenu: ['pi', (x, m, pos) => { const mn = menu(m), it = mn && mn.items[pos]; return it && it.flags & 0x10 ? it.sub : 0; }],
    GetMenuItemID: ['pi', (x, m, pos) => { const mn = menu(m), it = mn && mn.items[pos]; return !it ? -1 : it.flags & 0x10 ? -1 : it.id; }],
    GetMenuState: ['puu', (x, m, at, flags) => { const r = itemOf(m, at, flags); return r ? r.list[r.i].flags & 0x81b : -1; }],
    // The previous state, or -1 when there is no such item.
    CheckMenuItem: ['puu', (x, m, at, flags) => {
      const r = itemOf(m, at, flags); if (!r) return -1;
      const it = r.list[r.i], was = it.flags & 8; it.flags = (it.flags & ~8) | (flags & 8); return was;
    }],
    EnableMenuItem: ['puu', (x, m, at, flags) => {
      const r = itemOf(m, at, flags); if (!r) return -1;
      const it = r.list[r.i], was = it.flags & 3; it.flags = (it.flags & ~3) | (flags & 3); if (m === st.menu) wm.dirty = true; return was;
    }],
    // An item of the main window's bar, where the window manager draws it (screen coordinates).
    GetMenuItemRect: ['pppp', (x, hwnd, m, pos, r) => {
      const b = m === st.menu && wm.menuItemRect && wm.menuItemRect(pos); if (!b) return 0;
      x.w32(r, b.x); x.w32(r + 4, b.y); x.w32(r + 8, b.x + b.w); x.w32(r + 12, b.y + b.h); return 1;
    }],
    DrawMenuBar: ['p', () => { wm.dirty = true; return 1; }],
    SetMenu: ['pp', (x, h, m) => setMenu(h, m)], GetMenu: ['p', (x, h) => (h === st.hwnd ? st.menu || 0 : menus.get(h) || (st.wins && st.wins.get(h) || {}).bar || 0)],
    // Drawn controls' parts and icons: nothing drawn.
    DrawFrameControl: ['ppuu', () => 1], DrawIconEx: ['piipiiupu', () => 1],
    WinHelpA: ['ppuu', () => 1],
    LockWindowUpdate: ['p', () => 1],
  };
  const gdi32 = {
    // MM_TEXT, and the colour itself as the nearest (a true-colour screen).
    GetMapMode: ['p', () => 1], GetNearestColor: ['pu', (x, hdc, c) => c],
    SaveDC: ['p', () => 1], RestoreDC: ['pi', () => 1],
    SetMapMode: ['pi', () => 1],
    SetViewportOrgEx: ['piip', (x, dc, X, Y, p) => { if (p) { x.w32(p, 0); x.w32(p + 4, 0); } return 1; }],
    OffsetViewportOrgEx: ['piip', (x, dc, X, Y, p) => { if (p) { x.w32(p, 0); x.w32(p + 4, 0); } return 1; }],
    SetViewportExtEx: ['piip', () => 1], SetWindowExtEx: ['piip', () => 1],
    ScaleViewportExtEx: ['piiiip', () => 1], ScaleWindowExtEx: ['piiiip', () => 1],
    DPtoLP: ['ppi', () => 1],
    PtVisible: ['pii', () => 1], RectVisible: ['pp', () => 1],
    // Clipping regions: none kept -- a DC draws over its whole surface. GetClipRgn: the DC has none (0).
    GetClipRgn: ['pp', () => 0],
    SelectClipRgn: ['pp', () => 2], ExtSelectClipRgn: ['ppi', () => 2], UpdateColors: ['p', () => 1], ExcludeClipRect: ['piiii', () => 2], OffsetClipRgn: ['pii', () => 2],
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
  // The shell's folders, as a fresh Windows 98 sets them (an installer puts its shortcuts in Programs),
  // and DirectX's version.
  // Value names are kept in lower case, as valueName reads them.
  {
    const SF = { desktop: 'C:\\WINDOWS\\Desktop', programs: 'C:\\WINDOWS\\Start Menu\\Programs', 'start menu': 'C:\\WINDOWS\\Start Menu', startup: 'C:\\WINDOWS\\Start Menu\\Programs\\StartUp', personal: 'C:\\My Documents', fonts: 'C:\\WINDOWS\\Fonts' };
    for (const k of ['hkcu\\software\\microsoft\\windows\\currentversion\\explorer\\shell folders', 'hkcu\\software\\microsoft\\windows\\currentversion\\explorer\\user shell folders']) {
      make(k); for (const [n, v] of Object.entries(SF)) keys.get(k).values.set(n, { type: 1, data: new TextEncoder().encode(v + '\0') });
    }
    // Windows' own folders and version, as a fresh Windows XP has them: Warcraft III's demo installer
    // reads ProgramFilesDir and proposed "Invalid\Warcraft III Demo" without it.
    const WIN = { programfilesdir: 'C:\\Program Files', commonfilesdir: 'C:\\Program Files\\Common Files', productname: 'Microsoft Windows XP', version: 'Windows XP', versionnumber: '5.1', systemroot: 'C:\\WINDOWS' };
    make('hklm\\software\\microsoft\\windows\\currentversion');
    for (const [n, v] of Object.entries(WIN)) keys.get('hklm\\software\\microsoft\\windows\\currentversion').values.set(n, { type: 1, data: new TextEncoder().encode(v + '\0') });
    make('hklm\\software\\microsoft\\windows nt\\currentversion');
    for (const [n, v] of Object.entries({ productname: 'Microsoft Windows XP', currentversion: '5.1', currentbuildnumber: '2600', systemroot: 'C:\\WINDOWS' }))
      keys.get('hklm\\software\\microsoft\\windows nt\\currentversion').values.set(n, { type: 1, data: new TextEncoder().encode(v + '\0') });
    // DirectX's version, as XP's DirectX 9.0c writes it: installers read it before they ask for DirectX.
    make('hklm\\software\\microsoft\\directx');
    keys.get('hklm\\software\\microsoft\\directx').values.set('version', { type: 1, data: new TextEncoder().encode('4.09.00.0904\0') });
  }
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
    // The service manager: not open to this user (ERROR_ACCESS_DENIED), as on a Windows 95 or for a limited
    // account -- Quake III's demo setup asks it before it copies its files, and goes on without.
    OpenSCManagerA: ['ppu', (x) => { (st.lastError ||= new Map()).set(x.lx.pid, 5); return 0; }],
    OpenServiceA: ['ppu', (x) => { (st.lastError ||= new Map()).set(x.lx.pid, 5); return 0; }],
    CloseServiceHandle: ['p', () => 1],
    RegCreateKeyExA: ['ppupuuppp', (x, hk, sub, r, cls, opt, sam, sa, out, disp) => create(x, hk, sub, out, disp)],
    RegCreateKeyA: ['ppp', (x, hk, sub, out) => create(x, hk, sub, out, 0)],
    RegOpenKeyExA: ['ppuup', (x, hk, sub, opt, sam, out) => open(x, hk, sub, out)],
    RegOpenKeyA: ['ppp', (x, hk, sub, out) => open(x, hk, sub, out)],
    // RegQueryValueA(key, subkey, buf, &size): the subkey's default value, as a string.
    RegQueryValueA: ['pppp', (x, hk, sub, buf, cb) => {
      const t = x.win.heapAlloc(4);
      try { const r = sub && x.r8(sub) ? open(x, hk, sub, t) : (x.w32(t, hk), 0); if (r) return r; return query(x, x.r32(t), 0, 0, buf, cb); } finally { x.win.heapFree(t); }
    }],
    RegCloseKey: ['p', (x, hk) => { handles.delete(hk); return 0; }],
    RegFlushKey: ['p', () => 0],
    RegQueryValueExA: ['pppppp', (x, hk, name, r, type, data, cb) => query(x, hk, name, type, data, cb)],
    RegSetValueExA: ['ppuupu', (x, hk, name, r, type, data, cb) => {
      const k = keys.get(handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase()); if (!k) return 6;
      k.values.set(valueName(x, name), { type, data: data ? x.bytes(data, cb) : new Uint8Array(0) }); return 0;
    }],
    // RegSetValueA(key, subkey, REG_SZ, text, n): the subkey's default value (made if it is not there).
    RegSetValueA: ['ppupu', (x, hk, sub, type, data) => {
      const t = x.win.heapAlloc(4);
      try { const r = sub && x.r8(sub) ? create(x, hk, sub, t, 0) : (x.w32(t, hk), 0); if (r) return r; return advapi32.RegSetValueExA[1](x, x.r32(t), 0, 0, 1, data, data ? x.str(data).length + 1 : 0); } finally { x.win.heapFree(t); }
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
    RegEnumKeyA: ['pupu', (x, hk, i, name, n) => { const t = x.win.heapAlloc(4); x.w32(t, n); try { return advapi32.RegEnumKeyExA[1](x, hk, i, name, t); } finally { x.win.heapFree(t); } }],
    // The values one by one: name, type, data (ERROR_NO_MORE_ITEMS after the last).
    RegEnumValueA: ['pupppppp', (x, hk, i, name, cbName, r, type, data, cb) => {
      const k = keys.get(handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase()), all = k ? [...k.values] : [];
      if (i >= all.length) return 259;
      const [n, v] = all[i];
      if (x.r32(cbName) <= n.length) return 234;
      x.write(name, new TextEncoder().encode(n + '\0')); x.w32(cbName, n.length);
      if (type) x.w32(type, v.type);
      if (cb) { const room = x.r32(cb); x.w32(cb, v.data.length); if (data) { if (room < v.data.length) return 234; x.write(data, v.data); } }
      return 0;
    }],
    // The key's counts: subkeys and values, and their longest names and data.
    RegQueryInfoKeyA: ['pppppppppppp', (x, hk, cls, cbCls, r, nSub, maxSub, maxCls, nVal, maxName, maxData) => {
      const p = handles.get(hk) || (ROOTS[hk >>> 0] || '').toLowerCase(), k = keys.get(p);
      const kids = [...keys.keys()].filter((q) => q.startsWith(p + '\\') && !q.slice(p.length + 1).includes('\\')).map((q) => q.slice(p.length + 1));
      const vals = k ? [...k.values] : [];
      if (cls && cbCls) { x.w8(cls, 0); x.w32(cbCls, 0); }
      const put = (q, v) => { if (q) x.w32(q, v); };
      put(nSub, kids.length); put(maxSub, Math.max(0, ...kids.map((q) => q.length))); put(maxCls, 0);
      put(nVal, vals.length); put(maxName, Math.max(0, ...vals.map(([n]) => n.length))); put(maxData, Math.max(0, ...vals.map(([, v]) => v.data.length)));
      return 0;
    }],
    // Privileges (an installer's, to restart Windows): a token that holds none, and nothing to adjust.
    OpenProcessToken: ['pup', (x, proc, acc, out) => { x.w32(out, st.newHandle('token', {})); return 1; }],
    LookupPrivilegeValueA: ['ppp', (x, sys, name, luid) => { x.w32(luid, 0x13); x.w32(luid + 4, 0); return 1; }],
    AdjustTokenPrivileges: ['pipupp', () => 1],
  };
  // ---- winmm: MCI by strings. No CD drive: "open cdaudio" and the rest answer MCIERR_INVALID_DEVICE_NAME,
  // which a game takes for a machine without its music. The command goes to the log.
  const winmm = {
    /*
     * MCI's command strings for a video (an .avi, or type AVIVideo): "open <file> [type avivideo] [alias a]
     * [parent <hwnd>] ...", "window a handle <hwnd>", "play a [notify]", "stop", "close", "status a mode",
     * "where". The video itself is st.video's (api.js: an AVI decoded and drawn into the window, its sound
     * played, MM_MCINOTIFY at its end). Anything else: no such device (263).
     */
    mciSendStringA: ['ppup', (x, cmd, ret, n, cb) => {
      const s = x.str(cmd, 512).trim(), w = s.split(/\s+/), verb = (w[0] || '').toLowerCase(), put = (t) => { if (ret && n) putStr(x, ret, n, t); };
      const after = (k) => { const i = w.findIndex((t) => t.toLowerCase() === k); return i > 0 ? w[i + 1] : undefined; };
      put('');
      if (verb === 'open') {
        const file = w[1] || '', alias = (after('alias') || file).toLowerCase();
        const video = /\.avi$/i.test(file) || /\btype\s+avivideo\b/i.test(s);
        const id = video ? st.video.open(x, file, Number(after('parent')) || 0) : 0;
        if (!id) { x.win.say(`mciSendStringA("${s}"): no such device`); return 263; }
        mciVideos.set(alias, id); put(String(id)); return 0;
      }
      const id = mciVideos.get((w[1] || '').toLowerCase());
      if (!id) { x.win.say(`mciSendStringA("${s}"): no such device`); return 263; }
      if (verb === 'close') { st.video.close(x, id); mciVideos.delete(w[1].toLowerCase()); return 0; }
      // "play ... wait" returns at the video's end (or its break key, "break ... on <vk>": Half-Life's Escape),
      // the call waiting frame after frame -- each time it runs again the video goes on, not anew.
      if (verb === 'play' && /\bwait\b/i.test(s)) {
        if (!st.video.waiting(id)) st.video.play(x, id, /\bnotify\b/i.test(s) ? cb : 0, true);
        const next = st.video.tick(x);
        if (st.video.playing(id) && !st.video.broken(id)) return x.waitUntil(Math.min(next, x.lx.mono() + 0.05));
        if (st.video.playing(id)) st.video.stop(x, id);
        st.video.waited(id); return 0;
      }
      if (verb === 'play') st.video.play(x, id, /\bnotify\b/i.test(s) ? cb : 0);
      if (verb === 'break' && after('on')) st.video.breakKey(id, Number(after('on')));
      if (verb === 'put' && /\bdestination\b/i.test(s)) { const i = w.findIndex((t) => t.toLowerCase() === 'at'); if (i > 0) st.video.dest(id, w.slice(i + 1, i + 5).map(Number)); }
      if (verb === 'stop' || verb === 'pause') st.video.stop(x, id);
      if (verb === 'window' && after('handle')) st.video.window(id, Number(after('handle')));
      if (verb === 'status') put(/\bmode\b/i.test(s) ? (st.video.playing(id) ? 'playing' : 'stopped') : /\bready\b/i.test(s) ? 'true' : '0');
      if (verb === 'where') put('0 0 ' + st.video.size(id).join(' '));
      return 0;
    }],
    mciGetErrorStringA: ['upu', (x, err, buf, n) => putStr(x, buf, n, err === 263 ? 'The specified device is not open or is not recognized by MCI.' : 'MCI error ' + err) ? 1 : 0],
    mciGetDeviceIDA: ['p', (x, name) => mciVideos.get(x.str(name, 128).toLowerCase()) || 0],
  };
  // ---- version.dll: no version resource is read here (a program asks, and goes on without);
  // ---- ole32.dll: COM started, and no class registered (REGDB_E_CLASSNOTREG) -- Half-Life's engine
  // asks for DirectX's and the shell's objects, and does without.
  // The program's own file is read (its VS_VERSIONINFO resource, RT_VERSION 16): Cave Story shows its
  // version on its title screen from it. VerQueryValue answers "\\" (VS_FIXEDFILEINFO, after the
  // block's header and its key L"VS_VERSION_INFO", on a 4-byte boundary); other files have none here.
  // A DLL made here has the version of XP SP3's (DirectX's 5.3.2600.5512, the others 5.1.2600.5512): a
  // VS_VERSIONINFO of its fixed part alone. The StarCraft installer reads ddraw.dll's before it installs.
  const madeVersions = new Map();
  /*
   * VS_VERSIONINFO, as a .rc compiles it: nodes of { wLength, wValueLength, wType (1 text), key in UTF-16,
   * padding to 4, value, padding, children }. A DLL made here has XP's: its fixed file info, its strings
   * in US English (StringFileInfo\040904B0) and that language in VarFileInfo\Translation -- Jazz
   * Jackrabbit 2 reads the Translation of each DirectX DLL it loads, and does not check it got one.
   */
  const verNode = (key, value, children = []) => {
    const k = [...key].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]).concat([0, 0]);
    const text = typeof value === 'string', val = text ? [...value].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]).concat([0, 0]) : [...(value || [])];
    const pad = (a) => { while (a.length % 4) a.push(0); return a; };
    const body = pad([0, 0, 0, 0, 0, 0, ...k]); body.push(...val); pad(body);
    for (const c of children) body.push(...pad([...c]));
    const v = new DataView(Uint8Array.from(body).buffer);
    v.setUint16(0, body.length, true); v.setUint16(2, text ? val.length / 2 : val.length, true); v.setUint16(4, text ? 1 : 0, true);
    return new Uint8Array(v.buffer);
  };
  const madeVersion = (x, name) => {
    if (!x.win.made || !x.win.made(name)) return null;
    if (madeVersions.has(name)) return madeVersions.get(name);
    const ms = /^(ddraw|dsound|dinput|d3d)/.test(name) ? 0x50003 : 0x50001, ver = `${ms >>> 16}.${ms & 0xffff}.2600.5512`;
    const fixed = new Uint8Array(52), fv = new DataView(fixed.buffer);
    [0xfeef04bd, 0x10000, ms, 0x0a281588, ms, 0x0a281588, 0x3f, 0, 0x40004, 2, 0, 0, 0].forEach((w, i) => fv.setUint32(4 * i, w >>> 0, true));
    const b = verNode('VS_VERSION_INFO', fixed, [
      verNode('StringFileInfo', null, [verNode('040904B0', null, [verNode('CompanyName', 'Microsoft Corporation'), verNode('FileVersion', ver), verNode('InternalName', name), verNode('OriginalFilename', name), verNode('ProductVersion', ver)])]),
      verNode('VarFileInfo', null, [verNode('Translation', [0x09, 0x04, 0xb0, 0x04])]),
    ]);
    const at = x.win.heapAlloc(b.length); x.write(at, b);
    const r = { at, size: b.length }; madeVersions.set(name, r); return r;
  };
  // A node of a version block by its path ("\\", "\\VarFileInfo\\Translation", "\\StringFileInfo\\040904B0\\FileVersion").
  const verFind = (x, block, path) => {
    const al = (a) => block + ((a - block + 3) & ~3);
    const node = (p) => {
      let key = '', q = p + 6; for (let c; (c = x.r16(q)); q += 2) key += String.fromCharCode(c);
      const len = x.r16(p), vlen = x.r16(p + 2), type = x.r16(p + 4), vo = al(q + 2), vb = type === 1 ? vlen * 2 : vlen;
      return { p, key, len, vlen, type, vo, kids: al(vo + vb) };
    };
    let n = node(block);
    for (const part of path.split('\\').filter(Boolean)) {
      let found = null;
      for (let c = n.kids; c < n.p + n.len;) { const k = node(c); if (!k.len) break; if (k.key.toLowerCase() === part.toLowerCase()) { found = k; break; } c = al(c + k.len); }
      if (!found) return null; n = found;
    }
    return n;
  };
  const ownVersion = (x, f) => {
    const name = x.str(f, 260).split('\\').pop().toLowerCase();
    if (name !== x.win.path.split('\\').pop().toLowerCase()) return madeVersion(x, name);
    return findResource(x, x.win.base, 16, 1);
  };
  const version = {
    GetFileVersionInfoSizeA: ['pp', (x, f, h) => { if (h) x.w32(h, 0); const r = ownVersion(x, f); return r ? r.size : 0; }],
    GetFileVersionInfoA: ['puup', (x, f, h, n, buf) => { const r = ownVersion(x, f); if (!r) return 0; x.write(buf, x.bytes(r.at, Math.min(n, r.size))); return 1; }],
    // A text value comes back in ANSI (a copy), as VerQueryValueA gives it; nothing found clears both.
    VerQueryValueA: ['pppp', (x, block, sub, pp, plen) => {
      const n = verFind(x, block, x.str(sub, 256));
      if (!n || (!n.vlen && n.type !== 1)) { x.w32(pp, 0); if (plen) x.w32(plen, 0); return 0; }
      if (n.type === 1) { let t = ''; for (let i = 0; i < n.vlen; i++) { const c = x.r16(n.vo + 2 * i); if (!c) break; t += String.fromCharCode(c); } const a = x.win.heapAlloc(t.length + 1); x.write(a, Uint8Array.from([...t].map((c) => c.charCodeAt(0) & 255).concat([0]))); x.w32(pp, a); if (plen) x.w32(plen, t.length + 1); return 1; }
      x.w32(pp, n.vo); if (plen) x.w32(plen, n.vlen); return 1;
    }],
  };
  // The Unicode twins: the file's name narrowed; a text value given back where it is in the block (UTF-16),
  // its length in characters (GameMaker Studio 2 asks its own file's).
  const narrowed = (x, w, fn) => {
    let s = ''; for (let i = 0; i < 260; i++) { const c = x.r16(w + 2 * i); if (!c) break; s += String.fromCharCode(c & 0xff); }
    const p = x.win.heapAlloc(s.length + 1); x.write(p, Uint8Array.from(s + '\0', (c) => c.charCodeAt(0)));
    try { return fn(p); } finally { x.win.heapFree(p); }
  };
  Object.assign(version, {
    GetFileVersionInfoSizeW: ['pp', (x, f, h) => narrowed(x, f, (a) => version.GetFileVersionInfoSizeA[1](x, a, h))],
    GetFileVersionInfoW: ['puup', (x, f, h, n, buf) => narrowed(x, f, (a) => version.GetFileVersionInfoA[1](x, a, h, n, buf))],
    VerQueryValueW: ['pppp', (x, block, sub, pp, plen) => {
      let path = ''; for (let i = 0; i < 256; i++) { const c = x.r16(sub + 2 * i); if (!c) break; path += String.fromCharCode(c); }
      const n = verFind(x, block, path);
      if (!n || (!n.vlen && n.type !== 1)) { x.w32(pp, 0); if (plen) x.w32(plen, 0); return 0; }
      x.w32(pp, n.vo); if (plen) x.w32(plen, n.vlen); return 1;
    }],
  });
  const ole32 = {
    // CoCreateGuid(&guid): sixteen random bytes, a version 4 GUID.
    CoCreateGuid: ['p', (x, g) => {
      const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
      b[7] = (b[7] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; x.write(g, b); return 0;
    }],
    // OLE drag and drop and class objects: registered, never called here (nothing is dropped).
    RegisterDragDrop: ['pp', () => 0], RevokeDragDrop: ['p', () => 0], CoDisconnectObject: ['pu', () => 0],
    CoRegisterClassObject: ['ppuup', (x, clsid, unk, ctx, flags, cookie) => { if (cookie) x.w32(cookie, 1); return 0; }],
    CoRevokeClassObject: ['u', () => 0],
    ProgIDFromCLSID: ['pp', () => 0x80040154],                       // REGDB_E_CLASSNOTREG
    CoFreeUnusedLibraries: ['', () => 0],
    CoInitialize: ['p', () => 0], CoInitializeEx: ['pu', () => 0], CoUninitialize: ['', () => 0],
    OleInitialize: ['p', () => 0], OleUninitialize: ['', () => 0],    // COM and OLE ready (Winamp's NSIS setup, before it browses folders)
    // Internet Explorer's WebBrowser control (an inert one, below); any other class is not registered.
    CoCreateInstance: ['ppupp', (x, clsid, outer, ctx, iid, pp) => {
      if (pp) x.w32(pp, 0);
      const made = st.coClasses && st.coClasses.get(guid(x, clsid));   // DirectMusic's (src/win32/dmusic.js)
      if (made) return made(x, iid, pp);
      if (guid(x, clsid) === '00021401-0000-0000-c000-000000000046') return linkQI(x, newLink(x), iid, pp);   // CLSID_ShellLink
      if (guid(x, clsid) !== CLSID_WEBBROWSER) return 0x80040154;   // REGDB_E_CLASSNOTREG
      const o = oleControl(x); return OLE_IMPL.IUnknown.QueryInterface(x, o, iid, pp);
    }],
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
  // is no shell to open them with -- SE_ERR_NOASSOC, and FindExecutable finds no program for them).
  // The special folders by CSIDL, as the registry's shell folders name them (a Windows 98 layout).
  const CSIDL = { 0x00: 'C:\\WINDOWS\\Desktop', 0x02: 'C:\\WINDOWS\\Start Menu\\Programs', 0x05: 'C:\\My Documents', 0x07: 'C:\\WINDOWS\\Start Menu\\Programs\\StartUp',
    0x0b: 'C:\\WINDOWS\\Start Menu', 0x10: 'C:\\WINDOWS\\Desktop', 0x14: 'C:\\WINDOWS\\Fonts', 0x16: 'C:\\WINDOWS\\Start Menu', 0x17: 'C:\\WINDOWS\\Start Menu\\Programs',
    0x18: 'C:\\WINDOWS\\Start Menu\\Programs\\StartUp', 0x19: 'C:\\WINDOWS\\Desktop', 0x1a: 'C:\\WINDOWS\\Application Data', 0x23: 'C:\\WINDOWS\\Application Data',
    0x24: 'C:\\WINDOWS', 0x25: 'C:\\WINDOWS\\SYSTEM', 0x26: 'C:\\Program Files', 0x2b: 'C:\\Program Files\\Common Files' };
  const shell32 = {
    // The taskbar's notification area: none to put an icon in, the call answered (Winamp's tray icon).
    Shell_NotifyIconA: ['up', () => 1], DragQueryPoint: ['pp', () => 0],
    DragAcceptFiles: ['pi', () => 0], DragFinish: ['p', () => 0],
    DragQueryFileA: ['pupu', () => 0],
    ShellExecuteA: ['ppppppi', () => 31],
    // The shell's allocator (the process heap's) and its namespace: a desktop folder with nothing in it
    // (COM objects below). The StarCraft installer fills its folder tree from it, and stopped when there was
    // none ("exp1: Error 0"). A file's information: none (0).
    SHGetMalloc: ['p', (x, pp) => { x.w32(pp, shellObj(x, 'IMalloc')); return 0; }],
    SHGetDesktopFolder: ['p', (x, pp) => { x.w32(pp, shellObj(x, 'IShellFolder')); return 0; }],
    SHGetFileInfoA: ['pupuu', () => 0],
    SHChangeNotify: ['uupp', () => 0],                                 // no shell to tell (an installer's new shortcuts)
    FindExecutableA: ['ppp', (x, f, d, out) => { if (out) x.w8(out, 0); return 31; }],
    /*
     * The special folders (CSIDL), as a fresh Windows 98 has them (the shell folders the registry names):
     * an item ID list of one item that carries the path ('MRGP' then the path), which SHGetPathFromIDListA
     * reads back -- Warcraft III's installer puts its shortcuts in Programs. One not known: E_FAIL.
     */
    SHGetSpecialFolderLocation: ['pip', (x, h, csidl, pp) => {
      const path = CSIDL[csidl & 0xff]; if (pp) x.w32(pp, 0); if (!path) return 0x80004005;
      const n = 2 + 4 + path.length + 1, l = x.win.heapAlloc(n + 2); x.w16(l, n); x.write(l + 2, Uint8Array.from('MRGP' + path + '\0', (c) => c.charCodeAt(0))); x.w16(l + n, 0);
      if (pp) x.w32(pp, l); return 0;
    }],
    SHGetPathFromIDListA: ['pp', (x, l, out) => {
      const ok = l && x.r16(l) > 6 && x.str(l + 2, 4) === 'MRGP'; if (!out) return ok ? 1 : 0;
      if (!ok) { x.w8(out, 0); return 0; } x.write(out, Uint8Array.from(x.str(l + 6, 260) + '\0', (c) => c.charCodeAt(0))); return 1;
    }],
  };
  /*
   * The shell's COM objects, made as ddraw.js makes DirectDraw's: a pointer to a vtable of shell32's
   * exports named "Interface::Method". IMalloc allocates on the heap; the desktop's IShellFolder lists no
   * item (its IEnumIDList ends at once, S_FALSE), is named "Desktop", and binds to nothing (E_FAIL).
   */
  const E_FAIL = 0x80004005, SHELL_VT = {
    IShellLinkA: 'GetPath:4 GetIDList:1 SetIDList:1 GetDescription:2 SetDescription:1 GetWorkingDirectory:2 SetWorkingDirectory:1 GetArguments:2 SetArguments:1 GetHotkey:1 SetHotkey:1 GetShowCmd:1 SetShowCmd:1 GetIconLocation:3 SetIconLocation:2 SetRelativePath:2 Resolve:2 SetPath:1',
    IPersistFile: 'GetClassID:1 IsDirty:0 Load:2 Save:2 SaveCompleted:1 GetCurFile:1',
    IMalloc: 'Alloc:1 Realloc:2 Free:1 GetSize:1 DidAlloc:1 HeapMinimize:0',
    IShellFolder: 'ParseDisplayName:6 EnumObjects:3 BindToObject:4 BindToStorage:4 CompareIDs:3 CreateViewObject:3 GetAttributesOf:3 GetUIObjectOf:6 GetDisplayNameOf:3 SetNameOf:5',
    IEnumIDList: 'Next:3 Skip:1 Reset:0 Clone:1',
  };
  const shellVt = new Map();
  const vtOf = (x, iface) => {
    if (!shellVt.has(iface)) {
      const mod = x.win.load('shell32.dll'), ms = ['QueryInterface', 'AddRef', 'Release', ...SHELL_VT[iface].split(' ').map((t) => t.split(':')[0])];
      const v = x.win.heapAlloc(4 * ms.length); ms.forEach((n, i) => x.w32(v + 4 * i, mod.exports.get(`${iface}::${n}`)));
      shellVt.set(iface, v);
    }
    return shellVt.get(iface);
  };
  const shellObj = (x, iface) => { const p = x.win.heapAlloc(8); x.w32(p, vtOf(x, iface)); return p; };
  /*
   * CLSID_ShellLink: a shortcut, IShellLinkA and IPersistFile (two pointers of one block, QueryInterface
   * giving the one asked): its target, arguments, folder, description and icon kept, Save writing the
   * .lnk file on the disk (a line naming its target: no shell reads it here).
   */
  const IID_UNKNOWN = '00000000-0000-0000-c000-000000000046', IID_SHELLLINKA = '000214ee-0000-0000-c000-000000000046', IID_PERSISTFILE = '0000010b-0000-0000-c000-000000000046';
  const links = new Map();                                              // the IShellLinkA pointer -> its fields
  const linkOf = (self) => links.get(self) || links.get(self - 4);
  const newLink = (x) => { const p = x.win.heapAlloc(8); x.w32(p, vtOf(x, 'IShellLinkA')); x.w32(p + 4, vtOf(x, 'IPersistFile')); links.set(p, { path: '', args: '', dir: '', desc: '', icon: '' }); return p; };
  const linkQI = (x, self, iid, pp) => {
    const base = links.has(self) ? self : self - 4, id = guid(x, iid);
    const to = id === IID_UNKNOWN || id === IID_SHELLLINKA ? base : id === IID_PERSISTFILE ? base + 4 : 0;
    x.w32(pp, to); return to ? 0 : 0x80004002;                          // E_NOINTERFACE
  };
  const linkSet = (key) => (x, self, p) => { linkOf(self)[key] = p ? x.str(p, 1024) : ''; return 0; };
  const linkGet = (key) => (x, self, buf, n) => { const s = linkOf(self)[key]; if (buf && n > 0) x.write(buf, Uint8Array.from(s.slice(0, n - 1) + '\0', (c) => c.charCodeAt(0) & 255)); return 0; };
  const SHELL_IMPL = {
    IShellLinkA: { QueryInterface: linkQI, SetPath: linkSet('path'), GetPath: linkGet('path'), SetArguments: linkSet('args'), GetArguments: linkGet('args'),
      SetWorkingDirectory: linkSet('dir'), GetWorkingDirectory: linkGet('dir'), SetDescription: linkSet('desc'), GetDescription: linkGet('desc'),
      SetIconLocation: (x, self, p, i) => { linkOf(self).icon = p ? x.str(p, 260) : ''; return 0; }, GetIconLocation: (x, self, buf, n, pi) => { linkGet('icon')(x, self, buf, n); if (pi) x.w32(pi, 0); return 0; },
      SetShowCmd: () => 0, GetShowCmd: (x, self, p) => { if (p) x.w32(p, 1); return 0; }, SetHotkey: () => 0, GetHotkey: (x, self, p) => { if (p) x.w16(p, 0); return 0; },
      SetIDList: () => 0, GetIDList: (x, self, pp) => { if (pp) x.w32(pp, 0); return E_FAIL; }, SetRelativePath: () => 0, Resolve: () => 0 },
    IPersistFile: { QueryInterface: linkQI, IsDirty: () => 0, SaveCompleted: () => 0, Load: () => E_FAIL, GetCurFile: (x, self, pp) => { if (pp) x.w32(pp, 0); return E_FAIL; },
      GetClassID: (x, self, p) => { x.write(p, Uint8Array.of(0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46)); return 0; },
      Save: (x, self, name) => {                                         // its name in UTF-16
        let f = ''; for (let i = 0; ; i++) { const c = x.r16(name + 2 * i); if (!c) break; f += String.fromCharCode(c); }
        const L = linkOf(self), b = new TextEncoder().encode(`[MIRAGE shortcut]\r\nTarget=${L.path}\r\nArguments=${L.args}\r\nDirectory=${L.dir}\r\n`);
        st.disk.set(st.relPath(f), { bytes: b, size: b.length }); return 0;
      } },
    IMalloc: { Alloc: (x, self, n) => x.win.heapAlloc(n), Realloc: (x, self, p, n) => { const q = x.win.heapAlloc(n); if (p) x.write(q, x.bytes(p, n)); return q; },
      Free: () => 0, GetSize: () => -1, DidAlloc: () => -1, HeapMinimize: () => 0 },
    IShellFolder: {
      EnumObjects: (x, self, hwnd, flags, pp) => { x.w32(pp, shellObj(x, 'IEnumIDList')); return 0; },
      CompareIDs: () => 0, GetAttributesOf: () => 0,
      // STRRET_CSTR (2): the name in the structure itself, at 4.
      GetDisplayNameOf: (x, self, pidl, flags, sr) => { x.w32(sr, 2); x.write(sr + 4, new TextEncoder().encode('Desktop\0')); return 0; },
    },
    IEnumIDList: { Next: (x, self, n, items, got) => { if (got) x.w32(got, 0); return 1; }, Skip: () => 1, Reset: () => 0 },
  };
  for (const [iface, list] of Object.entries(SHELL_VT)) {
    let ord = 2000 + Object.keys(shell32).length;
    const all = [['QueryInterface', 2], ['AddRef', 0], ['Release', 0], ...list.split(' ').map((t) => t.split(':'))];
    for (const [n, k] of all) {
      const f = n === 'QueryInterface' ? (SHELL_IMPL[iface].QueryInterface || ((x, self, iid, pp) => { x.w32(pp, self); return 0; })) : n === 'AddRef' || n === 'Release' ? () => 1
        : (SHELL_IMPL[iface][n] || ((x, self, ...a) => { const pp = { BindToObject: a[3], BindToStorage: a[3], CreateViewObject: a[2], Clone: a[0] }[n]; if (pp) x.w32(pp, 0); return E_FAIL; }));
      shell32[`${iface}::${n}`] = ['p' + 'u'.repeat(+k), f, { ordinal: ord++ }];
    }
  }
  /*
   * An inert OLE control for CLSID_WebBrowser: GameMaker 8's runner (Delphi) puts Internet Explorer's
   * WebBrowser on its help form, and every form is made at start -- the class not registered, the runner
   * stopped there ("OLE error 80040154"). It answers the interfaces a control's host asks for, each a
   * pointer of its own in one block (QueryInterface hands out the one asked, E_NOINTERFACE else), draws
   * nothing and navigates nowhere. Methods are ole32's exports named "Interface::Method", as the shell's.
   */
  const guid = (x, p) => { const b = x.bytes(p, 16), h = (i, n) => [...b.slice(i, i + n)].map((v) => v.toString(16).padStart(2, '0')).join(''), r = (i, n) => h(i, n).match(/../g).reverse().join('');
    return `${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}`; };
  const CLSID_WEBBROWSER = '8856f961-340a-11d0-a96b-00c04fd705a2';
  const OLE_VT = {
    IUnknown: ['00000000-0000-0000-c000-000000000046', ''],
    IOleObject: ['00000112-0000-0000-c000-000000000046', 'SetClientSite:1 GetClientSite:1 SetHostNames:2 Close:1 SetMoniker:2 GetMoniker:3 InitFromData:3 GetClipboardData:2 DoVerb:6 EnumVerbs:1 Update:0 IsUpToDate:0 GetUserClassID:1 GetUserType:2 SetExtent:2 GetExtent:2 Advise:2 Unadvise:1 EnumAdvise:1 GetMiscStatus:2 SetColorScheme:1'],
    IPersistStreamInit: ['7fd52380-4e07-101b-ae2d-08002b2ec713', 'GetClassID:1 IsDirty:0 Load:1 Save:2 GetSizeMax:1 InitNew:0'],
    IOleControl: ['b196b288-bab4-101a-b69c-00aa00341d07', 'GetControlInfo:1 OnMnemonic:1 OnAmbientPropertyChange:1 FreezeEvents:1'],
    IOleInPlaceObject: ['00000113-0000-0000-c000-000000000046', 'GetWindow:1 ContextSensitiveHelp:1 InPlaceDeactivate:0 UIDeactivate:0 SetObjectRects:2 ReactivateAndUndo:0'],
    IOleInPlaceActiveObject: ['00000117-0000-0000-c000-000000000046', 'GetWindow:1 ContextSensitiveHelp:1 TranslateAccelerator:1 OnFrameWindowActivate:1 OnDocWindowActivate:1 ResizeBorder:3 EnableModeless:1'],
    IViewObject: ['0000010d-0000-0000-c000-000000000046', 'Draw:10 GetColorSet:6 Freeze:4 Unfreeze:1 SetAdvise:3 GetAdvise:3'],
    IDispatch: ['00020400-0000-0000-c000-000000000046', 'GetTypeInfoCount:1 GetTypeInfo:3 GetIDsOfNames:5 Invoke:8'],
  };
  const OLE_IFACES = Object.keys(OLE_VT), E_NOTIMPL = 0x80004001;
  const out0 = (n) => (x, self, ...a) => { if (a[n]) x.w32(a[n], 0); return E_NOTIMPL; };   // an out pointer cleared
  const OLE_IMPL = {
    IUnknown: {
      QueryInterface: (x, self, iid, pp) => {
        const g = guid(x, iid), i = OLE_IFACES.findIndex((k) => OLE_VT[k][0] === g), blk = oleBase(x, self);
        if (i < 0) { x.w32(pp, 0); if (!(st.saidIids ||= new Set()).has(g)) { st.saidIids.add(g); x.win.say(`WebBrowser: no interface ${g}`); } return 0x80004002; }
        x.w32(pp, blk + 4 * i); return 0;
      },
      AddRef: () => 1, Release: () => 1,
    },
    IOleObject: { GetClientSite: out0(0), GetMoniker: out0(2), EnumVerbs: out0(0), GetUserClassID: () => E_NOTIMPL, GetUserType: out0(1), EnumAdvise: out0(0),
      InitFromData: () => E_NOTIMPL, GetClipboardData: out0(1), Advise: (x, self, sink, pc) => { x.w32(pc, 1); return 0; },
      GetExtent: (x, self, aspect, sz) => { x.w32(sz, 0); x.w32(sz + 4, 0); return 0; }, GetMiscStatus: (x, self, aspect, p) => { x.w32(p, 0); return 0; } },
    IPersistStreamInit: { GetClassID: () => E_NOTIMPL, IsDirty: () => 1, GetSizeMax: (x, self, p) => { x.w32(p, 0); x.w32(p + 4, 0); return 0; } },
    IOleControl: { GetControlInfo: (x, self, ci) => { x.w32(ci + 4, 0); x.w16(ci + 8, 0); x.w32(ci + 12, 0); return 0; } },
    IOleInPlaceObject: { GetWindow: out0(0), ContextSensitiveHelp: () => E_NOTIMPL, ReactivateAndUndo: () => E_NOTIMPL },
    IOleInPlaceActiveObject: { GetWindow: out0(0), ContextSensitiveHelp: () => E_NOTIMPL, TranslateAccelerator: () => 1 },
    IViewObject: { GetColorSet: out0(5), GetAdvise: () => E_NOTIMPL },
    IDispatch: { GetTypeInfoCount: (x, self, p) => { x.w32(p, 0); return 0; }, GetTypeInfo: out0(2), GetIDsOfNames: () => 0x80020006, Invoke: () => 0x80020003 },
  };
  // The block: one vtable pointer per interface, in OLE_VT's order; an interface pointer's block is
  // found from its vtable's place in that order.
  const oleVt = new Map();
  const oleBase = (x, self) => { const v = x.r32(self), i = [...oleVt.values()].indexOf(v); return self - 4 * Math.max(0, i); };
  const oleControl = (x) => {
    const mod = x.win.load('ole32.dll');
    for (const k of OLE_IFACES) if (!oleVt.has(k)) {
      const ms = ['QueryInterface', 'AddRef', 'Release', ...OLE_VT[k][1].split(' ').filter(Boolean).map((t) => t.split(':')[0])];
      const v = x.win.heapAlloc(4 * ms.length); ms.forEach((n, i) => x.w32(v + 4 * i, mod.exports.get(`${k}::${n}`))); oleVt.set(k, v);
    }
    const p = x.win.heapAlloc(4 * OLE_IFACES.length);
    OLE_IFACES.forEach((k, i) => x.w32(p + 4 * i, oleVt.get(k)));
    return p;
  };
  {
    let ord = 3000;
    for (const [k, [, list]] of Object.entries(OLE_VT)) for (const [n, c] of [['QueryInterface', 2], ['AddRef', 0], ['Release', 0], ...list.split(' ').filter(Boolean).map((t) => t.split(':'))]) {
      const f = OLE_IMPL.IUnknown[n] || (OLE_IMPL[k] && OLE_IMPL[k][n]) || (() => 0);
      ole32[`${k}::${n}`] = ['p' + 'u'.repeat(+c), f, { ordinal: ord++ }];
    }
  }
  // ---- imm32.dll: no input method -- a window has no input context.
  const imm32 = {
    ImmGetContext: ['p', () => 0], ImmReleaseContext: ['pp', () => 1], ImmSetOpenStatus: ['pi', () => 0], ImmAssociateContext: ['pp', () => 0],
  };
  return { kernel32, user32, gdi32, advapi32, winmm, version, ole32, shlwapi, shell32, imm32 };
}
