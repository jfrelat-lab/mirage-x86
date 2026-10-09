// main.js — DOM entry point: boots the machine, wires drag-and-drop ingestion,
// URL-parameter program loading, the live HUD, and the profiling/CRT toggles.
//
// URL parameters:
//   ?run=NAME            run a program already on C: (e.g. ?run=PLASMA)
//   ?run=https://…/x.com fetch a binary, mount it, and run it
//   ?args=...            command tail passed to the program
//   ?load=URL[,URL2]     fetch + mount binaries without running
//   ?zip=URL&run=PROG    fetch a ZIP, unpack it to C:\GAMES\<NAME>\ and run PROG from there
//   ?cmd=DIR             run an arbitrary shell command line
//   ?mhz=8               cap the guest at N million cycles/s (default: uncapped — see ui.js VCPU_HZ)

import { Mirage } from './ui.js';
import { VFS } from './vfs.js';

const canvas = document.getElementById('screen');
const hud = document.getElementById('hud');
const boot = document.getElementById('boot');
const drop = document.getElementById('drop');

const mhz = parseFloat(new URLSearchParams(location.search).get('mhz'));
const app = new Mirage(canvas, {
  onFrame: throttle(updateHud, 100),
  ...(mhz > 0 ? { vcpuHz: mhz * 1e6 } : {}),
});

app.boot().then(async () => {
  boot.remove();
  await handleUrl(new URLSearchParams(location.search));
}).catch(e => { boot.textContent = 'Boot failed: ' + (e.message || e); console.error(e); });

window.mirage = app;   // handy for the console / debugging

// ---- URL parameters --------------------------------------------------------
async function handleUrl(p) {
  const loads = (p.get('load') || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const u of loads) await fetchInto(u);

  const zip = p.get('zip');
  if (zip) {
    try {
      const name = await app.mountZip(zip.split('/').pop().split('?')[0], new Uint8Array(await (await fetch(zip)).arrayBuffer()));
      const run = p.get('run');
      app.runCommand(run ? `GAMES\\${name}\\${run}` + (p.get('args') ? ' ' + p.get('args') : '') : `CD GAMES\\${name}`);
      if (!run) app.runCommand('DIR');
    } catch (e) { console.warn('zip failed', zip, e); }
    return;
  }
  const run = p.get('run');
  if (run) {
    if (/^https?:\/\//i.test(run)) { const name = await fetchInto(run); if (name) app.runCommand(name); }
    else app.runCommand(run + (p.get('args') ? ' ' + p.get('args') : ''));
  }
  const cmd = p.get('cmd');
  if (cmd) app.runCommand(cmd);
}

async function fetchInto(url) {
  try {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const base = VFS.dosName(url.split('/').pop().split('?')[0] || 'PROG.COM');
    app.mountFile(base, buf);
    return base;
  } catch (e) { console.warn('load failed', url, e); return null; }
}

// ---- drag and drop into the virtual disk -----------------------------------
['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('show'); }));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (ev !== 'drop') drop.classList.remove('show'); }));

window.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('show');
  const files = [...(e.dataTransfer?.files || [])];
  const mounted = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {                     // an archive becomes a folder under C:\GAMES
      try { mounted.push('GAMES\\' + await app.mountZip(f.name, bytes) + '\\'); } catch (e) { console.warn(e); }
      continue;
    }
    const name = VFS.dosName(f.name);
    app.mountFile(name, bytes);
    mounted.push(name);
  }
  if (!mounted.length) return;
  if (app.shell.state === 'input') {
    app.shell.print(`\r\n[mounted ${mounted.join(', ')} on C:]\r\n`);
    app.shell.prompt();
    if (mounted.length === 1 && /\.(COM|EXE|BAT)$/i.test(mounted[0])) app.runCommand(mounted[0]);
  }
});

// ---- HUD + toggles ---------------------------------------------------------
let lastExec = 0, lastT = performance.now(), ips = 0;
function updateHud(a) {
  const s = a.stats();
  const now = performance.now();
  if (now - lastT > 250) { ips = Math.round((s.exec - lastExec) / ((now - lastT) / 1000)); lastExec = s.exec; lastT = now; }
  const f = s.flags;
  const fl = ['C', 'P', 'A', 'Z', 'S', 'I', 'D', 'O'];
  const fb = [f & 1, (f >> 2) & 1, (f >> 4) & 1, (f >> 6) & 1, (f >> 7) & 1, (f >> 9) & 1, (f >> 10) & 1, (f >> 11) & 1];
  const hx = (v, n = 4) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
  hud.innerHTML =
    `<div class="row"><b>${s.running ? 'RUN' : 'idle'}${s.blocked ? '·wait' : ''}</b>` +
    `<span>mode ${hx(s.mode, 2)}h</span><span>${(ips / 1e6).toFixed(2)}M blk/s</span></div>` +
    `<div class="row mono">AX ${hx(s.ax)} BX ${hx(s.bx)} CX ${hx(s.cx)} DX ${hx(s.dx)}</div>` +
    `<div class="row mono">SI ${hx(s.si)} DI ${hx(s.di)} BP ${hx(s.bp)} SP ${hx(s.sp)}</div>` +
    `<div class="row mono">CS ${hx(s.cs)} DS ${hx(s.ds)} ES ${hx(s.es)} SS ${hx(s.ss)}</div>` +
    `<div class="row mono">IP ${hx(s.ip)}  FLAGS ${fl.map((c, i) => fb[i] ? c : c.toLowerCase()).join('')}</div>` +
    `<div class="row"><span>JIT blocks ${s.compiles}</span></div>`;
}

function throttle(fn, ms) { let last = 0; return (...a) => { const t = performance.now(); if (t - last >= ms) { last = t; fn(...a); } }; }

const crtBtn = document.getElementById('crt-toggle');
const hudBtn = document.getElementById('hud-toggle');
const sync = (btn, on) => { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); };

// CRT scanlines are ON by default; the DEVTOOLS inspector is OFF by default.
sync(crtBtn, document.body.classList.contains('crt'));
sync(hudBtn, document.body.classList.contains('show-hud'));

crtBtn.addEventListener('click', () => sync(crtBtn, document.body.classList.toggle('crt')));
hudBtn.addEventListener('click', () => { const on = document.body.classList.toggle('show-hud'); app.setProfiling(on); sync(hudBtn, on); });
