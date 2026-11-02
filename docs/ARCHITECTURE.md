# MIRAGE — Architecture

MIRAGE is an **x86 → JavaScript dynamic recompiler** with the machines built on it: a **DOS player**
whose DOS and BIOS are written in JavaScript, a **bare PC** that boots unmodified operating
systems from disk and CD images, and two **user-space worlds** with no operating system at all —
**MIRAGE-LINUX** (i386 Linux programs, the kernel's system calls in JavaScript) and **MIRAGE-WIN32**
(Windows programs, every DLL they import in JavaScript). It runs in the browser and, headless, in Node. There is **no
WebAssembly**: the design bet is that readable emitted JavaScript, handed to the engine's own JIT,
is a fast enough back end.

Two rules shape everything else: **precision** — behaviour is checked against independent
implementations, and the gates must stay green — and **reproducibility** — the same input gives the
same machine state, cycle for cycle.

> New to the code? Read this file, then [RECOMPILER.md](RECOMPILER.md) (the engine),
> [DEVICES.md](DEVICES.md) (BIOS, DOS, video, timer), [TESTING.md](TESTING.md) (the gates) and
> [COMPATIBILITY.md](COMPATIBILITY.md) (what runs). Keep them in step with the code when the design changes.

## The model in one paragraph

Guest memory is one flat `Uint8Array`. The recompiler translates a **basic block** of x86, starting
at the current `CS:EIP`, into the source of a JavaScript function, compiles it with `new Function`,
caches it by linear address and runs it. Blocks read and write the register file and the memory
array directly. The CPU is a 386-class processor up to a Pentium 4 (MMX, SSE, SSE2), chosen by a
profile: real mode, 16- and 32-bit protected mode, virtual-8086 mode, paging. A software interrupt either traps
into a JavaScript service (the BIOS, DOS) or enters the guest's own handler; hardware interrupts go
through an 8259 pair and are delivered between blocks. Time is counted in retired instructions.

## The machines

| | DOS player (`dos.html`) | Bare PC (`boot.html`) |
|---|---|---|
| Entry | `main.js` → `ui.js` | `bootpc.js` |
| Starts with | `dos.load(bytes, args, path)`: a `.COM` or `.EXE` in a PSP | `bootSector()` or `bootCD()` (`boot.js`): the BIOS handoff |
| DOS | `dos.js`, in JavaScript, over an in-memory file system (`vfs.js`) | whatever the image contains |
| Memory managers | XMS, EMS and a DPMI host, in JavaScript | none: the guest loads its own |
| Typical guest | an intro, a game | Windows 9x, Linux, a BSD, FreeDOS |

Both are the same `Machine`: `new Machine({ memSize, cpu })`, then `installBIOS(machine, options)`,
then for the DOS player `installDOS(machine, vfs)`. `tools/harness.mjs` builds either one for the
headless tools, composed as the browser composes it.

The user-space worlds are the same `Machine` too, with `installLinux(machine, options)` in place of
DOS: a paged, flat 32-bit address space in ring 3, and every `int 0x80` answered in JavaScript.

| | MIRAGE-LINUX (`world: "linux"`) | MIRAGE-WIN32 (`world: "win32"`) |
|---|---|---|
| Entry | `linuxrun.js` (`linux.html`, `machines.html`), `tools/oasis.mjs run` | `machines.html?m=win32` (images through `tools/oasis.mjs serve`) |
| Loads | a static or dynamic ELF, or an a.out, from an OASIS image's file tree | a PE `.exe`, mapped as Windows XP's loader maps it (`win32/index.js`) |
| The system | `linux.js`: the i386 system calls, processes, threads, signals, ttys, /dev | `linux.js`'s process machinery, plus a PEB, a TEB at `fs:` and XP's loader lists |
| Libraries | the image's own, or made in JavaScript (`hle/`: libSDL 1.2, libGL, libGLU, libasound) | all made in JavaScript (`win32/`): kernel32, user32, gdi32, winmm, msvcrt, opengl32, glu32, d3d9, d3dx9 |
| Graphics | the VGA, /dev/fb0, X on the VGA, or OpenGL on PRISM's `gl.js` | OpenGL on PRISM's `gl.js`, Direct3D 9 on PRISM's `d3d9.js` |
| Oracle | the same binary under Docker i386 | Windows XP's structures as Wine and ReactOS document them; Wine in Docker i386 |

A library made in JavaScript is a real shared object (`hle/elfso.js`) or a real PE DLL (`win32/dll.js`)
whose exports are stubs, `mov eax, id; int 80h; ret`: the program links and calls them as it would
the real ones, and the trap lands in the JavaScript function. The graphics themselves are
[PRISM](https://github.com/jfrelat-lab/prism)'s (`vendor/prism`, a submodule): its `gl.js` (OpenGL
and GLSL) and `d3d9.js` (Direct3D 9's device model, HLSL translated to GLSL ES), drawn by WebGL2.

## File map (`src/`, about 22,000 lines)

**The engine** — no DOM, identical in Node and in the browser.

| File | Role |
|---|---|
| `recompiler.js` | **The dynamic recompiler**: the x86 → JavaScript emitter, the block cache, the dispatch loop, invalidation on self-modifying code, the page-fault restart. See [RECOMPILER.md](RECOMPILER.md). |
| `cpu.js` | Architectural state and everything too rare to emit inline: flag helpers, segment loads and descriptor checks, privilege transitions, far calls and returns, task switches, control registers, CPUID, MSRs, CMPXCHG8B. |
| `cpu-profile.js` | Which processor MIRAGE claims to be: `386` (the default), `586`, `pentium`, `pentiummmx`, `686`, `pentiumpro`, `pentium3`, `pentium4`. A profile fixes the generation-specific behaviours and what CPUID reports (MMX from `pentiummmx`, SSE from `pentium3`, SSE2 from `pentium4`). |
| `memory.js` | Guest RAM, the A20 gate, paging (the page walk, two software TLBs, `PageFault`), and the per-page tracking of compiled code. |
| `mem-strategy.js` | How a memory access is emitted (inline typed-array access, or calls), kept pluggable so alternatives can be measured. |
| `fpu.js`, `mmx.js`, `sse.js` | The x87 coprocessor; the MMX registers and instructions; the XMM registers and the SSE and SSE2 operations compiled code uses (advertised by the `pentium3` and `pentium4` profiles). |
| `machine.js` | Wires CPU, memory and recompiler; owns `runSlice`, the I/O-port and interrupt tables, interrupt delivery in every mode, the PIT, VBE mode state. |
| `derail.js` | Says *what* the guest is executing when it is no longer executing code (a run of zero bytes, data, text), and how it got there. |

**The PC** — installed by `installBIOS`.

| File | Role |
|---|---|
| `bios.js` | INT 10h/11h/12h/15h/16h, VBE, the BIOS data area, E820, and the devices that have no file of their own: the VGA DAC and status ports, the 8042 keyboard controller, port 92h, Sound Blaster and OPL stubs. |
| `vga.js`, `dispi.js`, `vgarom.js` | The EGA/VGA planar device and its registers; the Bochs display interface (ports 1CEh/1CFh); running a real VGA option ROM instead of our INT 10h. |
| `pic.js`, `rtc.js`, `uart.js` | The 8259A pair; the MC146818 clock and CMOS with INT 1Ah; a 16550A on COM1 (optional). |
| `disk.js`, `ide.js`, `boot.js` | INT 13h over sector images, CD included; the two IDE channels, with ATA disks and an ATAPI CD-ROM; the boot handoff for a boot sector or an El Torito CD. |
| `pci.js` | An i440FX/PIIX3 PCI bus as QEMU's `-M pc` presents it, and the PCI BIOS (optional). |
| `ps2mouse.js` | A PS/2 mouse on the 8042's auxiliary port, and the BIOS services for it. |

**DOS** — the DOS player only.

| File | Role |
|---|---|
| `dos.js` | The DOS kernel: INT 21h, the PSP and memory control blocks, the loader, EXEC. |
| `vfs.js` | The in-memory drive C: with 8.3 names. |
| `xms.js`, `ems.js`, `dpmi.js` | Extended memory, expanded memory, and a DPMI 0.9 host for DOS extenders. |
| `mouse.js` | The INT 33h mouse driver. |
| `shell.js`, `samples.js` | A `COMMAND.COM`-style prompt and the small programs bundled on C:. |

**The user-space worlds** — no BIOS services, no DOS.

| File | Role |
|---|---|
| `linux.js` | MIRAGE-LINUX: the ELF and a.out loaders, the i386 system calls, processes and threads, signals, ttys and the console, the file system over an image's tree, /dev (fb0, dsp and audio, the mouse, ptys). |
| `linuxrun.js`, `vtconsole.js` | A Linux image in the page: its file tree from the OASIS server, the canvas, the keys; the VGA text console. |
| `hle/` | Libraries made in JavaScript for Linux programs (`elfso.js` builds the shared object, `index.js` dispatches): `sdl12.js`, `asound.js`, `gl.js` (the GL and GLU tables), `prism-gl.js` (PRISM's `gl.js` and `d3d9.js` on guest memory, and the window they draw in), `trace.js` (the headless backend that records). |
| `win32/index.js`, `win32/dll.js` | MIRAGE-WIN32: the PE loader, the process laid out as Windows XP lays it out, threads and their TEBs; a DLL made as a real PE image whose exports trap into JavaScript. |
| `win32/api.js` | kernel32, user32, gdi32, winmm (waveOut), msvcrt, lz32, ntdll, opengl32 (XP's 368 ordinals) and glu32. |
| `win32/d3d9.js` | d3d9.dll and d3dx9_24..43.dll: the COM objects and their vtables in guest memory, each method reading what it points to and handing it to the device model (PRISM's `d3d9.js` in a page, `recordD3D9()` headless). |
| `win32/truetype.js`, `win32/textmesh.js`, `win32/fonts.js` | A TrueType font's outlines as GDI's `GGO_NATIVE` gives them; D3DXCreateText's mesh from them (Wine's algorithm); the fonts an image names, found in the page (the visitor's, or DejaVu Sans). |

**The browser** — the only files that touch the DOM.

| File | Role |
|---|---|
| `main.js`, `ui.js` | The DOS page: drag-and-drop, `?run=`, the animation-frame loop that paces the machine. |
| `bootpc.js` | The bare-PC page: image, CPU and memory choice, the PCI and COM1 switches, the serial console. |
| `video.js` | Draws the active mode to a canvas: text, CGA, EGA/VGA planar, mode 13h and Mode X, VBE at 8, 16 and 32 bits per pixel. The headless tools use it too, with a stand-in canvas. |
| `keyboard.js` | Browser key events to scancodes, for the 8042 and for the BIOS. |

## CPU state (`cpu.js`)

```
reg    Uint32Array(8)   EAX ECX EDX EBX ESP EBP ESI EDI, in that index order
seg    Uint16Array(6)   ES=0 CS=1 SS=2 DS=3 FS=4 GS=5 — the selectors
base, limit, …          the hidden part of each segment register, refreshed by setSeg
eip, flags              CF=1 PF=4 AF=0x10 ZF=0x40 SF=0x80 TF IF DF OF=0x800, plus IOPL, NT, RF, VM
cr0, cr2, cr3, cr4      PE, WP, PG; the fault address; the page directory; PSE
gdtr, idtr, ldtr, tr    descriptor tables and the task register
cycles                  retired instructions — the machine's only clock
deadline                the value of `cycles` at which the next timer tick is due
```

Emitted code indexes `reg`, `seg` and `base` directly; 8- and 16-bit views (`cpu.al`, `cpu.ax`) are
accessors for the handlers. The current privilege level is stored, not derived from CS, because
the two differ in the middle of a privilege transition.

## Memory (`memory.js`)

- **One `ArrayBuffer`**, 16 MiB by default, with `u8` and `DataView` views. `machine.ramSize` is how
  much of it the guest is told is RAM; the DOS player has 16 MiB of RAM in a 32 MiB array, the rest
  holding the VBE aperture (`DOS_PLAYER_MEM` in `dos.js`).
- **Paging.** With CR0.PG set, linear addresses go through a page walk (4 KiB pages, and 4 MiB pages
  under CR4.PSE) with user/supervisor and write protection, CR0.WP included. Two software TLBs
  keep the walk off the hot path, and a CR3 load invalidates lazily. A miss that cannot be resolved
  throws `PageFault`; the dispatch loop catches it, sets CR2 and delivers #PF, with EIP still at the
  faulting instruction.
- **Self-modifying code.** Every 4 KiB page that holds compiled code is marked. A guest write to a
  marked page calls the recompiler's invalidator, which drops the blocks the write actually
  touches. Emitted stores carry the same check inline.
- **Video memory.** In the 16-colour planar modes, accesses to A000h are routed to `vga.js`; mode
  13h and VBE framebuffers are plain RAM.

## Execution (`machine.js`, `recompiler.js`)

```
machine.runSlice(maxBlocks)
  └─ rec.run(machine, maxBlocks)                  the dispatch loop
       while budget left, not halted, not blocked:
         if IF is set: deliver a pending hardware interrupt, the timer tick included
         lin = base[CS] + eip
         blk = the cached block at lin, or compile it     (translate → new Function)
         blk.fn(cpu, blk)
         cpu.cycles += blk.count
```

Without paging a block ends at a control transfer or after 192 instructions; under paging it goes on
through forward branches, short loops and followed calls ([RECOMPILER.md](RECOMPILER.md#longer-blocks-under-paging)).
Blocks are keyed by linear address and code-segment size. Under paging a block also remembers the physical frames it was compiled from: after a CR3 load it is revalidated
against the new address space rather than thrown away, which is what keeps process switches
cheap. The cache is capped (16 MiB of source, 64 MiB under paging) and flushed when full.

A second tier that fuses a hot loop's blocks into one function exists in the source and is
**off**: a fused region can run an unbounded amount of work in one slice, and some games ran slower
or derailed with it. `MIRAGE_TIER2=1` enables it for work on it.

## Interrupts (`machine.js`, `pic.js`)

Every interrupt vector initially points at a stub in the BIOS segment.

- **A software interrupt** whose vector still points at its stub is served by the JavaScript
  handler registered for it (`machine.intHandlers[n]`) — that is how the BIOS and DOS are
  implemented. If the guest has installed its own handler, the interrupt is delivered to it as the
  processor would: through the real-mode vector table, or through the IDT with its gates, privilege
  checks, stack switches and task gates.
- **Hardware interrupts** are raised on the 8259 pair (`raiseIRQ`) and delivered between blocks
  when IF is set, honouring the mask, priority and end-of-interrupt.
- **Exceptions** (#DE, #UD, #GP, #PF…) are raised with EIP at the faulting instruction.

## Time and determinism

There is one clock: `cpu.cycles`, the count of retired instructions. The PIT, the RTC's periodic
interrupt, the VGA retrace and RDTSC are all derived from it — one 18.2 Hz timer tick is 182,584
cycles by default, about 3.3 million instructions per guest second. Headless, nothing reads the
host's clock or `Math.random`, so a run is reproducible exactly; that is what the golden gate relies
on. In the browser the guest's time is the host's (`machine.wallClockMs`): `ui.js` paces timer
ticks to wall-clock time, and the VGA retrace and PIT counter 0's readback follow it, so that a game
runs at its real speed however fast the CPU goes. MIRAGE-LINUX takes the host's clock with
`MIRAGE_LXWALLCLOCK=1`, for benchmarks. [notes/timing.md](notes/timing.md) records how these numbers were chosen.

## Switches

Behaviour that is optional or experimental is selected by a constructor option, or in Node by an
environment variable read at start-up: `MIRAGE_CPU` (the profile), `MIRAGE_PCI`, `MIRAGE_SERIAL`,
`MIRAGE_PITRELOAD` (cycles per timer tick), and a family of kill switches (`MIRAGE_NOD8`,
`MIRAGE_NOXTLB`, `MIRAGE_NOSTRIP`…) that turn one optimisation off so a gate can be run with and
without it. Each is documented where it is read.
