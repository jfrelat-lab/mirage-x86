// run.mjs — a Win32 .exe on MIRAGE-WIN32, headless (src/win32): its DLLs made in JavaScript, its window
// and OpenGL recorded by src/hle/trace.js; what it called is printed at the end, and how it ended.
//
//   node tools/win32/run.mjs <program.exe> [arguments...]
//   MIRAGE_W32STUBS=1               an import MIRAGE-WIN32 does not make yet stops the run, named, when called
//                                   (=list: each such import also named at the start)
//                                   (the loader itself refuses it): what a program calls, in its order
//   MIRAGE_W32SHOTS=5,10 MIRAGE_W32SHOTPREFIX=/tmp/w   the screen (a GDI window's, on the card's framebuffer)
//                                   at those guest seconds: <prefix>-<s>s.png
//   MIRAGE_W32KEYS=12:01,14:1c       keys pressed at those guest seconds, by PC scancode (hex; e0xx for an
//                                   extended key), held a tenth of a second: WM_KEYDOWN, WM_KEYUP; 2a+ and
//                                   2a- press and release (Shift held over the keys between)
//   MIRAGE_W32MOUSE=10:98,10,down|10.2:398,210|10.4:up   the mouse on the screen at those guest seconds:
//                                   a point (mouseAt), the left button down or up there
//                                   (rdown, rup: the right button)
//   MIRAGE_W32ENV=NAME=value,...    the program's environment (GetEnvironmentVariable)
//   MIRAGE_W32DIR=<dir>             the files beside it and below, by their path there, on the program's own disk (src/win32/api.js)
//   MIRAGE_W32SECS=<guest seconds>  stop after that long (default: until it ends, or 2e10 instructions)
//   MIRAGE_W32IPS=<n>               instructions per guest second (default 1e8)
//   MIRAGE_W32TRACE=1|<file>        every API call as it is made (to stderr, or that file)
//   MIRAGE_W32TRACEFROM=<seconds>   ... from that guest second on
//   MIRAGE_W32FONTS=arial=<ttf>,arial:bold=<ttf>  TrueType fonts the program selects, as the page's machine.fonts
//   MIRAGE_W32CODEPAGE=932          the system's code page (machine.codepage): Shift-JIS, a Japanese Windows'
//   MIRAGE_W32DUMP=<name>,...       those files of the program's disk at the end (what it wrote)
//   MIRAGE_W32DUMPDIR=<dir>         ... written into that directory, as bytes, instead
//   MIRAGE_W32MEMDUMP=<mod>:<rva>:<size>@<s>,<s>:<prefix>  a module's bytes at those guest seconds; <mod> "abs": an address
//   MIRAGE_W32WINS=1                the windows at the end: handle, class, parent, id, place, style, title
//   MIRAGE_W32TEX=<dir>             every texture level as the program unlocks it: <dir>/NNNN.bin and index.json
//   MIRAGE_W32WAV=<file.wav>        what waveOut played (and <file>.midi.wav what MIDI played: midiOut, MCI)
import { readFileSync, readdirSync, statSync, writeSync, openSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { Machine } from '../../src/machine.js';
import { installLinux } from '../../src/linux.js';
import { installBIOS } from '../../src/bios.js';
import { loadPE, win32Memory } from '../../src/win32/index.js';
import { win32Apis } from '../../src/win32/api.js';
import { traceBackend } from '../../src/hle/trace.js';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/win32/run.mjs <program.exe>'); process.exit(2); }
const exe = new Uint8Array(readFileSync(prog));
const mc = new Machine({ memSize: win32Memory(exe), cpu: process.env.MIRAGE_CPU || '686' });
// MIRAGE_W32IPS=<instructions per guest second>: the CPU's pace (default 1e8, the page measures its own).
if (process.env.MIRAGE_W32IPS) mc.cyclesPerSecond = Number(process.env.MIRAGE_W32IPS);
installBIOS(mc);
try { mc.font = new Uint8Array(readFileSync(new URL('../../assets/vga-rom-8x16.bin', import.meta.url))); } catch { /* captions without letters */ }   // as the page loads it
const lx = installLinux(mc, { onOutput: (fd, b) => (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(b)) });
lx.epoch = Math.floor(Date.now() / 1000);
const backend = traceBackend();
// MIRAGE_W32TEX=<dir>: what the program writes into its textures, level by level, as it unlocks them.
const TEX = process.env.MIRAGE_W32TEX, texIndex = [];
if (TEX) {
  const { mkdirSync } = await import('fs'), { createHash } = await import('crypto');
  mkdirSync(TEX, { recursive: true });
  backend.textureCapture = (info, bytes) => {
    const file = String(info.seq).padStart(4, '0') + '.bin';
    writeFileSync(`${TEX}/${file}`, bytes);
    texIndex.push({ ...info, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), file, cycles: mc.cpu.cycles });
    writeFileSync(`${TEX}/index.json`, JSON.stringify(texIndex, null, 1) + '\n');
  };
}
// The trace written as it is made (writeSync): to a pipe, console.error queues in memory, and a launcher's
// idle loop of millions of calls ran Node out of heap.
// MIRAGE_W32TRACE=<file>: into that file instead of stderr.
const traceFd = process.env.MIRAGE_W32TRACE && process.env.MIRAGE_W32TRACE !== '1' ? openSync(process.env.MIRAGE_W32TRACE, 'w') : 2;
const traceOut = (t) => { const b = Buffer.from(t); for (let o = 0; o < b.length;) { try { o += writeSync(traceFd, b, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
// MIRAGE_W32TRACEFROM=<guest seconds>: only from then on (a launcher's first minute is millions of calls).
const traceFrom = Number(process.env.MIRAGE_W32TRACEFROM) || 0;
if (process.env.MIRAGE_W32TRACE) { const t0 = backend.trace; backend.trace = (name, args) => { if (traceFrom && lx.mono() < traceFrom) { if (t0) t0(name, args); return; } traceOut('w32 ' + lx.mono().toFixed(3) + ': ' + name + ' ' + args.map((a) => (typeof a === 'number' && Number.isInteger(a) && a > 9 ? '0x' + (a >>> 0).toString(16) : a)).join(' ') + '\n'); if (t0) t0(name, args); }; }
const files = {};
if (process.env.MIRAGE_W32DIR) (function walk(d, rel) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, rel + n + '/'); else files[rel + n] = new Uint8Array(readFileSync(p)); } })(process.env.MIRAGE_W32DIR, '');
// MIRAGE_W32FONTS=arial=/path/Arial.ttf,arial:bold=/path/Arial Bold.ttf: TrueType fonts, as the page's machine.fonts.
const fonts = process.env.MIRAGE_W32FONTS ? Object.fromEntries(process.env.MIRAGE_W32FONTS.split(',').map((e) => { const [k, f] = e.split('='); return [k.toLowerCase(), new Uint8Array(readFileSync(f))]; })) : undefined;
// MIRAGE_W32ENV=NAME=value,...: the program's environment (SDL's hints: SDL_RENDER_DRIVER=software).
const env = Object.fromEntries((process.env.MIRAGE_W32ENV || '').split(',').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
// MIRAGE_W32CODEPAGE=932: a Japanese Windows' code page (an image's machine.codepage).
// MIRAGE_W32DESK=800x600: the desktop's size (an image's machine.desktop), 1024x768 otherwise.
const apis = win32Apis({ files, fonts, env, codepage: Number(process.env.MIRAGE_W32CODEPAGE) || undefined, desk: process.env.MIRAGE_W32DESK });
/*
 * MIRAGE_W32PROBE=goldsrc: what Half-Life's engine (sw.dll) and its game (hl.dll) say to each other through
 * their tables of function pointers, which no import trace sees. The engine's table, handed over by
 * GiveFnptrsToDll, has SetOrigin (28) and FindEntityByString (14) replaced before the game copies it; the
 * game's (GetEntityAPI's) has KeyValue (6) replaced once it is filled. Each replacement is a stub of
 * mirageprobe.dll whose JavaScript writes the call down and goes on into the real function, the caller's
 * stack as it was. To stderr, prefixed "probe".
 */
const PROBE = process.env.MIRAGE_W32PROBE === 'goldsrc';
const probes = [];                                       // { name, orig, log(x, sp) }
if (PROBE) {
  const fns = {};
  // p63: where a probe that wants the result sends its function's return -- EAX written down, then back to
  // the caller's own return address (the stack as a plain return leaves it).
  const returns = [];
  // The stub's own `mov eax, id` would lose the result: the return goes first to a few bytes of the guest's
  // own, `mov [slot], eax; push p63; ret`.
  let tramp = null;
  const retTramp = (x) => {
    if (tramp) return tramp;
    const code = x.win.heapAlloc(32), slot = code + 16, to = stub(x, 63);
    x.write(code, Uint8Array.of(0xa3, slot & 255, (slot >> 8) & 255, (slot >> 16) & 255, slot >>> 24, 0x68, to & 255, (to >> 8) & 255, (to >> 16) & 255, to >>> 24, 0xc3));
    return (tramp = { code, slot });
  };
  for (let i = 0; i < 64; i++) fns[`p${i}`] = ['', (x) => {
    if (i === 63) { const r = returns.pop(), eax = x.r32(retTramp(x).slot); if (r) { r.done(x, eax); x.cpu.eip = r.ret; } return eax; }
    const p = probes[i], sp = x.cpu.reg[4] >>> 0;
    if (p) {
      const keep = p.log(x, sp);
      if (typeof keep === 'function') { returns.push({ ret: x.r32(sp), done: keep }); x.w32(sp, retTramp(x).code); }
      x.cpu.eip = p.orig;
    }
    return x.cpu.reg[0] >>> 0;
  }];
  apis.push({ dll: 'mirageprobe.dll', fns });
  const k32 = apis.find((d) => d.dll === 'kernel32.dll').fns, gpa = k32.GetProcAddress[1];
  // The registry as the launcher and the engine use it: each value set, and each one asked for with what it got.
  const adv = apis.find((d) => d.dll === 'advapi32.dll').fns, regSeen = new Set();
  const show = (x, type, p, n) => (type === 1 ? JSON.stringify(x.str(p, 64)) : n === 4 ? String(x.r32(p) | 0) : `[${n} bytes]`);
  const setV = adv.RegSetValueExA[1]; adv.RegSetValueExA[1] = (x, hk, name, r, type, data, cb) => {
    const k = 'set ' + x.str(name, 64) + '=' + show(x, type, data, cb); if (!regSeen.has(k)) { regSeen.add(k); say(`RegSetValueExA ${k}`); } return setV(x, hk, name, r, type, data, cb); };
  const qV = adv.RegQueryValueExA[1]; adv.RegQueryValueExA[1] = (x, hk, name, r, type, data, cb) => {
    const ret = qV(x, hk, name, r, type, data, cb), k = 'get ' + (name ? x.str(name, 64) : '') + ' -> ' + ret + (ret === 0 && data ? ' ' + show(x, type ? x.r32(type) : 1, data, cb ? x.r32(cb) : 0) : '');
    if (!regSeen.has(k)) { regSeen.add(k); say(`RegQueryValueExA ${k}`); } return ret; };
  // The surface the engine draws into: the last Lock's DDSURFACEDESC (pitch at 16, lpSurface at 36).
  const dd = apis.find((d) => d.dll === 'ddraw.dll').fns, lock = dd['IDirectDrawSurface::Lock'];
  if (lock) { const f0 = lock[1]; lock[1] = (x, self, r, desc, ...rest) => { const ret = f0(x, self, r, desc, ...rest); probes.surf = { at: x.r32(desc + 36), pitch: x.r32(desc + 16) }; return ret; }; }
  const f32 = (x, p) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, x.r32(p), true); return +b.getFloat32(0, true).toFixed(2); };
  const stub = (x, i) => x.win.proc(x.win.load('mirageprobe.dll'), `p${i}`);
  const say = (t) => process.stderr.write(`probe ${lx.mono().toFixed(2)}: ${t}\n`);
  let gameTable = 0, gamePatched = false;
  k32.GetProcAddress[1] = (x, h, name) => {
    const r = gpa(x, h, name), m = x.win.moduleAt(h), what = name < 0x10000 ? name : x.str(name);
    // client.dll: HUD_UpdateClientData(client_data_t *, float time) -- the player's origin as the client
    // has it, at the struct's start; HUD_Redraw(float time, int intermission) counted.
    // client.dll's Initialize(cl_enginefunc_t *, version): the engine's drawing for the HUD -- 4 SPR_Set,
    // 5 SPR_Draw, 6 SPR_DrawHoles, 7 SPR_DrawAdditive, 11 FillRGBA -- hooked in the table it is given.
    if (r && m && m.name === 'client.dll' && what === 'Initialize') {
      probes[52] = { name: what, orig: r, log: (x2, sp) => {
        const t = x2.r32(sp + 4); say(`client Initialize(${t.toString(16)}, ${x2.r32(sp + 8)})`);
        const counts = probes.sprCounts = {};
        [[4, 'SPR_Set'], [5, 'SPR_Draw'], [6, 'SPR_DrawHoles'], [7, 'SPR_DrawAdditive'], [11, 'FillRGBA']].forEach(([idx, nm], k) => {
          probes[53 + k] = { name: nm, orig: x2.r32(t + 4 * idx), log: (x3, s3) => {
            counts[nm] = (counts[nm] || 0) + 1;
            if (counts[nm] <= 4 || counts[nm] % 500 === 0) say(`${nm}#${counts[nm]}(${[1, 2, 3, 4, 5, 6, 7, 8].map((j) => x3.r32(s3 + 4 * j) | 0).join(', ')}) at ${x3.r32(s3).toString(16)} -> ${probes[53 + k].orig.toString(16)}`);
            // FillRGBA's column of pixels before and after, in the surface last locked (16 bits a pixel).
            if (nm === 'FillRGBA' && counts[nm] <= 3) {
              // In the engine's own buffer: vid.buffer and vid.rowbytes (sw.dll's 10390B10h and 10390B28h,
              // relocated with the DLL), its 15/16-bit flag at 100BC4F8h.
              const rel = x3.win.modules.get('sw.dll').base - 0x10000000, buf = x3.r32(0x10390b10 + rel), rb = x3.r32(0x10390b28 + rel);
              say(`  vid.buffer ${buf.toString(16)} rowbytes ${rb} flag ${x3.r32(0x100bc4f8 + rel)}`);
              // FillRGBA's colour tables (sw.dll .data): words at colour + alpha's row, (a*3*64) & FF00.
              const row = ((x3.r32(s3 + 32) * 3) << 6) & 0xff00, nz = (base) => { let n = 0; for (let j = 0; j < 0x10000; j += 2) if (x3.r16(base + rel + j)) n++; return n; };
              say(`  tables: ${[[0x1019c830, x3.r32(s3 + 28)], [0x1017c820, x3.r32(s3 + 24)], [0x1015c780, x3.r32(s3 + 20)]].map(([t, c]) => `${t.toString(16)}[${c}+${row}]=${x3.r16(t + rel + 2 * (c + row)).toString(16)} nonzero ${nz(t)}`).join(', ')}`);
              { let n = 0; for (let j = 0; j < 0x10000; j++) if (x3.r8(0x101bc840 + rel + j)) n++; say(`  table 101bc840 nonzero ${n}, built flag 101cc83f = ${x3.r8(0x101cc83f + rel)}, first bytes ${Array.from({ length: 8 }, (_, j) => x3.r8(0x101bc840 + rel + j)).join(',')}`); }
              say(`  vid: ${Array.from({ length: 24 }, (_, j) => `${(0x10390b00 + 4 * j).toString(16)}=${x3.r32(0x10390b00 + 4 * j + rel) | 0}`).join(' ')}`);
              const X = x3.r32(s3 + 4), Y = x3.r32(s3 + 8), sf = { at: buf, pitch: rb & ~1 }, px = () => [0, 4, 8].map((dy) => x3.r16(sf.at + (Y + dy) * sf.pitch + 2 * X).toString(16)).join('/');
              const before = px();
              return () => say(`  FillRGBA pixels at (${X}, ${Y}) in ${sf.at.toString(16)} pitch ${sf.pitch}: ${before} -> ${px()}`);
            }
          } };
          x2.w32(t + 4 * idx, stub(x2, 53 + k));
        });
      } };
      return stub(x, 52);
    }
    if (r && m && m.name === 'client.dll' && (what === 'HUD_UpdateClientData' || what === 'HUD_Redraw')) {
      const slot = what === 'HUD_Redraw' ? 50 : 51;
      probes[slot] = { name: what, orig: r, n: 0, log: (x2, sp) => {
        const p2 = probes[slot]; p2.n++;
        if (p2.n <= 3 || p2.n % 200 === 0) {
          if (slot === 51) { const c = x2.r32(sp + 4); say(`HUD_UpdateClientData#${p2.n} origin ${f32(x2, c)} ${f32(x2, c + 4)} ${f32(x2, c + 8)} time ${f32(x2, sp + 8)}`);
            // Where the engine keeps the player's place: sw.dll's data, every float pair (x, y) of the client's.
            if (p2.n === 600) {
              const sw = x2.win.modules.get('sw.dll'), X = x2.r32(c), Y = x2.r32(c + 4), hits = [];
              for (let a2 = sw.base; a2 < sw.base + sw.size - 12; a2 += 4) if (x2.r32(a2) === X && x2.r32(a2 + 4) === Y) hits.push(`${(a2 - sw.base).toString(16)}:${f32(x2, a2 + 8)}`);
              say(`  sw.dll holds (${f32(x2, c)}, ${f32(x2, c + 4)}) at ${hits.join(' ')}`);
              if (probes.swCode) {
                const now = x2.bytes(probes.swCode.base, 0xa0000), runs = [];
                for (let i = 0; i < now.length; i++) if (now[i] !== probes.swCode.bytes[i]) { const st0 = i; while (i < now.length && now[i] !== probes.swCode.bytes[i]) i++; runs.push(`${(st0).toString(16)}+${i - st0}`); }
                say(`  sw.dll code patched since the game loaded: ${runs.length} runs ${runs.slice(0, 40).join(' ')}`);
              }
              // Entities placed by the server: each copy of their (x, y) in the heap and VirtualAlloc's regions.
              const fb = (v) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); };
              for (const [ex, ey] of [[-2128, 435], [-1984, 2240], [228, -198], [-736, -248]]) {
                const at = [];
                // Committed pages only (a lookup through phys would commit the reserved ones).
                for (const vpn of x2.lx.pages.keys()) {
                  const lo = vpn * 4096; if (lo < 0x10000000) continue;
                  for (let a3 = lo; a3 < lo + 4092; a3 += 4) if (x2.r32(a3) === fb(ex) && x2.r32(a3 + 4) === fb(ey)) at.push(`${a3.toString(16)}:${f32(x2, a3 + 8)}`);
                }
                say(`  (${ex}, ${ey}) at ${at.join(' ')}`);
              }
            }
          }
          else say(`HUD_Redraw#${p2.n} time ${f32(x2, sp + 4)} intermission ${x2.r32(sp + 8)}`);
        }
      } };
      return stub(x, slot);
    }
    if (!r || !m || m.name !== 'hl.dll') return r;
    if (what === 'GiveFnptrsToDll') {
      probes[0] = { name: what, orig: r, log: (x2, sp) => {
        const t = x2.r32(sp + 4);
        say(`GiveFnptrsToDll(${t.toString(16)})`);
        const sw = x2.win.modules.get('sw.dll'); probes.swCode = { base: sw.base, bytes: x2.bytes(sw.base, 0xa0000) };   // its code, to see what it patches
        const hook = (slot, idx, name2, log) => { probes[slot] = { name: name2, orig: x2.r32(t + 4 * idx), log }; x2.w32(t + 4 * idx, stub(x2, slot)); };
        hook(1, 28, 'SetOrigin', (x3, s3) => { const o = x3.r32(s3 + 8); say(`SetOrigin(${x3.r32(s3 + 4).toString(16)}, ${f32(x3, o)} ${f32(x3, o + 4)} ${f32(x3, o + 8)})`); });
        hook(2, 14, 'FindEntityByString', (x3, s3) => {
          const what = `FindEntityByString(${x3.r32(s3 + 4).toString(16)}, ${x3.str(x3.r32(s3 + 8), 40)}, ${x3.str(x3.r32(s3 + 12), 40)})`;
          return (x4, eax) => {
            say(`${what} -> ${eax.toString(16)}`);
            // The spawn point found: its fields as floats where they look like coordinates (offset: value).
            if (/info_player_start|, player\)/.test(what)) {
              const out = [];
              for (let o = 0; o < 0x2c8; o += 4) { const v = f32(x4, eax + o); if (Math.abs(v) >= 1 && Math.abs(v) < 8192 && Number.isFinite(v)) out.push(`${o.toString(16)}:${v}`); }
              say(`  edict ${eax.toString(16)} floats ${out.join(' ')}`);
            }
          };
        });
      } };
      return stub(x, 0);
    }
    if (what === 'GetEntityAPI') { probes[3] = { name: what, orig: r, log: (x2, sp) => { gameTable = x2.r32(sp + 4); say(`GetEntityAPI(${gameTable.toString(16)})`); } }; return stub(x, 3); }
    return r;
  };
  // The game's table, filled by GetEntityAPI into a buffer the engine then copies: every copy of it in
  // sw.dll's image found (the same first 16 entries) and its entries hooked there, between two slices.
  // DLL_FUNCTIONS: 6 KeyValue, 15 ClientConnect, 18 ClientPutInServer, 19 ClientCommand, 21 ServerActivate.
  // Its layout is the 1999 SDK's, not today's: every entry up to 40 hooked, each call counted and the first
  // few written down with their first argument (an edict, a string).
  const GAME = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [i, `game[${i}]`]));
  const seen = new Map();
  probes.poll = (x) => {
    if (!gameTable || gamePatched || !x.r32(gameTable + 24)) return;
    gamePatched = true;
    const want = Array.from({ length: 16 }, (_, i) => x.r32(gameTable + 4 * i)), sw = x.win.modules.get('sw.dll');
    const copies = [gameTable];
    for (let a = sw.base; a < sw.base + sw.size - 64; a += 4) if (a !== gameTable && x.r32(a) === want[0] && want.every((v, i) => x.r32(a + 4 * i) === v)) copies.push(a);
    let slot = 5;
    probes.counts = seen;
    for (const [idx, name2] of Object.entries(GAME)) {
      const orig = x.r32(gameTable + 4 * idx), s0 = slot++;
      probes[s0] = { name: name2, orig, log: (x3, s3) => {
        const a1 = x3.r32(s3 + 4), a2 = x3.r32(s3 + 8);
        const n = (seen.get(name2) || 0) + 1; seen.set(name2, n);
        if (n <= 3) say(`${name2}#${n}(${a1.toString(16)}, ${a2.toString(16)} "${a2 > 0x10000 ? x3.str(a2, 24).replace(/[^ -~]/g, '.') : ''}")`);
      } };
      for (const c of copies) x.w32(c + 4 * idx, stub(x, s0));
    }
    say(`game table hooked in ${copies.map((c) => c.toString(16)).join(', ')}`);
  };
}
if (process.env.MIRAGE_W32STUBS) {
  // The import directory read here, as the loader reads it, and every name no table makes added as a
  // function that throws: the run then stops at the first one called, and says which. The program's and
  // those of its own DLLs (on its disk: Abuse's SDL2.dll), which are themselves loaded, not stubbed.
  const own = new Map(Object.entries(files).filter(([n]) => /\.dll$/i.test(n)).map(([n, v]) => [basename(n).toLowerCase(), v]));
  const byDll = new Map(apis.map((a) => [a.dll.toLowerCase(), a]));
  for (const b of [exe, ...own.values()]) {
    const u32 = (o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0, u16 = (o) => b[o] | b[o + 1] << 8;
    const pe = u32(0x3c), nsec = u16(pe + 6), opt = pe + 24, secs = opt + u16(pe + 20);
    const off = (r) => { for (let i = 0; i < nsec; i++) { const sct = secs + i * 40, va = u32(sct + 12), raw = u32(sct + 20); if (r >= va && r < va + Math.max(u32(sct + 8), u32(sct + 16))) return r - va + raw; } return r; };
    const str = (o) => { let e = o; while (b[e]) e++; return new TextDecoder('latin1').decode(b.subarray(o, e)); };
    if (!u32(opt + 104)) continue;
    for (let d = off(u32(opt + 104)); u32(d + 12); d += 20) {
      const dll = str(off(u32(d + 12)));
      if (own.has(dll.toLowerCase())) continue;
      let mod = byDll.get(dll.toLowerCase());
      if (!mod) { mod = { dll, fns: {} }; apis.push(mod); byDll.set(dll.toLowerCase(), mod); }
      for (let t = off(u32(d) || u32(d + 16)); u32(t); t += 4) {
        const v = u32(t), ord = v & 0x80000000 ? v & 0xffff : 0, name = ord ? `#${ord}` : str(off(v) + 2);
        if (ord ? Object.values(mod.fns).some((f) => f[2] && f[2].ordinal === ord) : name in mod.fns) continue;
        mod.fns[name] = ['', () => { throw new Error(`mirage-win32: ${dll}!${name} is called and not made yet`); }, ord ? { ordinal: ord, noName: true } : {}];
        if (process.env.MIRAGE_W32STUBS === 'list') process.stderr.write(`mirage-win32: not made yet: ${dll}!${name}\n`);
      }
    }
  }
}
const loaded = loadPE(lx, mc.mem, mc.cpu, exe, { path: `C:\\${basename(prog)}`, args: args.join(' '), apis, backend });
const SEC = mc.cyclesPerSecond || 1e8, SECS = Number(process.env.MIRAGE_W32SECS) || 0;
const LIMIT = SECS ? SECS * SEC : 2e10;
// MIRAGE_W32WAV=<file.wav>: what waveOut played, recorded.
const WAV = process.env.MIRAGE_W32WAV, heard = [];
let wavRate = 44100;
const midiHeard = [];
let midiRate = 32000;
const record = () => {
  if (!WAV) return;
  if (mc.midi) { mc.midi.capture = true; mc.midi.render(); const m = mc.midi.drain(); midiRate = m.rate; for (const v of m.samples) midiHeard.push(v); }
  if (!mc.dsp) return;
  const { rate, samples } = mc.dsp.drain(); if (samples.length) { wavRate = rate; for (const v of samples) heard.push(v); }
};
const writeWav = (_, pcm, rate) => {
  const n = pcm.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, pcm[i])), 44 + i * 2);
  return b;
};
const SHOTS = (process.env.MIRAGE_W32SHOTS || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const shot = async (t) => {
  const v = mc.vbe; if (!v || v.bpp !== 32) { console.error(`mirage-win32: no picture at ${t} s`); return; }
  const { writePNG } = await import('../frame.mjs'), px = new Uint32Array(mc.mem.u8.buffer, mc.mem.u8.byteOffset + v.base, v.width * v.height), rgb = new Uint8Array(px.length * 3);
  for (let i = 0; i < px.length; i++) { rgb[3 * i] = px[i] >> 16; rgb[3 * i + 1] = px[i] >> 8; rgb[3 * i + 2] = px[i]; }
  const f = `${process.env.MIRAGE_W32SHOTPREFIX || '/tmp/w32'}-${t}s.png`; writePNG(f, rgb, v.width, v.height, 1); console.error(`mirage-win32: ${v.width}x${v.height} at ${t} s -> ${f}`);
};
const KEYS = (process.env.MIRAGE_W32KEYS || '').split(',').filter(Boolean).flatMap((k) => {
  const [t, c] = k.split(':'), v = parseInt(c, 16), ext = v > 0xff, scan = v & 0xff, hold = c.slice(-1);
  if (hold === '+' || hold === '-') return [{ at: Number(t), down: hold === '+', scan, ext }];   // held down, let go
  return [{ at: Number(t), down: true, scan, ext }, { at: Number(t) + 0.1, down: false, scan, ext }];
}).sort((a, b) => a.at - b.at);
const MOUSE = (process.env.MIRAGE_W32MOUSE || '').split('|').filter(Boolean).map((m) => { const [t, a] = m.split(':'); return { at: Number(t), a: a.split(',') }; });
// MIRAGE_W32MEMDUMP=<module>:<rva hex>:<size hex>@<s>,<s>:<file prefix>: the module's bytes at those guest
// seconds, each file its base (4 bytes) then the bytes -- to compare with the same dump from Wine.
const MEMDUMP = (() => { const v = process.env.MIRAGE_W32MEMDUMP; if (!v) return null; const [what, rest] = v.split('@'), [mod, rva, size] = what.split(':'), [times, prefix] = rest.split(':');
  return { mod, rva: parseInt(rva, 16), size: parseInt(size, 16), times: times.split(',').map(Number), prefix, n: 0 }; })();
while (!lx.done && mc.cpu.cycles < LIMIT) {
  if (MEMDUMP && MEMDUMP.times.length && lx.mono() >= MEMDUMP.times[0]) {
    MEMDUMP.times.shift(); const m = MEMDUMP.mod === "abs" ? { base: 0 } : loaded.x.win.modules.get(MEMDUMP.mod), out = Buffer.alloc(4 + MEMDUMP.size);
    if (m) { out.writeUInt32LE(m.base, 0); Buffer.from(loaded.x.bytes(m.base + MEMDUMP.rva, MEMDUMP.size)).copy(out, 4); }
    const file = `${MEMDUMP.prefix}${++MEMDUMP.n}.bin`; writeFileSync(file, out); console.error(`mirage-win32: ${MEMDUMP.mod} at ${lx.mono().toFixed(1)} s -> ${file}`);
  }
  if (PROBE && probes.poll) probes.poll(loaded.x);
  while (KEYS.length && mc.cpu.cycles >= KEYS[0].at * SEC) { const k = KEYS.shift(); apis.input.key(k.down, k.scan, k.ext); }
  while (MOUSE.length && mc.cpu.cycles >= MOUSE[0].at * SEC) {
    const { a } = MOUSE.shift();
    const press = (w) => apis.input.mouseButton(w[0] === 'r' ? 1 : 0, w.endsWith('down'));   // down/up, rdown/rup
    if (/^r?(up|down)$/.test(a[0])) press(a[0]);
    else { apis.input.mouseAt(Number(a[0]), Number(a[1])); if (a[2]) press(a[2]); }
  }
  mc.runSlice(200000); record();
  while (SHOTS.length && mc.cpu.cycles >= SHOTS[0] * SEC) await shot(SHOTS.shift());
}
if (WAV) {
  const { writeFileSync } = await import('fs');
  const n = heard.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(wavRate, 24); b.writeUInt32LE(wavRate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, heard[i])), 44 + i * 2);
  writeFileSync(WAV, b); console.error(`mirage-win32: ${(n / 2 / wavRate).toFixed(1)} s of sound -> ${WAV}`);
  if (midiHeard.some((v) => v)) { writeFileSync(WAV.replace(/\.wav$/i, '') + '.midi.wav', writeWav(null, midiHeard, midiRate)); console.error(`mirage-win32: ${(midiHeard.length / 2 / midiRate).toFixed(1)} s of MIDI -> ${WAV.replace(/\.wav$/i, '')}.midi.wav`); }
}
// MIRAGE_W32DUMP=qconsole.log: a file of the program's disk at the end (what it wrote: Half-Life's -condebug log).
// MIRAGE_W32DUMPDIR=<dir>: those files written there instead, as bytes, by their base name (an installer's).
if (process.env.MIRAGE_W32DUMP) for (const n of process.env.MIRAGE_W32DUMP.split(',')) {
  const f = apis.readFile(n), dir = process.env.MIRAGE_W32DUMPDIR;
  if (dir && f) { const { writeFileSync, mkdirSync } = await import('node:fs'); mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/${n.replace(/^.*[\\/]/, '')}`, f); console.error(`w32 file ${n}: ${f.length} bytes`); }
  else console.error(`w32 file ${n}:`, f ? (dir ? '' : Buffer.from(f).toString('latin1')) : '(none)');
}
if (PROBE && probes.counts) console.error('probe counts:', JSON.stringify(Object.fromEntries(probes.counts)));
if (PROBE && probes.sprCounts) console.error('probe hud draws:', JSON.stringify(probes.sprCounts));
// MIRAGE_W32BLOCKS=<preferred lo>-<preferred hi>@<module>: the blocks translated there so far (executed at least
// once), as the module's preferred addresses -- which of a DLL's functions ran.
if (process.env.MIRAGE_W32BLOCKS) {
  const [range, modName] = process.env.MIRAGE_W32BLOCKS.split('@'), [lo, hi] = range.split('-').map((v) => parseInt(v, 16));
  const m = loaded.x.win.modules.get(modName), rel = m.base - 0x10000000, out = [];
  for (const [page, set] of mc.rec.pageBlocks) if ((page << 12) + 0xfff >= lo + rel && page << 12 <= hi + rel) for (const lin of set) if (lin >= lo + rel && lin < hi + rel) out.push(lin - rel);
  console.error('w32 blocks:', [...new Set(out)].sort((a, b) => a - b).map((v) => v.toString(16)).join(' '));
}
// MIRAGE_W32WINS=1: the windows at the end, one a line.
if (process.env.MIRAGE_W32WINS && apis.windows) for (const w of apis.windows()) console.error('w32 window:', JSON.stringify(w));
const t = backend.summary();
console.error('w32:', JSON.stringify({ mode: t.mode, frames: t.frames, calls: t.calls }));
for (const s of t.shaders) console.error('w32 shader:\n' + s);
if (!lx.done) { console.error(SECS ? `mirage-win32: stopped after ${SECS} guest seconds` : `mirage-win32: still running after ${LIMIT} cycles`); process.exit(SECS ? 0 : 124); }
if (lx.signal) {
  const f = lx.faultInfo;
  console.error(`mirage-win32: fault` + (f ? ` (exception ${f.n} err ${f.err} at eip ${f.eip.toString(16)}, cr2 ${f.cr2.toString(16)})` : ''));
  process.exit(1);
}
console.error(`mirage-win32: exited with ${lx.status}`);
