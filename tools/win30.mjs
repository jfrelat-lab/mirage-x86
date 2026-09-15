// win30.mjs — run the Windows 3.0 tree built by tools/win30-install.mjs, and report where it stops.
//
//   node tools/win30.mjs ["/3"] [out.png] [blocks]      defauts: 30 M blocs, 180 s
//   WIN30_SECS=600 node tools/win30.mjs …                 pour lever le plafond de temps
//   XMS=0 node tools/win30.mjs            — the memory-driver configurations (see docs/COMPAT.md)
//
// There was no committed runner for this, which is why "where win /3 stops" lived only in
// docs/COMPAT.md and could not be re-measured after an engine change. Windows announces its own
// failures in TEXT, so the picture is the least useful output here: what settles a question is the
// INT 2Fh trail (the enhanced-mode takeover is negotiated over 2Fh), the exception count, and
// whatever Windows printed through DOS.
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';
import { VFS } from '../src/vfs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = join(ROOT, 'boot', process.env.WIN30_DIR || 'WIN30');
if (!existsSync(TREE)) {
  console.error(`no tree at ${TREE} — build it first:\n  node tools/win30-install.mjs`);
  process.exit(2);
}
const args = process.argv[2] ?? '/3';
const out = process.argv[3] || join(ROOT, 'win30.png');
// 30 M blocks, and a wall-clock cap on top. The measured scales are ~450 000 blocks to KERNEL's
// EXEC and ~4 M to the Program Manager, so this leaves 7x headroom and still ends in under a minute.
//
// The old default was 400 M, which is unrelated to any of those numbers — and a block budget alone
// does not bound TIME: in a derail the guest executes 192-instruction blocks of zeroes costing ~700us
// each, so 400 M blocks is effectively forever. One such run was found still going after 9h21 at
// 117% CPU, on a workload that cannot terminate by itself. Hence both bounds.
const BLOCKS = Number(process.argv[4]) || 30_000_000;
const SECS = Number(process.env.WIN30_SECS) || 180;

const vfs = new VFS();
for (const rel of walk(TREE)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(TREE, rel))));
vfs.chdir('\\');

const { mc, dos } = makeMachine({ vfs, xms: process.env.XMS !== '0', ems: process.env.EMS !== '0' });

// Handlers are wrapped IN PLACE. machine.intHandlers is read through a local on the dispatch path,
// so replacing the array would log nothing — the same trap that made an earlier port census come
// back empty.
const trail = [];
const wrap = (n, fn) => { const h = mc.intHandlers[n]; if (h) mc.intHandlers[n] = (cpu, m) => { fn(cpu); return h(cpu, m); }; };
wrap(0x2f, (cpu) => trail.push(cpu.ax & 0xffff));

// Windows' diagnostics come out of DOS, not out of the framebuffer: AH=09h (string at DS:DX, '$'
// terminated), AH=02h (one character in DL) and AH=40h (write to a handle).
let con = '';
wrap(0x21, (cpu) => {
  const ah = (cpu.ax >> 8) & 0xff;
  if (ah === 0x02) con += String.fromCharCode(cpu.dx & 0xff);
  else if (ah === 0x09) {
    let a = (cpu.seg[3] << 4) + (cpu.dx & 0xffff);
    for (let i = 0; i < 512; i++) { const c = mc.mem.r8(a + i); if (c === 0x24) break; con += String.fromCharCode(c); }
  } else if (ah === 0x40 && (cpu.bx & 0xffff) <= 2) {
    const a = (cpu.seg[3] << 4) + (cpu.dx & 0xffff), n = cpu.cx & 0xffff;
    for (let i = 0; i < n && i < 4096; i++) con += String.fromCharCode(mc.mem.r8(a + i));
  }
});

// EMS is asked for over INT 67h, and the XMS driver through its far-callable entry. Windows
// complains about whichever of the two it was told to take over, so both trails are needed to say
// WHICH call it is unhappy with — or, as documented, that it never makes one.
const ems = [];
wrap(0x67, (cpu) => ems.push(((cpu.ax >> 8) & 0xff).toString(16).padStart(2, '0')));
let xmsCalls = 0;
const xmsLog = [];
if (mc.cpu.xmsCall) {
  const x = mc.cpu.xmsCall.bind(mc.cpu);
  mc.cpu.xmsCall = () => {
    const ah = (mc.cpu.ax >> 8) & 0xff, dx = mc.cpu.dx & 0xffff;
    xmsCalls++;
    const r = x();
    // AX=1 is success; AX=0 puts the error code in BL. Recording the ANSWER as well as the call is
    // the point: 421 calls arrive, so what Windows dislikes is a reply, not a missing entry.
    const ax = mc.cpu.ax & 0xffff, bl = mc.cpu.bx & 0xff;
    xmsLog.push(`${ah.toString(16).padStart(2, '0')}${dx ? ':' + dx.toString(16) : ''}` +
      `=>${ax === 1 ? 'ok' : 'ERR' + bl.toString(16)}`);
    return r;
  };
}

let exc = 0;
const oldProt = mc.protInt.bind(mc);
mc.protInt = (n, err, faultIp) => { exc++; return oldProt(n, err, faultIp); };

let fault = null;
mc.onError = (e) => { fault = e; };

dos.load(new Uint8Array(readFileSync(join(TREE, 'WIN.COM'))), args ? ' ' + args : '', 'C:\\WIN.COM');

let blocks = 0, guard = 0;
const t0 = Date.now();
let timedOut = false;
while (blocks < BLOCKS && !fault && !dos.programDone && guard++ < 20_000_000) {
  if (Date.now() - t0 > SECS * 1000) { timedOut = true; break; }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  blocks += mc.runSlice(20000);
}

const mode = mc.mem.r8(0x449);
console.log(`win ${args} — blocs=${blocks} en ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
  `${dos.programDone ? 'programme termine' : timedOut ? `ARRET SUR LE TEMPS (${SECS}s, WIN30_SECS pour changer)` : 'budget de blocs epuise'}` +
  `${fault ? `  FAUTE: ${fault.message || fault}` : ''}`);
console.log(`mode=0x${mode.toString(16)} CR0=0x${(mc.cpu.cr0 >>> 0).toString(16)} CR3=0x${(mc.cpu.cr3 >>> 0).toString(16)} ` +
  `TR=0x${(mc.cpu.tr || 0).toString(16)} exceptions=${exc}`);
if (trail.length) {
  const seen = trail.map((a) => a.toString(16).padStart(4, '0'));
  console.log(`INT 2Fh (${seen.length}) : ${seen.slice(-40).join(' ')}`);
}
if (ems.length) console.log(`INT 67h (${ems.length}) AH : ${ems.slice(-40).join(' ')}`);
console.log(`appels a l'entree XMS : ${xmsCalls}`);
if (xmsLog.length) {
  const fails = xmsLog.filter((e) => e.includes('ERR'));
  const uniq = [...new Set(xmsLog)];
  console.log(`  fonctions distinctes : ${uniq.slice(0, 40).join(' ')}`);
  console.log(`  echecs : ${fails.length}${fails.length ? ' — ' + [...new Set(fails)].join(' ') : ''}`);
  console.log(`  20 derniers : ${xmsLog.slice(-20).join(' ')}`);
  if (process.env.WIN30_XMSDUMP) { writeFileSync(process.env.WIN30_XMSDUMP, xmsLog.join('\n') + '\n'); }
}
if (con.trim()) console.log(`console :\n  ${con.trim().split('\n').join('\n  ')}`);

// Mode 0x12 is 640x480x16 planar, so the 320x200 composer in shot.mjs cannot render this at all.
// Geometry comes from the CRTC, as everywhere else in this toolbox.
const W = mode === 0x12 ? 640 : 320, H = mode === 0x12 ? 480 : 200;
const vga = mc.vga, dac = mc.bios.dac, rgb = new Uint8Array(W * H * 3);
if (vga && mc.mem.planar) {
  const planes = vga.planes, stride = (vga.crtc[0x13] || (W >> 4)) * 2;
  const start = ((vga.crtc[0x0c] << 8) | vga.crtc[0x0d]) >>> 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const off = (start + y * stride + (x >> 3)) & 0xffff, bit = 7 - (x & 7);
    let idx = 0;
    for (let p = 0; p < 4; p++) idx |= ((planes[p * 0x10000 + off] >> bit) & 1) << p;
    const d = (vga.palette ? vga.palette[idx] : idx) & 0x3f, i = (y * W + x) * 3;
    rgb[i] = dac[d * 3] << 2; rgb[i + 1] = dac[d * 3 + 1] << 2; rgb[i + 2] = dac[d * 3 + 2] << 2;
  }
} else {
  for (let i = 0; i < W * H && i < 64000; i++) {
    const d = mc.mem.u8[0xa0000 + i];
    rgb[i * 3] = dac[d * 3] << 2; rgb[i * 3 + 1] = dac[d * 3 + 1] << 2; rgb[i * 3 + 2] = dac[d * 3 + 2] << 2;
  }
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(rgb.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
const crc32 = (b) => { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(body)); return Buffer.concat([L, body, C]); };
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`-> ${out}`);
