# Examples

The programs on the home page (`index.html`), listed in `manifest.json`.

- `demos/` (one level up) holds the demos written for MIRAGE, under its MIT licence.
- `boot/` holds boot-sector programs by other authors, each redistributed under its own free licence,
  whose text is in `licenses/`:

| File | Program | Author | Licence | Source |
|---|---|---|---|---|
| `boot/tetros.img` | TetrOS | Daniel Etzold | MIT | https://github.com/daniel-e/tetros |
| `boot/floppybird.img` | Floppy Bird | Mihail Szabolcs | MIT | https://github.com/icebreaker/floppybird |
| `boot/bootchess.img` | BootChess | Olivier Poudade (Baudsurfer/RSi), with Peter Ferrie | WTFPL v2 | `boot/bootchess.txt` (the author's documentation, with the full source) |
| `boot/bootrogue.img` | bootRogue | Oscar Toledo G. | BSD-2-Clause | https://github.com/nanochess/bootRogue |
| `boot/bootbasic.img` | bootBASIC | Oscar Toledo G. | BSD-2-Clause | https://github.com/nanochess/bootBASIC |
| `boot/sectorlisp.img` | SectorLISP | Justine Tunney, Alain Greppin | ISC | https://github.com/jart/sectorlisp |
| `boot/sectorforth.img` | sectorforth | Cesar Blum | MIT | https://github.com/cesarblum/sectorforth |

- `intros/` holds demoscene intros whose authors release them under free licences, with their sources:

| File | Intro | Author | Licence | Where the licence is stated |
|---|---|---|---|---|
| `intros/helium.com` | Helium (4K, Assembly 1997) | viznut (ocsa) | CC0 1.0 | https://github.com/viznut/demoscene (the file is taken from that repository) |
| `intros/puls.com` | Puls (256 bytes, 2009) | Řrřola (Jan Kadlec) | ISC | http://rrrola.wz.cz/downloads.html and COPYING.txt (`licenses/rrrola-isc.txt`) |
| `intros/symetrie.com` | Symetrie (256 bytes, 2007) | Řrřola | ISC | same |
| `intros/dirojed.com` | Dírojed (32 bytes, 2007) | Řrřola | ISC | same |
| `intros/paralaxa.com` | Paralaxa (32 bytes, 2007) | Řrřola | ISC | same |
| `intros/difuze.com` | Difúze (256 bytes, 2010), the final version | Řrřola | ISC | same |

Řrřola's files come from the zips on his download page.

- `games/` holds DOS programs whose rights holders allow free distribution, as ZIP archives that the
  DOS player unpacks into C:\GAMES\ (`dos.html?zip=…&run=…`):

| File | Program | Rights holder | Terms | Text |
|---|---|---|---|---|
| `games/unreal11.zip` | Unreal 1.1 | Future Crew | freeware: "can be freely distributed without modifications" | `licenses/unreal.txt`, and README.1ST in the archive |
| `games/frain200.zip` | Fractint 20.0 (the official DOS release package) | The Stone Soup Group | freeware: "may be freely copied and distributed in unmodified form but may not be sold" | `licenses/fractint.txt` |
| `games/dunedemo.zip` | Dune, the 1991 demo | Cryo / Virgin Games | "may be given away freely, but it is not to be sold", unaltered | `licenses/dunedemo.txt`, and README.TXT in the archive |
| `games/htic_v12.zip` | Heretic 1.2, shareware | id Software (Raven Software) | shareware: "the right to distribute, royalty free and by electronic means only … in compressed format" | `licenses/heretic.txt`, LICENSE.DOC in the archive |
| `games/doom19s.zip` | DOOM 1.9, shareware | id Software | shareware; the archive has no licence agreement, only id's "SHAREWARE VERSION — PLEASE DISTRIBUTE!!!" | `licenses/doom.txt` |

The two id archives are the files of id's own `idstuff` directory, as the idgames archive serves
them (ftp.fu-berlin.de/pc/games/idgames/idstuff/). They hold an installer, not the game: DEICE.EXE
and a self-extracting ZIP cut into NAME.1 and NAME.2. The player joins the pieces and reads the ZIP
inside (`deice` in src/zip.js), which is what DEICE does, so the archives are served unmodified.
Quake's shareware is not here: its licence forbids displaying it publicly and any use of its
screenshots.

The binaries of the boot-sector programs are the ones v86's catalogue serves for the same programs; BootChess comes with its
author's release text.

- `thumbs/` are screenshots taken by MIRAGE: `node tools/demo-thumbs.mjs` regenerates them from the
  manifest.

A new example must be redistributable: written for MIRAGE, or published by its author under a
licence that allows it, with the licence text added to `licenses/`.
