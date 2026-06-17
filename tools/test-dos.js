// test-dos.js — end-to-end check of BIOS + DOS + COM loader: load a hand-written
// "Hello" .COM, run it to termination, and read the text screen back out.

import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';

const mc = new Machine({ memSize: 1 << 20 });
installBIOS(mc);
const vfs = new VFS();
const dos = installDOS(mc, vfs);

// MOV AH,9 / MOV DX,0x0109 / INT 21h / INT 20h / "Hello, MIRAGE!$"
const msg = 'Hello, MIRAGE!$';
const code = [0xb4, 0x09, 0xba, 0x09, 0x01, 0xcd, 0x21, 0xcd, 0x20,
  ...[...msg].map(c => c.charCodeAt(0))];

dos.loadCOM(Uint8Array.from(code), '', 'C:\\HELLO.COM');

let guard = 0;
while (!dos.programDone && guard++ < 100000) mc.runSlice(1000);

// read the text screen (B800:0000), row 0
const VRAM = 0xb8000;
let row0 = '';
for (let i = 0; i < 80; i++) { const c = mc.mem.r8(VRAM + i * 2); row0 += c ? String.fromCharCode(c) : ' '; }
row0 = row0.replace(/\s+$/, '');

console.log('screen row 0: "' + row0 + '"');
console.log('terminated:', dos.programDone, 'exit code:', dos.exitCode);
if (row0 === 'Hello, MIRAGE!') { console.log('DOS hello ✓'); }
else { console.log('DOS hello ✗'); process.exit(1); }
