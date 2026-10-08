# Examples

The programs on the home page (`index.html`), listed in `manifest.json`.

- `demos/` (one level up) holds the demos written for MIRAGE, under its MIT licence.
- `boot/` holds boot-sector programs by other authors, each redistributed under its own free licence,
  whose text is in `licenses/`:

| File | Program | Author | Licence | Source |
|---|---|---|---|---|
| `boot/tetros.img` | TetrOS | Daniel Etzold | MIT | https://github.com/daniel-e/tetros |
| `boot/floppybird.img` | Floppy Bird | Mihail Szabolcs | MIT | https://github.com/icebreaker/floppybird |
| `boot/bootrogue.img` | bootRogue | Oscar Toledo G. | BSD-2-Clause | https://github.com/nanochess/bootRogue |
| `boot/bootbasic.img` | bootBASIC | Oscar Toledo G. | BSD-2-Clause | https://github.com/nanochess/bootBASIC |
| `boot/sectorlisp.img` | SectorLISP | Justine Tunney, Alain Greppin | ISC | https://github.com/jart/sectorlisp |
| `boot/sectorforth.img` | sectorforth | Cesar Blum | MIT | https://github.com/cesarblum/sectorforth |

The binaries are the ones v86's catalogue serves for the same programs.

- `thumbs/` are screenshots taken by MIRAGE: `node tools/demo-thumbs.mjs` regenerates them from the
  manifest.

A new example must be redistributable: written for MIRAGE, or published by its author under a
licence that allows it, with the licence text added to `licenses/`.
