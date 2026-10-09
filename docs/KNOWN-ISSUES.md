# MIRAGE — Known issues

What does not work, with the cause when it is known. Each entry says what is established and what
is only suspected. What is planned about them is in [ROADMAP.md](ROADMAP.md); what runs is in
[COMPATIBILITY.md](COMPATIBILITY.md).

## Missing hardware

| Missing | Consequence |
|---|---|
| Sound output | Sound Blaster and OPL are detected and silent. |
| A network card | Systems run without a network; QNX's demo disk stops asking for one. |
| ACPI | ReactOS (installed for an ACPI machine) stops in its kernel: "did NOT find RSDT". |
| A floppy *controller* | The BIOS serves drive A:, but a system that drives the controller itself cannot read a floppy. |
| IDE bus-master DMA | The registers exist and move no data; disks and the CD-ROM are PIO only. |
| MMX, SSE as a feature, 64-bit mode | The CPU is a Pentium Pro. A few SSE instructions exist for one intro and are not advertised. |
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

## Time

- **The headless clock is slow for late systems.** One guest second is 3.3 million instructions, the
  speed of a slow 386. Windows 2000 expects a Pentium and spends its time redrawing its boot
  animation. `MIRAGE_PITRELOAD` changes the rate; no profile sets it yet.
- **Raising that rate made the first seconds of one boot extremely slow** (ten minutes of host time
  for five guest seconds, Windows 2000). Not explained.
- **The real-time clock starts at a fixed date** in headless runs, so a guest sees files "from the
  future".
- **Fewer instructions per tick than DOSBox-X on some intros.** Measured with `tools/dosdiff.js` at
  the same tick count: Puls, Symetrie and Dírojed draw the same picture as DOSBox-X, less far
  along. The calibration (`pitBase`) was made on an integer loop; not investigated further.
- **The timer interrupt rate is capped** at about 291 Hz. A program that asks for more gets 291.
- **The second compilation tier is off.** A fused loop can run unbounded work in one slice.

## The DOS player

- **Uncapped speed is too fast** for games paced by neither the timer nor the retrace (the Commander
  Keen menus). `?mhz=` caps it.
- **EXEC after a last-fit allocation**: a child is placed above the highest allocated block, not in
  the largest free one as DOS does, so a program that allocates at the top of memory (last fit) and
  then runs another fails with "insufficient memory".
- **INT 21h**: the FCB file calls (open, read, write, find by FCB) and AH=5Dh are missing.
- **`tools/test-dos-api.js` has two failing checks**: the cursor shape reported by INT 10h AH=03h,
  and the pointer returned by INT 21h AH=34h. Neither is known to affect a program.

## Programs

Per-title status is in [COMPATIBILITY.md](COMPATIBILITY.md). The failures with a known cause:

| Program | Cause |
|---|---|
| Lemmings | needs a raw floppy (it reads its disk by INT 13h); the files alone are not enough |
| Void 3 | hangs inside its own timer handler after setting its VESA mode; cause not found |
| Unreal 1.1 (Future Crew) | "FutureExLoader: Block allocation error?" — its loader does not get the DOS memory it asks for; not investigated yet |
| Jump 'n Bump | #GP in the DPMI client at 47:1BDC9, before the title screen |
| Second Reality | derails to 0000:0000 at start |
| Difúze (Řrřola, 256 bytes) | draws horizontal bands where QEMU and DOSBox-X both draw reaction–diffusion patterns; cause not found. The golden test pins the wrong picture (`difze`) |
| oktaeder | programs PCI hardware directly and relies on a register DOS leaves by accident; it derails on DOSBox-X too |
| Heretic without our DPMI host | its bound DOS/4G faults after entering protected mode by itself |

## The tools

- About twenty tools look for `nasm`, `dosbox-x` and `qemu` in `/opt/homebrew/bin`.
- The golden test covers 44 programs, of which 39 are third-party files that a fresh clone does not
  have; there it checks 5.
