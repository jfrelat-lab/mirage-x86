// asound.js — libasound.so.2 (ALSA's library) for MIRAGE-LINUX: the simple PCM playback the intros of
// 2008-2010 open by dlopen("libasound.so") — snd_pcm_open, snd_pcm_set_params, snd_pcm_writei — played
// on the emulated sound device that /dev/dsp is (linux.js: lx.dspFormat, lx.dspPlay), so a full buffer
// paces the writer as the card would. Retrospection (TiTS + FRequency, 2009) called a null pointer when
// the library was missing.

const FORMAT = { 1: 'U8', 2: 'S16_LE', 14: 'FLOAT_LE' };      // SND_PCM_FORMAT_*
const EINVAL = 22;

export function asound() {
  const st = { format: 'S16_LE', ch: 2, rate: 44100, handle: 0 };
  const frameBytes = () => st.ch * (st.format === 'U8' ? 1 : st.format === 'S16_LE' ? 2 : 4);
  return {
    soname: 'libasound.so.2', links: ['libasound.so'],
    state: st,
    fns: {
      // snd_pcm_open(&pcm, name, stream, mode): one playback device, its handle a block of its own.
      snd_pcm_open: ['ppii', (x, pcmp, name, stream) => {
        if (stream !== 0) return -EINVAL;                       // SND_PCM_STREAM_PLAYBACK only
        if (!st.handle) st.handle = x.alloc(16);
        x.w32(pcmp, st.handle);
        return 0;
      }],
      // snd_pcm_set_params(pcm, format, access, channels, rate, soft_resample, latency)
      snd_pcm_set_params: ['puuuuuu', (x, pcm, format, access, ch, rate) => {
        if (!FORMAT[format] || ch < 1 || ch > 2) return -EINVAL;
        Object.assign(st, { format: FORMAT[format], ch, rate });
        x.lx.dspFormat(rate, format === 1 ? 8 : 0x10, ch);
        return 0;
      }],
      // snd_pcm_writei(pcm, buffer, frames): the frames written, after waiting for room as a blocking
      // device does; float samples go to the card as 16 bits.
      snd_pcm_writei: ['ppu', (x, pcm, buf, frames) => {
        let bytes = x.bytes(buf, frames * frameBytes());
        if (st.format === 'FLOAT_LE') {
          const f = new Float32Array(bytes.slice().buffer), out = new Uint8Array(f.length * 2);
          for (let i = 0; i < f.length; i++) { const v = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767); out[2 * i] = v & 255; out[2 * i + 1] = (v >> 8) & 255; }
          bytes = out;
        }
        const r = x.lx.dspPlay(bytes);
        if (r === x.lx.BLOCK) return r;
        return r < 0 ? r : Math.floor(r / (st.format === 'FLOAT_LE' ? st.ch * 2 : frameBytes()));
      }],
      snd_pcm_prepare: ['p', () => 0],
      snd_pcm_drain: ['p', () => 0],
      snd_pcm_drop: ['p', () => 0],
      snd_pcm_close: ['p', () => 0],
      snd_pcm_recover: ['pii', () => 0],
      snd_strerror: ['i', (x) => (st.empty ||= x.alloc(1))],      // "", in the library's memory
    },
  };
}
