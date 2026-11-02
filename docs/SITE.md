# The static site

How [mirage-x86.pages.dev](https://mirage-x86.pages.dev) is made, and how to put MIRAGE's pages on a
host of your own. The README's [Quick start](../README.md#quick-start) covers running MIRAGE locally.

## Building it

`node tools/site.mjs` writes `site/`, the pages as any static host serves them. It ships only files
git tracks, from the pages' own directories: the pages and their styles, `src/`, the examples with
their licences (`examples/`), the demos, the VGA fonts and the link-preview card (`assets/`), and
OASIS's manifests, files and screenshots (`oasis/`). From the PRISM submodule it ships the modules
`gl.js`, `glu.js` and `d3d9.js` import, PRISM's `LICENSE` and its `THIRD-PARTY.md`. The tools, the
documentation and the tests stay in the repository; the pages link to them on GitHub. `site/` is
never committed.

- A file over 25 MiB, the most Cloudflare Pages takes, goes in parts (`<file>.part0`, `.part1`, …
  and `<file>.parts.json`), joined back in the page by `src/fetch-whole.js`: the FreeDOS disk.
- `404.html` is what a missing path answers. Without it Cloudflare Pages answers every missing path
  with `index.html` and a 200, which `fetch-whole.js` would take for the file.
- `robots.txt` and `sitemap.xml` are written for `--origin` (`https://mirage-x86.pages.dev` by
  default).
- MIRAGE needs no cross-origin isolation (it uses no `SharedArrayBuffer`); `_headers` only sets
  `nosniff`, the referrer policy and revalidation for `src/`.

## Checking it

`node tools/site-check.mjs` says whether an export may go on a host: no file over 25 MiB; nothing
the repository does not track and ship (so `boot/`, `games/` and `intros/` can never reach a host);
every example's file, screenshot and licence, every OASIS image's manifest and screenshot present;
no path from the host's root in the pages' code, so an export works under any path; the relay
present; every module a page loads present; a `404.html`. `--selftest` damages a copy once per
check and expects each check to catch it.

## The OASIS relay

OASIS images are built in the page from archives on Debian's, idgames' and scene.org's servers,
which send no CORS headers. `functions/oasis-fetch.js` (a Cloudflare Pages Function) fetches them
for the page from the hosts `src/oasis-hosts.js` names and no other, and hands the bytes on
unchanged. `node tools/oasis.mjs serve` and `tools/serve.py` answer the same requests at home.

## Hosting it

`node tools/deploy.mjs` builds, checks and uploads the export to Cloudflare Pages with wrangler
(which must be logged in), from the repository, so that `functions/` goes with it:

- without arguments, a preview at `preview.mirage-x86.pages.dev`; `--branch=<name>` another one.
  Previews are closed by Cloudflare Access, set on the project, and the script checks that an
  anonymous request is sent to its sign-in;
- `--production` deploys `mirage-x86.pages.dev` from a clean tree only, and checks that it answers
  openly and that the relay answers with `Access-Control-Allow-Origin: *`.

Any other static host serves `site/` as it is; without the relay, the OASIS images that need
archives from elsewhere do not build, and everything else runs.
