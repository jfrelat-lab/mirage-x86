// One guest process's system calls under QEMU, through its gdb stub — the reference for the same log
// taken inside MIRAGE. Two phases:
//   1. ARM: a hardware breakpoint on a user address; stop when it is hit with EBX = <ebx> (to pick
//      the right process among those sharing the address), and remember that CR3.
//   2. LOG: a breakpoint on the kernel's syscall gate; every hit with that CR3 prints EAX EBX ECX EDX
//      ESI EDI and the caller's EIP (the IRET frame on the kernel stack), and EAX as it comes back
//      (read at the caller's return address).
//
//   node qsyscall.mjs <image> <arm-addr> <arm-ebx> <gate-addr> [max calls] [seconds]
//   e.g. KolibriOS @ICON:  node qsyscall.mjs boot/v86/kolibri.img 319 2731 80016460 60 120
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { readFileSync, writeFileSync, statSync } from 'fs';
const [img, armS, ebxS, gateS] = process.argv.slice(2, 6);
const ARM = parseInt(armS, 16), ARM_EBX = parseInt(ebxS, 16), GATE = parseInt(gateS, 16);
const MAX = Number(process.argv[6]) || 60, SECS = Number(process.argv[7]) || 120;
const copy = '/tmp/qsyscall.img';
let bytes = readFileSync(img);
if (statSync(img).size < 1474560) { const p = Buffer.alloc(1474560); bytes.copy(p); bytes = p; }
writeFileSync(copy, bytes);
const PORT = 13000 + (process.pid % 1000);
const q = spawn('/opt/homebrew/bin/qemu-system-i386', ['-m', '16', '-cpu', 'pentium',
  '-drive', `format=raw,file=${copy},if=floppy,index=0`, '-boot', 'a',
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
const le32 = (s, i = 0) => parseInt(s.slice(i * 8, i * 8 + 8).match(/../g).reverse().join(''), 16) >>> 0;
const h = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
await new Promise((r) => sock.on('connect', r));
sock.write('+');
await cmd('?');
const T0 = Date.now(), left = () => Math.max(1, SECS * 1000 - (Date.now() - T0));
const regs = async () => { const g = await cmd('g'); return (i) => le32(g, i); };
const cr3 = async () => le32(await cmd('p2e'));          // register 46 = CR3 in QEMU's i386 target
const stepOver = async (a) => { await cmd(`z1,${a.toString(16)},1`); await cmd('s'); await cmd(`Z1,${a.toString(16)},1`); };

await cmd(`Z1,${ARM.toString(16)},1`);
let target = -1;
while (left() > 1) {
  if (!(await cmd('c', left()))) break;
  const r = await regs();
  if (r(3) === ARM_EBX) { target = await cr3(); console.log(`armed: CR3=${h(target)} EAX=${h(r(0))} (the call returned this)`); break; }
  await stepOver(ARM);
}
await cmd(`z1,${ARM.toString(16)},1`);
if (target < 0) { console.log('never armed'); sock.destroy(); q.kill('SIGKILL'); process.exit(1); }

await cmd(`Z1,${GATE.toString(16)},1`);
let n = 0, pendingRet = -1, pendingFn = 0;
while (n < MAX && left() > 1) {
  if (!(await cmd('c', left()))) break;
  const r = await regs(), pc = r(8);
  if (pc === pendingRet) {                                  // back in the caller: the call's result
    console.log(`      = EAX ${h(r(0))} EBX ${h(r(3))}`);
    await cmd(`z1,${pendingRet.toString(16)},1`); pendingRet = -1;
    if (pc === GATE) { /* cannot happen */ }
    continue;
  }
  if ((await cr3()) !== target) { await stepOver(GATE); continue; }
  const esp = r(4), fr = await cmd(`m${esp.toString(16)},4`), ret = le32(fr);
  pendingFn = r(0) | 0;
  console.log(`fn ${pendingFn} EBX=${h(r(3))} ECX=${h(r(1))} EDX=${h(r(2))} ESI=${h(r(6))} EDI=${h(r(7))} from ${h(ret)}`);
  n++;
  await stepOver(GATE);
  if (pendingRet < 0) { pendingRet = ret; await cmd(`Z1,${ret.toString(16)},1`); }
}
sock.destroy(); q.kill('SIGKILL');
