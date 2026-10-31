# MIRAGE — The machine

What hardware MIRAGE presents to a guest, and what each part was checked against. How it is
implemented is in [DEVICES.md](DEVICES.md); what is missing and planned is in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) and [ROADMAP.md](ROADMAP.md).

**The reference rule.** MIRAGE's behaviour is changed when independent implementations agree. QEMU,
v86 and Bochs all run SeaBIOS and SeaVGABIOS: for BIOS questions they are one lineage, not three.
DOSBox-X (its own BIOS) is a second, and a vendor ROM — the Cirrus CL-GD5446 VGA BIOS, run on QEMU —
is a third. Where they agree, that is the contract; where they differ, the choice is recorded in the
code beside the behaviour. A **probe** is a small boot program in `tools/*.asm` that prints what the
hardware answers and is run unchanged on MIRAGE and on the reference.

Status: **yes** — present by default; **option** — present when asked for; **partial** — see the
note; **no** — absent.

## Machine

| Part | Status | Checked against |
|---|---|---|
| ISA PC: 8259 pair, 8254 timer, 8042 keyboard controller, CMOS | yes | QEMU `-M isapc`, DOSBox-X |
| PCI: i440FX host bridge, PIIX3 ISA bridge and IDE, a display function, $PIR, the PCI BIOS | option (`pci`) | QEMU `-M pc`: the first 128 bytes of each function's configuration space are identical (`tools/pcidump.asm`) |
| ACPI, a local APIC, USB | no | — |

## Processor

Chosen by profile (`src/cpu-profile.js`). A feature is reported by CPUID only if it is implemented.

| Profile | What it is | Checked against |
|---|---|---|
| `386` (default) | no CPUID | test386 to its last POST code; SingleStepTests 8088 vectors for the common subset |
| `586`, `pentium` | CPUID, family 5: FPU, TSC, PSE (4 MiB pages), CMPXCHG8B. `pentium` says GenuineIntel | `tools/cx8probe.asm` against QEMU `-cpu pentium` |
| `686`, `pentiumpro` | family 6: adds CMOV, FCMOV, FCOMI, RDMSR/WRMSR, CPUID leaf 2. `pentiumpro` says GenuineIntel | Linux 2.2 identifies it as a Pentium Pro |
| `pentiummmx` | `586` with MMX (family 5 model 4, a P55C) | `tools/linux/mmx.asm`: every MMX instruction against Docker i386 |
| `pentium3`, `pentium4` | `686` with MMX and SSE (a Pentium III); with SSE2 too (family 15, a Pentium 4) | `tools/linux/sse.asm`: SSE and SSE2 against Docker i386 |

Modes: real, 16- and 32-bit protected, virtual-8086, paging with write protection, hardware task
switching. Not present: SSE3 and later, FXSAVE/FXRSTOR, PAE, global pages, SYSENTER, 64-bit mode.
The x87 computes in IEEE double, not 80-bit extended.

## BIOS

MIRAGE's BIOS is written in JavaScript: it answers the interrupts instead of running ROM code.

| Service | Status | Checked against |
|---|---|---|
| INT 10h video, with VBE 2.0 | yes | SeaVGABIOS, DOSBox-X and the Cirrus ROM (`tools/int10gfx.asm`, `tools/int10-oracle.mjs`) |
| INT 13h disks: CHS and the EDD extensions; the CD as drive E0h | yes | SeaBIOS (`tools/cdboot.asm` for the CD) |
| INT 15h (memory map E820, A20, the PS/2 mouse), INT 16h, INT 1Ah | yes | SeaBIOS |
| El Torito CD boot: no emulation, floppy emulation, hard-disk emulation | yes; hard-disk emulation untested | SeaBIOS; two official CDs boot |
| A real VGA option ROM run in place of our INT 10h | option (`src/vgarom.js`) | — |
| Running SeaBIOS or a vendor BIOS as the system BIOS | no | — |

## Video

| Part | Status | Checked against |
|---|---|---|
| VGA: text, CGA, 16-colour planar, mode 13h, Mode X | yes | QEMU, DOSBox-X, the Cirrus ROM; pixel comparisons |
| VBE linear and banked modes, 8/16/32 bits, to 1024×768, in a 4 MiB framebuffer | yes | SeaVGABIOS's mode list (`tools/vbemodes.asm`) |
| The Bochs display interface (ports 1CEh/1CFh) | with `pci` | QEMU `-vga std` with 4 MiB of video memory: identical (`tools/dispiprobe.asm`) |
| Cirrus, S3, ATI or VMware accelerators | no | — |

## Storage

| Part | Status | Checked against |
|---|---|---|
| Two hard disks on the primary IDE channel, PIO | yes | QEMU, v86; Linux, the BSDs and Windows 9x mount them |
| An ATAPI CD-ROM on the secondary channel | when a disc is attached, or with `pci` | QEMU `-cdrom` (`tools/atapiprobe.asm`); Linux 2.2 and 2.4 mount a disc |
| Bus-master DMA | partial: the registers and the interrupt bit, no data transfer | — |
| A floppy drive, through the BIOS | yes | SeaBIOS |
| A floppy *controller* (82077) | no | — |
| The 8237 DMA controllers | yes, for the Sound Blaster; the mask and status registers are not read back (the references differ) | QEMU, DOSBox-X (`tools/dmaprobe.asm`) |

## Other devices

| Part | Status | Checked against |
|---|---|---|
| Real-time clock and CMOS, with the periodic interrupt | yes | QEMU |
| PS/2 keyboard and mouse | yes | — |
| 16550A serial port, COM1 | option (`serial`) | QEMU (`tools/uartprobe.asm`): identical |
| Sound Blaster 16 (DSP, mixer, DMA playback, IRQ 7) | yes, heard in the browser | DOSBox-X (`tools/sbprobe.asm`) |
| PC speaker (port 61h, PIT channel 2) | yes | — (`tools/beep.asm`: 440 Hz measured) |
| OPL3 / OPL2 (AdLib FM) | yes, bit-identical to Nuked-OPL3 | status and timers: DOSBox-X, QEMU (`tools/oplprobe.asm`); sound: Nuked-OPL3, sample for sample (`tools/opl-compare.mjs`) |
| A network card, a parallel port | no | — |

## DOS services (the DOS player only)

| Part | Status | Checked against |
|---|---|---|
| DOS (INT 21h), in JavaScript | yes | a real DOS kernel's answers (`tools/dos-oracle.mjs`), DOSBox-X's file and video event log (`tools/dbx-oracle.mjs`) |
| XMS 3.0, EMS 4.0 | yes | DOSBox-X |
| A DPMI 0.9 host | yes | DOOM, Heretic, Quake run on it |
| The INT 33h mouse | yes | — |
