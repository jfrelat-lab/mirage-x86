// deploy.mjs — build the static export, check it, and put it on Cloudflare Pages.
//
//   node tools/deploy.mjs                      a preview: https://preview.mirage-x86.pages.dev
//   node tools/deploy.mjs --branch=<name>      a preview under another name: https://<name>.mirage-x86.pages.dev
//   node tools/deploy.mjs --production         https://mirage-x86.pages.dev (a clean tree only)
//   ... --skip-build                           send site/ as it is
//
// Direct upload, never Cloudflare's Git build: the export is made by tools/site.mjs. wrangler must be
// logged in (npx wrangler login). It runs from the repository, whose functions/ holds the
// oasis-fetch relay (functions/oasis-fetch.js) that pages use to build OASIS Linux images.
//
// PREVIEWS ARE CLOSED by Cloudflare Access, set on the project (Settings > General > Access policy):
// a visitor signs in, and only the addresses its policy names get through. Nothing in the deployment
// does it, so production and previews are the same static files; this script checks, after sending,
// that a preview answers with Access's sign-in and that production answers openly.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = 'mirage-x86';
const WRANGLER = 'wrangler@4.151.1';
const SITE = join(ROOT, 'site');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => process.argv.includes(`--${n}`);
const production = flag('production');
const branch = production ? 'main' : (arg('branch') ?? 'preview');
const die = (msg) => { console.error(`deploy: ${msg}`); process.exit(1); };
const run = (cmd, args) => {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) die(`${cmd} ${args[0] ?? ''} failed`);
};
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).stdout.trim();

const dirty = git('status', '--porcelain') !== '';
if (production && dirty) die('production is deployed from a clean tree: commit first (git status shows changes)');

if (!flag('skip-build')) run('node', ['tools/site.mjs']);
run('node', ['tools/site-check.mjs', SITE]);

const sha = git('rev-parse', 'HEAD'), subject = git('log', '-1', '--format=%s');
run('npx', ['--yes', WRANGLER, 'pages', 'deploy', SITE, `--project-name=${PROJECT}`, `--branch=${branch}`,
  `--commit-hash=${sha}`, `--commit-message=${subject}`, `--commit-dirty=${dirty}`]);

// What a visitor gets: production open, its relay answering; a preview behind Access's sign-in.
const url = production ? `https://${PROJECT}.pages.dev/` : `https://${branch}.${PROJECT}.pages.dev/`;
const closed = (r) => r && r.status === 302 && /cloudflareaccess\.com/.test(r.headers.get('location') || '');
let res = null;
for (let i = 0; i < 10; i++) {
  res = await fetch(url, { redirect: 'manual' }).catch(() => null);
  if (production ? res && res.status === 200 : closed(res)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (production) {
  if (!res || res.status !== 200) die(`${url} answers ${res && res.status}: check it before announcing anything`);
  const probe = 'http://archive.debian.org/debian-archive/debian/dists/bo/main/binary-i386/base/ldso_1.8.12-1.deb';
  const relay = await fetch(`${url}oasis-fetch?url=${encodeURIComponent(probe)}`).catch(() => null);
  if (!relay || relay.status !== 200 || relay.headers.get('access-control-allow-origin') !== '*') die(`the oasis-fetch relay answers ${relay && relay.status}: OASIS Linux images will not build`);
  console.log(`\n${url} is live, and its oasis-fetch relay answers.`);
} else {
  if (!closed(res)) die(`${url} answers ${res && res.status} without signing in: Cloudflare Access is not closing previews (Settings > General > Access policy)`);
  console.log(`\n${url} is up, behind Cloudflare Access.`);
}
