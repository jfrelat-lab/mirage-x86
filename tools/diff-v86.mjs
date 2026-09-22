// diff-v86.mjs — run the SAME disk image in MIRAGE and in v86 and find the first point where the
// two guests ask for different things.
//
//   mkdir -p /tmp/v86ref && cd /tmp/v86ref && npm init -y && npm i v86
//   curl -o /tmp/v86ref/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
//   curl -o /tmp/v86ref/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
//   V86_DIR=/tmp/v86ref node tools/diff-v86.mjs boot/WIN31HD.IMG 66,16,63 [seconds] [--io[=ranges]]
//
// THREE OBSERVABLES, same method.
//   (default)  the SECTORS the guests ask for
//   --io       their PORT ACCESSES, once the disk has been excluded. CURRENTLY NON-FUNCTIONAL
//              against v86 1.x as installed today: the WASM CPU does not dispatch through the JS
//              `IO.port_read8/16/32` methods this hooks, so v86 records ZERO port actions while the
//              IDE hook right beside it still works. Measured on the committed version too, so it
//              is API drift and not a change here. The run says so rather than reporting a match —
//              "one side recorded nothing ... and that is not a match" — but it is not a usable
//              observable until the hook is moved to whatever the WASM build actually calls.
//   --mem=LBA[:k[:lo-hi,...]]  their MEMORY, both stopped when the guest reads that sector the kth
//              time. Extended memory by default; see MEM_RANGES below for why not low memory.
//
// --mem is how XMS gets compared. A symmetric trace of the XMS calls themselves is not reachable:
// on our side the driver entry can be caught by hooking the CS load, but v86 runs its CPU in WASM
// and offers no execution hook, so there is no way to see the far call on both sides. What IS
// symmetric is the EFFECT — an XMS move is a memcpy — so the question becomes "did the move copy
// the same bytes to the same place", i.e. a memory diff at an instant both engines can be stopped
// at. THE SYNC POINT IS DEFINED BY CONTENT, not by an index: a port-access number is not the same
// instant on both sides (each BIOS has its own prologue — 2686 port accesses of difference on this
// image, so stopping both at "access 50000" compared two unrelated moments and reported 189 KB of
// meaningless difference). A sector number is the guest's own event and needs no alignment.
//
// WHAT IDENTICAL SNAPSHOTS DO NOT PROVE, the same caveat as the other two observables: that the two
// guests held the same bytes at ONE instant. Everything between two sync points is unobserved, and
// a difference that is written and overwritten before the snapshot is invisible. Run it with
// DIFFV86_MEMPOKE before believing a zero — see MEM_POKE below.
//
// WHY THE DISK, and not memory or registers. There is no instruction-level sync point between these
// two engines: v86 is a WASM JIT with no per-block hook, and even a shared POST code only pins ONE
// instant (tools/memdiff-v86.mjs does that, and it is the right tool when the guest is test386).
// A booted OS gives something better — the guest is deterministic, so the SEQUENCE of sectors it
// asks for is a long, ordered, guest-authored trace, and the first sector that differs is the first
// decision the two guests made differently. No timing, no clock, no address-space layout in it.
//
// The two engines are observed at different levels — MIRAGE at INT 13h (our BIOS IS the disk), v86
// at the IDE device, where SeaBIOS has already translated. So request BOUNDARIES are not comparable:
// one INT 13h call may become several IDE commands. The comparison is therefore on the FLATTENED
// stream of LBAs, which is boundary-independent.
//
// WHAT A MATCH DOES NOT PROVE. If the streams agree all the way to where MIRAGE stops, the guests
// did not diverge in what they read — that rules the disk out and says the divergence is in
// something neither engine reports here (a service answer, a fault, a descriptor). That is a real
// result, but it is an exclusion, not a location.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V86_DIR = process.env.V86_DIR || '/tmp/v86ref';
const img = process.argv[2] || join(ROOT, 'boot/WIN31HD.IMG');
const geom = (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '66,16,63').split(',').map(Number);
const args = process.argv.slice(2);
const ioArg = args.find((a) => a.startsWith('--io'));
const memArg = args.find((a) => a.startsWith('--mem='));
const memParts = memArg ? memArg.split('=')[1].split(':') : null;
const MEM_LBA = memParts ? Number(memParts[0]) : -1;            // the sector whose read stops both
const MEM_NTH = memParts && memParts[1] ? Number(memParts[1]) : 1;
const memRangeArg = memParts && memParts[2] ? memParts[2] : null;
const IO_MODE = ioArg !== undefined;
const SECS = Number(args.filter((a) => !a.startsWith('--'))[2] || 90);

// WHICH PORTS ARE COMPARABLE. Only the ones the GUEST programs directly. The rest differ by
// construction and would report a divergence on the first access, every time:
//   1f0-1f7, 3f6  IDE — v86's guest drives it through SeaBIOS; our INT 13h serves a JS image and
//                 touches no IDE port at all
//   40-43         PIT — the two timer models are not the same machine
//   20-21, a0-a1  PIC, 60-64 keyboard controller, 70-71 CMOS — initialised by each BIOS its own way
//   00-0f, 80-8f, c0-df  DMA      3f0-3f7  floppy      cf8-cff  PCI (v86 has a bus, we do not)
// What is left is the VGA, the UARTs, the parallel port, A20 at 92h and the sound ports — the
// devices a DOS or Windows guest talks to itself.
const DEFAULT_EXCLUDED = [[0x00, 0x0f], [0x20, 0x21], [0x40, 0x43], [0x60, 0x64], [0x70, 0x71],
  [0x80, 0x8f], [0xa0, 0xa1], [0xc0, 0xdf], [0x1f0, 0x1f7], [0x3f0, 0x3f7], [0xcf8, 0xcff]];
const parseRanges = (spec) => spec.split(',').filter(Boolean).map((r) => {
  const [lo, hi] = r.split('-'); const a = parseInt(lo, 16); return [a, hi === undefined ? a : parseInt(hi, 16)];
});
const included = ioArg && ioArg.includes('=') ? parseRanges(ioArg.split('=')[1]) : null;
// 3BA and 3DA are the VGA input-status registers, and their bit 0 is the vertical retrace. That bit
// is TIME, not a decision: two emulators will never agree on it, and comparing it reports a
// divergence that means nothing. Measured: the first "divergence" this tool found on win31.img was
// `in 3da = 00` against `in 3da = 01`. They are dropped on both sides unless asked for.
const RETRACE = [0x3ba, 0x3da];
const keepRetrace = process.env.DIFFV86_KEEP_RETRACE !== undefined;
const watched = (p) => (keepRetrace || !RETRACE.includes(p)) && (included
  ? included.some(([lo, hi]) => p >= lo && p <= hi)
  : !DEFAULT_EXCLUDED.some(([lo, hi]) => p >= lo && p <= hi));
const CAP = 4_000_000;
const MEM_MB = Number(process.env.MEM || 64);
const hex = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
// WHAT --mem COMPARES BY DEFAULT: EXTENDED memory, everything above the first megabyte.
//
// Low memory is NOT comparable and the first version of this compared it anyway, reporting tens of
// kilobytes of difference that meant nothing. The two machines are not the same machine down there:
// SeaBIOS reports 639 KB of conventional memory and puts an EBDA at 9FC0, MIRAGE reports 640 KB and
// has none, so the top of conventional memory, the BIOS data area and the vectors each BIOS owns
// differ by construction, before the guest has decided anything.
//
// The TOP of RAM is not comparable either, for the same reason one storey up: SeaBIOS relocates
// itself and its tables there, and MIRAGE has no equivalent, so those pages read as zeros against a
// working structure. Measured on this image — 64 MB: 2411 bytes over 02ff7000..02ffffff; 32 MB:
// 2413 bytes over 01fb7000..01fbffff. The offset from the top of RAM is NOT constant between the
// two, so there is no boundary to compute; the addresses are v86's business, not a rule.
//
// What IS both comparable and interesting is the BOTTOM of extended memory: HIMEM hands out XMS
// blocks from 1 MiB upwards, so that is where an XMS move lands — the thing this mode exists to
// compare — and it is far below anything either BIOS touches. Hence the default of the first 15 MiB
// above the line. Pass explicit ranges as the third field
// (`--mem=LBA:k:100000-4000000,0-a0000`) to look anywhere else, as long as you know that a
// difference there may belong to a BIOS rather than to the guest.
const MEM_RANGES = memRangeArg
  ? memRangeArg.split(',').map((r) => r.split('-').map((x) => parseInt(x, 16)))
  : [[0x100000, 0x1000000]];
// POSITIVE CONTROL FOR --mem. The other two controls are useless here, and the rule this file states
// for ports says why: a control must perturb THE OBSERVABLE BEING COMPARED. DIFFV86_ALT perturbs the
// sector stream (and worse: with a different image the sync sector may never be read, so the run
// aborts instead of reporting a difference), DIFFV86_PERTURB perturbs a port read. So for memory:
// flip every bit of one byte of MIRAGE's guest RAM at the sync instant, just before the snapshot.
// The comparison must then report exactly one differing byte, in the page holding that address.
// The byte is FLIPPED rather than set, because setting it to a value it already holds is a control
// that silently does not fire — which is the failure mode this whole idea exists to prevent.
const MEM_POKE = process.env.DIFFV86_MEMPOKE !== undefined ? parseInt(process.env.DIFFV86_MEMPOKE, 16) : -1;
const bytes = new Uint8Array(readFileSync(img));
// POSITIVE CONTROL. DIFFV86_ALT gives MIRAGE a different image from v86's, so the guests really do
// behave differently and the comparison MUST report it. Without a control that fires, "identical"
// is not evidence: it is equally what a broken hook, a bad alignment or an empty stream produces.
// The first control tried here perturbed MIRAGE's head count, and it changed nothing — every read
// of this phase is in cylinder 0, where the head count drops out of the CHS arithmetic.
// A CONTROL MUST PERTURB THE OBSERVABLE BEING COMPARED. DIFFV86_ALT (a different image for MIRAGE)
// fires on sectors and does NOT fire on ports: removing SMARTDRV changes which sectors are read but
// barely touches the port sequence, and the comparison reported the same index either way. So for
// ports the control is DIFFV86_PERTURB=<port>:<nth>, which corrupts the value returned by ONE read
// of one port — exactly the class of defect the port comparison is meant to catch.
const perturb = process.env.DIFFV86_PERTURB ? process.env.DIFFV86_PERTURB.split(':').map((x) => parseInt(x, 16)) : null;
const altPath = process.env.DIFFV86_ALT;
const altBytes = altPath ? new Uint8Array(readFileSync(altPath)) : bytes;
if (altPath) console.log(`CONTROL: MIRAGE runs ${altPath.split('/').pop()} while v86 runs ${img.split('/').pop()}`);

// ---- MIRAGE: the guest's own INT 13h requests -------------------------------------------------
async function runMirage() {
  const { makeMachine } = await import(join(ROOT, 'tools/harness.mjs'));
  const { bootSector } = await import(join(ROOT, 'src/boot.js'));
  const { mc } = makeMachine({ dos: false, memSize: MEM_MB << 20 });
  mc.disk.attach(0x80, altBytes, { cyl: geom[0], heads: geom[1], spt: geom[2], type: 3 });
  const lbas = [];
  // Port accesses, in typed arrays: at four million events an object per access is not affordable.
  const io = { port: new Uint16Array(CAP), tag: new Uint8Array(CAP), val: new Uint32Array(CAP), n: 0 };
  // The snapshot is taken INSIDE the port handler, so it is the state at that access and not at the
  // end of whatever slice happened to contain it.
  let snap = null, lbaSeen = 0;
  const stopAt = () => {
    if (snap) return;
    if (MEM_POKE >= 0) {
      const was = mc.mem.u8[MEM_POKE], now = (~was) & 0xff;
      mc.mem.u8[MEM_POKE] = now;
      const inside = MEM_RANGES.some(([lo, hi]) => MEM_POKE >= lo && MEM_POKE < hi);
      console.log(`CONTROL: linear ${hex(MEM_POKE, 8)} in MIRAGE's guest memory ${hex(was, 2)} -> ${hex(now, 2)}` +
        (inside ? ' — the comparison must report exactly 1 byte'
                : ' *** OUTSIDE every compared range, so this control CANNOT fire ***'));
    }
    snap = MEM_RANGES.map(([lo, hi]) => mc.mem.u8.slice(lo, hi));
  };
  if (IO_MODE) {
    const rd = mc.cpu.ioRead, wr = mc.cpu.ioWrite;
    let perturbSeen = 0;
    mc.cpu.ioRead = (p, sz) => {
      let v = rd(p, sz);
      if (perturb && p === perturb[0] && ++perturbSeen === perturb[1]) {
        // A DISTINCTIVE value, not a flipped bit: flipping bit 0 of the VGA retrace port produced a
        // value the guest legitimately sees there, so the comparison matched and the control lied.
        console.log(`CONTROL: corrupting read #${perturbSeen} of port ${hex(p, 3)}: ${hex(v, 2)} -> a5`);
        v = 0xa5;
      }
      if (io.n < CAP && watched(p)) { io.port[io.n] = p; io.tag[io.n] = sz; io.val[io.n] = v >>> 0; io.n++; }
      return v;
    };
    mc.cpu.ioWrite = (p, sz, v) => {
      if (io.n < CAP && watched(p)) { io.port[io.n] = p; io.tag[io.n] = 0x80 | sz; io.val[io.n] = v >>> 0; io.n++; }
      return wr(p, sz, v);
    };
  }
  const o13 = mc.intHandlers[0x13];
  mc.intHandlers[0x13] = (c, m) => {
    const ah = (c.ax >> 8) & 0xff, al = c.ax & 0xff, cx = c.cx & 0xffff, dx = c.dx & 0xffff;
    const cl = cx & 0xff, ch = (cx >> 8) & 0xff;
    const sector = cl & 0x3f, cyl = ch | ((cl & 0xc0) << 2), head = (dx >> 8) & 0xff;
    const r = o13 ? o13(c, m) : undefined;
    // Only reads that SUCCEEDED: a refused request moved no data and the guest will react to the
    // error, which is a divergence the stream would otherwise hide as a missing sector.
    if (ah === 0x02 && (dx & 0xff) >= 0x80 && !(c.flags & 1)) {
      const lba = (cyl * geom[1] + head) * geom[2] + sector - 1;
      for (let i = 0; i < al; i++) lbas.push(lba + i);
      if (MEM_LBA >= 0 && lba <= MEM_LBA && MEM_LBA < lba + al && ++lbaSeen === MEM_NTH) stopAt();
    }
    return r;
  };
  let fault = null, derail = null;
  mc.onError = (e) => { fault = e; };
  mc.onDerail = (d) => { if (!derail) derail = d; };
  bootSector(mc, altBytes, { drive: 0x80 });
  const t0 = Date.now();
  while (!fault && !derail && !snap && Date.now() - t0 < SECS * 1000) { mc.runSlice(20000); mc.tickTimer(); }
  return { lbas, io, snap, stop: fault ? `fault: ${(fault.message || fault).slice(0, 120)}`
    : derail ? `derail: ${derail.slice(0, 120)}` : 'ran to the time limit' };
}

// ---- v86: the same guest, observed at the IDE device ------------------------------------------
function runV86() {
  return new Promise(async (resolve) => {
    const buf = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    const { V86 } = await import(V86_DIR + '/node_modules/v86/build/libv86.mjs');
    const emulator = new V86({
      wasm_path: V86_DIR + '/node_modules/v86/build/v86.wasm',
      bios: { buffer: buf(V86_DIR + '/seabios.bin') },
      vga_bios: { buffer: buf(V86_DIR + '/vgabios.bin') },
      hda: { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      memory_size: MEM_MB * 1024 * 1024, vga_memory_size: 8 * 1024 * 1024,
      autostart: true, disable_keyboard: true, disable_mouse: true,
    });
    const lbas = [];
    const io = { port: new Uint16Array(CAP), tag: new Uint8Array(CAP), val: new Uint32Array(CAP), n: 0 };
    let snap = null, lbaSeen = 0;
    const grab = () => {
      if (snap) return;
      snap = MEM_RANGES.map(([lo, hi]) => new Uint8Array(emulator.read_memory(lo, hi - lo)));
      clearInterval(iv); try { emulator.stop(); } catch (e) {}
      resolve({ lbas, io, snap });
    };
    // NOT the `ide-read-end` event: its payload is [0, byte length, sector count] — the first field
    // is always zero, so decoding it as a disk offset yields a stream of 0 1 2 3 that looks like
    // data and is not. The LBA lives in the interface's own registers, and v86 exposes get_lba().
    let hooked = false;
    const hook = () => {
      const ide = emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices && emulator.v86.cpu.devices.ide;
      const iface = ide && ide.primary && ide.primary.master;
      if (!iface || hooked) return false;
      // The instance is sealed, so the wrapper goes on the prototype. One disk, one interface.
      const proto = Object.getPrototypeOf(iface);
      for (const name of ['ata_read_sectors', 'ata_read_sectors_dma']) {
        const orig = proto[name];
        if (typeof orig !== 'function') continue;
        proto[name] = function (...args) {
          const lba = this.get_lba(), n = this.get_count();
          if (lba >= 0 && n > 0) {
            for (let i = 0; i < n; i++) lbas.push(lba + i);
            // The snapshot must be taken AFTER the transfer, so both sides see the sector landed.
            if (MEM_LBA >= 0 && lba <= MEM_LBA && MEM_LBA < lba + n && ++lbaSeen === MEM_NTH) {
              const r = orig.apply(this, args); grab(); return r;
            }
          }
          return orig.apply(this, args);
        };
      }
      // Port I/O has ONE interception point on each side: v86 dispatches through io.port_read8/16/32
      // and port_write8/16/32, MIRAGE through cpu.ioRead/ioWrite.
      if (IO_MODE) {
        const ioObj = emulator.v86.cpu.io, ioProto = Object.getPrototypeOf(ioObj);
        for (const [name, sz, isWrite] of [['port_read8', 1, false], ['port_read16', 2, false], ['port_read32', 4, false],
          ['port_write8', 1, true], ['port_write16', 2, true], ['port_write32', 4, true]]) {
          const orig = ioProto[name];
          if (typeof orig !== 'function') continue;
          ioProto[name] = isWrite
            ? function (p, v) { if (io.n < CAP && watched(p)) { io.port[io.n] = p; io.tag[io.n] = 0x80 | sz; io.val[io.n] = v >>> 0; io.n++; } return orig.call(this, p, v); }
            : function (p) { const v = orig.call(this, p); if (io.n < CAP && watched(p)) { io.port[io.n] = p; io.tag[io.n] = sz; io.val[io.n] = v >>> 0; io.n++; } return v; };
        }
      }
      hooked = true;
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 20);
    setTimeout(() => { if (snap) return; clearInterval(iv); try { emulator.stop(); } catch (e) {} resolve({ lbas, io, snap }); }, SECS * 1000);
  });
}

console.log(`${img.split('/').pop()}: MIRAGE geometry ${geom.join('/')}, ${MEM_MB} MB, ${SECS}s each side` +
  (IO_MODE ? `; comparing PORT ACCESSES${included ? ' on ' + ioArg.split('=')[1] : ' (default exclusions)'}` : '; comparing SECTORS'));
const [a, b] = await Promise.all([runMirage(), runV86()]);

// ---- --mem: the same instant on both sides, compared byte by byte -----------------------------
if (MEM_LBA >= 0) {
  if (!a.snap || !b.snap) {
    console.log(`no snapshot: MIRAGE ${a.snap ? 'took one' : `stopped first (${a.stop})`}, ` +
      `v86 ${b.snap ? 'took one' : `never read sector ${MEM_LBA} a ${MEM_NTH}${MEM_NTH === 1 ? 'st' : 'th'} time`}`);
    process.exit(2);
  }
  console.log(`both stopped on read #${MEM_NTH} of sector ${MEM_LBA} — the guest's own event, so the same instant on both sides`);
  let total = 0;
  for (let r = 0; r < MEM_RANGES.length; r++) {
    const [lo, hi] = MEM_RANGES[r], A = a.snap[r], B = b.snap[r];
    // Per 4 KB page, so a difference is located rather than counted: a whole-range total says
    // nothing about whether one structure moved or the whole map is shifted.
    const pages = [];
    let n = 0;
    for (let p = 0; p < (hi - lo) >> 12; p++) {
      let d = 0;
      for (let k = 0; k < 4096; k++) if (A[(p << 12) + k] !== B[(p << 12) + k]) d++;
      if (d) { n += d; if (pages.length < 12) pages.push(`${hex(lo + (p << 12), 8)} (${d})`); }
    }
    total += n;
    console.log(`  ${hex(lo, 8)}..${hex(hi, 8)}: ${n} bytes differ` + (pages.length ? `, pages ${pages.join(' ')}` : ''));
    // A count locates nothing. Print the first differing bytes WITH BOTH VALUES: that is what says
    // whether a page is a structure one side owns and the other does not, or the same structure
    // holding different data.
    if (n && process.env.DIFFV86_MEMDUMP !== undefined) {
      const shown = [];
      for (let k = 0; k < hi - lo && shown.length < 24; k++) {
        if (A[k] !== B[k]) shown.push(`${hex(lo + k, 8)} ${hex(A[k], 2)}/${hex(B[k], 2)}`);
      }
      console.log('    first differing bytes (MIRAGE/v86): ' + shown.join('  '));
      // IS IT DIFFERENT DATA, OR THE SAME DATA AT A DIFFERENT ADDRESS? Slide one side against the
      // other and report the best alignment. "17007 bytes differ" and "the same structure sits two
      // bytes lower" are entirely different findings, and eyeballing a hex dump is how the second
      // gets asserted without being measured.
      let first = -1, last = -1;
      for (let k = 0; k < hi - lo; k++) if (A[k] !== B[k]) { if (first < 0) first = k; last = k; }
      let best = { d: 0, same: -1 };
      for (let d = -64; d <= 64; d++) {
        let same = 0, seen = 0;
        for (let k = first; k <= last; k++) {
          const j = k + d;
          if (j < 0 || j >= hi - lo) continue;
          seen++; if (A[k] === B[j]) same++;
        }
        if (seen && same / seen > (best.same < 0 ? 0 : best.same)) best = { d, same: same / seen };
      }
      console.log(`    best alignment: shifting v86 by ${best.d >= 0 ? '+' : ''}${best.d} bytes makes ` +
        `${(best.same * 100).toFixed(1)}% of ${hex(lo + first, 8)}..${hex(lo + last, 8)} agree` +
        (best.d === 0 ? ' — so it is different DATA, not a moved structure' : ''));
    }
  }
  console.log(total ? `${total} bytes differ in total` : 'the snapshots are IDENTICAL');
  process.exit(0);
}

// RUN-LENGTH FIRST, on ports. Without this the comparison is VACUOUS and says so by accident: the
// port stream is dominated by spins — HIMEM toggling A20 around every XMS move reads port 92h tens
// of thousands of times in a row — and two guests doing entirely different work still "agree" for
// hundreds of thousands of events. Measured: with SMARTDRV removed from one side, the raw streams
// still reported the same divergence index as the unmodified run, i.e. the agreement carried no
// information. Collapsing runs and comparing only the SEQUENCE OF DISTINCT ACTIONS (never the
// repeat counts, which are timing) makes agreement mean something.
const rle = (io) => {
  const port = new Uint16Array(io.n), tag = new Uint8Array(io.n), val = new Uint32Array(io.n), rep = new Uint32Array(io.n);
  let m = 0;
  for (let k = 0; k < io.n; k++) {
    if (m && port[m - 1] === io.port[k] && tag[m - 1] === io.tag[k] && val[m - 1] === io.val[k]) { rep[m - 1]++; continue; }
    port[m] = io.port[k]; tag[m] = io.tag[k]; val[m] = io.val[k]; rep[m] = 1; m++;
  }
  return { port, tag, val, rep, n: m };
};
const RLE = IO_MODE && process.env.DIFFV86_RAW === undefined;
if (RLE) { a.io = rle(a.io); b.io = rle(b.io); }
if (IO_MODE && !RLE) { for (const io of [a.io, b.io]) io.rep = new Uint32Array(io.n).fill(1); }

// One comparison for both observables: a length, an equality between two indices, and a formatter.
const stream = IO_MODE
  ? {
    name: 'distinct port actions',
    lenA: a.io.n, lenB: b.io.n,
    eq: (i, j) => a.io.port[i] === b.io.port[j] && a.io.tag[i] === b.io.tag[j] && a.io.val[i] === b.io.val[j],
    fmtA: (i) => `${(a.io.tag[i] & 0x80) ? 'out' : 'in '} ${hex(a.io.port[i], 3)}.${a.io.tag[i] & 0x7f} = ${hex(a.io.val[i], 2)}${a.io.rep[i] > 1 ? ` x${a.io.rep[i]}` : ''}`,
    fmtB: (j) => `${(b.io.tag[j] & 0x80) ? 'out' : 'in '} ${hex(b.io.port[j], 3)}.${b.io.tag[j] & 0x7f} = ${hex(b.io.val[j], 2)}${b.io.rep[j] > 1 ? ` x${b.io.rep[j]}` : ''}`,
  }
  : {
    name: 'sectors',
    lenA: a.lbas.length, lenB: b.lbas.length,
    eq: (i, j) => a.lbas[i] === b.lbas[j],
    fmtA: (i) => `LBA ${a.lbas[i]}`,
    fmtB: (j) => `LBA ${b.lbas[j]}`,
  };
console.log(`MIRAGE: ${stream.lenA} ${stream.name}, stopped: ${a.stop}`);
console.log(`v86   : ${stream.lenB} ${stream.name}`);
if (process.env.DIFFV86_DEBUG) {
  console.log('MIRAGE first 12: ' + Array.from({ length: Math.min(12, stream.lenA) }, (_, i) => stream.fmtA(i)).join(' | '));
  console.log('v86    first 12: ' + Array.from({ length: Math.min(12, stream.lenB) }, (_, j) => stream.fmtB(j)).join(' | '));
  console.log('MIRAGE last 12 : ' + Array.from({ length: Math.min(12, stream.lenA) }, (_, k) => stream.fmtA(stream.lenA - 12 + k)).join(' | '));
}
if (!stream.lenA || !stream.lenB) {
  console.log('one side recorded nothing — there is nothing to compare, and that is not a match');
  process.exit(1);
}

// ALIGN FIRST, AND NOT AT EVENT ZERO. The two streams do not start together and cannot: MIRAGE's
// harness loads the boot sector itself while v86 boots through SeaBIOS and the MBR, and on the port
// side each BIOS probes A20 its own way. Anchoring on MIRAGE's FIRST events therefore fails on
// ports — those events have no counterpart at all. What is wanted is the first place the two
// streams SYNCHRONISE: an ANCHOR-long run that occurs in both. Found with a rolling hash over v86's
// stream (O(n), not the O(n^2) of a double scan over hundreds of thousands of events), then
// confirmed element by element so a hash collision cannot pass.
const ANCHOR = IO_MODE ? 24 : 8;
const keyA = (i) => IO_MODE ? (a.io.port[i] * 0x10000 + a.io.tag[i] * 0x100 + (a.io.val[i] & 0xff)) : a.lbas[i];
const keyB = (j) => IO_MODE ? (b.io.port[j] * 0x10000 + b.io.tag[j] * 0x100 + (b.io.val[j] & 0xff)) : b.lbas[j];
const roll = (key, len, at) => { let h = 0; for (let k = 0; k < ANCHOR; k++) h = (Math.imul(h, 33) + key(at + k)) | 0; return h; };
const index = new Map();
for (let j = 0; j + ANCHOR <= stream.lenB; j++) { const h = roll(keyB, stream.lenB, j); if (!index.has(h)) index.set(h, j); }
let startA = -1, off = -1;
for (let i = 0; i + ANCHOR <= stream.lenA && off < 0; i++) {
  const j = index.get(roll(keyA, stream.lenA, i));
  if (j === undefined) continue;
  let ok = true;
  for (let k = 0; k < ANCHOR; k++) if (!stream.eq(i + k, j + k)) { ok = false; break; }
  if (ok) { startA = i; off = j - i; }
}
if (off < 0) {
  console.log(`\nNO SYNCHRONISATION: no run of ${ANCHOR} ${stream.name} occurs in the same order on both sides.` +
    ` Either the guests diverge before anything comparable happens, or the two sides are not watching the same thing.`);
  process.exit(1);
}
// The offset is all that was wanted. COMPARISON THEN STARTS AT THE BEGINNING of the overlap, not at
// the point where the anchor was found — otherwise the aligner skips past exactly what the tool is
// looking for. Proved: corrupting one early port read made the anchor shift past it and the run was
// then reported IDENTICAL. The anchor locates the mapping; it must not choose what gets compared.
const first = Math.max(0, -off);
console.log(`synchronised: MIRAGE event ${startA} == v86 event ${startA + off}` +
  (startA ? ` (anchor found there; comparison still starts at MIRAGE event ${first})` : ''));

const n = Math.min(stream.lenA - first, stream.lenB - first - off);
let i = first;
while (i - first < n && stream.eq(i, i + off)) i++;
if (i - first === n) {
  console.log(`the ${n} ${stream.name} after that point are IDENTICAL in order — the guests did not` +
    ` diverge here${stream.lenA - startA < stream.lenB - startA - off ? `; v86 went on for ${stream.lenB - startA - off - n} more` : ''}`);
  process.exit(0);
}
console.log(`\nFIRST DIVERGENCE at MIRAGE event #${i}:`);
console.log(`  MIRAGE: ${stream.fmtA(i)}`);
console.log(`  v86   : ${stream.fmtB(i + off)}`);
const from = Math.max(first, i - 10);
console.log('context (MIRAGE event #, MIRAGE, v86):');
for (let k = from; k < Math.min(first + n, i + 6); k++)
  console.log(`  ${String(k).padStart(8)}  ${stream.fmtA(k).padEnd(34)}  ${stream.fmtB(k + off)}${k === i ? '   <-- here' : ''}`);
