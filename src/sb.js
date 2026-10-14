// sb.js — a Sound Blaster 16 at 220h, IRQ 7, DMA 1 and 5: what DOS's BLASTER variable says.
//
// The DSP takes commands and data on 22Ch and answers on 22Ah; reading 22Eh (8-bit) or 22Fh (16-bit)
// acknowledges its interrupt. Playback is DMA: the card pulls samples from the 8237 at the rate the
// program set, and raises its IRQ at the end of every block. That is what this models — the card
// CONSUMES its channel, so the current count a player reads back moves, and the end-of-block
// interrupt comes when the samples have been played. Without it a player that refills its buffer up
// to the card's position (Void 3) recomputed the whole buffer on every tick and never drew a frame.
//
// Time is the machine's own: cpu.cycles headless (18.2065 * pitBase cycles a second, the PIT's clock),
// wall-clock time in the browser, where the PIT follows wall-clock time too — see machine.wallClockMs.
// The card catches up at every run slice and whenever the guest reads the DMA controller.
//
// The samples it pulls are kept, as signed 16-bit stereo at the card's rate, for src/audio.js to mix
// (sb.drain()).
//
// The SB Pro's stereo bit (mixer register 0Eh) is not honoured: this is an SB16, and DOSBox-X's SB16
// plays those programs in mono ("stereo control with sbpro only", its default). Unreal asks for SB
// Pro stereo and is mono there; here it was stereo, with left and right swapped every odd block.
//
// The DSP command set is the documented SB16 one (Creative's "Sound Blaster Series Hardware
// Programming Guide"): 8-bit single-cycle and auto-init (14h, 1Ch), high speed (90h, 91h), the SB16
// generic Bxh/Cxh commands, time constant and output rate, pause, continue and exit auto-init,
// speaker, version 4.05, and the test and IRQ-trigger commands. ADPCM and recording are not
// implemented: their commands are accepted and play silence.

import { clock } from './audio.js';

const BASE = 0x220, IRQ = 7, DMA8 = 1, DMA16 = 5;
// Arguments each command takes (bytes after the command byte).
const ARGS = new Map([
  [0x10, 1], [0x14, 2], [0x16, 2], [0x17, 2], [0x24, 2], [0x40, 1], [0x41, 2], [0x42, 2], [0x48, 2],
  [0x74, 2], [0x75, 2], [0x76, 2], [0x77, 2], [0x80, 2], [0xe0, 1], [0xe4, 1], [0xe2, 1],
  // The ASP/CSP commands (SB16 "Advanced Signal Processor"): set mode, set codec parameter, set
  // register, get register. Windows 95's SB16 driver sends 04 FC, 04 FA, then 0F 83 and waits for the
  // answer; taking their argument bytes for commands and never answering left it at its logo for good.
  [0x04, 1], [0x05, 2], [0x0e, 2], [0x0f, 1],
]);
for (let c = 0xb0; c <= 0xcf; c++) ARGS.set(c, 3);

export function installSB(machine) {
  const mem = machine.mem;
  const sb = {
    inQ: [], outQ: [], cmd: -1, args: [], resetting: false, speaker: false, test: 0,
    rate: 22050, block8: 0x7ff, mixerIndex: 0, mixer: new Uint8Array(256), csp: new Uint8Array(256),
    irq8: false, irq16: false,
    // The transfer in progress, or null: { wide, stereo, signed, auto, left (units to the IRQ), len }
    xfer: null, paused: false, carry: null,
    clock: 0, frac: 0,                       // last time the card caught up (seconds), and a sample fraction
    cyc: 0,                                  // ...and the CPU's cycle count then
    pcm: [], pcmRate: 22050,                 // played samples, interleaved L/R Int16, for drain()
    drain() { const out = Int16Array.from(sb.pcm); sb.pcm.length = 0; return { rate: sb.pcmRate, samples: out }; },
  };
  // The card's time: wall time, or the instructions run since it last caught up at the rate the end of
  // block is armed with, whichever has moved further — as the OPL's timers. In the browser the guest
  // can run ahead of the wall clock, faster than the measured average: Unreal waits for the IRQ of a
  // short test transfer in a counted loop, and the wall clock alone had not moved enough to finish
  // the transfer when the loop gave up — "Selected sound card not found". Headless the two are the
  // same clock.
  const cps = () => (machine.wallClockMs ? (machine.cyclesPerSecond || 1e8) : 18.2065 * (machine.pitBase || 0x10000));
  const now = () => Math.max(clock(machine), sb.clock + (machine.cpu.cycles - sb.cyc) / cps());
  const mark = (t) => { sb.clock = t; sb.cyc = machine.cpu.cycles; };
  const raise = (wide) => {
    if (wide) sb.irq16 = true; else sb.irq8 = true;
    machine.raiseIRQ(IRQ);
  };

  // ---- the mixer (224h index, 225h data) ----
  const mixerReset = () => {
    sb.mixer.fill(0);
    sb.mixer[0x80] = 0x04;                  // IRQ select: IRQ 7
    sb.mixer[0x81] = 0x22;                  // DMA select: 8-bit DMA 1, 16-bit DMA 5
    for (const r of [0x22, 0x26, 0x04]) sb.mixer[r] = 0xcc;   // master, FM, voice at 75%
    for (const r of [0x30, 0x31, 0x32, 0x33, 0x34, 0x35]) sb.mixer[r] = 0xc0;
  };
  mixerReset();
  machine.onPortWrite(BASE + 4, (p, s, v) => { sb.mixerIndex = v & 0xff; });
  machine.onPortWrite(BASE + 5, (p, s, v) => {
    if (sb.mixerIndex === 0x00) { mixerReset(); return; }
    if (sb.mixerIndex === 0x82) return;     // the interrupt status is read-only
    sb.mixer[sb.mixerIndex] = v & 0xff;
  });
  machine.onPortRead(BASE + 5, () => {
    if (sb.mixerIndex === 0x82) return (sb.irq8 ? 1 : 0) | (sb.irq16 ? 2 : 0);
    return sb.mixer[sb.mixerIndex];
  });

  // ---- playback ----
  // Pull `frames` sample frames from DMA. A frame is one unit (mono) or two (stereo); a unit is a
  // byte on the 8-bit channel and a word on the 16-bit one, which is also what the 8237 counts.
  const pull = (frames) => {
    const x = sb.xfer, c = x.wide ? DMA16 : DMA8, per = x.stereo ? 2 : 1;
    let units = frames * per, got = [];
    while (units > 0 && sb.xfer) {
      const n = Math.min(units, x.left);
      const r = machine.dma.transfer(c, n, (a) => {
        let v = x.wide ? (mem.u8[a & mem.mask] | (mem.u8[(a + 1) & mem.mask] << 8)) : mem.u8[a & mem.mask];
        if (x.wide) v = x.signed ? (v << 16 >> 16) : v - 0x8000;
        else v = (x.signed ? (v << 24 >> 24) : v - 0x80) << 8;
        got.push(v);
      });
      if (r.done === 0) break;              // the channel is masked: the card waits for it
      units -= r.done; x.left -= r.done;
      if (x.left <= 0) {
        raise(x.wide);
        if (x.auto) x.left = x.len; else { sb.xfer = null; }
      }
    }
    // Keep it as stereo, so a player needs no mode of its own. A stereo stream alternates left and
    // right unit by unit whatever the block size: a unit left over from an odd-length block is the
    // left half of the next frame, not the start of a new pair.
    if (per === 2) { if (sb.carry !== null) got.unshift(sb.carry); sb.carry = got.length & 1 ? got.pop() : null; }
    // The speaker commands (D1h, D3h) do not gate an SB16's output: DOSBox-X's DSP_SetSpeaker returns
    // before touching the channel when the card is an SB16, and QEMU's only records the flag. DOOM's
    // DMX never sends D1h; its sound effects were silent here.
    if (machine.audio) {                                                // kept only if someone will play them
      if (per === 2) for (const v of got) sb.pcm.push(v);
      else for (const v of got) sb.pcm.push(v, v);
    }
    if (sb.pcm.length > 1 << 20) sb.pcm.splice(0, sb.pcm.length - (1 << 20));   // nobody is draining
  };
  const catchUp = () => {
    const t = now(), dt = t - sb.clock;
    mark(t);
    if (!sb.xfer || sb.paused || dt <= 0) { sb.frac = 0; return; }
    sb.pcmRate = sb.rate;
    let frames = dt * sb.rate + sb.frac;
    const whole = Math.floor(frames);
    sb.frac = frames - whole;
    if (whole > 0) pull(Math.min(whole, sb.rate));   // at most a second at once: a backlog is dropped
  };
  // When the block in progress ends, in cycles, so the IRQ comes on time and not at the next run
  // slice: a driver probing for the card's IRQ (Unreal) gives a 5-byte transfer ~10 ms, and a slice
  // can be longer than that. Exact headless, where the clock IS cycles; in the browser the clock is
  // wall time and the cycle count is estimated from the measured execution rate.
  const arm = () => {
    const x = sb.xfer;
    if (!x || sb.paused || !sb.rate) return;
    const frames = x.left / (x.stereo ? 2 : 1), secs = Math.max(0, (frames - sb.frac) / sb.rate);
    machine.armDevice(machine.cpu.cycles + Math.ceil(secs * cps()) + 1);
  };
  const poll = () => { catchUp(); arm(); };
  machine.sbPoll = poll;
  machine.dma.beforeRead = catchUp;

  const start = (wide, auto, stereo, signed, units) => {
    mark(clock(machine)); sb.frac = 0; sb.paused = false;
    sb.xfer = { wide, auto, stereo, signed, len: units, left: units };
    arm();
  };

  // ---- the DSP ----
  const out = (...b) => { for (const x of b) sb.outQ.push(x & 0xff); };
  const exec = (c, a) => {
    switch (c) {
      case 0x10: sb.pcm.push((a[0] - 0x80) << 8, (a[0] - 0x80) << 8); return;   // direct output
      case 0x14: case 0x16: case 0x17: case 0x24:                          // 8-bit single cycle (ADPCM and input: silence)
        start(false, false, false, false, (a[0] | (a[1] << 8)) + 1); return;
      case 0x1c: case 0x1f: case 0x2c:                                     // 8-bit auto-init
        start(false, true, false, false, sb.block8 + 1); return;
      case 0x90: case 0x98: start(false, true, false, false, sb.block8 + 1); return;   // high speed auto-init
      case 0x91: case 0x99: start(false, false, false, false, sb.block8 + 1); return;  // high speed single cycle
      case 0x40: sb.rate = Math.round(1e6 / (256 - a[0])); return;        // time constant: 256 - 1e6 / rate
      case 0x41: case 0x42: sb.rate = (a[0] << 8) | a[1]; return;          // output / input rate, high byte first
      case 0x48: sb.block8 = a[0] | (a[1] << 8); return;                   // block size - 1
      case 0x80: return;                                                   // silence: not modelled
      case 0xd0: case 0xd5: catchUp(); sb.paused = true; return;           // pause
      case 0xd4: case 0xd6: mark(clock(machine)); sb.paused = false; arm(); return;   // continue
      case 0xd9: case 0xda: if (sb.xfer) sb.xfer.auto = false; return;     // exit auto-init after this block
      case 0xd1: sb.speaker = true; return;
      case 0xd3: sb.speaker = false; return;
      case 0xd8: out(sb.speaker ? 0xff : 0x00); return;
      case 0xe0: out(~a[0]); return;                                       // DSP identification
      case 0xe1: out(4, 5); return;                                        // version 4.05
      case 0xe3: for (const ch of 'COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.') out(ch.charCodeAt(0)); out(0); return;
      // ASP/CSP, measured with tools/cspprobe.asm: QEMU -device sb16 and DOSBox-X both answer 00 to
      // 0F 83 and nothing to 04 and 05. A register 0E wrote reads back as QEMU has it (DOSBox-X answers
      // otherwise); 03 stays unanswered (QEMU 10h, DOSBox-X nothing).
      case 0x0e: sb.csp[a[0]] = a[1]; return;
      case 0x0f: out(sb.csp[a[0]]); return;
      case 0x04: case 0x05: return;
      case 0xe4: sb.test = a[0]; return;
      case 0xe8: out(sb.test); return;
      case 0xf2: raise(false); return;                                     // trigger the 8-bit IRQ
      case 0xf3: raise(true); return;                                      // and the 16-bit one
      case 0x20: out(0x80); return;                                        // direct input: silence
      default:
        if (c >= 0xb0 && c <= 0xcf && !(c & 0x08)) {                       // SB16 generic: Bxh 16-bit, Cxh 8-bit; bit 3 = input
          const wide = c < 0xc0, mode = a[0];
          start(wide, !!(c & 0x04), !!(mode & 0x20), !!(mode & 0x10), (a[1] | (a[2] << 8)) + 1);
        }
    }
  };
  machine.onPortWrite(BASE + 6, (p, s, v) => {                             // reset: 1 then 0, then AAh
    if (v & 1) { sb.resetting = true; return; }
    if (!sb.resetting) return;
    sb.resetting = false;
    sb.outQ.length = 0; sb.cmd = -1; sb.args = []; sb.xfer = null; sb.paused = false; sb.speaker = false;
    sb.irq8 = sb.irq16 = false;
    out(0xaa);
  });
  machine.onPortWrite(BASE + 0xc, (p, s, v) => {
    v &= 0xff;
    if (sb.cmd < 0) {
      sb.cmd = v; sb.args = [];
    } else sb.args.push(v);
    if (sb.args.length >= (ARGS.get(sb.cmd) || 0)) { const c = sb.cmd; sb.cmd = -1; exec(c, sb.args); }
  });
  machine.onPortRead(BASE + 0xc, () => 0x7f);                              // write status: bit 7 clear = ready
  machine.onPortRead(BASE + 0xa, () => (sb.outQ.length ? sb.outQ.shift() : 0xff));
  machine.onPortRead(BASE + 0xe, () => { sb.irq8 = false; return sb.outQ.length ? 0xff : 0x7f; });   // bit 7: data to read; acks the 8-bit IRQ
  machine.onPortRead(BASE + 0xf, () => { sb.irq16 = false; return 0xff; });                          // acks the 16-bit IRQ

  machine.sb = sb;
  return sb;
}
