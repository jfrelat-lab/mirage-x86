// stream.js — Node's `stream`, smaller: Readable (paused and flowing, push, pipe, async iteration),
// Writable (write, end, finish, a buffer of what waits), Duplex, Transform, PassThrough, pipeline,
// finished. Object mode, highWaterMark and backpressure as Node has them; not cork nor readable.wrap.
// A part of the HLE node (src/node/kernel.js).
export function stream(N) {
  const EE = N.EventEmitter, tick = (f, ...a) => N.nextTick(f, ...a);
  const destroyImpl = function (err, cb) {
    if (this.destroyed) { if (cb) cb(err); return this; }
    this.destroyed = true;
    const done = (e) => {
      if (e && !this._errored) { this._errored = e; tick(() => this.emit('error', e)); }
      if (this._emitClose !== false) tick(() => { this.closed = true; this.emit('close'); });
      if (cb) cb(e);
    };
    this._destroy(err || null, done);
    return this;
  };

  function Readable(opts = {}) {
    if (!(this instanceof Readable)) return new Readable(opts);
    EE.call(this);
    const om = !!(opts.objectMode || opts.readableObjectMode);
    this._r = { objectMode: om, hwm: opts.highWaterMark ?? opts.readableHighWaterMark ?? (om ? 16 : 65536), buffer: [], length: 0, flowing: null, ended: false, endEmitted: false, reading: false, encoding: null, decoder: null, pipes: [] };
    if (opts.encoding) this.setEncoding(opts.encoding);
    if (typeof opts.read === 'function') this._read = opts.read;
    if (typeof opts.destroy === 'function') this._destroy = opts.destroy;
    if (typeof opts.construct === 'function') opts.construct.call(this, (e) => { if (e) this.destroy(e); });
    this.destroyed = false; this.readable = true; this._emitClose = opts.emitClose !== false;
    if (opts.signal) opts.signal.addEventListener?.('abort', () => this.destroy(new Error('The operation was aborted')));
  }
  Object.setPrototypeOf(Readable.prototype, EE.prototype); Object.setPrototypeOf(Readable, EE);
  const R = Readable.prototype;
  R._read = function () { throw N.nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _read() method is not implemented'); };
  R._destroy = function (err, cb) { cb(err); };
  R.destroy = destroyImpl;
  R.setEncoding = function (enc) { this._r.encoding = N.normEncoding(enc) || 'utf8'; this._r.decoder = new N.StringDecoder(this._r.encoding); return this; };
  R.push = function (chunk, enc) {
    const s = this._r;
    if (chunk === null) { s.ended = true; s.reading = false; maybeEnd(this); flow(this); return false; }
    if (!s.objectMode && typeof chunk === 'string') chunk = N.Buffer.from(chunk, enc || 'utf8');
    else if (!s.objectMode && chunk instanceof Uint8Array && !(chunk instanceof N.Buffer)) chunk = N.Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (s.decoder && !s.objectMode) chunk = s.decoder.write(chunk);
    s.reading = false;
    if (s.objectMode || chunk.length) { s.buffer.push(chunk); s.length += s.objectMode ? 1 : chunk.length; }
    if (s.flowing) tick(() => flow(this)); else this.emit('readable');
    return s.length < s.hwm;
  };
  R.unshift = function (chunk) { const s = this._r; s.buffer.unshift(chunk); s.length += s.objectMode ? 1 : chunk.length; };
  const pull = (st) => {
    const s = st._r;
    if (s.ended || s.reading || st.destroyed) return;
    if (s.length >= s.hwm && s.length > 0) return;
    s.reading = true;
    st._read(s.objectMode ? 1 : s.hwm);
  };
  R.read = function (n) {
    const s = this._r;
    if (s.length === 0) { pull(this); maybeEnd(this); return null; }
    let chunk;
    if (s.objectMode || n === undefined || n >= s.length) {
      if (s.objectMode) chunk = s.buffer.shift();
      else { chunk = s.decoder ? s.buffer.join('') : s.buffer.length === 1 ? s.buffer[0] : N.Buffer.concat(s.buffer); s.buffer = []; }
      s.length -= s.objectMode ? 1 : chunk.length;
    } else {
      const all = s.decoder ? s.buffer.join('') : N.Buffer.concat(s.buffer);
      chunk = all.slice(0, n); const rest = all.slice(n);
      s.buffer = rest.length ? [rest] : []; s.length = rest.length;
    }
    if (s.length < s.hwm) tick(() => pull(this));
    if (s.length === 0) tick(() => maybeEnd(this));
    return chunk;
  };
  const flow = (st) => {
    const s = st._r;
    while (s.flowing && s.buffer.length) {
      const chunk = s.buffer.shift(); s.length -= s.objectMode ? 1 : chunk.length;
      st.emit('data', chunk);
    }
    if (s.flowing && !s.ended) pull(st);
    maybeEnd(st);
  };
  const maybeEnd = (st) => {
    const s = st._r;
    if (s.ended && s.length === 0 && !s.endEmitted && (s.flowing || st.listenerCount('readable') > 0 || s.flowing === false && false)) {
      if (s.decoder) { const rest = s.decoder.end(); if (rest) { st.emit('data', rest); } }
      s.endEmitted = true; st.readable = false;
      tick(() => { st.emit('end'); if (st._autoDestroy !== false) st.destroy(); });
    }
  };
  R.on = R.addListener = function (ev, fn) {
    const r = EE.prototype.on.call(this, ev, fn), s = this._r;
    if (ev === 'data' && s.flowing !== false) this.resume();
    else if (ev === 'readable') { s.flowing = false; tick(() => { pull(this); if (s.length) this.emit('readable'); maybeEnd(this); }); }
    return r;
  };
  R.resume = function () { const s = this._r; if (!s.flowing) { s.flowing = true; this.emit('resume'); tick(() => flow(this)); } return this; };
  R.pause = function () { if (this._r.flowing !== false) { this._r.flowing = false; this.emit('pause'); } return this; };
  R.isPaused = function () { return this._r.flowing === false; };
  R.pipe = function (dest, opts = {}) {
    this._r.pipes.push(dest);
    this.on('data', (chunk) => { if (dest.write(chunk) === false) { this.pause(); dest.once('drain', () => this.resume()); } });
    if (opts.end !== false && dest !== N.process.stdout && dest !== N.process.stderr) this.once('end', () => dest.end());
    dest.emit('pipe', this);
    return dest;
  };
  R.unpipe = function (dest) { this._r.pipes = dest ? this._r.pipes.filter((d) => d !== dest) : []; this.removeAllListeners('data'); return this; };
  R[Symbol.asyncIterator] = function () {
    const st = this, queue = [], waiting = [];
    let done = false, error = null;
    st.on('data', (c) => { if (waiting.length) waiting.shift().resolve({ value: c, done: false }); else queue.push(c); st.pause(); });
    st.once('end', () => { done = true; while (waiting.length) waiting.shift().resolve({ value: undefined, done: true }); });
    st.once('error', (e) => { error = e; while (waiting.length) waiting.shift().reject(e); });
    return {
      next() {
        if (queue.length) { const v = queue.shift(); if (!queue.length) st.resume(); return Promise.resolve({ value: v, done: false }); }
        if (error) return Promise.reject(error);
        if (done) return Promise.resolve({ value: undefined, done: true });
        st.resume();
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      },
      return() { st.destroy(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  R.toArray = async function () { const out = []; for await (const c of this) out.push(c); return out; };
  Object.defineProperty(R, 'readableEnded', { get() { return this._r.endEmitted; } });
  Object.defineProperty(R, 'readableLength', { get() { return this._r.length; } });
  Object.defineProperty(R, 'readableObjectMode', { get() { return this._r.objectMode; } });
  Object.defineProperty(R, 'readableHighWaterMark', { get() { return this._r.hwm; } });
  Object.defineProperty(R, 'readableFlowing', { get() { return this._r.flowing; } });
  Object.defineProperty(R, 'readableEncoding', { get() { return this._r.encoding; } });
  Readable.from = (iterable, opts = {}) => {
    const it = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator] ? iterable[Symbol.iterator]() : null;
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) { const r = new Readable({ objectMode: true, ...opts, read() { this.push(iterable); this.push(null); } }); return r; }
    let busy = false;
    return new Readable({ objectMode: true, ...opts, read() { if (busy) return; busy = true; Promise.resolve(it.next()).then(({ value, done }) => { busy = false; if (done) this.push(null); else this.push(value); }, (e) => this.destroy(e)); } });
  };

  function Writable(opts = {}) {
    if (!(this instanceof Writable) && !(this instanceof Duplex)) return new Writable(opts);
    EE.call(this);
    const om = !!(opts.objectMode || opts.writableObjectMode);
    this._w = { objectMode: om, hwm: opts.highWaterMark ?? opts.writableHighWaterMark ?? (om ? 16 : 65536), length: 0, queue: [], writing: false, ending: false, ended: false, finished: false, needDrain: false, decode: opts.decodeStrings !== false, enc: opts.defaultEncoding || 'utf8' };
    if (typeof opts.write === 'function') this._write = opts.write;
    if (typeof opts.writev === 'function') this._writev = opts.writev;
    if (typeof opts.final === 'function') this._final = opts.final;
    if (typeof opts.destroy === 'function') this._destroy = opts.destroy;
    this.destroyed = false; this.writable = true; this._emitClose = opts.emitClose !== false;
  }
  Object.setPrototypeOf(Writable.prototype, EE.prototype); Object.setPrototypeOf(Writable, EE);
  const W = Writable.prototype;
  W._write = function (chunk, enc, cb) { if (this._writev) this._writev([{ chunk, encoding: enc }], cb); else throw N.nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _write() method is not implemented'); };
  W._destroy = function (err, cb) { cb(err); };
  W.destroy = destroyImpl;
  W.write = function (chunk, enc, cb) {
    const s = this._w;
    if (typeof enc === 'function') { cb = enc; enc = null; }
    if (s.ending) { const e = N.nodeError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end'); tick(() => { if (cb) cb(e); this.emit('error', e); }); return false; }
    if (chunk === null) throw N.nodeError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream');
    if (!s.objectMode) {
      if (typeof chunk === 'string') { if (s.decode) { chunk = N.Buffer.from(chunk, enc || s.enc); enc = 'buffer'; } }
      else if (chunk instanceof Uint8Array) { if (!(chunk instanceof N.Buffer)) chunk = N.Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength); enc = 'buffer'; }
      else throw N.invalidArg('chunk', 'of type string or an instance of Buffer, TypedArray, or DataView', chunk);
    }
    const len = s.objectMode ? 1 : chunk.length;
    s.length += len;
    const ret = s.length < s.hwm;
    if (!ret) s.needDrain = true;
    s.queue.push({ chunk, enc: enc || s.enc, cb, len });
    if (!s.writing) doWrite(this);
    return ret;
  };
  const doWrite = (st) => {
    const s = st._w;
    if (s.writing || !s.queue.length || st.destroyed) { if (!s.queue.length && s.ending && !s.writing) finish(st); return; }
    const { chunk, enc, cb, len } = s.queue.shift();
    s.writing = true;
    let sync = true;
    st._write(chunk, enc, (err) => {
      const after = () => {
        s.writing = false; s.length -= len;
        if (err) { if (cb) cb(err); st.destroy(err); return; }
        if (cb) cb();
        if (s.needDrain && s.length === 0) { s.needDrain = false; st.emit('drain'); }
        doWrite(st);
      };
      if (sync) tick(after); else after();
    });
    sync = false;
  };
  const finish = (st) => {
    const s = st._w;
    if (s.finished || s.prefinish) return;
    s.prefinish = true;
    const done = (err) => { if (err) { st.destroy(err); return; } s.finished = true; st.writable = false; tick(() => { st.emit('finish'); if (st._autoDestroy !== false && (!st._r || st._r.endEmitted)) st.destroy(); }); };
    if (st._final) st._final(done); else done();
  };
  W.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; } else if (typeof enc === 'function') { cb = enc; enc = null; }
    if (chunk !== null && chunk !== undefined) this.write(chunk, enc);
    const s = this._w;
    if (cb) { if (s.finished) tick(cb); else this.once('finish', cb); }
    if (!s.ending) { s.ending = true; if (!s.writing && !s.queue.length) tick(() => finish(this)); }
    return this;
  };
  W.cork = function () {}; W.uncork = function () {};
  W.setDefaultEncoding = function (e) { this._w.enc = e; return this; };
  Object.defineProperty(W, 'writableEnded', { get() { return this._w.ending; } });
  Object.defineProperty(W, 'writableFinished', { get() { return this._w.finished; } });
  Object.defineProperty(W, 'writableLength', { get() { return this._w.length; } });
  Object.defineProperty(W, 'writableObjectMode', { get() { return this._w.objectMode; } });
  Object.defineProperty(W, 'writableHighWaterMark', { get() { return this._w.hwm; } });
  Object.defineProperty(W, 'writableNeedDrain', { get() { return this._w.needDrain; } });

  function Duplex(opts = {}) {
    if (!(this instanceof Duplex)) return new Duplex(opts);
    Readable.call(this, opts);
    const r = this._r;
    Writable.call(this, opts);
    this._r = r;
    if (opts.allowHalfOpen === false) this.once('end', () => this.end());
  }
  Object.setPrototypeOf(Duplex.prototype, Readable.prototype); Object.setPrototypeOf(Duplex, Readable);
  for (const k of Object.getOwnPropertyNames(W)) if (k !== 'constructor' && k !== 'destroy' && k !== '_destroy' && !Object.prototype.hasOwnProperty.call(Duplex.prototype, k)) Object.defineProperty(Duplex.prototype, k, Object.getOwnPropertyDescriptor(W, k));

  function Transform(opts = {}) {
    if (!(this instanceof Transform)) return new Transform(opts);
    Duplex.call(this, opts);
    if (typeof opts.transform === 'function') this._transform = opts.transform;
    if (typeof opts.flush === 'function') this._flush = opts.flush;
  }
  Object.setPrototypeOf(Transform.prototype, Duplex.prototype); Object.setPrototypeOf(Transform, Duplex);
  Transform.prototype._transform = function () { throw N.nodeError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _transform() method is not implemented'); };
  Transform.prototype._write = function (chunk, enc, cb) { this._transform(chunk, enc, (err, data) => { if (err) { cb(err); return; } if (data !== undefined && data !== null) this.push(data); cb(); }); };
  Transform.prototype._read = function () {};
  Transform.prototype._final = function (cb) {
    const end = (err, data) => { if (err) { cb(err); return; } if (data !== undefined && data !== null) this.push(data); this.push(null); cb(); };
    if (this._flush) this._flush(end); else end();
  };
  function PassThrough(opts) { if (!(this instanceof PassThrough)) return new PassThrough(opts); Transform.call(this, opts); }
  Object.setPrototypeOf(PassThrough.prototype, Transform.prototype); Object.setPrototypeOf(PassThrough, Transform);
  PassThrough.prototype._transform = function (chunk, enc, cb) { cb(null, chunk); };

  const finished = (st, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    let called = false;
    const done = (err) => { if (!called) { called = true; cb(err); } };
    st.once('error', done);
    if (st._w && !st._r) st.once('finish', () => done());
    else st.once('end', () => done());
    st.once('close', () => done());
    return () => {};
  };
  const pipeline = (...streams) => {
    const cb = typeof streams.at(-1) === 'function' ? streams.pop() : null;
    if (Array.isArray(streams[0])) streams = streams[0];
    const list = streams.map((s) => (typeof s === 'function' || (s && !s.on && (s[Symbol.asyncIterator] || s[Symbol.iterator])) ? (typeof s === 'function' ? Readable.from(s()) : Readable.from(s)) : s));
    let error = null;
    for (let i = 0; i < list.length - 1; i++) list[i].pipe(list[i + 1]);
    for (const s of list) s.once('error', (e) => { if (!error) { error = e; for (const t of list) if (!t.destroyed) t.destroy(); if (cb) cb(e); } });
    const last = list.at(-1);
    finished(last, (e) => { if (!error && cb) cb(e); });
    return last;
  };
  const promises = {
    pipeline: (...s) => new Promise((res, rej) => pipeline(...s, (e) => (e ? rej(e) : res()))),
    finished: (st, o) => new Promise((res, rej) => finished(st, o, (e) => (e ? rej(e) : res()))),
  };
  const Stream = function Stream(opts) { EE.call(this, opts); };
  Object.setPrototypeOf(Stream.prototype, EE.prototype); Object.setPrototypeOf(Stream, EE);
  Stream.prototype.pipe = R.pipe;
  Object.assign(Stream, { Readable, Writable, Duplex, Transform, PassThrough, Stream, pipeline, finished, promises,
    isReadable: (s) => !!(s && s._r && !s.destroyed && !s._r.endEmitted), isErrored: (s) => !!(s && s._errored), addAbortSignal: (sig, s) => s,
    getDefaultHighWaterMark: (om) => (om ? 16 : 65536), setDefaultHighWaterMark: () => {} });
  N.stream = Stream;

  // string_decoder: UTF-8 (and the others) across chunk boundaries.
  class StringDecoder {
    constructor(enc = 'utf8') { this.encoding = N.normEncoding(enc); if (!this.encoding) throw N.nodeError(TypeError, 'ERR_UNKNOWN_ENCODING', `Unknown encoding: ${enc}`); this.pending = new Uint8Array(0); }
    write(b) {
      if (typeof b === 'string') return b;
      let u = b;
      if (this.pending.length) { u = new Uint8Array(this.pending.length + b.length); u.set(this.pending); u.set(b, this.pending.length); }
      let cut = u.length;
      if (this.encoding === 'utf8') {
        let k = u.length - 1, n = 0;
        while (k >= 0 && n < 3 && (u[k] & 0xc0) === 0x80) { k--; n++; }
        if (k >= 0) { const c = u[k], need = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0; if (need > n) cut = k; }
      } else if (this.encoding === 'utf16le') cut = u.length & ~1;
      else if (this.encoding === 'base64' || this.encoding === 'base64url') cut = u.length - (u.length % 3);
      this.pending = u.slice(cut);
      return N.decodeBuffer(u, this.encoding, 0, cut);
    }
    end(b) { let s = b ? this.write(b) : ''; if (this.pending.length) { s += N.decodeBuffer(this.pending, this.encoding, 0, this.pending.length); this.pending = new Uint8Array(0); } return s; }
    text(b, i) { return this.write(b.subarray(i)); }
  }
  N.StringDecoder = StringDecoder;
}
