// zip.js — read a ZIP archive into a list of files, in the browser and in Node.
//
// Shareware and freeware of the period is distributed as a ZIP, and its licence usually asks that
// it be passed on complete and unmodified. So MIRAGE serves the archive as published and unpacks it
// here, rather than repackaging its contents. The central directory is read (it holds the sizes
// even when a local header defers them to a data descriptor); entries are "stored" (method 0) or
// "deflated" (method 8), the latter through the platform's DecompressionStream('deflate-raw').
// Anything else — encryption, ZIP64, old methods like implode — is reported, not guessed at.

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * @param {Uint8Array} zip
 * @returns {Promise<{path: string, bytes: Uint8Array}[]>} files only (directories are implied by paths)
 */
export async function unzip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes (a comment may follow it).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error('ZIP central directory is damaged');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    // Names of the period are CP437/ASCII; Latin-1 decoding keeps every byte as one character.
    const name = Array.from(zip.subarray(p + 46, p + 46 + nameLen), (b) => String.fromCharCode(b)).join('');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.endsWith('\\')) continue;            // a directory entry
    if (flags & 1) throw new Error(`${name}: encrypted ZIP entries are not supported`);
    if (dv.getUint32(local, true) !== SIG_LOC) throw new Error(`${name}: local header not found`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = zip.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) bytes = await inflateRaw(data);
    else throw new Error(`${name}: compression method ${method} is not supported (only stored and deflate)`);
    if (bytes.length !== size) throw new Error(`${name}: ${bytes.length} bytes unpacked, the directory says ${size}`);
    files.push({ path: name.replace(/\\/g, '/'), bytes });
  }
  return files;
}

/**
 * id Software's shareware archives (DOOM 1.9, Heretic 1.2) do not hold the game: they hold DEICE.EXE
 * and a self-extracting PKZIP archive cut into floppy-sized pieces, NAME.1, NAME.2… INSTALL.BAT runs
 * DEICE, which glues the pieces back into NAME.EXE and runs it. Doing the same here — join the
 * pieces, read the ZIP inside — serves the archive exactly as id published it, installer included,
 * instead of a repackaged copy. The self-extractor keeps its central directory's offsets relative to
 * the start of the whole .EXE, so `unzip` reads it as it stands.
 * Anything without DEICE.EXE and a NAME.1 beside it is returned unchanged.
 * @param {{path: string, bytes: Uint8Array}[]} files
 */
export async function deice(files) {
  const byName = new Map(files.map((f) => [f.path.toUpperCase(), f]));
  const deiceAt = [...byName.keys()].find((p) => p === 'DEICE.EXE' || p.endsWith('/DEICE.EXE'));
  if (deiceAt === undefined) return files;
  const dir = deiceAt.slice(0, -'DEICE.EXE'.length);
  const first = [...byName.keys()].find((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && p.endsWith('.1'));
  if (first === undefined) return files;
  const stem = first.slice(0, -2), pieces = [];
  for (let n = 1; byName.has(`${stem}.${n}`); n++) pieces.push(byName.get(`${stem}.${n}`).bytes);
  const whole = new Uint8Array(pieces.reduce((a, p) => a + p.length, 0));
  let at = 0; for (const p of pieces) { whole.set(p, at); at += p.length; }
  return unzip(whole);
}
