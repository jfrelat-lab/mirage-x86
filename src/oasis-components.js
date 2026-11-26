// oasis-components.js — what MIRAGE itself puts in an image: OASIS's components, named as Docker
// names an image (oasis/node beside i386/busybox), whatever world they run in.
//
// A layer { "oasis": "<name>" } stands for the component's own layers, laid where they always go
// (`to` moves the command elsewhere). An image is then named for where its contents come from:
// <world>/docker-* from Docker Hub, <world>/oasis-* with a component of MIRAGE's -- linux/oasis-node
// today, win32/oasis-node the same component as node.exe tomorrow.
//
// A component made of someone's release carries its version as a tag, as Docker's do (oasis/python:3.15):
// another version is another component, so an image that names one never changes under it. MIRAGE's
// own (oasis/node) has none -- its version is MIRAGE's, and the Node it answers as is one at a time.
//
//   oasis/node         Node's API made in JavaScript (src/node), run by the host's engine: `\0hle node\n`
//   oasis/python:3.15  CPython 3.15 built for WASI by the CPython project, run by the host's WebAssembly engine
export const COMPONENTS = {
  node: { what: "MIRAGE's node: Node's API in JavaScript (src/node), run by the host's own engine",
    layers: (l) => [{ hle: 'node', to: l.to || '/usr/local/bin/node' }] },
  'python:3.15': { what: "CPython 3.15 built for WASI by the CPython project, run by the host's WebAssembly engine (src/wasi.js)",
    layers: () => [
      { zip: 'https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.15.2/python-3.15.2-wasi_sdk-33.zip', into: '/usr/local' },
      { links: { '/usr/local/bin/python3': '/usr/local/python.wasm', '/usr/local/bin/python': 'python3' } }] },
};

/** An image's layers with each { oasis } layer replaced by its component's own. */
export function withComponents(layers) {
  return (layers || []).flatMap((l) => {
    if (!l.oasis) return [l];
    const c = COMPONENTS[String(l.oasis).replace(/^oasis\//, '')];
    if (!c) throw new Error(`oasis: no component "${l.oasis}" (${Object.keys(COMPONENTS).map((k) => 'oasis/' + k).join(', ')})`);
    return c.layers(l);
  });
}

/** Images renamed: the old name -> the new, so a link or a command made before still finds it. */
export const RENAMED = { 'linux/node-hle': 'linux/oasis-node', 'linux/python-wasi': 'linux/oasis-python-3.15', 'linux/oasis-python': 'linux/oasis-python-3.15' };
