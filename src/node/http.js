// http.js — node's http, https, net, tls and dns as a machine with no network has them: their classes
// (Agent, ClientRequest, IncomingMessage, Socket...), STATUS_CODES and METHODS, so that a program that
// only loads them (npm's agents, at every start) runs; a request fails as on a machine with no route,
// getaddrinfo ENOTFOUND -- unless the kernel offers a fetch (N.fetch: src/node/kernel.js), which carries
// a request to the hosts its relay allows. A part of the HLE node (src/node/kernel.js).
export function http(N) {
  const EE = N.EventEmitter, { Readable, Writable, Duplex } = N.stream, Buffer = N.Buffer;
  const STATUS_CODES = {
    100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
    204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently',
    302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
    402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
    409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency',
    425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required',
  };
  const METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY',
    'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];
  const unavailable = (what) => N.nodeError(Error, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', `${what} is not available in MIRAGE yet`);
  const notFound = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host });

  // ---- net ----------------------------------------------------------------------------------------
  const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const isIPv4 = (s) => v4.test(String(s));
  const isIPv6 = (s) => { s = String(s); if (!s.includes(':')) return false; try { return new N.global.URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; } };
  const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);
  // A socket that never connects: there is no AF_INET in MIRAGE-LINUX.
  class Socket extends Duplex {
    constructor(opts = {}) { super(opts); this.connecting = false; this.remoteAddress = undefined; this.bytesRead = 0; this.bytesWritten = 0; }
    connect(...a) {
      const o = typeof a[0] === 'object' ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : 'localhost' };
      const cb = a.find((x) => typeof x === 'function'); if (cb) this.once('connect', cb);
      this.connecting = true;
      N.nextTick(() => { this.connecting = false; this.destroy(notFound(o.host || o.path || 'localhost')); });
      return this;
    }
    setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; } setNoDelay() { return this; } setKeepAlive() { return this; } ref() { return this; } unref() { return this; }
    address() { return {}; } _read() {} _write(c, e, cb) { cb(unavailable('net')); }
  }
  const net = {
    isIP, isIPv4, isIPv6, Socket, Stream: Socket,
    connect: (...a) => new Socket().connect(...a), createConnection: (...a) => new Socket().connect(...a),
    createServer: () => { throw unavailable('net.createServer'); }, Server: class Server extends EE { constructor() { super(); throw unavailable('net.Server'); } },
    BlockList: class BlockList { addAddress() {} addRange() {} addSubnet() {} check() { return false; } }, SocketAddress: class SocketAddress { constructor(o = {}) { Object.assign(this, { address: '127.0.0.1', port: 0, family: 'ipv4', ...o }); } },
    getDefaultAutoSelectFamily: () => true, setDefaultAutoSelectFamily: () => {}, getDefaultAutoSelectFamilyAttemptTimeout: () => 250, setDefaultAutoSelectFamilyAttemptTimeout: () => {},
  };
  class TLSSocket extends Socket { constructor(s, o) { super(o); this.encrypted = true; this.authorized = false; } getPeerCertificate() { return {}; } getProtocol() { return null; } }
  const tls = { TLSSocket, connect: (...a) => new TLSSocket().connect(...a), createSecureContext: (o) => ({ context: {}, options: o }), checkServerIdentity: () => undefined,
    rootCertificates: Object.freeze([]), DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', DEFAULT_ECDH_CURVE: 'auto', DEFAULT_CIPHERS: 'TLS_AES_256_GCM_SHA384',
    getCiphers: () => [], createServer: () => { throw unavailable('tls.createServer'); }, Server: net.Server, SecureContext: class SecureContext {} };
  const lookup = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const fam = isIP(host);
    N.nextTick(() => (fam ? cb(null, opts && opts.all ? [{ address: host, family: fam }] : host, fam) : host === 'localhost' ? cb(null, opts && opts.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) : cb(notFound(host))));
  };
  const dns = { lookup, resolve: (h, t, cb) => { cb = typeof t === 'function' ? t : cb; N.nextTick(() => cb(notFound(h))); }, setServers: () => {}, getServers: () => [], setDefaultResultOrder: () => {}, getDefaultResultOrder: () => 'verbatim',
    ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256, NOTFOUND: 'ENOTFOUND', Resolver: class Resolver { resolve(h, t, cb) { dns.resolve(h, t, cb); } setServers() {} getServers() { return []; } cancel() {} } };
  dns.promises = { lookup: (h, o) => new Promise((res, rej) => lookup(h, o || {}, (e, a, f) => (e ? rej(e) : res(o && o.all ? a : { address: a, family: f })))), resolve: (h) => Promise.reject(notFound(h)), setServers() {}, getServers: () => [], Resolver: dns.Resolver, setDefaultResultOrder() {} };

  // ---- http and https: a client ------------------------------------------------------------------
  class Agent extends EE {
    constructor(opts = {}) { super(); this.options = { path: null, ...opts }; this.keepAlive = !!opts.keepAlive; this.keepAliveMsecs = opts.keepAliveMsecs || 1000; this.maxSockets = opts.maxSockets || Infinity; this.maxFreeSockets = opts.maxFreeSockets || 256; this.maxTotalSockets = opts.maxTotalSockets || Infinity; this.totalSocketCount = 0; this.sockets = {}; this.freeSockets = {}; this.requests = {}; this.defaultPort = 80; this.protocol = 'http:'; }
    createConnection(o, cb) { return net.createConnection(o, cb); }
    getName(o = {}) { return `${o.host || 'localhost'}:${o.port || ''}:${o.localAddress || ''}${o.family ? ':' + o.family : ''}`; }
    keepSocketAlive() { return false; } reuseSocket() {} destroy() {}
  }
  class HttpsAgent extends Agent { constructor(o) { super(o); this.defaultPort = 443; this.protocol = 'https:'; } }
  class IncomingMessage extends Readable {
    constructor(socket) { super(); this.socket = socket || null; this.headers = {}; this.rawHeaders = []; this.trailers = {}; this.rawTrailers = []; this.httpVersion = '1.1'; this.httpVersionMajor = 1; this.httpVersionMinor = 1; this.complete = false; this.statusCode = null; this.statusMessage = null; this.aborted = false; }
    _read() {} setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
  }
  class OutgoingMessage extends Writable {
    constructor() { super(); this._headers = Object.create(null); this._names = Object.create(null); this.headersSent = false; this.finished = false; }
    setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; this._names[String(k).toLowerCase()] = k; return this; }
    getHeader(k) { return this._headers[String(k).toLowerCase()]; } removeHeader(k) { delete this._headers[String(k).toLowerCase()]; } hasHeader(k) { return String(k).toLowerCase() in this._headers; }
    getHeaders() { return Object.assign(Object.create(null), this._headers); } getHeaderNames() { return Object.keys(this._headers); } getRawHeaderNames() { return Object.values(this._names); }
    flushHeaders() {} setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
  }
  class ClientRequest extends OutgoingMessage {
    constructor(input, options, cb, defaults) {
      super();
      if (typeof input === 'string' || input instanceof N.global.URL) { const u = new N.global.URL(String(input)); input = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, auth: u.username ? `${u.username}:${u.password}` : undefined }; } else { cb = options; options = input; input = {}; }
      if (typeof options === 'function') { cb = options; options = {}; }
      const o = { ...defaults, ...input, ...(options || {}) };
      this.method = (o.method || 'GET').toUpperCase(); this.protocol = o.protocol || defaults.protocol; this.host = o.hostname || o.host || 'localhost';
      this.path = o.path || '/'; this.port = o.port || (this.protocol === 'https:' ? 443 : 80); this.agent = o.agent; this.reusedSocket = false; this.aborted = false; this._body = [];
      for (const [k, v] of Object.entries(o.headers || {})) this.setHeader(k, v);
      if (cb) this.once('response', cb);
      this.socket = null;
    }
    _write(chunk, enc, cb) { this._body.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk); cb(); }
    _final(cb) { cb(); this._send(); }
    abort() { this.aborted = true; this.destroy(); }
    _send() {
      const url = `${this.protocol}//${this.host}${(this.protocol === 'https:' && +this.port === 443) || (this.protocol === 'http:' && +this.port === 80) ? '' : ':' + this.port}${this.path}`;
      if (!N.fetch) { N.nextTick(() => this.emit('error', notFound(this.host))); return; }
      N.fetch(url, { method: this.method, headers: this.getHeaders(), body: this._body.length ? Buffer.concat(this._body) : null }, (err, res) => {
        if (err) { this.emit('error', err); return; }
        const m = new IncomingMessage(null);
        m.statusCode = res.status; m.statusMessage = res.statusText || STATUS_CODES[res.status] || '';
        for (const [k, v] of res.headers) { m.rawHeaders.push(k, v); const l = k.toLowerCase(); m.headers[l] = l in m.headers ? (l === 'set-cookie' ? [].concat(m.headers[l], v) : `${m.headers[l]}, ${v}`) : (l === 'set-cookie' ? [v] : v); }
        this.res = m;
        this.emit('response', m);
        res.body((chunk) => { if (chunk) m.push(Buffer.from(chunk)); else { m.complete = true; m.push(null); } }, (e) => m.destroy(e));
      });
    }
  }
  /*
   * The kernel's fetch (FETCH, src/node/host.js): cb(err) or cb(null, { status, statusText, headers,
   * body(onChunk, onError) }) -- the body's chunks then null at its end, read as the loop finds them ready.
   */
  const FETCH = 0x10002;
  N.fetch = (url, init, cb) => {
    const fd = N.scope(() => N.sys(FETCH, N.str(JSON.stringify({ url, method: init.method || 'GET', headers: init.headers || {} }))));
    if (fd < 0) {
      const host = (() => { try { return new N.global.URL(url).hostname; } catch { return url; } })();
      N.nextTick(cb, fd === -101 ? notFound(host) : Object.assign(new Error(`connect EACCES ${host}: MIRAGE lets a program reach registry.npmjs.org only`), { errno: fd, code: 'EACCES', syscall: 'connect', hostname: host }));
      return;
    }
    let head = null, pending = [], onChunk = null, onError = null, stop = null, ended = false;
    const deliver = () => { if (!onChunk) return; for (const c of pending.splice(0)) onChunk(c); if (ended) onChunk(null); };
    let acc = new Uint8Array(0);
    const finish = () => { if (stop) { stop(); stop = null; } try { N.fsio.closeSync ? N.fsio.closeSync(fd) : N.sys(6, fd); } catch { /* closed */ } };
    const read = () => {
      const b = Buffer.allocUnsafe(65536);
      let n;
      try { n = N.fsio.readSync(fd, b, 0, 65536, null); } catch (e) { if (e.code === 'EAGAIN') return; finish(); if (onError) onError(e); else cb(e); return; }
      if (!n) {
        ended = true; finish();
        if (!head) { cb(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); return; }
        deliver(); return;
      }
      let chunk = b.subarray(0, n);
      if (!head) {
        const all = new Uint8Array(acc.length + chunk.length); all.set(acc); all.set(chunk, acc.length);
        const nl = all.indexOf(10);
        if (nl < 0) { acc = all; return; }
        head = JSON.parse(N.utf8Decode(all, 0, nl));
        chunk = all.subarray(nl + 1);
        if (head.error) { ended = true; finish(); cb(Object.assign(new Error(head.error), { code: head.code })); return; }
        cb(null, { status: head.status, statusText: head.statusText, headers: head.headers, url: head.url, body: (f, e) => { onChunk = f; onError = e; deliver(); } });
      }
      if (chunk.length) pending.push(Buffer.from(chunk));
      deliver();
    };
    stop = N.watch({ fd, events: 1, ready: read });
  };
  const request = (defaults) => (input, options, cb) => new ClientRequest(input, options, cb, defaults);
  const get = (defaults) => (input, options, cb) => { const r = request(defaults)(input, options, cb); r.end(); return r; };
  const globalAgent = new Agent(), httpsGlobalAgent = new HttpsAgent();
  const notServer = () => { throw unavailable('http.createServer'); };
  const httpMod = { Agent, globalAgent, ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse: OutgoingMessage, Server: net.Server, STATUS_CODES, METHODS,
    request: request({ protocol: 'http:', agent: globalAgent }), get: get({ protocol: 'http:', agent: globalAgent }), createServer: notServer, maxHeaderSize: 16384,
    validateHeaderName: (n) => { if (!/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(n)) throw N.nodeError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${n}"]`); },
    validateHeaderValue: () => {}, setMaxIdleHTTPParsers: () => {} };
  const httpsMod = { Agent: HttpsAgent, globalAgent: httpsGlobalAgent, request: request({ protocol: 'https:', agent: httpsGlobalAgent }), get: get({ protocol: 'https:', agent: httpsGlobalAgent }), createServer: notServer, Server: net.Server };
  Object.assign(N.builtins, { http: httpMod, https: httpsMod, net, tls, dns, 'dns/promises': dns.promises });
}
