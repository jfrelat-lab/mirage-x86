// programs.mjs — WASI test programs, assembled by tools/wasi/wasm.mjs: each a module and how to run it.
// tools/wasi/check.mjs runs them on MIRAGE-LINUX and on Node's own WASI, and compares; tools/test.js
// runs them on MIRAGE-LINUX against what they printed there.
//
// Memory: 0-63 scratch (iovecs, results), 64-1023 numbers printed, 1024- the data, 8192- buffers.
import { module } from './wasm.mjs';

const W = 'wasi_snapshot_preview1';
const I = (n) => Array(n).fill('i32');
const IMPORTS = {
  fd_write: [I(4), ['i32']], fd_read: [I(4), ['i32']], fd_close: [I(1), ['i32']], proc_exit: [I(1), []],
  args_sizes_get: [I(2), ['i32']], args_get: [I(2), ['i32']], environ_sizes_get: [I(2), ['i32']], environ_get: [I(2), ['i32']],
  fd_seek: [['i32', 'i64', 'i32', 'i32'], ['i32']], fd_filestat_get: [I(2), ['i32']], fd_fdstat_get: [I(2), ['i32']],
  path_open: [['i32', 'i32', 'i32', 'i32', 'i32', 'i64', 'i64', 'i32', 'i32'], ['i32']],
  path_filestat_get: [I(5), ['i32']], path_create_directory: [I(3), ['i32']], path_remove_directory: [I(3), ['i32']],
  path_unlink_file: [I(3), ['i32']], path_rename: [I(6), ['i32']], path_symlink: [I(5), ['i32']], path_readlink: [I(6), ['i32']],
  fd_readdir: [['i32', 'i32', 'i32', 'i64', 'i32'], ['i32']], fd_prestat_get: [I(2), ['i32']], fd_prestat_dir_name: [I(3), ['i32']],
  clock_time_get: [['i32', 'i64', 'i32'], ['i32']], poll_oneoff: [I(4), ['i32']], random_get: [I(2), ['i32']],
};
const imports = (names) => names.map((n) => [W, n, ...IMPORTS[n]]);

// Helpers every program has: print(ptr, len) to stdout, num(n) the decimal of an i32 and a space.
const helpers = [
  { name: 'print', params: I(2), body: (o) => [
    o.i32(0), o.get(0), o.store(0), o.i32(0), o.get(1), o.store(4),
    o.i32(1), o.i32(0), o.i32(1), o.i32(8), o.call('fd_write'), o.drop] },
  { name: 'num', params: I(1), locals: I(1), body: (o) => [      // digits from 1022 down, then a space at 1023
    o.i32(1023), o.i32(32), o.store8(), o.i32(1023), o.set(1),
    o.loop(o.get(1), o.i32(1), o.sub, o.tee(1), o.get(0), o.i32(10), o.remu, o.i32(48), o.add, o.store8(),
      o.get(0), o.i32(10), o.divu, o.tee(0), o.brIf(0)),
    o.get(1), o.i32(1024), o.get(1), o.sub, o.call('print')] },
];
const prog = (names, data, body, locals = I(4)) => module({
  imports: imports(['fd_write', 'proc_exit', ...names.filter((n) => n !== 'fd_write' && n !== 'proc_exit')]),
  data, funcs: [...helpers, { name: '_start', export: true, locals, body }],
});
const NL = [1100, '\n'];
const nl = (o) => [o.i32(1100), o.i32(1), o.call('print')];
// path_open's rights: FD_READ | FD_SEEK | FD_WRITE | FD_READDIR... as wasi-libc asks for O_RDWR.
// O_RDONLY's lacks the four that write: FD_DATASYNC, FD_WRITE, FD_ALLOCATE, FD_FILESTAT_SET_SIZE.
const RW = 0x1ffffffn, RD = 0x1ffffffn & ~0x400141n;

export const programs = {
  // A line, and an exit status of its own.
  hello: { wasm: prog([], [[1024, 'hello from wasi\n']], (o) => [o.i32(1024), o.i32(16), o.call('print'), o.i32(7), o.call('proc_exit')]), status: 7 },

  // Its arguments and its environment as they came, NUL-separated.
  args: {
    args: ['one', 'two words'],
    wasm: prog(['args_sizes_get', 'args_get', 'environ_sizes_get', 'environ_get'], [NL], (o) => [
      o.i32(16), o.i32(20), o.call('args_sizes_get'), o.drop, o.i32(16), o.load(), o.call('num'),
      o.i32(4096), o.i32(8192), o.call('args_get'), o.drop, o.i32(8192), o.i32(20), o.load(), o.call('print'), ...nl(o),
      o.i32(16), o.i32(20), o.call('environ_sizes_get'), o.drop, o.i32(16), o.load(), o.call('num'),
      o.i32(4096), o.i32(16384), o.call('environ_get'), o.drop, o.i32(16384), o.i32(20), o.load(), o.call('print'), ...nl(o)]),
  },

  // stdin to stdout, 32 KiB at a time, to its end.
  cat: {
    stdin: 'line one\nline two\n' + 'x'.repeat(100000) + '\nend\n',
    wasm: prog(['fd_read'], [], (o) => [
      o.block(o.loop(
        o.i32(0), o.i32(8192), o.store(), o.i32(0), o.i32(32768), o.store(4),
        o.i32(0), o.i32(0), o.i32(1), o.i32(8), o.call('fd_read'), o.brIf(1),
        o.i32(8), o.load(), o.eqz, o.brIf(1),
        o.i32(8192), o.i32(8), o.load(), o.call('print'), o.br(0)))]),
  },

  // The preopened directories, by name.
  preopens: {
    wasm: prog(['fd_prestat_get', 'fd_prestat_dir_name'], [NL], (o) => [
      o.i32(3), o.set(0),
      o.block(o.loop(
        o.get(0), o.i32(16), o.call('fd_prestat_get'), o.brIf(1),
        o.get(0), o.call('num'), o.get(0), o.i32(8192), o.i32(20), o.load(), o.call('fd_prestat_dir_name'), o.drop,
        o.i32(8192), o.i32(20), o.load(), o.call('print'), ...nl(o),
        o.get(0), o.i32(1), o.add, o.set(0), o.br(0)))]),
  },

  // Files: written, sought, read back, their size; a directory made, a file renamed and removed, and
  // what the calls answered (errno 0, or WASI's numbers: 44 ENOENT, 20 EEXIST, 55 NOTEMPTY...).
  files: {
    wasm: prog(['path_open', 'fd_seek', 'fd_read', 'fd_close', 'fd_filestat_get', 'path_filestat_get', 'path_create_directory',
      'path_remove_directory', 'path_unlink_file', 'path_rename', 'fd_fdstat_get'],
    [[1024, 'out.txt'], [1040, 'written, then read\n'], [1064, 'sub'], [1072, 'sub/f'], [1080, 'moved'], [1088, 'nothing'], NL], (o) => {
      const open = (p, len, oflags, rights) => [o.i32(4), o.i32(1), o.i32(p), o.i32(len), o.i32(oflags), o.i64(rights), o.i64(rights), o.i32(0), o.i32(32), o.call('path_open'), o.call('num')];
      const write = (fdLocal, p, len) => [o.i32(0), o.i32(p), o.store(), o.i32(0), o.i32(len), o.store(4), o.get(fdLocal), o.i32(0), o.i32(1), o.i32(8), o.call('fd_write'), o.call('num')];
      const status = (call) => [...call, o.call('num')];
      return [
        ...open(1024, 7, 1 | 8, RW), o.i32(32), o.load(), o.set(0),               // CREAT|TRUNC
        ...write(0, 1040, 19),
        o.get(0), o.i64(0), o.i32(0), o.i32(40), o.call('fd_seek'), o.call('num'),
        o.i32(16), o.i32(8192), o.store(), o.i32(16), o.i32(100), o.store(4),            // print's own iovec is at 0
        o.get(0), o.i32(16), o.i32(1), o.i32(24), o.call('fd_read'), o.call('num'),
        o.i32(8192), o.i32(24), o.load(), o.call('print'),
        o.get(0), o.i32(256), o.call('fd_filestat_get'), o.call('num'), o.i32(256 + 16), o.load8(), o.call('num'), o.i32(256 + 32), o.load(), o.call('num'),
        o.get(0), o.i32(320), o.call('fd_fdstat_get'), o.call('num'), o.i32(320), o.load8(), o.call('num'),
        ...status([o.get(0), o.call('fd_close')]), ...nl(o),
        ...status([o.i32(4), o.i32(1064), o.i32(3), o.call('path_create_directory')]),
        ...status([o.i32(4), o.i32(1064), o.i32(3), o.call('path_create_directory')]),  // EEXIST
        ...open(1072, 5, 1, RW), o.i32(32), o.load(), o.set(1),
        ...write(1, 1040, 7), ...status([o.get(1), o.call('fd_close')]),
        ...status([o.i32(4), o.i32(1064), o.i32(3), o.call('path_remove_directory')]),  // ENOTEMPTY
        ...status([o.i32(4), o.i32(1072), o.i32(5), o.i32(4), o.i32(1080), o.i32(5), o.call('path_rename')]),
        ...status([o.i32(4), o.i32(1), o.i32(1080), o.i32(5), o.i32(256), o.call('path_filestat_get')]), o.i32(256 + 32), o.load(), o.call('num'),
        ...status([o.i32(4), o.i32(1080), o.i32(5), o.call('path_unlink_file')]),
        ...status([o.i32(4), o.i32(1080), o.i32(5), o.call('path_unlink_file')]),      // ENOENT
        ...status([o.i32(4), o.i32(1064), o.i32(3), o.call('path_remove_directory')]),
        ...open(1088, 7, 0, RD),                                                      // ENOENT
        ...nl(o)];
    }),
    files: { 'out.txt': 'old contents, longer than the new ones\n' },
  },

  // Paths from the root's descriptor (3) while the working directory is /w: each call is relative to
  // the directory it is given, not to the working one. Made through 3, seen through 4 ("."), and back.
  rooted: {
    wasm: prog(['path_create_directory', 'path_filestat_get', 'path_rename', 'path_symlink', 'path_readlink', 'path_unlink_file', 'path_remove_directory'],
      [[1024, 'w/made'], [1032, 'made'], [1040, 'w/made2'], [1048, 'made2'], [1056, 'w/link'], [1064, 'link'], NL], (o) => {
        const st = (call) => [...call, o.call('num')];
        return [
          ...st([o.i32(3), o.i32(1024), o.i32(6), o.call('path_create_directory')]),
          ...st([o.i32(4), o.i32(0), o.i32(1032), o.i32(4), o.i32(256), o.call('path_filestat_get')]), o.i32(256 + 16), o.load8(), o.call('num'),
          ...st([o.i32(3), o.i32(1024), o.i32(6), o.i32(4), o.i32(1048), o.i32(5), o.call('path_rename')]),
          ...st([o.i32(4), o.i32(0), o.i32(1032), o.i32(4), o.i32(256), o.call('path_filestat_get')]),     // ENOENT: moved
          ...st([o.i32(1048), o.i32(5), o.i32(3), o.i32(1056), o.i32(6), o.call('path_symlink')]),
          ...st([o.i32(4), o.i32(1064), o.i32(4), o.i32(8192), o.i32(64), o.i32(40), o.call('path_readlink')]),
          o.i32(8192), o.i32(40), o.load(), o.call('print'), ...nl(o),
          ...st([o.i32(3), o.i32(1056), o.i32(6), o.call('path_unlink_file')]),
          ...st([o.i32(3), o.i32(1040), o.i32(7), o.call('path_remove_directory')]),
          ...st([o.i32(4), o.i32(0), o.i32(1048), o.i32(5), o.i32(256), o.call('path_filestat_get')]),    // ENOENT: removed
          ...nl(o)];
      }),
  },

  // A directory's names, one a line (their order the directory's: compared sorted).
  readdir: {
    sorted: true,
    files: { 'a.txt': 'a', 'b.txt': 'bb', 'sub/c': 'c' },
    wasm: prog(['path_open', 'fd_readdir'], [[1024, '.'], NL], (o) => [
      o.i32(4), o.i32(1), o.i32(1024), o.i32(1), o.i32(2), o.i64(RD), o.i64(RD), o.i32(0), o.i32(32), o.call('path_open'), o.drop,
      o.i32(32), o.load(), o.i32(8192), o.i32(16384), o.i64(0), o.i32(36), o.call('fd_readdir'), o.drop,
      o.i32(8192), o.set(1),                                                         // the entry
      o.block(o.loop(
        o.get(1), o.i32(8192), o.sub, o.i32(36), o.load(), o.ltu, o.eqz, o.brIf(1),
        o.get(1), o.i32(24), o.add, o.get(1), o.load(16), o.call('print'), ...nl(o),
        o.get(1), o.i32(24), o.add, o.get(1), o.load(16), o.add, o.set(1), o.br(0)))]),
  },

  // The clocks: a sleep of 50 ms through poll_oneoff is seen by the monotonic one; the real one is now.
  clock: {
    wasm: prog(['clock_time_get', 'poll_oneoff'], [[1024, 'slept\n'], [1032, 'did not sleep\n'], [1048, 'now\n'], [1056, 'not now\n']], (o) => [
      o.i32(1), o.i64(1), o.i32(40), o.call('clock_time_get'), o.drop,
      // the subscription at 128: userdata 5, tag 0 (clock), id 1 (monotonic), timeout 50 ms, relative
      o.i32(128), o.i64(5), o.store64(), o.i32(136), o.i32(0), o.store8(), o.i32(144), o.i32(1), o.store(), o.i32(152), o.i64(50000000), o.store64(),
      o.i32(128), o.i32(192), o.i32(1), o.i32(48), o.call('poll_oneoff'), o.drop,
      o.i32(1), o.i64(1), o.i32(56), o.call('clock_time_get'), o.drop,
      o.i32(56), o.load64(), o.i32(40), o.load64(), [0x7d], o.i64(50000000), [0x5a],   // i64.sub, i64.ge_u
      o.if(o.i32(1024), o.i32(6), o.call('print'), o.else, o.i32(1032), o.i32(14), o.call('print')),
      o.i32(192), o.load(), o.call('num'), o.i32(48), o.load(), o.call('num'), o.i32(1100), o.i32(0), o.call('print'),
      o.i32(0), o.i64(1), o.i32(40), o.call('clock_time_get'), o.drop,
      o.i32(40), o.load64(), o.i64(1700000000000000000n), [0x5a],
      o.if(o.i32(1048), o.i32(4), o.call('print'), o.else, o.i32(1056), o.i32(8), o.call('print'))]),
  },

  // A trap ends it as an abort does: status 134, a line on stderr.
  trap: { wasm: prog([], [[1024, 'before\n']], (o) => [o.i32(1024), o.i32(7), o.call('print'), o.unreachable]), status: 134, stderr: true },

  // random_get fills what it is given.
  random: {
    wasm: prog(['random_get'], [[1024, 'filled\n'], [1032, 'zeros\n']], (o) => [
      o.i32(8192), o.i32(4096), o.call('random_get'), o.call('num'),
      o.i32(8192 + 4000), o.load(), o.i32(8192 + 100), o.load(), [0x72],                      // i32.or
      o.if(o.i32(1024), o.i32(7), o.call('print'), o.else, o.i32(1032), o.i32(6), o.call('print'))]),
  },
};

// C programs of tools/wasi/c, for tools/wasi/check.mjs with WASI_SDK: built with wasi-sdk's clang, so
// what wasi-libc makes of the calls -- its stdio, its directory handling, its preopens -- is tested too.
export const cPrograms = {
  libc: { c: 'libc.c', args: ['one', 'two words', ''], status: 42 },
  files: { c: 'files.c' },
  wc: { c: 'wc.c', stdin: 'one two\nthree\n\n  four  five six\n' },
  wcfiles: { c: 'wc.c', args: ['a.txt', 'missing', '/w/sub/b.txt'], files: { 'a.txt': 'a b c\nd\n', 'sub/b.txt': 'x'.repeat(5000) + '\n' } },
};
