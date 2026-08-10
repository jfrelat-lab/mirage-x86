// planes2.mjs — how often would a linear VGA READ-shadow have to be rebuilt?
//
// The "unconditional read" design (u8[a] with no test, measured 2.5-4x faster) only works if the
// array is always right. For EGA/VGA planar modes that means vga.js keeping a linear shadow, which
// must be rebuilt whenever the SELECTED READ PLANE or the READ MODE changes — Graphics Controller
// index 4 and index 5. Writes are irrelevant here: they keep their branch either way.
//
// Counted separately, with distinct values recorded, because a register written 900 times with the
// SAME value costs zero rebuilds. Reports its own positive controls (total port writes, sequencer
// map-mask writes) so a zero can be told apart from a dead probe — a distinction that has bitten
// this investigation twice.

const ROOT = '/Users/julienfrelat/Projects/mirage';
const [dir, exe, secs] = process.argv.slice(2);
const { readFileSync, readdirSync, statSync } = await import('fs');
const { Machine } = await import(`${ROOT}/src/machine.js`);
const { installBIOS } = await import(`${ROOT}/src/bios.js`);
const { installDOS } = await import(`${ROOT}/src/dos.js`);
const { VFS } = await import(`${ROOT}/src/vfs.js`);
const now = () => Number(process.hrtime.bigint()) / 1e6;

const mc = new Machine({ memSize: 16 << 20 });
mc.timerAuto = true;
installBIOS(mc);
const vfs = new VFS();
const dos = installDOS(mc, vfs);
let fault = null; mc.onError = (e) => { fault = e; };
const base = `${ROOT}/games/${dir}`;
const walk = (d, pre) => {
  for (const n of readdirSync(d)) {
    const p = `${d}/${n}`;
    if (statSync(p).isDirectory()) walk(p, pre + n + '\\');
    else vfs.addFile('\\GAMES\\' + pre + n, new Uint8Array(readFileSync(p)));
  }
};
walk(base, dir + '\\');
vfs.chdir('C:\\GAMES\\' + dir);

const st = {
  ports: 0,          // positive control: every port write seen
  gcIdxWrites: 0,    // writes to 0x3CE (the index register itself)
  idx4: 0, idx5: 0,  // data writes while the index selects read-plane / mode
  seqMask: 0,        // 0x3C5 while sequencer index 2 = the WRITE plane mask (control: planar games hammer it)
  planeChanges: 0, modeChanges: 0,
};
const vals4 = new Set(), vals5 = new Set();
let gcIndex = 0, seqIndex = 0, lastPlane = -1, lastMode = -1;

// Hook cpu.ioWrite before any block is translated — the run loop captures the port tables, so a late
// swap of one table entry is not observed.
const oW = mc.cpu.ioWrite;
mc.cpu.ioWrite = (p, sz, v) => {
  st.ports++;
  const b = v & 0xff;
  if (p === 0x3ce) { st.gcIdxWrites++; gcIndex = b; }
  else if (p === 0x3cf) {
    if (gcIndex === 4) { st.idx4++; vals4.add(b & 3); if ((b & 3) !== lastPlane) { lastPlane = b & 3; st.planeChanges++; } }
    else if (gcIndex === 5) { st.idx5++; vals5.add(b & 0x08); if ((b & 0x08) !== lastMode) { lastMode = b & 0x08; st.modeChanges++; } }
  } else if (p === 0x3c4) seqIndex = b;
  else if (p === 0x3c5) { if (seqIndex === 2) st.seqMask++; }
  return oW(p, sz, v);
};

dos.load(new Uint8Array(readFileSync(`${base}/${exe}`)), '', 'C:\\GAMES\\' + dir + '\\' + exe);
const t0 = now();
while (now() - t0 < Number(secs || 5) * 1000 && !fault && !dos.programDone) mc.runSlice(20000);

const instr = mc.cpu.cycles;
const accesses = instr * 2;                       // ~2 memory ops per instruction (measured from emitted blocks)
const rebuilds = st.planeChanges + st.modeChanges;
const SHADOW = 65536;                             // bytes to rebuild per invalidation (one 64 KB plane view)
const copyCost = rebuilds * SHADOW;

console.log(`${dir}/${exe}`);
console.log(`  controls: ${st.ports.toLocaleString()} port writes, ${st.seqMask.toLocaleString()} sequencer map-mask writes, ` +
  `${st.gcIdxWrites.toLocaleString()} GC index writes  ${st.ports ? '(probe is live)' : '(PROBE IS DEAD — ignore all of the below)'}`);
console.log(`  GC idx4 read-plane: ${st.idx4.toLocaleString()} writes, values {${[...vals4].join(',') || '-'}}, ` +
  `${st.planeChanges} CHANGES`);
console.log(`  GC idx5 read-mode : ${st.idx5.toLocaleString()} writes, values {${[...vals5].join(',') || '-'}}, ` +
  `${st.modeChanges} CHANGES`);
console.log(`  ${(instr / 1e6).toFixed(0)} M instructions -> ~${(accesses / 1e6).toFixed(0)} M memory accesses in ${secs || 5}s`);
if (!rebuilds) console.log(`  => shadow would NEVER be rebuilt: the read plane/mode is set once and left alone`);
else console.log(`  => one rebuild per ~${Math.round(accesses / rebuilds).toLocaleString()} accesses; ` +
  `${(copyCost / 1e6).toFixed(1)} MB copied vs ~${(accesses / 1e6).toFixed(0)} M accesses saving ~1.3 ns each`);
if (fault) console.log(`  FAULT: ${fault}`);
