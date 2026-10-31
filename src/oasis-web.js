// oasis-web.js — what src/oasis-layers.js needs from a page: archives fetched through a CORS relay,
// and a cache that keeps them, and the results of run layers, between visits.
//
// Debian's archive and idgames' mirrors send no Access-Control-Allow-Origin, so a page cannot read
// them itself. The relay is `oasis-fetch?url=<url>` beside the page: tools/oasis.mjs serve answers it
// on a computer, functions/oasis-fetch.js on Cloudflare Pages — the same allowlist of hosts in both
// (OASIS_HOSTS), the bytes relayed as their authors publish them, nothing stored but in the browser.
// The repository's own files (oasis/files/...) are fetched as they are.
//
// The cache is the browser's Cache Storage: an archive is fetched once; a run layer (DOOM's build,
// minutes of gcc) is built once and kept as a tar under the hash of every layer up to it.

const CACHE = 'oasis-layers-v1';
const keyUrl = (key) => new URL(`__oasis-cache/${encodeURIComponent(key)}`, location.href).href;

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }      // no Cache Storage (an insecure origin)
}

export function webIO({ relay = 'oasis-fetch', onProgress = () => {} } = {}) {
  const cachePromise = openCache();
  const get = async (key) => {
    const c = await cachePromise; if (!c) return null;
    const r = await c.match(keyUrl(key));
    return r ? new Uint8Array(await r.arrayBuffer()) : null;
  };
  const put = async (key, bytes) => {
    const c = await cachePromise; if (!c) return;
    try { await c.put(keyUrl(key), new Response(bytes)); } catch { /* full: the next visit fetches again */ }
  };
  const fetchBytes = async (src) => {
    const remote = /^https?:\/\//.test(src);
    const hit = remote ? await get('url:' + src) : null;
    if (hit) return hit;
    const url = remote ? `${relay}?url=${encodeURIComponent(src)}` : src;
    if (remote) onProgress(`fetching ${src.split('/').pop()}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`oasis: ${src}: HTTP ${r.status}${remote && r.status === 404 ? ' (this server has no oasis-fetch relay: serve with python3 tools/serve.py or node tools/oasis.mjs serve)' : ''}`);
    const b = new Uint8Array(await r.arrayBuffer());
    if (remote) await put('url:' + src, b);
    return b;
  };
  return { fetchBytes, cache: { get, put }, onProgress };
}
