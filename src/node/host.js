// host.js — the machine's side of an HLE node (src/node/worker.js the other): its Worker started, and the
// shared memory through which each system call comes and goes.
//
//   ctrl (Int32Array over the first 64 bytes): [0] the state -- RUN (the guest's JavaScript runs), REQ (a
//   system call waits: [1] its number, [2..7] its arguments, [8] how many bytes of the buffer it uses),
//   DONE (it ended: [9] its status), FAIL (MIRAGE's node failed: [9] the length of its message); [9] also
//   a call's result. Then the buffer, `size` bytes, copied to and from the process's own at `base`.
export const RUN = 0, REQ = 1, DONE = 2, FAIL = 3;
export const NODE_MAGIC = '\0hle node\n';
// Two calls of MIRAGE's own, beside Linux's numbers (src/linux.js's loadNode answers them):
//   SPAWN (path, argv, envp, cwd, fds, nfds): a child made and exec'd by the kernel, as posix_spawn makes
//     one -- its descriptors 0..nfds-1 the caller's fds[i] (-1: none), cwd its directory (0: the caller's);
//     the child's id, or -errno with no child where the file or the directory is not there.
//   WAIT (pollfds, n, ms): poll, which a child's end interrupts (EINTR) -- libuv's SIGCHLD.
//   FETCH (request): an HTTP GET carried by the host (lx.fetch) to the hosts src/oasis-hosts.js lets a guest
//     reach; `request` a JSON string { url, method, headers }. A descriptor to read, the response as it comes:
//     a line of JSON { status, statusText, headers: [[name, value]] } (or { error, code }), then the body;
//     its end, the response's. -errno where no fetch is offered (ENETUNREACH) or the URL is not allowed (EACCES).
export const SPAWN = 0x10000, WAIT = 0x10001, FETCH = 0x10002;

/** Is it the HLE node's executable? A file beginning "\0hle node\n" (oasis's `hle` layer writes one). */
export const isHleNode = (b) => b && b.length >= 10 && b[0] === 0 && String.fromCharCode(...b.subarray(1, 10)) === 'hle node\n';

/**
 * Start a node: { argv, envp, exe, base, size } -> { ctrl, buf, failed (a promise), end() } or
 * { error } where it cannot run (a page that is not cross-origin isolated has no SharedArrayBuffer).
 */
export function startNode(init) {
  if (typeof SharedArrayBuffer === 'undefined' || (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)) return { error: 'this page is not cross-origin isolated, and node needs SharedArrayBuffer' };
  const sab = new SharedArrayBuffer(64 + init.size), ctrl = new Int32Array(sab, 0, 16), buf = new Uint8Array(sab, 64, init.size);
  const data = { sab, size: init.size, base: init.base, argv: init.argv, envp: init.envp, exe: init.exe };
  const url = new URL('./worker.js', import.meta.url);
  let worker, failed;
  const failure = new Promise((res) => { failed = res; });
  const onError = (e) => { if (Atomics.load(ctrl, 0) === RUN || Atomics.load(ctrl, 0) === REQ) { const msg = new TextEncoder().encode(`node: MIRAGE's node failed: ${e && (e.message || e)}\n`); buf.set(msg.subarray(0, init.size)); ctrl[9] = msg.length; Atomics.store(ctrl, 0, FAIL); } failed(); };
  if (typeof Worker === 'function' && typeof window !== 'undefined') {
    worker = new Worker(url, { type: 'module', name: 'mirage-node' });
    worker.onerror = (e) => { e.preventDefault(); onError(e); };
    worker.postMessage(data);
  } else {
    const { Worker: NodeWorker } = globalThis.process.getBuiltinModule('node:worker_threads');
    worker = new NodeWorker(url, { workerData: data, stdout: false, stderr: false });
    worker.on('error', onError);
    worker.on('exit', () => failed());
    // not unref()d: the machine's loop may be awaiting it (Atomics.waitAsync holds nothing alive); end() ends it
  }
  return { ctrl, buf, failure, end: () => { try { worker.terminate(); } catch { /* gone */ } } };
}
