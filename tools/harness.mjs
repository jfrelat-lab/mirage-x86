// harness.mjs — compose a Machine the way the browser does, in ONE place.
//
// Every headless tool used to build its own machine, and each one drifted from `ui.js` in a
// different direction. That drift is not cosmetic: it decides what the tools can *see*.
//   • `run-game.mjs` pinned 1 MiB, where extended memory starts exactly at the top of RAM, so every
//     XMS allocation failed and the XMS path of the games that need it was never exercised at all.
//   • `golden.js` and `dosdiff.js` never loaded the ROM fonts `video.js` loads, so BIOS character
//     output in a graphics mode drew blank glyphs — three intros were pinned rendering a BLACK
//     SCREEN, and scored 98-99% against DOSBox precisely because those frames are mostly black.
//   • INT 33h was installed only by `ui.js`, so headless runs report "mouse driver not found"
//     (Mystic Towers does) for a driver the real player has.
// In all three the defect was in what the harness let us see, not in the code under test. Hence
// this module: a tool that stands in for the browser calls makeMachine() and inherits the fix.
//
// Instruction-level tools (test.js, conformance.js, the fuzzers, the co-simulator) deliberately
// build bare machines and should NOT use this — they are testing the CPU, not the environment.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Machine } from '../src/machine.js';
import { installBIOS } from '../src/bios.js';
import { installDOS, DOS_PLAYER_MEM } from '../src/dos.js';
import { installMouse } from '../src/mouse.js';
import { VFS } from '../src/vfs.js';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** Load the ROM fonts onto the machine, as video.js does in the browser. Missing files are not an
 *  error (the engine falls back to blank glyphs) but they are exactly what made the gate blind. */
export function loadFonts(machine) {
  for (const [prop, file] of [['font', 'vga-rom-8x16.bin'], ['font8x8', 'vga-rom-8x8.bin'],
                              ['font8x14', 'vga-rom-8x14.bin']]) {
    try { machine[prop] = new Uint8Array(readFileSync(join(ASSETS, file))); } catch { /* optional */ }
  }
  return machine;
}

/**
 * @param {{memSize?: number, dos?: boolean, mouse?: boolean, vfs?: VFS}} opts
 *   Without memSize: the browser's DOS player machine (DOS_PLAYER_MEM, 16 MiB of RAM with the VBE
 *   aperture above it), or 16 MiB for a bare machine (`dos: false`). Note this does not change real-mode addressing —
 *   Memory masks to a 1 MiB wrap until A20 is enabled — it only decides how much extended memory
 *   exists for XMS. `dos: false` composes the bare BIOS machine a boot sector runs on.
 * @returns {{mc: Machine, bios: object, dos: object|null, vfs: VFS|null}}
 */
export function makeMachine(opts = {}) {
  const mc = new Machine(opts.memSize ? { memSize: opts.memSize } : opts.dos === false ? { memSize: 16 << 20 } : DOS_PLAYER_MEM);
  // A BARE machine — one a boot sector runs on — has no expanded memory manager. EMS is a DOS
  // driver (EMM386.EXE, loaded by CONFIG.SYS), not part of the PC, and unlike XMS it cannot stand
  // aside once the guest arrives: EMM386 checks the INT 67h vector BEFORE installing, finds ours,
  // and refuses — "EMM386 not installed - other expanded memory manager detected" on v86's
  // msdos622.img, where QEMU (which has no EMM) gets VCPI. Asking for `ems: true` still works.
  const ems = opts.ems ?? (opts.dos === false ? false : undefined);
  const bios = installBIOS(mc, { xms: opts.xms, ems, dpmi: opts.dpmi });
  loadFonts(mc);
  if (opts.mouse !== false) installMouse(mc);          // INT 33h — the browser always has it
  let dos = null, vfs = null;
  if (opts.dos !== false) { vfs = opts.vfs || new VFS(); dos = installDOS(mc, vfs); }
  return { mc, bios, dos, vfs };
}
