# MIRAGE — Architecture

MIRAGE is an **x86 → JavaScript dynamic recompiler** with two machines built on it: a **DOS player**
whose DOS and BIOS are written in JavaScript, and a **bare PC** that boots unmodified operating
systems from disk and CD images. It runs in the browser and, headless, in Node. There is **no
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
array directly. The CPU is a 386-class processor up to a Pentium Pro, chosen by a profile: real
mode, 16- and 32-bit protected mode, virtual-8086 mode, paging. A software interrupt either traps
into a JavaScript service (the BIOS, DOS) or enters the guest's own handler; hardware interrupts go
through an 8259 pair and are delivered between blocks. Time is counted in retired instructions.

## The two machines

| | DOS player (`index.html`) | Bare PC (`boot.html`) |
|---|---|---|
| Entry | `main.js` → `ui.js` | `bootpc.js` |
| Starts with | `dos.load(bytes, args, path)`: a `.COM` or `.EXE` in a PSP | `bootSector()` or `bootCD()` (`boot.js`): the BIOS handoff |
| DOS | `dos.js`, in JavaScript, over an in-memory file system (`vfs.js`) | whatever the image contains |
| Memory managers | XMS, EMS and a DPMI host, in JavaScript | none: the guest loads its own |
| Typical guest | an intro, a game | Windows 9x, Linux, a BSD, FreeDOS |

Both are the same `Machine`: `new Machine({ memSize, cpu })`, then `installBIOS(machine, options)`,
then for the DOS player `installDOS(machine, vfs)`. `tools/harness.mjs` builds either one for the
headless tools, composed as the browser composes it.

## File map (`src/`, about 13,000 lines)

**The engine** — no DOM, identical in Node and in the browser.

| File | Role |
|---|---|
| `recompiler.js` | **The dynamic recompiler**: the x86 → JavaScript emitter, the block cache, the dispatch loop, invalidation on self-modifying code, the page-fault restart. See [RECOMPILER.md](RECOMPILER.md). |
| `cpu.js` | Architectural state and everything too rare to emit inline: flag helpers, segment loads and descriptor checks, privilege transitions, far calls and returns, task switches, control registers, CPUID, MSRs, CMPXCHG8B. |
| `cpu-profile.js` | Which processor MIRAGE claims to be: `386` (the default), `586`, `pentium`, `686`, `pentiumpro`. A profile fixes the generation-specific behaviours and what CPUID reports. |
| `memory.js` | Guest RAM, the A20 gate, paging (the page walk, two software TLBs, `PageFault`), and the per-page tracking of compiled code. |
| `mem-strategy.js` | How a memory access is emitted (inline typed-array access, or calls), kept pluggable so alternatives can be measured. |
| `fpu.js`, `sse.js` | The x87 coprocessor; the XMM registers and the handful of SSE instructions implemented (not advertised by CPUID). |
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

- **One `ArrayBuffer`**, 16 MiB by default, with `u8` and `DataView` views.
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

A block ends at a control transfer or after 192 instructions. Blocks are keyed by linear address and code-segment size. Under paging a
block also remembers the physical frames it was compiled from: after a CR3 load it is revalidated
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
cycles by default, about 3.3 million instructions per guest second. Nothing reads the host's clock
or `Math.random`, so a headless run is reproducible exactly; that is what the golden gate relies
on. In the browser, `ui.js` paces timer ticks to wall-clock time so that a game runs at its real
speed. [notes/timing.md](notes/timing.md) records how these numbers were chosen.

## Switches

Behaviour that is optional or experimental is selected by a constructor option, or in Node by an
environment variable read at start-up: `MIRAGE_CPU` (the profile), `MIRAGE_PCI`, `MIRAGE_SERIAL`,
`MIRAGE_PITRELOAD` (cycles per timer tick), and a family of kill switches (`MIRAGE_NOD8`,
`MIRAGE_NOXTLB`, `MIRAGE_NOSTRIP`…) that turn one optimisation off so a gate can be run with and
without it. Each is documented where it is read.
