// freedos-sources.mjs — the FreeDOS 1.4 packages of the home page's disk, and their source, delivered
// beside the disk.
//
//   node tools/freedos-sources.mjs                 fetch the packages into dist/freedos-sources/
//   node tools/freedos-sources.mjs --release       ... and publish them as the assets of the release
//                                                  freedos-1.4-sources of jfrelat-lab/mirage-x86 (gh)
//
// The disk (examples/boot/freedos.img.gz, tools/mkfreedos.mjs) holds the packages' programs without
// their SOURCE directories. Most are under the GNU GPL v2, whose section 3 asks that whoever passes the
// binaries on gives access to the source "from the same place": so the package zips themselves,
// unmodified (each holds its program's SOURCE/), go wherever the disk goes — in the static export at
// sources/freedos/ (tools/site.mjs), and as release assets where the repository serves the disk.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const UPSTREAM = 'https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.4/';
export const RELEASE = { repo: 'jfrelat-lab/mirage-x86', tag: 'freedos-1.4-sources' };
export const CACHE = join(ROOT, 'dist', 'freedos-sources');

/** The SHA-256 of each package's zip, as the disk's C:\SOURCES.TXT lists it. */
export const PACKAGES = {
  // base
  kernel: '43ed55fec6e795bb24e658302c7fae9eec9eb8dfeaba15734317b3f8302706d6',
  freecom: '3a7cfa03cce242031926cd67b69e1fd030d1c27127885d927629945f3137b6f0',
  himemx: '99b44e5bbb878105486e172675a460f645cdfb5a86cc1cf1e0e549fa31f29ce6',
  ctmouse: 'fd47069fb3d9559604dcaef34ca4f3705a7f2f2cff3e4b205e361b79f10a8200',
  edit: '6fc7bb68283f22387d0d5f310bf0cfc40af37324ad6bea7a574b57287bbb9841',
  mem: 'ec98eb5e7afa15f587e0f85f4a748611c398cbe88bf571b17e6341532b9b746d',
  more: 'a968c39b4de3a946f0d8e3138668991b97c328c8c95f2a380e249e6fd11da91e',
  deltree: 'af3867c4c2c98369da497ecf50c9a6b45fea1fb5967e9333a3420d5dda5cc521',
  xcopy: 'd075f4e59c3c7008c0f4d8c0c8b5b2dd06210e7c4e0b53eec646db66f7e5ddaf',
  attrib: '6a32c47d5319c11f1e748ab320d678704166f34d0cd6ef4b857fdaf182f4ed69',
  find: '75dd5bf90821b9ecff67fad36d9da342e48bfb1073e1835e53c9bf560ac5099c',
  tree: 'a3d11398d116654df293eccf6fbbcf543c799bced21f8045056a28cecccfa10b',
  choice: 'c64ce36b900feaf98741fb1e0a560106928926ab02e8158d403e5fee91edd8aa',
  mode: 'c92e07e9bea8f132437c542184c0cadc7fbabe3543174209c2799407ab671bdb',
  sort: '3c9ed55ef7425272c313431ac3e02605d1e9ce1ce1d8e32cefb575e36077d6cf',
  fc: 'bad0b8e74bd9c1d02c3065a2acbd1d4a54a0a7efa0771ce00700556bafa7d48a',
  // devel
  bwbasic: '45a37e14e06d5dd2972a5799519148c119c1562523160b8a44c507f7fe6e2318',
  fbc: '2eadc6d87d6e95fdaff8ba147c87f3a3eaf397cb3ca4fc48c40ffe24237b6328',
  nasm: 'f3497ec94f76b508a74904926a479cf33d75f6da332c432dfa72d5aaa2903cbe',
  lua: 'ff640089921398182ee9b92aefa97662f90c279f8476234360643990e32361d5',
  // games
  vitetris: '53a0be1c42ae9f2cb3e501d9cbf5e4b9d1d829b934966e2ca0d6ab0486dd7843',
  flpybird: 'a6f5c0c1bf5aa1746c9a335714c58835d4ce1ed90caa8de9072d9fb7f1d08ac9',
  sudoku86: '12c13caecd098748f5a8ace6667bbcacc333da209a70f26e49504fd11cb21eb3',
  liquiwar: '5ad1a6507883f9aacb0ad1914b7dbc266afc640f081797a0638e7e8de92f9ad9',
  kraptor: 'd14e3a780a488be427dbaa577aef8e878f2d62e8b6ab516902c4e9fc99c929cd',
};
const GROUP = { bwbasic: 'devel', fbc: 'devel', nasm: 'devel', lua: 'devel',
  vitetris: 'games', flpybird: 'games', sudoku86: 'games', liquiwar: 'games', kraptor: 'games' };
export const upstreamOf = (name) => `${UPSTREAM}${GROUP[name] || 'base'}/${name}.zip`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The package zips in CACHE, fetched from UPSTREAM where absent; each checked against its SHA-256. */
export async function fetchSources(dir = CACHE, log = console.error) {
  mkdirSync(dir, { recursive: true });
  for (const [name, sha] of Object.entries(PACKAGES)) {
    const file = join(dir, `${name}.zip`);
    if (existsSync(file) && sha256(readFileSync(file)) === sha) continue;
    log(`freedos-sources: fetching ${upstreamOf(name)}`);
    const res = await fetch(upstreamOf(name));
    if (!res.ok) throw new Error(`${upstreamOf(name)}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== sha) throw new Error(`${name}.zip: sha256 ${sha256(bytes)}, expected ${sha}`);
    writeFileSync(file, bytes);
  }
  return Object.keys(PACKAGES).map((name) => join(dir, `${name}.zip`));
}

/** SHA256SUMS of the packages, as sha256sum writes it. */
export const sums = () => Object.entries(PACKAGES).map(([n, h]) => `${h}  ${n}.zip`).join('\n') + '\n';

/** What the archives are, for a reader who found them beside the disk. */
export const readme = () => `The FreeDOS 1.4 packages of MIRAGE's FreeDOS disk (examples/boot/freedos.img.gz), unmodified.

The disk holds each package's programs without its SOURCE directory; these zips are the packages
whole, as the FreeDOS project publishes them, so each holds the source code of its programs (SOURCE/)
and its licence (APPINFO/*.LSM). They are copies of
${UPSTREAM}
and SHA256SUMS gives each one's checksum, the same as the disk's C:\\SOURCES.TXT.

  ${Object.keys(PACKAGES).map((n) => `${n}.zip`).join('  ')}

Most of these programs are under the GNU General Public License, version 2 (the kernel package's
SOURCE/ and DOC/KERNEL/COPYING hold its text). examples/licenses/freedos.txt in MIRAGE's repository
lists each package's licence.
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await fetchSources();
  console.log(`freedos-sources: ${files.length} packages in ${CACHE}`);
  if (process.argv.includes('--release')) {
    writeFileSync(join(CACHE, 'SHA256SUMS'), sums());
    writeFileSync(join(CACHE, 'README.txt'), readme());
    const gh = (...a) => spawnSync('gh', a, { stdio: 'inherit' }).status;
    const exists = spawnSync('gh', ['release', 'view', RELEASE.tag, '-R', RELEASE.repo], { stdio: 'ignore' }).status === 0;
    const assets = [...files, join(CACHE, 'SHA256SUMS'), join(CACHE, 'README.txt')];
    const st = exists ? gh('release', 'upload', RELEASE.tag, '-R', RELEASE.repo, '--clobber', ...assets)
      : gh('release', 'create', RELEASE.tag, '-R', RELEASE.repo, '--title', 'FreeDOS 1.4 packages, with their source',
        '--notes', readme(), ...assets);
    process.exit(st);
  }
}
