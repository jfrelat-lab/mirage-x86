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
| `games/1wolf14.zip` | Wolfenstein 3D 1.4, shareware | id Software, published by Apogee | shareware: "Everyone can … copy, upload and generally pass around this Program without charging for it", complete and unmodified, "Apogee" in the description | `licenses/wolf3d.txt` (VENDOR.DOC) |
| `games/1keen.zip` | Commander Keen 1 1.31, shareware | id Software, licensed to Apogee | the same Apogee VENDOR.DOC terms | `licenses/keen1.txt` |
| `games/4keen.zip` | Commander Keen 4 1.4, shareware | id Software, licensed to Apogee | the same Apogee VENDOR.DOC terms | `licenses/keen4.txt` |
| `games/cdogs106.zip` | C-Dogs 1.06 | Ronny Wester | freeware: "All files must be distributed unmodified", "no charge" | `licenses/cdogs.txt`, README.TXT in the archive |

The two id archives are the files of id's own `idstuff` directory, as the idgames archive serves
them (ftp.fu-berlin.de/pc/games/idgames/idstuff/). They hold an installer, not the game: DEICE.EXE
and a self-extracting ZIP cut into NAME.1 and NAME.2. The player joins the pieces and reads the ZIP
inside (`deice` in src/zip.js), which is what DEICE does, so the archives are served unmodified.
`games/doom/DEFAULT.CFG` and `games/heretic/HERETIC.CFG` are ours (MIT): the setup each game's
SETUP.EXE would write for a Sound Blaster at 220h, IRQ 7, DMA 1, music and effects. A manifest
entry's `add` lists them, and the player puts them next to the unpacked game (`dos.html?add=`).
Without one the games start silent.
`games/cdogs/SOUND.CFG` is ours too: what C-Dogs' own DSETUP32.EXE writes for a Sound Blaster 16 at
220h, IRQ 7, DMA 5, 22 kHz stereo. Its README says some of the sound effects were borrowed from other
games; they are served as part of the author's unmodified archive.
The three Apogee archives are 3D Realms' own (ftp.3drealms.com/share/, through the mirror at
ftpmirror1.infania.net/pub/3drealms/share/). They hold Apogee's INSTALL.EXE and one NAME.SHR, files
compressed by the PKWARE Data Compression Library; the player unpacks the .SHR beside the installer
(`unshr` in src/zip.js), which is what INSTALL does, so these too are served unmodified.
Quake's shareware is not here: its licence forbids displaying it publicly and any use of its
screenshots.

`boot/freedos.img.gz` is a FreeDOS 1.4 hard disk that `node tools/mkfreedos.mjs <packages> <out>` builds,
the same bytes every time, from 24 packages of the FreeDOS 1.4 repository, unmodified and pinned by
SHA-256; `licenses/freedos.txt` lists each with its licence (GPL v2 for most, MIT, BSD) and where its
source is. boot.html inflates it in the browser.

The binaries of the boot-sector programs are the ones v86's catalogue serves for the same programs; BootChess comes with its
author's release text.

- `linux/` holds Linux intros by The Orz (grz, Julien Verneuil), static i386 binaries taken unchanged
  from the author's repositories, under their BSD 3-Clause licence:

| File | Intro | Year | Licence text | Source |
|---|---|---|---|---|
| `linux/Apollonian_1920x1080x32`, `CalculatingSpace_…`, `Campers_…`, `QuasiSpace_…` | Apollonian, Calculating Space, Campers, QuasiSpace | 2021 | `licenses/codegolfing-bsd3.txt` | https://github.com/grz0zrg/codegolfing |
| `linux/Crimson_…`, `Mmrnmhrm_…`, `Zeta_…` | Crimson, Mmrnmhrm, Zeta | 2022 | `licenses/codegolfing-bsd3.txt` | same |
| `linux/the_light_1920x1080x32` | The light | 2023 | `licenses/codegolfing-bsd3.txt` | same |
| `linux/flagship_1920x1080x32` | Flagship | 2021 | `licenses/flagship-bsd3.txt` | https://github.com/grz0zrg/Flagship |

Three Linux entries of the manifest (Blin Elfom, pattern, attraction & decay) state no licence: they
are not in this repository, and the page fetches them from their authors' own sites when they are run.

- `thumbs/` are screenshots taken by MIRAGE: `node tools/demo-thumbs.mjs` regenerates them from the
  manifest.

A new example must be redistributable: written for MIRAGE, or published by its author under a
licence that allows it, with the licence text added to `licenses/`.
