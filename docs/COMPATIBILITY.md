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
| Linux 2.4 (Damn Small Linux 4.4.10 CD, *official media*) | Starts | runlevel 5, then a black screen and an idle CPU (X starting? not seen) after 900 guest s | 64 MiB, `586` | 2026-10-15 |
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
| Haiku | Starts | its boot splash with all seven icons lit (Enter at the Boot Manager), then no desktop after 900 guest s | 256 MiB, `pentiumpro`, PCI | 2026-10-15 |
| MikeOS 4.7 | Plays | its interface chooser (program menu or command line) | — | 2026-10-15 |
| MS-DOS 4 (floppy) | Plays | the date and time prompts | — | 2026-10-15 |
| FreeNOS 1.0.3 | Plays | its system information and a shell; its timer reads "0 ticks" | 256 MiB, `686` | 2026-10-15 |
| xwoaf (Linux, X11 on a floppy-sized CD) | Starts | the keyboard chooser before `login:` | 256 MiB | 2026-10-15 |
| Oberon | Starts | "OBERON loading…", then nothing | 64 MiB | 2026-10-15 |
| Linux 3.x (v86's mini CD) | Starts | the kernel boots, then waits for a virtio 9p root (v86's own) | 128 MiB, `686` | 2026-10-15 |
| Linux 2.6 (v86's mini CD) | Fails | ISOLINUX: "Booting kernel failed: Invalid argument" | 128 MiB, `686` | 2026-10-15 |
| TinyCore 11 | Starts | "Loading extensions…", udev killing slow modprobes, after 900 guest s | 256 MiB, `686` | 2026-10-15 |
| SliTaz rolling 2024 | Fails | a kernel panic, page fault in an interrupt (`__queue_work`) | 512 MiB, `686` | 2026-10-15 |
| HelenOS 0.14.1 | Starts | the SPARTAN kernel boots and starts its services (ns, locsrv, rd, vfs, logger, ext4fs); rd and ns then die on a user-mode page fault at the same kernel address, 80167F55h | 256 MiB, `686` (or `586`) | 2026-10-15 |
| Sortix 1.0 | Starts | GRUB loading its 5 MB initrd, unfinished after 600 guest s | 512 MiB, `686` | 2026-10-15 |
| ToaruOS 1.6.1 | Starts | its bootloader menu; Enter is not taken | 512 MiB, `686` | 2026-10-15 |
| Tilck | Fails | its bootloader and kernel start (800x600x32 console), then a kernel panic on a #GP in kmain | 128 MiB, `686` | 2026-10-15 |

Boot-sector programs — BootChess, bootBASIC, bootOS, Invaders, Pillman, sectorFORTH, sectorLISP,
TetrOS, Floppy Bird and the like — run; several were compared pixel for pixel with QEMU.

## DOS games (the DOS player, `dos.html`)

| Title | Video | Status | Notes | Updated |
|---|---|---|---|---|
| DOOM (id, 1993) | VGA 13h | Plays | attract demo with the status bar; with our DPMI host or its own DOS/4G | 2026-09-09 |
| Heretic | VGA 13h | Plays | needs our DPMI host; its own extender faults without it | 2026-09-09 |
| Quake | VGA 13h | Plays | `-nocdaudio`; demo1 with the full HUD. Broken from 2026-09-23 (segment limits enforced) to 2026-10-10 (INT 31h reloads SS) | 2026-10-10 |
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
| Unreal 1.1 (Future Crew) | VGA 13h | Renders | sound menu, logos, the scroller part, at its own speed in the browser (it times a frame with PIT counter 0, which now counts in real time there, and waits on every retrace: 64 to 67 a second seen); needed MCBs in front of AH=48h blocks and extended keys through AH=08h | 2026-11-02 |
| Dune, the 1991 playable demo (Cryo) | VGA 13h | Renders | the logos and the intro, from its ZIP in the browser | 2026-10-09 |
| Jump 'n Bump | Mode X | Renders | the title screen; needed INT 31h to reload DS after DJGPP's crt0 widens it to 4 GiB | 2026-10-10 |
| Second Reality (Future Crew) | — | Fails | derails to 0000:0000 at start | 2026-10-09 |
| Stash (The Black Lotus, 64K) | VESA 320×200×16 | Plays | progress bar while it precomputes (3.3 billion instructions, about 30 s), then the whole intro to its end text; needed 12 MiB of XMS in one block | 2026-10-10 |
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
| Void 3 | Renders | in the DOS player's 16 MiB (its 16 MiB DPMI block now fits): answer `2` and `1` to its SB questions; it precomputes its music, then plays. Its synthesis wants ~30 M instructions a second: headless that is `MIRAGE_PITRELOAD=1800000`, the browser measured 73 M. `?mem=` gives a program more RAM when one needs it. Needed DMA playback and the DPMI locked stack | 2026-10-11 |
| C-Dogs 1.06 | Plays | DOS/4GW 1.97 on MIRAGE's DPMI host, Sound Blaster 16 effects (SOUND.CFG from its DSETUP32). Needed selector 0040h in the host's GDT, a waiting INT 16h reached through a client's chain, and E0-prefixed arrow keys | 2026-10-12 |
| Difúze (Řrřola) | Renders | the reaction–diffusion patterns, after a few hundred frames; identical to Unicorn for 300 frames ([notes/2026-10-10-difuze.md](notes/2026-10-10-difuze.md)) | 2026-10-10 |
| oktaeder | Fails | not a MIRAGE defect — see above | 2026-08-22 |

## Windows programs (MIRAGE-WIN32, `machines.html?m=win32`)

The scene's Windows intros of 2007-2017, run with no Windows: the `.exe` mapped as Windows XP maps it,
every DLL in JavaScript, the graphics drawn by PRISM's `gl.js` (OpenGL) or `d3d9.js` (Direct3D 9).
The ones that render are OASIS images (`oasis/images/win32/`). "Headless" is a run in Node on the
recording device model, which says how far the program gets but not what it draws.

| Title | API | Status | Notes | Updated |
|---|---|---|---|---|
| To the Road of Ribbon, Flow2, Chocolux (1K) | OpenGL | Renders | one GLSL fragment shader each | 2026-10 |
| Retrospection, Paradistance (4K) | OpenGL | Renders | with their music through waveOut | 2026-10 |
| Hartverdrahtet (4K, Revision 2012) | OpenGL | Renders | framebuffer objects; music from a thread | 2026-10 |
| Absolute Territory (4K, Revision 2017) | OpenGL | Renders | 38 ms of fragment shader a frame on an M1 | 2026-10 |
| cdak (4K, Chaos Constructions 2010) | Direct3D 9 | Renders | 60 frames a second in Chrome: HLSL pixel shaders, render targets ping-ponged, a looped waveOut buffer | 2026-10-31 |
| yes we can (4K, Chaos Constructions 2009) | Direct3D 9 | Renders | 60 frames a second in Chrome: pixel shaders on one pre-transformed triangle, a float16 render target | 2026-10-31 |
| Photon Race 2 (4K, NVScene 2008) | Direct3D 9 | Renders | in Chrome after a few seconds of precalculation: HLSL vertex and pixel shaders, four float16 render targets at once, 192 passes a frame | 2026-10-31 |
| Elevated (4K, Breakpoint 2009) | Direct3D 9 | Renders | the mountains in Chrome after 1½ minutes of precalculation (24 G instructions: its height map through `D3DXFillTexture`, then its music): a quad cut by `D3DXTessellateNPatches` into a million triangles raised by a vertex shader, the camera read back from a render target each frame | 2026-11-01 |
| Atrium (4K, Breakpoint 2008) | Direct3D 9 | Starts | still precomputing after 3 G instructions, its device created | 2026-10-31 |
| Darwinism | Direct3D 9 | Starts | presents headless at about one frame a second: some 180 M x87 instructions a frame on one emulated core | 2026-10-31 |
| Wishful Twisting | Direct3D 9 | Starts | still precomputing after 1.5 G instructions, before its first frame | 2026-10-31 |
| Ergon | Direct3D 9 | Starts | presents headless; its `tx_1_0` texture shader (HLSL's `noise()`) is handed to PRISM's `d3d9.js`, which does not evaluate texture shaders yet | 2026-11-01 |
| Stiletto | Direct3D 9 | Starts | its skinned mesh and its nine Tahoma words (`D3DXCreateTextA`, from the visitor's Tahoma or DejaVu Sans) are made and it presents headless; it draws with the fixed function (lights, material, no shader), which PRISM's `d3d9.js` does not have yet | 2026-11-01 |
| luxo4k | Direct3D 9 | Fails | shows a message box and exits: it needs DirectSound | 2026-10-31 |
| Polystreptikum, Synchroplastikum | Direct3D 9 | Fails | a page fault before the device is created; cause not looked at | 2026-10-31 |
| Valleyball, Stripped | OpenGL | Starts | Valleyball's synthesizer renders at 0.97 of real time in the page, just short of keeping up; Stripped precomputes for minutes | 2026-10 |

## The CPU

| Check | Result | Updated |
|---|---|---|
| test386 (the 80386 self-test) | passes, to POST FFh | 2026-10 |
| SingleStepTests, 8088 vectors | 423,736 vectors pass | 2026-07 |
| Unicorn comparison (`tools/test-x86-uc.mjs`) | all green | 2026-10-08 |
