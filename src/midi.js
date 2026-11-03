// midi.js — General MIDI for MIRAGE: a small synthesizer of its own, and the doors programs reach it by.
//
// No sound set is shipped: a period PC played General MIDI through a wavetable card or Windows'
// Microsoft GS Wavetable Synth (Roland's samples, not ours to give). Each of the 16 GM families gets a
// voice made here instead — an oscillator, a filter and an envelope — and channel 10 its drums made of
// noise and swept sines. It is a sketch of the arrangement, not of Roland's timbres: notes, rhythm,
// chords, program changes, volumes, pan, pitch bend and the sustain pedal are the program's own.
//
// Doors: an MPU-401 at 330h/331h in UART mode (DOS: Difúze, 2010), and winmm's midiOut* (MIRAGE-WIN32:
// Photon Race 2, 2008). Bytes go through one parser with running status. Like the OPL (src/opl.js) the
// synthesizer renders up to the machine's clock (src/audio.js clock()) before each event, so a note
// starts when the program sent it; src/audio.js drains it as one more source.
import { clock } from './audio.js';

export const MIDI_RATE = 32000;
const MAX_VOICES = 32;

// Per family (program >> 3): wave, attack, decay (to `sustain`), sustain level, release, filter.
// A sustain of 0 is an instrument that dies away by itself (a piano, a pluck), which is what a program
// that never sends note off (Difúze) counts on.
const FAMILIES = [
  { wave: 'piano', a: 0.003, d: 1.6, s: 0, r: 0.25, lp: 0.35 },    // piano
  { wave: 'bell', a: 0.002, d: 1.2, s: 0, r: 0.4, lp: 0.6 },       // chromatic percussion
  { wave: 'organ', a: 0.01, d: 0.1, s: 0.85, r: 0.08, lp: 0.5 },   // organ
  { wave: 'saw', a: 0.002, d: 1.1, s: 0, r: 0.2, lp: 0.18 },       // guitar
  { wave: 'saw', a: 0.004, d: 1.4, s: 0, r: 0.15, lp: 0.08 },      // bass
  { wave: 'saw', a: 0.12, d: 0.3, s: 0.8, r: 0.35, lp: 0.2 },      // strings
  { wave: 'saw', a: 0.18, d: 0.3, s: 0.8, r: 0.45, lp: 0.16 },     // ensemble
  { wave: 'saw', a: 0.04, d: 0.2, s: 0.75, r: 0.15, lp: 0.3 },     // brass
  { wave: 'square', a: 0.03, d: 0.2, s: 0.7, r: 0.12, lp: 0.25 },  // reed
  { wave: 'pipe', a: 0.05, d: 0.2, s: 0.8, r: 0.15, lp: 0.4 },     // pipe
  { wave: 'saw', a: 0.005, d: 0.2, s: 0.8, r: 0.12, lp: 0.45 },    // synth lead
  { wave: 'pad', a: 0.35, d: 0.5, s: 0.8, r: 0.8, lp: 0.12 },      // synth pad
  { wave: 'tri', a: 0.2, d: 0.6, s: 0.6, r: 0.6, lp: 0.3 },        // synth effects
  { wave: 'saw', a: 0.002, d: 0.9, s: 0, r: 0.2, lp: 0.2 },        // ethnic
  { wave: 'sine', a: 0.001, d: 0.45, s: 0, r: 0.1, lp: 0.5 },      // percussive
  { wave: 'noise', a: 0.01, d: 0.4, s: 0.3, r: 0.2, lp: 0.3 },     // sound effects
];

/** Channel 10's kit: by GM note, a sweep (Hz from, Hz to), noise share, length (s), filter. */
function drum(note) {
  if (note === 35 || note === 36) return { f0: 150, f1: 45, noise: 0, len: 0.35, lp: 0.2, amp: 1.2 };       // bass drums
  if (note === 38 || note === 40) return { f0: 220, f1: 160, noise: 0.7, len: 0.2, lp: 0.6, amp: 0.8 };     // snares
  if (note === 39) return { f0: 0, f1: 0, noise: 1, len: 0.12, lp: 0.7, amp: 0.6 };                          // clap
  if (note === 42 || note === 44) return { f0: 0, f1: 0, noise: 1, len: 0.05, lp: 1, hp: true, amp: 0.4 };  // closed hi-hats
  if (note === 46) return { f0: 0, f1: 0, noise: 1, len: 0.3, lp: 1, hp: true, amp: 0.35 };                  // open hi-hat
  if (note === 49 || note === 52 || note === 55 || note === 57) return { f0: 0, f1: 0, noise: 1, len: 1.2, lp: 1, hp: true, amp: 0.35 };   // cymbals
  if (note === 51 || note === 53 || note === 59) return { f0: 0, f1: 0, noise: 1, len: 0.5, lp: 0.9, hp: true, amp: 0.25 };               // rides
  if (note >= 41 && note <= 50) { const f = 80 + (note - 41) * 18; return { f0: f * 1.6, f1: f, noise: 0.1, len: 0.3, lp: 0.3, amp: 0.8 }; }   // toms
  return { f0: 400 + (note & 15) * 60, f1: 300, noise: 0.5, len: 0.08, lp: 0.6, amp: 0.4 };                  // the rest: a short knock
}

export function createSynth(rate = MIDI_RATE) {
  const chans = Array.from({ length: 16 }, () => ({ prog: 0, vol: 100 / 127, expr: 1, pan: 0.5, bend: 0, bendRange: 2, sustain: false, rpn: 0x7f7f }));
  const voices = [];
  let seed = 22222, age = 0;
  const noise = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 8388608 - 1; };
  const hz = (note, ch) => 440 * Math.pow(2, (note - 69 + ch.bend * ch.bendRange) / 12);

  const noteOff = (c, note) => {
    for (const v of voices) if (v.ch === c && v.note === note && !v.released) {
      if (chans[c].sustain) v.held = true; else v.released = true;
    }
  };
  const noteOn = (c, note, vel) => {
    if (!vel) { noteOff(c, note); return; }
    for (const v of voices) if (v.ch === c && v.note === note && !v.released) v.released = true;   // a retrigger
    if (voices.length >= MAX_VOICES) {                                   // steal the quietest, else the oldest
      let k = 0;
      for (let i = 1; i < voices.length; i++) if (voices[i].released > voices[k].released || voices[i].age < voices[k].age) k = i;
      voices.splice(k, 1);
    }
    const ch = chans[c], amp = (vel / 127) ** 1.5;
    if (c === 9) { voices.push({ ch: c, note, drum: drum(note), t: 0, amp, phase: 0, y: 0, x1: 0, age: age++, released: false }); return; }
    const fam = FAMILIES[ch.prog >> 3];
    voices.push({ ch: c, note, fam, t: 0, amp, phase: 0, phase2: 0, y: 0, x1: 0, env: 0, relLevel: 0, age: age++, released: false, held: false, relT: 0 });
  };
  const control = (c, n, v) => {
    const ch = chans[c];
    if (n === 7) ch.vol = v / 127;
    else if (n === 11) ch.expr = v / 127;
    else if (n === 10) ch.pan = v / 127;
    else if (n === 64) { ch.sustain = v >= 64; if (!ch.sustain) for (const x of voices) if (x.ch === c && x.held) { x.held = false; x.released = true; } }
    else if (n === 101) ch.rpn = (ch.rpn & 0x7f) | (v << 7);
    else if (n === 100) ch.rpn = (ch.rpn & 0x3f80) | v;
    else if (n === 6 && ch.rpn === 0) ch.bendRange = v;                 // RPN 0: the pitch bend range
    else if (n === 120 || n === 123) { for (const x of voices) if (x.ch === c) { if (n === 120) x.dead = true; else x.released = true; } }
    else if (n === 121) Object.assign(ch, { vol: 100 / 127, expr: 1, pan: 0.5, bend: 0, sustain: false });
  };
  const message = (st, d1, d2) => {
    const c = st & 15;
    switch (st & 0xf0) {
      case 0x80: noteOff(c, d1); break;
      case 0x90: noteOn(c, d1, d2); break;
      case 0xb0: control(c, d1, d2); break;
      case 0xc0: chans[c].prog = d1; break;
      case 0xe0: chans[c].bend = ((d2 << 7 | d1) - 8192) / 8192; break;
    }
  };
  const reset = () => { voices.length = 0; for (const ch of chans) Object.assign(ch, { prog: 0, vol: 100 / 127, expr: 1, pan: 0.5, bend: 0, bendRange: 2, sustain: false }); };

  // One stereo sample of every voice, into lr.
  const dt = 1 / rate;
  const sample = (lr) => {
    let l = 0, r = 0;
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i], ch = chans[v.ch];
      let s, e;
      if (v.drum) {
        const d = v.drum, k = v.t / d.len;
        if (k >= 1 || v.dead) { voices.splice(i, 1); continue; }
        const f = d.f1 + (d.f0 - d.f1) * Math.exp(-v.t * 30);
        v.phase += f * dt;
        let x = (1 - d.noise) * Math.sin(2 * Math.PI * v.phase) + d.noise * noise();
        if (d.hp) { const y = x - v.x1; v.x1 = x; x = y; }
        v.y += d.lp * (x - v.y);
        s = v.y * d.amp; e = (1 - k) * (1 - k);
      } else {
        const fm = v.fam;
        if (v.dead) { voices.splice(i, 1); continue; }
        // The envelope: attack, then a decay towards the sustain level, then the release from wherever it was.
        if (!v.released) {
          e = v.t < fm.a ? v.t / fm.a : fm.s + (1 - fm.s) * Math.exp(-(v.t - fm.a) * 4 / fm.d);
          v.relLevel = e;
        } else {
          v.relT += dt;
          e = v.relLevel * Math.exp(-v.relT * 5 / fm.r);
        }
        if (e < 0.0005 && (v.released || fm.s === 0) && v.t > fm.a) { voices.splice(i, 1); continue; }
        const f = hz(v.note, ch);
        v.phase = (v.phase + f * dt) % 1;
        const p = v.phase;
        let x;
        switch (fm.wave) {
          case 'sine': x = Math.sin(2 * Math.PI * p); break;
          case 'tri': x = 4 * Math.abs(p - 0.5) - 1; break;
          case 'square': x = p < 0.5 ? 0.7 : -0.7; break;
          case 'organ': x = 0.6 * Math.sin(2 * Math.PI * p) + 0.3 * Math.sin(4 * Math.PI * p) + 0.2 * Math.sin(6 * Math.PI * p); break;
          case 'piano': x = 0.7 * Math.sin(2 * Math.PI * p) + 0.25 * Math.sin(4 * Math.PI * p) * Math.exp(-v.t * 3) + 0.25 * (2 * p - 1) * Math.exp(-v.t * 8); break;
          case 'bell': x = Math.sin(2 * Math.PI * p + 1.6 * Math.exp(-v.t * 2) * Math.sin(2 * Math.PI * 3.5 * p)); break;
          case 'pipe': x = Math.sin(2 * Math.PI * p) + 0.04 * noise(); break;
          case 'pad': v.phase2 = (v.phase2 + f * 1.006 * dt) % 1; x = (p - 0.5) + (v.phase2 - 0.5); break;
          case 'noise': x = noise(); break;
          default: x = 2 * p - 1;                                         // saw
        }
        v.y += fm.lp * (x - v.y);                                       // a one-pole low-pass: the brightness
        s = v.y;
      }
      v.t += dt;
      const a = s * e * v.amp * ch.vol * ch.expr * 0.45;
      l += a * Math.cos(ch.pan * Math.PI / 2); r += a * Math.sin(ch.pan * Math.PI / 2);
    }
    lr[0] = Math.max(-1, Math.min(1, l)) * 32767; lr[1] = Math.max(-1, Math.min(1, r)) * 32767;
  };

  // The byte stream: status bytes, running status, data; SysEx and real-time bytes are let through.
  let status = 0, need = 0, data = [], sysex = false;
  const byte = (b) => {
    b &= 0xff;
    if (b >= 0xf8) return;                                              // real time: clock, start, stop...
    if (b === 0xf0) { sysex = true; return; }
    if (b === 0xf7) { sysex = false; return; }
    if (b & 0x80) { sysex = false; if (b >= 0xf0) { status = 0; return; } status = b; data = []; need = (b & 0xe0) === 0xc0 ? 1 : 2; return; }
    if (sysex || !status) return;
    data.push(b);
    if (data.length === need) { message(status, data[0], data[1] || 0); data = []; }
  };
  return { byte, message, reset, sample, active: () => voices.length, chans };
}

/**
 * A Standard MIDI File (format 0 or 1) as one list of timed messages: [{ t (seconds), st, d1, d2 }],
 * its tracks merged, its tempo changes followed (ticks per quarter note; SMPTE division too). What
 * Windows' MCI sequencer plays (Photon Race 2 writes its song to a .mid file and opens it so).
 */
export function parseSMF(b) {
  const u32 = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0, u16 = (o) => b[o] << 8 | b[o + 1];
  if (b.length < 14 || u32(0) !== 0x4d546864) throw new Error('not a Standard MIDI File');   // 'MThd'
  const ntrk = u16(10), div = u16(12);
  const raw = [];                                                       // { tick, ord, st, d1, d2 } or { tick, tempo }
  let o = 8 + u32(4), ord = 0;
  for (let k = 0; k < ntrk && o + 8 <= b.length; k++) {
    if (u32(o) !== 0x4d54726b) { o += 8 + u32(o + 4); k--; continue; }  // 'MTrk' (skip any other chunk)
    const end = Math.min(b.length, o + 8 + u32(o + 4));
    let p = o + 8, tick = 0, run = 0;
    const vlq = () => { let v = 0, c; do { c = b[p++]; v = v * 128 + (c & 0x7f); } while (c & 0x80 && p < end); return v; };
    while (p < end) {
      tick += vlq();
      let st = b[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) { const type = b[p++], len = vlq(); if (type === 0x51 && len === 3) raw.push({ tick, ord: ord++, tempo: b[p] << 16 | b[p + 1] << 8 | b[p + 2] }); if (type === 0x2f) break; p += len; continue; }
      if (st === 0xf0 || st === 0xf7) { p += vlq(); continue; }
      run = st;
      const n = (st & 0xe0) === 0xc0 ? 1 : 2;
      raw.push({ tick, ord: ord++, st, d1: b[p], d2: n === 2 ? b[p + 1] : 0 });
      p += n;
    }
    o = end;
  }
  raw.sort((a, c) => a.tick - c.tick || a.ord - c.ord);
  const smpte = div & 0x8000, tpq = div & 0x7fff;
  const out = [];
  let tempo = 500000, lastTick = 0, t = 0;
  for (const e of raw) {
    t += (e.tick - lastTick) * (smpte ? 1 / ((256 - (div >> 8)) * (div & 0xff)) : tempo / 1e6 / tpq);
    lastTick = e.tick;
    if (e.tempo) tempo = e.tempo; else out.push({ t, st: e.st, d1: e.d1, d2: e.d2 });
  }
  return out;
}

/** The synthesizer on `machine`, as machine.midi: bytes in (write), samples out (drain), rendered to `now`
 *  (seconds): the machine's clock (src/audio.js), or MIRAGE-LINUX's lx.mono() for its programs. */
export function installMidi(machine, now = () => clock(machine)) {
  if (machine.midi) return machine.midi;
  const synth = createSynth();
  let clock_ = now;
  const midi = {
    synth, last: clock_(), frac: 0, pcm: [], capture: false,
    drain() { const out = Int16Array.from(midi.pcm); midi.pcm.length = 0; return { rate: MIDI_RATE, samples: out }; },
  };
  const lr = [0, 0];
  // A sequence playing (MCI): its messages are sent at their sample, as the clock reaches them.
  let seq = null;
  const due = (t) => { while (seq && seq.i < seq.ev.length && seq.t0 + seq.ev[seq.i].t <= t) { const e = seq.ev[seq.i++]; synth.message(e.st, e.d1, e.d2); } if (seq && seq.i >= seq.ev.length) { seq = null; } };
  midi.render = () => {
    const now = clock_(), from = midi.last;
    const n = (now - midi.last) * MIDI_RATE + midi.frac;
    midi.last = now;
    if (n <= 0) return;
    const whole = Math.floor(n);
    midi.frac = n - whole;
    // Nobody listens (the headless tools, unless they capture): the sequence still moves on, silently.
    if (!(machine.audio || midi.capture)) { due(now); return; }
    const k = Math.min(whole, MIDI_RATE);
    for (let i = 0; i < k; i++) {
      if (seq) due(from + i / MIDI_RATE);
      if (!synth.active()) { midi.pcm.push(0, 0); continue; }
      synth.sample(lr); midi.pcm.push(lr[0], lr[1]);
    }
    if (seq) due(now);
    if (midi.pcm.length > 1 << 21) midi.pcm.splice(0, midi.pcm.length - (1 << 21));
  };
  /** Play a Standard MIDI File's messages from now (parseSMF), or stop (null): all notes off. */
  midi.play = (ev) => { midi.render(); synth.reset(); seq = ev && ev.length ? { ev, i: 0, t0: clock_() } : null; };
  midi.playing = () => !!seq;
  /** Another time source from now on (MIRAGE-LINUX's: lx.mono()), where the BIOS installed it on the machine's. */
  midi.setClock = (f) => { midi.render(); clock_ = f; midi.last = f(); midi.frac = 0; };
  midi.write = (b) => { midi.render(); synth.byte(b); };
  midi.short = (msg) => { midi.render(); synth.message(msg & 0xff, (msg >>> 8) & 0x7f, (msg >>> 16) & 0x7f); };
  midi.reset = () => { midi.render(); synth.reset(); };
  machine.midi = midi;
  return midi;
}

/**
 * An MPU-401 at 330h (data) and 331h (status, command), as a Sound Blaster 16 carries one: reset (FFh)
 * and UART mode (3Fh) are acknowledged with FEh on the data port; in UART mode every byte written to
 * 330h is MIDI. The status port says "ready to receive" always, and "data to read" while an ACK waits.
 */
export function installMPU401(machine) {
  const midi = installMidi(machine);
  let uart = false, ack = [];
  machine.onPortWrite(0x331, (p, s, v) => {
    v &= 0xff;
    if (v === 0xff) { uart = false; midi.reset(); ack.push(0xfe); }
    else if (v === 0x3f) { uart = true; ack.push(0xfe); }
    else if (!uart) ack.push(0xfe);
  });
  machine.onPortWrite(0x330, (p, s, v) => { midi.write(v); });
  machine.onPortRead(0x331, () => (ack.length ? 0x00 : 0x80));       // bit 6 clear: ready; bit 7 clear: data waiting
  machine.onPortRead(0x330, () => (ack.length ? ack.shift() : 0xfe));
  return midi;
}
