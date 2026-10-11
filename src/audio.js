// audio.js — what the machine sounds like, as stereo samples at whatever rate the listener wants.
// No DOM here: the browser plays it (src/audio-out.js), tools/record-audio.mjs writes it to a WAV.
//
// Three sources:
//   - the Sound Blaster's DAC (src/sb.js) and its OPL3 FM (src/opl.js), whose samples arrive at
//     their own rates (the card's, 49716 Hz) and are resampled linearly;
//   - the PC speaker: port 61h bits 0-1 and PIT channel 2. With the gate (bit 0) and the data bit
//     (bit 1) both set it plays channel 2's square wave; with the gate off the data bit drives the
//     cone directly, which is how speaker-PCM players (and plain clicks) work. Every change is
//     stamped with the machine's time and rendered from that timeline, so a beep lasts what the
//     program meant whatever the frame rate.
//
// Time is the machine's own clock — see clock() — so headless output is reproducible to the sample.
// pull(rate) returns the samples for the time elapsed since the previous pull.

const PIT_HZ = 1193182;
const SPEAKER = 0.25, SB = 0.9, OPL = 1.5;  // levels, against full scale (OPL: DOSBox-X's Nuked-OPL3 level, tools/oplnotes.asm)

/** The machine's time in seconds: wall-clock in the browser (where the PIT follows it too),
 *  otherwise cpu.cycles at 18.2065 * pitBase cycles a second, the PIT's own rate. */
export function clock(machine) {
  return machine.wallClockMs ? machine.wallClockMs() / 1000
    : machine.cpu.cycles / (18.2065 * (machine.pitBase || 0x10000));
}

export function installAudio(machine) {
  const audio = {
    last: clock(machine),
    // Speaker timeline: [{ t, b (port 61h bits 0-1), hz }], the state in force from t on.
    spk: [{ t: -Infinity, b: 0, hz: 0, t0: 0 }],
    // The resampled sources: the Sound Blaster's DAC and the OPL3, each with its own fifo.
    src: [{ name: 'sb', gain: SB, fifo: [], frac: 0, prev: [0, 0] }, { name: 'opl', gain: OPL, fifo: [], frac: 0, prev: [0, 0] }],
    hp: [0, 0, 0, 0],                       // DC blocker state, per channel: x1, y1
    pull,
  };
  const ppi = machine.ppi;
  machine.onSpeaker = () => {
    const b = ppi ? ppi.portB & 3 : 0, hz = ppi ? PIT_HZ / ppi.ch2Reload : 0, t = clock(machine);
    const prev = audio.spk[audio.spk.length - 1];
    if (prev.b === b && prev.hz === hz) return;
    // Channel 2 restarts its count when its gate rises or it is reloaded: the wave's phase starts there.
    const restart = (b & 1) && (!(prev.b & 1) || prev.hz !== hz);
    audio.spk.push({ t, b, hz, t0: restart ? t : prev.t0 });
  };

  // Linear resampling of a device's stereo Int16 stream onto `rate`, appended to its fifo.
  const take = (st, rate) => {
    const dev = machine[st.name];
    if (!dev) return;
    if (dev.render) dev.render();                 // the OPL computes its samples up to now
    const { rate: srcRate, samples } = dev.drain();
    if (!samples.length || !srcRate) return;
    const step = srcRate / rate, n = samples.length >> 1;
    let pos = st.frac;
    const [p0, p1] = st.prev;
    while (pos < n) {
      const i = Math.floor(pos), f = pos - i;
      const a0 = i === 0 ? p0 : samples[(i - 1) * 2], a1 = i === 0 ? p1 : samples[(i - 1) * 2 + 1];
      const b0 = samples[i * 2], b1 = samples[i * 2 + 1];
      st.fifo.push((a0 + (b0 - a0) * f) / 32768 * st.gain, (a1 + (b1 - a1) * f) / 32768 * st.gain);
      pos += step;
    }
    st.frac = pos - n;
    st.prev = [samples[(n - 1) * 2], samples[(n - 1) * 2 + 1]];
    // Never let a device get more than a quarter of a second ahead of the listener.
    const max = Math.ceil(rate * 0.25) * 2;
    if (st.fifo.length > max) st.fifo.splice(0, st.fifo.length - max);
  };

  function pull(rate) {
    const now = clock(machine), t0 = audio.last;
    audio.last = now;
    for (const st of audio.src) take(st, rate);
    const frames = Math.max(0, Math.min(Math.round((now - t0) * rate), rate));   // a second at most
    const out = new Float32Array(frames * 2);
    // The speaker, sample by sample along its timeline.
    const tl = audio.spk;
    let k = 0;
    while (k + 1 < tl.length && tl[k + 1].t <= t0) k++;
    for (let i = 0; i < frames; i++) {
      const t = t0 + (i / rate);
      while (k + 1 < tl.length && tl[k + 1].t <= t) k++;
      const s = tl[k];
      let v;
      if (!(s.b & 2)) v = 0;                                   // data bit off: the cone rests
      else if (s.b & 1) v = s.hz > 20 && s.hz < 20000 ? ((((t - s.t0) * s.hz) % 1) < 0.5 ? 1 : -1) : 0;   // channel 2's square wave
      else v = 1;                                              // data bit on, gate off: pushed out
      out[i * 2] = out[i * 2 + 1] = v * SPEAKER;
    }
    // Keep only the state in force from now on.
    audio.spk = tl.slice(Math.max(0, k));
    // The card's DAC and its FM, from their fifos.
    for (const st of audio.src) {
      const n = Math.min(frames * 2, st.fifo.length);
      for (let i = 0; i < n; i++) out[i] += st.fifo[i];
      st.fifo.splice(0, n);
    }
    // A ~16 Hz high-pass on the mix, as the AC coupling of a real output does: neither the speaker's
    // resting level nor a card playing a buffer of zeros (00h is -128 in unsigned 8-bit) is audible.
    const a = 1 - 1 / (rate * 0.01), hp = audio.hp;
    for (let i = 0; i < out.length; i++) {
      const c = (i & 1) * 2, v = out[i], y = a * (hp[c + 1] + v - hp[c]);
      hp[c] = v; hp[c + 1] = y;
      out[i] = Math.max(-1, Math.min(1, y));
    }
    return out;
  }

  machine.audio = audio;
  return audio;
}

/** A 16-bit stereo WAV file of interleaved float samples. */
export function wav(samples, rate) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return new Uint8Array(buf);
}
