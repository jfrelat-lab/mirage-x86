// oasis-hosts.js — the hosts an OASIS image's remote layers come from, and the one rule of the relay
// that lets a page read them (tools/oasis.mjs serve's /oasis-fetch, functions/oasis-fetch.js on
// Cloudflare Pages): an http(s) URL on one of these hosts, nothing else. A relay that took any URL
// would be an open proxy. The list is what oasis/images/ and examples/manifest.json use; tools/test.js
// holds it to that.

// yolp.omgwtf.ru: YOLP's Linux intros of 2011-2012 (examples/manifest.json `url`), which state no
// licence and so are fetched from their authors' site rather than kept here. An entry with a path is a
// host AND a path prefix: Desire's releases (attraction & decay, Outline 2026) are on GitHub, and the
// whole of raw.githubusercontent.com would make the relay a proxy for every repository there.
// ftp.scene.org/pub/ and ftp.untergrund.net/users/parapete/: the party archives of the Linux OpenGL
// intros of 2003-2010 (oasis/images/linux/*-20xx.json), fetched as scene.org keeps them.
// conspiracy.hu/files/: Conspiracy's own downloads, where its 2023 repack of luxo4k (2007) is.
export const OASIS_HOSTS = ['archive.debian.org', 'ftp.fu-berlin.de', 'busybox.net', 'yolp.omgwtf.ru',
  'raw.githubusercontent.com/dominikfhnw/demoscene_releases/', 'ftp.scene.org/pub/', 'ftp.untergrund.net/users/parapete/', 'conspiracy.hu/files/'];

/** The URL to fetch for `?url=`, or null when the relay must refuse it. */
export function relayTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  const at = u.hostname + u.pathname;
  if (!OASIS_HOSTS.some((h) => (h.includes('/') ? at.startsWith(h) && !u.pathname.includes('/../') : u.hostname === h))) return null;
  return u.href;
}
