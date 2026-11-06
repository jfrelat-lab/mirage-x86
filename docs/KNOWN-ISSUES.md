# MIRAGE — Known issues

What does not work, with the cause when it is known. Each entry says what is established and what
is only suspected. What is planned about them is in [ROADMAP.md](ROADMAP.md); what runs is in
[COMPATIBILITY.md](COMPATIBILITY.md).

## Missing hardware

| Missing | Consequence |
|---|---|
| Sound | No Gravis Ultrasound. ADPCM and recording play silence. General MIDI plays through MIRAGE's own small synthesizer, not a Roland or Microsoft sound set: the notes are the program's, the timbres are approximations. |
| A network card | Systems run without a network; QNX's demo disk stops asking for one. |
| ACPI | ReactOS (installed for an ACPI machine) stops in its kernel: "did NOT find RSDT". |
| A floppy *controller* | The BIOS serves drive A:, but a system that drives the controller itself cannot read a floppy. |
| IDE bus-master DMA | The registers exist and move no data; disks and the CD-ROM are PIO only. |
| SSE3 and later, FXSAVE, 64-bit mode | The profiles stop at a Pentium 4: MMX, SSE and SSE2 (`pentiummmx`, `pentium3`, `pentium4`). |
| An 80-bit x87 | Floating point is IEEE double. Programs that depend on extended precision differ. |
| USB, a local APIC, more than one processor | — |

## Systems that do not boot

| System | Where it stops | Cause |
|---|---|---|
| Windows 2000 | its boot screen, progress bar empty | **Unknown.** After calibrating its delay loop it touches no device again. Not a matter of speed alone: it idles at 20 times the default clock rate too. |
| ReactOS 0.4.15 | a stop in the kernel | **Known**: no ACPI tables. |
| Plan 9 (9legacy) | after the kernel is entered | **Known**: it runs with an instruction pointer above FFFFh in a 16-bit code segment, which MIRAGE does not handle. |
| Damn Small Linux 4.4.10 | a black screen at runlevel 5 | **Unknown**: not investigated — it may only be slow. |
| 386BSD 1.0 | not stopped: `login:` is in video memory | **Display**: once the kernel has the console, the screen is drawn as one text row (640×16). Not investigated. |
| XCOM (`xcom144.img`) | its 640×480 screen draws as noise | **Display, suspected**: the system runs (HDPMI32, its FreeDOS); the picture has been noise since at least 2026-10-20. |

## Time

- **Headless, a guest second is 3.32 million instructions**, whatever the processor profile (the
  PIT's rate, set to match DOSBox's work per frame). In the page the clock is real time and the
  processor runs as fast as the host. A late system run headless sees a slow processor; this is not
  what stops Windows 2000 (above). A rate per profile is on the roadmap.
- **The real-time clock starts at 1 January 1990, 08:00** in headless runs, so that runs repeat
  exactly; a guest then sees files "from the future". `MIRAGE_RTC=hostdate` starts it at the host's
  date instead.
- **The timer interrupt rate is capped** at about 1165 Hz (a reload of 1024 PIT ticks; 291 Hz until
  2026-10-11). Keen 4 and Wolf3D ask for 561 and 700 Hz and get them; Chrome Revenge asks for 17.5 kHz
  and gets 1165. `MIRAGE_PITFLOOR` lowers the floor.
- **The second compilation tier is off** (`MIRAGE_TIER2=1` turns it on for work on it): a fused loop
  could run unbounded work in one slice.

## The DOS player

- **Uncapped speed is too fast** for games paced by neither the timer nor the retrace (the Commander
  Keen menus). `?mhz=` caps it.
- **EXEC after a last-fit allocation**: a child is placed above the highest allocated block, not in
  the largest free one as DOS does, so a program that allocates at the top of memory (last fit) and
  then runs another fails with "insufficient memory".
- **INT 21h**: the FCB file calls (open, read, write, find by FCB) and AH=5Dh are missing.

## Programs

Per-title status is in [COMPATIBILITY.md](COMPATIBILITY.md). The failures with a known cause:

| Program | Cause |
|---|---|
| Lemmings | needs a raw floppy (it reads its disk by INT 13h); the files alone are not enough |
| Second Reality | derails to 0000:0000 at start |
| C-Dogs 1.06 | silent: its DSIK Sound Blaster driver polls the 16-bit DMA channel 5's count and plays nothing. Not investigated further |
| oktaeder | programs PCI hardware directly and relies on a register DOS leaves by accident; it derails on DOSBox-X too |
| Heretic without our DPMI host | its bound DOS/4G faults after entering protected mode by itself |

## Windows programs (MIRAGE-WIN32)

| Missing | Consequence |
|---|---|
| DirectDraw, DirectSound, DirectInput | Programs that need them stop; luxo4k shows a message box and exits for want of DirectSound. |
| Direct3D 9 without shaders | PRISM's `d3d9.js` draws with HLSL shaders; the fixed function, vertex declarations, stencil, alpha test and `Reset` are not there yet. |
| D3DX beyond HLSL | Shader assembly, `ID3DXFont`, effects and sprites are not done. Meshes, skins, N-patches, normals, adjacency, `D3DXFillTexture`, texture shaders (`D3DXFillTextureTX`) and text meshes (`D3DXCreateText`) are. |
| Windows fonts | MIRAGE ships none. An image lists the ones it selects (`machine.fonts`); the page reads the visitor's own (Chrome's Local Font Access, after asking) or else uses DejaVu Sans, whose shapes and widths differ. Glyphs are not hinted. |
| One emulated core | Threads take turns on one CPU at about 200 M instructions a second: Darwinism (180 M x87 instructions a frame) draws a frame a second, Valleyball's synthesizer keeps up at 0.97 of real time, Stripped's precalculation lasts minutes. |
| gdi32's ordinals | Crinkler's /RANGE imports by ordinal; MIRAGE's gdi32 does not number its exports as Windows XP's (no intro met needs it yet). opengl32's and d3dx9's are numbered as Microsoft's. |
| Win16 | No NE loader yet. |

## The tools

- About twenty tools look for `nasm`, `dosbox-x` and `qemu` in `/opt/homebrew/bin`.
- The golden test covers 44 programs, of which 39 are third-party files that a fresh clone does not
  have; there it checks 5.
