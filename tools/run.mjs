// run.mjs — run any program MIRAGE knows, from the command line; the file's own bytes say which.
//
//   node tools/run.mjs <program> [args...]
//
// Detected by signature, never by extension (ROADMAP H11):
//   7F 'ELF'                          -> MIRAGE-LINUX   tools/linux/run.mjs
//   'MZ' + 'PE\0\0' at e_lfanew       -> Win32: not yet (MIRAGE-WIN32, H14)
//   'MZ' + 'NE' at e_lfanew           -> Win16: not from the command line (it needs Windows' screen)
//   'MZ' / 'ZM', or anything else     -> MIRAGE-DOS     tools/dos/run.mjs (a .COM has no signature)
//   55 AA at 510 in a 512-byte image,
//   or a floppy-sized image            -> a bare PC boot  tools/run-boot.mjs
// The runner keeps its own conventions: stdout, stdin and the exit status for Linux and DOS.
import { readFileSync, statSync } from 'fs';

const [prog, ...args] = process.argv.slice(2);
if (!prog) { console.error('usage: node tools/run.mjs <program> [args...]'); process.exit(2); }
const b = readFileSync(prog), size = statSync(prog).size;

export function kind(b, size) {
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'linux';
  const mz = b.length >= 64 && ((b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x5a && b[1] === 0x4d));
  if (mz) {
    const at = b.readUInt32LE(0x3c);
    // e_lfanew is only meaningful when the relocation table starts at 40h or later, as Windows checks.
    if (b.readUInt16LE(0x18) >= 0x40 && at + 4 <= b.length) {
      if (b.toString('latin1', at, at + 4) === 'PE\0\0') return 'pe';
      if (b.toString('latin1', at, at + 2) === 'NE') return 'ne';
    }
    return 'dos';
  }
  const floppy = [163840, 184320, 327680, 368640, 737280, 1228800, 1474560, 2949120].includes(size);
  if ((size === 512 || floppy) && b[510] === 0x55 && b[511] === 0xaa) return 'boot';
  return 'dos';
}

const k = kind(b, size);
const runner = { linux: './linux/run.mjs', dos: './dos/run.mjs', boot: './run-boot.mjs' }[k];
if (!runner) {
  console.error(k === 'pe' ? 'mirage: a Win32 (PE) program — MIRAGE-WIN32 does not exist yet'
    : 'mirage: a Win16 (NE) program — run it in Windows 3.x in the browser');
  process.exit(126);
}
if (process.env.MIRAGE_RUN_VERBOSE) console.error(`mirage: ${k} -> tools/${runner.slice(2)}`);
process.argv = [process.argv[0], new URL(runner, import.meta.url).pathname, prog, ...args];
await import(runner);
