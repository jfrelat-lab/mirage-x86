// fat12.mjs — read a FAT12 floppy image: the BPB, the FAT chain, and the directory tree.
//
// Written for the DOS oracle, which needs OUR filesystem to hold the same files as the kernel's when
// it replays a captured `AH=3Dh open` / `AH=3Fh read`. Comparing file calls without the file is
// meaningless — that is the "replicate the state deliberately" half of widening the oracle.
//
// Read-only, and only what a floppy needs: 12-bit FAT entries, 8.3 short names, subdirectories.
// No long names, no FAT16/32. If it meets something it does not understand it says so rather than
// guessing, because a silently mis-parsed image would produce oracle mismatches that mean nothing.

const SECTOR = 512;
const ATTR_VOLUME = 0x08, ATTR_DIR = 0x10;

/** Parse the BIOS Parameter Block out of the boot sector. */
export function readBPB(img) {
  const r16 = (o) => img[o] | (img[o + 1] << 8);
  const bpb = {
    oem: String.fromCharCode(...img.subarray(3, 11)).trim(),
    bytesPerSector: r16(0x0b),
    sectorsPerCluster: img[0x0d],
    reservedSectors: r16(0x0e),
    fatCount: img[0x10],
    rootEntries: r16(0x11),
    totalSectors: r16(0x13),
    sectorsPerFat: r16(0x16),
    sectorsPerTrack: r16(0x18),
    heads: r16(0x1a),
  };
  if (bpb.bytesPerSector !== SECTOR) throw new Error(`unsupported sector size ${bpb.bytesPerSector}`);
  if (!bpb.sectorsPerCluster || !bpb.fatCount || !bpb.sectorsPerFat) throw new Error('not a FAT12 BPB');
  bpb.fatStart = bpb.reservedSectors;
  bpb.rootStart = bpb.fatStart + bpb.fatCount * bpb.sectorsPerFat;
  bpb.rootSectors = Math.ceil((bpb.rootEntries * 32) / SECTOR);
  bpb.dataStart = bpb.rootStart + bpb.rootSectors;
  return bpb;
}

/** Entry `n` of the 12-bit FAT: two entries share three bytes. */
function fatEntry(img, bpb, n) {
  const base = bpb.fatStart * SECTOR + ((n * 3) >> 1);
  const v = img[base] | (img[base + 1] << 8);
  return (n & 1) ? (v >> 4) : (v & 0xfff);
}

/** Follow a cluster chain and concatenate its data, stopping at `size` bytes. */
function readChain(img, bpb, firstCluster, size) {
  const out = new Uint8Array(size);
  const perCluster = bpb.sectorsPerCluster * SECTOR;
  let cluster = firstCluster, written = 0, guard = 0;
  while (cluster >= 2 && cluster < 0xff0 && written < size) {
    if (++guard > 0x1000) throw new Error('FAT chain does not terminate (loop?)');
    const off = (bpb.dataStart + (cluster - 2) * bpb.sectorsPerCluster) * SECTOR;
    const n = Math.min(perCluster, size - written);
    out.set(img.subarray(off, off + n), written);
    written += n;
    cluster = fatEntry(img, bpb, cluster);
  }
  return out;
}

/** Decode 32-byte directory entries from a buffer. */
function parseDir(buf) {
  const out = [];
  for (let i = 0; i + 32 <= buf.length; i += 32) {
    const first = buf[i];
    if (first === 0x00) break;                       // no entry here or after
    if (first === 0xe5) continue;                    // deleted
    const attr = buf[i + 11];
    if (attr === 0x0f) continue;                     // a long-name fragment: ignored, not supported
    if (attr & ATTR_VOLUME) continue;                // volume label
    const base = String.fromCharCode(...buf.subarray(i, i + 8)).trimEnd();
    const ext = String.fromCharCode(...buf.subarray(i + 8, i + 11)).trimEnd();
    const name = ext ? `${base}.${ext}` : base;
    if (name === '.' || name === '..') continue;
    out.push({
      name, attr,
      isDir: !!(attr & ATTR_DIR),
      cluster: buf[i + 26] | (buf[i + 27] << 8),
      size: (buf[i + 28] | (buf[i + 29] << 8) | (buf[i + 30] << 16) | (buf[i + 31] << 24)) >>> 0,
    });
  }
  return out;
}

/**
 * Read every file in the image.
 * @returns {{bpb: object, files: Map<string, Uint8Array>}} paths are DOS-style, e.g. `\FDSETUP\X.BAT`
 */
export function readImage(img) {
  const bpb = readBPB(img);
  const files = new Map();
  const rootBuf = img.subarray(bpb.rootStart * SECTOR, (bpb.rootStart + bpb.rootSectors) * SECTOR);

  const walk = (entries, prefix, depth) => {
    if (depth > 8) return;                           // a floppy is not that deep; refuse to loop
    for (const e of entries) {
      const path = prefix + e.name;
      if (e.isDir) {
        if (!e.cluster) continue;
        const buf = readChain(img, bpb, e.cluster, bpb.sectorsPerCluster * SECTOR * 64);
        walk(parseDir(buf), path + '\\', depth + 1);
      } else {
        files.set(path, e.size ? readChain(img, bpb, e.cluster, e.size) : new Uint8Array(0));
      }
    }
  };
  walk(parseDir(rootBuf), '\\', 0);
  return { bpb, files };
}
