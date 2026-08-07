// test-demos.js — run real nasm-assembled mode-13h demos from demos/ through the
// engine and assert they behave: the framebuffer fills, many colours appear, and
// (for palette-rotation demos) the DAC palette actually changes frame to frame.
//
//   node tools/test-demos.js [DEMO.COM ...]

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { VFS } from '../src/vfs.js';
import { makeMachine } from './harness.mjs';

const DEMODIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'demos');
const demos = process.argv.slice(2).length ? process.argv.slice(2) : ['XORMUNCH.COM', 'PLASMA13.COM'];

let fail = 0;
for (const name of demos) {
  const path = join(DEMODIR, name);
  if (!existsSync(path)) { console.log(`  ${name}: SKIP (not built)`); continue; }

  const { mc, dos } = makeMachine();        // composed like the browser — see harness.mjs
  dos.loadCOM(new Uint8Array(readFileSync(path)), '', 'C:\\' + name);

  const fb = () => mc.mem.u8.slice(0xa0000, 0xa0000 + 64000);
  mc.runSlice(600000);                       // draw + several animation frames
  const palA = mc.bios.dac.slice(), fbA = fb();
  mc.runSlice(600000);                       // more frames
  const palB = mc.bios.dac.slice(), fbB = fb();

  const mode = mc.mem.r8(0x449);
  const colours = new Set();
  let nonzero = 0;
  for (let i = 0; i < 64000; i++) { const p = fbB[i]; if (p) nonzero++; colours.add(p); }
  let palΔ = 0; for (let i = 0; i < palA.length; i++) if (palA[i] !== palB[i]) palΔ++;
  let fbΔ = 0; for (let i = 0; i < 64000; i++) if (fbA[i] !== fbB[i]) fbΔ++;
  // an animated demo changes either its framebuffer (pattern) or its palette each frame
  const animated = palΔ > 0 || fbΔ > 0;

  const ok = mode === 0x13 && nonzero > 20000 && colours.size > 32 && animated;
  const how = palΔ && fbΔ ? `pattern+palette` : palΔ ? `palette (${palΔ}B)` : fbΔ ? `pattern (${fbΔ}px)` : 'static';
  console.log(`  ${name}: mode=0x${mode.toString(16)} nonzero=${nonzero} colours=${colours.size} animated=${how}  ${ok ? '✓' : '✗'}`);
  if (!ok) fail = 1;
}
console.log(fail ? '\nreal demos ✗' : '\nreal demos ✓');
process.exit(fail);
