// frame.mjs — turn a captured EGA/VGA frame into RGB, and RGB into a PNG.
//
// Shared deliberately between the MIRAGE side (tools/shot.mjs) and the DOSBox side
// (tools/egaref.mjs): if each composed its own planes, a difference in the picture would not tell
// you whether the DATA differs or only the two renderers do.

import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

/**
 * @param {Uint8Array} planes four 64 KB planes, or four 8000-byte planes, laid end to end
 * @param {number} planeLen bytes per plane in `planes`
 * @param {Uint8Array} dac 768 six-bit entries
 * @param {Uint8Array|null} attr 16 attribute-controller entries (4-bit index -> DAC index)
 */
export function composePlanar(planes, planeLen, dac, attr, stride, start, W = 320, H = 200) {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const off = (start + y * stride + (x >> 3)) % planeLen, bit = 7 - (x & 7);
    let idx = 0;
    for (let p = 0; p < 4; p++) idx |= ((planes[p * planeLen + off] >> bit) & 1) << p;
    const d = (attr ? attr[idx] : idx) & 0x3f, o = (y * W + x) * 3;
    rgb[o] = dac[d * 3] << 2; rgb[o + 1] = dac[d * 3 + 1] << 2; rgb[o + 2] = dac[d * 3 + 2] << 2;
  }
  return rgb;
}

export function composeLinear(fb, dac, W = 320, H = 200) {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const d = fb[i], o = i * 3;
    rgb[o] = dac[d * 3] << 2; rgb[o + 1] = dac[d * 3 + 1] << 2; rgb[o + 2] = dac[d * 3 + 2] << 2;
  }
  return rgb;
}

export function writePNG(file, rgb, W = 320, H = 200, S = 2) {
  const OW = W * S, OH = H * S, buf = Buffer.alloc(OW * OH * 3);
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const s = (((y / S) | 0) * W + ((x / S) | 0)) * 3, d = (y * OW + x) * 3;
    buf[d] = rgb[s]; buf[d + 1] = rgb[s + 1]; buf[d + 2] = rgb[s + 2];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(OW, 0); ihdr.writeUInt32BE(OH, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = OW * 3, raw = Buffer.alloc((stride + 1) * OH);
  for (let y = 0; y < OH; y++) buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  const crc32 = (b) => { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t), d]); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc32(body)); return Buffer.concat([L, body, C]); };
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

/** Fraction of pixels that match exactly. */
export function similarity(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i += 3) if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
  return same / (a.length / 3);
}
