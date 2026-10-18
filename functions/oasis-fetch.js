// functions/oasis-fetch.js — the OASIS relay on Cloudflare Pages: GET /oasis-fetch?url=<url>.
//
// A page builds an OASIS Linux image itself (src/oasis-layers.js) from archives on Debian's and
// idgames' servers, which send no CORS headers; this Function fetches them for it, from the hosts
// src/oasis-hosts.js names and no other, and hands the bytes on unchanged with the header that lets
// the page read them. Nothing is stored here: Cloudflare's cache keeps a copy a while, the browser
// its own (Cache Storage). The same rule answers on a computer: tools/oasis.mjs serve.
import { relayTarget } from '../src/oasis-hosts.js';

export async function onRequestGet({ request }) {
  const target = relayTarget(new URL(request.url).searchParams.get('url') || '');
  if (!target) return new Response('oasis-fetch: not a host OASIS images use', { status: 403 });
  const r = await fetch(target, { cf: { cacheEverything: true, cacheTtl: 7 * 86400 } });
  if (!r.ok || !relayTarget(r.url)) return new Response(`oasis-fetch: ${target}: HTTP ${r.status}`, { status: 502 });
  const h = new Headers({ 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  const len = r.headers.get('Content-Length'); if (len) h.set('Content-Length', len);
  return new Response(r.body, { status: 200, headers: h });
}
