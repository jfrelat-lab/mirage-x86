// diff-v86.mjs — run the SAME disk image in MIRAGE and in v86 and find the first point where the
// two guests ask for different things.
//
//   mkdir -p /tmp/v86ref && cd /tmp/v86ref && npm init -y && npm i v86
//   curl -o /tmp/v86ref/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
//   curl -o /tmp/v86ref/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
//   V86_DIR=/tmp/v86ref node tools/diff-v86.mjs boot/WIN31HD.IMG 66,16,63 [seconds]
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
const geom = (process.argv[3] || '66,16,63').split(',').map(Number);
const SECS = Number(process.argv[4] || 90);
const MEM_MB = Number(process.env.MEM || 64);
const hex = (v, n = 4) => (v >>> 0).toString(16).padStart(n, '0');
const bytes = new Uint8Array(readFileSync(img));
// POSITIVE CONTROL. DIFFV86_ALT gives MIRAGE a different image from v86's, so the guests really do
// behave differently and the comparison MUST report it. Without a control that fires, "identical"
// is not evidence: it is equally what a broken hook, a bad alignment or an empty stream produces.
// The first control tried here perturbed MIRAGE's head count, and it changed nothing — every read
// of this phase is in cylinder 0, where the head count drops out of the CHS arithmetic.
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
    }
    return r;
  };
  let fault = null, derail = null;
  mc.onError = (e) => { fault = e; };
  mc.onDerail = (d) => { if (!derail) derail = d; };
  bootSector(mc, altBytes, { drive: 0x80 });
  const t0 = Date.now();
  while (!fault && !derail && Date.now() - t0 < SECS * 1000) { mc.runSlice(20000); mc.tickTimer(); }
  return { lbas, stop: fault ? `fault: ${(fault.message || fault).slice(0, 120)}`
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
          if (lba >= 0 && n > 0) for (let i = 0; i < n; i++) lbas.push(lba + i);
          return orig.apply(this, args);
        };
      }
      hooked = true;
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 20);
    setTimeout(() => { clearInterval(iv); try { emulator.stop(); } catch (e) {} resolve({ lbas }); }, SECS * 1000);
  });
}

console.log(`${img.split('/').pop()}: MIRAGE geometry ${geom.join('/')}, ${MEM_MB} MB, ${SECS}s each side`);
const [a, b] = await Promise.all([runMirage(), runV86()]);
console.log(`MIRAGE read ${a.lbas.length} sectors, stopped: ${a.stop}`);
console.log(`v86    read ${b.lbas.length} sectors`);

if (process.env.DIFFV86_DEBUG) {
  console.log('MIRAGE first 24: ' + a.lbas.slice(0, 24).join(' '));
  console.log('v86    first 24: ' + b.lbas.slice(0, 24).join(' '));
}

// ALIGN FIRST. The two streams do not start together and cannot: MIRAGE's harness loads the boot
// sector itself, while v86 boots through SeaBIOS and the MBR, so each side's prologue is its own
// mechanism rather than the guest's decision. Anchor on the first 8-sector run of MIRAGE's stream,
// found in v86's; without that the comparison reports a "divergence" at request 0 every time.
const ANCHOR = 8;
let off = -1;
for (let j = 0; j + ANCHOR <= b.lbas.length && off < 0; j++) {
  let ok = true;
  for (let k = 0; k < ANCHOR; k++) if (b.lbas[j + k] !== a.lbas[k]) { ok = false; break; }
  if (ok) off = j;
}
if (off < 0) {
  console.log(`\nNO ALIGNMENT: MIRAGE's first ${ANCHOR} sectors (${a.lbas.slice(0, ANCHOR).join(' ')}) never occur in that order in v86's stream.` +
    ` The guests diverge before anything comparable happens, or the anchor is too long for this image.`);
  process.exit(1);
}
console.log(`aligned: MIRAGE request 0 == v86 request ${off} (anchor of ${ANCHOR} sectors)`);

// The flattened streams, compared in order. A guest that re-reads the same sector does so in both,
// so no de-duplication: repetition carries information.
const n = Math.min(a.lbas.length, b.lbas.length - off);
let i = 0;
while (i < n && a.lbas[i] === b.lbas[off + i]) i++;
if (i === n) {
  console.log(`the first ${n} sectors after the anchor are IDENTICAL in order — the guests did not` +
    ` diverge in what they read${a.lbas.length < b.lbas.length - off ? `; v86 went on to read ${b.lbas.length - off - n} more` : ''}`);
  process.exit(0);
}
console.log(`\nFIRST DIVERGENCE at request #${i} after the anchor: MIRAGE asks LBA ${a.lbas[i]}, v86 asks LBA ${b.lbas[off + i]}`);
const from = Math.max(0, i - 8);
console.log('context (request #, MIRAGE, v86):');
for (let k = from; k < Math.min(n, i + 8); k++)
  console.log(`  ${String(k).padStart(6)}  ${String(a.lbas[k]).padStart(8)}  ${String(b.lbas[off + k]).padStart(8)}${k === i ? '   <-- here' : ''}`);
