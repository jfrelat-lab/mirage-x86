// test-gfx.js — confirm the mode-13h demos set the mode and paint the A000:0
// framebuffer with varied pixels (i.e. the recompiler runs the render loops).

import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS } from '../src/dos.js';
import { VFS } from '../src/vfs.js';
import { SAMPLES } from '../src/samples.js';

for (const name of ['BARS.COM', 'PLASMA.COM']) {
  const mc = new Machine({ memSize: 1 << 20 });
  installBIOS(mc);
  const dos = installDOS(mc, new VFS());
  dos.load(SAMPLES.find(s => s.name === name).make(), '', 'C:\\' + name);

  // these demos loop forever; run a bounded budget then inspect
  mc.runSlice(300000);

  const mode = mc.mem.r8(0x449);
  const seen = new Set();
  let nonzero = 0;
  for (let i = 0; i < 64000; i++) { const p = mc.mem.r8(0xa0000 + i); if (p) nonzero++; seen.add(p); }
  const ok = mode === 0x13 && nonzero > 30000 && seen.size > 32;
  console.log(`${name}: mode=0x${mode.toString(16)} nonzero=${nonzero} colours=${seen.size} ${ok ? '✓' : '✗'}`);
  if (!ok) process.exit(1);
}
console.log('graphics demos ✓');
