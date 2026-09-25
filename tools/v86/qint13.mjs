// Every INT 13h a boot image makes under QEMU, through QEMU's gdb stub: a breakpoint on SeaBIOS's
// INT 13h entry (F000:E3FE, the fixed address of the IBM PC BIOS entry point, which SeaBIOS keeps)
// logs AX BX CX DX ES and the caller at each call. Requests only: aligning the two request streams
// (MIRAGE's from its INT 13h handler) is what finds where a guest's disk access starts to differ.
// After each stop the breakpoint is lifted for one single step, or `c` stops on it again at once.
//
//   node qint13.mjs <image> [max calls] [seconds]
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { readFileSync, writeFileSync, statSync } from 'fs';
const img = process.argv[2], MAX = Number(process.argv[3]) || 200, SECS = Number(process.argv[4]) || 60;
const copy = '/tmp/qint13.img';
let bytes = readFileSync(img);
if (statSync(img).size < 1474560) { const p = Buffer.alloc(1474560); bytes.copy(p); bytes = p; }
writeFileSync(copy, bytes);
const hd = bytes.length > 2949120;
const PORT = 12000 + (process.pid % 1000), BP = 0xfe3fe;
const q = spawn('/opt/homebrew/bin/qemu-system-i386', ['-m', '16',
  '-drive', `format=raw,file=${copy},if=${hd ? 'ide' : 'floppy'},index=0`, '-boot', hd ? 'c' : 'a',
  '-display', 'none', '-no-reboot', '-net', 'none', '-gdb', `tcp::${PORT}`, '-S'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);
const sock = createConnection(PORT, '127.0.0.1');
let rx = '';
sock.on('data', (b) => { rx += b.toString('latin1'); });
const ck = (s) => [...s].reduce((a, ch) => (a + ch.charCodeAt(0)) & 0xff, 0).toString(16).padStart(2, '0');
const reply = async (ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = rx.match(/\$([^#]*)#[0-9a-f]{2}/);
    if (m) { rx = rx.slice(rx.indexOf(m[0]) + m[0].length); sock.write('+'); return m[1]; }
    await sleep(1);
  }
  return null;
};
const cmd = async (c, ms = 5000) => { rx = rx.replace(/^\+/, ''); sock.write(`$${c}#${ck(c)}`); return reply(ms); };
await new Promise((r) => sock.on('connect', r));
sock.write('+');
await cmd('?');
await cmd(`Z1,${BP.toString(16)},1`);
const h = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
const t0 = Date.now();
for (let k = 0; k < MAX && Date.now() - t0 < SECS * 1000; k++) {
  const stop = await cmd('c', SECS * 1000 - (Date.now() - t0));
  if (!stop) break;
  const g = await cmd('g');
  const r32 = (i) => parseInt(g.slice(i * 8, i * 8 + 8).match(/../g).reverse().join(''), 16) >>> 0;
  const [ax, cx, dx, bx] = [r32(0), r32(1), r32(2), r32(3)], es = r32(13);
  // The caller's CS:IP is the IRET frame on the stack: SS:SP -> IP, CS, FLAGS.
  const ss = r32(11), sp = r32(4) & 0xffff;
  const fr = await cmd(`m${((ss << 4) + sp).toString(16)},4`);
  const w = (s, i) => parseInt(s.slice(i * 4 + 2, i * 4 + 4) + s.slice(i * 4, i * 4 + 2), 16);
  await cmd(`z1,${BP.toString(16)},1`); await cmd('s'); await cmd(`Z1,${BP.toString(16)},1`);
  console.log(`AX=${h(ax)} BX=${h(bx)} CX=${h(cx)} DX=${h(dx)} ES=${h(es)}  from ${h(w(fr, 1))}:${h(w(fr, 0))}`);
}
sock.destroy(); q.kill('SIGKILL');
