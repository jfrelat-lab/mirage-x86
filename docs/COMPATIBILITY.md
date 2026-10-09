# MIRAGE — Compatibility

What has been run on MIRAGE and how far it got. None of this software is in the repository.

**How to read the tables**

| Status | Meaning |
|---|---|
| **Plays** | interactive and working as far as it was exercised (a level, a demo loop, a shell) |
| **Renders** | reaches and correctly draws the screen named in the notes; not played further |
| **Starts** | runs, but stops short of its main screen for the reason given |
| **Fails** | does not get there; see [KNOWN-ISSUES.md](KNOWN-ISSUES.md) when the cause is known |
| **Unknown** | the last result predates a change that probably affects it |

**Updated** is the date the entry was last edited, **not** a guarantee that it was re-run that day.
Entries from July and August 2026 predate the DPMI host, EMS, the real 8259 and the IDE controller;
most have not been re-run since. The stories behind many entries — how a title was unblocked, what
was wrong — are in [notes/](notes/README.md), chiefly [notes/compat-log.md](notes/compat-log.md).

---

## Operating systems (the bare PC, `boot.html`)

Images are v86's pre-installed disks unless marked *official media*. "Options" are what the image
needs beyond the defaults (16 MiB, the `386` profile, no PCI).

| System | Status | Reaches | Options | Updated |
|---|---|---|---|---|
| Windows 3.0, real mode (`win /r`) | Plays | Program Manager | — | 2026-09-15 |
| Windows 3.0, standard mode, on MIRAGE's built-in DOS | Unknown | last result: "Cannot load Windows in standard mode" | — | 2026-09-15 |
| Windows 3.0, 386 enhanced mode | Plays | Program Manager | — | 2026-09-29 |
| Windows 3.1, standard mode | Plays | Program Manager at 1024×768×256, pixel-identical to QEMU | — | 2026-09-22 |
| Windows 95 | Plays | the desktop (1024×768×8) | 64 MiB, `586` | 2026-10 |
| Windows 98 | Plays | the desktop | 64 MiB, `586` | 2026-10-07 |
| Windows ME | Plays | the desktop, after ScanDisk | 128 MiB, `586` | 2026-10 |
| Windows NT 3.51 | Fails | the graphical switch, then a stop error | 64 MiB, `586`, PCI | 2026-10-01 |
| Windows 2000 | Fails | its boot screen, progress bar empty | 256 MiB, `pentiumpro`, PCI | 2026-10-07 |
| MS-DOS 6.22 | Plays | the prompt; DOOM under EMM386 | — | 2026-09-28 |
| FreeDOS 1.4 (floppy) | Plays | the prompt, with HimemX | — | 2026-09 |
| FreeDOS 1.3, Legacy CD (*official media*) | Starts | the installer's language menu; not installed | — | 2026-10-04 |
| PC-MOS/386 | Starts | the date prompt | — | 2026-09 |
| Linux 2.2 (BasicLinux 3.5) | Plays | a shell; mounts a CD-ROM | `586` | 2026-10-07 |
| Linux 2.4 (Damn Small Linux 4.4.10 CD, *official media*) | Starts | runlevel 5; the desktop was not seen | 64 MiB, `586` | 2026-10-04 |
| ELKS | Plays | `login:` | — | 2026-09 |
| Unix V7/x86 | Plays | a single-user shell | — | 2026-09 |
| 386BSD 1.0 | Plays | `login:`, and a single-user shell | — | 2026-09 |
| NetBSD 4.0.1 | Plays | a root shell, multi-user | 256 MiB, `pentium` | 2026-09 |
| OpenBSD | Starts | `login:` (the image's password is not known) | 128 MiB, `586` | 2026-09 |
| QNX 4.05 demo disk | Starts | the welcome screen; stops asking for a network card | — | 2026-10 |
| KolibriOS | Plays | the desktop | `586` | 2026-09 |
| GentleOS/16 | Renders | its screen, pixel-identical to QEMU | — | 2026-09 |
| XCOM (a small graphical OS) | Renders | the desktop | — | 2026-09 |
| BeOS 5 | Fails | the splash screen | 128 MiB, `586`, PCI | 2026-10-04 |
| ReactOS 0.4.15 | Fails | a stop in the kernel: it needs ACPI | 256 MiB, `pentiumpro`, PCI | 2026-10-07 |
| Plan 9 (9legacy) | Fails | the loader starts the kernel, which then stops | PCI | 2026-10 |
| Haiku | Unknown | not tried | — | — |

Boot-sector programs — BootChess, bootBASIC, bootOS, Invaders, Pillman, sectorFORTH, sectorLISP,
TetrOS, Floppy Bird and the like — run; several were compared pixel for pixel with QEMU.

## DOS games (the DOS player, `dos.html`)

| Title | Video | Status | Notes | Updated |
|---|---|---|---|---|
| DOOM (id, 1993) | VGA 13h | Plays | attract demo with the status bar; with our DPMI host or its own DOS/4G | 2026-09-09 |
| Heretic | VGA 13h | Plays | needs our DPMI host; its own extender faults without it | 2026-09-09 |
| Quake | VGA 13h | Plays | `-nocdaudio`; demo1 with the full HUD | 2026-09 |
| Wolfenstein 3D (shareware and registered) | Mode X | Plays | signon, attract loop, a played demo | 2026-09-09 |
| Alley Cat | CGA | Plays | title, menus, the alley | 2026-07-29 |
| Blues Brothers | EGA | Plays | a level, timer-paced | 2026-08-01 |
| Pitman | text | Plays | title, menu, level 1 | 2026-08-28 |
| Dune (Cryo) | VGA 13h | Renders | the animated intro, in the `HIM 386` path too | 2026-08-25 |
| Commander Keen 1 | EGA | Renders | high scores; file and video events identical to DOSBox-X | 2026-08-18 |
| Commander Keen 3, 4 | EGA | Renders | Apogee logo; main menu | 2026-07-31 |
| Cosmo's Cosmic Adventure | EGA | Renders | attract mode | 2026-07-20 |
| Bio Menace | EGA | Renders | | 2026-07-20 |
| Duke Nukem 1 | EGA | Renders | credits | 2026-07-31 |
| Crystal Caves | EGA | Renders | main menu | 2026-08-01 |
| Secret Agent | EGA | Renders | title | 2026-08-01 |
| Monster Bash | EGA | Renders | notice screen | 2026-08-01 |
| Dark Ages | EGA | Renders | main menu | 2026-08-01 |
| Word Rescue, Math Rescue | EGA | Renders | credits; intro | 2026-08-01 |
| Dangerous Dave in the Haunted Mansion | EGA | Renders | gameplay | 2026-08-01 |
| Prehistorik | EGA | Renders | title and intro, correct palette | 2026-07-31 |
| Baby Jo | EGA | Renders | language select (`BABY 2`) | 2026-08-01 |
| Maniac Mansion (enhanced) | EGA | Renders | title and character select | 2026-08-01 |
| The Secret of Monkey Island (EGA) | EGA | Renders | title | 2026-08-22 |
| Monkey Island 2 | VGA 13h | Renders | the copy-protection screen | 2026-08-22 |
| Indiana Jones and the Last Crusade | EGA | Renders | the copy-protection screen | 2026-08-01 |
| Loom | EGA | Renders | proficiency menu | 2026-08-01 |
| Prince of Persia | VGA 13h | Renders | title | 2026-07-31 |
| Major Stryker, Hocus Pocus, Jill of the Jungle | VGA 13h | Renders | title | 2026-07-20 |
| God of Thunder | VGA 13h | Renders | intro logo | 2026-07-20 |
| Realms of Chaos | Mode X | Renders | title; uses XMS | 2026-09-22 |
| Moktar (Titus) | VGA 13h | Renders | title; a launcher that EXECs the game | 2026-09-22 |
| Arctic Adventure | CGA | Renders | the map screen | 2026-09-22 |
| Digger, Lode Runner | CGA | Renders | title; gameplay | 2026-08-01 |
| Mars (Tim Clarke) | VGA 13h | Renders | steers with the mouse | 2026-08 |
| Fractint 20.0 | VGA 13h | Plays | menus, draws and zooms the Mandelbrot set; needs the AH=58h last-fit strategy | 2026-10-09 |
| Unreal 1.1 (Future Crew) | VGA 13h | Renders | sound menu (No sound), logos, the scroller part; needed MCBs in front of AH=48h blocks and extended keys through AH=08h | 2026-10-09 |
| Dune, the 1991 playable demo (Cryo) | VGA 13h | Renders | the logos and the intro, from its ZIP in the browser | 2026-10-09 |
| Jump 'n Bump | VGA 13h | Fails | #GP in the DPMI client (47:1BDC9) before the title | 2026-10-09 |
| Second Reality (Future Crew) | — | Fails | derails to 0000:0000 at start | 2026-10-09 |
| Stash (The Black Lotus, 64K) | VESA 320×200×16 | Starts | sets its mode, draws nothing in 30 s | 2026-10-09 |
| Lemmings | VGA/EGA | Starts | the trap-flag decryption works; then wants a raw floppy | 2026-08-01 |
| Golden Axe | — | Starts | its video menu; not driven past it headless | 2026-08-01 |
| Arkanoid | — | Starts | its video menu; no key was accepted | 2026-08-01 |
| Paganitzu | EGA | Starts | intro text and first menus | 2026-08-01 |
| Pinball Fantasies | Mode X | Starts | past its memory check | 2026-09-22 |
| Ski or Die | EGA | Starts | stalls in its own overlay loader | 2026-08-01 |
| Mystic Towers | VGA 13h | Starts | exits after the mouse reset; data incomplete | 2026-08-01 |
| QBasic | text | Starts | the IDE, after a long first compile | 2026-07-20 |
| Turbo Pascal 7.1 | text | Starts | banner, then runs on; not confirmed to reach the IDE | 2026-08-19 |
| Halloween Harry | text | Fails | the launcher exits without setting a mode | 2026-07-20 |
| Raptor, Jazz Jackrabbit, One Must Fall 2097, Zone 66 | — | Unknown | failed for want of a DPMI host; not re-run since there is one | 2026-08-01 |

## Intros and demos

31 of the 32 intros in the corpus rendered when it was last swept (2026-08-22); the exception,
`oktaeder`, drives PCI hardware directly and derails on the reference emulator too. 21 are pinned
by the golden test. Of pouët's top ten MS-DOS 4K intros, nine rendered (2026-08-28).

| Title | Status | Notes | Updated |
|---|---|---|---|
| tube, memories, kaneda, lattice, puls, and the other 256-byte intros of the golden set | Renders | fingerprinted by `tools/golden.js` | 2026-10-04 |
| Chrome Revenge (1K, SSE raytracer, VESA 640×480×32) | Renders | | 2026-09 |
| qblove (1K) | Renders | checked against the author's screenshot | 2026-09 |
| Mirrors Within (512b) | Renders | 82 % pixel agreement with DOSBox-X | 2026-08 |
| Heaven (NoooN) | Renders | not checked frame-exact | 2026-08-06 |
| Helium | Renders | a finite intro: it exits by itself | 2026-08-05 |
| Mesha | Renders | also under a booted FreeDOS with a real XMS driver | 2026-09-05 |
| Juggler 2001 | Renders | after the keypress it asks for | 2026-08-28 |
| Omniscent, Forever Reality, StarPort BBS 2, Another Soul Lost | Renders | | 2026-08-28 |
| Void 3 | Starts | sets its VESA mode, then hangs in its timer handler | 2026-08-28 |
| Difúze (Řrřola) | Fails | horizontal bands instead of diffusion patterns, against QEMU and DOSBox-X | 2026-10-09 |
| oktaeder | Fails | not a MIRAGE defect — see above | 2026-08-22 |

## The CPU

| Check | Result | Updated |
|---|---|---|
| test386 (the 80386 self-test) | passes, to POST FFh | 2026-10 |
| SingleStepTests, 8088 vectors | 423,736 vectors pass | 2026-07 |
| Unicorn comparison (`tools/test-x86-uc.mjs`) | all green | 2026-10-08 |
