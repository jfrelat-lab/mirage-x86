// golden-frame.mjs — which frame of an intro tools/golden.js pins, so a recompiled build can be held
// to the committed golden itself and not only to a fresh MIRAGE run.
//
// golden.js runs a FIXED schedule (60 ticks of runSlice(400000) on the browser's machine, timer
// on) and hashes mode byte + fault byte + A000 + DAC. This replays that schedule with a hook on port
// 0x60 that counts the polls (one per frame, after the blit) and keeps the frame at the last one. If
// the picture at the end of the schedule is that frame -- the schedule did not stop inside a blit --
// the golden is "frame k", and `goldenHash(fb, dac)` of a recompiled run's frame k must equal it.
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeMachine } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TICKS = 60, BUDGET = 400000;

/** golden.js's fingerprint of a mode-13h picture with no fault. */
export function goldenHash(fb, dac, mode = 0x13) {
  const meta = Buffer.alloc(8); meta[0] = mode;
  return createHash('sha1').update(meta).update(fb).update(dac).digest('hex');
}

export function goldenFrame(name) {
  const rel = `intros/${name}.com`;
  const base = JSON.parse(readFileSync(join(ROOT, 'tools', 'golden-baseline.json'), 'utf8'))[rel];
  const { mc, dos } = makeMachine({ dos: true });
  let fault = null; mc.onError = (e) => { fault = e; };
  dos.load(new Uint8Array(readFileSync(join(ROOT, rel))), '', 'C:\\PROG');
  let polls = 0, atPoll = null;
  const prev = mc.portRead[0x60];
  mc.onPortRead(0x60, (p, s) => { polls++; atPoll = Buffer.from(mc.mem.u8.subarray(0xa0000, 0xa0000 + 64000)); return prev ? prev(p, s) : 0xff; });
  for (let t = 0; t < TICKS && !fault && !dos.programDone; t++) mc.runSlice(BUDGET);
  const fb = mc.mem.u8.subarray(0xa0000, 0xa0000 + 64000);
  const dac = Buffer.from(mc.bios.dac.buffer, mc.bios.dac.byteOffset, 768);
  const hash = goldenHash(fb, dac, mc.mem.r8(0x449));
  // Between the k-th poll and the (k+1)-th blit the screen is frame k; a later blit not yet polled
  // makes it frame k+1 (rep movsw is one instruction, so the schedule cannot stop inside one).
  const frame = atPoll && Buffer.compare(atPoll, Buffer.from(fb)) === 0 ? polls : polls + 1;
  return { frame, polls, hash, baseline: base?.hash ?? null, matchesBaseline: hash === base?.hash, fault: fault ? String(fault.message) : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const n of process.argv.slice(2)) console.log(n, goldenFrame(n));
}
