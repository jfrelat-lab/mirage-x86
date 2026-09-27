// Fetch a v86 catalogue image that is served in PARTS (catalogue `use_parts: true`, url "<dir>/.img"):
// <dir>/<start>-<end>.img, `chunk` bytes each, reassembled into boot/v86/<dir>.img and checked against
// the size the catalogue declares. Parts already on disk are kept, so an interrupted run resumes.
//
//   node fetch-parts.mjs <dir> <size> <chunk> [ext]
//   e.g. node fetch-parts.mjs windows95-v3 471859200 262144
import { mkdirSync, existsSync, statSync, writeFileSync, openSync, writeSync, closeSync, readFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
const [dir, sizeS, chunkS, ext = '.img'] = process.argv.slice(2);
const size = Number(sizeS), chunk = Number(chunkS);
const DEST = fileURLToPath(new URL('../../boot/v86/', import.meta.url));
const partsDir = `${DEST}.${dir}.parts`;
mkdirSync(partsDir, { recursive: true });
const n = Math.ceil(size / chunk);
const name = (i) => `${partsDir}/${String(i).padStart(6, '0')}`;
const want = (i) => Math.min(chunk, size - i * chunk);
const get = async (i) => {
  if (existsSync(name(i)) && statSync(name(i)).size === want(i)) return;
  const s = i * chunk;
  // The last part is named by the true end, or by a full chunk: try both.
  for (const e of [s + chunk, Math.min(s + chunk, size)]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`https://i.copy.sh/${dir}/${s}-${e}${ext}`);
        if (!r.ok) break;
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length < want(i)) throw new Error(`short part ${i}: ${b.length}`);
        writeFileSync(name(i), b.subarray(0, want(i)));
        return;
      } catch (err) { if (attempt === 3) throw err; }
    }
  }
  throw new Error(`part ${i} (${s}) not found`);
};
let next = 0, done = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < n) { const i = next++; await get(i); if (++done % 100 === 0) process.stderr.write(`  ${dir}: ${done}/${n}\n`); }
}));
const out = `${DEST}${dir.replace(/\/$/, '')}.img`, fd = openSync(out, 'w');
for (let i = 0; i < n; i++) writeSync(fd, readFileSync(name(i)));
closeSync(fd);
const got = statSync(out).size;
if (got === size) rmSync(partsDir, { recursive: true, force: true });
console.log(`${dir}: ${got === size ? 'ok' : 'BAD'} ${got} bytes (${n} parts, ${((Date.now() - t0) / 1000) | 0} s) -> ${out}`);
