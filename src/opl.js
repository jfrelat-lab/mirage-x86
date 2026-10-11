// opl.js — the Yamaha YMF262 (OPL3), which also plays everything written for the YM3812 (OPL2, the
// AdLib): the FM music of most DOS games. MIT, written for MIRAGE.
//
// The model is the chip's own, as the die analyses describe it (the OPL2 and OPL3 decaps, whose
// published ROM contents and timings Nuked-OPL3 encodes): every one of the 36 operators runs, in
// order, a feedback stage, an envelope generator, a phase generator and a log-sine/exponential
// lookup — the chip has no multiplier: a sine is read as an attenuation, attenuations add, and one
// exponential turns the sum back into an amplitude. Two operators make a channel, in series (FM) or
// in parallel; on the OPL3 two channels can join into four operators; rhythm mode turns the last
// three channels into five drums fed by a noise generator.
//
// Checked sample for sample against Nuked-OPL3 run as an outside reference (tools/opl-compare.mjs;
// Nuked is LGPL and not part of MIRAGE). Order matters everywhere and follows the chip: an operator
// outputs with its envelope and phase as they were BEFORE this sample's update; a modulator's
// output is the one it produced earlier in the same sample; the left and right mixes are taken
// part-way through the operators, as the chip interleaves them (see sample()).
//
// Output is generated lazily: every register write first renders the samples up to that moment on
// the machine's clock (src/audio.js clock()), so a note starts when the program wrote it.
// src/audio.js drains the samples (opl.drain()) and resamples them.
//
// The ports: 388h-38Bh (AdLib, and the OPL3's second bank at 38Ah) and the Sound Blaster's 220h-223h
// and 228h-229h. The status byte (tools/oplprobe.asm, DOSBox-X and QEMU): bit 7 IRQ, bit 6 timer 1
// expired, bit 5 timer 2 expired, and 0 in the low bits — an OPL3; an OPL2 would read 06h there.

import { clock } from './audio.js';

export const OPL_RATE = 49716;

// ---- the chip's ROMs, computed ----
// Quarter log-sine: -log2(sin) in 1/256 units. Exponential: 2^(x/256) as 10 bits plus the implied 1.
const LOGSIN = new Uint16Array(256), EXPROM = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin((i + 0.5) * Math.PI / 512)) * 256);
  EXPROM[i] = Math.round((Math.pow(2, (255 - i) / 256) - 1) * 1024) | 0x400;
}
const MUL2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];   // frequency multiplier, doubled
const KSLROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSLSHIFT = [8, 1, 2, 0];
// Rates 48 and up: how many extra steps each quarter of the envelope clock adds.
const EG_STEP = [[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0]];
// Register offset (0..31) -> operator in the bank, or -1.
const SLOT = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
const CH_SLOT = [0, 1, 2, 6, 7, 8, 12, 13, 14];          // a channel's first operator; the second is 3 above
const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3;
const ZERO = -1, FB = -2;                                 // modulation sources besides another operator
const T2OP = 0, T4OP = 1, T4OP2 = 2, TDRUM = 3;

/** exp(-level): a 13-bit amplitude from a 4.8 attenuation. */
const expLevel = (l) => { if (l > 0x1fff) l = 0x1fff; return (EXPROM[l & 0xff] << 1) >> (l >> 8); };

/** The eight waveforms: (phase, envelope) -> signed amplitude. A negative half is the amplitude's
 *  ones' complement, -v-1: a silent operator still contributes -1 there. */
function waveLog(wf, ph) {
  let l, neg = false;
  switch (wf) {
    case 0: neg = !!(ph & 0x200); l = LOGSIN[(ph & 0x100) ? (ph & 0xff) ^ 0xff : ph & 0xff]; break;
    case 1: l = (ph & 0x200) ? 0x1000 : LOGSIN[(ph & 0x100) ? (ph & 0xff) ^ 0xff : ph & 0xff]; break;
    case 2: l = LOGSIN[(ph & 0x100) ? (ph & 0xff) ^ 0xff : ph & 0xff]; break;
    case 3: l = (ph & 0x100) ? 0x1000 : LOGSIN[ph & 0xff]; break;
    case 4: neg = (ph & 0x300) === 0x100;
      l = (ph & 0x200) ? 0x1000 : LOGSIN[(ph & 0x80) ? ((ph ^ 0xff) << 1) & 0xff : (ph << 1) & 0xff]; break;
    case 5: l = (ph & 0x200) ? 0x1000 : LOGSIN[(ph & 0x80) ? ((ph ^ 0xff) << 1) & 0xff : (ph << 1) & 0xff]; break;
    case 6: neg = !!(ph & 0x200); l = 0; break;
    default: if (ph & 0x200) { neg = true; ph = (ph & 0x1ff) ^ 0x1ff; } l = ph << 3;
  }
  return neg ? l | 0x10000 : l;
}
// The same, as one table: waveform * 1024 + phase -> attenuation, and bit 16 for a negative half.
const WAVE = new Int32Array(8 * 1024);
for (let wf = 0; wf < 8; wf++) for (let ph = 0; ph < 1024; ph++) WAVE[wf * 1024 + ph] = waveLog(wf, ph);
const wave = (wf, ph, env) => {
  const w = WAVE[(wf << 10) | (ph & 0x3ff)];
  const v = expLevel((w & 0xffff) + (env << 3));
  return w & 0x10000 ? ~v : v;
};

function makeSlot(i) {
  return {
    i, mult: 0, ksr: 0, egt: 0, vib: 0, am: 0, ksl: 0, tl: 0, ar: 0, dr: 0, sl: 0, rr: 0, wf: 0,
    key: 0, egRout: 0x1ff, egOut: 0x1ff, egGen: RELEASE, egKsl: 0, egBase: 0, ch: null,
    phase: 0, phaseOut: 0, pgReset: 0, out: 0, prout: 0, fbmod: 0, mod: ZERO,
  };
}

/** The synthesis core: registers in, samples out, no clock and no ports. */
export function createOPL() {
  const slots = Array.from({ length: 36 }, (_, i) => makeSlot(i));
  const chans = Array.from({ length: 18 }, (_, c) => {
    const bank = c >= 9 ? 1 : 0, s0 = bank * 18 + CH_SLOT[c % 9];
    return { c, s0, s1: s0 + 3, fnumReg: 0, blockReg: 0, fnum: 0, block: 0, ksv: 0, fb: 0, con: 0,
      cha: -1, chb: -1, type: T2OP, outs: [], pair: null };
  });
  for (const [a, b] of [[0, 3], [1, 4], [2, 5], [9, 12], [10, 13], [11, 14]]) { chans[a].pair = chans[b]; chans[b].pair = chans[a]; }
  const slotCh = new Int8Array(36);
  for (const ch of chans) { slotCh[ch.s0] = ch.c; slotCh[ch.s1] = ch.c; slots[ch.s0].ch = ch; slots[ch.s1].ch = ch; }
  const chip = {
    slots, chans, newm: 0, nts: 0, rhy: 0, timer: 0, egTimer: 0, egTimerRem: 0, egState: 0, egAdd: 0, egTimerLo: 0,
    tremoloPos: 0, tremolo: 0, tremoloShift: 4, vibPos: 0, vibShift: 1, noise: 1,
    rmHh2: 0, rmHh3: 0, rmHh7: 0, rmHh8: 0, rmTc3: 0, rmTc5: 0, mixR: 0, keyed: false,
  };

  // ---- routing: what modulates each operator, and what each channel outputs ----
  const route = (ch) => {
    const S = (k) => slots[k];
    if (ch.type === TDRUM) {
      if (ch.c === 7 || ch.c === 8) { S(ch.s0).mod = ZERO; S(ch.s1).mod = ZERO; ch.outs = [ch.s0, ch.s0, ch.s1, ch.s1]; return; }
      S(ch.s0).mod = FB; S(ch.s1).mod = ch.con ? ZERO : ch.s0; ch.outs = [ch.s1, ch.s1]; return;
    }
    if (ch.type === T4OP || ch.type === T4OP2) {
      const F = ch.type === T4OP ? ch : ch.pair, X = F.pair;
      F.outs = [];
      S(F.s0).mod = FB;
      switch ((F.con << 1) | X.con) {
        case 0: S(F.s1).mod = F.s0; S(X.s0).mod = F.s1; S(X.s1).mod = X.s0; X.outs = [X.s1]; break;
        case 1: S(F.s1).mod = F.s0; S(X.s0).mod = ZERO; S(X.s1).mod = X.s0; X.outs = [F.s1, X.s1]; break;
        case 2: S(F.s1).mod = ZERO; S(X.s0).mod = F.s1; S(X.s1).mod = X.s0; X.outs = [F.s0, X.s1]; break;
        default: S(F.s1).mod = ZERO; S(X.s0).mod = F.s1; S(X.s1).mod = ZERO; X.outs = [F.s0, X.s0, X.s1];
      }
      return;
    }
    S(ch.s0).mod = FB;
    if (ch.con) { S(ch.s1).mod = ZERO; ch.outs = [ch.s0, ch.s1]; } else { S(ch.s1).mod = ch.s0; ch.outs = [ch.s1]; }
  };

  // ---- frequency, key scale ----
  // egBase: the attenuation that only moves with a register write (total level and key scale level).
  const updateKsl = (s, ch) => {
    const k = (KSLROM[ch.fnum >> 6] << 2) - ((8 - ch.block) << 5);
    s.egKsl = k < 0 ? 0 : k;
    s.egBase = (s.tl << 2) + (s.egKsl >> KSLSHIFT[s.ksl]);
  };
  const setFreq = (ch, fnum, block) => {
    ch.fnum = fnum; ch.block = block;
    ch.ksv = (block << 1) | ((fnum >> (9 - chip.nts)) & 1);
    updateKsl(slots[ch.s0], ch); updateKsl(slots[ch.s1], ch);
  };
  const restoreFreq = (ch) => {
    setFreq(ch, ch.fnumReg, ch.blockReg);
    if (ch.type === T4OP) setFreq(ch.pair, ch.fnum, ch.block);   // the pair plays at the first channel's pitch
  };

  // ---- keys ----
  const keyOn = (s, bit) => { s.key |= bit; chip.keyed = true; };
  const keyOff = (s, bit) => { s.key &= ~bit; };
  const chKey = (ch, on) => {
    const list = ch.type === T4OP ? [ch.s0, ch.s1, ch.pair.s0, ch.pair.s1]
      : (ch.type === T2OP || ch.type === TDRUM) ? [ch.s0, ch.s1] : [];
    for (const k of list) on ? keyOn(slots[k], 1) : keyOff(slots[k], 1);
  };

  const setRhythm = (v) => {
    chip.rhy = v & 0x3f;
    const [c6, c7, c8] = [chans[6], chans[7], chans[8]];
    if (chip.rhy & 0x20) {
      for (const ch of [c6, c7, c8]) { ch.type = TDRUM; route(ch); }
      const k = (bit, s) => ((v >> bit) & 1 ? keyOn(slots[s], 2) : keyOff(slots[s], 2));
      k(0, c7.s0); k(1, c8.s1); k(2, c8.s0); k(3, c7.s1); k(4, c6.s0); k(4, c6.s1);
    } else {
      for (const ch of [c6, c7, c8]) { ch.type = T2OP; route(ch); keyOff(slots[ch.s0], 2); keyOff(slots[ch.s1], 2); }
    }
  };
  const set4op = (v) => {
    for (let bit = 0; bit < 6; bit++) {
      const F = chans[bit < 3 ? bit : bit + 6], X = F.pair;
      if ((v >> bit) & 1) { F.type = T4OP; X.type = T4OP2; restoreFreq(F); route(F); }
      else { F.type = T2OP; X.type = T2OP; restoreFreq(X); route(F); route(X); }
    }
  };

  // ---- registers ----
  const write = (bank, r, v) => {
    r &= 0xff; v &= 0xff;
    const hi = r & 0xf0;
    if (hi === 0x00) {
      if (bank && r === 0x04) set4op(v);
      else if (bank && r === 0x05) chip.newm = v & 1;
      else if (!bank && r === 0x08) chip.nts = (v >> 6) & 1;
      return;
    }
    if (hi >= 0x20 && hi <= 0x90 || hi >= 0xe0) {
      const k = SLOT[r & 0x1f];
      if (k < 0) return;
      const s = slots[bank * 18 + k];
      switch (hi) {
        case 0x20: case 0x30: s.am = v >> 7; s.vib = (v >> 6) & 1; s.egt = (v >> 5) & 1; s.ksr = (v >> 4) & 1; s.mult = v & 15; break;
        case 0x40: case 0x50: s.ksl = v >> 6; s.tl = v & 63; updateKsl(s, chans[slotCh[s.i]]); break;
        case 0x60: case 0x70: s.ar = v >> 4; s.dr = v & 15; break;
        case 0x80: case 0x90: s.sl = (v >> 4) === 15 ? 0x1f : v >> 4; s.rr = v & 15; break;
        default: s.wf = chip.newm ? v & 7 : v & 3;
      }
      return;
    }
    if (hi === 0xb0 && r === 0xbd && !bank) {
      chip.tremoloShift = ((((v >> 7) & 1) ^ 1) << 1) + 2;
      chip.vibShift = ((v >> 6) & 1) ^ 1;
      setRhythm(v);
      return;
    }
    if ((r & 0x0f) > 8) return;
    const ch = chans[bank * 9 + (r & 0x0f)];
    if (hi === 0xa0) { ch.fnumReg = (ch.fnumReg & 0x300) | v; if (ch.type !== T4OP2) restoreFreq(ch); return; }
    if (hi === 0xb0) {
      ch.fnumReg = (ch.fnumReg & 0xff) | ((v & 3) << 8); ch.blockReg = (v >> 2) & 7;
      if (ch.type !== T4OP2) restoreFreq(ch);
      chKey(ch, (v >> 5) & 1);
      return;
    }
    if (hi === 0xc0) {
      ch.fb = (v >> 1) & 7; ch.con = v & 1;
      route(ch);
      if (chip.newm) { ch.cha = (v >> 4) & 1 ? -1 : 0; ch.chb = (v >> 5) & 1 ? -1 : 0; } else { ch.cha = ch.chb = -1; }
    }
  };

  // ---- one operator ----
  const envelope = (s, ch) => {
    s.egOut = s.egRout + s.egBase + (s.am ? chip.tremolo : 0);
    // Released and fully off (most of the 36 operators, most of the time): nothing below would move.
    if (s.egRout === 0x1ff && !s.key && s.egGen === RELEASE) { s.pgReset = 0; return; }
    let rr = 0, reset = 0;
    if (s.key && s.egGen === RELEASE) { reset = 1; rr = s.ar; }
    else if (s.egGen === ATTACK) rr = s.ar;
    else if (s.egGen === DECAY) rr = s.dr;
    else if (s.egGen === SUSTAIN) rr = s.egt ? 0 : s.rr;
    else rr = s.rr;
    s.pgReset = reset;
    const ks = ch.ksv >> ((s.ksr ^ 1) << 1);
    const rate = ks + (rr << 2);
    let hi = rate >> 2;
    const lo = rate & 3;
    if (hi & 0x10) hi = 15;
    let shift = 0;
    if (rr) {
      if (hi < 12) {
        if (chip.egState) {
          const e = hi + chip.egAdd;
          shift = e === 12 ? 1 : e === 13 ? (lo >> 1) & 1 : e === 14 ? lo & 1 : 0;
        }
      } else {
        shift = (hi & 3) + EG_STEP[lo][chip.egTimerLo];
        if (shift & 4) shift = 3;
        if (!shift) shift = chip.egState;
      }
    }
    let rout = s.egRout, inc = 0;
    if (reset && hi === 15) rout = 0;                       // instant attack
    const off = (s.egRout & 0x1f8) === 0x1f8;
    if (s.egGen !== ATTACK && !reset && off) rout = 0x1ff;
    switch (s.egGen) {
      case ATTACK:
        if (!s.egRout) s.egGen = DECAY;
        else if (s.key && shift > 0 && hi !== 15) inc = (~s.egRout) >> (4 - shift);
        break;
      case DECAY:
        if ((s.egRout >> 4) === s.sl) s.egGen = SUSTAIN;
        else if (!off && !reset && shift > 0) inc = 1 << (shift - 1);
        break;
      default:
        if (!off && !reset && shift > 0) inc = 1 << (shift - 1);
    }
    s.egRout = (rout + inc) & 0x1ff;
    if (reset) s.egGen = ATTACK;
    if (!s.key) s.egGen = RELEASE;
  };
  const phaseGen = (s, ch) => {
    let f = ch.fnum;
    if (s.vib) {
      let range = (f >> 7) & 7;
      const vp = chip.vibPos;
      if (!(vp & 3)) range = 0; else if (vp & 1) range >>= 1;
      range >>= chip.vibShift;
      if (vp & 4) range = -range;
      f += range;
    }
    const base = (f << ch.block) >> 1;
    const phase = (s.phase >>> 9) & 0xffff;
    if (s.pgReset) s.phase = 0;
    // The chip's accumulator has 32 bits but only bits 9-24 are ever read: keeping 25 keeps it a small
    // integer for V8 (past 2^30 it becomes a boxed number, and the whole synthesis runs four times slower).
    s.phase = (s.phase + ((base * MUL2[s.mult]) >> 1)) & 0x1ffffff;
    s.phaseOut = phase;
  };
  // Operators 13, 16 and 17 (hi-hat, snare, top cymbal): rhythm mode builds their phase from bits of
  // 13's and 17's and from the noise generator as it stands at that operator.
  const rhythmPhase = (s, noise) => {
    const phase = s.phaseOut;
    if (s.i === 13) { chip.rmHh2 = (phase >> 2) & 1; chip.rmHh3 = (phase >> 3) & 1; chip.rmHh7 = (phase >> 7) & 1; chip.rmHh8 = (phase >> 8) & 1; }
    if (s.i === 17 && (chip.rhy & 0x20)) { chip.rmTc3 = (phase >> 3) & 1; chip.rmTc5 = (phase >> 5) & 1; }
    if (chip.rhy & 0x20) {
      const x = (chip.rmHh2 ^ chip.rmHh7) | (chip.rmHh3 ^ chip.rmTc5) | (chip.rmTc3 ^ chip.rmTc5);
      if (s.i === 13) s.phaseOut = (x << 9) | ((x ^ (noise & 1)) ? 0xd0 : 0x34);
      else if (s.i === 16) s.phaseOut = (chip.rmHh8 << 9) | ((chip.rmHh8 ^ (noise & 1)) << 8);
      else if (s.i === 17) s.phaseOut = (x << 9) | 0x80;
    }
  };

  // ---- one sample: [left, right] ----
  const clip = (x) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);
  const run = (from, to) => {
    let noise = chip.noise;
    for (let k = from; k < to; k++) {
      const s = slots[k], ch = s.ch;
      if (ch.fb) s.fbmod = (s.prout + s.out) >> (9 - ch.fb); else s.fbmod = 0;
      s.prout = s.out;
      envelope(s, ch);
      phaseGen(s, ch);
      if (k === 13 || k === 16 || k === 17) rhythmPhase(s, noise);
      noise = (noise >>> 1) | ((((noise >>> 14) ^ noise) & 1) << 22);   // one step per operator
      const m = s.mod === ZERO ? 0 : s.mod === FB ? s.fbmod : slots[s.mod].out;
      s.out = wave(s.wf, s.phaseOut + m, s.egOut);
    }
    chip.noise = noise;
  };
  const mix = (left) => {
    let sum = 0;
    for (let c = 0; c < 18; c++) {
      const ch = chans[c], outs = ch.outs;
      let acc = 0;
      for (let j = 0; j < outs.length; j++) acc += slots[outs[j]].out;
      sum += acc & (left ? ch.cha : ch.chb);
    }
    return sum;
  };
  // The chip interleaves its outputs with the operator updates, which is why channels 6-8 of each
  // bank reach the left output one sample later than the right ("channel sample delay"): the left
  // mix is taken after operators 0-14, the right one after 18-32, and is output a sample later.
  const sample = (out) => {
    out[1] = clip(chip.mixR);
    run(0, 15);
    const L = mix(true);
    run(15, 18);
    out[0] = clip(L);
    run(18, 33);
    chip.mixR = mix(false);
    run(33, 36);
    if ((chip.timer & 0x3f) === 0x3f) chip.tremoloPos = (chip.tremoloPos + 1) % 210;
    chip.tremolo = (chip.tremoloPos < 105 ? chip.tremoloPos : 210 - chip.tremoloPos) >> chip.tremoloShift;
    if ((chip.timer & 0x3ff) === 0x3ff) chip.vibPos = (chip.vibPos + 1) & 7;
    chip.timer++;
    if (chip.egState) {
      // The envelope clock's rate: one more than the number of trailing zeros of its low 13 bits.
      const t = chip.egTimer & 8191;
      chip.egAdd = t ? 32 - Math.clz32(t & -t) : 0;
      chip.egTimerLo = t & 3;
    }
    if (chip.egTimerRem || chip.egState) {
      if (chip.egTimer === 0xfffffffff) { chip.egTimer = 0; chip.egTimerRem = 1; } else { chip.egTimer++; chip.egTimerRem = 0; }
    }
    chip.egState ^= 1;
  };
  chip.write = write;
  chip.sample = sample;
  // Every channel starts as a two-operator voice with its outputs routed.
  for (const ch of chans) route(ch);
  return chip;
}

export function installOPL(machine) {
  const core = createOPL();
  const opl = {
    core, index: [0, 0],
    t1: { preset: 0, run: false, w0: 0, c0: 0, seen: 0, masked: false, step: 80e-6 },
    t2: { preset: 0, run: false, w0: 0, c0: 0, seen: 0, masked: false, step: 320e-6 },
    status: 0,
    last: clock(machine), frac: 0, pcm: [],
    drain() { const out = Int16Array.from(opl.pcm); opl.pcm.length = 0; return { rate: OPL_RATE, samples: out }; },
  };

  // Exactly `count` samples into opl.pcm, whatever the clock says: what tools/opl-compare.mjs drives,
  // writing registers at the same sample positions as the reference it is compared with.
  const lr = [0, 0];
  const gen = (count) => { for (let i = 0; i < count; i++) { core.sample(lr); opl.pcm.push(lr[0], lr[1]); } };
  // Render up to the machine's present.
  const render = () => {
    const now = clock(machine);
    const n = (now - opl.last) * OPL_RATE + opl.frac;
    opl.last = now;
    if (n <= 0) return;
    const whole = Math.floor(n);
    opl.frac = n - whole;
    // Nothing has ever played, or nobody listens (no src/audio.js: the headless tools): stay cheap.
    // The envelope and LFO clocks then stand still, which only matters to a listener.
    if (!core.keyed || !machine.audio) return;
    gen(Math.min(whole, OPL_RATE));                           // a second at most; a backlog is dropped
    if (opl.pcm.length > 1 << 21) opl.pcm.splice(0, opl.pcm.length - (1 << 21));
  };
  opl.render = render;
  opl.gen = gen;

  // ---- status and timers: timer 1 counts 80 us steps, timer 2 320 us, from the preset to 256 ----
  // A detection routine waits its 80 us by reading the status port a hundred times, counting on an
  // ISA bus's microsecond per access. The browser's clock is wall time and MIRAGE does those reads in
  // a microsecond altogether, so the timers run on whichever has moved further: wall time, or the
  // instructions executed at the PIT's rate (a 386's worth a second). Headless the two are the same.
  const cps = () => 18.2065 * (machine.pitBase || 0x10000);
  function overflows(tm) {
    if (!tm.run) return tm.seen || 0;
    const dt = Math.max(clock(machine) - tm.w0, (machine.cpu.cycles - tm.c0) / cps());
    return Math.floor(dt / ((256 - tm.preset) * tm.step));
  }
  const timerWrite = (r, v) => {
    if (r === 0x02) { opl.t1.preset = v; return; }
    if (r === 0x03) { opl.t2.preset = v; return; }
    if (v & 0x80) {                                           // reset the flags: they come back at the NEXT overflow
      opl.status = 0;
      for (const tm of [opl.t1, opl.t2]) tm.seen = overflows(tm);
      return;
    }
    opl.t1.masked = !!(v & 0x40); opl.t2.masked = !!(v & 0x20);
    for (const [tm, on] of [[opl.t1, v & 1], [opl.t2, v & 2]]) {
      if (on && !tm.run) { tm.w0 = clock(machine); tm.c0 = machine.cpu.cycles; tm.seen = 0; }
      tm.run = !!on;
    }
  };
  const readStatus = () => {
    for (const [tm, bit] of [[opl.t1, 0x40], [opl.t2, 0x20]]) {
      if (tm.run && !tm.masked && overflows(tm) > tm.seen) opl.status |= bit;
    }
    return opl.status & 0x60 ? opl.status | 0x80 : 0;
  };
  const write = (bank, r, v) => {
    render();
    if (!bank && r >= 0x02 && r <= 0x04) { timerWrite(r, v & 0xff); return; }
    core.write(bank, r, v);
  };
  opl.write = write;

  for (const [base, bank] of [[0x388, 0], [0x38a, 1], [0x220, 0], [0x222, 1], [0x228, 0]]) {
    machine.onPortWrite(base, (p, s, v) => { opl.index[bank] = v & 0xff; });
    machine.onPortWrite(base + 1, (p, s, v) => { write(bank, opl.index[bank], v); });
    machine.onPortRead(base, () => readStatus());
    machine.onPortRead(base + 1, () => 0xff);
  }
  machine.opl = opl;
  return opl;
}
