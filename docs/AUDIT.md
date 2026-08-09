# MIRAGE — audit de conformité (2026-08-04)

Audit de la base de code face aux specs **x86 / DOS / CGA-EGA-VGA**, sur trois axes :
compatibilité, performance, maintenance. Déclencheur : le bug `0x67` (préfixe address-size
consommé puis ignoré → désynchronisation du flux d'instructions), qui a coûté une session
entière de diagnostic.

## Le constat central : le *faux silencieux*

Les trois audits ont trouvé **indépendamment le même motif**, à trois étages :

| étage | motif |
|---|---|
| **CPU** | un préfixe ou une condition **décode proprement** puis fait autre chose que la spec — aucun diagnostic |
| **Vidéo** | des registres sont **stockés mais jamais consultés** ; la géométrie vient d'une table figée, pas du CRTC |
| **DOS/BIOS** | un service non implémenté **retourne « succès »** (CF inchangé) au lieu d'une erreur |

`0x67` n'était pas un accident isolé : c'est **la classe de bug dominante** de la base.

Et la cause structurelle est unique : **les gates ne peuvent pas voir cette classe.**
`conformance.js` est mono-instruction et 8088 seulement (donc aveugle au 386 et au stripping
multi-instructions) ; `golden.js` couvre 20 démos par empreinte framebuffer ; `dos.js` (407 l.),
`vfs.js` (169), `xms.js` (104) et l'essentiel des INT 10h/16h/1Ah de `bios.js` ont
**zéro couverture automatisée**. Chaque défaut listé ici peut être introduit — ou corrigé puis
re-cassé — avec un gate **entièrement vert**.

---

## Tier 0 — corruption silencieuse côté CPU (le plus grave, le moins cher)

| # | Défaut | Fichier | Effet |
|---|---|---|---|
| **T0.1** | **Une faute DIV/IDIV/AAM ne termine pas le bloc.** `cpu.div*` appelle `swInt(0)` qui ne *throw* pas ; le reste du bloc s'exécute et le `RET` final **écrase `cpu.eip`**, annulant l'interruption sur une pile qui contient déjà une frame IRET. | `recompiler.js:956-957`, `:706`, `cpu.js:226-242` | **Critique.** Tout invité avec un handler INT 0 (extenders DOS, protections, trappeurs d'erreur) déraille. `BOUND` (`:592`) le fait correctement — modèle à copier. |
| **T0.2** | **`66 98` / `66 99` décodent CBW/CWD au lieu de CWDE/CDQ** (`sz` n'est jamais lu). Longueur correcte → pas de désync, arithmétique fausse. | `recompiler.js:638-639` | **Critique.** `CDQ; IDIV ECX` est *l'*idiome de division signée 32 bits → quotients garbage. Le plus probable à être touché par du code 386. |
| **T0.3** | **`66 60/61` (PUSHAD/POPAD) et `66 9C/9D` (PUSHFD/POPFD) empilent 16 bits.** ✅ `C2/C3/CA/CB`, `9A`, `EA`, `E8/E9`, `FF /2 /3 /4` corrigés (test386.asm POST 5). Restent `8F`, `C9`, `CF`, PUSH/POP FS/GS, LES/LDS/LSS/LFS/LGS. | `recompiler.js:588-591,642-643,632,697,704,683-699` | **Élevé.** Désynchronise **la pile** (16 vs 32 octets) dès qu'on mélange avec un vrai push 32 bits ou un `RET`. |
| **T0.4** | **`0x67` n'est pas appliqué aux adressages implicites** : `REP MOVS/STOS/…` (ESI/EDI/ECX), `XLAT` (EBX), `LOOP/LOOPE/LOOPNE`, `JCXZ→JECXZ`. Le fix de `7e1e162` a fermé la désync (ModRM) mais **pas la moitié sémantique**. | `recompiler.js:974-1003,709,726-729` | **Élevé.** `67 F3 A4` (copie rapide 386 standard) utilise SI/DI/CX au lieu de ESI/EDI/ECX. |
| **T0.5** | **`BT/BTS/BTR/BTC` masquent l'offset de bit même en mémoire.** En mémoire x86 utilise l'offset **complet signé** pour adresser une chaîne de bits (`byte += bitofs>>3`). | `recompiler.js:1016-1023` | **Élevé.** Tout accès à un bitmap (allocateurs, masques de collision) retombe dans le premier mot. |
| **T0.6** | **XMS « move block » écrit dans `u8[]` sans check SMC.** Seul chemin d'écriture de la base qui contourne l'invalidation — et c'est *précisément* le chemin de swap-in d'overlays de code. | `xms.js:66` | **Élevé.** Des blocs compilés périmés s'exécutent. (Bonus : boucle octet-par-octet, `copyWithin` serait 10-50× plus rapide et gérerait le recouvrement ; pas de bornage.) |
| **T0.7** | **DAA/DAS** : seuil de haut-ajustement faux (`0x9f` appliqué à l'ancien AL) et DAS perd le borrow du nibble bas dans CF. | `cpu.js:247-258` | Moyen. Chaînes BCD multi-octets (scores, impression décimale). |
| **T0.8** | **`REP` non interruptible et compté 1 cycle.** `REP MOVSW` CX=0xFFFF fait 64 K accès en avançant `cpu.cycles` de 1 ; aucun tick PIT ni IRQ ne peut tomber au milieu. | `recompiler.js:974-1003` | Moyen (timing). Fausse le modèle PIT, affame les effets synchronisés IRQ/raster. |

Divers plus petits mais silencieux : `0F 20/21/22/23` consomment un disp sur `mod≠3` (désync sur
encodage non canonique) ; `FF /3`, `FF /5` avec `mod=3` produisent `sb[undefined]` → adresse `NaN` ;
`FE /2..7` décode DEC au lieu de #UD ; `FF /7` n'émet **rien** ; les accès mot/dword à cheval sur
0x9FFFF→0xA0000 contournent la logique planaire.

**Le reste de la table def/use des flags a été vérifié registre par registre et est correct** —
aucune sur-déclaration de `def` (la seule direction qui pourrait stripper un writer vivant).
Seul `BOUND` manque `cur.use |= lALL` (`recompiler.js:592`).

---

## Tier 1 — mensonges silencieux côté DOS/BIOS

| # | Défaut | Fichier | Effet |
|---|---|---|---|
| **T1.1** | **Toute INT non gérée retourne « succès ».** 9 vecteurs seulement ont un handler ; les autres reviennent **CF et registres inchangés**. ✅ INT 13h implémenté (`disk.js`) : un lecteur vide répond 80h « not ready ». INT 15h `AH=86` (attente) → retour instantané. INT 25h/26h → **désync de pile** (flags laissés). | `machine.js:123-132` | **Le pire de l'audit** : indétectable. Déjà accusé pour Lemmings dans `COMPAT.md`. |
| **T1.2** | **~23 fonctions INT 21h ne touchent jamais CF** (`AH=00,01,02,06,…,30,33,35,36,52,4D`). Le vrai DOS **efface** CF. Un `stc` du programme avant `int 21h` fait croire à un échec. | `dos.js:261-355` | Élevé, très bon marché à corriger. |
| **T1.3** | ✅ **CORRIGÉ.** **`machine.block()` était cassé sur le chemin far-call BIOS.** `biosCallback` dépile la frame IRET juste après, **écrasant le rewind** — l'attente clavier est perdue, `blocked` reste posé, AX jamais chargé. | `machine.js:114-121` vs `:231` | Élevé, silencieux. |
| **T1.4** | Gaps INT 21h notables : ✅ **`39/3A/3B`**, ✅ **`62h` Get PSP**, ✅ **`58h`** (stratégie d'allocation), ✅ **`34h`** (InDOS) ; `45/46` DUP ; `59h` erreur étendue ; **toute l'API FCB** ; ✅ périphériques caractère (`CON`/`NUL`/`PRN`/`AUX`/`LPTn`/`COMn`) implémentés. | `dos.js`, `vfs.js:105` | Un jeu qui crée un dossier `SAVE` abandonne. |
| **T1.5** | ✅ **`AH=44h` IOCTL ignore AL** → `AL=06/07` (statut entrée/sortie) répond toujours « succès, DX=0 » : cause classique de boucle infinie. ✅ **`AH=49h`** free réussit toujours (double-free non signalé). **find-first/next** = curseur global unique hors DTA, `CX` (masque d'attributs) ignoré. ✅ **PSP:0002** toujours 0xA000 au lieu du vrai sommet de bloc. | `dos.js:319,326,377-401,52` | Élevé. |
| **T1.6** | **XMS** : `AH=0Fh` realloc **écrase le bloc suivant** ; `AH=0Bh` move sans bornage ; désactivation A20 ment (retourne succès, laisse A20 actif). | `xms.js:85,66,42` | Élevé — WL6/PML passe par là. |
| **T1.7** | INT 16h `AH=02` renvoie **toujours AL=0** (aucun état Shift/Ctrl/Alt) alors que le chemin 8042 voit les make/break. INT 1Ah : seul `AH=00`. INT 33h ✅ désormais installé par `tools/harness.mjs` dans tous les harnais headless. | `bios.js:270-290`, `mouse.js` | Moyen. Shift-pour-courir ne marche jamais. |

---

## Tier 2 — vidéo : ce qui casse des classes entières de jeux

**Ce qui est juste, ne pas y toucher** : le pipeline d'écriture planaire EGA est **correct** —
les 4 write modes, l'ordre rotate → set/reset → ALU → bitmask, les latches, le map mask
(`vga.js:44-66`). Meilleur que beaucoup d'émulateurs jouets.

| # | Défaut | Fichier | Effet |
|---|---|---|---|
| **T2.1** | **La géométrie vient d'une table figée, pas des registres CRTC.** Seuls 0x0C/0x0D (start) et 0x13 (offset) sont consommés ; largeur/hauteur viennent de `DIMS` indexé par le n° de mode INT 10h. Le **Misc Output (0x3C2/0x3CC) n'existe pas du tout**. | `vga.js:9,104-110` | **Le Mode-X 320×240 est littéralement inatteignable** — *le* Mode X. 40 lignes coupées en bas sur chaque jeu Mode-X. Idem 320×400, 360×480. |
| **T2.2** | **Line compare / split screen totalement absent** (CRTC 0x18, 0x07 bit 4, 0x09 bit 6). | `video.js:72` | Toute barre de statut matérielle au-dessus d'un playfield qui scrolle : **Keen, Prince of Persia, Duke 1/2, Cosmo**, et l'idiome démo « split-screen scroller ». |
| **T2.3** | **Read mode 1 (colour compare) non implémenté** ; `gc[5]` bit 3, `gc[2]`, `gc[7]` stockés jamais lus. | `vga.js:70-75` | Masques de sprites et collisions EGA → garbage. La fonctionnalité GC manquante la plus utilisée. |
| **T2.4** | **ATC : seuls les 16 registres de palette existent.** Manquent 0x13 **pixel panning** (scroll fluide → sauts de 8 px), 0x14 **Colour Select** (bits hauts DAC → fades rapides sans effet), 0x10 mode control (blink), 0x12 plane enable, 0x11 overscan. **Port 0x3C1 (lecture ATC) non enregistré → 0xFF** : un save/restore détruit la palette. | `vga.js:97-100` | Élevé. |
| **T2.5** | **Mode texte câblé en dur 80×25×8×16, page 0, blink masqué.** 40 colonnes rendues en 80 ; **pages jamais commutées** (AH=05 stocke, le renderer lit toujours B800) ; **bit 7 d'attribut masqué** → aucun clignotement *et* aucun fond clair ; 43/50 lignes impossibles. Mode 7 (MDA) invisible, et une boucle de retrace sur 0x3BA **boucle à l'infini** (port non enregistré → 0xFF). | `video.js:8,86-114,94` | Élevé et très visible. |
| **T2.6** | **INT 10h `AH=0Ch`/`0Dh` (write/read pixel) absents**, avalés par `default:`. | `bios.js:146-266` | Écran graphique **entièrement vide**, sans erreur, pour tout programme qui trace via le BIOS. |
| **T2.7** | **Aucun texte en mode graphique EGA/VGA.** `teletype` ne gère que les modes CGA 4/5/6 ; en 0Dh/12h/13h il écrit des cellules char/attr dans B800 que rien ne rend. | `bios.js:121-138` | Tout « Loading… », bandeau ou message d'erreur d'un jeu graphique est **invisible**. |
| **T2.8** | **Pas de blanking horizontal** : le bit 0 de 0x3DA n'est posé que pendant les 12 % de vblank, au lieu de ~20 % de **chacune** des 449 lignes. | `bios.js:337-345` | Casse tous les effets raster par scanline (copper bars, palette mid-frame, wobble). Casse-démo de premier ordre. |
| **T2.9** | **Le CRTC n'est pas réinitialisé au changement de mode** → la géométrie d'un mode fuit dans le suivant (image cisaillée/décalée après un aller-retour Mode-X → 13h). | `vga.js:30-37` | Tout programme qui change de mode plus d'une fois. |
| **T2.10** | **Séquenceur : seuls les regs 2 et 4.** Manquent reg 0 (reset), reg 1 (**bit 5 = screen off**, très utilisé), reg 3 (char map select). Les lectures d'index ≠2/4 renvoient `0` au lieu de l'état → save/restore corrompt. **DAC** : un seul latch partagé lecture/écriture → les fades read-modify-write désynchronisent les canaux ; 0x3C7 et 0x3C6 sont des stubs. | `vga.js:78-88`, `bios.js:297-310` | Moyen. |

---

## Tier 3 — performance & maintenance

- **Bus de ports = `Map` sur le chemin chaud** (`machine.js:147-150`). `IN AL,0x3DA` est **l'accès port le plus chaud du jeu DOS** (chaque boucle vsync), et paie `Map.get` + appel mégamorphique (39 handlers) + deux ternaires. Le cache de blocs a déjà été sorti de `Map` pour cette raison exacte (`recompiler.js:63-66`) ; le bus de ports ne l'a jamais été. → tableau plat + `ioRead8/16/32` spécialisés (la taille est connue à l'émission).
- **`invalidate` SMC est O(blocs de la page)** par écriture ; combiné au chemin TF qui **recompile à chaque instruction**, c'est le pire profil du moteur (Lemmings : ~1593 écritures TF).
- **`translate()` fait 735 lignes** (68 % de `recompiler.js`), 4 `switch` imbriqués, ~25 helpers en closure. **Pas encore ingérable, mais à la limite** — à découper au moment où DPMI/mode protégé le forcera, pas avant.
- **Le parseur MZ-EXE existe 3× à l'identique** (`dos.js:121/193/230`) — et le fix `e_maxalloc` (`98c25f0`) n'a été appliqué qu'à **une** copie : la dérive a déjà eu lieu.
- **Docs contradictoires** : `DEVICES.md:44` et `COMPAT.md:188` affirment « pas de XMS » alors que `xms.js` est livré ; table LOC d'`ARCHITECTURE.md` périmée partout ; `TESTING.md` dit « 72 cas » contre **83** réels.

---

## Plan d'actions

### Quick wins (petits, cadrés, gain net) — dans cet ordre

| # | Action | Où | Effort |
|---|---|---|---|
| 1 | **Compter/journaliser les INT non gérées + poser CF** dans `swInt` | `machine.js:128` | ~5 l. |
| 2 | **`66 98/99` → CWDE/CDQ** | `recompiler.js:638` | ~4 l. |
| 3 | **Terminer le bloc sur faute DIV/IDIV/AAM** (modèle `BOUND`) | `recompiler.js:956` | ~6 l. |
| 4 | **Effacer CF en tête du dispatch INT 21h** | `dos.js:261` | ~2 l. |
| 5 | **`0x67` sur string ops / XLAT / LOOP / JCXZ** | `recompiler.js:974,709,726` | ~20 l. |
| 6 | **PUSHAD/POPAD/PUSHFD/POPFD 32 bits** sous `0x66` | `recompiler.js:588,642` | ~15 l. |
| 7 | **INT 10h `AH=0Ch/0Dh`** + **`AH=10h AL=17h`** (lecture DAC) | `bios.js:265,217` | ~25 l. |
| 8 | **Blink/intensité texte** : cesser de masquer le bit 7 | `video.js:94` | ~5 l. |
| 9 | **Curseur : masquer + forme** (AH=01, CRTC 0x0A/0x0B) | `bios.js:172`, `video.js:104` | ~10 l. |
| 10 | ✅ **INT 21h `39/3A/3B`** (mkdir/rmdir/chdir) + `vfs.rmdir()` (il manquait) ; corrige aussi `RD` du shell | `dos.js`, `vfs.js`, `shell.js` | fait |
| 11 | **Réinitialiser `vga.crtc` au changement de mode** | `vga.js:30` | ~5 l. |
| 12 | **Read mode 1** (colour compare) | `vga.js:70` | ~8 l. |
| 13 | ✅ **XMS : `copyWithin` + bornage (0Bh), rejet du realloc chevauchant (0Fh), check SMC** (`mem.move()`) | `xms.js`, `memory.js` | fait |
| 14 | **Alias/stubs de ports** : 0x3BA (miroir 0x3DA — convertit un **hang** en sortie correcte), 0x3C1, 0x3CC, 0x3C7, 0x3C6 réel | `bios.js`, `vga.js` | ~10 l. |
| 15 | **Latches DAC lecture/écriture séparés** | `bios.js:297` | 1 l. |
| 16 | ✅ **Déduplication du parseur MZ** (`parseMZ()`) + dimensionnement du bloc de l'enfant EXEC | `dos.js` | fait |
| 17 | ✅ **Bus de ports : tableau plat** (gain micro réel, débit global inchangé — mesuré) | `machine.js` | fait |
| 18 | **Corriger les docs** (XMS, table LOC, compte de tests) | `docs/` | — |

### Gros chantiers (par risque/impact)

1. **Suite de tests DOS/BIOS** (`tools/test-dos-api.js`) + **empreinte du mode texte dans `golden.js`**.
   **C'est le prérequis de tout le reste** : sans elle, `dos.js`/`vfs.js`/`xms.js`/`bios.js` restent
   non testés et chaque correctif ci-dessus peut pourrir en silence.
2. **Géométrie dérivée du CRTC + Misc Output** → débloque **Mode-X 320×240** (le plus gros manque
   vidéo), 320×400, les modes texte tweakés.
3. **Line compare / split screen** + **pixel panning** → Keen, PoP, Duke, scrollers de démo.
4. **INT 13h + image disque virtuelle** → Lemmings et tout titre sur disquette ; supprime le
   no-op silencieux le plus dangereux.
5. **Allocateur MCB réel** (first-fit + coalescing + `AH=49h` validant + PSP:0002) → règle la fuite
   sur free non-LIFO et le chevauchement `4Ah`.
6. **Modèle de faisceau par scanline** (hblank) → effets raster.
7. **Flexibilité du mode texte** (40 colonnes, pages, fonts 8×8/8×14, 43/50 lignes, mode 7).
8. **Découpage de `translate()`** — à faire *au début* du chantier DPMI, pas isolément.

### Recommandation

Faire les quick wins **1 à 6 d'abord** : ce sont exactement la classe `0x67` (faux silencieux,
CPU, quelques lignes chacun), et **#1 rend visible** tout ce que l'audit n'a pas pu atteindre.
Puis le **chantier #1 (tests DOS/BIOS)** avant d'attaquer le reste, sinon on empile des correctifs
non gardés.
