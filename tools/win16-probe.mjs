// win16-probe.mjs — oracle Win16 : piéger n'importe quel export de KERNEL/USER/GDI/VGA.DRV pendant
// un vrai run de Windows 3.0, et rendre ses arguments, sa valeur de retour et son effet réel.
//
//   node tools/win16-probe.mjs KERNEL @175 @177          deux ordinaux
//   node tools/win16-probe.mjs GDI TEXTOUT EXTTEXTOUT    par nom
//   node tools/win16-probe.mjs VGA.DRV EXTTEXTOUT --planes    + effet sur les pixels
//   node tools/win16-probe.mjs --census KERNEL           quels exports sont REELLEMENT appeles
//   WIN16_KEYS='38,21,a1,b8/13,93/2e,ae,26,a6,18,98,2e,ae,25,a5/1c,9c' …   Alt+F, R, "clock", Entree
//
// Ce fichier existe parce que les mesures qui ont debloque Windows 3.0 — le selecteur rendu par
// PrestoChangoSelector, la police que VGA.DRV refuse, la ressource que KERNEL croit chargee — ont
// toutes ete faites avec la meme recette, jetee et reecrite a chaque fois. La recette est ici, avec
// les quatre gardes qui lui ont manque au moins une fois chacune :
//
//   1. TEMOIN. Chaque entree piegee compte aussi ses passages SANS verification d'octets. Un zero
//      n'est un resultat que si l'instrument a mordu ailleurs ; sinon c'est une sonde muette, et une
//      sonde muette a exactement l'air d'une absence d'appel.
//   2. LIVRAISON DES TOUCHES. Sous runSlice(1) les scancodes injectes cessent d'etre lus au port
//      0x60 : on reste en tranches larges TANT QUE des scancodes restent a lire, et on ne passe au
//      pas-a-pas qu'apres. Plusieurs mesures ont porte sur un run ou rien n'avait ete tape.
//   3. SIGNATURE A +3. Les trois premiers octets d'une entree SINGLEDATA sont reecrits au
//      chargement (8c d8 90 -> b8 <DGROUP>) : comparer a partir de 0 rejette des entrees legitimes,
//      comparer a partir de +3 distingue quand meme deux segments qui partagent un IP.
//   4. "n sur N". Toute liste tronquee le dit dans sa propre sortie. Une tranche de six lignes lue
//      comme la population a coute une conclusion fausse et un message a retirer.
//
// Convention PASCAL : a l'entree, [SS:SP+0] et [SS:SP+2] sont l'IP et le CS de retour ; les
// arguments commencent a [SS:SP+4], le DERNIER empile en premier. Le nombre d'octets depiles se lit
// par difference de SP entre l'entree et le retour, ce qui donne le nombre d'arguments sans avoir a
// le supposer.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeMachine } from './harness.mjs';
import { walk } from './corpus.mjs';
import { VFS } from '../src/vfs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = join(ROOT, 'boot', process.env.WIN30_DIR || 'WIN30');
const h = (v, n = 4) => (v === undefined || v === null ? '?'.repeat(n) : (v >>> 0).toString(16).padStart(n, '0'));

const argv = process.argv.slice(2);
const census = argv[0] === '--census';
const wantPlanes = argv.includes('--planes');
const modArg = (census ? argv[1] : argv[0]) || '';
const wanted = (census ? [] : argv.slice(1)).filter((a) => !a.startsWith('--'));
if (!modArg) {
  console.error('usage: win16-probe.mjs <MODULE> <@ordinal|NOM> [...] [--planes]\n' +
                '       win16-probe.mjs --census <MODULE>');
  process.exit(2);
}
const file = join(TREE, /\./.test(modArg) ? modArg : modArg.toUpperCase() + '.EXE');
if (!existsSync(file)) { console.error(`pas de ${file} — construire l'arbre avec tools/win30-install.mjs`); process.exit(2); }

// ---- table d'entree NE : ordinal -> { seg, off }, et les noms des deux tables ----------------
const nb = readFileSync(file);
const u16 = (o) => nb[o] | (nb[o + 1] << 8);
const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
const ne = u16(0x3c);
const segTab = ne + u16(ne + 0x22), align = 1 << u16(ne + 0x32);
const segFile = (n) => u16(segTab + (n - 1) * 8) * align;      // n = numero de segment, 1-based

const names = new Map();                                        // ordinal -> nom
const readNames = (off, end) => {
  let o = off;
  while (o < end && nb[o]) {
    const n = nb[o], s = String.fromCharCode(...nb.slice(o + 1, o + 1 + n));
    names.set(u16(o + 1 + n), s); o += 1 + n + 2;
  }
};
// La table RESIDENTE de KERNEL ne contient que le nom du module ; tous ses exports nommes sont dans
// la table NON RESIDENTE, dont l'offset est un offset FICHIER. Sa longueur n'est PAS le champ 0x2a
// (c'est l'offset des noms importes) : on lit jusqu'au terminateur de longueur nulle.
readNames(ne + u16(ne + 0x26), nb.length);
readNames(u32(ne + 0x2c), nb.length);

const entries = new Map();                                      // ordinal -> { seg, off, movable }
{
  let o = ne + u16(ne + 0x04), ord = 1;
  const end = o + u16(ne + 0x06);
  while (o < end) {
    const cnt = nb[o], type = nb[o + 1];
    if (cnt === 0) break;
    o += 2;
    for (let i = 0; i < cnt; i++) {
      if (type === 0xff) { entries.set(ord, { seg: nb[o + 3], off: u16(o + 4), movable: true }); o += 6; }
      else if (type !== 0) { entries.set(ord, { seg: type, off: u16(o + 1), movable: false }); o += 3; }
      ord++;
    }
  }
}
/** Les 4 octets a +3 de l'entree, pris dans le FICHIER : la signature qui distingue deux segments
 *  partageant un IP, sans dependre du prologue reecrit au chargement. */
const sigOf = (e) => [...nb.slice(segFile(e.seg) + e.off + 3, segFile(e.seg) + e.off + 7)];

if (census) {
  const fixed = [...entries.entries()].filter(([, e]) => !e.movable && e.seg === 1);
  console.log(`${modArg} : ${entries.size} entrees, dont ${fixed.length} fixes du segment 1 (les seules couvertes)`);
}

// ---- les entrees a pieger --------------------------------------------------------------------
const traps = new Map();                                        // offset -> { ord, name, sig, seg }
const add = (ord) => {
  const e = entries.get(ord);
  if (!e) { console.error(`  ordinal ${ord} absent de la table d'entree`); return; }
  traps.set(e.off, { ord, name: names.get(ord) || `@${ord}`, sig: sigOf(e), seg: e.seg, movable: e.movable });
};
if (census) for (const [ord, e] of entries) { if (!e.movable && e.seg === 1) add(ord); }
else for (const w of wanted) {
  if (w.startsWith('@')) add(Number(w.slice(1)));
  else {
    const hit = [...names.entries()].find(([, n]) => n.toUpperCase() === w.toUpperCase());
    if (hit) add(hit[0]); else console.error(`  nom inconnu : ${w}`);
  }
}
if (!traps.size) { console.error('rien a pieger'); process.exit(2); }

// Garde 1 bis : imprimer ce qui est ARME avant de mesurer. Un « temoin AUCUN » ne distingue pas
// « armee a une adresse valide qui n'a jamais tourne » (une mesure) de « jamais armee, resolution
// echouee » (pas de mesure du tout) — meme classe que le « n sur N ». La ligne ci-dessous coute
// une ligne et rend la difference lisible dans la sortie.
if (!census) for (const [off, t] of traps)
  console.log(`arme : ${t.name} (@${t.ord}) -> segment ${t.seg}${t.movable ? ' MOVABLE' : ''} offset ${h(off)}` +
    `  signature fichier +3 : ${t.sig.map((x) => h(x, 2)).join(' ')}`);

// ---- la machine --------------------------------------------------------------------------------
const vfs = new VFS();
for (const rel of walk(TREE)) vfs.addFile('\\' + rel.split('/').join('\\'), new Uint8Array(readFileSync(join(TREE, rel))));
vfs.chdir('\\');
const { mc, dos } = makeMachine({ vfs });
const cpu = mc.cpu;

// Garde 2 : le temoin de livraison des touches. On compte ce que le guest LIT au port 0x60, pas ce
// qu'on a injecte — l'injection reussit toujours, la lecture non.
const port = [];
const origRead = mc.portRead[0x60];
mc.portRead[0x60] = (p, s) => { const v = origRead(p, s); port.push(v & 0xff); return v; };

const GROUPS = (process.env.WIN16_KEYS || '').split('/')
  .map((g) => g.split(',').map((x) => parseInt(x.trim(), 16)).filter((x) => !isNaN(x))).filter((g) => g.length);
let expectedReads = 2;                                          // les deux ACK 0xfa du controleur
for (const g of GROUPS) expectedReads += g.length;

const stamp = () => {                                            // empreinte des quatre plans VGA
  const p = mc.vga && mc.vga.planes; if (!p) return 0;
  let s = 0; for (let i = 0; i < p.length; i += 7) s = (s + p[i] * (i & 255)) >>> 0; return s;
};

dos.load(new Uint8Array(readFileSync(join(TREE, 'WIN.COM'))), ' ' + (process.env.WIN16_ARGS || '/r'), 'C:\\WIN.COM');

const BLOCKS = Number(process.env.WIN16_BLOCKS) || 100_000_000;
const SECS = Number(process.env.WIN16_SECS) || 240;
const MAX = Number(process.env.WIN16_MAX) || 24;                // appels detailles retenus
const bare = new Map(), calls = [], counts = new Map();
let pending = null, b = 0, guard = 0, sent = 0;
const t0 = Date.now();
const delivered = () => sent >= GROUPS.length && port.length >= expectedReads;

while (b < BLOCKS && !dos.programDone && !cpu.halted && guard++ < 200_000_000 && Date.now() - t0 < SECS * 1000) {
  if (sent < GROUPS.length && b > BLOCKS * (0.30 + 0.55 * sent / Math.max(1, GROUPS.length - 1))) {
    mc.pushScancodes(GROUPS[sent]); sent++;
  }
  if (mc.pumpKeyboard) mc.pumpKeyboard();
  // Garde 2 : tranches larges tant que des scancodes restent a lire ; le pas-a-pas ne commence
  // qu'apres, sinon la frappe n'atteint jamais le guest et on mesure un run ou rien n'est tape.
  if (!delivered()) { b += mc.runSlice(20000); continue; }

  const ip = cpu.eip & 0xffff, t = traps.get(ip);
  if (t && !pending) {
    bare.set(t.name, (bare.get(t.name) || 0) + 1);               // garde 1 : le temoin, sans signature
    const lin = (cpu.seg[1] << 4) + ip + 3;
    let ok = true;
    for (let k = 0; k < 4; k++) if (mc.mem.r8(lin + k) !== t.sig[k]) { ok = false; break; }
    if (ok) {
      const sp = cpu.reg[4] & 0xffff, a = (cpu.seg[2] << 4) + sp, r = (x) => mc.mem.r16(a + x);
      counts.set(t.name, (counts.get(t.name) || 0) + 1);
      pending = { name: t.name, ord: t.ord, at: b, cs: cpu.seg[1], entry: ip, ss: cpu.seg[2], sp,
        retIp: r(0), retCs: r(2), args: [r(4), r(6), r(8), r(10), r(12), r(14)],
        in: { AX: cpu.ax & 0xffff, BX: cpu.bx & 0xffff, CX: cpu.cx & 0xffff, DX: cpu.dx & 0xffff },
        planes: wantPlanes ? stamp() : null };
    }
  } else if (pending && cpu.seg[1] === pending.retCs && ip === pending.retIp) {
    if (calls.length < MAX) {
      const l2 = (pending.retCs << 4) + pending.retIp, code = [];
      for (let k = 0; k < 12; k++) code.push(mc.mem.r8(l2 + k));  // ce que l'appelant fait du resultat
      calls.push({ ...pending, code,
        out: { AX: cpu.ax & 0xffff, BX: cpu.bx & 0xffff, CX: cpu.cx & 0xffff, DX: cpu.dx & 0xffff },
        popped: (((cpu.reg[4] & 0xffff) - pending.sp) & 0xffff) - 4,
        painted: wantPlanes ? stamp() !== pending.planes : null });
    }
    pending = null;
  }
  b += mc.runSlice(1);
}

console.log(`${b} blocs en ${((Date.now() - t0) / 1000).toFixed(1)}s` +
  (GROUPS.length ? `, scancodes lus ${port.length}/${expectedReads}` : '') +
  ` [sortie: ${dos.programDone ? 'programme termine' : cpu.halted ? 'CPU halted' : b >= BLOCKS ? 'budget' : 'temps'}]`);
console.log(`temoin (IP seuls, sans verification d'octets) : ` +
  ([...bare.entries()].map(([k, v]) => `${k} x${v}`).join('  ') || '(AUCUN — si un compte attendu est nul, c est peut-etre la sonde)'));

if (census) {
  const called = [...counts.entries()].sort((a, c) => c[1] - a[1]);
  console.log(`\nexports appeles : ${called.length} sur ${traps.size} pieges`);
  for (const [n, c] of called.slice(0, 40)) console.log(`  ${n} x${c}`);
  console.log(`(${Math.min(40, called.length)} sur ${called.length} affiches)`);       // garde 4
} else {
  console.log(`\n${calls.length} appel(s) detaille(s) sur ${[...counts.values()].reduce((a, c) => a + c, 0)} captures :`);
  for (const c of calls) {
    console.log(`\n  ${c.name} (@${c.ord}) en ${h(c.cs)}:${h(c.entry)}` +
      `  bloc ${c.at}  retour vers ${h(c.retCs)}:${h(c.retIp)}  SS:SP=${h(c.ss)}:${h(c.sp)}`);
    console.log(`    pile a l'entree : [+4]=${h(c.args[0])} [+6]=${h(c.args[1])} [+8]=${h(c.args[2])} ` +
      `[+10]=${h(c.args[3])} [+12]=${h(c.args[4])} [+14]=${h(c.args[5])}   octets depiles : ${c.popped}`);
    const keys = ['AX', 'BX', 'CX', 'DX'];
    console.log(`    MESURE : ` + keys.map((k) => `${k} ${h(c.in[k])}->${h(c.out[k])}`).join('  ') +
      (c.painted === null ? '' : `   pixels : ${c.painted ? 'ECRITS' : 'aucun'}`));
    console.log(`    octets a l'adresse de retour : ${c.code.map((x) => h(x, 2)).join(' ')}`);
  }
  if (!calls.length) console.log('  (aucun — lire le temoin ci-dessus avant de conclure a une absence d appel)');
}
