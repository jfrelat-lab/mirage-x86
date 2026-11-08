# What's new

What changed on [mirage-x86.pages.dev](https://mirage-x86.pages.dev), and in MIRAGE for someone using it,
newest first. The site is updated continuously, so entries are dated rather than versioned. Every
change is in the [commit history](https://github.com/jfrelat-lab/mirage-x86/commits/main).

## 2026-11-08

- **Six intros drawn as on DOSBox-X**, three causes found with two new probes for the oracles:
  - **kaneda, paleozoa and upup** shift a 16-bit register by more than 16 bits, which Intel leaves
    undefined and no processor ignores: a Pentium rotates the source, a Pentium Pro and later shift
    destination, source and destination together (Bochs; `tools/shd16.asm` on DOSBox-X and QEMU).
    MIRAGE answered with the register unchanged; it now follows the processor it is set to be.
    crevenge, which uses the Pentium Pro's FUCOMI, is tested as one.
  - **nibble, soullost and 256bytef** read the 8x8 font at F000:FA6E, where every PC BIOS keeps it;
    MIRAGE's ROM held zeros there, so their text was blank.
  - **256bytef and kaneda** seed their randomness from the timer without programming it. The BIOS
    leaves it counting down by two (mode 3), as DOSBox-X does (`tools/pit40.asm`); MIRAGE now does too.

## 2026-11-06

- **x87 at single precision, as the hardware does it**: a result is rounded to 24 bits of significand
  but keeps the x87's own exponent range (a tiny product no longer becomes 0), and loading the
  control word mid-block takes effect at once. kkrieger's power function, 2,400 calls, now matches
  Visual C++'s build of it under Wine on QEMU bit for bit (342 of 2,400 before).
- **The home page plays Elevated as a video**, with a button for its music; the README shows it as an
  animated WebP (1 MB instead of a 4 MB GIF, every colour), the GIF kept for older browsers.
- **Record what you see**: the Machines page has a Record button. It saves the screen and its sound
  as an MP4 (WebM where the browser writes no MP4). For the repository, `tools/record.mjs` films a DOS
  title headless, a frame every 1/30 s of guest time with its Sound Blaster, OPL3 or MIDI sound, so
  no frame is dropped whatever the computer's speed; `tools/webp.mjs` makes animated WebPs, a quarter
  of a GIF's size with every colour.
- **Three more Windows intros**, each a click away in the Windows machine: **Atrium** (Breakpoint
  2008), **luxo4k** (RGBA & Conspiracy, 2007, its lamp hopping on "PIXAR") and **Valleyball**
  (Breakpoint 2009). MIRAGE-WIN32 gained D3DX's matrix stack and boxes, more of Direct3D 9's
  transforms, DIB sections, Windows XP's font substitutions ("Times" is Times New Roman) and
  dx8vb.dll's math, which Polystreptikum and Synchroplastikum load.
- **Windows 2000 reaches its desktop** in the bare PC (256 MiB, `pentiumpro`, PCI), given a faster
  headless clock. Two faults stopped it. The hard disk reported the 128 heads of its partition table
  to the controller, which has room for 16: Windows' disk driver addresses by cylinder, head and
  sector, so head 72 or 80 spilled into the drive-select bits and the read went to a drive that is not
  there. The disk now reports 16 heads and 63 sectors, as QEMU's and a real one do. Then Windows'
  microcode updater wrote the update trigger register, which was a fault; the write is now taken.
- **Second Reality plays** (Future Crew, 1993): choose the SoundBlaster Pro at its set-up and the
  demo runs with its music. Its credits are drawn once and it runs on past the spaceship: PIT
  counter 0 now counts by two in mode 3, as an 8254 does (the demo measured its frame at half its
  length and starved its own drawing), and a part ending frees the memory it allocated. Its loader is a scheduler driven by the single-step trap, and an `INT n` was wrongly followed by a
  trap (DOSBox-X counts 9 traps on the new probe `tools/inttrap.asm`, MIRAGE counted 11); it also
  needed INT 21h AH=55h, a child PSP, and a child that ends without ending its parent.
- **386BSD's console shows whole**, to `login:`. Its kernel zeroes the BIOS data area, where MIRAGE
  read the number of text rows, and drew one row; the text screen's size now comes from the video
  card's own registers, as on real hardware and in QEMU.
- **Windows ME, Linux 3.x and TinyCore no longer freeze**: the recompiler's memo of past translations
  was bounded by a count of blocks, each holding its compiled function; once paged blocks grew it held
  1.3 GB and the host spent 99 % of its time collecting garbage. It is now bounded by the source it
  holds, as the code cache is. Windows ME reaches its desktop again, OpenBSD its `login:`.
- **COMPATIBILITY.md, reorganized**: games and demos in separate tables, each in alphabetical order;
  🏅 marks the titles the golden test pins, and each golden intro and demo has its own row and
  picture. Maniac Mansion and Jump 'n Bump are shown in play: neither had a keyboard problem, the
  scripted runs simply never pressed what each game waits for.

## 2026-11-05

- **Windows NT 3.51 reaches Program Manager** in the bare PC (64 MiB, `586`, PCI). An IRET to a code
  segment whose privilege does not match its selector now faults, as on a real processor: NT ends
  every BIOS call its video driver makes on exactly that fault, and without it NT never switched to
  graphics.
- **KolibriOS, xcom144 and FreeNOS boot again** in the bare PC. A compatibility sweep found all three
  stopped since late October, each by a speed-up of the recompiler: an instruction it cannot translate
  inside a short skipped run of code, a stack with a base (HDPMI32's), and a page fault raised while
  translating code that never runs. Each is fixed and has a test.
- **COMPATIBILITY.md** re-run in full, with pictures: each DOS game's title and a moment of play,
  drawn by MIRAGE's own renderer from a scripted headless run (`tools/compat-shots.mjs`, the keys of
  each title in `tools/compat-shots.json`); every system where it boots or stops; a Linux section.
- **Jazz Jackrabbit plays**: Borland's RTM now runs on MIRAGE's DPMI host, after ten fixes found by
  tracing it: the raw mode switch, a resident program leaving protected mode, AX after a TSR, the
  parent's path in a shared environment, the "MS-DOS" vendor API, selectors in DOS and BIOS answers,
  exception frames on the host's stack, segment loads that fault, DPMI 0400h, and protected-mode
  addresses in the palette and string calls.
- **`?xms=0` and `?ems=0`** in the DOS player start it without that memory manager: **Zone 66**, which
  refuses any XMS driver (on DOSBox-X too), shows its title.
- **Windows 3.0 in all three modes**: real, standard and 386 enhanced, each to Program Manager.
- **Pinball Fantasies' menus whole**: a 16-colour screen that doubles its lines (CRTC double scan) was
  drawn twice as tall, its lower half the memory below the menu.
- **Five more DOS games run**: Raptor (on MIRAGE's DPMI host), Halloween Harry, Bio Menace, Major
  Stryker and Jill of the Jungle; **BeOS 5 reaches its desktop**.
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
