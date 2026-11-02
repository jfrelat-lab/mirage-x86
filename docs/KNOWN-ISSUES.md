# MIRAGE — Known issues

What does not work, with the cause when it is known. Each entry says what is established and what
is only suspected. What is planned about them is in [ROADMAP.md](ROADMAP.md); what runs is in
[COMPATIBILITY.md](COMPATIBILITY.md).

## Missing hardware

| Missing | Consequence |
|---|---|
| Sound | No Gravis Ultrasound. ADPCM and recording play silence. |
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
| Windows NT 3.51 | a stop error (C000021A) after the switch to graphics | **Suspected**: a context restored wrongly on the way back from a BIOS call in virtual-8086 mode. Not confirmed. |
| Windows 2000 | its boot screen, progress bar empty | **Unknown.** After calibrating its delay loop it touches no device again. Not a matter of speed alone: it idles at 20 times the default clock rate too. |
| ReactOS 0.4.15 | a stop in the kernel | **Known**: no ACPI tables. |
| BeOS 5 | the splash screen | **Unknown.** The kernel log matches v86's to its last line; then user programs run and one loops waiting. Suspected: the display server does not start. |
| Plan 9 (9legacy) | after the kernel is entered | **Known**: it runs with an instruction pointer above FFFFh in a 16-bit code segment, which MIRAGE does not handle. |
| Damn Small Linux 4.4.10 | a black screen at runlevel 5 | **Unknown**: not investigated — it may only be slow. |
| BasicLinux 3.5 (Linux 2.2), on the 586 profile | its console fills with "probable hardware bug: clock timer configuration lost" | **Regression**, since PIT counter 0 reads count from the reload write (2026-10-03): the kernel's timer interrupt reads a count it takes for a lost configuration. With `MIRAGE_PITOLD=1` it reaches its console in 6 s. |

## Time

- **The headless clock is slow for late systems.** One guest second is 3.3 million instructions, the
  speed of a slow 386. Windows 2000 expects a Pentium and spends its time redrawing its boot
  animation. `MIRAGE_PITRELOAD` changes the rate; no profile sets it yet.
- **Raising that rate made the first seconds of one boot extremely slow** (ten minutes of host time
  for five guest seconds, Windows 2000). Not explained.
- **The real-time clock starts at a fixed date** in headless runs, so a guest sees files "from the
  future".
- **The timer interrupt rate is capped** at about 291 Hz. A program that asks for more gets 291.
- **The second compilation tier is off.** A fused loop can run unbounded work in one slice.

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
| oktaeder | programs PCI hardware directly and relies on a register DOS leaves by accident; it derails on DOSBox-X too |
| Heretic without our DPMI host | its bound DOS/4G faults after entering protected mode by itself |

## Windows programs (MIRAGE-WIN32)

| Missing | Consequence |
|---|---|
| DirectDraw, DirectSound, DirectInput | Programs that need them stop; luxo4k shows a message box and exits for want of DirectSound. |
| Direct3D 9 without shaders | PRISM's `d3d9.js` draws with HLSL shaders; the fixed function, vertex declarations, stencil, alpha test and `Reset` are not there yet. |
| D3DX beyond HLSL | Shader assembly, `ID3DXFont`, effects and sprites are not done; texture shaders (`D3DXFillTextureTX`, Ergon) wait on PRISM. Meshes, skins, N-patches, normals, adjacency, `D3DXFillTexture` and text meshes (`D3DXCreateText`) are. |
| Windows fonts | MIRAGE ships none. An image lists the ones it selects (`machine.fonts`); the page reads the visitor's own (Chrome's Local Font Access, after asking) or else uses DejaVu Sans, whose shapes and widths differ. Glyphs are not hinted. |
| One emulated core | Threads take turns on one CPU at about 200 M instructions a second: Darwinism (180 M x87 instructions a frame) draws a frame a second, Valleyball's synthesizer keeps up at 0.97 of real time, Stripped's precalculation lasts minutes. |
| gdi32's ordinals | Crinkler's /RANGE imports by ordinal; MIRAGE's gdi32 does not number its exports as Windows XP's (no intro met needs it yet). opengl32's and d3dx9's are numbered as Microsoft's. |
| Win16 | No NE loader yet. |

## The tools

- About twenty tools look for `nasm`, `dosbox-x` and `qemu` in `/opt/homebrew/bin`.
- The golden test covers 44 programs, of which 39 are third-party files that a fresh clone does not
  have; there it checks 5.
