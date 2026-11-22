// MIRAGE: a word OUT to 3C8h. On an ISA VGA the bus splits it: AL to 3C8h (index), AH to 3C9h
// (the first component). mov al,13h; int 10h; mov dx,3c8h; mov ax,1105h; out dx,ax; int 20h
// MIRAGE gave the word to the 3C8h handler, which kept AL: the colour was not written. Fixed: the
// DAC's ports pass AH on to the next port (src/bios.js; tools/dacwprobe.asm).  node tools/recomp/walls/outw.mjs
import { writeFileSync } from 'fs';
import { mirageMachine } from '../oracle.mjs';
const f = new URL('../out/outw.com', import.meta.url).pathname;
writeFileSync(f, Uint8Array.from([0xb0, 0x13, 0xcd, 0x10, 0xba, 0xc8, 0x03, 0xb8, 0x05, 0x11, 0xef, 0xcd, 0x20]));
const m = await mirageMachine(f);
const before = m.mc.bios.dac[15];
m.runTo(1000);
console.log(`DAC[5].red before ${before}, after ${m.mc.bios.dac[15]} (hardware: 17)`);
