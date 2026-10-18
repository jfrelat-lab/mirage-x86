// oasis-hosts.js — the hosts an OASIS image's remote layers come from, and the one rule of the relay
// that lets a page read them (tools/oasis.mjs serve's /oasis-fetch, functions/oasis-fetch.js on
// Cloudflare Pages): an http(s) URL on one of these hosts, nothing else. A relay that took any URL
// would be an open proxy. The list is what oasis/images/ uses; tools/test.js holds it to that.

export const OASIS_HOSTS = ['archive.debian.org', 'ftp.fu-berlin.de', 'busybox.net'];

/** The URL to fetch for `?url=`, or null when the relay must refuse it. */
export function relayTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!OASIS_HOSTS.includes(u.hostname) || u.username || u.password || u.port) return null;
  return u.href;
}
