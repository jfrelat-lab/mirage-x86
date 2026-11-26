// worker.js — where an HLE node's JavaScript runs: a Worker (in a page) or a worker thread (in Node),
// waiting on Atomics at each system call while MIRAGE-LINUX answers it (src/node/host.js the other side).
//
// The guest's realm. In Node: a new vm context, the guest's own globals, Node's API built inside it by
// src/node's parts (their source evaluated there, so that its objects are the guest's: an Error the API
// throws is the guest's Error). vm is no security boundary: the realm is for faithfulness; the tools run
// files of their user's. In a page: the Worker's own global, the parts called as they are -- and before the
// guest runs, what would reach outside the machine is taken away: the network, storage, other workers,
// messages to the page (the Worker's CSP, site/_headers, refuses connections whatever is left).
import { kernel } from './kernel.js';
import { path } from './path.js';
import { events } from './events.js';
import { inspect } from './inspect.js';
import { buffer } from './buffer.js';
import { stream } from './stream.js';
import { fs } from './fs.js';
import { crypto } from './crypto.js';
import { process as proc } from './process.js';
import { modules } from './modules.js';
import { main } from './main.js';

const PARTS = [kernel, path, events, inspect, buffer, stream, fs, crypto, proc, modules, main];
const ST = 0, RUN = 0, REQ = 1, DONE = 2, FAIL = 3;
const inNode = typeof globalThis.process === 'object' && !!globalThis.process.versions?.node && typeof globalThis.WorkerGlobalScope === 'undefined';

function start(init, host) {
  const ctrl = new Int32Array(init.sab, 0, 16), buf = new Uint8Array(init.sab, 64, init.size);
  const wait = Atomics.wait, store = Atomics.store, notify = Atomics.notify, load = Atomics.load;
  const bridge = {
    base: init.base, size: init.size, buf, argv: init.argv, envp: init.envp, exe: init.exe,
    sys(top, n, a, b, c, d, e, f) {
      ctrl[1] = n; ctrl[2] = a; ctrl[3] = b; ctrl[4] = c; ctrl[5] = d; ctrl[6] = e; ctrl[7] = f; ctrl[8] = top;
      store(ctrl, ST, REQ); notify(ctrl, ST);
      while (load(ctrl, ST) === REQ) wait(ctrl, ST, REQ);
      return ctrl[9];
    },
    exit(code) {
      ctrl[9] = code; store(ctrl, ST, DONE); notify(ctrl, ST);
      for (;;) wait(ctrl, ST, DONE);                                       // the machine ends the thread
    },
    tick: host.tick, compile: host.compile, onRejection: host.onRejection,
  };
  const fail = (e) => {
    const msg = new TextEncoder().encode(`node: MIRAGE's node failed: ${e && e.stack || e}\n`).subarray(0, init.size);
    buf.set(msg); ctrl[9] = msg.length; store(ctrl, ST, FAIL); notify(ctrl, ST);
  };
  try { host.run(bridge, fail); } catch (e) { fail(e); }
}

if (inNode) {
  const { workerData } = await import('node:worker_threads');
  const vm = await import('node:vm');
  const ctx = vm.createContext({});
  const G = vm.runInContext('globalThis', ctx);
  let onRejection = null;
  globalThis.process.on('unhandledRejection', (reason) => { if (onRejection) onRejection(reason); });
  start(workerData, {
    tick: (cb) => setImmediate(cb),
    compile: (src, filename, params) => vm.compileFunction(src, params, { filename, parsingContext: ctx }),
    onRejection: (cb) => { onRejection = cb; },
    run(bridge, fail) {
      const N = vm.runInContext('({})', ctx);
      N.bridge = bridge; N.global = G;
      let loop;                                                          // main's answer: the loop, whose failure is MIRAGE's own
      for (const part of PARTS) loop = vm.runInContext(`(${part.toString()})`, ctx, { filename: `mirage-node:${part.name}` })(N);
      Promise.resolve(loop).catch(fail);
    },
  });
} else {
  self.onmessage = (ev) => {
    self.onmessage = null;
    const G = self, tickPort = new MessageChannel(), queue = [];
    tickPort.port1.onmessage = () => { const f = queue.shift(); if (f) f(); };
    let onRejection = null;
    self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); if (onRejection) onRejection(e.reason); });
    const post = tickPort.port2.postMessage.bind(tickPort.port2);
    // What reaches outside the machine, taken away before the guest runs.
    for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker',
      'BroadcastChannel', 'postMessage', 'close', 'onmessage', 'onmessageerror', 'navigator', 'location', 'FileReaderSync', 'cookieStore', 'storageBuckets', 'RTCPeerConnection', 'RTCDataChannel', 'MessageChannel', 'MessagePort']) {
      try { delete G[k]; } catch { /* not configurable */ }
      try { if (k in G) Object.defineProperty(G, k, { value: undefined, configurable: true, writable: true }); } catch { /* left as it is */ }   // the guest may put its own there (navigator: src/node/modules.js)
    }
    start(ev.data, {
      tick: (cb) => { queue.push(cb); post(0); },
      compile: (src, filename, params) => new Function(...params, `${src}\n//# sourceURL=${filename}`),
      onRejection: (cb) => { onRejection = cb; },
      run(bridge, fail) {
        const N = { bridge, global: G };
        let loop;
        for (const part of PARTS) loop = part(N);
        Promise.resolve(loop).catch(fail);
      },
    });
  };
}
