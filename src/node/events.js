// events.js — Node's `events`: EventEmitter, once, the error event. A part of the HLE node (src/node/kernel.js).
export function events(N) {
  const kCapture = Symbol('kCapture');
  function EventEmitter(opts) { EventEmitter.init.call(this, opts); }
  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._eventsCount = 0;
  EventEmitter.prototype._maxListeners = undefined;
  EventEmitter.defaultMaxListeners = 10;
  EventEmitter.errorMonitor = Symbol('events.errorMonitor');
  EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
  EventEmitter.init = function init() {
    if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) { this._events = Object.create(null); this._eventsCount = 0; }
    this._maxListeners = this._maxListeners || undefined;
    this[kCapture] = false;
  };
  const P = EventEmitter.prototype;
  P.setMaxListeners = function (n) { this._maxListeners = n; return this; };
  P.getMaxListeners = function () { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; };
  P.emit = function emit(type, ...args) {
    const events = this._events;
    if (type === 'error' && events !== undefined && events[EventEmitter.errorMonitor] !== undefined) this.emit(EventEmitter.errorMonitor, ...args);
    const handler = events !== undefined ? events[type] : undefined;
    if (handler === undefined) {
      if (type === 'error') {
        const er = args[0];
        if (er instanceof Error) throw er;
        const e = N.nodeError(Error, 'ERR_UNHANDLED_ERROR', `Unhandled error. (${N.inspect ? N.inspect(er) : String(er)})`);
        e.context = er; throw e;
      }
      return false;
    }
    if (typeof handler === 'function') handler.apply(this, args);
    else for (const h of handler.slice()) h.apply(this, args);
    return true;
  };
  const add = (target, type, listener, prepend) => {
    if (typeof listener !== 'function') throw N.invalidArg('listener', 'of type function', listener);
    let events = target._events;
    if (events === undefined) { events = target._events = Object.create(null); target._eventsCount = 0; }
    else if (events.newListener !== undefined) { target.emit('newListener', type, listener.listener ? listener.listener : listener); events = target._events; }
    const existing = events[type];
    if (existing === undefined) { events[type] = listener; ++target._eventsCount; }
    else if (typeof existing === 'function') events[type] = prepend ? [listener, existing] : [existing, listener];
    else if (prepend) existing.unshift(listener); else existing.push(listener);
    const m = target.getMaxListeners(), count = typeof events[type] === 'function' ? 1 : events[type].length;
    if (m > 0 && count > m && !events[type].warned) {
      if (typeof events[type] !== 'function') events[type].warned = true;
      const name = target.constructor && target.constructor.name ? target.constructor.name : 'EventEmitter';
      if (N.process) N.process.emitWarning(`Possible EventEmitter memory leak detected. ${count} ${String(type)} listeners added to [${name}]. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`, 'MaxListenersExceededWarning');
    }
    return target;
  };
  P.addListener = P.on = function (type, listener) { return add(this, type, listener, false); };
  P.prependListener = function (type, listener) { return add(this, type, listener, true); };
  const onceWrap = (target, type, listener) => {
    const state = { fired: false, target, type, listener };
    const w = function (...args) { if (!state.fired) { state.target.removeListener(state.type, w); state.fired = true; return state.listener.apply(state.target, args); } };
    w.listener = listener; return w;
  };
  P.once = function (type, listener) { if (typeof listener !== 'function') throw N.invalidArg('listener', 'of type function', listener); this.on(type, onceWrap(this, type, listener)); return this; };
  P.prependOnceListener = function (type, listener) { this.prependListener(type, onceWrap(this, type, listener)); return this; };
  P.removeListener = P.off = function (type, listener) {
    const events = this._events; if (events === undefined) return this;
    const list = events[type]; if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = Object.create(null);
      else { delete events[type]; if (events.removeListener) this.emit('removeListener', type, list.listener || listener); }
    } else if (typeof list !== 'function') {
      let pos = -1;
      for (let i = list.length - 1; i >= 0; i--) if (list[i] === listener || list[i].listener === listener) { pos = i; break; }
      if (pos < 0) return this;
      list.splice(pos, 1);
      if (list.length === 1) events[type] = list[0];
      if (events.removeListener !== undefined) this.emit('removeListener', type, listener);
    }
    return this;
  };
  P.removeAllListeners = function (type) {
    const events = this._events; if (events === undefined) return this;
    if (type === undefined) { this._events = Object.create(null); this._eventsCount = 0; return this; }
    if (events[type] !== undefined) { if (--this._eventsCount === 0) this._events = Object.create(null); else delete events[type]; }
    return this;
  };
  P.listeners = function (type) { const l = this._events && this._events[type]; return l === undefined ? [] : typeof l === 'function' ? [l.listener || l] : l.map((x) => x.listener || x); };
  P.rawListeners = function (type) { const l = this._events && this._events[type]; return l === undefined ? [] : typeof l === 'function' ? [l] : l.slice(); };
  P.listenerCount = function (type) { const l = this._events && this._events[type]; return l === undefined ? 0 : typeof l === 'function' ? 1 : l.length; };
  P.eventNames = function () { return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : []; };
  EventEmitter.listenerCount = (em, type) => em.listenerCount(type);
  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.usingDomains = false;
  EventEmitter.once = (em, name) => new Promise((resolve, reject) => {
    const onError = (err) => { em.removeListener(name, onEvent); reject(err); };
    const onEvent = (...args) => { if (name !== 'error') em.removeListener('error', onError); resolve(args); };
    em.once(name, onEvent);
    if (name !== 'error') em.once('error', onError);
  });
  EventEmitter.on = (em, name) => {
    const queue = [], waiting = [];
    em.on(name, (...args) => { if (waiting.length) waiting.shift()({ value: args, done: false }); else queue.push(args); });
    return { [Symbol.asyncIterator]() { return this; }, next() { return queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((r) => waiting.push(r)); }, return() { return Promise.resolve({ value: undefined, done: true }); } };
  };
  EventEmitter.getEventListeners = (em, name) => em.listeners(name);
  EventEmitter.setMaxListeners = (n, ...targets) => { if (!targets.length) EventEmitter.defaultMaxListeners = n; else for (const t of targets) t.setMaxListeners(n); };
  N.EventEmitter = EventEmitter;
}
