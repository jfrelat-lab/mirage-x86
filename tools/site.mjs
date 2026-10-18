// site.mjs — the static export: MIRAGE's pages as any static host serves them, in site/.
//
//   node tools/site.mjs [--out=site]
//   node tools/oasis.mjs serve --static        (or any static server on site/) to look at it
//
// What is shipped is what the repository holds and the pages load: the pages and their styles, src/,
// the examples (each with its licence, examples/licenses/), the demos, the VGA ROM fonts (assets/), and
// OASIS's manifests, files and screenshots (oasis/). Only files git tracks are taken, so nothing the
// repository keeps out — boot/, games/, intros/, other people's disks and games — can reach a host.
// The tools, the documentation and the tests stay in the repository (the pages link to them there).
//
// A file over 25 MiB, the most Cloudflare Pages takes, goes in parts (<file>.part0, .part1, ... and
// <file>.parts.json) that the page joins back (src/fetch-whole.js): the FreeDOS disk, 25.2 MB gzipped.
// functions/ (the oasis-fetch relay) is not copied: wrangler takes it from the directory it runs in
// (tools/deploy.mjs runs it from the repository). site/ is never committed (.gitignore).
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OUT = join(ROOT, arg('out') || 'site');
export const MAX = 25 * 1024 * 1024;                     // Cloudflare Pages' largest file
export const PART = 24 * 1024 * 1024;

/** What goes on a host, as repository paths: tracked files of the pages' own directories. */
export const SHIPPED = (p) => /^[^/]+\.(html|css)$/.test(p) || p === 'LICENSE'
  || /^(src|examples|demos|assets|oasis)\//.test(p) && !/\.md$/i.test(p);   // the demos' .asm: their cards' source links

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();

function build() {
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const files = tracked.filter(SHIPPED);
  rmSync(OUT, { recursive: true, force: true });
  let bytes = 0, split = 0;
  const write = (rel, data) => { const to = join(OUT, rel); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, data); bytes += data.length; };
  for (const f of files) {
    const data = readFileSync(join(ROOT, f));
    if (data.length <= MAX) { write(f, data); continue; }
    const parts = Math.ceil(data.length / PART);
    for (let i = 0; i < parts; i++) write(`${f}.part${i}`, data.subarray(i * PART, (i + 1) * PART));
    write(`${f}.parts.json`, Buffer.from(JSON.stringify({ parts, size: data.length }) + '\n'));
    split++;
  }
  // No COOP/COEP: MIRAGE uses no SharedArrayBuffer. Pages and scripts revalidate (a deploy changes
  // them); nothing is indexed from a preview, which Cloudflare Access closes anyway.
  write('_headers', Buffer.from(`/*
    X-Content-Type-Options: nosniff
    Referrer-Policy: strict-origin-when-cross-origin
  /src/*
    Cache-Control: public, max-age=0, must-revalidate
  `));
  console.log(`site: ${files.length} files (${split} in parts), ${(bytes / 1e6).toFixed(1)} MB -> ${OUT}`);
}
