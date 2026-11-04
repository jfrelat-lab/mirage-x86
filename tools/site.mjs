// site.mjs — the static export: MIRAGE's pages as any static host serves them, in site/.
//
//   node tools/site.mjs [--out=site] [--origin=https://mirage-x86.pages.dev]   (the sitemap's addresses)
//   node tools/oasis.mjs serve --static        (or any static server on site/) to look at it
//
// What is shipped is what the repository holds and the pages load: the pages and their styles, src/,
// the examples (each with its licence, examples/licenses/), the demos, the VGA ROM fonts (assets/), and
// OASIS's manifests, files and screenshots (oasis/). Only files git tracks are taken, so nothing the
// repository keeps out — boot/, games/, intros/, other people's disks and games — can reach a host.
// The tools, the documentation and the tests stay in the repository (the pages link to them there).
//
// The FreeDOS disk goes with its source: the packages it is built from, whole (sources/freedos/,
// tools/freedos-sources.mjs, fetched into dist/ once and checked against their SHA-256).
//
// A file over 25 MiB, the most Cloudflare Pages takes, goes in parts (<file>.part0, .part1, ... and
// <file>.parts.json) that the page joins back (src/fetch-whole.js): the FreeDOS disk, 25.2 MB gzipped.
// functions/ (the oasis-fetch relay) is not copied: wrangler takes it from the directory it runs in
// (tools/deploy.mjs runs it from the repository). site/ is never committed (.gitignore).
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fetchSources, sums, readme, PACKAGES, UPSTREAM, RELEASE } from './freedos-sources.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OUT = join(ROOT, arg('out') || 'site');
export const MAX = 25 * 1024 * 1024;                     // Cloudflare Pages' largest file
export const PART = 24 * 1024 * 1024;

/** What goes on a host, as repository paths: tracked files of the pages' own directories. */
export const SHIPPED = (p) => /^[^/]+\.(html|css)$/.test(p) || p === 'LICENSE' || p === 'CHANGELOG.md'
  || /^(src|examples|demos|assets|oasis)\//.test(p) && !/\.md$/i.test(p);   // the demos' .asm: their cards' source links

/*
 * PRISM's environment modules, from the vendor/prism submodule (src/hle/prism-gl.js imports them): the
 * modules gl.js, glu.js and d3d9.js import, followed through their static imports, PRISM's licence (MIT) and
 * its THIRD-PARTY.md (glu.js carries SGI Free Software License B code). A
 * submodule's files are not the repository's own (git ls-files lists the submodule, not them), so they
 * are named here; a module PRISM adds to that closure is shipped without a change here.
 */
const PRISM = 'vendor/prism', PRISM_ENTRIES = ['src/env/gl.js', 'src/env/glu.js', 'src/env/d3d9.js'];
export function prismShipped(root = ROOT) {
  const out = new Set(['LICENSE', 'THIRD-PARTY.md']), todo = [...PRISM_ENTRIES];
  while (todo.length) {
    const f = todo.pop();
    if (out.has(f)) continue;
    out.add(f);
    const text = readFileSync(join(root, PRISM, f), 'utf8');
    for (const m of text.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) todo.push(join(dirname(f), m[1]));
  }
  return [...out].sort().map((f) => `${PRISM}/${f}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await build();

async function build() {
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  if (!existsSync(join(ROOT, PRISM, PRISM_ENTRIES[0]))) throw new Error(`site: ${PRISM} is empty -- git submodule update --init`);
  const files = [...tracked.filter(SHIPPED), ...prismShipped()];
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
  // The FreeDOS disk's source, beside it: its packages whole, as the FreeDOS project publishes them
  // (tools/freedos-sources.mjs). Not the repository's, so fetched, and checked against their SHA-256.
  const zips = await fetchSources();
  for (const z of zips) write(`sources/freedos/${basename(z)}`, readFileSync(z));
  write('sources/freedos/SHA256SUMS', Buffer.from(sums()));
  write('sources/freedos/README.txt', Buffer.from(readme()));
  write('sources/freedos/index.html', Buffer.from(sourcesPage(zips)));
  // No COOP/COEP: MIRAGE uses no SharedArrayBuffer. Pages and scripts revalidate (a deploy changes
  // them); nothing is indexed from a preview, which Cloudflare Access closes anyway.
  write('_headers', Buffer.from(`/*
    X-Content-Type-Options: nosniff
    Referrer-Policy: strict-origin-when-cross-origin
  /src/*
    Cache-Control: public, max-age=0, must-revalidate
  `));
  // What a search engine is given: the pages (404.html excepted), addressed under --origin.
  const origin = (arg('origin') || 'https://mirage-x86.pages.dev').replace(/\/$/, '');
  const pages = files.filter((f) => /^[^/]+\.html$/.test(f) && f !== '404.html' && f !== 'linux.html').sort();   // linux.html: oasis run's window
  write('robots.txt', Buffer.from(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`));
  write('sitemap.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + pages.map((f) => `  <url><loc>${origin}/${f === 'index.html' ? '' : f}</loc></url>\n`).join('') + '</urlset>\n'));
  console.log(`site: ${files.length} files (${split} in parts), ${(bytes / 1e6).toFixed(1)} MB -> ${OUT}`);
}

/** sources/freedos/index.html: the packages to download, what they are, where they come from. */
function sourcesPage(zips) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows = zips.map((z) => { const n = basename(z, '.zip'), mb = (readFileSync(z).length / 1048576).toFixed(1);
    return `<tr><td><a href="${n}.zip" download>${n}.zip</a></td><td>${mb} MB</td><td class="h">${PACKAGES[n]}</td></tr>`; }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FreeDOS 1.4 sources — MIRAGE</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg: #0a0e12; --ink: #b8c8d4; --dim: #6a8090; --accent: #00d0a0; }
  html { background: var(--bg); }
  body { margin: 0; color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px; }
  h1 { margin: 0 0 12px; font: 600 24px ui-monospace, "SF Mono", Menlo, monospace; color: #e6eef4; }
  p { color: var(--dim); } a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
  td { padding: 3px 12px 3px 0; white-space: nowrap; } td.h { color: var(--dim); overflow: hidden; text-overflow: ellipsis; max-width: 0; width: 100%; }
</style>
</head>
<body>
<main>
  <h1>FreeDOS 1.4 — the disk's source</h1>
  <p>MIRAGE's FreeDOS disk (<a href="../../examples/boot/freedos.img.gz">freedos.img.gz</a>) holds the programs
    of these packages without their <code>SOURCE</code> directories. Here are the packages whole, unmodified, as the
    FreeDOS project publishes them at <a href="${esc(UPSTREAM)}">ibiblio</a>: each holds its programs' source code
    and its licence (<code>APPINFO/*.LSM</code>). Most are under the GNU GPL, version 2;
    <a href="../../examples/licenses/freedos.txt">the disk's licence notes</a> list each one.</p>
  <table>
${rows}
  </table>
  <p><a href="SHA256SUMS">SHA256SUMS</a> · <a href="README.txt">README.txt</a> · the same files as
    <a href="https://github.com/${RELEASE.repo}/releases/tag/${RELEASE.tag}">a release on GitHub</a> ·
    <a href="../../">MIRAGE's home page</a></p>
</main>
</body>
</html>
`;
}
