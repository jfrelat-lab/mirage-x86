// oasis-docker.js — Docker images in OASIS without Docker: an image's layers pulled from Docker Hub's
// registry (the Distribution API, v2) and laid one over the other as a container's root file system,
// the same in Node (tools/oasis.mjs) and in a page (src/oasis-layers.js, through the relay).
//
// A pull: an anonymous token for the repository (auth.docker.io), the tag's manifest -- an image index
// (OCI) or manifest list (Docker) is resolved to the platform's own manifest, linux/386 -- then the
// image's config (its Cmd, Entrypoint, Env, WorkingDir, User) and each layer, a tar compressed with
// gzip, every blob checked against its sha256 digest. Layers apply in order; a whiteout (".wh.<name>")
// removes what a lower layer put at <name>, an opaque whiteout (".wh..wh..opq") everything a lower
// layer put in its directory (the OCI image layout's rules).
//
// Only Docker Hub's "i386/" repositories: MIRAGE runs i386 code, and the relay that fetches them for
// a page (relayDocker) must stay narrow -- public images, read-only, nothing but this registry.

const REGISTRY = 'https://registry-1.docker.io', AUTH = 'https://auth.docker.io/token';
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');
const REPO = /^i386\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/, TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * "docker://i386/debian:bookworm-slim", "i386/debian", "i386/alpine@sha256:..." as { repo, ref }; the
 * tag "latest" when none is given. Throws on anything but an i386/ repository of Docker Hub.
 */
export function dockerRef(s) {
  let r = String(s).replace(/^docker:\/\//, '').replace(/^(?:docker\.io|registry-1\.docker\.io|index\.docker\.io)\//, '');
  let ref = 'latest';
  const at = r.indexOf('@');
  if (at >= 0) { ref = r.slice(at + 1); r = r.slice(0, at); } else { const c = r.lastIndexOf(':'); if (c > r.lastIndexOf('/')) { ref = r.slice(c + 1); r = r.slice(0, c); } }
  if (!REPO.test(r)) throw new Error(`oasis: ${s}: only Docker Hub's i386/ images (i386/debian, i386/alpine...) -- MIRAGE runs i386 code`);
  if (!TAG.test(ref) && !DIGEST.test(ref)) throw new Error(`oasis: ${s}: not a tag or a sha256 digest`);
  return { repo: r, ref };
}

/** linux/386 (or "linux/386/v7"-style) as { os, architecture, variant }. */
const platformOf = (p) => { const [os, architecture, variant] = String(p || 'linux/386').split('/'); return { os, architecture, variant }; };

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) { return 'sha256:' + hex(await crypto.subtle.digest('SHA-256', bytes)); }

/*
 * Where an i386/ image can be read: Docker Hub itself, and AWS's public mirror of Docker's official
 * images (public.ecr.aws/docker/library/<name>), whose linux/386 manifests and layers are the same bytes
 * under the same digests -- i386/<name> is the official image's linux/386 build. Docker Hub limits
 * anonymous pulls per address, and the relay's addresses are shared: it reads the mirror first.
 */
export const REGISTRIES = {
  hub: { base: REGISTRY, token: (repo) => `${AUTH}?service=registry.docker.io&scope=repository:${repo}:pull`, path: (repo) => repo },
  ecr: { base: 'https://public.ecr.aws', token: (repo) => `https://public.ecr.aws/token/?scope=repository:${repo}:pull&service=public.ecr.aws`,
    path: (repo) => `docker/library/${repo.slice(5)}` },
};

/**
 * A registry client over `fetch` (Node's, or a Worker's): { manifest(repo, ref) -> { json, bytes },
 * blob(repo, digest) -> Uint8Array }, an anonymous pull token kept per registry and repository. `order`
 * names the registries tried in turn (REGISTRIES): the next one when one refuses (a 429, a 404, an error).
 */
export function registryClient(fetchFn = fetch, order = ['hub', 'ecr']) {
  const tokens = new Map();
  const token = async (reg, path) => {
    const k = reg.base + ' ' + path;
    if (!tokens.has(k)) {
      const r = await fetchFn(reg.token(path));
      if (!r.ok) throw new Error(`a token: HTTP ${r.status}`);
      tokens.set(k, (await r.json()).token);
    }
    return tokens.get(k);
  };
  const get = async (repo, what, accept) => {
    const tried = [];
    for (const name of order) {
      const reg = REGISTRIES[name], path = reg.path(repo);
      try {
        const r = await fetchFn(`${reg.base}/v2/${path}/${what}`, { headers: { Authorization: `Bearer ${await token(reg, path)}`, ...(accept ? { Accept: accept } : {}) } });
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
        tried.push(`${name} HTTP ${r.status}`);
      } catch (e) { tried.push(`${name} ${e.message}`); }
    }
    throw new Error(`oasis: ${repo} ${what}: ${tried.join(', ')}`);
  };
  return {
    manifest: async (repo, ref) => { const bytes = await get(repo, `manifests/${ref}`, ACCEPT); return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) }; },
    blob: (repo, digest) => get(repo, `blobs/${digest}`),
  };
}

/**
 * Pull an image: { config, layers: [{ digest, bytes }], digest } -- `bytes` each layer's tar as the
 * registry keeps it (gzip), `digest` the platform's own image manifest's, which pins it -- the same on
 * Docker Hub and its mirrors, where an index (i386/<name>'s, library/<name>'s) is not;
 * `withLayers: false` stops at the config. `client` is registryClient's interface (or the page's, through the relay).
 */
export async function dockerPull(client, repo, ref, platform = 'linux/386', onProgress = () => {}, { withLayers = true } = {}) {
  const want = platformOf(platform);
  onProgress(`fetching ${repo}:${ref}'s manifest`);
  let { json: m, bytes } = await client.manifest(repo, ref);
  if (DIGEST.test(ref) && (await sha256(bytes)) !== ref) throw new Error(`oasis: ${repo}@${ref}: the manifest does not match its digest`);
  if (m.manifests) {                                                   // an index: the platform's own manifest
    const e = m.manifests.find((x) => x.platform && x.platform.os === want.os && x.platform.architecture === want.architecture && (!want.variant || x.platform.variant === want.variant));
    if (!e) throw new Error(`oasis: ${repo}:${ref} has no ${platform} image (it has ${m.manifests.map((x) => x.platform ? `${x.platform.os}/${x.platform.architecture}` : '?').join(', ')})`);
    ({ json: m, bytes } = await client.manifest(repo, e.digest));
    if ((await sha256(bytes)) !== e.digest) throw new Error(`oasis: ${repo}@${e.digest}: the manifest does not match its digest`);
  }
  if (!m.layers || !m.config) throw new Error(`oasis: ${repo}:${ref}: not an image manifest (${m.mediaType || 'no media type'})`);
  const digest = await sha256(bytes);                                   // what pins the image: its linux/386 manifest
  const blob = async (d, what) => { onProgress(`fetching ${what}`); const b = await client.blob(repo, d.digest); if ((await sha256(b)) !== d.digest) throw new Error(`oasis: ${repo}: ${d.digest} does not match its digest`); return b; };
  const config = JSON.parse(new TextDecoder().decode(await blob(m.config, `${repo}'s config`)));
  if (config.architecture && config.architecture !== want.architecture) throw new Error(`oasis: ${repo}:${ref} is ${config.architecture}, not ${want.architecture}`);
  const layers = [];
  if (!withLayers) return { config, layers, digest };
  for (const [i, l] of m.layers.entries()) {
    if (!/tar(\+gzip)?$|tar\.gzip$|rootfs\.diff\.tar\.gzip$/.test(l.mediaType || '')) throw new Error(`oasis: ${repo}: a layer of type ${l.mediaType} (only tar and tar+gzip)`);
    layers.push({ digest: l.digest, bytes: await blob(l, `layer ${i + 1} of ${m.layers.length} (${Math.round(l.size / 1024)} KiB)`) });
  }
  return { config, layers, digest };
}

/**
 * A layer's tar entries ({ path, type, ... } as src/oasis-layers.js's tarEntries gives them) laid over
 * what the layers below made, with `remove(path)` and `children(path)` of the tree below and `add(entries)`
 * for what stays: whiteouts first (they hide the lower layers only), then the layer's own files.
 */
export function applyLayer(entries, { remove, children, add }) {
  const keep = [];
  for (const e of entries) {
    const p = e.path.replace(/\/+$/, ''), slash = p.lastIndexOf('/'), dir = slash >= 0 ? p.slice(0, slash) : '', base = p.slice(slash + 1);
    if (base === '.wh..wh..opq') { for (const c of children(dir)) remove(dir ? `${dir}/${c}` : c); continue; }
    if (base.startsWith('.wh.')) { remove(dir ? `${dir}/${base.slice(4)}` : base.slice(4)); continue; }
    keep.push(e);
  }
  add(keep);
}

/** An OASIS image's entry from the image's config: Entrypoint and Cmd, WorkingDir, Env, as docker run starts it. */
export function dockerEntry(config) {
  const c = config.config || {}, argv = [...(c.Entrypoint || []), ...(c.Cmd || [])];
  if (!argv.length) argv.push('/bin/sh');
  const env = Object.fromEntries((c.Env || []).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  if (!env.HOME && !c.User) env.HOME = '/root';                       // as docker run sets it for root (a User's comes from /etc/passwd)
  return { run: argv[0], ...(argv.length > 1 ? { args: argv.slice(1) } : {}), cwd: c.WorkingDir || '/', env, ...(c.User ? { user: c.User } : {}) };
}

/**
 * The relay's Docker requests (tools/oasis.mjs serve, functions/oasis-fetch.js): ?docker=<i386/repo>
 * with &manifest=<tag or digest> or &blob=<digest>, fetched here with an anonymous token -- the page
 * sends no credentials, and gets nothing but Docker Hub's public i386 images. Returns
 * { status, body, type }.
 */
export async function relayDocker(params, fetchFn = fetch, order = ['ecr', 'hub']) {
  const repo = params.get('docker') || '', manifest = params.get('manifest'), blob = params.get('blob');
  if (!REPO.test(repo)) return { status: 403, body: 'oasis-fetch: only Docker Hub\'s i386/ repositories' };
  if (manifest !== null && !TAG.test(manifest) && !DIGEST.test(manifest)) return { status: 400, body: 'oasis-fetch: not a tag or digest' };
  if (blob !== null && !DIGEST.test(blob)) return { status: 400, body: 'oasis-fetch: not a digest' };
  if ((manifest === null) === (blob === null)) return { status: 400, body: 'oasis-fetch: a manifest or a blob' };
  try {
    const c = registryClient(fetchFn, order);
    const body = manifest !== null ? (await c.manifest(repo, manifest)).bytes : await c.blob(repo, blob);
    return { status: 200, body, type: manifest !== null ? 'application/json' : 'application/octet-stream' };
  } catch (e) { return { status: 502, body: `oasis-fetch: ${e.message}` }; }
}

/** The page's client: registryClient's interface over the relay beside it. */
export function relayClient(relay = 'oasis-fetch', fetchFn = fetch) {
  const get = async (q) => { const r = await fetchFn(`${relay}?${q}`); if (!r.ok) throw new Error(`oasis: ${relay}?${q}: HTTP ${r.status} ${await r.text()}`); return new Uint8Array(await r.arrayBuffer()); };
  return {
    manifest: async (repo, ref) => { const bytes = await get(`docker=${encodeURIComponent(repo)}&manifest=${encodeURIComponent(ref)}`); return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) }; },
    blob: (repo, digest) => get(`docker=${encodeURIComponent(repo)}&blob=${encodeURIComponent(digest)}`),
  };
}
