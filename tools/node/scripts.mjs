// scripts.mjs — the test scripts tools/node/check.mjs runs on MIRAGE's HLE node and on Node itself. Each:
// { files: { name: source }, args, stdin, stderr: compare stderr too }. The first file is the one run.
// They print nothing of the host's (no absolute path, no time): what they print must be the same.
export const scripts = {
  inspect: { files: { 'main.js': `
const v = [1, 'two', [3, [4, [5, [6]]]], { a: { b: { c: { d: 1 } } } }, null, undefined, true, -0, 10n, Symbol('s')];
for (const x of v) console.log(x);
console.log(v);
console.log({ s: "it's", t: 'say "hi"', u: 'both \\' and "', n: 'line\\nbreak', k: 'a-b' }, { 'a-b': 1, b2: 2, '3c': 3 });
console.log(new Map([['a', 1], [{ k: 1 }, [2]]]), new Set([1, 'x', [2]]), new Map(), new Set());
console.log([function named() {}, () => {}, class A {}, class B extends Array {}, async function af() {}, function* g() {}]);
console.log(Array.from({ length: 30 }, (_, i) => i * 7));
console.log(Array.from({ length: 120 }, (_, i) => i));
console.log(['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'honeydew', 'kiwi']);
console.log([1, , 3, , , 6], new Array(5), [undefined, null]);
console.log({ x: 'a'.repeat(100) });
console.log({ long: 'line one\\nline two that goes on and on and on and on and on and on and on and on and on' });
const c = { name: 'c' }; c.self = c; c.list = [c, { c }]; console.log(c);
class Point { constructor() { this.x = 1; this.y = 2; } } console.log(new Point(), [new Point()], Object.create(null), Object.assign(Object.create(null), { a: 1 }));
console.log(new Uint8Array([1, 2, 3]), new Float64Array(2), Buffer.from('hello'), new ArrayBuffer(3));
console.log(new Date(0), /re+gex/gi, new Number(3), new String('str'), new Boolean(false));
console.log({ get g() { return 1; }, set s(v) {}, get gs() { return 1; }, set gs(v) {} });
console.log({ [Symbol('k')]: 1, f() {}, nested: { arr: [[1, 2, [3, 4, [5]]]] } });
console.log(Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'item' + i })));
console.log('%s is %d years and %i, %f, %j %o %O %%, %c.', 'Bob', 42.5, 42.9, '3.5', { a: [1] }, [1], { b: 2 }, 'css', 'extra', 7);
console.log('%s', { a: { b: { c: 1 } } }, '%s', 3n, -0);
console.log(require('util').inspect({ a: { b: { c: { d: { e: 1 } } } } }, { depth: 0 }), require('util').inspect('x'), require('util').format('%d', '0x10'));
console.log([[]], [{}], {a: []}, {a: {}}, [[[[[1]]]]]);
console.log({ a: 1, b: 'two', c: [3], d: { e: 4 }, f: null, g: undefined, h: true, i: 1.5, j: -1, k: 'some longer string value here' });
console.log(process.argv.length, typeof process.env.PATH, [1.5, -2.25, 1e21, 1e-7, NaN, Infinity]);
` } },
  errors: { files: { 'main.js': `
try { require('fs').readFileSync('nope.txt'); } catch (e) { console.log(e.message, e.code, e.errno, e.syscall, e.path); }
try { require('fs').mkdirSync('.'); } catch (e) { console.log(e.message); }
try { require('fs').rmdirSync('main.js'); } catch (e) { console.log(e.message); }
try { require('fs').readdirSync('main.js'); } catch (e) { console.log(e.message); }
try { require('fs').openSync('d/x', 'r'); } catch (e) { console.log(e.message); }
try { require('./missing'); } catch (e) { console.log(e.message.split('\\n')[0], e.code); }
try { Buffer.alloc(-1); } catch (e) { console.log(e.name, e.code); }
try { require('path').join(1); } catch (e) { console.log(e.message, e.code, e.name); }
try { new (require('events'))().emit('error', new Error('boom')); } catch (e) { console.log(e.message); }
const err = new Error('with props'); err.code = 'E_X'; console.log(Object.keys(err), err.code);
process.on('exit', (c) => console.log('exit', c));
process.exitCode = 3;
` } },
  fs: { files: { 'main.js': `
const fs = require('fs'), path = require('path');
fs.mkdirSync('a/b/c', { recursive: true });
console.log(fs.mkdirSync('a/b/c/d/e', { recursive: true }) !== undefined, fs.mkdirSync('a', { recursive: true }));
fs.writeFileSync('a/b/one.txt', 'one\\n'); fs.appendFileSync('a/b/one.txt', 'two\\n');
fs.writeFileSync('a/bin.dat', Buffer.from([0, 1, 2, 255]));
console.log(fs.readFileSync('a/b/one.txt', 'utf8'), fs.readFileSync('a/bin.dat'), fs.existsSync('a/b'), fs.existsSync('zz'));
const st = fs.statSync('a/b/one.txt'); console.log(st.isFile(), st.isDirectory(), st.size, (st.mode & 0o777).toString(8).length);
console.log(fs.readdirSync('a').sort(), fs.readdirSync('a', { withFileTypes: true }).map((d) => [d.name, d.isDirectory(), d.isFile()]).sort());
console.log(fs.readdirSync('a', { recursive: true }).sort());
fs.renameSync('a/b/one.txt', 'a/two.txt'); fs.copyFileSync('a/two.txt', 'a/three.txt');
fs.symlinkSync('two.txt', 'a/link'); console.log(fs.readlinkSync('a/link'), fs.lstatSync('a/link').isSymbolicLink(), fs.readFileSync('a/link', 'utf8').length);
console.log(path.relative(process.cwd(), fs.realpathSync('a/link')));
const fd = fs.openSync('a/rw.txt', 'w+'); fs.writeSync(fd, 'hello world'); const b = Buffer.alloc(5); console.log(fs.readSync(fd, b, 0, 5, 6), b.toString()); fs.closeSync(fd);
fs.truncateSync('a/rw.txt', 5); console.log(fs.readFileSync('a/rw.txt', 'latin1'));
fs.unlinkSync('a/three.txt'); fs.rmSync('a/b', { recursive: true });
console.log(fs.readdirSync('a').sort());
fs.readFile('a/two.txt', 'utf8', (e, d) => { console.log('cb', e, d.length); fs.promises.readFile('a/rw.txt', 'utf8').then((x) => console.log('promise', x)); });
console.log('sync first');
fs.promises.readdir('a').then((l) => console.log('readdir', l.sort()));
const w = fs.createWriteStream('a/stream.txt'); w.write('s1\\n'); w.end('s2\\n', () => { console.log('written', fs.readFileSync('a/stream.txt', 'utf8')); const r = fs.createReadStream('a/stream.txt', { encoding: 'utf8' }); r.on('data', (c) => console.log('chunk', JSON.stringify(c))); r.on('end', () => console.log('end')); });
` } },
  path: { files: { 'main.js': `
const p = require('path');
for (const x of ['/a/b/c', 'a/b/', '/', '', '.', '..', 'a//b/../c/./d', '/a/b.tar.gz', '.bashrc', 'a.', '//x']) console.log(JSON.stringify([p.dirname(x), p.basename(x), p.extname(x), p.normalize(x), p.isAbsolute(x), p.parse(x)]));
console.log(p.join('a', '../..', 'b', '/c/'), p.resolve('/x', 'y', '../z'), p.relative('/a/b/c', '/a/d'), p.relative('/a', '/a/b/c'), p.basename('/x/y.js', '.js'), p.format({ dir: '/d', name: 'n', ext: 'e' }));
console.log(p.sep, p.delimiter, p.posix === p);
` } },
  events: { files: { 'main.js': `
const EE = require('events');
const e = new EE();
e.on('x', (a, b) => console.log('x1', a, b)); e.prependListener('x', () => console.log('x0')); e.once('x', () => console.log('once'));
console.log(e.emit('x', 1, 2), e.emit('x', 3, 4), e.emit('none'), e.listenerCount('x'), e.eventNames());
class My extends EE {} const m = new My(); m.on('a', function () { console.log(this instanceof My); }); m.emit('a');
EE.once(m, 'ready').then(([v]) => console.log('ready', v)); m.emit('ready', 42);
const f = () => console.log('removed?'); e.on('y', f); e.off('y', f); console.log(e.emit('y'));
` } },
  buffer: { files: { 'main.js': `
const b = Buffer.from('héllo wörld ✓ 😀');
console.log(b.length, b.toString('hex'), b.toString('base64'), b.toString('base64url'), b.toString('latin1').length);
console.log(Buffer.from(b.toString('base64'), 'base64').toString(), Buffer.from('68656c6c6f', 'hex').toString(), Buffer.from('aGk', 'base64').toString());
console.log(Buffer.byteLength('😀'), Buffer.concat([Buffer.from('a'), Buffer.from('bc')]).toString(), Buffer.compare(Buffer.from('a'), Buffer.from('b')));
const n = Buffer.alloc(16); n.writeUInt32LE(0xdeadbeef, 0); n.writeInt16BE(-2, 4); n.writeDoubleLE(1.5, 8);
console.log(n, n.readUInt32LE(0).toString(16), n.readInt16BE(4), n.readDoubleLE(8), n.readUInt8(1));
console.log(b.slice(0, 5).toString(), b.subarray(1, 3), b.indexOf('l'), b.lastIndexOf('l'), b.includes('wör'), b.equals(Buffer.from(b)));
console.log(Buffer.alloc(3, 'ab'), Buffer.from([256, -1, 3.7]), Buffer.from(new Uint16Array([1, 256]).buffer), JSON.stringify(Buffer.from('hi')));
console.log(Buffer.isBuffer(b), Buffer.isEncoding('utf-8'), Buffer.isEncoding('nope'), typeof Buffer.poolSize, Buffer.from('ab').toString('utf16le').length);
console.log(new TextDecoder().decode(new TextEncoder().encode('ok ✓')), atob(btoa('xyz')), Buffer.from([0xe2, 0x82]).toString(), Buffer.from('€').toString('ascii'));
` } },
  timers: { files: { 'main.js': `
const order = [];
// (a timeout of 0 and an immediate set from the main script run in either order in Node, by how long it
// took to start: from a timer's callback, the immediate is first)
setTimeout(() => order.push('t50'), 50);
setTimeout(() => { setTimeout(() => order.push('t0'), 0); setImmediate(() => order.push('imm')); }, 0);
process.nextTick(() => order.push('tick'));
Promise.resolve().then(() => order.push('promise'));
queueMicrotask(() => order.push('micro'));
const iv = setInterval(() => { order.push('iv'); if (order.filter((x) => x === 'iv').length === 3) clearInterval(iv); }, 20);
const t = setTimeout(() => order.push('never'), 20); clearTimeout(t);
setTimeout(() => { setImmediate(() => order.push('imm2')); process.nextTick(() => order.push('tick2')); }, 110);
setTimeout(() => console.log(order.join(' ')), 200);
setTimeout(() => console.log('unref'), 1000).unref();
(async () => { await new Promise((r) => setTimeout(r, 150)); order.push('await'); })();
` } },
  modules: { files: {
    'main.js': `
const a = require('./lib/a'), b = require('./lib/b.js'), data = require('./data.json');
console.log(a.name, b(), data, require('./lib') === require('./lib/index.js'));
console.log(require('pkg'), require('pkg/sub'), require('exp'), require('exp/feature'), require('@scope/thing'));
console.log(module.id, require.main === module, typeof require.resolve, require.cache[require.resolve('./lib/a')] !== undefined);
console.log(require('node:path') === require('path'), require('module').builtinModules.includes('fs'), require('module').isBuiltin('node:fs'));
console.log(require('./cycle1').done, Object.keys(require.cache).length > 3);
console.log(__filename.endsWith('/main.js'), require('path').dirname(__filename) === __dirname);
`,
    'lib/a.js': 'exports.name = "a"; exports.from = require("./b")();',
    'lib/b.js': 'module.exports = () => "b says hi";',
    'lib/index.js': 'module.exports = { index: true };',
    'data.json': '{"answer": 42, "list": [1, 2]}',
    'node_modules/pkg/package.json': '{"name": "pkg", "main": "./main.js"}',
    'node_modules/pkg/main.js': 'module.exports = "pkg main";',
    'node_modules/pkg/sub.js': 'module.exports = "pkg sub";',
    'node_modules/exp/package.json': '{"name": "exp", "exports": {".": {"import": "./esm.mjs", "require": "./cjs.js"}, "./feature": "./lib/feature.js"}}',
    'node_modules/exp/cjs.js': 'module.exports = "exp cjs";',
    'node_modules/exp/lib/feature.js': 'module.exports = "exp feature";',
    'node_modules/@scope/thing/index.js': 'module.exports = "scoped";',
    'cycle1.js': 'exports.done = false; const c2 = require("./cycle2"); exports.done = c2.sawPartial;',
    'cycle2.js': 'exports.sawPartial = require("./cycle1").done === false;',
  } },
  stdin: { files: { 'main.js': `
let all = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { all += c; });
process.stdin.on('end', () => { const lines = all.split('\\n').filter(Boolean); console.log(lines.length, lines.map((l) => l.toUpperCase()).join('|')); });
` }, stdin: 'one\ntwo\nthree\n' },
  readline: { files: { 'main.js': `
const rl = require('readline').createInterface({ input: process.stdin });
const seen = [];
rl.on('line', (l) => seen.push(l.split('').reverse().join('')));
rl.on('close', () => console.log(seen, seen.length));
` }, stdin: 'abc\r\ndef\nlast' },
  asynciter: { files: { 'main.js': `
(async () => {
  const rl = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
  let n = 0; for await (const line of rl) n += Number(line);
  console.log('sum', n);
  const { setTimeout: sleep } = require('timers/promises'); await sleep(5); console.log('slept');
  const s = require('stream'); const out = [];
  await s.promises.pipeline(s.Readable.from(['a', 'b', 'c']), new s.Transform({ objectMode: true, transform(c, e, cb) { cb(null, c.toUpperCase()); } }), new s.Writable({ objectMode: true, write(c, e, cb) { out.push(c); cb(); } }));
  console.log(out);
})();
` }, stdin: '1\n2\n3\n4\n' },
  stream: { files: { 'main.js': `
const { Readable, Writable, Transform, PassThrough } = require('stream');
const r = new Readable({ read() {} });
const got = [];
const up = new Transform({ transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); } });
const sink = new Writable({ write(chunk, enc, cb) { got.push(chunk.toString()); cb(); } });
sink.on('finish', () => console.log('finish', got.join('')));
sink.on('finish', () => { const r2 = Readable.from([1, 2, 3]); r2.on('data', (x) => console.log('obj', x)); r2.on('end', () => console.log('r2 end')); });
r.pipe(up).pipe(new PassThrough()).pipe(sink);
r.push('hello '); r.push('stream'); r.push(null);
` } },
  process: { files: { 'main.js': `
console.log(typeof process.platform, typeof process.pid, typeof process.cwd(), typeof process.title, typeof process.hrtime.bigint(), process.env.HOME, process.version.startsWith('v'));
process.env.FOO = 42; console.log(process.env.FOO, typeof process.env.FOO, 'FOO' in process.env, delete process.env.FOO, process.env.FOO);
process.chdir('sub'); console.log(require('path').basename(process.cwd())); process.chdir('..');
try { process.chdir('nowhere'); } catch (e) { console.log(e.code, e.syscall); }
console.log(typeof process.memoryUsage().heapUsed, process.argv.slice(2), process.exitCode, typeof process.umask());
console.log(require('os').EOL === '\\n', typeof require('os').platform(), typeof require('os').tmpdir(), require('os').endianness());
process.stdout.write('no newline'); process.stdout.write(' then one\\n');
console.error('to stderr'); console.info('info'); console.warn('warn');
console.log(typeof setTimeout(() => {}, 0).ref, typeof structuredClone, structuredClone(new Map([[1, { a: [1] }]])));
console.table([{ a: 1, b: 'x' }, { a: 2, c: true }]);
console.group('G'); console.log('inside'); console.group(); console.log('deeper'); console.groupEnd(); console.groupEnd(); console.log('out');
console.count(); console.count(); console.count('k'); console.assert(1 === 2, 'nope %s', 'fmt'); console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 });
`, 'sub/.keep': '' }, args: ['x', '--y'], stderr: true },
  exit: { files: { 'main.js': `
process.on('exit', (c) => { console.log('exiting with', c); });
setTimeout(() => console.log('never'), 100);
console.log('before');
process.exit(5);
` } },
  crypto: { files: { 'main.js': `
const c = require('crypto');
for (const a of ['md5', 'sha1', 'sha256', 'sha512', 'sha224']) console.log(a, c.createHash(a).update('abc').digest('hex'), c.createHash(a).update('').digest('base64'));
console.log(c.createHash('sha256').update('a'.repeat(1000)).update(Buffer.from('xyz')).digest('hex'));
console.log(c.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'), c.createHmac('md5', 'k'.repeat(100)).update('m').digest('hex'));
console.log(c.randomBytes(8).length, /^[0-9a-f-]{36}$/.test(c.randomUUID()), c.randomInt(5) < 5, c.timingSafeEqual(Buffer.from('a'), Buffer.from('a')));
` } },
  util: { files: { 'main.js': `
const util = require('util'), assert = require('assert');
console.log(util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), util.isDeepStrictEqual([1], ['1']), util.types.isDate(new Date()), util.types.isPromise(Promise.resolve()));
const sleep = util.promisify((ms, cb) => setTimeout(() => cb(null, ms * 2), ms)); sleep(5).then((v) => console.log('promisified', v));
function A() {} function B() {} util.inherits(B, A); console.log(new B() instanceof A, B.super_ === A);
try { assert.strictEqual(1, 2); } catch (e) { console.log(e.name, e.code, e.message.split('\\n')[0]); }
try { assert.deepStrictEqual({ a: 1 }, { a: 1 }); assert.ok(true); assert.throws(() => { throw new TypeError('t'); }, TypeError); console.log('asserts ok'); } catch (e) { console.log('bad', e.message); }
console.log(util.format('%s=%d', 'x', 5, 'rest'), util.inspect(new Error('e').message), util.types.isRegExp(/x/));
const { values, positionals } = util.parseArgs({ args: ['-v', '--name', 'n', 'pos', '--flag'], options: { v: { type: 'boolean' }, name: { type: 'string' }, flag: { type: 'boolean', short: 'f' } }, allowPositionals: true });
console.log(values, positionals);
const u = new URL('https://user:pw@Example.com:8080/a/../b/c?x=1&y=two#frag'); console.log(u.href, u.host, u.pathname, u.searchParams.get('y'), u.origin);
console.log(new URL('../d?q', 'http://h.com/a/b/c').href, require('url').fileURLToPath('file:///tmp/a%20b'), require('url').pathToFileURL('/x y').href);
console.log(require('querystring').parse('a=1&b=2&a=3'), require('querystring').stringify({ x: [1, 2], y: 'z w' }));
` } },
  uncaught: { files: { 'main.js': `
console.log('start');
setTimeout(() => { throw new Error('thrown later'); }, 1);
` } },
  rejection: { files: { 'main.js': `
process.on('unhandledRejection', (r) => { console.log('caught rejection', r.message); });
Promise.reject(new Error('nobody'));
setTimeout(() => console.log('still alive'), 5);
` } },
  eval: { files: { 'main.js': '' }, args: ['-p', '[1, 2, 3].map((x) => x * 2).concat(require("path").sep)'], runFile: false },
  stdinscript: { files: { 'main.js': '' }, args: ['-'], runFile: false, stdin: 'console.log("from stdin", 6 * 7)' },
  sort: { files: { 'main.js': `
const words = 'the quick brown fox jumps over the lazy dog'.split(' ');
const counts = {}; for (const w of words) counts[w] = (counts[w] || 0) + 1;
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
console.log(JSON.stringify({ deep: { list: words.slice(0, 3) } }, null, 2));
console.log([3, 1, 2].toSorted(), Object.groupBy(words, (w) => w.length), 'abc'.at(-1), [1, [2, [3]]].flat(Infinity), new Intl.NumberFormat('en-US').format(1234567.891));
` } },
  child: { files: { 'main.js': `
// child_process with node itself as the child (process.execPath: MIRAGE's HLE node, Node's own beside it)
const cp = require('child_process');
const r = cp.spawnSync(process.execPath, ['-e', 'console.log("hi from child", process.argv.length); process.stderr.write("err\\\\n"); process.exit(4)']);
console.log(r.status, r.signal, JSON.stringify(r.stdout.toString()), JSON.stringify(r.stderr.toString()), r.output.length, r.output[0]);
const s = cp.spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped in', encoding: 'utf8' });
console.log(JSON.stringify(s.stdout), s.status);
console.log(cp.spawnSync('nosuchcmd', ['x']).error.message, Object.keys(cp.spawnSync('nosuchcmd')));
const k = cp.spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']);
console.log(k.status, k.signal);
try { cp.execFileSync(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(2)'], { stdio: 'pipe' }); } catch (e) { console.log(e.message.split('\\n').slice(1), e.status); }
console.log(cp.execFileSync(process.execPath, ['-p', '6 * 7'], { encoding: 'utf8' }));
const c = cp.spawn(process.execPath, ['-e', 'setTimeout(() => console.log("late"), 20); console.log("early")']);
let out = '';
c.stdout.on('data', (d) => out += d);
c.on('spawn', () => console.log('spawned', typeof c.pid));
c.on('exit', (code, sig) => console.log('exit', code, sig, c.exitCode));
c.on('close', (code) => {
  console.log('close', code, JSON.stringify(out));
  const bad = cp.spawn('nosuchcmd', ['a']);
  bad.on('error', (e) => console.log('error', e.message, e.code, e.errno, e.syscall, e.path, e.spawnargs));
  bad.on('close', (code, sig) => {
    console.log('bad close', code, sig);
    cp.execFile(process.execPath, ['-e', 'console.log(1+1)'], (err, stdout, stderr) => {
      console.log('execFile', err, JSON.stringify(stdout), JSON.stringify(stderr));
      const t = cp.spawn(process.execPath, ['-e', 'let n = 0; process.stdin.on("data", (d) => n += d.length).on("end", () => console.log("got", n))'], { stdio: ['pipe', 'inherit', 'inherit'] });
      t.stdin.write('abc'); t.stdin.end('defg');
      t.on('close', (code) => {
        console.log('inherit close', code);
        const l = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        l.on('exit', (code, sig) => {
          console.log('killed', code, sig, l.killed);
          require('util').promisify(cp.execFile)(process.execPath, ['-p', '"promised"']).then((x) => console.log(x));
        });
        setTimeout(() => console.log('kill', l.kill()), 10);
      });
    });
  });
});
` } },
  // fs.watchFile polls stat as libuv's fs_poll does, the same on every platform: a change of the same
  // size seen (a file's times to the nanosecond), a file gone (its stats zeroed) and back, unwatchFile's stop.
  watchfile: { files: { 'main.js': `
const fs = require('fs');
fs.writeFileSync('x.txt', 'one');
const steps = [() => fs.writeFileSync('x.txt', 'two'), () => fs.writeFileSync('x.txt', 'three!'), () => fs.unlinkSync('x.txt'), () => fs.writeFileSync('x.txt', 'back')];
let step = 0;
const next = () => {
  if (step < steps.length) setTimeout(steps[step++], 80);
  else { fs.unwatchFile('x.txt', listener); console.log(w.listenerCount('change')); fs.unwatchFile('x.txt'); w.on('stop', () => console.log('stop')); }
};
const listener = (cur, prev) => {
  console.log('change', prev.size, '->', cur.size, cur.mtimeMs === 0, prev.mtimeMs === 0, cur.mtimeMs >= prev.mtimeMs, cur.isFile(), cur.mtime instanceof Date);
  next();
};
const w = fs.watchFile('x.txt', { interval: 20 }, listener);
fs.watchFile('nothere', { interval: 20, persistent: false }, () => console.log('never'));
console.log(w instanceof require('events'), typeof w.ref, typeof w.unref, fs.watchFile('x.txt', () => {}) === w);
fs.unwatchFile('x.txt', () => {});
next();
` } },
  // ES modules: import and export in every form, live bindings, a cycle, CommonJS and built-ins imported,
  // JSON, packages' "exports" and "imports", import.meta, top-level await, import()'s errors.
  esm: { files: { 'main.mjs': `
import fs, { readFileSync as rfs } from 'node:fs';
import { join } from 'path';
import * as lib from './lib.mjs';
import def, { count, bump, Klass, fromCycle } from './lib.mjs';
import anon from './anon.mjs';
import anonClass from './anonclass.mjs';
import arrow from './arrow.mjs';
import * as cjs from './c.cjs';
import cjsDefault, { a as ca } from './c.cjs';
import * as again from './again.mjs';
import data from './data.json' with { type: 'json' };
import pkg from 'pkg';
import { which } from 'pkg/sub';
import inner from '#inner';
import typed from './typed/x.js';
import detected from './detected.js';
import { createRequire } from 'node:module';
const strip = (s) => String(s).split(fs.realpathSync(process.cwd())).join('.').split(process.cwd()).join('.');
console.log(typeof fs.readFileSync, rfs === fs.readFileSync, join('a', 'b'));
console.log(lib, def.name, count);
bump(); bump();
console.log(count, lib.count, Klass.name, new Klass().hi(), fromCycle());
console.log(anon.name, anonClass.name, arrow.name, arrow());
console.log(cjs, cjsDefault === cjs.default, ca);
console.log(Object.keys(again), again.y, again.m === lib);
console.log(data, pkg, which, inner, typed, detected);
try { count = 5; } catch (e) { console.log(e.name); }
console.log(Object.keys(import.meta), strip(import.meta.url), strip(import.meta.filename), strip(import.meta.dirname), import.meta.main, strip(import.meta.resolve('./zz.js')));
const require = createRequire(import.meta.url);
const r = require('./lib.mjs'); console.log(r === lib, r.__esModule, r.count, require('./nodef.mjs'), require('./me.mjs'));
console.log(await Promise.resolve('top-level await'), (await import('./tla.mjs')).v);
for (const spec of ['./nope.mjs', './c', './sub', './data.json', './bad.mjs', './badc.mjs', 'nopkg', 'pkg/hidden', 'node:nope', '#nothing', './x.txt', 'http://x/y.js']) {
  try { await import(spec); console.log('loaded', spec); } catch (e) { console.log(e.name, e.code, strip(e.message)); }
}
const ns = await import('node:events'); console.log(typeof ns.default, typeof ns.once, ns.default === (await import('events')).default);
console.log(await import('./lib.mjs') === lib, typeof (await import('./c.cjs')).default.b);
`,
  'lib.mjs': `import { cycled } from './cycle.mjs';
export default function named() {}
export let count = 0;
export function bump() { count++; }
export class Klass { hi() { return 'hi'; } }
export const { a: destructured, b: [first, ...rest] } = { a: 1, b: [2, 3, 4] }, after = 5;
export var v1 = 1, v2;
export function fromCycle() { return cycled(); }
const local = 'L'; export { local as renamed, local as 'string name' };
export function inCycle() { return 'lib function, hoisted'; }
`,
  'cycle.mjs': `import { inCycle } from './lib.mjs';
export function cycled() { return inCycle(); }
console.log('cycle sees', typeof inCycle);
`,
  'anon.mjs': 'export default function () { return 1; }\n',
  'anonclass.mjs': 'export default class { }\n',
  'arrow.mjs': 'export default () => "arrow";\n',
  'c.cjs': "exports.a = 1; exports.b = function () {}; module.exports.c = 3; Object.defineProperty(exports, '__esModule', { value: true });\n",
  'again.mjs': "export * from './c.cjs';\nexport * as m from './lib.mjs';\nexport { renamed as y, default } from './lib.mjs';\n",
  'data.json': '{ "json": [1, 2] }\n',
  'nodef.mjs': 'export const q = 1;\n',
  'me.mjs': 'const v = { z: 1 };\nexport { v as "module.exports" };\nexport const w = 2;\n',
  'tla.mjs': 'export const v = await new Promise((r) => setTimeout(() => r("waited"), 5));\n',
  'bad.mjs': "import { nope } from './lib.mjs';\n",
  'badc.mjs': "import { nope } from './c.cjs';\n",
  'x.txt': 'text\n',
  'sub/.keep': '',
  'typed/package.json': '{ "type": "module" }\n',
  'typed/x.js': 'export default "typed as a module";\n',
  'detected.js': 'export default "detected as a module";\n',
  'package.json': '{ "imports": { "#inner": "./inner.mjs" } }\n',
  'inner.mjs': 'export default "imported by #inner";\n',
  'node_modules/pkg/package.json': '{ "name": "pkg", "exports": { ".": { "import": "./esm.mjs", "require": "./cjs.cjs" }, "./sub": "./sub.mjs" } }\n',
  'node_modules/pkg/esm.mjs': 'export default "pkg, its import condition";\n',
  'node_modules/pkg/cjs.cjs': 'module.exports = "pkg, its require condition";\n',
  'node_modules/pkg/sub.mjs': 'export const which = "pkg/sub";\n',
  'node_modules/pkg/hidden.mjs': 'export default 1;\n',
} },
  // ES modules from CommonJS: import(), require() of an ES module (a namespace, its default's facade,
  // "module.exports"), and of one that awaits.
  esmcjs: { files: { 'main.js': `
const strip = (s) => String(s).split(require('fs').realpathSync(process.cwd())).join('.').split(process.cwd()).join('.');
const m = require('./m.mjs'); console.log(m, require('util').types.isModuleNamespaceObject(m));
console.log(require('./t/esm.js'), require('./nodef.mjs'));
try { require('./tla.mjs'); } catch (e) { console.log(e.code, strip(e.message)); }
import('./m.mjs').then((ns) => console.log('import()', ns === m, ns.default === m.default, ns));
import('fs').then((ns) => console.log('import(fs)', typeof ns.readFileSync));
const o = { import(x) { return 'method ' + x; } }; console.log(o.import(1));
`,
  'm.mjs': 'export default function () {}\nexport const x = 1;\n',
  'nodef.mjs': 'export const q = 1;\n',
  'tla.mjs': 'await 0;\nexport const v = 1;\n',
  't/package.json': '{ "type": "module" }\n',
  't/esm.js': 'export const typed = true;\n',
} },
  // Errors of ES modules, as Node reports them: a throw at the top level, and a top-level await that
  // never settles (status 13).
  esmthrow: { files: { 'main.mjs': "import './dep.mjs';\nconsole.log('never');\n", 'dep.mjs': "console.log('dep runs');\nthrow new TypeError('from a module');\n" } },
  esmunsettled: { files: { 'main.mjs': "console.log('before');\nawait new Promise(() => {});\nconsole.log('never');\n" } },
  esmeval: { files: { 'main.js': '' }, args: ['-e', 'import { sep } from "path"; console.log("eval as a module", sep, typeof require);'], runFile: false },
};
