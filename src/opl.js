// opl.js — the Yamaha YMF262 (OPL3), which also plays everything written for the YM3812 (OPL2, the
// AdLib): the FM music of most DOS games. Written from the chip's documented behaviour, MIT.
//
// The chip runs at 14.318 MHz / 288 = 49716 samples a second. Each of its 36 operators is a phase
// generator, a log-sine/exponential lookup (the chip has no multiplier: a sine is looked up as an
// attenuation, attenuations add, and one exponential turns the sum back into an amplitude) and an
// envelope generator. Two operators make a channel — in series (FM) or in parallel (AM) — and on the
// OPL3 two channels can join into four operators. Rhythm mode turns the last three channels into
// five drums fed by a noise generator.
//
// Output is generated lazily: every register write first renders the samples up to that moment on
// the machine's clock (src/audio.js clock()), so a note starts when the program wrote it, whatever
// the frame rate. src/audio.js drains the samples (opl.drain()) and resamples them.
//
// The ports: 388h-38Bh (AdLib, and the OPL3's second bank at 38Ah) and the Sound Blaster's 220h-223h
// and 228h-229h. The status byte (tools/oplprobe.asm, DOSBox-X and QEMU): bit 7 IRQ, bit 6 timer 1
// expired, bit 5 timer 2 expired, and 0 in the low bits — an OPL3; an OPL2 would read 06h there.

import { clock } from './audio.js';

export const OPL_RATE = 49716;

// ---- the chip's ROMs, computed ----
// Quarter log-sine: -log2(sin) in 1/256 units, 8.8 fixed point (the chip stores 12 bits).
const LOGSIN = new Uint16Array(256), EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin((i + 0.5) * Math.PI / 512)) * 256);
  EXP[i] = Math.round((Math.pow(2, i / 256) - 1) * 1024);
}
// Frequency multiplier, doubled (the 1/2 entry becomes 1).
const MUL2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
// Key-scale-level ROM (in 0.75 dB steps x 4), by the top four bits of F-number.
const KSLROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSLSHIFT = [8, 1, 2, 0];
// Envelope increment patterns, by the two low bits of the rate.
const EG_INC = [[0, 1, 0, 1, 0, 1, 0, 1], [0, 1, 0, 1, 1, 1, 0, 1], [0, 1, 1, 1, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 1]];
// Register offset (0..21) -> operator in the bank (0..17), or -1 for the gaps.
const SLOT = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];
// Channel (0..8) -> its two operators.
const CH_OPS = [[0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17]];
const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3;

/** exp(-attenuation) for a 12-bit attenuation (4.8 fixed point): a 13-bit amplitude. */
const expAtt = (a) => (a >= 0x1000 ? 0 : (((EXP[(~a) & 0xff] | 0x400) << 1) >> (a >> 8)));

/** The eight waveforms: (10-bit phase, attenuation in env units << 3) -> signed amplitude. */
function wave(ws, ph, att) {
  ph &= 0x3ff;
  let neg = 0, l;
  const q = (p) => LOGSIN[(p & 0x100) ? (~p) & 0xff : p & 0xff];
  switch (ws) {
    case 0: neg = ph & 0x200; l = q(ph); break;                                   // sine
    case 1: if (ph & 0x200) return 0; l = q(ph); break;                            // half sine
    case 2: l = q(ph); break;                                                      // abs sine
    case 3: if (ph & 0x100) return 0; l = q(ph); break;                            // pulse sine
    case 4: if (ph & 0x200) return 0; neg = ph & 0x100; l = q(ph << 1); break;     // even sine
    case 5: if (ph & 0x200) return 0; l = q(ph << 1); break;                       // abs even sine
    case 6: neg = ph & 0x200; l = 0; break;                                        // square
    default: neg = ph & 0x200; l = ((neg ? (~ph) & 0x1ff : ph & 0x1ff)) << 3; break;   // derived square
  }
  const v = expAtt(l + att);
  return neg ? -v : v;
}

function makeOp() {
  return {
    am: 0, vib: 0, egt: 0, ksr: 0, mult: 0, ksl: 0, tl: 0, ar: 0, dr: 0, sl: 0, rr: 0, ws: 0,
    phase: 0, env: 511, state: RELEASE, key: 0, out: 0, prev: 0,
  };
}
function makeCh() {
  return { fnum: 0, block: 0, kon: 0, fb: 0, cnt: 0, left: 1, right: 1, four: 0, fb0: 0, fb1: 0 };
}

export function installOPL(machine) {
  const regs = [new Uint8Array(256), new Uint8Array(256)];
  const ops = Array.from({ length: 36 }, makeOp);
  const chs = Array.from({ length: 18 }, makeCh);
  const opl = {
    regs, ops, chs, index: [0, 0], opl3: 0, nts: 0, amDepth: 0, vibDepth: 0, rhythm: 0, wse: 0,
    egCounter: 0, amCount: 0, vibPos: 0, noise: 1,
    t1: { preset: 0, run: false, w0: 0, c0: 0, seen: 0, masked: false, step: 80e-6 },
    t2: { preset: 0, run: false, w0: 0, c0: 0, seen: 0, masked: false, step: 320e-6 },
    status: 0,
    last: clock(machine), frac: 0, pcm: [], keyed: false,
    drain() { const out = Int16Array.from(opl.pcm); opl.pcm.length = 0; return { rate: OPL_RATE, samples: out }; },
  };

  // ---- envelope ----
  const ksrOf = (ch) => (ch.block << 1) | ((ch.fnum >> (opl.nts ? 8 : 9)) & 1);
  const rateOf = (op, r, ch) => {
    if (r === 0) return 0;
    const k = ksrOf(ch);
    return Math.min(63, r * 4 + (op.ksr ? k : k >> 2));
  };
  const egStep = (rate) => {
    if (rate < 4) return 0;
    const hi = rate >> 2, lo = rate & 3;
    if (hi < 12) {
      const shift = 12 - hi;
      if (opl.egCounter & ((1 << shift) - 1)) return 0;
      return EG_INC[lo][(opl.egCounter >> shift) & 7];
    }
    return EG_INC[lo][opl.egCounter & 7] << (hi - 12);
  };
  const envelope = (op, ch) => {
    switch (op.state) {
      case ATTACK: {
        const r = rateOf(op, op.ar, ch);
        if (r >= 60) op.env = 0;
        else { const s = egStep(r); if (s) op.env += ((~op.env) * s) >> 3; }
        if (op.env <= 0) { op.env = 0; op.state = DECAY; }
        break;
      }
      case DECAY: {
        const s = egStep(rateOf(op, op.dr, ch));
        op.env += s;
        const sl = op.sl === 15 ? 0x1f0 : op.sl << 4;
        if (op.env >= sl) { op.env = sl; op.state = SUSTAIN; }
        break;
      }
      case SUSTAIN:
        if (!op.egt) op.env += egStep(rateOf(op, op.rr, ch));
        break;
      default:
        op.env += egStep(rateOf(op, op.rr, ch));
    }
    if (op.env > 511) op.env = 511;
  };
  const keyOn = (op) => { if (!op.key) { op.key = 1; op.phase = 0; op.state = ATTACK; } };
  const keyOff = (op) => { if (op.key) { op.key = 0; op.state = RELEASE; } };

  // ---- one operator, one sample ----
  const AM_LEN = 210 * 64;                 // the tremolo triangle: 0..26 and back, 13440 samples
  const attOf = (op, ch) => {
    let ksl = (KSLROM[ch.fnum >> 6] << 2) - ((8 - ch.block) << 5);
    if (ksl < 0) ksl = 0;
    let a = op.env + (op.tl << 2) + (ksl >> KSLSHIFT[op.ksl]);
    if (op.am) {
      const tri = opl.amCount < AM_LEN / 2 ? opl.amCount : AM_LEN - opl.amCount;
      a += (tri * 26 / (AM_LEN / 2)) >> (opl.amDepth ? 0 : 2);
    }
    return a > 511 ? 511 : a;
  };
  const VIB = [0, 1, 2, 1, 0, -1, -2, -1];
  const advance = (op, ch, fnumOverride) => {
    let f = ch.fnum;
    if (op.vib) f += ((f >> 7) * VIB[opl.vibPos]) >> (opl.vibDepth ? 0 : 1);
    // 19-bit phase; F = fnum * 2^block * mult * 49716 / 2^20, so the increment is (fnum << block) * mult / 2.
    op.phase = (op.phase + ((((f << ch.block) >> 1) * MUL2[op.mult]) >> 1)) & 0x7ffff;
  };
  const opOut = (op, ch, mod) => {
    const v = wave(op.ws, (op.phase >> 9) + mod, attOf(op, ch) << 3);
    op.prev = op.out; op.out = v;
    return v;
  };
  const feedback = (op, ch) => (ch.fb ? (op.out + op.prev) >> (9 - ch.fb) : 0);

  // ---- one sample of the whole chip ----
  const sample = (outLR) => {
    let L = 0, R = 0;
    opl.egCounter++;
    if (++opl.amCount >= AM_LEN) opl.amCount = 0;
    if ((opl.egCounter & 1023) === 0) opl.vibPos = (opl.vibPos + 1) & 7;
    // the noise generator: a 23-bit LFSR
    const nbit = ((opl.noise >> 22) ^ (opl.noise >> 8)) & 1;
    opl.noise = ((opl.noise << 1) | nbit) & 0x7fffff;
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 9; c++) {
        const ch = chs[b * 9 + c];
        const o0 = ops[b * 18 + CH_OPS[c][0]], o1 = ops[b * 18 + CH_OPS[c][1]];
        envelope(o0, ch); envelope(o1, ch);
        advance(o0, ch); advance(o1, ch);
      }
    }
    const mix = (ch, v) => {
      if (opl.opl3) { if (ch.left) L += v; if (ch.right) R += v; } else { L += v; R += v; }
    };
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 9; c++) {
        const ch = chs[b * 9 + c];
        if (b === 0 && opl.rhythm && c >= 6) continue;          // drums below
        if (ch.four === 2) continue;                            // the second half of a four-op pair
        const o0 = ops[b * 18 + CH_OPS[c][0]], o1 = ops[b * 18 + CH_OPS[c][1]];
        if (ch.four === 1) {
          // Four operators: this channel (A, B) and the one three above (C, D).
          const ch2 = chs[b * 9 + c + 3];
          const o2 = ops[b * 18 + CH_OPS[c + 3][0]], o3 = ops[b * 18 + CH_OPS[c + 3][1]];
          const a = opOut(o0, ch, feedback(o0, ch));
          let v;
          switch ((ch.cnt << 1) | ch2.cnt) {
            case 0: v = opOut(o3, ch2, opOut(o2, ch2, opOut(o1, ch, a))); break;
            case 1: v = opOut(o1, ch, a) + opOut(o3, ch2, opOut(o2, ch2, 0)); break;
            case 2: v = a + opOut(o3, ch2, opOut(o2, ch2, opOut(o1, ch, 0))); break;
            default: v = a + opOut(o2, ch2, opOut(o1, ch, 0)) + opOut(o3, ch2, 0);
          }
          mix(ch, v);
          continue;
        }
        const a = opOut(o0, ch, feedback(o0, ch));
        mix(ch, ch.cnt ? a + opOut(o1, ch, 0) : opOut(o1, ch, a));
      }
    }
    if (opl.rhythm) {
      // Channel 6: the bass drum, an ordinary two-operator voice whose output counts twice.
      const c6 = chs[6], c7 = chs[7], c8 = chs[8];
      const bd0 = ops[12], bd1 = ops[15], hh = ops[13], sd = ops[16], tt = ops[14], tc = ops[17];
      const a = opOut(bd0, c6, feedback(bd0, c6));
      mix(c6, (c6.cnt ? opOut(bd1, c6, 0) : opOut(bd1, c6, a)) * 2);
      // Hi-hat, snare and cymbal take their phase from bits of the hi-hat's and cymbal's phase
      // generators and from the noise, not from their own.
      const hp = hh.phase >> 9, tp = tc.phase >> 9, n = opl.noise & 1;
      const x = (((hp >> 2) ^ (hp >> 7)) | ((hp >> 3) ^ (tp >> 5)) | ((tp >> 3) ^ (tp >> 5))) & 1;
      const hhPh = (x << 9) | ((x ^ n) ? 0xd0 : 0x34);
      const sdPh = (((hp >> 8) & 1) << 9) | ((((hp >> 8) & 1) ^ n) << 8);
      const tcPh = (x << 9) | 0x80;
      const drum = (op, ch, ph) => wave(op.ws, ph, attOf(op, ch) << 3);
      mix(c7, drum(hh, c7, hhPh) * 2 + drum(sd, c7, sdPh) * 2);
      mix(c8, opOut(tt, c8, 0) * 2 + drum(tc, c8, tcPh) * 2);
    }
    outLR[0] = L; outLR[1] = R;
  };

  // Render up to the machine's present.
  const lr = [0, 0];
  const render = () => {
    const now = clock(machine);
    let n = (now - opl.last) * OPL_RATE + opl.frac;
    opl.last = now;
    if (n <= 0) return;
    const whole = Math.floor(n);
    opl.frac = n - whole;
    // Nothing has ever played, or nobody listens (no src/audio.js: the headless tools): stay cheap.
    if (!opl.keyed || !machine.audio) { opl.egCounter += whole; return; }
    const count = Math.min(whole, OPL_RATE);                  // a second at most; a backlog is dropped
    for (let i = 0; i < count; i++) {
      sample(lr);
      opl.pcm.push(Math.max(-32768, Math.min(32767, lr[0])), Math.max(-32768, Math.min(32767, lr[1])));
    }
    if (opl.pcm.length > 1 << 21) opl.pcm.splice(0, opl.pcm.length - (1 << 21));
  };
  opl.render = render;

  // ---- registers ----
  const opReg = (b, r, v) => {
    const s = SLOT[r & 0x1f];
    if (s < 0 || (r & 0x1f) > 21) return;
    const op = ops[b * 18 + s];
    switch (r & 0xe0) {
      case 0x20: op.am = v >> 7; op.vib = (v >> 6) & 1; op.egt = (v >> 5) & 1; op.ksr = (v >> 4) & 1; op.mult = v & 15; break;
      case 0x40: op.ksl = v >> 6; op.tl = v & 63; break;
      case 0x60: op.ar = v >> 4; op.dr = v & 15; break;
      case 0x80: op.sl = v >> 4; op.rr = v & 15; break;
      case 0xe0: op.ws = opl.opl3 ? v & 7 : (opl.wse ? v & 3 : 0); break;
    }
  };
  const chKey = (b, c, on) => {
    const ch = chs[b * 9 + c];
    const both = [ops[b * 18 + CH_OPS[c][0]], ops[b * 18 + CH_OPS[c][1]]];
    if (ch.four === 1) both.push(ops[b * 18 + CH_OPS[c + 3][0]], ops[b * 18 + CH_OPS[c + 3][1]]);
    for (const op of both) on ? keyOn(op) : keyOff(op);
    if (on) opl.keyed = true;
  };
  const fourOp = () => {
    const v = opl.opl3 ? regs[1][0x04] : 0;
    for (let b = 0; b < 2; b++) for (let i = 0; i < 3; i++) {
      const on = (v >> (b * 3 + i)) & 1;
      chs[b * 9 + i].four = on ? 1 : 0; chs[b * 9 + i + 3].four = on ? 2 : 0;
    }
  };
  const write = (b, r, v) => {
    render();
    v &= 0xff; r &= 0xff;
    regs[b][r] = v;
    if (b === 1 && r === 0x05) { opl.opl3 = v & 1; fourOp(); return; }
    if (b === 1 && r === 0x04) { fourOp(); return; }
    if (b === 0) {
      if (r === 0x01) { opl.wse = (v >> 5) & 1; return; }
      if (r === 0x02) { opl.t1.preset = v; return; }
      if (r === 0x03) { opl.t2.preset = v; return; }
      if (r === 0x04) {
        if (v & 0x80) {                                        // reset the flags: they come back at the NEXT overflow
          opl.status = 0;
          for (const tm of [opl.t1, opl.t2]) tm.seen = overflows(tm);
          return;
        }
        opl.t1.masked = !!(v & 0x40); opl.t2.masked = !!(v & 0x20);
        for (const [tm, on] of [[opl.t1, v & 1], [opl.t2, v & 2]]) {
          if (on && !tm.run) { tm.w0 = clock(machine); tm.c0 = machine.cpu.cycles; tm.seen = 0; }
          tm.run = !!on;
        }
        return;
      }
      if (r === 0x08) { opl.nts = (v >> 6) & 1; return; }
      if (r === 0xbd) {
        opl.amDepth = v >> 7; opl.vibDepth = (v >> 6) & 1;
        const was = opl.rhythm; opl.rhythm = (v >> 5) & 1;
        if (opl.rhythm) {
          const k = (bit, op) => ((v >> bit) & 1 ? keyOn(op) : keyOff(op));
          k(4, ops[12]); k(4, ops[15]); k(3, ops[16]); k(2, ops[14]); k(1, ops[17]); k(0, ops[13]);
          if (v & 0x1f) opl.keyed = true;
        } else if (was) for (const i of [12, 13, 14, 15, 16, 17]) keyOff(ops[i]);
        return;
      }
    }
    if (r >= 0x20 && r < 0xa0) { opReg(b, r, v); return; }
    if (r >= 0xe0 && r <= 0xf5) { opReg(b, r, v); return; }
    const c = r & 0x0f;
    if (c > 8) return;
    const ch = chs[b * 9 + c];
    if ((r & 0xf0) === 0xa0) { ch.fnum = (ch.fnum & 0x300) | v; return; }
    if ((r & 0xf0) === 0xb0) {
      ch.fnum = (ch.fnum & 0xff) | ((v & 3) << 8); ch.block = (v >> 2) & 7;
      const on = (v >> 5) & 1;
      if (on !== ch.kon) { ch.kon = on; chKey(b, c, on); }
      return;
    }
    if ((r & 0xf0) === 0xc0) {
      ch.fb = (v >> 1) & 7; ch.cnt = v & 1;
      ch.left = opl.opl3 ? (v >> 4) & 1 : 1; ch.right = opl.opl3 ? (v >> 5) & 1 : 1;
    }
  };
  opl.write = write;

  // ---- status and timers: timer 1 counts 80 us steps, timer 2 320 us, from the preset to 256 ----
  // A detection routine waits its 80 us by reading the status port a hundred times, counting on an
  // ISA bus's microsecond per access. The browser's clock is wall time and MIRAGE does those reads in
  // a microsecond altogether, so the timers run on whichever has moved further: wall time, or the
  // instructions executed at the PIT's rate (a 386's worth a second). Headless the two are the same.
  const cps = () => 18.2065 * (machine.pitBase || 0x10000);
  // How many times the timer has overflowed since it was started.
  function overflows(tm) {
    if (!tm.run) return tm.seen || 0;
    const dt = Math.max(clock(machine) - tm.w0, (machine.cpu.cycles - tm.c0) / cps());
    return Math.floor(dt / ((256 - tm.preset) * tm.step));
  }
  const readStatus = () => {
    for (const [tm, bit] of [[opl.t1, 0x40], [opl.t2, 0x20]]) {
      if (tm.run && !tm.masked && overflows(tm) > tm.seen) opl.status |= bit;
    }
    return opl.status & 0x60 ? opl.status | 0x80 : 0;
  };

  for (const [base, bank] of [[0x388, 0], [0x38a, 1], [0x220, 0], [0x222, 1], [0x228, 0]]) {
    machine.onPortWrite(base, (p, s, v) => { opl.index[bank] = v & 0xff; });
    machine.onPortWrite(base + 1, (p, s, v) => { write(bank, opl.index[bank], v); });
    machine.onPortRead(base, () => readStatus());
    machine.onPortRead(base + 1, () => 0xff);
  }
  machine.opl = opl;
  return opl;
}
