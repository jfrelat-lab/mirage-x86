# Changelog

What changed for someone using MIRAGE, newest first. The commit history has every step.

## 2026-11 — first public release

- **Four machines on one CPU**: the DOS player (`dos.html`), the bare PC (`boot.html`), Linux
  programs with no kernel and Windows intros with no Windows (`machines.html`).
- **OASIS images**: 34 recipes of the period PC — DOS games, Linux programs of 1994–1998 (DOOM,
  Quake, XFree86 3.3 and its games, gcc 2.7.2 building DOOM, Mesa), the scene's Linux and Windows
  OpenGL intros, and Direct3D 9 intros, Elevated and Ergon among them — each program fetched from where its
  authors published it.
- **Faster paged code**: under paging a translated block goes on through forward branches, short
  loops and followed calls; Linux programs run Dhrystone at 420–450 M x86 instructions a second,
  Windows 98 reaches its desktop in 34 s.
- **Browser timing**: PIT counter 0 counts real time in the page and no retrace is missed between
  two steps of the host's clock — Future Crew's Unreal runs at its own speed.
- **PIT**: counter 2 counts at counter 0's clock, and counter 0 reads back in phase with the
  interrupts it drives: Linux 2.2 boots again (it found a 1193 kHz processor and a "lost" timer).
- **x87**: FIST/FISTP store the integer indefinite on overflow and raise IE; FNCLEX clears the
  exception flags.
- **Sources and licences**: the FreeDOS disk's source is served beside it (`sources/freedos/`, and a
  GitHub release); each OASIS image has a *source & licence* dialog — its terms, and where every layer
  comes from — with a caution where the terms are not free (Quake's shareware licence).
- **The home page**: four shelves (DOS, Linux, Windows, Boot), the Windows intros on it at last, each
  card tagged with what it uses and 🔊 where its sound was heard playing in MIRAGE; MIRAGE's own test
  programs and the weaker intros left to the Machines page.
- **General MIDI**: an MPU-401 at 330h (UART mode), winmm's midiOut and MCI's sequencer, played by
  a small synthesizer of MIRAGE's own (no Roland or Microsoft sound set): Difúze, omniscent and
  Photon Race 2 have their music. The Standard MIDI File player was checked against Wine's MCI
  sequencer on Photon Race 2's song: the same messages, in the same order, at the same times.
- **MIRAGE-WIN32**: CreateFileA, WriteFile and DeleteFileA on a small disk of the program's own.
