// audio-compare.mjs — compare two recordings of the same program, section by section.
//
//   node tools/audio-compare.mjs <ours.wav> <reference.wav> [silence threshold=0.004]
//
// The two need not start at the same moment (an emulator boots, a DOS loads): each is cut into
// sections at its silences (10 ms windows below the threshold, for at least 60 ms), and section n is
// compared with section n. Per section: duration, RMS level, the dominant frequency (a 16384-point
// FFT of the middle), the spectral centroid (where the energy sits — the timbre in one number), the
// left and right levels, and how well the two 10 ms loudness envelopes correlate.
// tools/oplnotes.asm is written for it: one sound per section.
import { readFileSync } from 'fs';

const [aPath, bPath, thrArg] = process.argv.slice(2);
if (!aPath || !bPath) { console.error('usage: node tools/audio-compare.mjs <ours.wav> <reference.wav> [threshold]'); process.exit(2); }
const THR = Number(thrArg) || 0.004;

function load(p) {
  const b = readFileSync(p);
  let o = 12, rate = 44100, ch = 2, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); rate = b.readUInt32LE(o + 12); }
    if (id === 'data') { data = b.subarray(o + 8, o + 8 + len); break; }
    o += 8 + len + (len & 1);
  }
  const n = Math.floor(data.length / 2 / ch), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = data.readInt16LE(i * ch * 2) / 32768; R[i] = data.readInt16LE((i * ch + (ch - 1)) * 2) / 32768; }
  // The same 16 Hz DC blocker on both: a half-sine waveform carries a DC level, and each emulator's
  // output removes it with its own time constant — a difference of plumbing, not of the chip.
  const a = 1 - 1 / (rate * 0.01);
  for (const x of [L, R]) { let x1 = 0, y1 = 0; for (let i = 0; i < n; i++) { const y = a * (y1 + x[i] - x1); x1 = x[i]; y1 = y; x[i] = y; } }
  return { rate, L, R };
}

function sections(w) {
  const win = Math.round(w.rate / 100), gap = 6, out = [];
  let start = -1, quiet = 0;
  const nwin = Math.floor(w.L.length / win);
  for (let k = 0; k < nwin; k++) {
    let s = 0; for (let i = k * win; i < (k + 1) * win; i++) s += w.L[i] * w.L[i] + w.R[i] * w.R[i];
    const loud = Math.sqrt(s / (2 * win)) > THR;
    if (loud) { if (start < 0) start = k; quiet = 0; }
    else if (start >= 0 && ++quiet >= gap) { out.push([start * win, (k - quiet + 1) * win]); start = -1; quiet = 0; }
  }
  if (start >= 0) out.push([start * win, nwin * win]);
  return out;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + len / 2;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}

function describe(w, [s, e]) {
  const n = e - s, N = 16384, mid = s + Math.max(0, Math.floor((n - N) / 2));
  let sl = 0, sr = 0; for (let i = s; i < e; i++) { sl += w.L[i] ** 2; sr += w.R[i] ** 2; }
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N && mid + i < e; i++) re[i] = (w.L[mid + i] + w.R[mid + i]) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft(re, im);
  let peak = 1, pv = 0, cs = 0, ct = 0;
  for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > pv) { pv = m; peak = k; } cs += m * k; ct += m; }
  const env = [], win = Math.round(w.rate / 100);
  for (let i = s; i + win <= e; i += win) { let q = 0; for (let j = i; j < i + win; j++) q += w.L[j] ** 2 + w.R[j] ** 2; env.push(Math.sqrt(q / (2 * win))); }
  return { dur: n / w.rate, rms: Math.sqrt((sl + sr) / (2 * n)), l: Math.sqrt(sl / n), r: Math.sqrt(sr / n),
    hz: peak * w.rate / N, centroid: ct ? (cs / ct) * w.rate / N : 0, env };
}
const corr = (a, b) => {
  const n = Math.min(a.length, b.length); if (n < 3) return NaN;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += (a[i] - ma) * (b[i] - mb); y += (a[i] - ma) ** 2; z += (b[i] - mb) ** 2; }
  return y && z ? x / Math.sqrt(y * z) : NaN;
};

const A = load(aPath), B = load(bPath), sa = sections(A), sb = sections(B);
console.log(`sections: ours ${sa.length}, reference ${sb.length}`);
console.log(' #   dur s (ours/ref)   rms (ours/ref)    peak Hz (ours/ref)   centroid Hz (ours/ref)   L/R ours    L/R ref    env corr');
for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
  const a = sa[i] && describe(A, sa[i]), b = sb[i] && describe(B, sb[i]);
  const f = (x, d = 3) => (x === undefined ? '-' : x.toFixed(d));
  console.log(`${String(i + 1).padStart(2)}   ${f(a?.dur, 2).padStart(5)}/${f(b?.dur, 2).padEnd(6)}   ${f(a?.rms).padStart(6)}/${f(b?.rms).padEnd(6)}   ` +
    `${f(a?.hz, 0).padStart(7)}/${f(b?.hz, 0).padEnd(7)}      ${f(a?.centroid, 0).padStart(6)}/${f(b?.centroid, 0).padEnd(6)}        ` +
    `${a ? f(a.l) + '/' + f(a.r) : '-'}  ${b ? f(b.l) + '/' + f(b.r) : '-'}   ${a && b ? corr(a.env, b.env).toFixed(2) : '-'}`);
}
