// compare3.mjs — time to the "arrival" screen of a boot image under QEMU, v86 and MIRAGE.
//
//   V86_DIR=/dir/with/npm-v86-and-bios node tools/v86/compare3.mjs <image> <secs> [mem MiB] [engines]
//   e.g. node tools/v86/compare3.mjs boot/v86/windows98.img 180 128 qemu,v86,mirage
//   OUTDIR=dir writes each engine's last frame as <image>-<engine>.png — look at it: the arrival
//   time means nothing if that screen is not the one the boot was meant to reach.
//
// Each engine boots the same image cold and is screenshotted every STEP wall seconds (default 2).
// The arrival time is the first frame from which every later frame stays within THRESH (1%) of the
// LAST frame — the screen the boot settles on (desktop, prompt, login). Frames are compared within
// one engine only, downscaled to 64x48 luminance, so resolution and font differences do not matter.
//
// QEMU: -M isapc -cpu pentium -vga std, real time. v86: its own PC (PCI, Bochs VGA), real time.
// MIRAGE: headless and as fast as it can go (guest time = cycles, as tools/v86/bootshot.mjs), the
// 586 profile. QEMU and v86 always run in real time, so their numbers include the waits a guest
// makes on its timers; MIRAGE's turbo collapses idle HLTs. Run engines one after another, never in
// parallel (wall-clock measurements).
//
// Known limits, measured 2026-10-02: headless v86 (in Node, no browser) stops for good after
// "Calibrating delay loop" on BasicLinux 2.2 (0 instructions/s from there) and shows a black
// 640x480x16 screen on Windows 3.0 enhanced mode while running 105 M instr/s — so its arrival
// time there is the stall, not a boot. MIRAGE's turbo runs guest time faster than real time:
// pick SECS short enough that a screensaver (KolibriOS) does not start before the run ends.
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const [img, secsS, memS = '64', enginesS = 'qemu,v86,mirage'] = process.argv.slice(2);
const SECS = Number(secsS), MEM = Number(memS), STEP = Number(process.env.STEP || 2), THRESH = Number(process.env.THRESH || 0.01);
const bytes = readFileSync(img), floppy = bytes.length <= 2949120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = process.env.TMPDIR || '/tmp';

// ---- frame reduction ---------------------------------------------------------------------------
let lastFull = null;                                  // the last frame at full size, for OUTDIR
function reduce(rgb, w, h) {
  lastFull = { rgb: rgb.slice ? rgb.slice(0, w * h * 3) : rgb, w, h };
  const W = 64, H = 48, out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    const x0 = Math.floor(x * w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
    const y0 = Math.floor(y * h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H));
    for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { const i = (yy * w + xx) * 3; s += rgb[i] * 0.3 + rgb[i + 1] * 0.59 + rgb[i + 2] * 0.11; n++; }
    out[y * W + x] = n ? s / n : 0;
  }
  return out;
}
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) d++; return d / a.length; };
function arrival(frames) {
  if (!frames.length) return null;
  const last = frames[frames.length - 1].f;
  let t = frames[frames.length - 1].t;
  for (let k = frames.length - 1; k >= 0; k--) { if (diff(frames[k].f, last) > THRESH) break; t = frames[k].t; }
  return t;
}

// ---- QEMU ------------------------------------------------------------------------------------------
async function runQemu() {
  const copy = `${SCRATCH}/c3-qemu.img`; writeFileSync(copy, bytes);
  const args = ['-M', 'isapc', '-cpu', 'pentium', '-m', String(MEM), '-vga', 'std', '-display', 'none', '-monitor', 'stdio', '-no-reboot',
    '-drive', `format=raw,file=${copy},if=${floppy ? 'floppy' : 'ide'},index=0`, '-boot', floppy ? 'a' : 'c'];
  const q = spawn('/opt/homebrew/bin/qemu-system-i386', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  const frames = [], T0 = Date.now();
  for (let t = STEP; t <= SECS; t += STEP) {
    await sleep(Math.max(0, t * 1000 - (Date.now() - T0)));
    const f = `${SCRATCH}/c3-q.ppm`; if (existsSync(f)) unlinkSync(f);
    q.stdin.write(`screendump ${f}\n`);
    for (let k = 0; k < 50 && !existsSync(f); k++) await sleep(20);
    await sleep(60);
    try {
      const b = readFileSync(f); let o = 0; const tok = () => { while (b[o] === 0x20 || b[o] === 0x0a) o++; let s = ''; while (b[o] !== 0x20 && b[o] !== 0x0a) s += String.fromCharCode(b[o++]); return s; };
      tok(); const w = +tok(), h = +tok(); tok(); o++;
      frames.push({ t, f: reduce(b.subarray(o), w, h) });
    } catch { /* not written yet */ }
  }
  q.stdin.write('quit\n'); await sleep(300); q.kill('SIGKILL');
  return frames;
}

// ---- v86 ---------------------------------------------------------------------------------------------
async function runV86() {
  const V = process.env.V86_DIR; if (!V) return null;
  const { V86 } = await import(V + '/node_modules/v86/build/libv86.mjs');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const e = new V86({
    wasm_path: V + '/node_modules/v86/build/v86.wasm',
    bios: { buffer: readFileSync(V + '/bios/seabios.bin').buffer }, vga_bios: { buffer: readFileSync(V + '/bios/vgabios.bin').buffer },
    ...(floppy ? { fda: { buffer: buf } } : { hda: { buffer: buf } }),
    memory_size: MEM << 20, vga_memory_size: 8 << 20, autostart: true, disable_speaker: true,
  });
  let size = [720, 400, 0]; e.add_listener('screen-set-size', (a) => { size = a; });
  const shot = () => {
    const v = e.v86.cpu.devices.vga, [w0, h0, bpp] = size;
    if (!bpp) {                                        // text: one cell -> its character's brightness; v86 keeps
      // a character every other byte of plane 0 (the attribute between), as v86shot's output showed
      const cols = w0 || 80, rows = h0 || 25, start = ((v.crtc[0x0c] << 8) | v.crtc[0x0d]) >>> 0, rgb = new Uint8Array(cols * rows * 3);
      for (let i = 0; i < cols * rows; i++) { const ch = v.plane0[((start + i) * 2) & 0xffff], g = ch > 32 && ch < 255 ? 200 : 0; rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g; }
      return reduce(rgb, cols, rows);
    }
    const w = w0, h = h0, rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      let c;
      if (bpp === 4) { const x = i % w, y = (i / w) | 0, o = y * (w >> 3) + (x >> 3), b = 7 - (x & 7);
        c = v.vga256_palette[v.dac_map[((v.plane0[o] >> b) & 1) | (((v.plane1[o] >> b) & 1) << 1) | (((v.plane2[o] >> b) & 1) << 2) | (((v.plane3[o] >> b) & 1) << 3)]]; }
      else if (bpp === 8 && !v.svga_enabled) c = v.vga256_palette[[v.plane0, v.plane1, v.plane2, v.plane3][i & 3][i >> 2]];
      else if (bpp === 8) c = v.vga256_palette[v.svga_memory[i]];
      else if (bpp === 16) { const p = v.svga_memory[i * 2] | v.svga_memory[i * 2 + 1] << 8; c = ((p >> 11) << 19) | (((p >> 5) & 63) << 10) | ((p & 31) << 3); }
      else { const B = bpp >> 3; c = v.svga_memory[i * B + 2] << 16 | v.svga_memory[i * B + 1] << 8 | v.svga_memory[i * B]; }
      rgb[i * 3] = (c >> 16) & 255; rgb[i * 3 + 1] = (c >> 8) & 255; rgb[i * 3 + 2] = c & 255;
    }
    return reduce(rgb, w, h);
  };
  const frames = [], T0 = Date.now();
  await new Promise((resolve) => {
    let t = STEP;
    const tick = setInterval(() => {
      if ((Date.now() - T0) / 1000 < t) return;
      try { const f = shot(); frames.push({ t, f }); if (process.env.DEBUG) { const v = e.v86.cpu.devices.vga; let txt = ''; for (let k = 0; k < 60; k++) { const ch = v.plane0[k * 2]; txt += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.'; } console.log('v86 frame', t, size.join('x'), Math.round(f.reduce((a, b) => a + b, 0)), JSON.stringify(txt), 'eip', (e.v86.cpu.get_real_eip() >>> 0).toString(16)); } } catch (err) { if (process.env.DEBUG) console.log('v86 shot failed', t, String(err.message || err)); }
      t += STEP;
      if (t > SECS) { clearInterval(tick); e.stop(); resolve(); }
    }, 50);
  });
  return frames;
}

// ---- MIRAGE ----------------------------------------------------------------------------------------
async function runMirage() {
  const { makeMachine } = await import(ROOT + '/tools/harness.mjs');
  const { bootSector } = await import(ROOT + '/src/boot.js');
  const { Video } = await import(ROOT + '/src/video.js');
  const disk = new Uint8Array(bytes);
  const { mc } = makeMachine({ dos: false, memSize: MEM << 20, cpu: '586' });   // the 586 profile, as the header says
  let drive = 0;
  if (!floppy) {
    const dv = new DataView(disk.buffer), e = 0x1be;
    const lba = dv.getUint32(e + 8, true), n = dv.getUint32(e + 12, true), sh = disk[e + 1], ss = disk[e + 2] & 63;
    const eh = disk[e + 5], es = disk[e + 6] & 63, ec = disk[e + 7] | ((disk[e + 6] & 0xc0) << 2);
    const ok = (disk[e] === 0 || disk[e] === 0x80) && disk[e + 4] && n && ec;
    const spt = ok && sh ? (lba - (ss - 1)) / sh : 63, hd = ok ? Math.round(((lba + n - 1 - (es - 1)) / spt - eh) / ec) : 16;
    mc.disk.attach(0x80, disk, { cyl: Math.floor(disk.length / (hd * spt * 512)), heads: hd, spt, type: 3 });
    drive = 0x80;
  } else {
    let d = disk; if (d.length < 1474560) { d = new Uint8Array(1474560); d.set(disk); }
    mc.disk.attach(0, d);
  }
  let fault = null; mc.onError = (x) => { fault = x; };
  bootSector(mc, disk, { drive });
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  const v = new Video(mc, canvas); v.font = mc.font;
  const c = mc.cpu, frames = [], T0 = Date.now();
  for (let t = STEP; t <= SECS && !fault; t += STEP) {
    while (!fault && Date.now() - T0 < t * 1000 && !(c.halted && !(c.flags & 0x200))) { mc.runSlice(20000); mc.pumpKeyboard(); }
    v.frame = 16; v.render();
    const W = v.imgW, H = v.imgH, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { const p = v.u32[i]; rgb[i * 3] = p & 0xff; rgb[i * 3 + 1] = (p >> 8) & 0xff; rgb[i * 3 + 2] = (p >> 16) & 0xff; }
    frames.push({ t, f: reduce(rgb, W, H) });
    if (c.halted && !(c.flags & 0x200)) break;
  }
  return frames;
}

const name = img.split('/').pop();
const { writePNG } = await import(ROOT + '/tools/frame.mjs');
const out = {};
for (const eng of enginesS.split(',')) {
  const frames = eng === 'qemu' ? await runQemu() : eng === 'v86' ? await runV86() : await runMirage();
  out[eng] = frames ? arrival(frames) : null;
  if (process.env.OUTDIR && lastFull) writePNG(`${process.env.OUTDIR}/${name}-${eng}.png`, lastFull.rgb, lastFull.w, lastFull.h, 1);   // what 'arrival' settled on
  console.log(`${name}  ${eng.padEnd(6)}  arrival ${out[eng] === null ? 'n/a' : out[eng] + ' s'}  (${frames ? frames.length : 0} frames over ${SECS} s)`);
}
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ image: name, secs: SECS, ...out }));
process.exit(0);
