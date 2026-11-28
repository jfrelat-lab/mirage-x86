# MIRAGE — Compatibility

What has been run on MIRAGE and how far it got. None of this software is in the repository; the
pictures beside each entry are MIRAGE's own captures of it (`docs/compat/`).

**How to read the tables**

| Status | Meaning |
|---|---|
| 🟢 **Plays** | interactive and working as far as it was exercised (a level, a demo loop, a shell) |
| 🟢 **Renders** | reaches and correctly draws the screen named in the notes; not played further |
| 🟠 **Starts** | runs, but stops short of its main screen for the reason given |
| 🔴 **Fails** | does not get there; see [KNOWN-ISSUES.md](KNOWN-ISSUES.md) when the cause is known |
| 🟠 **Unknown** | the last result predates a change that probably affects it |

**Run** is the date the entry was last run. **2026-11-05 is a full sweep**: every title whose
files were at hand was run again that day — DOS games headless (`tools/shot.mjs`), systems headless
(`tools/v86/bootshot.mjs`), intros and the Windows and Linux machines in headless Chrome with its GPU.
An older date means the title was not re-run (its files were not at hand), and the result may be
stale. The stories behind many entries
are in [notes/](notes/README.md), chiefly [notes/compat-log.md](notes/compat-log.md).

---

## Operating systems (the bare PC, `boot.html`)

Images are v86's pre-installed disks unless marked *official media*. "Options" are what the image
needs beyond the defaults (16 MiB, the `386` profile, no PCI).

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | System | Status | Reaches | Options | Run |
|---|---|---|---|---|---|
| <img src="compat/win30.png" width="160" alt=""> | Windows 3.0, real mode (`win /r`, as `W30HD.IMG`'s AUTOEXEC.BAT starts it, on its MS-DOS 4) | 🟢 Plays | Program Manager | — | 2026-11-05 |
| <img src="compat/os-win30-std.png" width="160" alt=""> <img src="compat/os-win30-std-hle.png" width="160" alt=""> | Windows 3.0, standard mode (`win /s`) | 🟢 Plays | Program Manager, on `W30HD.IMG`'s MS-DOS 4 (left) and on MIRAGE's built-in DOS (`tools/win30.mjs /s`, right) | — | 2026-11-05 |
| <img src="compat/os-win30-386.png" width="160" alt=""> | Windows 3.0, 386 enhanced mode (`win /3`) | 🟢 Plays | Program Manager on `W30HD.IMG`'s MS-DOS 4, paging on, WIN386 at 0028:8000xxxx. On MIRAGE's built-in DOS it stops with "Cannot install the 386 enhanced mode Expanded Memory driver": its V86MMGR wants to take over a real HIMEM.SYS | — | 2026-11-05 |
| <img src="compat/win31.png" width="160" alt=""> | Windows 3.1, standard mode | 🟢 Plays | Program Manager at 1024×768×256, pixel-identical to QEMU | — | 2026-11-05 |
| <img src="compat/win95.png" width="160" alt=""> | Windows 95 | 🟢 Plays | the desktop (Enter at its three dialogs) | 64 MiB, `586` | 2026-11-05 |
| <img src="compat/win98.png" width="160" alt=""> | Windows 98 | 🟢 Plays | the desktop | 64 MiB, `586` | 2026-11-05 |
| <img src="compat/os-winme.png" width="160" alt=""> | Windows ME | 🟢 Plays | the desktop, after ScanDisk and its display settings (Esc at the hardware wizard) | 128 MiB, `586` | 2026-11-06 |
| <img src="compat/os-nt351.png" width="160" alt=""> | Windows NT 3.51 | 🟢 Plays | Program Manager (its welcome screen identical to QEMU `-M pc`'s; Ctrl+Alt+Del, empty password, Enter at the Service Control Manager and Invalid System Time messages) | 64 MiB, `586`, PCI | 2026-11-05 |
| <img src="compat/os-win2k.png" width="160" alt=""> | Windows 2000 | 🟢 Plays | the desktop, auto-logged on, asking to restart for its new devices — at 5 times the headless clock (`MIRAGE_PITRELOAD=912920`, `MIRAGE_RTC=hostdate`). At the default rate (3.3 M instructions a guest second) the boot screen's scrolling band takes 99 % of the processor and the boot does not move. Until 2026-11-06 its disk driver lost a read to a 128-head geometry, and a microcode update was a #GP | 256 MiB, `pentiumpro`, PCI | 2026-11-06 |
| <img src="compat/msdos622.png" width="160" alt=""> | MS-DOS 6.22 | 🟢 Plays | the prompt (DOOM under EMM386 last run 2026-09-28) | — | 2026-11-05 |
| <img src="compat/msdos4.png" width="160" alt=""> | MS-DOS 4 (floppy) | 🟢 Plays | the date and time prompts | — | 2026-11-05 |
| <img src="compat/freedos14.png" width="160" alt=""> | FreeDOS 1.4 (floppy) | 🟢 Plays | the installer's first question; the prompt, with HimemX, after `N` | — | 2026-11-05 |
| <img src="compat/os-fd13.png" width="160" alt=""> | FreeDOS 1.3, Legacy CD (*official media*) | 🟠 Starts | the installer's language menu; not installed | — | 2026-11-05 |
| <img src="compat/pcmos.png" width="160" alt=""> | PC-MOS/386 | 🟠 Starts | the date prompt | — | 2026-11-05 |
| <img src="compat/linux22.png" width="160" alt=""> | Linux 2.2 (BasicLinux 3.5) | 🟢 Plays | "Please press Enter to activate this console"; a shell, a CD-ROM mounted (2026-10-07) | `586` | 2026-11-05 |
| <img src="compat/os-dsl.png" width="160" alt=""> | Linux 2.4 (Damn Small Linux 4.4.10 CD, *official media*) | 🟠 Starts | runlevel 5, then a black screen and an idle CPU (X starting? not seen) after 900 guest s | 64 MiB, `586` | 2026-11-05 |
| <img src="compat/elks.png" width="160" alt=""> | ELKS | 🟢 Plays | `login:` | — | 2026-11-05 |
| <img src="compat/unixv7.png" width="160" alt=""> | Unix V7/x86 | 🟢 Plays | a single-user shell (Enter at `BOOT`) | — | 2026-11-05 |
| <img src="compat/386bsd.png" width="160" alt=""> | 386BSD 1.0 | 🟢 Renders | `login:` (Esc at its boot prompt) | — | 2026-11-06 |
| <img src="compat/netbsd.png" width="160" alt=""> | NetBSD 4.0.1 | 🟢 Plays | `login:`; a root shell, multi-user (2026-09) | 256 MiB, `pentium` | 2026-11-05 |
| <img src="compat/os-openbsd.png" width="160" alt=""> | OpenBSD | 🟠 Starts | `login:` at 900 guest s (the image's password is not known) | 128 MiB, `586` | 2026-11-06 |
| <img src="compat/qnx.png" width="160" alt=""> | QNX 4.05 demo disk | 🟠 Starts | the welcome screen; stops asking for a network card | — | 2026-11-05 |
| <img src="compat/kolibri.png" width="160" alt=""> | KolibriOS | 🟢 Plays | the desktop | `586` | 2026-11-05 |
| <img src="compat/gentleos.png" width="160" alt=""> | GentleOS/16 | 🟢 Renders | its screen, pixel-identical to QEMU | — | 2026-11-05 |
| | XCOM (a small graphical OS, `xcom144.img`) | 🟠 Starts | boots through its FreeDOS and HDPMI32 to a 640×480 screen that draws as noise, as on 2026-10-20; the desktop was seen in 2026-09 | — | 2026-11-05 |
| <img src="compat/os-beos.png" width="160" alt=""> | BeOS 5 | 🟢 Plays | the desktop, Tracker and Deskbar (Enter at the partition menu) | 128 MiB, `586`, PCI | 2026-11-05 |
| <img src="compat/os-reactos.png" width="160" alt=""> | ReactOS 0.4.15 | 🔴 Fails | a stop in the kernel: it needs ACPI | 256 MiB, `pentiumpro`, PCI | 2026-11-05 |
| <img src="compat/os-plan9.png" width="160" alt=""> | Plan 9 (9legacy) | 🔴 Fails | the loader starts the kernel, which then stops | PCI | 2026-11-05 |
| <img src="compat/os-haiku.png" width="160" alt=""> | Haiku | 🟠 Starts | its boot splash with all seven icons lit (Enter at the Boot Manager), then no desktop after 900 guest s | 256 MiB, `pentiumpro`, PCI | 2026-11-05 |
| <img src="compat/mikeos.png" width="160" alt=""> | MikeOS 4.7 | 🟢 Plays | its interface chooser (program menu or command line) | — | 2026-11-05 |
| <img src="compat/freenos.png" width="160" alt=""> | FreeNOS 1.0.3 | 🟢 Plays | its system information and a shell; its timer reads "0 ticks" | 256 MiB, `686` | 2026-11-05 |
| <img src="compat/os-xwoaf.png" width="160" alt=""> | xwoaf (Linux, X11 on a floppy-sized CD) | 🟠 Starts | the keyboard chooser before `login:` | 256 MiB | 2026-11-05 |
| <img src="compat/os-oberon.png" width="160" alt=""> | Oberon | 🟠 Starts | "OBERON loading…", then nothing | 64 MiB | 2026-11-05 |
| <img src="compat/os-linux3.png" width="160" alt=""> | Linux 3.x (v86's mini CD) | 🟠 Starts | the kernel boots and waits for a virtio 9p root (v86's own) | 128 MiB, `686` | 2026-11-06 |
| <img src="compat/os-linux26.png" width="160" alt=""> | Linux 2.6 (v86's mini CD) | 🔴 Fails | ISOLINUX: "Booting kernel failed: Invalid argument" | 128 MiB, `686` | 2026-11-05 |
| <img src="compat/os-tinycore.png" width="160" alt=""> | TinyCore 11 | 🟠 Starts | "Loading extensions…", udev killing slow modprobes, after 900 guest s | 256 MiB, `686` | 2026-11-06 |
| <img src="compat/os-slitaz.png" width="160" alt=""> | SliTaz rolling 2024 | 🟠 Starts | "Decompressing Linux…" at 600 guest s; a kernel panic in an interrupt was seen in 2026-10 | 512 MiB, `686` | 2026-11-05 |
| <img src="compat/os-helenos.png" width="160" alt=""> | HelenOS 0.14.1 | 🟠 Starts | the SPARTAN kernel boots and starts its services; rd and ns then die on a user-mode page fault at the same kernel address, 80167F55h | 256 MiB, `686` (or `586`) | 2026-11-05 |
| <img src="compat/os-sortix.png" width="160" alt=""> | Sortix 1.0 | 🟠 Starts | GRUB loading its 5 MB initrd, unfinished after 600 guest s | 512 MiB, `686` | 2026-11-05 |
| <img src="compat/os-toaru.png" width="160" alt=""> | ToaruOS 1.6.1 | 🟠 Starts | its bootloader menu; Enter is not taken | 512 MiB, `686` | 2026-11-05 |
| <img src="compat/os-tilck.png" width="160" alt=""> | Tilck | 🔴 Fails | its bootloader and kernel start (800x600x32 console), then a kernel panic on a #GP in kmain | 128 MiB, `686` | 2026-11-05 |

Boot-sector programs — 🏅 BootChess, bootBASIC, bootOS, Invaders, Pillman, sectorFORTH, sectorLISP,
TetrOS, Floppy Bird and the like — run; several were compared pixel for pixel with QEMU.

## DOS games (the DOS player, `dos.html`)

Each picture pair is the title, then the game, drawn by MIRAGE's own renderer (`src/video.js`) from a headless run: `node tools/compat-shots.mjs`, the keys and moments of each title in `tools/compat-shots.json`.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | Video | Status | Notes | Run |
|---|---|---|---|---|---|
| <img src="compat/dos-alleycat-title.png" width="160" alt=""> <img src="compat/dos-alleycat-game.png" width="160" alt=""> | Alley Cat | CGA | 🟢 Plays | title, then the alley | 2026-11-05 |
| <img src="compat/dos-arctic-title.png" width="160" alt=""> <img src="compat/dos-arctic-game.png" width="160" alt=""> | Arctic Adventure | CGA | 🟢 Plays | title, then the map | 2026-11-05 |
| <img src="compat/dos-arkanoid-title.png" width="160" alt=""> <img src="compat/dos-arkanoid-game.png" width="160" alt=""> | Arkanoid | CGA | 🟢 Plays | its video and input menus, then round 1 | 2026-11-05 |
| <img src="compat/dos-babyjo-title.png" width="160" alt=""> <img src="compat/dos-babyjo-game.png" width="160" alt=""> | Baby Jo | EGA | 🟢 Plays | past its language flags (Space), the title, then the first level | 2026-11-05 |
| <img src="compat/dos-bmenace-title.png" width="160" alt=""> <img src="compat/dos-bmenace-game.png" width="160" alt=""> | Bio Menace (freeware) | EGA | 🟢 Renders | past its set-up screen and technical help, the new-game menu | 2026-11-05 |
| <img src="compat/dos-blues-title.png" width="160" alt=""> <img src="compat/dos-blues-game.png" width="160" alt=""> | Blues Brothers | EGA | 🟢 Plays | title, then the city map | 2026-11-05 |
| <img src="compat/dos-cdogs-title.png" width="160" alt=""> <img src="compat/dos-cdogs-game.png" width="160" alt=""> | C-Dogs 1.06 | VGA 13h | 🟢 Plays | its menu, then mission 1; Sound Blaster 16 effects (see the intros table) | 2026-11-05 |
| <img src="compat/dos-keen1-title.png" width="160" alt=""> <img src="compat/dos-keen1-game.png" width="160" alt=""> | Commander Keen 1 | EGA | 🟢 Plays | title, then a new game on the Mars map; file and video events identical to DOSBox-X (2026-08-18) | 2026-11-05 |
| <img src="compat/dos-keen3-title.png" width="160" alt=""> <img src="compat/dos-keen3-game.png" width="160" alt=""> | Commander Keen 3 | EGA | 🟢 Plays | title, then a new game on the map | 2026-11-05 |
| <img src="compat/dos-keen4-title.png" width="160" alt=""> <img src="compat/dos-keen4-game.png" width="160" alt=""> | Commander Keen 4 (shareware) | EGA | 🟢 Plays | past its set-up screen, the title, then the attract demo | 2026-11-05 |
| <img src="compat/dos-cosmo-title.png" width="160" alt=""> <img src="compat/dos-cosmo-game.png" width="160" alt=""> | Cosmo's Cosmic Adventure | EGA | 🟢 Plays | title, then the attract demo | 2026-11-05 |
| <img src="compat/dos-crystalc-title.png" width="160" alt=""> <img src="compat/dos-crystalc-game.png" width="160" alt=""> | Crystal Caves | EGA | 🟢 Plays | title, then a new game: the first level | 2026-11-05 |
| <img src="compat/dos-davehm-title.png" width="160" alt=""> <img src="compat/dos-davehm-game.png" width="160" alt=""> | Dangerous Dave in the Haunted Mansion | EGA | 🟢 Plays | title, then the first level | 2026-11-05 |
| <img src="compat/dos-darkage-title.png" width="160" alt=""> <img src="compat/dos-darkage-game.png" width="160" alt=""> | Dark Ages | EGA | 🟢 Plays | title, then the first level | 2026-11-05 |
| <img src="compat/dos-digger-title.png" width="160" alt=""> | Digger | CGA | 🟢 Renders | title and high scores | 2026-11-05 |
| <img src="compat/dos-doom-title.png" width="160" alt=""> <img src="compat/dos-doom-game.png" width="160" alt=""> | DOOM (id, 1993) | VGA 13h | 🟢 Plays | its title, then the attract demo with the status bar; with our DPMI host or its own DOS/4G | 2026-11-05 |
| <img src="compat/dos-duke1-title.png" width="160" alt=""> <img src="compat/dos-duke1-game.png" width="160" alt=""> | Duke Nukem 1 | EGA | 🟢 Plays | title, then a new game: the first level | 2026-11-05 |
| <img src="compat/dos-dune-title.png" width="160" alt=""> <img src="compat/dos-dune-game.png" width="160" alt=""> | Dune (Cryo) | VGA 13h | 🟢 Renders | the animated intro, in the `HIM 386` path too | 2026-11-05 |
| <img src="compat/dos-dunedemo-title.png" width="160" alt=""> <img src="compat/dos-dunedemo-game.png" width="160" alt=""> | Dune, the 1991 playable demo (Cryo) | VGA 13h | 🟢 Renders | the logos and the intro, from its ZIP | 2026-11-05 |
| <img src="compat/dos-fractint-title.png" width="160" alt=""> <img src="compat/dos-fractint-game.png" width="160" alt=""> | Fractint 20.0 | VGA 13h | 🟢 Plays | its credits, then the Mandelbrot set drawn; zooms | 2026-11-05 |
| <img src="compat/dos-godthund-title.png" width="160" alt=""> <img src="compat/dos-godthund-game.png" width="160" alt=""> | God of Thunder | VGA 13h | 🟢 Renders | title, then the player selection | 2026-11-05 |
| <img src="compat/dos-goldenax-title.png" width="160" alt=""> | Golden Axe | — | 🟠 Starts | its title, then a password entry from the manual | 2026-11-05 |
| <img src="compat/dos-hharry-title.png" width="160" alt=""> <img src="compat/dos-hharry-game.png" width="160" alt=""> | Halloween Harry (shareware) | VGA 13h | 🟢 Renders | past its configuration screen, the intro, then "Mission 1 — Office Block" | 2026-11-05 |
| <img src="compat/dos-heretic-title.png" width="160" alt=""> <img src="compat/dos-heretic-game.png" width="160" alt=""> | Heretic | VGA 13h | 🟢 Plays | its title, then the attract demo; needs our DPMI host | 2026-11-05 |
| <img src="compat/dos-hexen-title.png" width="160" alt=""> <img src="compat/dos-hexen-game.png" width="160" alt=""> | Hexen (4-level demo) | VGA 13h | 🟢 Plays | a key past its shareware notice, then the attract demo; DOS/4GW 1.97 on our DPMI host | 2026-11-05 |
| <img src="compat/dos-hocus-title.png" width="160" alt=""> <img src="compat/dos-hocus-game.png" width="160" alt=""> | Hocus Pocus | VGA 13h | 🟢 Plays | past its notices, the main menu, then the first level | 2026-11-05 |
| <img src="compat/dos-indy3-title.png" width="160" alt=""> <img src="compat/dos-indy3-game.png" width="160" alt=""> | Indiana Jones and the Last Crusade | EGA | 🟢 Renders | the Lucasfun circus intro, then the college; the copy-protection screen (2026-08-01) | 2026-11-05 |
| <img src="compat/dos-jazz-title.png" width="160" alt=""> <img src="compat/dos-jazz-game.png" width="160" alt=""> | Jazz Jackrabbit | VGA 13h | 🟢 Plays | through Borland's RTM on our DPMI host: its main menu, then the first level (its CONFIG.000, saved on a 486, opens the Gameplay Options first) | 2026-11-05 |
| <img src="compat/dos-jill-title.png" width="160" alt=""> <img src="compat/dos-jill-game.png" width="160" alt=""> | Jill of the Jungle (shareware) | VGA 13h | 🟢 Plays | title, then a new game on the map | 2026-11-05 |
| <img src="compat/dos-jumpbump-title.png" width="160" alt=""> <img src="compat/dos-jumpbump-game.png" width="160" alt=""> | Jump 'n Bump | Mode X | 🟢 Plays | the title, then a level: a bunny walked right and jumped over the log (up arrow) starts the game | 2026-11-05 |
| <img src="compat/dos-lemmings-title.png" width="160" alt=""> | Lemmings | VGA/EGA | 🟠 Starts | the machine-type menu; then it wants a raw floppy ("Lemmings Disk 1 Not Found") | 2026-11-05 |
| <img src="compat/dos-loderun-game.png" width="160" alt=""> | Lode Runner | CGA | 🟢 Renders | its gameplay | 2026-11-05 |
| <img src="compat/dos-loom-title.png" width="160" alt=""> | Loom | EGA | 🟢 Renders | proficiency menu (driven with the mouse) | 2026-11-05 |
| <img src="compat/dos-stryker-title.png" width="160" alt=""> <img src="compat/dos-stryker-game.png" width="160" alt=""> | Major Stryker (shareware) | EGA | 🟢 Renders | past its notice, the credits, then the first mission's briefing | 2026-11-05 |
| <img src="compat/dos-maniac-title.png" width="160" alt=""> <img src="compat/dos-maniac-game.png" width="160" alt=""> | Maniac Mansion (enhanced) | EGA | 🟢 Plays | the kid select, then the first scene with its verbs (arrow keys and Enter: it reads the keyboard through INT 21h; the mouse after Shift+M) | 2026-11-05 |
| <img src="compat/dos-mathresc-title.png" width="160" alt=""> <img src="compat/dos-mathresc-game.png" width="160" alt=""> | Math Rescue | EGA | 🟢 Renders | title, then its main menu after the story | 2026-11-05 |
| <img src="compat/dos-moktar-title.png" width="160" alt=""> <img src="compat/dos-moktar-game.png" width="160" alt=""> | Moktar (Titus) | VGA 13h | 🟢 Plays | title, then the first level; a launcher that EXECs the game | 2026-11-05 |
| <img src="compat/dos-mi2-title.png" width="160" alt=""> | Monkey Island 2 | VGA 13h | 🟢 Renders | the copy-protection screen | 2026-11-05 |
| <img src="compat/dos-monsterb-title.png" width="160" alt=""> <img src="compat/dos-monsterb-game.png" width="160" alt=""> | Monster Bash | EGA | 🟢 Plays | title, then the first level with its hint box | 2026-11-05 |
| <img src="compat/dos-mystic-title.png" width="160" alt=""> <img src="compat/dos-mystic-game.png" width="160" alt=""> | Mystic Towers | VGA 13h | 🟢 Plays | its set-up screen, the title, then a quest | 2026-11-05 |
| <img src="compat/dos-omf-title.png" width="160" alt=""> <img src="compat/dos-omf-game.png" width="160" alt=""> | One Must Fall 2097 | VGA 13h | 🟢 Renders | its main menu, then the game's title, on DOS/4GW and our DPMI host | 2026-11-05 |
| <img src="compat/dos-paganitz-title.png" width="160" alt=""> <img src="compat/dos-paganitz-game.png" width="160" alt=""> | Paganitzu | EGA | 🟠 Starts | its display and controller menus, then the story | 2026-11-05 |
| <img src="compat/dos-pinball-title.png" width="160" alt=""> <img src="compat/dos-pinball-game.png" width="160" alt=""> | Pinball Fantasies | Mode X, 640×480 planar | 🟢 Renders | the 21st Century logo, then its table selection | 2026-11-05 |
|  | Tyrian 2.1 (Eclipse Productions, 1995), its freeware release | VGA | 🔴 Fails | TYRIAN.EXE starts the game under Borland's 16-bit DPMI (RTM.EXE, DPMI16BI.OVL); MIRAGE derails at once, a jump to 0000:0D00 from selector 27h. OpenTyrian, its port, plays on the Windows machine | 2026-11-27 |
| <img src="compat/dos-pitman-title.png" width="160" alt=""> <img src="compat/dos-pitman-game.png" width="160" alt=""> | 🏅 Pitman | text | 🟢 Plays | its title and menu, then level 1 | 2026-11-05 |
| <img src="compat/dos-prehist-title.png" width="160" alt=""> <img src="compat/dos-prehist-game.png" width="160" alt=""> | Prehistorik | EGA | 🟢 Renders | past its language, graphics, sound and control menus, the title, then its introduction | 2026-11-05 |
| <img src="compat/dos-pop-title.png" width="160" alt=""> <img src="compat/dos-pop-game.png" width="160" alt=""> | Prince of Persia | VGA 13h | 🟢 Renders | title, then its intro in the palace | 2026-11-05 |
| | QBasic | text | 🟠 Starts | the IDE, after a long first compile | 2026-07-20 |
| <img src="compat/dos-quake-title.png" width="160" alt=""> <img src="compat/dos-quake-game.png" width="160" alt=""> | Quake | VGA 13h | 🟢 Plays | `-nocdaudio`; its console, then demo1 | 2026-11-05 |
| <img src="compat/dos-raptor-title.png" width="160" alt=""> <img src="compat/dos-raptor-game.png" width="160" alt=""> | Raptor: Call of the Shadows (shareware) | VGA 13h | 🟢 Renders | on our DPMI host: the main menu, then a new pilot's file | 2026-11-05 |
| <img src="compat/dos-roc-title.png" width="160" alt=""> <img src="compat/dos-roc-game.png" width="160" alt=""> | Realms of Chaos | Mode X | 🟢 Plays | credits, then a new game in the forest (uses XMS) | 2026-11-05 |
| <img src="compat/dos-secretag-title.png" width="160" alt=""> <img src="compat/dos-secretag-game.png" width="160" alt=""> | Secret Agent | EGA | 🟢 Plays | title, then a new game: the island map | 2026-11-05 |
| <img src="compat/dos-monkey-title.png" width="160" alt=""> <img src="compat/dos-monkey-game.png" width="160" alt=""> | The Secret of Monkey Island (EGA) | EGA | 🟢 Renders | past "Press ENTER to continue", the Island of Mêlée | 2026-11-05 |
| <img src="compat/dos-skiordie-title.png" width="160" alt=""> <img src="compat/dos-skiordie-game.png" width="160" alt=""> | Ski or Die | EGA | 🟢 Renders | title, then Rodney's ski shop | 2026-11-05 |
| <img src="compat/dos-turbopas-title.png" width="160" alt=""> <img src="compat/dos-turbopas-game.png" width="160" alt=""> | Turbo Pascal 7.1 | text | 🟢 Renders | the IDE and its About box | 2026-11-05 |
| <img src="compat/dos-wolf3d-title.png" width="160" alt=""> <img src="compat/dos-wolf3d-game.png" width="160" alt=""> | Wolfenstein 3D (shareware and registered) | Mode X | 🟢 Plays | past its signon, the title, then the attract demo | 2026-11-05 |
| <img src="compat/dos-wordresc-title.png" width="160" alt=""> <img src="compat/dos-wordresc-game.png" width="160" alt=""> | Word Rescue | EGA | 🟢 Plays | title, then the first level | 2026-11-05 |
| <img src="compat/dos-zone66-title.png" width="160" alt=""> | Zone 66 | VGA 13h | 🟠 Starts | its intro and five story pages (Space), then a black screen for 200 guest s; with `?xms=0`: it refuses any XMS driver ("This program can not run with an XMS driver"), on DOSBox-X too unless `xms=false` | 2026-11-05 |

## Intros and demos

Scene productions for DOS, from 256-byte intros to Future Crew's demos, in alphabetical order. Of
pouët's top ten MS-DOS 4K intros, nine render.

🏅 marks a **golden** title: `tools/golden.js` runs it on every code change and compares a
fingerprint of its screen with the recorded one, so a regression in it cannot land unnoticed. All
44 golden runs matched on 2026-11-05. The pictures of the golden intros are MIRAGE's own, drawn by
`tools/compat-shots.mjs` (the `g-` entries of `tools/compat-shots.json`).

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | Status | Notes | Run |
|---|---|---|---|---|
| <img src="compat/golden-256b.png" width="160" alt=""> | 🏅 256b | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-256bytef.png" width="160" alt=""> | 🏅 256bytef | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-above.png" width="160" alt=""> | 🏅 above | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-abstract.png" width="160" alt=""> | 🏅 abstract | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-animate.png" width="160" alt=""> | 🏅 animate | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-soullost.png" width="160" alt=""> | 🏅 Another Soul Lost | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-chaosequ.png" width="160" alt=""> | 🏅 chaosequ | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/intro-crevenge.png" width="160" alt=""> | 🏅 Chrome Revenge (1K, SSE raytracer, VESA 640×480×32) | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/intro-difze.png" width="160" alt=""> | 🏅 Difúze (Řrřola) | 🟢 Plays | the reaction–diffusion patterns, after a few hundred frames; identical to Unicorn for 300 frames ([notes/2026-10-10-difuze.md](notes/2026-10-10-difuze.md)); its General MIDI music through the MPU-401 | 2026-11-05 |
| <img src="compat/golden-dirojed.png" width="160" alt=""> | 🏅 dirojed | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-endless.png" width="160" alt=""> | 🏅 endless | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-freality.png" width="160" alt=""> | 🏅 Forever Reality | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/intro-heaven.png" width="160" alt=""> | Heaven (NoooN) | 🟢 Renders | not checked frame-exact | 2026-11-05 |
| <img src="compat/intro-helium.png" width="160" alt=""> | Helium | 🟢 Renders | a finite intro: it exits by itself | 2026-11-05 |
| <img src="compat/golden-intoanew.png" width="160" alt=""> | 🏅 intoanew | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-intro.png" width="160" alt=""> | 🏅 intro | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-intro256.png" width="160" alt=""> | 🏅 intro256 | 🟢 Renders |  | 2026-11-05 |
| | Juggler 2001 | 🟢 Renders | after the MIDI-port question and the keypress it asks for | 2026-08-28 |
| <img src="compat/golden-kaneda.png" width="160" alt=""> | 🏅 kaneda | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-lattice.png" width="160" alt=""> | 🏅 lattice | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-mars-title.png" width="160" alt=""> | 🏅 Mars (Tim Clarke) | 🟢 Renders | the landscape; steers with the mouse | 2026-11-05 |
| <img src="compat/golden-memories.png" width="160" alt=""> | 🏅 memories | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/intro-mesha.png" width="160" alt=""> | 🏅 Mesha | 🟢 Renders | its picture after ~110 s of precomputation; also under a booted FreeDOS with a real XMS driver | 2026-11-05 |
| <img src="compat/intro-mirrors.png" width="160" alt=""> | 🏅 Mirrors Within (512b) | 🟢 Renders | 82 % pixel agreement with DOSBox-X | 2026-11-05 |
| <img src="compat/golden-nibble.png" width="160" alt=""> | 🏅 nibble | 🟢 Renders |  | 2026-11-05 |
|  | 🏅 oktaeder | 🔴 Fails | pinned on its fault: it drives PCI hardware directly and derails on the reference emulator too | 2026-11-05 |
| <img src="compat/intro-omniscent.png" width="160" alt=""> | 🏅 Omniscent | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-paleozoa.png" width="160" alt=""> | 🏅 paleozoa | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-panic-title.png" width="160" alt=""> <img src="compat/dos-panic-game.png" width="160" alt=""> | Panic (Future Crew) | 🟠 Starts | its menu; not driven past it headless | 2026-11-05 |
| <img src="compat/golden-paralaxa.png" width="160" alt=""> | 🏅 paralaxa | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-puls.png" width="160" alt=""> | 🏅 puls | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/intro-qblove.png" width="160" alt=""> | 🏅 qblove (1K) | 🟢 Renders | checked against the author's screenshot | 2026-11-05 |
| <img src="compat/golden-revitro.png" width="160" alt=""> | 🏅 revitro | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-rv256.png" width="160" alt=""> | 🏅 rv256 | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-2ndreal-title.png" width="160" alt=""> <img src="compat/dos-2ndreal-game.png" width="160" alt=""> | Second Reality (Future Crew) | 🟢 Plays | SoundBlaster Pro at its set-up (its default, the Gravis Ultrasound, is not emulated), then the demo with its music: its opening, the credits over the mountains, the spaceship, the checkerboard, the polyhedra and the plants (checked to 260 s) | 2026-11-06 |
| <img src="compat/golden-starport.png" width="160" alt=""> | 🏅 StarPort BBS 2 | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-stash-title.png" width="160" alt=""> | Stash (The Black Lotus, 64K) | 🟢 Plays | the progress bar while it precomputes (3.3 billion instructions), then the intro to its end text | 2026-11-05 |
| <img src="compat/golden-symetrie.png" width="160" alt=""> | 🏅 symetrie | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-tube-title.png" width="160" alt=""> | 🏅 tube | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/dos-unreal-title.png" width="160" alt=""> <img src="compat/dos-unreal-game.png" width="160" alt=""> | Unreal 1.1 (Future Crew) | 🟢 Renders | its sound menu, then the scroller part (in the browser, at its own speed: it times a frame with PIT counter 0 and waits on every retrace) | 2026-11-05 |
| <img src="compat/golden-upup.png" width="160" alt=""> | 🏅 upup | 🟢 Renders |  | 2026-11-05 |
| | Void 3 | 🟢 Renders | answer `2` and `1` to its SB questions; it precomputes its music, then plays. Its synthesis wants ~30 M instructions a second: headless that is `MIRAGE_PITRELOAD=1800000`, the browser measured 73 M | 2026-10-11 |
| <img src="compat/golden-warp.png" width="160" alt=""> | 🏅 warp | 🟢 Renders |  | 2026-11-05 |
| <img src="compat/golden-worm.png" width="160" alt=""> | 🏅 worm | 🟢 Renders |  | 2026-11-05 |

MIRAGE's own test demos (`demos/`), all golden:

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | Status | Notes | Run |
|---|---|---|---|---|
| <img src="compat/golden-plasma13.png" width="160" alt=""> | 🏅 PLASMA13 | 🟢 Renders | mode 13h palette plasma | 2026-11-05 |
| <img src="compat/golden-xormunch.png" width="160" alt=""> | 🏅 XORMUNCH | 🟢 Renders | mode 13h | 2026-11-05 |
| <img src="compat/golden-planar.png" width="160" alt=""> | 🏅 PLANAR | 🟢 Renders | EGA/VGA planar 16 colours | 2026-11-05 |
| <img src="compat/golden-cga.png" width="160" alt=""> | 🏅 CGA | 🟢 Renders | CGA 4 colours | 2026-11-05 |
| <img src="compat/golden-vesa.png" width="160" alt=""> | 🏅 VESA | 🟢 Renders | VBE mode list, 4F01/4F02 and bank switches | 2026-11-05 |

## Windows programs (MIRAGE-WIN32, `machines.html?m=win32`)

### Games

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | API | Status | Notes |
|---|---|---|---|---|
| <img src="compat/win32-winquake-game.png" width="160" alt=""> <img src="compat/win32-winquake-menu.png" width="160" alt=""> | WinQuake 1.00 (id Software, 1997) | DirectDraw, GDI, DirectSound, Winsock | 🟢 Plays | id's own `winquake.exe` with the shareware episode: its software renderer through SciTech MGL into DirectDraw surfaces, full screen (320x200 by default), or with `-dibonly` in an 8-bit DIB section that `StretchBlt` puts on the screen, its sound through DirectSound, keys and mouse as window messages; Winsock reports no network, so it plays alone. In a window (`vid_mode` 0-2, `-startwindowed`) it sits framed on the desktop and can be dragged | 2026-11-13 |
| <img src="compat/win32-glquake.png" width="160" alt=""> <img src="compat/win32-glquake-window.png" width="160" alt=""> | GLQuake 0.95 (id Software, 1997) | OpenGL 1.1, DirectSound | 🟢 Plays | id's own `glquake.exe` (glq8_27.zip) with the shareware episode, without the 3dfx miniGL beside it: its OpenGL drawn by PRISM's `gl.js` on WebGL2, full screen at 640x480, or with `-window` in a frame on the desktop, WebGL's picture in its client area | 2026-11-09 |
| <img src="compat/win32-quake2.png" width="160" alt=""> <img src="compat/win32-quake2-game.png" width="160" alt=""> | Quake II demo 3.14 (id Software, 1998) | DirectDraw, DirectSound, Winsock, its own DLLs | 🟢 Plays | `quake2.exe` loading its `ref_soft.dll` and `gamex86.dll` from its directory; full screen through DirectDraw, an 8-bit mode and its palette (320x240, 640x480 from its Video menu); the demo, the menu, the console, its Video menu's modes and `sw_mode`, a new game from the menu, the mouse captured in play | 2026-11-10 |
| — | StarCraft shareware 1.01 (Blizzard, 1998) | DirectDraw, DirectSound, Storm, GDI | 🟢 Renders | Blizzard's installer (`SCDEMO.EXE`) runs and installs its files in MIRAGE-WIN32; the game's menu, a player made, the Terran prequel's briefing and its first mission played and won in the page (depots, a refinery, gas; its score screen), its sound and voices. Run locally as a test | 2026-11-14 |
| <img src="compat/win32-diablo-hero.png" width="160" alt=""> <img src="compat/win32-diablo-town.png" width="160" alt=""> | Diablo shareware 1.00 (Blizzard, 1997) | DirectDraw, DirectSound, Storm, Smacker, GDI | 🟢 Plays | Blizzard's installer (`diablosw.exe`) runs and installs its files in MIRAGE-WIN32; the game plays the Blizzard North logo, its title screen and menus (Storm's dialogs: pictures blitted through their windows' update regions, text in Arial's metrics), a Warrior made and named, Tristram loaded and walked with the mouse in the page. Not played further yet. Run locally as a test | 2026-11-15 |
| <img src="compat/win32-quake3-setup.png" width="160" alt=""> <img src="compat/win32-quake3-demo.png" width="160" alt=""> | Quake III Arena demo 1.11 (id Software, 1999) | OpenGL, Installer VISE, GDI, Winsock | 🟢 Plays | id's installer (`Q3ADemo.exe`, Installer VISE) runs and installs the demo in MIRAGE-WIN32: its wizard, its licence, its files; the game starts in OpenGL on PRISM, its menus, and plays its recorded demos (demo001) at some 45 frames a second in headless Chrome. Mouse and sound not checked yet. Run locally as a test | 2026-11-17 |
| <img src="compat/win32-war3demo-menu.png" width="160" alt=""> | Warcraft III: Reign of Chaos demo (Blizzard, 2002) | OpenGL (`-opengl`), its own installer, GDI, Miles Sound System | 🟡 Starts | Blizzard's installer (`W3Demo.exe`) runs and installs the demo in MIRAGE-WIN32; the game starts in OpenGL on PRISM (`-opengl -window`) and shows its 3D main menu, its buttons' text included, at some 36 frames a second in headless Chrome. Clicks, sound and a game not checked yet. Run locally as a test | 2026-11-18 |
| <img src="compat/win32-quake2-gl-menu.png" width="160" alt=""> <img src="compat/win32-quake2-gl.png" width="160" alt=""> | Quake II demo 3.14, OpenGL (`+set vid_ref gl`) | OpenGL 1.1, DirectSound | 🟢 Plays | `ref_gl.dll` loading `opengl32.dll` and asking it for every GL function by name; full screen, its Video menu's modes (800x600: the GL surface follows), a new game from the menu, the mouse in play; ~45 fps in Chrome | 2026-11-10 |
| <img src="compat/win32-jazz2-intro.png" width="160" alt=""> <img src="compat/win32-jazz2-menu.png" width="160" alt=""> | Jazz Jackrabbit 2 shareware 1.21 (Orange Games / Epic MegaGames, 1998) | GDI, waveOut, Winsock | 🟢 Plays | `Jazz2.exe` as Epic built it, from its installer read in the page (`src/didi.js`): its splash, then its game window, each frame an 8-bit DIB section `StretchBlt` puts there; the Orange Games logo, the intro video (copied eight bytes at a time through the FPU), the menus (its keyboard through a WH_KEYBOARD hook), the demos, a new game; its sound mixed on a multimedia timer into waveOut. its menu bar (Game, Video, Music, Help) drawn and used | 2026-11-12 |
| <img src="compat/win32-abuse-title.png" width="160" alt=""> <img src="compat/win32-abuse-game.png" width="160" alt=""> | Abuse (Crack dot Com, 1996), Xenoveritas' SDL 2 port 0.9.1 for Windows | GDI, SDL 2, the Universal C Runtime | 🟢 Plays | a Visual C++ 2022 program on MIRAGE-WIN32: its grey-ramp check, the title, the demo, a game. SDL2.dll and SDL2_mixer.dll made in JavaScript (`machine.hle: ["sdl2"]`, PRISM's SDL): the frames pixel for pixel those of the SDL2.dll beside it, run in x86 (still the oracle, without `hle`), 50 guest seconds in 10.8 s of the host's time instead of 15.1 s. Its engine GPL, its data public domain; the release has no sound effects | 2026-11-27 |
| <img src="compat/win32-opentyrian-title.png" width="160" alt=""> <img src="compat/win32-opentyrian-game.png" width="160" alt=""> | OpenTyrian v2.1.20221123 for Windows, with Tyrian 2.1's freeware data (Eclipse Productions, 1995) | SDL 2, SDL2_net, the Universal C Runtime | 🟢 Plays | its title, the menus, the briefing, the first level played (fire, movement), its music and sound through SDL's audio callback on a thread of the program's. SDL2.dll made in JavaScript (`machine.hle: ["sdl2"]`): its frames pixel for pixel those of the SDL2.dll beside it run in x86 (software renderer), the sound's loudness envelope matching it (0.95); SDL2_net.dll in x86, on a machine with no network | 2026-11-27 |
| <img src="compat/win32-cavestory-title.png" width="160" alt=""> <img src="compat/win32-cavestory-cave.png" width="160" alt=""> | Cave Story (Studio Pixel, 2004), Aeon Genesis' English translation 1.03 | DirectDraw, DirectSound, DirectInput | 🟡 Plays, not offered | `Doukutsu.exe` full screen in 16 bits or in a window: its intro, title, the first dialogue and the First Cave, run headless; GDI draws its text on DirectDraw surfaces (`GetDC`). No OASIS image: Pixel's freeware states nothing on redistribution | 2026-11-12 |
| <img src="compat/win32-undertale-title.png" width="160" alt=""> <img src="compat/win32-undertale-ruins.png" width="160" alt=""> | Undertale demo (Toby Fox, 2013), GameMaker 8 | Direct3D 8, DirectMusic, OpenAL, Delphi | 🟢 Plays | GameMaker 8's runner (Delphi) starts, unpacks its game, makes its 602 textures and draws through Direct3D 8 in the page (its window on the desktop): the intro, the title, the naming of the fallen human, then the Ruins, walked through with the arrow keys; its music through OpenAL's waveOut device, its sounds through DirectMusic. Run locally as a test | 2026-11-15 |
| <img src="compat/win32-deltarune-intro.png" width="160" alt=""> | Deltarune Chapter 1 (Toby Fox, 2018), GameMaker Studio 2 | Direct3D 11, DXGI, VC++ 2015 runtime, SSE2 | 🟡 Renders | The runner starts on a Pentium 4 with 512 MiB, loads its game and draws its intro in its window on the desktop through Direct3D 11 at feature level 9_3 (each shader's level 9 bytecode, on PRISM's Direct3D 9 device model), some 15 frames a second in the page; no sound (XAudio2 missing). Run locally as a test | 2026-11-15 |
| <img src="compat/win32-halflife-uplink.png" width="160" alt=""> | Half-Life: Uplink demo (Valve, 1999) | DirectDraw, its own DLLs | 🟡 Renders, not offered | `hl.exe` and its software renderer `sw.dll` (`-soft`), the game in `hl.dll`, the HUD in `client.dll`: its first level drawn and its HUD up, run headless (captured at 120 s), as under Wine. No OASIS image: the demo's licence (Sierra, 1999) allows personal use only, not redistribution | 2026-11-11 |

### Applications

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | API | Status | Notes |
|---|---|---|---|---|
| — | Java 2 Runtime, Standard Edition 1.4.2 (Sun, 2003) | HotSpot Client VM, AWT and Swing (GDI), msvcrt | 🟢 Runs | The JRE from archive.org's j2re-1_4_2_06 installer, its files taken out of the installer's MSI and its .pack libraries unpacked by its own unpack.exe run in MIRAGE-WIN32. `java -version` answers; Java2Demo (Sun's Java 2D demo, its 1999 jar with the images of the 1.4.2 SDK's sources) runs: its intro, its Composite, Transforms and Paint tabs, Swing's controls, its memory and performance monitors. Its messages sent across threads run on the toolkit's thread; its frame on the desktop through DirectDraw's primary surface. java.exe ends with main, System.exit or the frame's close box. HotSpot's code runs at some 42 million x86 instructions a second here (block dispatch the cost). Run locally as a test | 2026-11-19 |
| — | Unreal Tournament, Game of the Year Edition (Epic, 1999; archive.org's ut-goty, which Epic allows) | Unreal Engine 1 (UNICODE), SoftDrv (GDI), WinDrv, Window.dll's dialogs | 🟡 Starts | Its maps decompressed by its own UCC.exe run in MIRAGE-WIN32; the first-run configuration, which runs UnrealTournament.exe again to try Direct3D (a child process: CreateProcess, ShellExecute) and offers software rendering; the CityIntro flyby and the menu at 7 guest frames a second, 130 M host instructions a second; in the page with its renderer 3dfx Glide (MIRAGE's glide2x.dll on WebGL), which the configuration now detects, 6 frames a second on a Pentium III profile. With D3DDrv (Direct3D 7: MIRAGE's ddraw.dll on PRISM's Direct3D 9 device model) its intro flybys full screen or in its window at some 25 frames a second. To do: a map played, fog and the chroma key in Glide and Direct3D, OpenGlDrv. Run locally as a test | 2026-11-22 |
| — | NESticle x.xx for Windows 95 (Bloodlust Software, 1997) | DirectDraw 2 (320x240, 8 bits), DirectSound, GDI | 🟢 Plays | The NES emulator from archive.org's NESticleVersion0.42 item runs Shiru's freeware homebrew games (Alter Ego, Lan Master) given on its command line, full screen at 60 frames a second in headless Chrome with most of the machine to spare. Its GUI's own menus not checked yet. Run locally as a test | 2026-11-18 |
| — | Macromedia Flash Player 8 (standalone projector, 2005) | GDI, waveOut, its own vector renderer | 🟢 Plays | The projector from archive.org's standalone_flash_player item starts, its menus in the visitor's language (English when the code page cannot write it), and plays a movie given on its command line -- `tools/win32/samples/flash/make-swf.mjs` makes one of our own (shapes turning and moving, 30 frames a second). Movies from archive.org's Flash collection, in headless Chrome: Peanut Butter Jelly Time at its 12 frames a second, Badger at 10 to 23 of its 25; Zoo Keeper's and Fly Guy's title screens; Line Rider, Alien Hominid and The Ultimate Showdown wait at their first screen for a click (not driven yet). Its own renderer is short blocks of x86 (12 instructions on average): it is the recompiler's dispatch that limits it. Run locally as a test | 2026-11-18 |
| <img src="compat/win32-winamp.png" width="160" alt=""> <img src="compat/win32-winamp-avs.png" width="160" alt=""> | Winamp 2.95 (Nullsoft, 2003) | GDI, waveOut, DirectDraw, Video for Windows, its plug-ins (in_mp3, out_wave, vis_avs) | 🟢 Plays | Installed by its own setup in MIRAGE-WIN32; its main window, equalizer and playlist drawn with its built-in skin, and its demo MP3 played to the end with its spectrum. AVS 2.6.1 (Ctrl+Shift+K, on an MMX CPU) draws its presets in its window, some 15 frames a second at 204x138 in headless Chrome (MMX compiled, some 150 M instructions a second); its editor lists its effects in its tree and opens each one's settings (its sliders not drawn yet). The minibrowser stays empty: it is Internet Explorer's, which is not made here; shortcut menus are not shown yet. Run locally as a test | 2026-11-17 |

### Intros

The scene's Windows intros of 2007-2017, run with no Windows: the `.exe` mapped as Windows XP maps it,
every DLL in JavaScript, the graphics drawn by PRISM's `gl.js` (OpenGL) or `d3d9.js` (Direct3D 9).
The ones that render are OASIS images (`oasis/images/win32/`), all captured in Chrome on 2026-11-05.
"Headless" is a run in Node on the recording device model, which says how far the program gets but
not what it draws.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Title | API | Status | Notes | Run |
|---|---|---|---|---|---|
| <img src="compat/win32-ribbon-2009.png" width="160" alt=""> | To the Road of Ribbon, Flow2, Chocolux (1K) | OpenGL | 🟢 Renders | one GLSL fragment shader each | 2026-11-05 |
| <img src="compat/win32-paradistance-2009.png" width="160" alt=""> | Retrospection, Paradistance (4K) | OpenGL | 🟢 Renders | with their music through waveOut | 2026-11-05 |
| <img src="compat/win32-hartverdrahtet-2012.png" width="160" alt=""> | Hartverdrahtet (4K, Revision 2012) | OpenGL | 🟢 Renders | framebuffer objects; music from a thread | 2026-11-05 |
| <img src="compat/win32-absoluteterritory-2017.png" width="160" alt=""> | Absolute Territory (4K, Revision 2017) | OpenGL | 🟢 Renders | 38 ms of fragment shader a frame on an M1 | 2026-11-05 |
| <img src="compat/win32-cdak-2010.png" width="160" alt=""> | cdak (4K, Chaos Constructions 2010) | Direct3D 9 | 🟢 Renders | 60 frames a second in Chrome: HLSL pixel shaders, render targets ping-ponged, a looped waveOut buffer | 2026-11-05 |
| <img src="compat/win32-yeswecan-2009.png" width="160" alt=""> | yes we can (4K, Chaos Constructions 2009) | Direct3D 9 | 🟢 Renders | 60 frames a second in Chrome: pixel shaders on one pre-transformed triangle, a float16 render target | 2026-11-05 |
| <img src="compat/win32-photonrace2-2008.png" width="160" alt=""> | Photon Race 2 (4K, NVScene 2008) | Direct3D 9 | 🟢 Plays | after a few seconds of precalculation: HLSL vertex and pixel shaders, four float16 render targets at once, 192 passes a frame; its music a .mid played through MCI's sequencer on MIRAGE's General MIDI synthesizer | 2026-11-05 |
| <img src="compat/win32-elevated-2009.png" width="160" alt=""> | Elevated (4K, Breakpoint 2009) | Direct3D 9 | 🟢 Renders | the mountains after about 1½ minutes of precalculation (24 G instructions): its height map through `D3DXFillTexture`, a quad cut by `D3DXTessellateNPatches` into a million triangles raised by a vertex shader | 2026-11-05 |
| <img src="compat/win32-ergon-2010.png" width="160" alt=""> | Ergon (4K, Breakpoint 2010) | Direct3D 9 | 🟢 Renders | at 60 frames a second: its height map a 1024x1024 float16 texture filled by its `tx_1_0` texture shader (`D3DXFillTextureTX`, HLSL's `noise()`), then raymarched | 2026-11-05 |
| <img src="compat/win32-atrium-2008.png" width="160" alt=""> | Atrium (4K, Breakpoint 2008) | Direct3D 9 | 🟢 Renders | after some 18 G instructions of precalculation: `D3DXCreateBox` meshes placed by an `ID3DXMatrixStack` and `D3DXVec3TransformCoordArray`, HLSL shaders | 2026-11-06 |
| <img src="compat/win32-luxo4k-2007.png" width="160" alt=""> | luxo4k (4K, RGBA & Conspiracy, 2007) | Direct3D 9 | 🟢 Renders | the fixed function: D3DX meshes, Direct3D's lights, "PIXAR" from `D3DXCreateText` in "times", which XP substitutes with Times New Roman | 2026-11-06 |
| <img src="compat/win32-valleyball-2009.png" width="160" alt=""> | Valleyball (4K, Breakpoint 2009) | OpenGL | 🟢 Renders | one raymarching GLSL shader on two triangles, its music from a thread; ends itself after some 100 s | 2026-11-06 |
| | Darwinism | Direct3D 9 | 🔴 Fails | its frames run headless; PRISM does not draw its fixed-function stage yet (COLOROP SELECTARG1 of the texture factor, no texture, no pixel shader), nor its stencil | 2026-11-06 |
| | Wishful Twisting | Direct3D 9 | 🔴 Fails | after 13 G instructions it calls `IDirect3DDevice9::Reset` with its creation parameters, not in PRISM yet; headless it then draws (an `ID3DXMatrixStack`, 700,000 calls a frame) | 2026-11-06 |
| | Stiletto | Direct3D 9 | 🟠 Starts | its skinned mesh and its nine Tahoma words are made and it presents headless; it draws with the fixed function (lights, material, no shader). Its camera moves | 2026-11-02 |
| | .kkrieger (farbrausch, 2004) | Direct3D 9 | 🟠 Starts | its first frames and generated textures headless; runs out of memory after four frames | 2026-11-03 |
| | Polystreptikum (2007) | Direct3D 9 | 🔴 Fails | past dx8vb.dll's D3DX math and its letters drawn into a DIB section, its synthesizer divides by zero: it plays the instruments of XP's `gm.dls`, which MIRAGE does not ship (read as zeros) | 2026-11-06 |
| | Synchroplastikum (2005) | Direct3D 9 | 🔴 Fails | past dx8vb.dll, stops on `CreateVolumeTexture` (on another branch), then on a cube texture's surface as a render target, which PRISM has not | 2026-11-06 |
| | Stripped (Numerica 2009) | OpenGL | 🟠 Renders, slowly | its first frame after some 29 G instructions (about 3 minutes in Chrome), then some 240,000 `glVertex3f` a frame: 20 M instructions a second | 2026-11-06 |

## Linux programs (MIRAGE-LINUX, `machines.html?m=linux`)

i386 Linux binaries with no Linux kernel: their system calls answered in JavaScript, X11 and OpenGL
drawn by PRISM's libraries, SVGAlib on the emulated VGA. Each is an OASIS image
(`oasis/images/linux/`) that fetches its programs from where their authors or Debian published them;
all captured in Chrome on 2026-11-05.

| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Image | Status | Notes | Run |
|---|---|---|---|---|
| <img src="compat/linux-mirage.png" width="160" alt=""> | Debian 12 i386 user space (`mirage`, `debian-bookworm`) | 🟢 Plays | a real bash with Debian's commands | 2026-11-05 |
| <img src="compat/linux-doom-1994.png" width="160" alt=""> | DOOM (id's linuxsdoom, 1994, SVGAlib) | 🟢 Plays | a.out and libc 4, unmodified; the attract demo | 2026-11-05 |
| <img src="compat/linux-doom-mini.png" width="160" alt=""> | DOOM, the smallest image (`doom-mini`) | 🟢 Plays | its shell, `linuxsdoom` one command away | 2026-11-05 |
| | DOOM built by gcc 2.7.2 (`doom-build`, `doom-x11`) | 🟢 Plays | builds DOOM from source on first run (about 9 minutes), then X11 DOOM; the build not re-run on 2026-11-05 | 2026-11-05 |
| <img src="compat/linux-quake-1997.png" width="160" alt=""> | Quake (1997) | 🟢 Plays | its demo loop | 2026-11-05 |
| <img src="compat/linux-quake-x11.png" width="160" alt=""> | Quake for X11 (`quake-x11-1997`) | 🟢 Plays | id's `quake.x11` 1.0 in a 640x400 window on XFree86 3.3 (Cirrus GD5446, 256 colours), under twm; its demos, its menu | 2026-11-10 |
| <img src="compat/linux-glquake.png" width="160" alt=""> | GLQuake 0.97 for Linux (`glquake-1997`, 3dfx) | 🟢 Plays | id's Voodoo build: `libMesaGL.so.2` and its fxMesa calls made in JavaScript, PRISM's `gl.js` on WebGL2, 640x480; SVGAlib's keyboard and mouse; its demos, its menu; ~37 fps in Chrome | 2026-11-10 |
| <img src="compat/linux-quake2-gl.png" width="160" alt=""> | Quake II 3.20 in OpenGL (`quake2-gl-1998`, `ref_gl`) | 🟢 Plays | `ref_gl.so` dlopens `libGL.so` (`+set gl_driver libGL.so`) and finds fxMesa by dlsym; 640x480, the gamma Glide read from `SST_GAMMA`; its demo, its menu; ~30 fps in Chrome | 2026-11-10 |
| <img src="compat/linux-quake2-x11.png" width="160" alt=""> | Quake II 3.20 on X11 (`quake2-x11-1998`, `ref_softx`) | 🟢 Plays | `ref_softx.so` (Xlib, MIT-SHM) in a 400x300 window on XFree86 3.3, under twm; its demo, its menu | 2026-11-10 |
| <img src="compat/linux-tuxracer.png" width="160" alt=""> | Tux Racer 0.61 (Sunspire Studios, 2001; `tuxracer-2001`, Debian woody's) | 🟢 Plays | Its own i386 binary on glibc 2.2.5, Tcl 8.3 and libstdc++ 2.95; libSDL, libGL and libGLU made in JavaScript (OpenGL on PRISM's gl.js, its mipmaps by PRISM's glu.js); the title, the menus, a practice race, the keyboard; ~47 fps in Chrome. The sound is off (SDL_mixer needs SDL's audio conversion and files) | 2026-11-23 |
| <img src="compat/linux-supertuxkart.png" width="160" alt=""> | SuperTuxKart 0.6.2 (2009; `supertuxkart-2010`, Debian squeeze's) | 🟢 Plays | Its own i386 binary on eglibc 2.11, PLIB 1.8.5 and libstdc++ 6; libSDL, libGL, libGLU and the GLUT shapes it uses made in JavaScript (PRISM's gl.js, its display lists); the menus, a race driven at the keyboard (the 4th place on the grid rolls back down its slope until you accelerate); ~50 fps in Chrome. No sound yet (OpenAL Soft finds no device); 100 MB of data | 2026-11-23 |
| <img src="compat/linux-quake2.png" width="160" alt=""> | Quake II 3.20 (`quake2-1998`, SVGAlib) | 🟢 Plays | id's libc5 build with the 1998 demo's data: `ref_soft.so` and `gamei386.so` through `dlopen`, 320x240 in mode X; its demo, its menu | 2026-11-10 |
| <img src="compat/linux-oasis-node.png" width="160" alt=""> | node in HLE (`oasis-node`, on BusyBox) | 🟢 Plays | JavaScript, not x86: MIRAGE's own `node` (Node 26's API in JavaScript, CommonJS and ES modules), a process of MIRAGE-LINUX started by BusyBox's x86 shell; scripts, `-e`, `-p`, pipes both ways, `#!/usr/bin/env node`; the same output as Node 26 on tools/node's scripts | 2026-11-26 |
| <img src="compat/linux-oasis-typescript-6.0.png" width="160" alt=""> | TypeScript 6.0's `tsc` (`oasis-typescript-6.0`, on `oasis/node`) | 🟢 Plays | JavaScript on MIRAGE's node: a file, a project with its tsconfig, declarations and source maps, its errors, `--init`, `--watch` -- the same output as on Node 26 | 2026-11-26 |
| <img src="compat/linux-oasis-npm-11.20.png" width="160" alt=""> | npm 11.20 (`oasis-npm-11.20`, on `oasis/node`) | 🟢 Plays | JavaScript on MIRAGE's node: `npm init`, `npm install` from the registry (71 packages for express and chalk), from a folder or a tarball, `npm run`, `npx`, `npm ls`, `npm pack` -- no `npm audit` | 2026-11-27 |
| <img src="compat/linux-oasis-python-3.15.png" width="160" alt=""> | CPython 3.15 for WASI (`oasis-python-3.15`, on BusyBox) | 🟢 Plays | WebAssembly, not x86: the CPython project's own WASI build, a process of MIRAGE-LINUX started by BusyBox's x86 shell; scripts, its stdlib and files; the REPL in Chrome (JSPI), not in Safari | 2026-11-26 |
| <img src="compat/linux-x11-1997.png" width="160" alt=""> | XFree86 3.3 (`x11-1997`) | 🟢 Plays | xterm and xclocks under twm on the emulated Cirrus card | 2026-11-05 |
| <img src="compat/linux-xboing-1997.png" width="160" alt=""> | XBoing, XBill, xjewel (1997) | 🟢 Renders | their title screens | 2026-11-05 |
| <img src="compat/linux-mesa-1997.png" width="160" alt=""> | Mesa's gears (1997), xscreensaver's GL hacks (1998) | 🟢 Renders | | 2026-11-05 |
| <img src="compat/linux-yellowrose-2003.png" width="160" alt=""> | Yellow Rose of Texas (2003) | 🟢 Renders | OpenGL 1.x in immediate mode | 2026-11-05 |
| <img src="compat/linux-metatunnel-2009.png" width="160" alt=""> | Clod, Laminator, Make it 4K, Metatunnel, Retrospection, To the Road of Ribbon (2005–2010) | 🟢 Renders | the scene's Linux GLSL intros | 2026-11-05 |

## The CPU

| Check | Result | Run |
|---|---|---|
| 🏅 test386 (the 80386 self-test) | passes, to POST FFh | 2026-10 |
| SingleStepTests, 8088 vectors | 423,736 vectors pass | 2026-07 |
| Unicorn comparison (`tools/test-x86-uc.mjs`) | all green | 2026-10-08 |
