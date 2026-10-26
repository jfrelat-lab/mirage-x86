#!/usr/bin/env node
// oasis.mjs — OASIS: images of the period PC, run on MIRAGE (ROADMAP O1-O2; the format is
// docs/OASIS.md).
//
//   node tools/oasis.mjs list                       the images in oasis/images/
//   node tools/oasis.mjs inspect <image>            its manifest, and which layers are cached
//   node tools/oasis.mjs pull <image>               fetch and unpack its remote layers into the cache
//   node tools/oasis.mjs run <image> [args...]      run it (pulls first if needed); --user=<name> names the Linux user
//                                                   (default $OASIS_USER, else this computer's login)
//   node tools/oasis.mjs serve [--open]             every image, for machines.html (Linux images need it)
//   node tools/oasis.mjs serve --static             the files and the oasis-fetch relay only, as a static host
//                                                   with functions/oasis-fetch.js serves them: pages build images themselves
//   node tools/oasis.mjs index                      write oasis/index.json, the list oasis.html reads
//       --window      in a window of its own: the system's Chrome or Edge in app mode, else the browser
//       --terminal    in this terminal: its output on stdout, our stdin as its keyboard
//       --serve       a window's page, served without opening it (prints the URL; for tests)
//       (default: the image's `output`)
//
// <image> is a name under oasis/images/ (dos/c-dogs) or a path to a manifest. The cache is
// $OASIS_CACHE or ~/.cache/oasis: one directory per layer, named by the hash of its source.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync,
  symlinkSync, rmSync, mkdtempSync, copyFileSync, renameSync, chmodSync } from 'fs';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { join, dirname, resolve, relative, basename, extname } from 'path';
import { homedir, tmpdir, platform, userInfo } from 'os';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The user's name inside a Linux image: --user=<name>, else $OASIS_USER, else this computer's login. */
const hostUser = () => { const a = process.argv.find((x) => x.startsWith('--user=')); if (a) return a.slice(7); if (process.env.OASIS_USER) return process.env.OASIS_USER; try { return userInfo().username; } catch { return 'player'; } };
const IMAGES = join(ROOT, 'oasis', 'images');
const CACHE = process.env.OASIS_CACHE || join(homedir(), '.cache', 'oasis');
let SERVE_ONLY = false, STATIC_ONLY = false;

// ---- images ---------------------------------------------------------------------------------------
function findImage(name) {
  const p = existsSync(name) && name.endsWith('.json') ? resolve(name) : join(IMAGES, name + '.json');
  if (!existsSync(p)) throw new Error(`oasis: no image "${name}" (looked for ${relative(process.cwd(), p)})`);
  const m = JSON.parse(readFileSync(p, 'utf8'));
  if (m.oasis !== 1) throw new Error(`oasis: ${p} is not an OASIS v1 manifest`);
  return { ...m, name: m.name || name, path: p };
}
function listImages(dir = IMAGES, pre = '') {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...listImages(p, pre + f + '/'));
    else if (f.endsWith('.json')) out.push(pre + f.slice(0, -5));
  }
  return out;
}

// ---- layers ---------------------------------------------------------------------------------------
// A layer is a source of files. Local ones (repository paths) are used where they are; remote ones
// (URLs, Debian packages, Docker images) are fetched once and unpacked into the cache.
const isUrl = (s) => /^https?:\/\//.test(s);
const local = (s) => resolve(ROOT, s);
const layerKey = (l) => createHash('sha256').update(JSON.stringify(l)).digest('hex').slice(0, 16);
const cacheDir = (l) => join(CACHE, 'layers', layerKey(l));
const needsPull = (l) => (l.tar || l.deb || l.docker || l.lha || l.busybox || l.member || ((l.zip || l.file || l.gz) && isUrl(l.zip || l.file || l.gz)));

async function fetchBytes(src) {
  if (!isUrl(src)) return readFileSync(local(src));
  process.stderr.write(`oasis: fetching ${src}\n`);
  const r = await fetch(src);
  if (!r.ok) throw new Error(`oasis: ${src}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** ustar / GNU tar, as `docker export` and Debian packages write it: files, directories, symbolic
 *  and hard links, long names. Device nodes and FIFOs are skipped (MIRAGE-LINUX provides /dev). */
function untar(buf, dest) {
  let o = 0, longName = null;
  const str = (a, n) => { let s = ''; for (let i = 0; i < n && buf[a + i]; i++) s += String.fromCharCode(buf[a + i]); return s; };
  const oct = (a, n) => parseInt(str(a, n).trim() || '0', 8);
  const hard = [];
  while (o + 512 <= buf.length) {
    if (buf[o] === 0) break;
    let name = longName || (str(o + 345, 155) ? str(o + 345, 155) + '/' : '') + str(o, 100);
    longName = null;
    const size = oct(o + 124, 12), type = String.fromCharCode(buf[o + 156] || 48), link = str(o + 157, 100);
    const mode = oct(o + 100, 8), mtime = oct(o + 136, 12);
    const data = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = Buffer.from(data).toString('latin1').replace(/\0.*$/s, ''); continue; }   // GNU long name
    if (type === 'x' || type === 'g') continue;                                // pax headers
    name = name.replace(/^\.?\/+/, '');
    if (!name || name.split('/').includes('..')) continue;
    const to = join(dest, name);
    if (type === '5') { mkdirSync(to, { recursive: true }); continue; }
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to) || isLink(to)) rmSync(to, { recursive: true, force: true });
    if (type === '2') { symlinkSync(link, to); continue; }
    if (type === '1') { hard.push([link.replace(/^\.?\/+/, ''), to]); continue; }
    if (type !== '0' && type !== '7') continue;                                // 3 4 6: devices, FIFOs
    writeFileSync(to, data, { mode: mode & 0o777 });
    void mtime;
  }
  for (const [from, to] of hard) { try { copyFileSync(join(dest, from), to); } catch { /* target outside */ } }
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** A Debian package: an `ar` archive whose data.tar.{gz,xz} is the file tree. */
function undeb(buf, dest) {
  if (buf.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error('oasis: not a .deb');
  let o = 8;
  while (o + 60 <= buf.length) {
    const name = buf.toString('latin1', o, o + 16).trim().replace(/\/$/, ''), size = parseInt(buf.toString('latin1', o + 48, o + 58), 10);
    const data = buf.subarray(o + 60, o + 60 + size);
    if (name === 'data.tar.gz') { untar(gunzipSync(data), dest); return; }
    if (name === 'data.tar') { untar(data, dest); return; }
    if (name.startsWith('data.tar')) throw new Error(`oasis: ${name} in a .deb is not supported yet`);
    o += 60 + size + (size & 1);
  }
  throw new Error('oasis: no data.tar in the .deb');
}

async function pullLayer(l) {
  const dir = cacheDir(l);
  if (existsSync(join(dir, '.oasis-done'))) return dir;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  if (l.docker) {
    process.stderr.write(`oasis: exporting the Docker image ${l.docker} (${l.platform || 'linux/386'})\n`);
    const c = spawnSync('docker', ['create', '--platform', l.platform || 'linux/386', l.docker], { encoding: 'utf8' });
    if (c.status !== 0) throw new Error(`oasis: docker create ${l.docker}: ${c.stderr}`);
    const id = c.stdout.trim();
    const e = spawnSync('docker', ['export', id], { maxBuffer: 1 << 30 });
    spawnSync('docker', ['rm', id]);
    if (e.status !== 0) throw new Error(`oasis: docker export: ${e.stderr}`);
    untar(e.stdout, dir);
  } else if (l.deb) undeb(await fetchBytes(l.deb), l.into ? join(dir, l.into) : dir);
  else if (l.tar) { const b = await fetchBytes(l.tar); untar(/\.(tgz|gz)$/.test(l.tar) ? gunzipSync(b) : b, l.into ? join(dir, l.into) : dir); }
  else if (l.busybox) {                // a static busybox, and a link per applet as `busybox --install -s` makes
    const bin = join(dir, l.into || 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'busybox'), isUrl(l.busybox) ? await fetchBytes(l.busybox) : readFileSync(local(l.busybox))); chmodSync(join(bin, 'busybox'), 0o755);
    // The applets are the binary's own answer to --list, run on MIRAGE-LINUX itself.
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'linux', 'run.mjs'), join(bin, 'busybox'), '--list'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`oasis: busybox --list: ${r.stderr}`);
    for (const a of r.stdout.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'busybox' && !x.includes('/'))) {
      try { symlinkSync('busybox', join(bin, a)); } catch { /* already there */ }
    }
  }
  else if (l.zip && l.files && !l.lha) { // files of a ZIP, each put where `files` says (an intro's dropper from its party archive)
    const { unzip } = await import(join(ROOT, 'src', 'zip.js'));
    const zb = isUrl(l.zip) ? await fetchBytes(l.zip) : readFileSync(local(l.zip));
    const entries = await unzip(new Uint8Array(zb));
    for (const [from, to] of Object.entries(l.files)) {
      const f = entries.find((e) => e.path === from);
      if (!f) throw new Error(`oasis: ${from} is not in ${l.zip}`);
      mkdirSync(dirname(join(dir, to)), { recursive: true }); writeFileSync(join(dir, to), f.bytes);
    }
  }
  else if (l.zip && l.member) {         // a tar inside a ZIP (id's doomsrc.zip holds linuxdoom-1.10.src.tgz)
    const { unzip } = await import(join(ROOT, 'src', 'zip.js'));
    const zb = isUrl(l.zip) ? await fetchBytes(l.zip) : readFileSync(local(l.zip));
    const inner = (await unzip(new Uint8Array(zb))).find((f) => f.path.toLowerCase() === l.member.toLowerCase());
    if (!inner) throw new Error(`oasis: ${l.member} is not in ${l.zip}`);
    untar(/\.(tgz|gz)$/i.test(l.member) ? gunzipSync(inner.bytes) : Buffer.from(inner.bytes), l.into ? join(dir, l.into) : dir);
  }
  else if (l.lha) {                     // an LHA archive inside a ZIP (Quake's resource.1): the files `files` names, renamed
    const { unzip } = await import(join(ROOT, 'src', 'zip.js')), { unlha } = await import(join(ROOT, 'src', 'lha.js'));
    const zb = isUrl(l.zip) ? await fetchBytes(l.zip) : readFileSync(local(l.zip));
    const inner = (await unzip(new Uint8Array(zb))).find((f) => f.path.toLowerCase() === l.lha.toLowerCase());
    if (!inner) throw new Error(`oasis: ${l.lha} is not in ${l.zip}`);
    const base = l.into ? join(dir, l.into) : dir;
    for (const f of unlha(inner.bytes)) {
      const to = l.files ? l.files[f.path] : f.path;
      if (!to) continue;
      mkdirSync(dirname(join(base, to)), { recursive: true }); writeFileSync(join(base, to), f.bytes);
    }
  }
  else {                                                                       // a remote zip, file or gz
    const src = l.zip || l.file || l.gz, b = await fetchBytes(src);
    writeFileSync(join(dir, basename(src.split('?')[0]).replace(/\.gz$/, l.gz ? '' : '.gz')), l.gz ? gunzipSync(b) : b);
  }
  writeFileSync(join(dir, '.oasis-done'), JSON.stringify(l));
  return dir;
}
async function pull(img) {
  for (const l of img.layers || []) if (needsPull(l)) await pullLayer(l);
  if (img.world === 'linux' && (img.layers || []).some((l) => l.run)) await linuxRoot(img);   // builds its `run` layers
}

/** A `run` layer: a command run once on MIRAGE-LINUX over the layers before it, what it wrote kept as
 *  a layer — a Dockerfile's RUN. Its cache key covers every layer up to it, local files' bytes too,
 *  so changing anything below builds it again. */
const chainStep = (chain, l) => {
  const h = createHash('sha256').update(chain).update(JSON.stringify(l));
  const src = l.file || l.gz || l.zip;
  if (src && !isUrl(src) && existsSync(local(src))) h.update(readFileSync(local(src)));
  return h.digest('hex');
};
const RUN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';   // Docker's default PATH for a RUN
const runDir = (chain) => join(CACHE, 'layers', 'run-' + chain.slice(0, 16));
async function runLayer(l, root, dir) {
  if (existsSync(join(dir, '.oasis-done'))) return dir;
  const tmp = dir + '.part';
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const spec = join(CACHE, 'run-' + process.pid + '-build.json');
  writeFileSync(spec, JSON.stringify({ dirs: root.dirs, files: [...root.files], links: [...root.links], mkdirs: [...root.mkdirs] }));
  process.stderr.write(`oasis: building a layer: ${l.run} (in ${l.cwd || '/'})\n`);
  const t0 = Date.now();
  const code = await new Promise((ok) => {
    const p = spawn(process.execPath, [join(ROOT, 'tools', 'linux', 'run.mjs'), '/bin/sh', '-c', l.run], { stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, MIRAGE_LXROOTSPEC: spec, MIRAGE_LXCWD: l.cwd || '/', MIRAGE_LXCOMMIT: tmp, MIRAGE_LXENV: JSON.stringify({ PATH: RUN_PATH, ...(l.env || {}) }), MIRAGE_CPU: l.cpu || '686' } });
    p.on('exit', (c) => ok(c));
  });
  rmSync(spec, { force: true });
  if (code !== 0 || !existsSync(join(tmp, '.oasis-gone'))) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`oasis: the layer "${l.run}" failed (status ${code})`); }
  writeFileSync(join(tmp, '.oasis-done'), JSON.stringify(l));
  rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir);
  process.stderr.write(`oasis: layer built in ${Math.round((Date.now() - t0) / 1000)} s -> ${dir}\n`);
  return dir;
}

/** The image's file tree as an ordered list of host directories (later layers win), plus the
 *  files, links and directories laid on top — what MIRAGE-LINUX reads lazily through lx.host. */
async function linuxRoot(img) {
  const dirs = [], files = new Map(), links = new Map(), mkdirs = new Set();
  let chain = '';
  for (const l of img.layers || []) {
    chain = chainStep(chain, l);
    if (l.run) dirs.push(await runLayer(l, { dirs: [...dirs], files, links, mkdirs }, runDir(chain)));
    else if (l.dir) dirs.push(local(l.dir));
    else if (l.tar || l.deb || l.docker || l.lha || l.busybox || (l.zip && (l.member || l.files))) dirs.push(await pullLayer(l));
    else if (l.gz || l.file) {
      const src = l.gz || l.file;
      let host = needsPull(l) ? join(await pullLayer(l), basename(src.split('?')[0]).replace(/\.gz$/, '')) : local(src);
      if (l.gz && !needsPull(l)) {                                                // a local .gz: unpacked once into the cache
        const out = join(cacheDir(l), basename(src).replace(/\.gz$/, ''));
        if (!existsSync(out)) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, gunzipSync(readFileSync(host))); }
        host = out;
      }
      files.set(l.to, host);
    } else if (l.links) for (const [p, t] of Object.entries(l.links)) links.set(p, t);
    else if (l.mkdir) for (const p of [].concat(l.mkdir)) mkdirs.add(p);
  }
  return { dirs, files, links, mkdirs };
}

/** lx.host over a linuxRoot: lstat, read, list — in Node directly, and for the browser page. */
function hostOver(root) {
  // A `run` layer lists the paths its run removed (.oasis-gone): they, and what is under them, are
  // not seen in the layers below it.
  const gone = root.dirs.map((d) => { try { return new Set(JSON.parse(readFileSync(join(d, '.oasis-gone'), 'utf8'))); } catch { return null; } });
  const hides = (i, p) => { const g = gone[i]; if (!g) return false; for (let q = p; q !== '/' && q !== '.'; q = dirname(q)) if (g.has(q)) return true; return false; };
  const find = (p) => { for (let i = root.dirs.length - 1; i >= 0; i--) { const q = join(root.dirs[i], p); try { lstatSync(q); return q; } catch { /* next */ } if (hides(i, p)) return null; } return null; };
  const childOf = (p, k) => k !== p && k.startsWith(p === '/' ? '/' : p + '/') && !k.slice(p === '/' ? 1 : p.length + 1).includes('/');
  const parentsOf = (k) => { const out = []; let d = dirname(k); while (d !== '/' && d !== '.') { out.push(d); d = dirname(d); } return out; };
  const synthDirs = new Set([...root.mkdirs, ...[...root.files.keys(), ...root.links.keys(), ...root.mkdirs].flatMap(parentsOf)]);
  return {
    lstat(p) {
      if (root.links.has(p)) return { type: 'link', target: root.links.get(p) };
      if (root.files.has(p)) { const st = statSync(root.files.get(p)); return { type: 'file', size: st.size, mode: st.mode, mtime: Math.floor(st.mtimeMs / 1000) }; }
      const q = find(p);
      if (q) {
        const st = lstatSync(q), meta = { mode: st.mode, mtime: Math.floor(st.mtimeMs / 1000), nlink: st.nlink };
        return st.isSymbolicLink() ? { type: 'link', target: readlinkSync(q), ...meta } : st.isDirectory() ? { type: 'dir', ...meta } : { type: 'file', size: st.size, ...meta };
      }
      return synthDirs.has(p) || p === '/' ? { type: 'dir' } : null;
    },
    read(p) { const f = root.files.get(p); return new Uint8Array(readFileSync(f !== undefined ? f : find(p))); },
    list(p) {
      const names = new Set();
      root.dirs.forEach((d, i) => {
        if (gone[i]) for (const n of [...names]) if (hides(i, p === '/' ? '/' + n : p + '/' + n)) names.delete(n);
        try { for (const n of readdirSync(join(d, p))) if (p !== '/' || !n.startsWith('.oasis-')) names.add(n); } catch { /* absent here */ }
      });
      for (const k of [...root.files.keys(), ...root.links.keys(), ...root.mkdirs, ...synthDirs]) if (childOf(p, k)) names.add(k.slice(p === '/' ? 1 : p.length + 1));
      return [...names];
    },
  };
}

// ---- DOS: the layers as one C: directory --------------------------------------------------------
async function dosDir(img) {
  const { unzip } = await import(join(ROOT, 'src', 'zip.js'));
  const dir = mkdtempSync(join(tmpdir(), 'oasis-'));
  for (const l of img.layers || []) {
    if (l.zip) {
      const b = needsPull(l) ? readFileSync(join(await pullLayer(l), basename(l.zip))) : readFileSync(local(l.zip));
      // unzip is async and gives { path, bytes }, directories left out (src/zip.js).
      for (const f of await unzip(new Uint8Array(b))) {
        const to = join(dir, f.path.toUpperCase()); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, f.bytes);
      }
    } else if (l.file) copyFileSync(needsPull(l) ? join(await pullLayer(l), basename(l.file)) : local(l.file), join(dir, (l.to || basename(l.file)).toUpperCase()));
    else if (l.dir) spawnSync('cp', ['-R', local(l.dir) + '/.', dir]);
  }
  return dir;
}

// ---- a window -----------------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.zip': 'application/zip', '.wasm': 'application/wasm' };

/** Serve the repository, and for a Linux image its file tree (lstat/list/read), on a free port.
 *  With no image, every image: /oasis-images.json lists them and ?img=<name> picks a tree. */
const hosts = new Map();
async function hostFor(name) {
  if (!hosts.has(name)) hosts.set(name, (async () => { const m = findImage(name); await pull(m); return hostOver(await linuxRoot(m)); })());
  return hosts.get(name);
}
function serve(img, host, port = 0) {
  return new Promise((ok) => {
    const srv = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (code, body, type = 'application/octet-stream') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
      if (STATIC_ONLY && (u.pathname.startsWith('/oasis-fs/') || u.pathname === '/oasis-image.json' || u.pathname === '/oasis-images.json')) return send(404, 'a static host');
      if (u.pathname.startsWith('/oasis-fs/')) {
        const p = u.searchParams.get('p') || '/', op = u.pathname.slice(10), want = u.searchParams.get('img');
        try {
          const h = want ? await hostFor(want) : host;
          if (!h) return send(404, 'no file system');
          if (op === 'lstat') return send(200, JSON.stringify(h.lstat(p)), 'application/json');
          if (op === 'list') return send(200, JSON.stringify(h.list(p)), 'application/json');
          if (op === 'read') return send(200, Buffer.from(h.read(p)));
        } catch (e) { return send(404, String(e.message)); }
        return send(400, 'unknown');
      }
      if (u.pathname === '/oasis-fetch') {                                    // the relay a page uses to build an image itself (src/oasis-web.js)
        const { relayTarget } = await import(join(ROOT, 'src', 'oasis-hosts.js'));
        const target = relayTarget(u.searchParams.get('url') || '');
        if (!target) return send(403, 'oasis-fetch: not a host OASIS images use');
        try {
          const r = await fetch(target);
          if (!r.ok || !relayTarget(r.url)) return send(502, `oasis-fetch: ${target}: HTTP ${r.status}`);
          return send(200, Buffer.from(await r.arrayBuffer()));
        } catch (e) { return send(502, `oasis-fetch: ${e.message}`); }
      }
      if (u.pathname === '/oasis-image.json') {
        const want = u.searchParams.get('img');
        try { return send(200, JSON.stringify({ ...(want ? { ...findImage(want), name: want } : img), hostUser: hostUser() }), 'application/json'); } catch (e) { return send(404, e.message); }
      }
      if (u.pathname === '/oasis-images.json') return send(200, JSON.stringify(imageIndex()), 'application/json');
      let p = join(ROOT, decodeURIComponent(u.pathname));
      if (p.startsWith(ROOT) && existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');   // the logo's "./", as a static host does
      if (!p.startsWith(ROOT) || !existsSync(p) || statSync(p).isDirectory()) return send(404, 'not found');
      send(200, readFileSync(p), MIME[extname(p)] || 'application/octet-stream');
    });
    srv.listen(port, '127.0.0.1', () => ok({ srv, port: srv.address().port }));
  });
}

/** The system's Chrome, Edge or Chromium in app mode — a window with no browser around it — with a
 *  profile of its own, so the window is a process we can wait for. Else the default browser. */
function openWindow(url, title) {
  const candidates = platform() === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : platform() === 'win32'
      ? [join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const exe = candidates.find((c) => existsSync(c));
  if (!exe) {
    spawn(platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    process.stderr.write(`oasis: no Chrome or Edge found; opened ${url} in the default browser (Ctrl-C to stop)\n`);
    return null;
  }
  const profile = join(CACHE, 'window-profile');
  mkdirSync(profile, { recursive: true });
  process.stderr.write(`oasis: ${title} in a window (close it to stop)\n`);
  return spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1000,720'], { stdio: 'ignore' });
}

// ---- run ----------------------------------------------------------------------------------------
async function run(img, args, out) {
  await pull(img);
  const e = img.entry || {}, world = img.world, argv = [...(e.args || []), ...args];
  out = out || img.output || 'terminal';
  if (world === 'dos') {
    if (out === 'window') {
      const zip = (img.layers || []).find((l) => l.zip), adds = (img.layers || []).filter((l) => l.file);
      if (!zip || needsPull(zip)) throw new Error('oasis: a DOS window needs a zip layer from the repository for now');
      const q = new URLSearchParams({ zip: zip.zip, run: e.run.replace(/\.(exe|com|bat)$/i, '') });
      if (argv.length) q.set('args', argv.join(' '));
      if (adds.length) q.set('add', adds.map((l) => l.file).join(','));
      if (img.machine && img.machine.mem) q.set('mem', img.machine.mem);
      return window(img, `dos.html?${q}`);
    }
    const dir = await dosDir(img);
    return child('tools/dos/run.mjs', [join(dir, e.run.toUpperCase()), ...argv], { MIRAGE_CPU: (img.machine && img.machine.cpu) || '586' }, () => rmSync(dir, { recursive: true, force: true }));
  }
  if (world === 'linux') {
    const root = await linuxRoot(img);
    if (out === 'window') return window(img, `linux.html`, hostOver(root));
    const spec = join(CACHE, 'run-' + process.pid + '.json');
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(spec, JSON.stringify({ dirs: root.dirs, files: [...root.files], links: [...root.links], mkdirs: [...root.mkdirs] }));
    return child('tools/linux/run.mjs', [e.run, ...argv], { MIRAGE_LXROOTSPEC: spec, MIRAGE_LXCWD: e.cwd || '/', MIRAGE_LXCONSOLE: e.console ? '1' : '', MIRAGE_CPU: (img.machine && img.machine.cpu) || '686', MIRAGE_LXENV: JSON.stringify(e.env || {}), MIRAGE_LXUSER: hostUser(), MIRAGE_LXHZ: String((img.machine && img.machine.hz) || ''), ...(img.machine && img.machine.vga ? { MIRAGE_VGA: img.machine.vga } : {}) }, () => rmSync(spec, { force: true }));
  }
  throw new Error(`oasis: world "${world}" cannot run yet`);
}
function child(tool, argv, env, done) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(ROOT, tool), ...argv], { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => { done && done(); process.exitCode = code ?? 1; ok(); });
  });
}
async function window(img, page, host) {
  const { srv, port } = await serve(img, host);
  if (SERVE_ONLY) { console.log(`http://127.0.0.1:${port}/${page}`); return new Promise(() => {}); }
  const w = openWindow(`http://127.0.0.1:${port}/${page}`, img.title || img.name);
  if (!w) return new Promise(() => {});                                        // until Ctrl-C
  await new Promise((ok) => w.on('exit', ok));
  srv.close();
}

/** What a listing of the images needs, without their layers: the server's /oasis-images.json, and
 *  oasis/index.json for a static host, which cannot list a directory. */
function imageIndex() {
  return listImages().map((n) => { const m = findImage(n); return { name: n, title: m.title, world: m.world, year: m.year, author: m.author, thumb: m.thumb, output: m.output }; });
}
const indexText = () => JSON.stringify(imageIndex(), null, 2) + '\n';

// ---- command line ---------------------------------------------------------------------------------
export { findImage, listImages, linuxRoot, hostOver, untar, undeb, indexText, dosDir };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a === '--window' || a === '--terminal' || a === '--serve'), args = rest.filter((a) => !flags.includes(a) && !a.startsWith('--user='));
  try {
    if (cmd === 'list') for (const n of listImages()) { const m = findImage(n); console.log(`${n.padEnd(28)} ${m.world.padEnd(6)} ${m.title || ''}`); }
    else if (cmd === 'inspect') {
      const m = findImage(name); console.log(JSON.stringify(m, null, 2));
      let chain = '';
      for (const l of m.layers || []) {
        chain = chainStep(chain, l);
        if (l.run) console.log((existsSync(join(runDir(chain), '.oasis-done')) ? 'built   ' : 'to build') + JSON.stringify(l));
        else if (needsPull(l)) console.log((existsSync(join(cacheDir(l), '.oasis-done')) ? 'cached  ' : 'remote  ') + JSON.stringify(l));
      }
    }
    else if (cmd === 'pull') { await pull(findImage(name)); console.error('oasis: pulled'); }
    else if (cmd === 'index') { writeFileSync(join(ROOT, 'oasis', 'index.json'), indexText()); console.error('oasis: wrote oasis/index.json'); }
    else if (cmd === 'serve') {
      const port = Number(process.env.OASIS_PORT) || 0;
      STATIC_ONLY = [name, ...rest].includes('--static');
      const { port: p } = await serve(null, null, port);
      const url = `http://127.0.0.1:${p}/machines.html`;
      console.log(url);
      if ([name, ...rest].includes('--open')) openWindow(url, 'MIRAGE');
      await new Promise(() => {});
    }
    else if (cmd === 'run') { SERVE_ONLY = flags.includes('--serve'); await run(findImage(name), args, flags.includes('--window') || SERVE_ONLY ? 'window' : flags.includes('--terminal') ? 'terminal' : null); }
    else { console.error('usage: node tools/oasis.mjs list | inspect <image> | pull <image> | run <image> [--window|--terminal] [args...]'); process.exitCode = 2; }
  } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
}
