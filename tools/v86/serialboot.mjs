// Boot an image under MIRAGE and print what the guest writes to COM1 (3F8h), until port F4h.
//   node serialboot.mjs <image> [seconds]
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
const { bootSector } = await import(ROOT + '/src/boot.js');
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const secs = Number(process.argv[3]) || 20;
const { mc } = makeMachine({ dos: false });
mc.disk.attach(0x00, bytes);
let out = '', done = false;
mc.onPortRead(0x3fd, () => 0x60);
mc.onPortWrite(0x3f8, (_p, _s, v) => { out += String.fromCharCode(v & 0xff); });
mc.onPortWrite(0xf4, () => { done = true; });
bootSector(mc, bytes, { drive: 0 });
const t0 = Date.now();
while (!done && Date.now() - t0 < secs * 1000) { mc.runSlice(20000); mc.tickTimer(); }
process.stdout.write(out);
