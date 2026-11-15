// modern.js — the Win32 a program of the 2010s and 2020s asks for that the XP-era tables (api.js,
// classic.js) did not: the Unicode (W) functions, the Vista-and-later kernel32 a Visual C++ 2015+
// runtime calls at start-up, and the user32, shell32, imm32 and setupapi a library such as SDL 2 reaches
// for. Abuse (Xenoveritas' SDL 2 port of 2022, the Win32 build) is the first program here to need them.
//
// A W function is its A twin wherever one exists: the UTF-16 string is copied to the heap as the
// program's code page has it (Latin-1, as `wide` in api.js) and the A function answers; a string it
// gives back is widened into the caller's buffer.
import { cprintf } from './ucrt.js';

/** UTF-16 at `p` (NUL-terminated, or `n` units) as a JavaScript string. */
export const wstr = (x, p, n = -1) => {
  if (!p) return '';
  let s = '';
  for (let i = 0; n < 0 || i < n; i++) { const c = x.r16(p + 2 * i); if (n < 0 && !c) break; s += String.fromCharCode(c); }
  return s;
};
/** `s` and its NUL as UTF-16 bytes. */
export const wbytes = (s) => { const b = new Uint8Array(2 * s.length + 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 0xff; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
/** `s` into a buffer of `n` units (n counted in characters), truncated; the units written, NUL excluded. */
export const putW = (x, buf, n, s) => { if (!buf || n <= 0) return 0; const t = s.slice(0, n - 1); x.write(buf, wbytes(t)); return t.length; };
const putA = (x, buf, n, s) => { if (!buf || n <= 0) return 0; const t = s.slice(0, n - 1); x.write(buf, Uint8Array.from(t + '\0', (c) => c.charCodeAt(0) & 0xff)); return t.length; };

export function modernApis({ st, kernel32, user32, gdi32, send, advapi32: reg, winmm }) {
  // A Latin-1 copy of a wide string on the heap, for the A function that answers its W twin; freed after.
  const withA = (x, w, fn) => {
    if (!w) return fn(0);
    const s = wstr(x, w), p = x.win.heapAlloc(s.length + 1);
    x.write(p, Uint8Array.from(s + '\0', (c) => c.charCodeAt(0) & 0xff));
    try { return fn(p); } finally { x.win.heapFree(p); }
  };
  const A = (t, name) => t[name][1];
  const k32 = {
    /*
     * PF_* as the CPU's profile has them (src/cpu-profile.js): MMX (3), SSE (6), SSE2 (10), the
     * comparison and exchange instructions every P6 has (CMPXCHG8B 2? -- PF_COMPARE_EXCHANGE_DOUBLE),
     * RDTSC (8). Not PF_FASTFAIL_AVAILABLE (23): the runtime then ends a failed process by
     * TerminateProcess rather than by INT 29h, which MIRAGE has no handler for.
     */
    IsProcessorFeaturePresent: ['u', (x, f) => {
      const P = x.cpu.profile || {};
      return ({ 2: 1, 3: P.mmx ? 1 : 0, 6: P.sse ? 1 : 0, 8: 1, 10: P.sse2 ? 1 : 0 })[f] || 0;
    }],
    IsDebuggerPresent: ['', () => 0],
    // An interlocked singly linked list's head: empty.
    InitializeSListHead: ['p', (x, p) => { x.write(p, new Uint8Array(8)); return 0; }],
    InitializeCriticalSectionAndSpinCount: ['pu', (x, cs) => { A(kernel32, 'InitializeCriticalSection')(x, cs); return 1; }],
    InitializeCriticalSectionEx: ['puu', (x, cs) => { A(kernel32, 'InitializeCriticalSection')(x, cs); return 1; }],
    // Taken if free or already the caller's; never waits.
    TryEnterCriticalSection: ['p', (x, cs) => {
      const me = x.lx.pid, owner = x.r32(cs + 12);
      if (owner && owner !== me) return 0;
      x.w32(cs + 12, me); x.w32(cs + 8, x.r32(cs + 8) + 1); return 1;
    }],
    lstrlenW: ['p', (x, p) => wstr(x, p).length],
    GetModuleHandleW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'GetModuleHandleA')(x, a))],
    // GetModuleHandleExW(flags, name or address, &module): GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS (4)
    // finds the module an address lies in.
    GetModuleHandleExW: ['upp', (x, flags, w, out) => {
      let h = 0;
      if (flags & 4) { const a = w >>> 0; h = [...x.win.modules.values(), { base: x.win.base, size: x.win.size || 0x1000000 }].find((m) => a >= m.base && a < m.base + (m.size || 0x100000))?.base || x.win.base; }
      else h = withA(x, w, (a) => A(kernel32, 'GetModuleHandleA')(x, a));
      if (out) x.w32(out, h);
      return h ? 1 : 0;
    }],
    GetModuleFileNameW: ['ppu', (x, h, buf, n) => {
      const tmp = x.win.heapAlloc(n + 1);
      try { const k = A(kernel32, 'GetModuleFileNameA')(x, h, tmp, n); return putW(x, buf, n, x.str(tmp, k)); } finally { x.win.heapFree(tmp); }
    }],
    LoadLibraryW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'LoadLibraryA')(x, a))],
    LoadLibraryExW: ['ppu', (x, w) => withA(x, w, (a) => A(kernel32, 'LoadLibraryA')(x, a))],
    DisableThreadLibraryCalls: ['p', () => 1],
    OutputDebugStringW: ['p', () => 0],
    CreateEventW: ['puup', (x, sa, manual, initial, name) => A(kernel32, 'CreateEventA')(x, sa, manual, initial, 0)],
    WaitForSingleObjectEx: ['puu', (x, h, ms) => A(kernel32, 'WaitForSingleObject')(x, h, ms)],
    SetThreadExecutionState: ['u', () => 0x80000000],              // ES_CONTINUOUS: what it was
    // MEMORYSTATUSEX: 64 MiB of RAM, half of it free, a 2 GiB address space -- GlobalMemoryStatus's machine.
    GlobalMemoryStatusEx: ['p', (x, p) => {
      if (x.r32(p) < 64) return 0;
      x.w32(p + 4, 50);
      [[8, 64 << 20], [16, 32 << 20], [24, 192 << 20], [32, 160 << 20], [40, 0x7ffe0000], [48, 0x7f000000], [56, 0]].forEach(([o, v]) => { x.w32(p + o, v); x.w32(p + o + 4, 0); });
      return 1;
    }],
    // SYSTEM_POWER_STATUS: on the mains, no battery.
    // The environment: PATH, and what the machine's `env` sets (SDL's hints). The length without the NUL,
    // or the size needed with it when the buffer is too small, 0 when unset.
    GetEnvironmentVariableA: ['ppu', (x, name, buf, n) => {
      const k = x.str(name).toUpperCase(), v = k === 'PATH' ? 'C:\\WINDOWS\\system32' : st.env.get(k);
      if (v === undefined) return 0;
      return v.length < n ? putA(x, buf, n, v) : v.length + 1;
    }],
    GetEnvironmentVariableW: ['ppu', (x, name, buf, n) => {
      const k = wstr(x, name).toUpperCase(), v = k === 'PATH' ? 'C:\\WINDOWS\\system32' : st.env.get(k);
      if (v === undefined) return 0;
      return v.length < n ? putW(x, buf, n, v) : v.length + 1;
    }],
    // A system error's text: "Error <n>" (no message tables here); FORMAT_MESSAGE_ALLOCATE_BUFFER (100h)
    // puts it in a buffer of its own, which the caller frees with LocalFree.
    FormatMessageW: ['upuupup', (x, flags, src, id, lang, buf, n) => {
      const s = `Error ${id}`;
      if (flags & 0x100) { const b = wbytes(s), p = x.win.heapAlloc(b.length); x.write(p, b); x.w32(buf, p); return s.length; }
      return putW(x, buf, n, s);
    }],
    // VerifyVersionInfoW against Windows XP SP2 (5.1.2600): the "this version or later" question SDL asks
    // of Vista, 7 and 10 is answered no. The condition mask is not read (">=" is all a program asks).
    VerSetConditionMask: ['uuuu', (x, lo, hi, type, cond) => ({ eax: lo, edx: hi })],
    VerifyVersionInfoW: ['puuu', (x, vi, type) => {
      const want = [type & 2 ? x.r32(vi + 4) : 0, type & 1 ? x.r32(vi + 8) : 0, type & 0x20 ? x.r16(vi + 276) : 0], have = [5, 1, 2];
      for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i] ? 1 : 0;
      return 1;
    }],
    GetSystemPowerStatus: ['p', (x, p) => { x.write(p, Uint8Array.of(1, 128, 255, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)); return 1; }],
  };
  // A WNDCLASS(EX)W as its A twin: the same fields, the menu and class names (or atoms) narrowed.
  const classA = (x, wc, size, menuAt, nameAt, fn) => {
    const t = x.win.heapAlloc(size), keep = [];
    x.write(t, x.bytes(wc, size));
    for (const o of [menuAt, nameAt]) { const q = x.r32(wc + o); if (q >= 0x10000) { const s = wstr(x, q), c = x.win.heapAlloc(s.length + 1); x.write(c, Uint8Array.from(s + '\0', (ch) => ch.charCodeAt(0) & 0xff)); x.w32(t + o, c); keep.push(c); } }
    try { return fn(t); } finally { x.win.heapFree(t); for (const c of keep) x.win.heapFree(c); }
  };
  // A name argument that may be an atom (below 10000h) or a wide string.
  const nameA = (x, w, fn) => (w < 0x10000 ? fn(w) : withA(x, w, fn));
  const MONITOR = 0x10001;
  // DEVMODEW: dmDeviceName is 32 WCHARs, so every field after it lies 32 bytes further than in DEVMODEA.
  const modes = () => [[640, 480], [800, 600], [1024, 768]].flatMap(([w, h]) => [16, 32].map((b) => [w, h, b]));
  const putModeW = (x, dm, m) => {
    x.write(dm, new Uint8Array(220)); x.write(dm, wbytes('MIRAGE').subarray(0, 14));
    x.w16(dm + 64, 0x401); x.w16(dm + 68, 220); x.w32(dm + 72, 0x5c0000);   // dmSpecVersion, dmSize; PELSWIDTH|HEIGHT|BITSPERPEL|DISPLAYFREQUENCY
    x.w32(dm + 168, m[2]); x.w32(dm + 172, m[0]); x.w32(dm + 176, m[1]); x.w32(dm + 184, 60);
  };
  const desk = () => (st.modeSet ? { w: st.w, h: st.h } : st.desk || { w: 1024, h: 768 });
  const DISPLAY = String.fromCharCode(92, 92, 46, 92) + 'DISPLAY1';           // \\.\DISPLAY1
  const u32 = {
    RegisterClassW: ['p', (x, wc) => classA(x, wc, 40, 32, 36, (t) => A(user32, 'RegisterClassA')(x, t))],
    RegisterClassExW: ['p', (x, wc) => classA(x, wc, 48, 36, 40, (t) => A(user32, 'RegisterClassExA')(x, t))],
    UnregisterClassW: ['pp', () => 1],
    // Only a class the program registered: SDL asks before it registers its own.
    GetClassInfoExW: ['ppp', (x, inst, name, wc) => {
      const key = name < 0x10000 ? name : wstr(x, name).toLowerCase(), info = st.classInfo.get(key);
      if (!info) return 0;
      x.w32(wc, 48); x.write(wc + 4, info); return 1;
    }],
    DefWindowProcW: ['puuu', (x, h, m, wp, lp) => A(user32, 'DefWindowProcA')(x, h, m, wp, lp)],
    CallWindowProcW: ['ppuuu', (x, fn, h, m, wp, lp) => A(user32, 'CallWindowProcA')(x, fn, h, m, wp, lp)],
    GetMessageW: ['ppuu', (x, m, h, a, b) => A(user32, 'GetMessageA')(x, m, h, a, b)],
    DispatchMessageW: ['p', (x, m) => A(user32, 'DispatchMessageA')(x, m)],
    PostMessageW: ['puuu', (x, h, m, wp, lp) => A(user32, 'PostMessageA')(x, h, m, wp, lp)],
    SendMessageW: ['puuu', (x, h, m, wp, lp) => A(user32, 'SendMessageA')(x, h, m, wp, lp)],
    PostThreadMessageW: ['uuuu', (x, t, m, wp, lp) => A(user32, 'PostThreadMessageA')(x, t, m, wp, lp)],
    GetWindowLongW: ['pi', (x, h, i) => A(user32, 'GetWindowLongA')(x, h, i)],
    SetWindowLongW: ['pii', (x, h, i, v) => A(user32, 'SetWindowLongA')(x, h, i, v)],
    SetPropW: ['ppp', (x, h, n, v) => nameA(x, n, (a) => A(user32, 'SetPropA')(x, h, a, v))],
    GetPropW: ['pp', (x, h, n) => nameA(x, n, (a) => A(user32, 'GetPropA')(x, h, a))],
    RemovePropW: ['pp', (x, h, n) => nameA(x, n, (a) => A(user32, 'RemovePropA')(x, h, a))],
    LoadCursorW: ['pp', (x, i, n) => A(user32, 'LoadCursorA')(x, i, n)],
    LoadIconW: ['pp', (x, i, n) => A(user32, 'LoadIconA')(x, i, n)],
    SetWindowTextW: ['pp', (x, h, t) => withA(x, t, (a) => A(user32, 'SetWindowTextA')(x, h, a))],
    GetWindowTextLengthW: ['p', (x, h) => A(user32, 'GetWindowTextLengthA')(x, h)],
    GetWindowTextW: ['ppi', (x, h, buf, n) => {
      const t = x.win.heapAlloc(Math.max(1, n)); try { const k = A(user32, 'GetWindowTextA')(x, h, t, n); return putW(x, buf, n, x.str(t, k)); } finally { x.win.heapFree(t); }
    }],
    // SPI_GETWORKAREA is the A function's; the rest (the mouse's settings, the screen reader) unchanged.
    SystemParametersInfoW: ['uupu', (x, what, n, p) => (what === 0x30 ? A(user32, 'SystemParametersInfoA')(x, what, n, p) : 1)],
    GetWindowThreadProcessId: ['pp', (x, h, pid) => { if (pid) x.w32(pid, 0x100); return 1; }],
    AttachThreadInput: ['uui', () => 1],
    FlashWindowEx: ['p', () => 1], SetLayeredWindowAttributes: ['puui', () => 1], SetWindowRgn: ['ppi', () => 1],
    TrackMouseEvent: ['p', () => 1], GetMessageExtraInfo: ['', () => 0], GetDoubleClickTime: ['', () => 500],
    // The region a window is due to paint: its whole client area while it is invalid (WM_PAINT pending),
    // nothing once validated -- SDL validates its window only when this says there is something.
    GetUpdateRect: ['ppi', (x, h, r) => {
      const due = st.invalid.has(h) || (h === st.hwnd && st.invalid.has(st.hwnd)), w = st.wins.get(h);
      const cw = h === st.hwnd ? st.w : w ? w.w : 0, ch = h === st.hwnd ? st.h : w ? w.h : 0;
      if (r) { x.write(r, new Uint8Array(16)); if (due) { x.w32(r + 8, cw); x.w32(r + 12, ch); } }
      return due ? 1 : 0;
    }],
    GetClipCursor: ['p', (x, r) => { const c = st.clip || { l: 0, t: 0, r: desk().w, b: desk().h }; [c.l, c.t, c.r, c.b].forEach((v, i) => x.w32(r + 4 * i, v)); return 1; }],
    SetWindowsHookExW: ['ippu', (x, id, fn, mod, tid) => A(user32, 'SetWindowsHookExA')(x, id, fn, mod, tid)],
    // Raw input and device notifications: registered, and no device ever reports.
    RegisterRawInputDevices: ['puu', () => 1],
    GetRawInputDeviceList: ['ppu', (x, list, pn) => { if (pn) x.w32(pn, 0); return 0; }],
    GetRawInputData: ['puppu', () => -1], GetRawInputDeviceInfoA: ['pupp', () => -1],
    RegisterDeviceNotificationW: ['ppu', () => 0x7001], UnregisterDeviceNotification: ['p', () => 1],
    // Icons and cursors made from bits: a handle each, never drawn.
    CreateIconIndirect: ['p', () => 0x10002], CreateIconFromResource: ['puuu', () => 0x10002], CopyImage: ['puiiu', (x, h) => h], DestroyIcon: ['p', () => 1],
    // One monitor, the screen: its rectangle and work area, the primary one.
    MonitorFromWindow: ['pu', () => MONITOR], MonitorFromPoint: ['iiu', () => MONITOR], MonitorFromRect: ['pu', () => MONITOR],
    GetMonitorInfoW: ['pp', (x, h, mi) => {
      const d = desk(), size = x.r32(mi);
      [0, 0, d.w, d.h, 0, 0, d.w, d.h].forEach((v, i) => x.w32(mi + 4 + 4 * i, v)); x.w32(mi + 36, 1);
      if (size >= 104) x.write(mi + 40, wbytes(DISPLAY));
      return 1;
    }],
    EnumDisplayMonitors: ['pppp', (x, hdc, clip, fn, data) => {
      const d = desk(), r = st.monRect ||= x.win.heapAlloc(16);
      [0, 0, d.w, d.h].forEach((v, i) => x.w32(r + 4 * i, v));
      return send(x, [{ fn, args: [MONITOR, hdc, r, data] }], () => 1, 16);
    }],
    // DISPLAY_DEVICEW: the adapter \\.\DISPLAY1 (attached, primary), and on it one monitor.
    EnumDisplayDevicesW: ['pupu', (x, dev, i, dd, flags) => {
      if (i !== 0) return 0;
      x.write(dd + 4, new Uint8Array(836));
      const [name, label, state] = dev ? [DISPLAY + String.fromCharCode(92) + 'Monitor0', 'Generic Monitor', 3] : [DISPLAY, 'MIRAGE Display Adapter', 5];
      x.write(dd + 4, wbytes(name)); x.write(dd + 68, wbytes(label)); x.w32(dd + 324, state);
      return 1;
    }],
    EnumDisplaySettingsW: ['pup', (x, dev, i, dm) => {
      const d = desk(), m = i === 0xffffffff || i === 0xfffffffe ? [d.w, d.h, 32] : modes()[i];
      if (!m) return 0;
      putModeW(x, dm, m); return 1;
    }],
    EnumDisplaySettingsExW: ['pupu', (x, dev, i, dm) => u32.EnumDisplaySettingsW[1](x, dev, i, dm)],
    // A mode set: the A function's, with DEVMODEW's fields where DEVMODEA has them; CDS_TEST asks only.
    ChangeDisplaySettingsExW: ['pppup', (x, dev, dm, hwnd, flags) => {
      if (!dm) return A(user32, 'ChangeDisplaySettingsA')(x, 0, flags);
      const t = x.win.heapAlloc(156); x.write(t, new Uint8Array(156));
      x.w32(t + 104, x.r32(dm + 168)); x.w32(t + 108, x.r32(dm + 172)); x.w32(t + 112, x.r32(dm + 176)); x.w32(t + 120, x.r32(dm + 184));
      try { return A(user32, 'ChangeDisplaySettingsA')(x, t, flags); } finally { x.win.heapFree(t); }
    }],
    // The keyboard: US English, its state the keys the visitor holds.
    GetKeyboardLayout: ['u', () => 0x04090409],
    GetKeyboardState: ['p', (x, p) => { const b = new Uint8Array(256); for (const k of st.keys || []) if (k < 256) b[k] = 0x80; x.write(p, b); return 1; }],
    MapVirtualKeyW: ['uu', (x, code, type) => mapVk(code, type)], MapVirtualKeyA: ['uu', (x, code, type) => mapVk(code, type)],
    // ToUnicode(vk, scan, state, buf, n, flags): the character a key types, unshifted or with Shift.
    ToUnicode: ['uuppiu', (x, vk, scan, state, buf, n) => {
      const shift = state && (x.r8(state + 0x10) & 0x80), c = vkChar(vk, shift);
      if (!c || n < 1) return 0; x.w16(buf, c.charCodeAt(0)); return 1;
    }],
    DrawTextW: ['ppipu', (x, hdc, t, n, r, fmt) => withA(x, t, (a) => A(user32, 'DrawTextA')(x, hdc, a, n < 0 ? -1 : n, r, fmt))],
    // A dialog made from a template in memory (SDL's message box): not shown; IDCANCEL.
    DialogBoxIndirectParamW: ['ppppp', (x) => { x.win.say('DialogBoxIndirectParamW: a message box, not shown'); return 2; }],
    // The clipboard: empty, and kept from (OpenClipboard fails here).
    GetClipboardSequenceNumber: ['', () => 1], IsClipboardFormatAvailable: ['u', () => 0], EmptyClipboard: ['', () => 0], SetClipboardData: ['up', () => 0],
  };
  const g32 = {
    CreateDCW: ['pppp', (x, drv, dev, out, dm) => withA(x, drv, (a) => A(gdi32, 'CreateDCA')(x, a, 0, 0, 0))],
    // LOGFONTW: LOGFONTA's fields, its face name 32 WCHARs.
    CreateFontIndirectW: ['p', (x, lf) => {
      const t = x.win.heapAlloc(60); x.write(t, x.bytes(lf, 28)); x.write(t + 28, Uint8Array.from(wstr(x, lf + 28, 32).replace(/\0.*$/, '').slice(0, 31) + '\0', (c) => c.charCodeAt(0) & 0xff));
      try { return A(gdi32, 'CreateFontIndirectA')(x, t); } finally { x.win.heapFree(t); }
    }],
    // TEXTMETRICW: TEXTMETRICA's eleven longs, then its four characters as WCHARs, then the five bytes.
    GetTextMetricsW: ['pp', (x, hdc, tm) => {
      const t = x.win.heapAlloc(56);
      try {
        if (!A(gdi32, 'GetTextMetricsA')(x, hdc, t)) return 0;
        x.write(tm, x.bytes(t, 44)); for (let i = 0; i < 4; i++) x.w16(tm + 44 + 2 * i, x.r8(t + 44 + i)); x.write(tm + 52, x.bytes(t + 48, 5));
        return 1;
      } finally { x.win.heapFree(t); }
    }],
    // The screen's gamma ramp: the identity, and one set is kept (SDL reads it back).
    GetDeviceGammaRamp: ['pp', (x, hdc, p) => { if (st.gammaRamp) x.write(p, st.gammaRamp); else for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) x.w16(p + 512 * c + 2 * i, i * 257); return 1; }],
    SetDeviceGammaRamp: ['pp', (x, hdc, p) => { st.gammaRamp = x.bytes(p, 1536); return 1; }],
    GetICMProfileW: ['ppp', () => 0], GetPixelFormat: ['p', () => 0],
  };
  // advapi32: the user, and the registry's Unicode keys -- none of which is there (ERROR_FILE_NOT_FOUND).
  const advapi32 = {
    GetUserNameA: ['pp', (x, buf, pn) => { const n = x.r32(pn); x.w32(pn, 7); if (n < 7) return 0; putA(x, buf, n, 'mirage'); return 1; }],
    GetUserNameW: ['pp', (x, buf, pn) => { const n = x.r32(pn); x.w32(pn, 7); if (n < 7) return 0; putW(x, buf, n, 'mirage'); return 1; }],
    RegOpenKeyExW: ['ppuup', () => 2], RegQueryValueExW: ['pppppp', () => 2],
  };
  // shell32: the folders a program keeps its settings in (CSIDL_APPDATA and the like), all on C:; no
  // icons in its executable to extract; files dropped on the window never.
  const APPDATA = 'C:' + String.fromCharCode(92) + 'APPDATA';
  const shell32 = {
    SHGetFolderPathW: ['pipup', (x, hwnd, csidl, tok, flags, buf) => { putW(x, buf, 260, APPDATA); return 0; }],
    SHGetSpecialFolderPathA: ['ppii', (x, hwnd, buf, csidl) => { putA(x, buf, 260, APPDATA); return 1; }],
    SHGetFolderPathA: ['pipup', (x, hwnd, csidl, tok, flags, buf) => { putA(x, buf, 260, APPDATA); return 0; }],
    // SHGetKnownFolderPath(id, flags, token, &path): a path the caller frees with CoTaskMemFree.
    SHGetKnownFolderPath: ['pupp', (x, id, flags, tok, out) => { const b = wbytes(APPDATA), p = x.win.heapAlloc(b.length); x.write(p, b); x.w32(out, p); return 0; }],
    ExtractIconExW: ['pippu', () => 0], ExtractIconExA: ['pippu', () => 0],
    DragAcceptFiles: ['pi', () => 0], DragFinish: ['p', () => 0], DragQueryFileW: ['pupu', () => 0],
    ShellExecuteW: ['pppppi', () => 2], ShellExecuteA: ['pppppi', () => 2],                // SE_ERR_FNF: nothing opens
  };
  // imm32: no input method; a key types its character directly.
  const imm32 = {
    ImmGetContext: ['p', () => 0], ImmReleaseContext: ['pp', () => 1], ImmAssociateContext: ['pp', () => 0],
    ImmGetCompositionStringW: ['pupu', () => 0], ImmSetCompositionStringW: ['pupupu', () => 0], ImmGetCandidateListW: ['pupu', () => 0],
    ImmNotifyIME: ['puuu', () => 0], ImmSetCompositionWindow: ['pp', () => 0], ImmSetCandidateWindow: ['pp', () => 0], ImmGetIMEFileNameA: ['ppu', () => 0],
  };
  // setupapi: the devices a joystick library walks (SDL's HID): none.
  const setupapi = {
    SetupDiGetClassDevsA: ['ppp' + 'u', () => -1], SetupDiEnumDeviceInterfaces: ['pppup', () => 0], SetupDiEnumDeviceInfo: ['pup', () => 0],
    SetupDiGetDeviceInterfaceDetailA: ['ppupp' + 'p', () => 0], SetupDiGetDeviceRegistryPropertyA: ['ppupp' + 'up', () => 0],
    SetupDiDestroyDeviceInfoList: ['p', () => 1],
    CM_Get_Device_IDA: ['upuu', () => 0x25], CM_Get_Parent: ['puu', () => 0x25], CM_Locate_DevNodeA: ['ppu', () => 0x25],   // CR_NO_SUCH_DEVNODE
  };
  // ole32 and oleaut32 beyond classic.js's: memory, and PROPVARIANTs cleared.
  const ole32 = {
    CoTaskMemFree: ['p', (x, p) => { if (p) x.win.heapFree(p); return 0; }],
    CoTaskMemAlloc: ['u', (x, n) => x.win.heapAlloc(Math.max(1, n))],
    PropVariantClear: ['p', (x, p) => { x.write(p, new Uint8Array(16)); return 0; }],
    CLSIDFromString: ['pp', () => 0x800401f3],                      // CO_E_CLASSSTRING
  };
  const oleaut32 = { SysFreeString: ['p', () => 0, { ordinal: 6 }] };
  // ws2_32: Winsock 2 by the ordinals Winsock 1.1 gives the same functions (accept 1 ... WSAStartup 115)
  // -- wsock32's, a machine on a network with nobody else on it.
  /*
   * The Unicode twins Windows' own programs of NT and 2000 call (Minesweeper, Solitaire, FreeCell: their
   * strings, menus, dialogs and settings in UTF-16). A resource named by a string is its A twin's name;
   * one named by a number passes as it is.
   */
  const withAR = (x, p, fn) => (p < 0x10000 ? fn(p) : withA(x, p, fn));
  const intoW = (x, buf, n, fn) => {                       // an A function's string result, widened into buf
    if (!buf || n <= 0) return fn(0, 0);
    const t = x.win.heapAlloc(n + 1);
    try { const k = fn(t, n); putW(x, buf, n, x.str(t, Math.max(0, k))); return k; } finally { x.win.heapFree(t); }
  };
  Object.assign(k32, {
    // Files by their Unicode names and 64-bit sizes and positions (none reaches 4 GB here); devices,
    // overlapped I/O and other processes, none.
    CreateFileW: ['puupuup', (x, w, acc, share, sa, disp, flags, tpl) => withA(x, w, (a) => A(kernel32, 'CreateFileA')(x, a, acc, share, sa, disp, flags, tpl))],
    CreateDirectoryW: ['pp', (x, w, sa) => withA(x, w, (a) => A(kernel32, 'CreateDirectoryA')(x, a, sa))],
    GetFileSizeEx: ['pp', (x, h, p) => { const lo = A(kernel32, 'GetFileSize')(x, h, 0); if (lo === 0xffffffff) return 0; x.w32(p, lo); x.w32(p + 4, 0); return 1; }],
    SetFilePointerEx: ['piipu', (x, h, lo, hi, out, how) => { const r = A(kernel32, 'SetFilePointer')(x, h, lo, 0, how); if (r === -1) return 0; if (out) { x.w32(out, r); x.w32(out + 4, 0); } return 1; }],
    CancelIo: ['p', () => 1], GetOverlappedResult: ['pppi', () => 0], DeviceIoControl: ['pupupupp', () => 0],
    CreateToolhelp32Snapshot: ['uu', () => -1], Process32First: ['pp', () => 0], Process32Next: ['pp', () => 0],
    // A semaphore: an event, signalled while its count is above zero (WaitForSingleObject takes one).
    CreateSemaphoreW: ['piip', (x, sa, initial) => A(kernel32, 'CreateEventA')(x, 0, 0, initial > 0 ? 1 : 0, 0)],
    ReleaseSemaphore: ['pip', (x, h, n, prev) => { if (prev) x.w32(prev, 0); return A(kernel32, 'SetEvent')(x, h); }],
    GetCommandLineW: ['', (x) => (st.cmdW ||= (() => { const s = x.str(A(kernel32, 'GetCommandLineA')(x)), b = wbytes(s), p = x.win.heapAlloc(b.length); x.write(p, b); return p; })())],
    GetProfileIntW: ['ppi', (x, sec, key, def) => def],
    GetProfileStringW: ['ppppu', (x, sec, key, def, buf, n) => putW(x, buf, n, def ? wstr(x, def) : '')],
    WriteProfileStringW: ['ppp', () => 1],
    GetPrivateProfileIntW: ['ppip', (x, sec, key, def) => def],
    GetPrivateProfileStringW: ['ppppup', (x, sec, key, def, buf, n) => putW(x, buf, n, def ? wstr(x, def) : '')],
    WritePrivateProfileStringW: ['pppp', () => 1],
    FindResourceW: ['ppp', (x, mod, name, type) => withAR(x, name, (n) => withAR(x, type, (t) => A(kernel32, 'FindResourceA')(x, mod, n, t)))],
    lstrcpyW: ['pp', (x, d, s) => { x.write(d, wbytes(wstr(x, s))); return d; }],
    lstrcpynW: ['ppi', (x, d, s, n) => { putW(x, d, n, wstr(x, s)); return d; }],
    lstrcmpW: ['pp', (x, a, b) => { const s = wstr(x, a), t = wstr(x, b); return s < t ? -1 : s > t ? 1 : 0; }],
    lstrcmpiW: ['pp', (x, a, b) => { const s = wstr(x, a).toLowerCase(), t = wstr(x, b).toLowerCase(); return s < t ? -1 : s > t ? 1 : 0; }],
    lstrcatW: ['pp', (x, d, s) => { x.write(d, wbytes(wstr(x, d) + wstr(x, s))); return d; }],
  });
  Object.assign(u32, {
    RegisterWindowMessageW: ['p', (x, w) => withA(x, w, (a) => A(user32, 'RegisterWindowMessageA')(x, a))],
    LoadStringW: ['pupi', (x, inst, id, buf, n) => intoW(x, buf, n, (t, k) => A(user32, 'LoadStringA')(x, inst, id, t, k))],
    MessageBoxW: ['pppu', (x, hwnd, text, cap, type) => withA(x, text, (t) => withA(x, cap, (c) => A(user32, 'MessageBoxA')(x, hwnd, t, c, type)))],
    LoadImageW: ['ppuiiu', (x, inst, name, type, cx, cy, flags) => withAR(x, name, (n) => A(user32, 'LoadImageA')(x, inst, n, type, cx, cy, flags))],
    LoadBitmapW: ['pp', (x, inst, name) => withAR(x, name, (n) => A(user32, 'LoadBitmapA')(x, inst, n))],
    LoadMenuW: ['pp', (x, inst, name) => withAR(x, name, (n) => A(user32, 'LoadMenuA')(x, inst, n))],
    LoadAcceleratorsW: ['pp', (x, inst, name) => withAR(x, name, (n) => A(user32, 'LoadAcceleratorsA')(x, inst, n))],
    TranslateAcceleratorW: ['ppp', (x, hwnd, acc, msg) => A(user32, 'TranslateAcceleratorA')(x, hwnd, acc, msg)],
    DialogBoxParamW: ['ppppp', (x, inst, name, parent, proc, param) => withAR(x, name, (n) => A(user32, 'DialogBoxParamA')(x, inst, n, parent, proc, param))],
    SetDlgItemTextW: ['pip', (x, dlg, id, w) => withA(x, w, (a) => A(user32, 'SetDlgItemTextA')(x, dlg, id, a))],
    GetDlgItemTextW: ['pipi', (x, dlg, id, buf, n) => intoW(x, buf, n, (t, k) => A(user32, 'GetDlgItemTextA')(x, dlg, id, t, k))],
    WinHelpW: ['ppuu', () => 1],
    // wsprintfW(buf, fmt, ...) (cdecl): at most 1024 characters, as Windows.
    wsprintfW: ['pp', (x, buf, fmt) => { const out = cprintf(x, wstr(x, fmt), (x.cpu.reg[4] >>> 0) + 12, true).slice(0, 1023); x.write(buf, wbytes(out)); return out.length; }, { cdecl: true }],
  });
  Object.assign(g32, {
    TextOutW: ['piipi', (x, hdc, X, Y, w, n) => { const s = wstr(x, w, n), p = x.win.heapAlloc(n + 1); try { x.write(p, Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)); return A(gdi32, 'TextOutA')(x, hdc, X, Y, p, n); } finally { x.win.heapFree(p); } }],
    GetTextExtentPoint32W: ['ppip', (x, hdc, w, n, size) => { const s = wstr(x, w, n), p = x.win.heapAlloc(n + 1); try { x.write(p, Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)); return A(gdi32, 'GetTextExtentPoint32A')(x, hdc, p, n, size); } finally { x.win.heapFree(p); } }],
    CreateICW: ['pppp', (x, drv) => withA(x, drv, (a) => A(gdi32, 'CreateDCA')(x, a, 0, 0, 0))],
  });
  // The registry's Unicode calls on classic.js's registry in memory: names narrowed; a REG_SZ value's
  // data kept as the program wrote it (UTF-16), so read back by its W twin as it was.
  if (reg) Object.assign(advapi32, {
    RegCreateKeyExW: ['ppupuuppp', (x, hk, sub, r, cls, opt, sam, sa, out, disp) => withA(x, sub, (a) => reg.RegCreateKeyExA[1](x, hk, a, r, 0, opt, sam, sa, out, disp))],
    RegCreateKeyW: ['ppp', (x, hk, sub, out) => withA(x, sub, (a) => reg.RegCreateKeyA[1](x, hk, a, out))],
    RegOpenKeyExW: ['ppuup', (x, hk, sub, opt, sam, out) => withA(x, sub, (a) => reg.RegOpenKeyExA[1](x, hk, a, opt, sam, out))],
    RegOpenKeyW: ['ppp', (x, hk, sub, out) => withA(x, sub, (a) => reg.RegOpenKeyA[1](x, hk, a, out))],
    RegQueryValueExW: ['pppppp', (x, hk, name, r, type, data, cb) => withA(x, name, (a) => reg.RegQueryValueExA[1](x, hk, a, r, type, data, cb))],
    RegSetValueExW: ['ppuupu', (x, hk, name, r, type, data, cb) => withA(x, name, (a) => reg.RegSetValueExA[1](x, hk, a, r, type, data, cb))],
    RegDeleteValueW: ['pp', (x, hk, name) => withA(x, name, (a) => reg.RegDeleteValueA[1](x, hk, a))],
  });
  // ShellAbout: Windows' "About" box, not shown here (its caller's own About dialog is a dialog).
  Object.assign(shell32, { ShellAboutW: ['pppp', (x) => { x.win.say('ShellAboutW: the About box, not shown'); return 1; }], ShellAboutA: ['pppp', (x) => { x.win.say('ShellAboutA: the About box, not shown'); return 1; }] });
  /*
   * What a GameMaker Studio 2 runner (Deltarune, 2018) calls at start-up beyond the above: files found and
   * described by their Unicode names, the console it has none of, waitable timers, the interlocked lists,
   * Vista's locale names. A W function is its A twin's, as above.
   */
  // WIN32_FIND_DATAA (320 bytes: the name at 44, the short name at 304) widened into WIN32_FIND_DATAW
  // (592: the name at 44, 260 WCHARs, the short name at 564).
  const findW = (x, fd, fn) => {
    const t = x.win.heapAlloc(320);
    try {
      const r = fn(t);
      if (r !== -1 && r !== 0) { x.write(fd, x.bytes(t, 44)); x.write(fd + 44, new Uint8Array(548)); putW(x, fd + 44, 260, x.str(t + 44, 260)); putW(x, fd + 564, 14, x.str(t + 304, 14)); }
      return r;
    } finally { x.win.heapFree(t); }
  };
  // An SLIST_HEADER: Next, then Depth and Sequence (16 bits each).
  const slistPush = (x, head, e) => { const first = x.r32(head); x.w32(e, first); x.w32(head, e); x.w16(head + 4, x.r16(head + 4) + 1); x.w16(head + 6, x.r16(head + 6) + 1); return first; };
  // A waitable timer: an event whose signal is its due time passed (kernel32's WaitForSingleObject reads
  // `set`); an auto-reset one, once waited on, waits for its next period, or for ever.
  const timer = (x, manual) => {
    const t = { manual: !!manual, due: Infinity, period: 0, fired: false };
    Object.defineProperty(t, 'set', {
      get: () => t.fired || x.lx.mono() >= t.due,
      set: (v) => { if (v) { t.fired = true; return; } t.fired = false; if (x.lx.mono() >= t.due) t.due = t.period ? Math.max(t.due + t.period, x.lx.mono()) : Infinity; },
    });
    const h = 0x3000 + st.events.size; st.events.set(h, t); return h;
  };
  Object.assign(k32, {
    FindFirstFileW: ['pp', (x, pat, fd) => findW(x, fd, (t) => withA(x, pat, (a) => A(kernel32, 'FindFirstFileA')(x, a, t)))],
    FindNextFileW: ['pp', (x, h, fd) => findW(x, fd, (t) => A(kernel32, 'FindNextFileA')(x, h, t))],
    // FindFirstFileEx(name, FindExInfoStandard or Basic, data, search op, filter, flags): FindFirstFile's.
    FindFirstFileExW: ['pupupu', (x, pat, level, fd) => findW(x, fd, (t) => withA(x, pat, (a) => A(kernel32, 'FindFirstFileA')(x, a, t)))],
    FindFirstFileExA: ['pupupu', (x, pat, level, fd) => A(kernel32, 'FindFirstFileA')(x, pat, fd)],
    GetFileAttributesW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'GetFileAttributesA')(x, a))],
    SetFileAttributesW: ['pu', () => 1],
    // WIN32_FILE_ATTRIBUTE_DATA: the attributes, three FILETIMEs and the size, as WIN32_FIND_DATA begins.
    GetFileAttributesExW: ['pup', (x, w, level, out) => withA(x, w, (a) => {
      const attr = A(kernel32, 'GetFileAttributesA')(x, a);
      if (attr === 0xffffffff) return 0;
      x.write(out, new Uint8Array(36)); x.w32(out, attr);
      if (attr & 0x10) return 1;
      const t = x.win.heapAlloc(320);
      try { if (A(kernel32, 'FindFirstFileA')(x, a, t) !== -1) x.write(out + 4, x.bytes(t + 4, 32)); } finally { x.win.heapFree(t); }
      return 1;
    })],
    GetCurrentDirectoryW: ['up', (x, n, buf) => { const s = 'C:' + String.fromCharCode(92); if (n > s.length) putW(x, buf, n, s); return n > s.length ? s.length : s.length + 1; }],
    SetCurrentDirectoryW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'SetCurrentDirectoryA')(x, a))],
    GetFullPathNameW: ['pupp', (x, w, n, buf, part) => withA(x, w, (a) => {
      const t = x.win.heapAlloc(520);
      try {
        const k = A(kernel32, 'GetFullPathNameA')(x, a, 520, t, 0), s = x.str(t, k);
        if (n <= s.length) return s.length + 1;
        putW(x, buf, n, s); if (part) x.w32(part, buf + 2 * (s.lastIndexOf(String.fromCharCode(92)) + 1)); return s.length;
      } finally { x.win.heapFree(t); }
    })],
    DeleteFileW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'DeleteFileA')(x, a))],
    RemoveDirectoryW: ['p', (x, w) => withA(x, w, (a) => A(kernel32, 'RemoveDirectoryA')(x, a))],
    MoveFileExW: ['ppu', (x, a, b, flags) => withA(x, a, (pa) => withA(x, b, (pb) => A(kernel32, 'MoveFileExA')(x, pa, pb, flags)))],
    GetTempPathW: ['up', (x, n, buf) => { const s = 'C:' + String.fromCharCode(92); if (n > s.length) putW(x, buf, n, s); return n > s.length ? s.length : s.length + 1; }],
    GetDriveTypeW: ['p', () => 3],
    // OSVERSIONINFOW (276 bytes, 284 the Ex): Windows XP SP2, as GetVersionExA.
    GetVersionExW: ['p', (x, p) => {
      const n = x.r32(p); if (n < 276) return 0;
      x.write(p + 4, new Uint8Array(n - 4)); x.w32(p + 4, 5); x.w32(p + 8, 1); x.w32(p + 12, 2600); x.w32(p + 16, 2);
      putW(x, p + 20, 128, 'Service Pack 2'); if (n >= 284) x.w16(p + 276, 2);
      return 1;
    }],
    // %NAME% replaced by the environment's value (as GetEnvironmentVariable has it); the characters with the NUL.
    ExpandEnvironmentStringsW: ['ppu', (x, src, dst, n) => {
      const s = wstr(x, src).replace(/%([^%]+)%/g, (m, k) => { const K = k.toUpperCase(), v = K === 'PATH' ? 'C:\\WINDOWS\\system32' : st.env.get(K); return v === undefined ? m : v; });
      if (dst && n > s.length) putW(x, dst, n, s);
      return s.length + 1;
    }],
    GetTimeFormatW: ['uupppi', (x, lcid, flags, time, fmt, buf, n) => (n ? intoW(x, buf, n, (t, k) => A(kernel32, 'GetTimeFormatA')(x, lcid, flags, time, 0, t, k)) : A(kernel32, 'GetTimeFormatA')(x, lcid, flags, time, 0, 0, 0))],
    GetDateFormatW: ['uupppi', (x, lcid, flags, date, fmt, buf, n) => (n ? intoW(x, buf, n, (t, k) => A(kernel32, 'GetDateFormatA')(x, lcid, flags, date, 0, t, k)) : A(kernel32, 'GetDateFormatA')(x, lcid, flags, date, 0, 0, 0))],
    // The time zone is UTC here: the local time is the time given.
    SystemTimeToTzSpecificLocalTime: ['ppp', (x, tz, utc, local) => { x.write(local, x.bytes(utc, 16)); return 1; }],
    CreateProcessW: ['pppppiuppp', () => 0],
    CreateWaitableTimerW: ['pip', (x, sa, manual) => timer(x, manual)],
    CreateWaitableTimerExW: ['ppuu', (x, sa, name, flags) => timer(x, flags & 1)],
    // SetWaitableTimer(timer, &due, period ms, ...): a due time below zero is relative, in 100 ns; above,
    // a FILETIME, taken as now (no clock of the guest's reaches it).
    SetWaitableTimer: ['ppipp' + 'i', (x, h, due, period) => {
      const t = st.events.get(h); if (!t || !('due' in t)) return 0;
      const lo = x.r32(due), hi = x.r32(due + 4) | 0, v = hi * 4294967296 + lo;
      t.fired = false; t.period = period > 0 ? period / 1000 : 0; t.due = x.lx.mono() + (v < 0 ? -v / 1e7 : 0);
      return 1;
    }],
    CancelWaitableTimer: ['p', (x, h) => { const t = st.events.get(h); if (t && 'due' in t) { t.due = Infinity; t.fired = false; } return 1; }],
    // CreateEventExW(sa, name, flags, access): CREATE_EVENT_MANUAL_RESET 1, CREATE_EVENT_INITIAL_SET 2.
    CreateEventExW: ['ppuu', (x, sa, name, flags) => A(kernel32, 'CreateEventA')(x, sa, flags & 1, flags & 2 ? 1 : 0, 0)],
    // No console: none to read, to write or to show.
    GetConsoleMode: ['pp', () => 0], GetConsoleCP: ['', () => 437], GetConsoleWindow: ['', () => 0],
    ReadConsoleW: ['ppupp', (x, h, buf, n, read) => { if (read) x.w32(read, 0); return 0; }],
    WriteConsoleW: ['ppupp', (x, h, buf, n, written) => { if (written) x.w32(written, 0); return 0; }],
    PeekNamedPipe: ['pppppp', () => 0],
    HeapWalk: ['pp', () => 0], HeapValidate: ['pup', () => 1],
    InterlockedPushEntrySList: ['pp', (x, head, e) => slistPush(x, head, e)],
    InterlockedPopEntrySList: ['p', (x, head) => { const first = x.r32(head); if (first) { x.w32(head, x.r32(first)); x.w16(head + 4, x.r16(head + 4) - 1); } return first; }],
    InterlockedFlushSList: ['p', (x, head) => { const first = x.r32(head); x.w32(head, 0); x.w16(head + 4, 0); return first; }],
    QueryDepthSList: ['p', (x, head) => x.r16(head + 4)],
    RtlCaptureStackBackTrace: ['uupp', () => 0],
    // One locale, US English, by its Vista name and LCID.
    EnumSystemLocalesW: ['pu', () => 1],
    LocaleNameToLCID: ['pu', () => 0x409],
    LCMapStringEx: ['pupipippp', (x, name, flags, src, n, dst, max) => A(kernel32, 'LCMapStringW')(x, 0x409, flags, src, n, dst, max)],
  });
  Object.assign(u32, {
    keybd_event: ['uuuu', () => 0], SetProcessDPIAware: ['', () => 1],
    IsDialogMessageW: ['pp', (x, dlg, m) => A(user32, 'IsDialogMessageA')(x, dlg, m)],
    ChangeDisplaySettingsW: ['pu', (x, dm, flags) => u32.ChangeDisplaySettingsExW[1](x, 0, dm, 0, flags, 0)],
    CreateDialogParamW: ['ppppp', (x, inst, name, parent, proc, param) => withAR(x, name, (n) => A(user32, 'CreateDialogParamA')(x, inst, n, parent, proc, param))],
    // Dialog units to pixels: MS Sans Serif 8's base units, 6 by 13 (x/4, y/8 of them).
    MapDialogRect: ['pp', (x, dlg, r) => { for (let i = 0; i < 4; i++) { const v = x.r32(r + 4 * i) | 0; x.w32(r + 4 * i, i & 1 ? Math.trunc(v * 13 / 8) : Math.trunc(v * 6 / 4)); } return 1; }],
  });
  Object.assign(ole32, {
    // Not made: a caller marshalling between apartments does without (one apartment here).
    CoCreateFreeThreadedMarshaler: ['pp', (x, outer, pp) => { if (pp) x.w32(pp, 0); return 0x80004001; }],   // E_NOTIMPL
    // StringFromGUID2(guid, buf, n): "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}", its characters with the NUL.
    StringFromGUID2: ['ppi', (x, g, buf, n) => {
      const b = x.bytes(g, 16), h = (i, k) => [...b.slice(i, i + k)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      const r = (i, k) => h(i, k).match(/../g).reverse().join('');
      const s = `{${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}}`;
      if (n <= s.length) return 0; putW(x, buf, n, s); return s.length + 1;
    }],
  });
  Object.assign(shell32, { SHBrowseForFolderA: ['p', () => 0], SHBrowseForFolderW: ['p', () => 0] });
  const comdlg32 = { GetOpenFileNameW: ['p', () => 0], GetSaveFileNameW: ['p', () => 0] };
  const wmm = winmm ? { PlaySoundW: ['ppu', (x, name, mod, flags) => (flags & 4 ? A(winmm, 'PlaySoundA')(x, name, mod, flags) : withAR(x, name, (a) => A(winmm, 'PlaySoundA')(x, a, mod, flags)))] } : {};
  /*
   * The DLLs a GameMaker Studio 2 runner links beside its graphics: a machine with no network (wininet
   * opens a session and resolves no name: ERROR_INTERNET_NAME_NOT_RESOLVED; ws2_32's getaddrinfo:
   * WSAHOST_NOT_FOUND), no compositor (dwmapi, Windows XP's: composition off), GDI+ started and asked
   * nothing, no symbols and no crash dumps (dbghelp).
   */
  const NO_NAME = 12007;
  const net = (x, e) => { A(kernel32, 'SetLastError')(x, e); return 0; };
  const wininet = {
    InternetGetConnectedState: ['pu', (x, flags) => { if (flags) x.w32(flags, 0x20); return 0; }],   // INTERNET_CONNECTION_OFFLINE
    InternetOpenA: ['puppu', () => 0xcc01], InternetOpenW: ['puppu', () => 0xcc01],
    InternetConnectA: ['ppuppuuu', (x) => net(x, NO_NAME)], InternetConnectW: ['ppuppuuu', (x) => net(x, NO_NAME)],
    InternetOpenUrlA: ['pppuuu', (x) => net(x, NO_NAME)], InternetOpenUrlW: ['pppuuu', (x) => net(x, NO_NAME)],
    HttpOpenRequestA: ['ppppppuu', (x) => net(x, NO_NAME)], HttpSendRequestA: ['ppupu', (x) => net(x, NO_NAME)],
    HttpEndRequestW: ['ppuu', (x) => net(x, NO_NAME)], HttpQueryInfoA: ['puppp', (x) => net(x, NO_NAME)],
    InternetReadFile: ['ppup', (x, h, buf, n, read) => { if (read) x.w32(read, 0); return net(x, NO_NAME); }],
    InternetWriteFile: ['ppup', (x, h, buf, n, written) => { if (written) x.w32(written, 0); return net(x, NO_NAME); }],
    InternetCloseHandle: ['p', () => 1],
    InternetCrackUrlA: ['puup', (x) => net(x, 12006)],              // ERROR_INTERNET_UNRECOGNIZED_SCHEME
    InternetCanonicalizeUrlA: ['pppu', (x) => net(x, 12006)],
  };
  const ws2_32 = {
    getaddrinfo: ['pppp', (x, node, svc, hints, out) => { if (out) x.w32(out, 0); return 11001; }],   // WSAHOST_NOT_FOUND
    freeaddrinfo: ['p', () => 0], WSAAddressToStringA: ['puppp', () => -1],
  };
  const dwmapi = {
    DwmIsCompositionEnabled: ['p', (x, p) => { if (p) x.w32(p, 0); return 0; }],
    DwmGetCompositionTimingInfo: ['pp', () => 0x80263001],        // DWM_E_COMPOSITIONDISABLED
    DwmFlush: ['', () => 0x80263001], DwmEnableMMCSS: ['i', () => 0], DwmSetWindowAttribute: ['pupu', () => 0x80263001],
    DwmExtendFrameIntoClientArea: ['pp', () => 0x80263001], DwmEnableComposition: ['u', () => 0],
  };
  const gdiplus = {
    GdiplusStartup: ['ppp', (x, token, input, output) => { if (token) x.w32(token, 1); if (output) x.write(output, new Uint8Array(8)); return 0; }],   // Ok
    GdiplusShutdown: ['p', () => 0],
  };
  const dbghelp = {
    SymInitialize: ['ppi', () => 1], SymCleanup: ['p', () => 1], SymSetOptions: ['u', (x, o) => o], SymGetOptions: ['', () => 0],
    SymFromAddr: ['puupp', (x) => net(x, 487)],                     // ERROR_INVALID_ADDRESS: no symbols
    MiniDumpWriteDump: ['puppppp', (x) => net(x, 50)],              // ERROR_NOT_SUPPORTED
  };
  return { kernel32: k32, user32: u32, gdi32: g32, winmm: wmm, advapi32, shell32, imm32, setupapi, ole32, oleaut32,
    // Added to api.js's tables of those DLLs, under the names they do not answer.
    into: { 'comdlg32.dll': comdlg32, 'ws2_32.dll': ws2_32 },
    dlls: [{ dll: 'wininet.dll', fns: wininet }, { dll: 'dwmapi.dll', fns: dwmapi }, { dll: 'gdiplus.dll', fns: gdiplus }, { dll: 'dbghelp.dll', fns: dbghelp }] };
}


// Virtual keys and scancodes (set 1) for MapVirtualKey: MAPVK_VK_TO_VSC 0, VSC_TO_VK 1, VK_TO_CHAR 2, VSC_TO_VK_EX 3.
const VK_SC = { 0x08: 0x0e, 0x09: 0x0f, 0x0d: 0x1c, 0x10: 0x2a, 0x11: 0x1d, 0x12: 0x38, 0x13: 0x45, 0x14: 0x3a, 0x1b: 0x01, 0x20: 0x39,
  0x21: 0x49, 0x22: 0x51, 0x23: 0x4f, 0x24: 0x47, 0x25: 0x4b, 0x26: 0x48, 0x27: 0x4d, 0x28: 0x50, 0x2d: 0x52, 0x2e: 0x53,
  0x30: 0x0b, 0x31: 0x02, 0x32: 0x03, 0x33: 0x04, 0x34: 0x05, 0x35: 0x06, 0x36: 0x07, 0x37: 0x08, 0x38: 0x09, 0x39: 0x0a,
  0x41: 0x1e, 0x42: 0x30, 0x43: 0x2e, 0x44: 0x20, 0x45: 0x12, 0x46: 0x21, 0x47: 0x22, 0x48: 0x23, 0x49: 0x17, 0x4a: 0x24, 0x4b: 0x25,
  0x4c: 0x26, 0x4d: 0x32, 0x4e: 0x31, 0x4f: 0x18, 0x50: 0x19, 0x51: 0x10, 0x52: 0x13, 0x53: 0x1f, 0x54: 0x14, 0x55: 0x16, 0x56: 0x2f,
  0x57: 0x11, 0x58: 0x2d, 0x59: 0x15, 0x5a: 0x2c, 0x70: 0x3b, 0x71: 0x3c, 0x72: 0x3d, 0x73: 0x3e, 0x74: 0x3f, 0x75: 0x40, 0x76: 0x41,
  0x77: 0x42, 0x78: 0x43, 0x79: 0x44, 0x7a: 0x57, 0x7b: 0x58, 0xa0: 0x2a, 0xa1: 0x36, 0xa2: 0x1d, 0xa3: 0x1d, 0xa4: 0x38, 0xa5: 0x38,
  0xba: 0x27, 0xbb: 0x0d, 0xbc: 0x33, 0xbd: 0x0c, 0xbe: 0x34, 0xbf: 0x35, 0xc0: 0x29, 0xdb: 0x1a, 0xdc: 0x2b, 0xdd: 0x1b, 0xde: 0x28 };
const SC_VK = Object.fromEntries(Object.entries(VK_SC).filter(([v]) => !(+v >= 0xa0 && +v <= 0xa5)).map(([v, s]) => [s, +v]));
SC_VK[0x36] = 0xa1;
const vkChar = (vk, shift) => {
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(shift ? vk : vk + 32);
  if (vk >= 0x30 && vk <= 0x39) return shift ? ')!@#$%^&*('[vk - 0x30] : String.fromCharCode(vk);
  const t = { 0x20: ' ', 0x0d: '\r', 0x08: '\b', 0x09: '\t', 0x1b: '\x1b', 0xba: ';:', 0xbb: '=+', 0xbc: ',<', 0xbd: '-_', 0xbe: '.>', 0xbf: '/?', 0xc0: '`~', 0xdb: '[{', 0xdc: '\\|', 0xdd: ']}', 0xde: '\'"' }[vk];
  return !t ? '' : t.length === 2 ? t[shift ? 1 : 0] : t;
};
const mapVk = (code, type) => (type === 0 ? VK_SC[code] || 0 : type === 1 || type === 3 ? SC_VK[code & 0xff] || 0 : type === 2 ? (vkChar(code, false).toUpperCase().charCodeAt(0) || 0) : 0);

