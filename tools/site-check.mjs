// site-check.mjs — what must hold of the static export (tools/site.mjs) before it goes on a host.
//
//   node tools/site-check.mjs [<export dir>]      default site/
//   node tools/site-check.mjs --selftest          each check made to fail on a damaged copy
//
// 1. No file over 25 MiB, the most Cloudflare Pages takes.
// 2. Nothing but what the repository tracks and site.mjs ships (and the parts it cut, _headers, robots.txt,
//    sitemap.xml and sources/freedos/, check 8):
//    the disks and games MIRAGE does not own — boot/, games/, intros/ — can never reach a host.
// 3. Everything the pages list is there: each example's file, screenshot and licence, each gallery
//    screenshot, each OASIS image's manifest and screenshot (a file in parts counts as there).
// 4. No path from the host's root in the pages' code: an export must work under a path. The OASIS
//    server's own endpoints (/oasis-fs/, /oasis-image.json, /oasis-images.json) are the exception: a
//    page asks them first and builds images itself when they are absent.
// 5. The oasis-fetch relay is there to deploy with it (functions/oasis-fetch.js, beside the export).
// 6. Every module a page loads is there: each relative import of a shipped script, each script a page
//    names. A module written but not yet committed is not tracked, so not shipped: the page then got
//    an HTML 404 for src/fetch-whole.js and refused it ("Expected a JavaScript module script").
// 7. A 404.html: without one Cloudflare Pages takes the site for a single-page app and answers a
//    missing path with index.html and a 200, which src/fetch-whole.js would take for the file.
// 8. The FreeDOS disk's source beside it (GPL v2, section 3): in sources/freedos/, every package the
//    disk is built from, whole, with the SHA-256 the disk's C:\SOURCES.TXT lists — and nothing else there.
import { readdirSync, statSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MAX, SHIPPED, prismShipped } from './site.mjs';
import { PACKAGES } from './freedos-sources.mjs';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_ONLY = /^\/oasis-(fs\/|image\.json|images\.json)/;

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
}

/** The problems of the export in `dir`, one line each; none is a pass. */
export function check(dir, root = ROOT) {
  const bad = [];
  const files = walk(dir).map((p) => relative(dir, p).split('\\').join('/'));
  const have = new Set(files);
  const there = (p) => have.has(p) || have.has(p + '.parts.json');
  const tracked = new Set(spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean));
  const prism = new Set(prismShipped(root));            // the submodule's modules the pages import (site.mjs)
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    if (size > MAX) bad.push(`1 ${f}: ${(size / 1048576).toFixed(1)} MiB, over 25 MiB`);
    const base = f.replace(/\.(part\d+|parts\.json)$/, '');
    if (f.startsWith('sources/freedos/')) continue;      // check 8
    if (!['_headers', 'robots.txt', 'sitemap.xml'].includes(f) && !(tracked.has(base) && SHIPPED(base)) && !prism.has(base)) bad.push(`2 ${f}: not a file the repository tracks and ships`);
    if (/^(boot|games|intros)\//.test(f)) bad.push(`2 ${f}: from a directory MIRAGE does not own`);
  }
  const json = (p) => { try { return JSON.parse(readFileSync(join(dir, p), 'utf8')); } catch { bad.push(`3 ${p}: missing or unreadable`); return []; } };
  for (const e of json('examples/manifest.json')) {
    for (const p of [e.file, e.licenseFile, `examples/thumbs/${e.id}.png`, ...(e.add || [])]) if (p && !/^https?:/.test(p) && !there(p)) bad.push(`3 ${p}: listed by examples/manifest.json (${e.id}), absent`);
  }
  for (const g of json('examples/gallery.json')) if (g.thumb && !there(g.thumb)) bad.push(`3 ${g.thumb}: gallery screenshot absent`);
  for (const m of json('oasis/index.json')) {
    if (!there(`oasis/images/${m.name}.json`)) bad.push(`3 oasis/images/${m.name}.json: absent`);
    if (m.thumb && !there(m.thumb)) bad.push(`3 ${m.thumb}: absent`);
  }
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/\b(?:fetch|open)\(\s*[`'"](\/[^`'"]*)/g)) if (!SERVER_ONLY.test(m[1])) bad.push(`4 ${f}: fetches ${m[1]} from the host's root`);
    for (const m of text.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)) bad.push(`4 ${f}: links ${m[1]} from the host's root`);
  }
  if (!existsSync(join(root, 'functions', 'oasis-fetch.js'))) bad.push('5 functions/oasis-fetch.js: the relay is missing');
  if (!existsSync(join(dir, '404.html'))) bad.push('7 404.html: without it Cloudflare Pages answers a missing path with index.html and a 200');
  const SRC = 'sources/freedos/', extra = new Set(['index.html', 'README.txt', 'SHA256SUMS']);
  for (const [n, sha] of Object.entries(PACKAGES)) {
    const p = `${SRC}${n}.zip`;
    if (!have.has(p)) bad.push(`8 ${p}: the source of the FreeDOS disk's ${n} package is absent`);
    else if (createHash('sha256').update(readFileSync(join(dir, p))).digest('hex') !== sha) bad.push(`8 ${p}: not the package the disk is built from`);
  }
  for (const f of files.filter((f) => f.startsWith(SRC))) if (!extra.has(f.slice(SRC.length)) && !(f.endsWith('.zip') && Object.hasOwn(PACKAGES, f.slice(SRC.length, -4)))) bad.push(`8 ${f}: not a package of the FreeDOS disk`);
  const resolve = (from, spec) => { const parts = (dirname(from) === '.' ? [] : dirname(from).split('/')); for (const x of spec.split('?')[0].split('/')) { if (x === '..') parts.pop(); else if (x !== '.') parts.push(x); } return parts.join('/'); };
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) if (!have.has(resolve(f, m[1]))) bad.push(`6 ${f}: imports ${m[1]}, not in the export`);
  }
  for (const f of files.filter((f) => f.endsWith('.html'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/<script[^>]*\bsrc="([^":]+)"/g)) if (!have.has(resolve(f, m[1].replace(/^\.\//, '')))) bad.push(`6 ${f}: loads ${m[1]}, not in the export`);
  }
  return bad;
}

// Each check, made to fail: a copy of the export damaged one way at a time.
function selftest() {
  const site = join(ROOT, 'site');
  if (!existsSync(site)) { console.error('site-check: build site/ first (node tools/site.mjs)'); process.exit(2); }
  const damages = [
    ['1', (d) => writeFileSync(join(d, 'examples', 'big.bin'), Buffer.alloc(MAX + 1))],
    ['2', (d) => { spawnSync('mkdir', ['-p', join(d, 'games')]); writeFileSync(join(d, 'games', 'x.zip'), 'x'); }],
    ['3', (d) => rmSync(join(d, 'examples', 'licenses'), { recursive: true, force: true })],
    ['4', (d) => appendFileSync(join(d, 'src', 'main.js'), "\nfetch('/games/manifest.json');\n")],
    ['6', (d) => rmSync(join(d, 'src', 'fetch-whole.js'))],
    ['7', (d) => rmSync(join(d, '404.html'))],
    ['8', (d) => rmSync(join(d, 'sources', 'freedos', 'kernel.zip'))],
  ];
  let ok = check(site).length === 0;
  console.log(`site-check selftest: the export as built ${ok ? 'passes' : 'FAILS'}`);
  for (const [n, damage] of damages) {
    const d = mkdtempSync(join(tmpdir(), 'site-check-'));
    spawnSync('cp', ['-Rc', site + '/.', d]);                     // APFS clones: no time, no space
    damage(d);
    const caught = check(d).some((l) => l.startsWith(n + ' '));
    console.log(`  check ${n}: ${caught ? 'caught' : 'MISSED'} its damage`);
    ok = ok && caught;
    rmSync(d, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) selftest();
  const dir = process.argv[2] || join(ROOT, 'site');
  const bad = check(dir);
  for (const l of bad) console.log('  ' + l);
  console.log(`site-check: ${bad.length ? bad.length + ' problem(s)' : 'the export may go on a host'} (${relative(process.cwd(), dir) || '.'})`);
  process.exit(bad.length ? 1 : 0);
}
