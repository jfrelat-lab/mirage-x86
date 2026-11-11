// oasis-layers.js — an OASIS image's file tree built from its layers, in the browser as in Node.
//
// tools/oasis.mjs unpacks each layer into a directory of the host's and lays them over each other;
// a page has no such directories, and its OASIS server used to do that work for it (/oasis-fs). This
// module does it with no server: it reads the period's archive formats — tar, Debian's `ar` packages,
// gzip, ZIP (src/zip.js), LHA (src/lha.js) — into one tree in memory, later layers over earlier ones,
// and answers MIRAGE-LINUX's file system from it (lx.host: lstat, list, read).
//
// The archives are fetched as their authors published them: a page goes through a narrow CORS relay
// (`fetchBytes` is the host's), since Debian's archive and idgames' mirrors send no CORS headers.
// Layers that are programs — `busybox` (its applets are its own --list) and `run` (a command whose
// results become a layer, a Dockerfile's RUN) — run on MIRAGE-LINUX itself, here, in slices so a
// page stays responsive; a run layer's result is kept in `cache` under a hash of every layer up to
// it, as tools/oasis.mjs keeps it on disk. `docker` layers need the docker command: not here.

import { Machine } from './machine.js';
import { installBIOS } from './bios.js';
import { installLinux } from './linux.js';
import { unzip } from './zip.js';
import { unlha } from './lha.js';
import { wiseLayer } from './wise.js';
import { didiLayer } from './didi.js';

const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const enc = new TextEncoder();
const latin1 = (b, a, n) => { let s = ''; for (let i = 0; i < n && b[a + i]; i++) s += String.fromCharCode(b[a + i]); return s; };

/** gzip, with the platform's DecompressionStream (a browser, Node 18+). */
export async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const isGzip = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;

/** sha256 of a string or bytes, in hex (WebCrypto: a browser, Node 19+). */
export async function sha256(x) {
  const d = await crypto.subtle.digest('SHA-256', typeof x === 'string' ? enc.encode(x) : x);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The entries of a ustar / GNU tar archive, as `docker export` and Debian packages write it:
 *  { path, type: 'file'|'dir'|'link'|'hard', mode, mtime, data, link }. Long names (GNU 'L') are
 *  followed, pax headers skipped; device nodes and FIFOs are left out (MIRAGE-LINUX provides /dev). */
export function tarEntries(buf) {
  const out = [];
  let o = 0, longName = null;
  const oct = (a, n) => parseInt(latin1(buf, a, n).trim() || '0', 8);
  while (o + 512 <= buf.length) {
    if (buf[o] === 0) break;
    let name = longName || (latin1(buf, o + 345, 155) ? latin1(buf, o + 345, 155) + '/' : '') + latin1(buf, o, 100);
    longName = null;
    const size = oct(o + 124, 12), type = String.fromCharCode(buf[o + 156] || 48), link = latin1(buf, o + 157, 100);
    const mode = oct(o + 100, 8) & 0o7777, mtime = oct(o + 136, 12);
    const data = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = latin1(data, 0, data.length); continue; }
    if (type === 'x' || type === 'g') continue;
    name = name.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!name || name.split('/').includes('..')) continue;
    if (type === '5') out.push({ path: name, type: 'dir', mode, mtime });
    else if (type === '2') out.push({ path: name, type: 'link', mode, mtime, link });
    else if (type === '1') out.push({ path: name, type: 'hard', mode, mtime, link: link.replace(/^\.?\/+/, '') });
    else if (type === '0' || type === '7') out.push({ path: name, type: 'file', mode, mtime, data });
  }
  return out;
}

/** A tar archive of `entries` (as tarEntries gives them): how a run layer's result is cached. */
export function tarWrite(entries) {
  const parts = [];
  const header = (name, size, type, mode, mtime, link = '') => {
    const h = new Uint8Array(512), put = (s, a, n) => { const b = enc.encode(s); h.set(b.subarray(0, n), a); };
    const oct = (v, n) => v.toString(8).padStart(n - 1, '0');
    if (enc.encode(name).length > 100) {                                    // GNU long name
      const nb = enc.encode(name + '\0');
      parts.push(header('././@LongLink', nb.length, 'L', 0, 0), nb, new Uint8Array((512 - (nb.length % 512)) % 512));
    }
    put(name, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
    put(oct(size, 12), 124, 12); put(oct(Math.max(0, mtime | 0), 12), 136, 12); put(type, 156, 1); put(link, 157, 100);
    put('ustar\x0000', 257, 8);
    for (let i = 148; i < 156; i++) h[i] = 32;
    let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
    put(oct(sum, 7) + '\0', 148, 8);
    return h;
  };
  for (const e of entries) {
    const data = e.type === 'file' ? e.data : new Uint8Array(0);
    parts.push(header(e.path, data.length, e.type === 'dir' ? '5' : e.type === 'link' ? '2' : '0', e.mode ?? 0o644, e.mtime ?? 0, e.link || ''));
    if (data.length) parts.push(data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A Debian package (`ar`): its data.tar(.gz). */
export async function debData(buf) {
  if (latin1(buf, 0, 8) !== '!<arch>\n') throw new Error('oasis: not a .deb');
  let o = 8;
  while (o + 60 <= buf.length) {
    const name = latin1(buf, o, 16).trim().replace(/\/$/, ''), size = parseInt(latin1(buf, o + 48, 10), 10);
    const data = buf.subarray(o + 60, o + 60 + size);
    if (name === 'data.tar.gz') return gunzip(data);
    if (name === 'data.tar') return data;
    if (name.startsWith('data.tar')) throw new Error(`oasis: ${name} in a .deb is not supported yet`);
    o += 60 + size + (size & 1);
  }
  throw new Error('oasis: no data.tar in the .deb');
}

// ---- the tree ---------------------------------------------------------------------------------------
const parentOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const joinP = (d, n) => (d === '/' ? '/' + n : d + '/' + n);
const norm = (p) => '/' + p.split('/').filter((x) => x && x !== '.').join('/');

/** One file tree, later writes over earlier ones: what the layers make together. */
export class Tree {
  constructor() { this.nodes = new Map([['/', { type: 'dir', mode: 0o755, mtime: 0 }]]); this.kids = new Map([['/', new Set()]]); }
  _link(p) {
    const d = parentOf(p);
    if (!this.nodes.has(d)) this.mkdir(d);
    this.kids.get(d).add(p.slice(d === '/' ? 1 : d.length + 1));
  }
  mkdir(p, mode = 0o755, mtime = 0) {
    p = norm(p);
    const n = this.nodes.get(p);
    if (n && n.type === 'dir') { if (mode !== undefined) n.mode = mode; return; }
    if (n) this.remove(p);
    this.nodes.set(p, { type: 'dir', mode, mtime }); this.kids.set(p, new Set()); this._link(p);
  }
  put(p, node) {
    p = norm(p);
    const old = this.nodes.get(p);
    if (old && old.type === 'dir') this.remove(p);
    this.nodes.set(p, node); this._link(p);
  }
  file(p, data, mode = 0o644, mtime = 0) { this.put(p, { type: 'file', data, mode, mtime }); }
  symlink(p, target, mtime = 0) { this.put(p, { type: 'link', target, mtime }); }
  remove(p) {
    p = norm(p);
    if (!this.nodes.has(p) || p === '/') return;
    const n = this.nodes.get(p);
    if (n.type === 'dir') { for (const c of [...this.kids.get(p)]) this.remove(joinP(p, c)); this.kids.delete(p); }
    this.nodes.delete(p);
    const d = parentOf(p), k = this.kids.get(d); if (k) k.delete(p.slice(d === '/' ? 1 : d.length + 1));
  }
  /** Entries of an archive under `into`. */
  addEntries(entries, into = '') {
    const base = into ? norm(into) : '';
    const at = (path) => norm(base + '/' + path);
    for (const e of entries) {
      if (e.type === 'dir') this.mkdir(at(e.path), e.mode, e.mtime);
      else if (e.type === 'link') this.symlink(at(e.path), e.link, e.mtime);
      else if (e.type === 'file') this.file(at(e.path), e.data, e.mode, e.mtime);
    }
    for (const e of entries) if (e.type === 'hard') {               // after the files they name
      const t = this.nodes.get(at(e.link));
      if (t && t.type === 'file') this.file(at(e.path), t.data, t.mode, t.mtime);
    }
  }
  /** lx.host: what MIRAGE-LINUX's file system asks, answered synchronously. */
  host() {
    return {
      lstat: (p) => {
        const n = this.nodes.get(norm(p));
        if (!n) return null;
        if (n.type === 'dir') return { type: 'dir', mode: S_IFDIR | n.mode, mtime: n.mtime, nlink: 2 };
        if (n.type === 'link') return { type: 'link', target: n.target, mode: S_IFLNK | 0o777, mtime: n.mtime, nlink: 1 };
        return { type: 'file', size: n.data.length, mode: S_IFREG | n.mode, mtime: n.mtime, nlink: 1 };
      },
      list: (p) => [...(this.kids.get(norm(p)) || [])],
      read: (p) => { const n = this.nodes.get(norm(p)); return n && n.type === 'file' ? n.data : null; },
    };
  }
}

// ---- running a program on the tree: busybox's --list, a run layer -----------------------------------
/** Run `argv` on MIRAGE-LINUX over `tree`, in slices (`yieldEvery` resolves between them); returns
 *  { status, out, lx }. */
export async function runOn(tree, argv, { cwd = '/', env = [], mem = 64, cpu = '686', onOutput, onExec, yieldEvery = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const mc = new Machine({ memSize: mem << 20, cpu });
  installBIOS(mc);
  let out = '';
  const lx = installLinux(mc, { onOutput: (fd, b) => { const t = String.fromCharCode(...b); if (fd === 1) out += t; if (onOutput) onOutput(t); } });
  lx.host = tree.host();
  if (onExec) lx.onExec = onExec;                                     // each program the run starts (execve)
  lx.chdir(cwd);
  lx.epoch = Math.floor(Date.now() / 1000);
  const image = lx.readFile(argv[0]);
  if (!image) throw new Error(`oasis: ${argv[0]} is not in the image`);
  lx.load(image, argv, env);
  for (let n = 0; !lx.done; n++) { mc.runSlice(200000); if (n % 20 === 19) await yieldEvery(); }
  return { status: lx.signal ? 128 + lx.signal : lx.status, out, lx };
}

const RUN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';   // Docker's default PATH for a RUN

/**
 * Build an image's tree. `io` is the host's:
 *   fetchBytes(src) -> Promise<Uint8Array>   a URL (through the relay in a page) or a repository path
 *   cache: { get(key) -> Promise<Uint8Array|null>, put(key, bytes) }   for run layers' results (optional)
 *   onProgress(text)                          what is happening, for a status line
 *   onOutput(text)                            a run layer's output
 * Returns the Tree. Throws on a layer this host cannot make (`docker`).
 */
export async function buildTree(img, io) {
  const tree = new Tree(), say = io.onProgress || (() => {});
  const get = async (src, what) => { const b = await io.fetchBytes(src); say(`unpacking ${what || src.split('/').pop()}`); return b; };   // fetched, then unpacked
  let chain = '';
  for (const l of img.layers || []) {
    chain = await sha256(chain + JSON.stringify(l));
    if (l.docker) throw new Error(`oasis: ${img.name || 'this image'} is a Docker image's export — it needs node tools/oasis.mjs`);
    if (l.deb) tree.addEntries(tarEntries(await debData(await get(l.deb))), l.into || '');
    else if (l.tar) { let b = await get(l.tar); if (isGzip(b)) b = await gunzip(b); tree.addEntries(tarEntries(b), l.into || ''); }
    else if (l.zip && l.files && !l.lha) {        // files of a ZIP, each put where `files` says
      const entries = await unzip(await get(l.zip));
      for (const [from, to] of Object.entries(l.files)) {
        const f = entries.find((e) => e.path === from);
        if (!f) throw new Error(`oasis: ${from} is not in ${l.zip}`);
        tree.file(norm(to), f.bytes);
      }
    } else if (l.zip && l.member) {
      const inner = (await unzip(await get(l.zip, l.member))).find((f) => f.path.toLowerCase() === l.member.toLowerCase());
      if (!inner) throw new Error(`oasis: ${l.member} is not in ${l.zip}`);
      tree.addEntries(tarEntries(isGzip(inner.bytes) ? await gunzip(inner.bytes) : inner.bytes), l.into || '');
    } else if (l.lha) {
      const inner = (await unzip(await get(l.zip, l.lha))).find((f) => f.path.toLowerCase() === l.lha.toLowerCase());
      if (!inner) throw new Error(`oasis: ${l.lha} is not in ${l.zip}`);
      for (const f of unlha(inner.bytes)) { const to = l.files ? l.files[f.path] : f.path; if (to) tree.file(norm((l.into || '') + '/' + to), f.bytes); }
    } else if (l.wise) {
      const inflate = async (d) => new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      for (const f of await wiseLayer(await get(l.wise), l, inflate)) tree.file(norm(f.to), f.bytes);
    } else if (l.didi) {
      for (const f of didiLayer(await get(l.didi), l)) tree.file(norm(f.to), f.bytes);
    } else if (l.zip) {
      for (const f of await unzip(await get(l.zip))) tree.file(norm(f.path), f.bytes);
    } else if (l.gz) tree.file(l.to, await gunzip(await get(l.gz)));
    else if (l.file) tree.file(l.to, await io.fetchBytes(l.file));
    else if (l.busybox) {
      const bin = norm('/' + (l.into || 'bin'));
      tree.file(bin + '/busybox', await io.fetchBytes(l.busybox), 0o755);
      say('listing busybox\'s applets');
      const r = await runOn(tree, [bin + '/busybox', '--list']);   // the binary's own answer, as oasis.mjs takes it
      for (const a of r.out.split('\n').map((x) => x.trim()).filter((x) => x && x !== 'busybox' && !x.includes('/'))) if (!tree.nodes.has(bin + '/' + a)) tree.symlink(bin + '/' + a, 'busybox');
    } else if (l.links) for (const [p, t] of Object.entries(l.links)) tree.symlink(p, t);
    else if (l.mkdir) for (const p of [].concat(l.mkdir)) tree.mkdir(p);
    else if (l.run) {
      const key = 'run-' + chain.slice(0, 16);
      let tar = io.cache ? await io.cache.get(key) : null;
      if (!tar) {
        // A build says little (gcc compiles in silence, a minute or more): what it runs now, and for how
        // long it has been running, so a visitor sees it working — "building (25 s): cc1 isosurf.c" (its options and /tmp files left out).
        const t0 = Date.now(), short = (a) => a.filter((x) => !/^-|^\/tmp\//.test(x)).map((x) => x.split('/').pop()).join(' ').slice(0, 80);
        let doing = 'sh', shown = 0;
        const tell = () => { shown = Date.now(); say(`building (${Math.round((shown - t0) / 1000)} s): ${doing}`); };
        tell();
        const env = Object.entries({ PATH: RUN_PATH, ...(l.env || {}) }).map(([k, v]) => `${k}=${v}`);
        const r = await runOn(tree, ['/bin/sh', '-c', l.run], { cwd: l.cwd || '/', env, cpu: l.cpu || '686', onOutput: io.onOutput,
          onExec: (argv) => { doing = short(argv); if (Date.now() - shown > 500) tell(); },
          yieldEvery: () => { if (Date.now() - shown > 1000) tell(); return new Promise((res) => setTimeout(res, 0)); } });
        if (r.status !== 0) throw new Error(`oasis: the layer "${l.run}" failed (status ${r.status})`);
        const c = r.lx.changes(), strip = (p) => p.replace(/^\//, '');
        tar = tarWrite([
          ...c.dirs.map((d) => ({ path: strip(d.path), type: 'dir', mode: d.mode ?? 0o755, mtime: d.mtime })),
          ...c.files.map((f) => ({ path: strip(f.path), type: 'file', mode: f.mode ?? 0o644, mtime: f.mtime, data: f.bytes })),
          ...c.links.map((k) => ({ path: strip(k.path), type: 'link', link: k.target })),
          { path: '.oasis-gone', type: 'file', mode: 0o644, data: enc.encode(JSON.stringify(c.removed)) },
        ]);
        if (io.cache) await io.cache.put(key, tar);
      }
      const entries = tarEntries(tar), gone = entries.find((e) => e.path === '.oasis-gone');
      if (gone) for (const p of JSON.parse(new TextDecoder().decode(gone.data))) tree.remove(p);
      tree.addEntries(entries.filter((e) => e.path !== '.oasis-gone'));
    }
  }
  return tree;
}
