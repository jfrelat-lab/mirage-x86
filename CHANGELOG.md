# What's new

What changed on [mirage-x86.pages.dev](https://mirage-x86.pages.dev), and in MIRAGE for someone using it,
newest first. The site is updated continuously, so entries are dated rather than versioned. Every
change is in the [commit history](https://github.com/jfrelat-lab/mirage-x86/commits/main).

## 2026-11-14

- **StarCraft reaches its first mission**: the main menu, a player made, the Terran prequel's text, its
  briefing, then the mission's map, units and interface. `GetLastError` answered 0 whatever was set:
  Storm.dll sets ERROR_IO_PENDING itself while its loading thread reads a file and reads it back, and a
  0 there was "unknown error 0x00000000" (each thread now keeps its last error; a file not found leaves
  2). `WaitForMultipleObjects` ignored bWaitAll and returned at the first object signalled: the game,
  waiting for all its loads, drew a sprite not read yet and faulted. Blizzard's network providers
  (`standard.snp`, `battle.snp`) load: the serial port calls (none), `GetComputerNameA`, `GetDCEx`,
  `CharLowerBuffA`, `CreatePatternBrush`.

## 2026-11-13

- **StarCraft's shareware installer runs, and the game starts**: Blizzard's installer (1998) shows its menu
  -- drawing into an 8-bit DIB section now lands in its memory, as indices of its own colours; it was
  ignored, and the menu, composed in one, never showed -- then its licence, the install directory (a tree
  view, the shell's desktop folder and allocator as COM objects with nothing in them, Explorer's folders
  in the registry), and installs the game, its fonts encrypted into its MPQ (`ddraw.dll` has XP's
  version; DirectX's version is in the registry). The game then opens its archive: a DLL loaded with the
  program gets a non-NULL `lpvReserved` in its `DllMain`, as Windows passes it -- Storm.dll, given NULL,
  believed itself loaded by `LoadLibrary` and recomputed its MPQ crypt table with another seed, and no
  file of its archives was found. It sets its 640x480 mode and stops on its first file read through
  Storm's loading thread. Some 40 calls more (dates and times, disk space, `crtdll.dll` with msvcrt's
  C functions, registry enumeration, text extents). `tools/win32/run.mjs`: `MIRAGE_W32STUBS=list`,
  `MIRAGE_W32DUMPDIR`, `MIRAGE_W32MEMDUMP=abs:...`.
- **WinQuake through DirectDraw**: SciTech MGL looks for `system32\ddraw.dll` on the disk before it offers
  DirectDraw's modes, and found nothing there, so WinQuake fell back to GDI; a DLL made here is now found
  in the system directory. Then MGL asked the primary surface for its back buffer with
  `EnumAttachedSurfaces`, which never called back, and asked again forever. WinQuake's page now starts it
  without `-dibonly`: full screen through DirectDraw at 320x200, the windowed modes still in Video Options.
- **List boxes, combo boxes and group boxes in Windows dialogs**: a drop-down list opens on a click and a
  click chooses, the arrow keys move along it; a group box is its frame and caption, the controls inside it
  showing and taking the clicks; a static's long text breaks into lines. 3D Pinball's Player Controls opens
  and works -- it crashed: a message to a dialog's control left four bytes on the stack each time.
- **GDI's raster operations and monochrome bitmaps**: BitBlt and StretchBlt combine their source with what
  is there (AND, OR, XOR...) instead of copying it, and a black-and-white bitmap takes the colours of the DC
  it is drawn on -- Solitaire's empty places are the felt's green with their dotted outline, not white. A
  window that clips its children no longer draws over them: a card dragged over Solitaire's status bar left
  green there.
- **Splash screens sit on the Windows desktop**: a window with no caption that a program places in the
  screen's middle (Jazz Jackrabbit 2's Epic banner) is shown there, on the desktop, not stretched over the
  whole screen; the screen is the desktop's blue while a Windows program starts, not black; and 3D
  Pinball's table no longer waits two seconds behind a grey screen once its splash is gone.
- **A Windows program that quits leaves the desktop and its icon**: once it has ended well, the Windows
  machine shows the desktop with the program's own icon in its corner; a click starts it again. A program
  that ends in an error keeps its last picture and the message.
- **Windows' message boxes are shown**: MessageBox opens a box over its window and waits for a button
  (OK, Yes, No...), Enter pressing the one with the focus. It was only written in the log, so FreeCell's
  "That move is not allowed." went unseen.
- **The Windows desktop's size is the visitor's choice**: 640x480 to 1920x1080 beside the Windows
  machine's buttons, 1024x768 as before; a game's 640x480 window fills more of the screen on 800x600.
- **A Windows program can read its own file**: the page left the program's .exe out of its disk, and
  Half-Life's launcher, which reads itself to check it, stopped at "Could not validate Half-Life".
- **Windows programs have a text font in the page**: a program whose image names no font drew no text in
  its dialogs, buttons and message boxes; DejaVu Sans now stands in for Arial, as the font mapper's last choice.
- **Dialogs over a full-screen Windows program**: a dialog over a program that set its own display mode
  (Half-Life's launcher, at 640x480) was made and never drawn, the program waiting on it.
- Drawing into a Windows program's window that is not shown yet leaves the desktop as it was (a black
  rectangle stayed under Half-Life's intro).

## 2026-11-12

- **Jazz Jackrabbit 2 plays on MIRAGE-WIN32**: Epic MegaGames' shareware of 1998, unmodified, in its
  window on the Windows desktop: the Orange Games logo, the intro video, the menus, the demos and the
  game, with its sound. Its installer is read in the page, not run (Epic's own format, fetched from the
  Internet Archive's collection of Epic's freely released files).
- **Abuse plays on MIRAGE-WIN32**: Crack dot Com's shooter of 1996 in Xenoveritas' SDL 2 port for
  Windows (GPL, 2022), a Visual C++ 2022 program with its SDL DLLs beside it, fetched from its release.
- **The x87 copies 64-bit integers exactly**: FILD and FISTP of a 64-bit integer kept only 53 bits, as
  a float64 does, and programs of the Pentium's time move memory eight bytes at a time through the FPU.
  Jazz Jackrabbit 2's video came out with one column in eight wrong.
- **A Windows program's keyboard hook is called** (WH_KEYBOARD), as Jazz Jackrabbit 2 reads its keys.
- **Windows' menus, dialog boxes and timers**: a window's menu bar is drawn under its caption and its
  menus open, checked and greyed as the program says (Jazz Jackrabbit 2's Game, Video, Music and Help);
  modal dialog boxes run over their window -- their fields typed in, Tab going from one control to the
  next, check boxes and radio buttons drawn; timers tick; keyboard accelerators work. Windows' own Minesweeper, Solitaire, FreeCell and 3D Pinball of Windows 2000 and NT 3.51,
  and Spider of Windows ME, play with them, run locally as tests -- Microsoft's, so not offered here.
- **A window procedure's answer reaches the program**: every message MIRAGE sent a Windows program came
  back with the same wrong result, so a dialog's default handling never ran.
- **Videos through MCI**: an AVI a Windows program plays with MCI (8-bit, uncompressed or Microsoft
  RLE, with PCM sound) is decoded in JavaScript and drawn into its window on the program's clock, its
  sound played; Escape breaks it where the program says so. Half-Life's intro plays so (run locally).
- An idle Windows program no longer spins: waiting for a message took 150 seconds of a computer's time
  for 5 of the program's.
- Underneath, for programs to come: a Visual C++ 2015+ program's runtime (the Universal CRT) and the
  Unicode calls of the 2000s, an imported DLL's start before the program's, thread-local storage, folders
  on the program's disk, a Japanese system's code page, DirectDraw surfaces GDI draws on, DirectInput with
  no controller, multimedia timers, and two threads asleep at once no longer sharing one deadline.

## 2026-11-11

- **The x87's FPTAN, FSIN, FCOS and FSINCOS clear C2** for an argument in range, as the real chip does.
  Microsoft's C runtime checks that flag after FPTAN; left set, `tan()` took its out-of-range path, and a
  program in Quake's single-precision mode got a NaN where its view's projection should be: Half-Life's
  engine ran with nothing on the screen but its titles.

## 2026-11-10

- **GLQuake and Quake II in OpenGL on Linux**: id's 3dfx builds of 1997 and 1998, written for a Voodoo
  card, unmodified: their `libMesaGL.so.2` (Mesa on Glide, with the fxMesa calls that open the card's
  full screen) is made in JavaScript and draws with PRISM's OpenGL on WebGL; keyboard and mouse are
  SVGAlib's, as on a 1997 PC. Quake II's brightness comes through as the Voodoo took it, from the
  `SST_GAMMA` the game puts in its environment. Around 30 to 40 frames a second in Chrome.
- **Quake and Quake II for X11**: id's windowed Linux builds of 1997 and 1998, unmodified, in windows
  on XFree86 3.3 under twm, on the emulated Cirrus card (Quake 640x400, Quake II's `ref_softx`
  400x300); their demos and their menus.
- **Quake II for Linux**: id's Linux build of 1998 (3.20, SVGAlib), unmodified, with the demo's data:
  `quake2` loads its renderer and its game with `dlopen`, draws in 320x240 (the VGA's unchained "mode
  X", programmed by SVGAlib itself), plays its demo and answers its menu. Two fixes for every Linux
  program: large anonymous memory is committed page by page as it is touched, as a kernel does (Quake
  II asks for tens of megabytes and uses a few), and a VGA programmed into mode X without the BIOS
  now shows.
- **DirectDraw**: full-screen 2D of 1995-2002 (DirectX 1-3's interfaces): display modes in 8, 16 and
  32 bits, a primary surface and its back buffer, flips, copies with colour keys, palettes that change
  the screen at once. Quake II's software renderer now runs full screen through it, as on a PC,
  and changes resolution from its Video menu.
- **Quake II in OpenGL too**: the same demo with its OpenGL renderer, full screen, about 45 frames a
  second in Chrome. Its Video menu changes the resolution (800x600) and the picture follows; a new
  game starts from the menu and the mouse turns the view, in OpenGL as in the software renderer.
  MIRAGE learnt the stack layout of 78 more OpenGL 1.x functions from PRISM's own table of them.
  A fault found on the way: the game's DLLs were placed where the OpenGL layer allocates its strings,
  and the first `glGetString` overwrote `ref_gl.dll`'s code.
- **The frame rate shown is the program's**: the Machines page counted its own refreshes, which follow
  the monitor (144 on a 144 Hz screen while Elevated drew 60). It now shows the frames the program
  presents each second, and the most it could present at the speed the computer emulates and draws
  it ("44 fps · max ≈ 44": WinQuake, every instruction it can get; "47 fps · max ≈ 120": GLQuake,
  waiting for the page to show each frame).
- **Quake II runs in the browser**: id Software's demo of March 1998, unmodified, in a window on the
  desktop, its sound included; the menu, the console, the screen sizes (`sw_mode`) and the mouse in
  play work. It is the first program here that brings DLLs of its own: `quake2.exe` loads its
  software renderer (`ref_soft.dll`) and the game (`gamex86.dll`) from its directory, and MIRAGE-WIN32
  now maps them as Windows does — relocated, their imports bound, their `DllMain` run. Winsock now
  starts, on a network with nobody else on it, since Quake II refuses to start without it.
- **Windows, corrected along the way**: a window created visible is activated at once (Quake II only
  takes the mouse once activated); `AdjustWindowRect` adds the frame; a window re-created after
  another was destroyed is shown; a window partly off the screen no longer paints the desktop white.

## 2026-11-09

- **GLQuake runs in the browser**: id Software's OpenGL Quake of August 1997, unmodified, its
  OpenGL 1.1 drawn through WebGL by PRISM's `gl.js` — full screen, or in a window on the desktop with
  `-window`. It needed five more OpenGL calls (`glAlphaFunc`, `glTexEnvf`, `glDepthRange`,
  `glTexSubImage2D`, `glReadPixels`), `InitCommonControls` and `GetDlgItem`.
- **Windows programs have windows**: a program's window with a caption is drawn on a 1024x768
  desktop, as Windows 2000 and XP's classic style draw it, with its frame, its title and a close
  button, and the cursor. A window is moved by its title bar, and the program learns where it went
  (WinQuake keeps its place). The close button asks the program to close. The desktop, the frame and
  the cursor are drawn on the emulated screen, so screenshots and the Record button show them. Full-screen
  programs, the intros among them, keep the whole screen as before. WinQuake's `-startwindowed` opens
  its 320x240 window on the desktop.

## 2026-11-08

- **Windows' own messages reach a program's window**, as Windows sends them before the call returns: on
  creation (`WM_NCCREATE`, `WM_CREATE`, `WM_SIZE`, `WM_MOVE`), on first showing (`WM_SHOWWINDOW`, activation,
  focus), on painting, resizing and destruction; `SendMessageA` and `PostMessageA` work. The 25 Windows
  intros behave exactly as before.
- **WinQuake's video modes**: `vid_mode 2` gives an 800x600 window, the screen following the size a
  program gives its window (`SetWindowPos`, `MoveWindow`) and the frame its style has (`SetWindowLongA`).
- **WinQuake runs in the browser, with no Windows**: id Software's own `winquake.exe` of March 1997,
  unmodified, with the shareware episode, one click away in the Windows machine. Its sound plays
  through DirectSound, and the keyboard and mouse reach it as window messages. MIRAGE-WIN32 gained
  what a full game asks beyond an intro:
  - Visual C++'s runtime start-up;
  - GDI's 8-bit DIB sections, palettes and `StretchBlt`, drawn on the card's framebuffer;
  - the message queue, with `DispatchMessageA` running the game's window procedure;
  - Winsock for a machine with no network, and an empty registry.
  A fault was fixed on the way: `VirtualAlloc` handed out addresses inside the heap. `tools/win32/run.mjs`
  now takes arguments, a directory of files, scripted keys and screenshots, and can name the first
  function a program calls that is not made yet.
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
