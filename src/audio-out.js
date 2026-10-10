// audio-out.js — plays the machine's sound in the browser (src/audio.js mixes it).
//
// An AudioWorklet holds a queue of stereo chunks and plays them; the page pushes what the machine
// produced since the last animation frame (machine.audio.pull at the context's rate). Both run on
// real time — the browser's machine clock is wall-clock time — so the queue stays short; it is
// trimmed past 200 ms (a stalled tab must not play its backlog late) and re-primed with 40 ms after
// running dry, so an underrun is a gap rather than a crackle.
//
// Browsers only let a page start audio from a user gesture: start() is called on the first click or
// key, and until then pump() still pulls, so the machine's sound does not pile up unheard.

const WORKLET = `
class MirageOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0; this.frames = 0; this.primed = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'flush') { this.q = []; this.off = 0; this.frames = 0; this.primed = false; return; }
      this.q.push(d); this.frames += d.length / 2;
      while (this.frames > sampleRate * 0.2 && this.q.length > 1) {
        const old = this.q.shift(); this.frames -= (old.length - this.off) / 2; this.off = 0;
      }
    };
  }
  process(_in, outs) {
    const L = outs[0][0], R = outs[0][1] || outs[0][0];
    if (!this.primed && this.frames >= sampleRate * 0.04) this.primed = true;
    for (let i = 0; i < L.length; i++) {
      if (!this.primed || !this.q.length) { L[i] = R[i] = 0; continue; }
      const b = this.q[0];
      L[i] = b[this.off]; R[i] = b[this.off + 1];
      this.off += 2; this.frames--;
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    if (!this.q.length) this.primed = false;
    return true;
  }
}
registerProcessor('mirage-out', MirageOut);
`;

export class AudioOut {
  constructor(machine) {
    this.machine = machine;
    this.ctx = null; this.node = null; this.muted = false; this.starting = null;
  }
  /** Create the context and the worklet. Must run inside a user gesture the first time. */
  start() {
    if (this.starting) return this.starting;
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return Promise.resolve(false);
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    this.starting = this.ctx.audioWorklet.addModule(url).then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'mirage-out', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      return this.ctx.resume().then(() => true);
    }).catch((e) => { console.warn('audio unavailable', e); return false; });
    return this.starting;
  }
  /** Called once per animation frame: hand the worklet what the machine played since the last one. */
  pump() {
    const a = this.machine.audio;
    if (!a) return;
    const rate = this.ctx ? this.ctx.sampleRate : 48000;
    const buf = a.pull(rate);
    if (!this.node || this.muted || this.ctx.state !== 'running' || !buf.length) return;
    this.node.port.postMessage(buf, [buf.buffer]);
  }
  setMuted(m) {
    this.muted = m;
    if (m && this.node) this.node.port.postMessage('flush');
  }
  get running() { return !!(this.ctx && this.ctx.state === 'running'); }
}
