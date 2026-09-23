// win16-waitevent.mjs — in a REAL Windows 3.0, while one task is inside WaitEvent, does a task
// DISTINCT FROM THE CALLER advance in its own message loop?
//
//   node tools/win16-waitevent.mjs            (needs the tree built by tools/win30-install.mjs)
//
// Measured 2026-09-23 for the Win16 HLE work (branch win16-hle): YES. While the task on SS=133d sat
// in WaitEvent (called from 2443), the task on SS=3d07 entered GetMessage from 3e79:1577 about every
// 350 000 blocks for more than 4 million blocks; 280 WaitEvent entries, 278 returns. So a Win16
// reimplementation whose WaitEvent returns at once is right with one task and wrong from the second.
// What it measures is Windows' own KERNEL scheduler as MIRAGE's CPU executes it, not a hardware
// trace: if the CPU diverges underneath, this reproduces the divergence faithfully.
//
// The only proof accepted: the message-loop entry of each task is instrumented, and a task other
// than the caller is shown passing through it between WaitEvent's entry and its return. Not "other
// stacks run" (segment 08a9 is KERNEL's, and some of those stacks are KERNEL's own).
//
// Tasks: Program Manager, plus CLOCK launched from the keyboard (Alt+F, R, "clock", Enter) — the
// sequence tools/win16-probe.mjs documents. A task is identified by its STACK segment (each Win16
// task runs on its own SS, its DGROUP) and, for the message loop, by the code segment that called
// GetMessage/PeekMessage (the return CS: the task's own code).
// Traps are the ones win16-probe resolves from the NE entry tables — fixed, segment 1:
//   KERNEL WAITEVENT @30   off 53ec  sig+3 ec 1e 53 8b
//   USER   GETMESSAGE @108 off 263d  sig+3 01 51 51 52
//   USER   PEEKMESSAGE @109 off 2637 sig+3 c9 eb 05 58
// with win16-probe's guards: a signature at +3 on every hit, a witness count without it, wide
// slices until the typed keys have been READ at port 0x60, and "n of N" on every list.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';
import { VFS } from '../src/vfs.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = join(ROOT, 'boot', process.env.WIN30_DIR || 'WIN30');
if (!existsSync(TREE)) { console.error(`no tree at ${TREE} — build it with tools/win30-install.mjs`); process.exit(2); }
const h = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
const TRAPS = new Map([
  [0x53ec, { name: 'WaitEvent', sig: [0xec, 0x1e, 0x53, 0x8b] }],
  [0x263d, { name: 'GetMessage', sig: [0x01, 0x51, 0x51, 0x52] }],
  [0x2637, { name: 'PeekMessage', sig: [0xc9, 0xeb, 0x05, 0x58] }],
]);
const vfs = new VFS();
for (const rel of walk(TREE)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(TREE, rel))));
vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });
const cpu = mc.cpu, mem = mc.mem;
const port = []; const origRead = mc.portRead[0x60];
mc.portRead[0x60] = (p, s) => { const v = origRead(p, s); port.push(v & 0xff); return v; };
const GROUPS = '38,21,a1,b8/13,93/2e,ae,26,a6,18,98,2e,ae,25,a5/1c,9c'.split('/').map((g) => g.split(',').map((x) => parseInt(x, 16)));
let expectedReads = 2; for (const g of GROUPS) expectedReads += g.length;
dos.load(new Uint8Array(readFileSync(join(TREE, 'WIN.COM'))), ' /r', 'C:\\WIN.COM');

const BLOCKS = 160_000_000, SECS = 420;
let b = 0, sent = 0;
const t0 = Date.now();
const delivered = () => sent >= GROUPS.length && port.length >= expectedReads;
const witness = new Map();
const open = new Map();        // SS of a task inside WaitEvent -> { retCs, retIp, at, callerCs }
const loopByTask = new Map();  // SS -> Set of caller CS seen entering GetMessage/PeekMessage
const proofs = [];             // cross-task message-loop entries seen while another task is in WaitEvent
let waits = 0, waitReturns = 0, stepStart = -1;
while (b < BLOCKS && !dos.programDone && Date.now() - t0 < SECS * 1000) {
  if (sent < GROUPS.length && b > 30_000_000 + 12_000_000 * sent) { mc.pushScancodes(GROUPS[sent]); sent++; }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  if (!delivered()) { b += mc.runSlice(20000); continue; }
  if (stepStart < 0) stepStart = b;
  const ip = cpu.eip & 0xffff, ss = cpu.seg[2], cs = cpu.seg[1];
  // Close a WaitEvent: back at its return address on the same stack.
  const o = open.get(ss);
  if (o && cs === o.retCs && ip === o.retIp) { open.delete(ss); waitReturns++; }
  const t = TRAPS.get(ip);
  if (t) {
    witness.set(t.name, (witness.get(t.name) || 0) + 1);
    const lin = (cs << 4) + ip + 3;
    let ok = true; for (let k = 0; k < 4; k++) if (mem.r8(lin + k) !== t.sig[k]) { ok = false; break; }
    if (ok) {
      const a = (ss << 4) + (cpu.reg[4] & 0xffff), retIp = mem.r16(a), retCs = mem.r16(a + 2);
      if (t.name === 'WaitEvent') { waits++; open.set(ss, { retCs, retIp, at: b, callerCs: retCs }); }
      else {
        if (!loopByTask.has(ss)) loopByTask.set(ss, new Set());
        loopByTask.get(ss).add(retCs);
        for (const [wss, w] of open) {
          if (wss !== ss && proofs.length < 12)
            proofs.push(`${t.name} entered by the task on SS=${h(ss)} (caller ${h(retCs)}:${h(retIp)}) ` +
              `while the task on SS=${h(wss)} is inside WaitEvent (called from ${h(w.callerCs)}, entered ${b - w.at} blocks earlier)`);
        }
      }
    }
  }
  b += mc.runSlice(1);
}
console.log(`${b} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s, single-stepped from block ${stepStart}; scancodes read ${port.length}/${expectedReads}`);
console.log(`witness (IP only): ${[...witness].map(([k, v]) => `${k} x${v}`).join('  ') || 'NONE'}`);
console.log(`WaitEvent: ${waits} entries, ${waitReturns} returns, ${open.size} still open at the end`);
console.log(`POSITIVE CONTROL — message loops seen, by task stack: ${[...loopByTask].map(([ss, s]) => `SS=${h(ss)} callers ${[...s].map((x) => h(x)).join(',')}`).join('  |  ') || 'NONE'}`);
console.log(`  (${loopByTask.size} of the 2 expected tasks seen in a message loop)`);
console.log(`PROOF — a message-loop entry by ANOTHER task while one is inside WaitEvent: ${proofs.length}${proofs.length >= 12 ? '+ (first 12 shown)' : ''}`);
for (const p of proofs) console.log('  ' + p);
