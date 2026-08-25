// hsq.mjs — Cryo HSQ/SQZ decompressor, an ORACLE for what a Dune resource must decompress to.
//
//   node -e "import('./tools/hsq.mjs').then(m=>console.log(m.unhsq(require('fs').readFileSync('games/DUNE/SHAI2.SQZ')).out.length))"
//
// Transcribed from Dune's own routine at 0824:bc29 rather than guessed: every attempt to infer the
// format from the outside failed, and the failures were invisible because the obvious check is
// vacuous — the decode loop is bounded by the declared output size, so it ALWAYS "produces the right
// number of bytes" unless it stops early. The honest check is INPUT consumption: a correct decode
// ends exactly 3 bytes short of the file (the unreached end-of-stream marker) on 25 of Dune's 32
// .SQZ files, and never overruns.
//
// Header: 3-byte uncompressed size, 2-byte compressed size, 1-byte checksum; the six bytes sum
// to 0xAB. The bit queue is a 16-bit word carrying a sentinel.
//
// This found the flag-leak bug fixed in machine.js: comparing MIRAGE's decompressed SHAI2.SQZ
// against this decoder pinpointed the first wrong byte, and from there the exact token and the
// exact instruction boundary.

// Cryo HSQ/SQZ decompressor, transcribed from Dune's own routine at 0824:bc29 (DUNEDEM.EXE).
// Header: 3-byte uncompressed size, 2-byte compressed size, 1-byte checksum (the six sum to 0xAB).
// The bit queue is a 16-bit word with a sentinel bit: `shr bp,1` yields the bit in CF and ZF marks
// exhaustion, then `stc / rcr bp,1` reloads with a fresh 1 at bit 15.
export function unhsq(src, trace) {
  const outSize = src[0] | (src[1] << 8) | (src[2] << 16);
  const out = new Uint8Array(outSize);
  let ip = 6, op = 0, q = 0;
  // `shr bp,1 / jz refill`: the shift that EMPTIES the queue yields the sentinel, which is thrown
  // away — the refilled word's bit 0 is used instead. Returning that sentinel as data gives 17 bits
  // per word and desynchronises the whole stream.
  const bit = () => {
    let b = q & 1; q >>>= 1;
    if (q === 0) { const w = src[ip] | (src[ip + 1] << 8); ip += 2; b = w & 1; q = 0x8000 | (w >> 1); }
    return b;
  };
  for (;;) {
    const tokIp = ip, tokOp = op, qBefore = q;
    if (bit()) { if (trace) trace({ op: tokOp, kind: 'lit', ip: tokIp, q: qBefore }); out[op++] = src[ip++]; if (op >= outSize) break; continue; }
    let count, offset;
    if (bit()) {                                   // long match: 13-bit offset
      const b0 = src[ip++], b1 = src[ip++];
      count = b0 & 7;
      offset = (((b0 >> 3) | (b1 << 5)) & 0x1fff) - 8192;
      if (count === 0) { count = src[ip++]; if (count === 0) break; }   // 0,0 = end of stream
    } else {                                       // short match: 2-bit count, 8-bit offset
      count = bit() * 2; count += bit();
      offset = src[ip++] - 256;
    }
    count += 2;
    if (trace) trace({ op: tokOp, kind: 'match', ip: tokIp, count, offset, q: qBefore });
    for (let i = 0; i < count; i++) { out[op] = out[op + offset]; op++; }
    if (op >= outSize) break;
  }
  return { produced: op, expected: outSize, out, consumed: ip };
}
