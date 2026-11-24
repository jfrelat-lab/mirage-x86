// oasis-home.js — a Linux image's home directory kept in the browser between visits: what the program
// made, changed or removed under $HOME, saved as a tar (src/oasis-layers.js's format, removals in its
// ".oasis-gone" member as a run layer keeps them) and laid over the image's tree the next time it starts.
//
// The save is computed afresh each time from the tar the visit started with and MIRAGE-LINUX's
// lx.changes() -- what differs from the tree, which already holds that tar -- so saving twice, or after
// an undo, gives the same bytes. Only paths under the home are kept: the rest of the image stays the
// image's.

import { tarEntries, tarWrite } from './oasis-layers.js';

const under = (p, home) => p === home || p.startsWith(home.replace(/\/$/, '') + '/');
const abs = (p) => '/' + String(p).replace(/^\/+/, '');

/** The saved state: { entries: Map(path -> tar entry), gone: Set(path) }, from a saved tar (or null). */
export function homeState(tar) {
  const entries = new Map(), gone = new Set();
  if (tar) for (const e of tarEntries(tar)) {
    if (e.path === '.oasis-gone') { for (const p of JSON.parse(new TextDecoder().decode(e.data))) gone.add(p); continue; }
    entries.set(abs(e.path), { ...e, path: abs(e.path) });
  }
  return { entries, gone };
}

/** Lay a saved home over an image's tree (src/oasis-layers.js's Tree): its removals, then its files. */
export function applyHome(tree, tar) {
  const { entries, gone } = homeState(tar);
  for (const p of gone) tree.remove(p);
  tree.addEntries([...entries.values()]);
  return entries.size + gone.size;
}

/**
 * What to save now: the visit's starting tar with lx.changes() (`c`: files, dirs, links, removed) under
 * `home` laid over it. Returns the tar, or null when nothing is kept.
 */
export function homeTar(startTar, c, home) {
  const { entries, gone } = homeState(startTar);
  const drop = (p) => { for (const k of [...entries.keys()]) if (under(k, p)) entries.delete(k); };
  for (const p of c.removed) if (under(p, home)) { drop(p); gone.add(p); }
  for (const d of c.dirs) if (under(d.path, home)) { entries.set(d.path, { path: d.path, type: 'dir', mode: d.mode ?? 0o755, mtime: d.mtime }); gone.delete(d.path); }
  for (const f of c.files) if (under(f.path, home)) { entries.set(f.path, { path: f.path, type: 'file', mode: f.mode ?? 0o644, mtime: f.mtime, data: f.bytes }); gone.delete(f.path); }
  for (const k of c.links) if (under(k.path, home)) { entries.set(k.path, { path: k.path, type: 'link', link: k.target }); gone.delete(k.path); }
  if (!entries.size && !gone.size) return null;
  const strip = (p) => p.replace(/^\//, '');
  return tarWrite([...[...entries.values()].sort((a, b) => a.path.localeCompare(b.path)).map((e) => ({ ...e, path: strip(e.path) })),
    { path: '.oasis-gone', type: 'file', mode: 0o644, data: new TextEncoder().encode(JSON.stringify([...gone].sort())) }]);
}

/** The image's home: entry.env.HOME, else its entry.user's in the tree's /etc/passwd, else /root. */
export function homeOf(img, host) {
  const e = img.entry || {};
  if (e.env && e.env.HOME) return e.env.HOME;
  if (e.user && host) {
    const pw = host.read('/etc/passwd'), u = String(e.user).split(':')[0];
    const row = pw && new TextDecoder().decode(pw).split('\n').map((l) => l.split(':')).find((r) => r[0] === u || r[2] === u);
    return row && row[5] ? row[5] : '/';
  }
  return '/root';
}

/** A quick signature of a tar (FNV-1a over its bytes): whether a save changed anything. */
export function homeSum(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619); return (h >>> 0).toString(16); }

/**
 * Under which name an image's home is kept: a Docker image's (its one layer a `docker` layer) by its
 * repository -- i386/alpine whether it was started from the catalogue's card (linux/docker-alpine), a
 * link (?docker=i386/alpine) or another tag -- as a named volume is the same whatever runs on it;
 * any other image by its own name.
 */
export function homeName(img) {
  const layers = img.layers || [], d = layers.length === 1 && layers[0].docker;
  return d ? String(d).split(/[@:]/)[0] : img.name;
}
