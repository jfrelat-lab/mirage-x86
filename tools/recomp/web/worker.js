// worker.js -- runs a recompiled intro's PRISM bundle (tools/recomp/out/web/<intro>.js and .bin) and answers
// what the C leaves to the platform: port 3DAh, the VGA status (retrace and display enable on the real clock,
// 70.086 frames a second of 449 lines, as a VGA's mode 13h), and port 60h (the key; each read is also where a
// picture may be sent, at most `fps` times a second -- 60 unless the page says: the intros poll it once a frame). PRISM's DJGPP environment does the rest (go32, the
// DAC's ports).
import { loadSnapshot, bindLateBuiltins } from '../../../vendor/prism/src/compile.js';
import { buildEnv } from '../../../vendor/prism/src/env/registry.js';

onmessage = async ({ data: { intro, keys, fps = 60 } }) => {
  try {
    const mod = await import(`../out/web/${intro}.js`);
    const image = new Uint8Array(await (await fetch(new URL(`../out/web/${intro}.bin`, import.meta.url))).arrayBuffer());
    const program = loadSnapshot({ meta: mod.meta, factory: mod.factory, image });
    buildEnv(program.M, mod.env, { dl: { modules: {} } });
    bindLateBuiltins(program);
    const M = program.M, key = keys ? new Int32Array(keys) : null;
    const HZ = 70.086, LINES = 449, VISIBLE = 400, t0 = performance.now();
    M.machine.onPortRead(0x3da, () => {
      const f = ((performance.now() - t0) / 1000) * HZ, line = (f - Math.floor(f)) * LINES, inLine = line - Math.floor(line);
      return (line >= VISIBLE || inLine > 0.8 ? 0x01 : 0) | (line >= 412 && line < 414 ? 0x08 : 0);
    });
    let shown = 0;
    M.machine.onPortRead(0x60, () => {
      const now = performance.now();
      if (now - shown >= 1000 / fps) {
        shown = now;
        postMessage({ fb: M.u8.slice(0xa0000, 0xa0000 + 64000), pal: Uint8Array.from(M.dac.palette) });
      }
      return key ? Atomics.load(key, 0) || 0x9c : 0x9c;
    });
    const r = program.run([`C:\\PROG\\${intro.toUpperCase()}.COM`]);
    postMessage({ exit: r && r.code !== undefined ? r.code : r });
  } catch (e) { postMessage({ error: String(e && e.stack || e) }); }
};
