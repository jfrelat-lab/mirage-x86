// fetch-whole.js — fetch a file that a static export may have shipped in parts.
//
// A static host takes files up to a size (Cloudflare Pages: 25 MiB). tools/site.mjs ships a larger
// one — the FreeDOS disk of the home page, 25.2 MB compressed — as <file>.part0, .part1, ... with
// <file>.parts.json saying how many; the parts are transport, joined here back into the file as
// published. Served from the repository the file is whole, and this is a plain fetch.

/** A Response for `url`: the file, or its parts joined in order. */
export async function fetchWhole(url) {
  const r = await fetch(url);
  if (r.ok) return r;
  const p = await fetch(url + '.parts.json').catch(() => null);
  if (!p || !p.ok) return r;
  const { parts } = await p.json();
  let i = 0;
  const stream = new ReadableStream({
    async pull(c) {
      if (i === parts) { c.close(); return; }
      const part = await fetch(`${url}.part${i++}`);
      if (!part.ok) { c.error(new Error(`${url}.part${i - 1}: HTTP ${part.status}`)); return; }
      c.enqueue(new Uint8Array(await part.arrayBuffer()));
    },
  });
  return new Response(stream, { status: 200 });
}
