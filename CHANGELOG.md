# What's new

What changed on [mirage-x86.pages.dev](https://mirage-x86.pages.dev), and in MIRAGE for someone using it,
newest first. The site is updated continuously, so entries are dated rather than versioned. Every
change is in the [commit history](https://github.com/jfrelat-lab/mirage-x86/commits/main).

## 2026-11-05

- **KolibriOS, xcom144 and FreeNOS boot again** in the bare PC. A compatibility sweep found all three
  stopped since late October, each by a speed-up of the recompiler: an instruction it cannot translate
  inside a short skipped run of code, a stack with a base (HDPMI32's), and a page fault raised while
  translating code that never runs. Each is fixed and has a test.
- **COMPATIBILITY.md** re-run in full, with a small picture of every title, and a Linux section.
- **Faster byte and word arithmetic**: CoreMark under MIRAGE-LINUX 990 → 1,056 iterations a second,
  Dhrystone 870,000 → 900,000 a second, and the DOS intros up to a fifth faster (puls, kaneda).
- **The header's Star button** is the home page's own, in the accent green.

## 2026-11-04

- **Faster DOS code**: without paging, a translated block now runs on through forward branches and
  its own loop, stopping at each place it used to end to do the checks the dispatcher did there, so
  timer interrupts land on the same instruction and every golden run is unchanged. BYTE's Sieve runs in
  4.9 s headless (7.5 s before) and 6.7 s in the page (11.1 s), ahead of native DOSBox-X's 6.2 s;
  DJGPP's Dhrystone 466,000 a second headless (320,000), CoreMark 608 iterations a second (402).
- **What MIRAGE does that the others do not**, and how far its OpenGL and Direct3D 9 go — fixed
  pipeline, GLSL, HLSL, shader bytecode — and its AVX, in
  [COMPARISON.md](https://github.com/jfrelat-lab/mirage-x86/blob/main/docs/COMPARISON.md).
- **What's new**: this page, read from `CHANGELOG.md` in the repository.

## 2026-11-03 — public launch

- **The repository and the showcase are public**: [github.com/jfrelat-lab/mirage-x86](https://github.com/jfrelat-lab/mirage-x86)
  under the MIT licence, the site at [mirage-x86.pages.dev](https://mirage-x86.pages.dev), the FreeDOS
  disk's packages and their source released as
  [freedos-1.4-sources](https://github.com/jfrelat-lab/mirage-x86/releases/tag/freedos-1.4-sources).
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
