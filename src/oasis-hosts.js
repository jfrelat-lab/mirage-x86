// oasis-hosts.js — the hosts an OASIS image's remote layers come from, and the one rule of the relay
// that lets a page read them (tools/oasis.mjs serve's /oasis-fetch, functions/oasis-fetch.js on
// Cloudflare Pages): an http(s) URL on one of these hosts, nothing else. A relay that took any URL
// would be an open proxy. The list is what oasis/images/ and examples/manifest.json use; tools/test.js
// holds it to that.

// yolp.omgwtf.ru: YOLP's Linux intros of 2011-2012 (examples/manifest.json `url`), which state no
// licence and so are fetched from their authors' site rather than kept here.
export const OASIS_HOSTS = ['archive.debian.org', 'ftp.fu-berlin.de', 'busybox.net', 'yolp.omgwtf.ru'];

/** The URL to fetch for `?url=`, or null when the relay must refuse it. */
export function relayTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!OASIS_HOSTS.includes(u.hostname) || u.username || u.password || u.port) return null;
  return u.href;
}
