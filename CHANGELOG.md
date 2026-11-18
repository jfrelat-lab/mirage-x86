# What's new

What changed on [mirage-x86.pages.dev](https://mirage-x86.pages.dev), newest first. The details are in
the [commit history](https://github.com/jfrelat-lab/mirage-x86/commits/main).

## 2026-11-18

- **Warcraft III's demo installs and starts** on the Windows machine, its 3D main menu with its buttons' text (tested locally).
- **Windows games run faster**: floating-point work and the C library's sorting no longer take the slow road (Warcraft III's menu from 24 to some 36 frames a second).

## 2026-11-17

- **Winamp 2.95 plays MP3s** on the Windows machine, in its built-in skin, with AVS visualisations (tested locally).
- **Windows dialogs** have their frames and captions, overlapping windows cover one another as on Windows, and tree views are drawn and work.
- **Windows programs' text and pop-up windows** are drawn where they were missing, and a program's first dialog is centred as on Windows.
- **Windows' look, checked against Windows 2000**: captions with their icons and buttons, menus and buttons in Windows' font, focus rectangles, scroll bars, message box icons, windows at their right size.
- **Windows' common controls**: tabs, progress bars, sliders, spin buttons, lists with columns, toolbars and status bars are drawn and work.
- **Macromedia Flash Player 8** (the standalone player) plays Flash movies on the Windows machine (tested locally).
- **Windows programs speak your language**: a program that ships several takes its menus and texts in your browser's language.
- **Quake III Arena's demo installs and plays** on the Windows machine (tested locally).
- **Windows setup programs**: their texts, licences and destination folders work (Installer VISE's).

## 2026-11-15

- **Deltarune Chapter 1 (2018) starts on the Windows machine** and draws its intro (tested locally): Direct3D 11 games begin.
- **Diablo's shareware plays** on the Windows machine: its menus, a hero made, Tristram (tested locally).
- **Windows text in Arial, Times New Roman and Courier New** takes the room it takes on Windows.
- **Jazz Jackrabbit 2 plays again**: it stopped at start since 2026-11-13.
- **The Undertale demo (2013) plays on the Windows machine, with its music and sounds** (tested locally):
  GameMaker 8's games, written in Delphi and drawn with Direct3D 8, run.

## 2026-11-14

- **StarCraft's shareware demo plays its first mission to victory** (tested locally; its licence forbids
  offering it here).
- **The mouse in Windows games**: a game that draws its own cursor follows the pointer directly; the
  pointer is only locked for games that aim with the mouse.

## 2026-11-13

- **WinQuake runs full screen through DirectDraw**; its windowed modes remain in Video Options.
- **StarCraft's installer runs and installs the game** (tested locally).
- **Windows dialogs**: drop-down lists, list boxes and group boxes work.
- **Windows drawing**: Solitaire's empty places and dragged cards are drawn correctly.
- **The Windows desktop**: splash screens sit in the middle of the desktop, message boxes are shown, a
  program that quits leaves its icon to start it again, and the desktop's size can be chosen (640x480 to
  1920x1080).
- **Windows programs have a text font** in their dialogs and buttons.

## 2026-11-12

- **Jazz Jackrabbit 2** (shareware, 1998) plays on the Windows machine, with its intro video and sound.
- **Abuse** (1996, SDL 2 port) plays on the Windows machine.
- **Windows menus, dialog boxes and timers**: Minesweeper, Solitaire, FreeCell, 3D Pinball and Spider play
  (tested locally; they are Microsoft's).
- **Videos**: AVI files played by Windows programs are shown, with their sound.
- An idle Windows program no longer uses the computer's CPU for nothing.

## 2026-11-11

- **Half-Life's engine draws its levels** (tested locally).

## 2026-11-10

- **Quake II** (demo, 1998) on the Windows machine: software and OpenGL renderers, full screen, its menus,
  sound and mouse.
- **GLQuake and Quake II in OpenGL on Linux**: id's 3dfx builds, drawn through WebGL.
- **Quake and Quake II for X11 and SVGAlib on Linux**, unmodified.
- **DirectDraw**: full-screen Windows games of 1995-2002 can run.
- **The frame rate shown is the program's**, not the browser's.

## 2026-11-09

- **GLQuake** (1997) on the Windows machine, full screen or in a window.
- **Windows programs have windows** on a desktop: moved by their title bar, closed by their button.

## 2026-11-08

- **WinQuake** (1997) on the Windows machine, with its sound, keyboard and mouse — no Windows needed.
- **Six DOS intros are drawn as on DOSBox-X** (kaneda, paleozoa, upup, nibble, soullost, 256bytef).

## 2026-11-06

- **Record what you see**: the Machines page saves the screen and its sound as a video.
- **The home page plays Elevated as a video.**
- **Three more Windows intros**: Atrium, luxo4k and Valleyball.
- **Windows 2000 reaches its desktop** in the bare PC.
- **Second Reality plays** (choose the SoundBlaster Pro at its set-up).
- **386BSD's console** shows whole; **Windows ME, Linux 3.x and TinyCore** no longer freeze.
- **The compatibility list** is reorganized, with pictures.

## 2026-11-05

- **Windows NT 3.51** reaches Program Manager; **Windows 3.0** runs in all three modes; **BeOS 5** reaches
  its desktop; **KolibriOS, xcom144 and FreeNOS** boot again.
- **Jazz Jackrabbit, Raptor, Halloween Harry, Bio Menace, Major Stryker and Jill of the Jungle** run in the
  DOS player; **Zone 66** with `?xms=0`; Pinball Fantasies' menus are whole.
- **Faster** DOS and Linux programs.

## 2026-11-04

- **Faster DOS code**: the DOS player now runs ahead of native DOSBox-X on BYTE's Sieve.
- **How MIRAGE compares** with other emulators:
  [COMPARISON.md](https://github.com/jfrelat-lab/mirage-x86/blob/main/docs/COMPARISON.md).
- **What's new**: this page.

## 2026-11-03 — public launch

- **The repository and the site are public**, under the MIT licence:
  [github.com/jfrelat-lab/mirage-x86](https://github.com/jfrelat-lab/mirage-x86).
- **Four machines on one CPU**: the DOS player, the bare PC, Linux programs with no kernel, Windows
  programs with no Windows.
- **34 OASIS images**: DOS games, Linux programs of 1994-1998 (DOOM, Quake, XFree86), the scene's OpenGL
  and Direct3D intros — each fetched from where its authors published it, with its source and licence.
- **General MIDI music** for the intros that use it.
