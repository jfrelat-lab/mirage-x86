# MIRAGE — Devices and services

How the BIOS, DOS and the devices are implemented. What the guest sees, and what each part was
checked against, is in [HARDWARE.md](HARDWARE.md). Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## The two buses (`machine.js`)

Everything outside the CPU hangs off two tables.

- **Interrupts.** `hookInterrupt(n, fn)` registers a JavaScript handler for INT n and points the
  vector at a one-byte `IRET` stub in the BIOS segment. When the guest executes INT n and the
  vector still points at the stub, the handler runs; if the guest installed its own handler, the
  interrupt goes to it, through the real-mode vector table or the IDT. A handler that the guest
  later reaches by a far call (a program that reads the vector and calls it) runs too: the stub's
  address is recognised by the recompiler.
- **I/O ports.** `onPortRead(port, fn)` and `onPortWrite(port, fn)`. A port nobody registered
  reads as all ones (FFh, FFFFh, FFFFFFFFh) and ignores writes, as an empty ISA bus does.

`installBIOS(machine, options)` installs everything below except DOS; `installDOS(machine, vfs)`
adds the DOS player's services. Options: `pci`, `serial`, `xms`, `ems`, `dpmi`.

## The interrupt controller and the timer

**8259A pair** (`pic.js`): IRR, ISR, IMR, fixed priority, specific and non-specific EOI, the ICW1-4
initialisation (so a guest can move the vector base), the cascade on IRQ 2, the edge/level control
registers (ELCR, with PCI). Devices call `machine.raiseIRQ(n)`; delivery happens between blocks when
IF is set. Not implemented: rotating priority, special mask mode, poll mode.

**8254 timer, channel 0** (`machine.js`). The tick is clocked off `cpu.cycles`: one 18.2 Hz tick is
`pitBase` cycles, 182,584 by default (`MIRAGE_PITRELOAD`), chosen so that MIRAGE does as much work
per tick as DOSBox-X at `cycles=fixed 20000` (see [notes/timing.md](notes/timing.md) §6).

- **Reprogramming** through ports 43h/40h changes the interrupt rate. The rate is capped at
  `pitBase / 16` (about 291 Hz) because delivering an interrupt is expensive here
  (`MIRAGE_PITFLOOR` lowers the cap). Every mode is treated as periodic.
- **Reading** port 40h returns the live count in 1.193 MHz ticks, counted from the moment the
  reload value was written, as an 8254 does (`MIRAGE_PITOLD=1` restores an older approximation).
- **Delivery.** `serviceTimer` runs when `cpu.cycles` reaches `nextTimerCycle`: it bumps the BIOS
  tick count and delivers IRQ 0. `machine.timerAuto` is on headless (the clock is the cycle count,
  deterministic); in the browser `ui.js` turns it off and paces ticks to wall-clock time.
- **Channel 2** and port 61h drive the PC speaker (see Audio).

**RTC and CMOS** (`rtc.js`): an MC146818 on ports 70h/71h — the clock, the status registers, the
periodic interrupt on IRQ 8, CMOS bytes (memory sizes, diskette types, equipment), INT 1Ah's clock
services. The update-ended and alarm interrupts are not implemented.

## Keyboard and mouse

**8042** (`bios.js`): ports 60h and 64h, IRQ 1. Keys arrive as set-1 make and break scancodes
(`machine.pushScancodes`, then `pumpKeyboard`) and also as BIOS keystrokes for INT 16h
(`machine.keyQueue`): a game with its own INT 9 handler reads the port, a program that asks the BIOS
gets the buffer. The controller's commands are implemented as far as guests use them, including
the output port, whose bit 1 is the A20 gate (HimemX switches A20 that way). Port 92h is the fast
A20 gate. The browser side (`keyboard.js`) maps `KeyboardEvent.code` to scancodes; the arrow keys
are sent without the E0 prefix.

**PS/2 mouse** (`ps2mouse.js`): three-byte packets on the 8042's auxiliary channel, IRQ 12, and INT
15h AX=C2xx, the BIOS interface a guest's own mouse driver uses. **INT 33h** (`mouse.js`) is the
DOS player's built-in mouse driver.

**Game port** 201h reads F0h: no joystick (buttons up, axes timed out). FFh would read as a joystick
whose axes never time out.

## Storage

**INT 13h** (`disk.js`) over sector images attached with `machine.disk.attach(drive, bytes, geom)`:
CHS reads, writes and verify, drive parameters, the disk type, and the EDD extensions (41h, 42h-44h,
47h, 48h) for hard disks. Floppy geometry is inferred from standard image sizes. A drive with no
image answers 80h "not ready". Drive A: exists even when empty, as the CMOS says. The CD-ROM is
drive E0h, by LBA in 2048-byte sectors, with 4Bh for El Torito.

**IDE** (`ide.js`): two channels, PIO only.

- **Primary**, 1F0h-1F7h and 3F6h, IRQ 14: the images attached as 80h and 81h, as ATA disks. The
  ATA-4 subset: IDENTIFY, READ/WRITE SECTORS and MULTIPLE, SET MULTIPLE, INITIALIZE DEVICE
  PARAMETERS, SEEK, VERIFY, SET FEATURES, the power commands, DIAGNOSTIC, the soft reset.
- **Secondary**, 170h-177h and 376h, IRQ 15: an ATAPI CD-ROM as master, present when a disc is
  attached (`disk.attachCD`) or when PCI is on (`disk.fitCD`, an empty drive). It answers PACKET
  with the MMC commands drivers send — TEST UNIT READY, REQUEST SENSE, INQUIRY, MODE SENSE(10),
  READ CAPACITY, READ(10/12), READ CD, READ TOC, GET CONFIGURATION, GET EVENT STATUS and a few
  others — and reports a disc inserted while running as UNIT ATTENTION.
- A channel with no device floats at FFh, as if absent.

**Booting** (`boot.js`): `bootSector` loads the first sector at 0000:7C00 and enters it with DL set;
`bootCD` follows the El Torito catalogue (no emulation, floppy or hard-disk emulation).

## Video

**INT 10h** (`bios.js`): mode set and the BIOS data area, cursor, scrolling, character and string
output (in text modes and drawn as glyphs in graphics modes), pixels, the palette and DAC calls,
fonts (AX=11xxh), configuration (12h), the display combination code (1Ah), state save (1Ch), and
VBE 2.0 (4Fh): the mode list, mode information, mode set with a linear or banked framebuffer, bank
switching, scan-line length and display start. Where the references disagreed, the choice is
written next to the code.

**VGA registers** (`vga.js`, `bios.js`): the sequencer, graphics controller, attribute controller,
CRTC, miscellaneous output, the DAC (3C6h-3C9h), the CGA mode and colour registers (3D8h, 3D9h) and
input status (3DAh, also 3BAh). The 16-colour planar modes keep their picture in `vga.planes`, four
64 KiB planes, not in A000h: the write pipeline implements the four write modes, set/reset, the
rotate and logic functions, the bit mask, the latches and both read modes. Mode X (unchained 256
colours) is the same planar path. The width and height come from the mode set; the CRTC supplies
the line offset, the display start (scrolling, page flipping) and, in Mode X, the number of
scan lines. Line compare (split screen) is not implemented.

**Retrace** (3DAh): derived from real time in the browser, so vertical retrace comes at 70 Hz however
fast the engine runs, and from the cycle count headless (`pitBase / 3.845` cycles per frame), so a
run stays reproducible. The blanking and retrace fractions follow the CRTC.

**VBE framebuffer.** VBE modes draw into a framebuffer that is ordinary memory in the machine's
array. When the address space is larger than the RAM (`machine.ramSize`, the DOS player: 16 MiB of
RAM in 32 MiB) it sits just above the RAM, 4 MiB-aligned, as a card's aperture does, and costs the
RAM nothing. Otherwise it is carved from the top of RAM — 4 MiB, 4 MiB-aligned, from 16 MiB up, or
the top 2 MiB below that — and reserved in the E820 map.
`machine.vbe` describes the active mode; the A000h window is a 64 KiB view of the same bytes.

**DISPI** (`dispi.js`, with PCI): the Bochs display interface on 1CEh/1CFh, setting any mode the
framebuffer can hold; it reads back a mode set through the VBE BIOS, as QEMU does.

**A real VGA BIOS** (`vgarom.js`): a VGA option ROM can be run as INT 10h instead of ours.

**Drawing** (`video.js`): one renderer for text (with blink and the cursor), CGA, planar 16-colour,
mode 13h, Mode X and VBE at 8, 16 and 32 bits per pixel. The fonts in `assets/` are the 8×8, 8×14
and 8×16 VGA fonts, rebuilt from DOSBox-X's rendered glyphs (`tools/build-fonts.mjs`).

## Buses and the rest

**PCI** (`pci.js`, option `pci`): configuration mechanism 1 on CF8h/CFCh; functions 00.0 (i440FX),
01.0 (PIIX3 ISA bridge, with the PCI interrupt routing), 01.1 (PIIX3 IDE in legacy mode, bus-master
registers at C000h that move no data but set the interrupt bit), 02.0 (a 1234:1111 display whose
BAR0 is the VBE framebuffer); the ELCR on 4D0h/4D1h; a $PIR routing table; the PCI BIOS through INT
1Ah B1xxh.

**Serial port** (`uart.js`, option `serial`): a 16550A on 3F8h-3FFh, IRQ 4, with its FIFOs. What the
guest sends goes to `machine.serial.onTx`; `boot.html` shows it in a console.

**Sound Blaster 16** (`sb.js`) at 220h, IRQ 7, DMA 1 and 5, as `BLASTER` says. The DSP takes the SB16
command set (8-bit single-cycle and auto-init, high speed, the generic Bxh/Cxh commands, time constant
and output rate, pause, continue, speaker, version 4.05) and the mixer answers its IRQ and DMA
registers. Playback pulls samples from the 8237 at the programmed rate, on the machine's clock
(cycles headless, wall-clock time in the browser), and raises IRQ 7 at the end of each block
(`tools/sbprobe.asm` against DOSBox-X). The end of block is armed as a cycle deadline the run loop
checks with the PIT's (`machine.nextEvent`), so a driver probing for the IRQ with a 5-byte transfer
gets it within its few milliseconds. The SB Pro stereo bit is not honoured, as on DOSBox-X's SB16.
ADPCM and recording play silence.

**OPL3** (`opl.js`): the YMF262, which plays OPL2 (AdLib) music too, at 388h-38Bh, 220h-223h and
228h. The chip's model as the die analyses describe it: per operator, in the chip's order, feedback,
envelope (on the chip's global envelope clock), phase and a log-sine/exponential lookup; FM and AM
connections, four-operator voices, rhythm mode and its noise generator, OPL3 stereo, and the
channel sample delay of channels 6-8. Its output is bit-identical to Nuked-OPL3's for the same
register writes (`tools/opl-compare.mjs`: tools/oplnotes.asm and 40 s of Dune's AdLib music; the
test suite pins the former). It renders at the chip's 49716 Hz on the machine's clock, catching up
at every register write, and only while something listens. The
timers run for real: on wall time or on executed instructions at the PIT's rate, whichever has
moved further, so a detection that waits by reading the status port a hundred times sees them
expire in the browser too. Status and timers checked with `tools/oplprobe.asm` against DOSBox-X and
QEMU.

**Audio** (`audio.js`, `audio-out.js`): `audio.js` mixes the card (resampled linearly) and the PC
speaker (port 61h and PIT channel 2, rendered from a timeline of their changes) into stereo at any
rate, on the machine's clock, through a 16 Hz high-pass as a real output's AC coupling. In the
browser `audio-out.js` plays it through an AudioWorklet, started by the first click or key; the
DOS player has a SOUND button, the bare PC a Sound box (real-time clock only).
`tools/record-audio.mjs` writes it to a WAV headless. The FM is the OPL3, below.

**DMA** (`dma.js`): both 8237s, with base and current address and count, the flip-flop, masks, modes
and page registers. Only the Sound Blaster transfers. A hardware IRQ nobody claimed is acknowledged
by the BIOS, as SeaBIOS's default handler does.

**Port F4h** is not a MIRAGE device: the probes in `tools/` write to it to end a run, as QEMU's
`isa-debug-exit` does, and the test tools hook it.

## DOS (the DOS player)

**DOS** (`dos.js`). The loader builds a PSP, loads a `.COM` at 100h or relocates an MZ `.EXE`, and
sets up the memory control blocks. INT 21h:

| Group | AH |
|---|---|
| console and character I/O | 00, 01, 02, 06, 07, 09, 0A, 0B, 0C |
| drives, DTA, vectors | 0E, 19, 1A, 25, 2F, 35, 36 |
| date, time, version, flags | 2A-2D, 30, 33, 37, 38 |
| directories and files | 39-44, 47, 4E, 4F, 56, 57, and 29 (parse a name into an FCB) |
| memory | 48, 49, 4A, 58 |
| processes | 31, 4B (load and execute, load overlay), 4C, 4D, 50, 51, 62 |
| internals | 34 (InDOS), 52 (list of lists, with a live System File Table) |

The FCB file calls and AH=5Dh are not implemented. Files live in an in-memory file system
(`vfs.js`, drive C:, 8.3 names); character devices (CON, NUL, PRN, AUX, LPTn, COMn) open as handles.
INT 20h, 27h, 2Ah and 2Fh are answered too.

**XMS 3.0** (`xms.js`): INT 2Fh 4300h/4310h and the far-call entry; allocate, free, lock, move,
reallocate, the A20 calls. A move runs the self-modifying-code check, because overlays of code are
swapped in this way.

**EMS 4.0** (`ems.js`): INT 67h, the subset programs use, and the `EMMXXXX0` device that programs
open to detect it. Not installed on the bare PC: a guest's own EMM386 would refuse to load.

**DPMI 0.9** (`dpmi.js`): the mode-switch entry, INT 31h services (descriptors, memory, interrupt and
exception vectors, real-mode calls and callbacks, raw mode switch), and reflection of interrupts
between the modes. DOOM, Heretic and Quake run on it. `MIRAGE_NODPMI=1` removes it, so that a
program's own extender takes over. Returning from INT 31h reloads CS, SS, ES, DS, FS and GS from
their selectors, as a real host's return to the client does (`tools/dpmireload.asm`: CWSDPMI under
DOSBox-X and QEMU): a descriptor changed through INT 31h reaches a register that already holds it.
A hardware interrupt runs the client's PM handler on a 16 KiB stack the host keeps, as DPMI 0.9
specifies (`tools/dpmistack.asm`): data a client keeps below its ESP survives. An IRQ without a PM
handler is acknowledged, not reflected.

When a real DOS kernel boots on the bare PC, the XMS driver and the DPMI host stand aside: a guest
that installs its own handler on INT 2Fh or loads its own extender gets the vector
(`machine.reclaimVector`).

## Port map

| Ports | Device | File |
|---|---|---|
| 20h-21h, A0h-A1h | 8259 pair | `pic.js` |
| 40h, 43h | 8254 channel 0 | `machine.js` |
| 42h, 61h | channel 2, speaker gate | `bios.js` |
| 60h, 64h | 8042 keyboard and aux (mouse) | `bios.js`, `ps2mouse.js` |
| 70h-71h | RTC and CMOS | `rtc.js` |
| 92h | fast A20 | `bios.js` |
| 170h-177h, 376h | IDE secondary (CD-ROM) | `ide.js` |
| 1CEh-1D0h | DISPI (with PCI) | `dispi.js` |
| 1F0h-1F7h, 3F6h | IDE primary | `ide.js` |
| 201h | game port | `bios.js` |
| 220h-22Fh | Sound Blaster 16 DSP and mixer; the OPL3 on 220h-223h and 228h | `sb.js`, `opl.js` |
| 388h-38Bh | the OPL3 (AdLib) | `opl.js` |
| 00h-0Fh, 81h-8Fh, C0h-DFh | 8237 DMA controllers and page registers | `dma.js` |
| 3BAh, 3DAh | input status (retrace) | `bios.js` |
| 3C0h-3CFh | VGA attribute, misc, sequencer, DAC, graphics | `vga.js`, `bios.js` |
| 3D4h-3D5h, 3D8h-3D9h | CRTC; CGA mode and colour | `vga.js`, `bios.js` |
| 3F8h-3FFh | COM1 (option) | `uart.js` |
| 4D0h-4D1h, CF8h, CFCh | ELCR, PCI configuration (option) | `pci.js` |
| C000h-C00Fh | IDE bus master (with PCI) | `pci.js` |
