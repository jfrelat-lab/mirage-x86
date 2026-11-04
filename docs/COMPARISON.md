# MIRAGE compared

MIRAGE beside the tools it is measured against every day: **QEMU** (whole-system emulation with
TCG, and `qemu-user` for Linux programs), **DOSBox-X** (DOS, with its own DOS and BIOS), **v86** (an
x86 PC in the browser, compiled to WebAssembly) — and **Docker**, which is not an emulator but is
what most people reach for to "run a program somewhere else". How fast each runs — with PCjs and the
other x86 emulators of the browser, js-dos, RetroTick and CheerpX — is in [BENCHMARKS.md](BENCHMARKS.md).

| | |
|---|---|
| ✅ | yes |
| 🟡 | partly, or with a condition in the note |
| ❌ | no |
| ➖ | does not apply |
| ❔ | not checked by us; from the project's documentation |
| ⭐ | only MIRAGE, of the five |

Rows about MIRAGE are measured in this repository (the tool or document is named). Rows about the
others are what we observed while using them as references (`tools/qemu-*.mjs`, `tools/dbx-*.mjs`,
`tools/diff-v86.mjs`, Docker's `i386/debian` image) or, marked ❔, what their documentation says.
Corrections are welcome.

## What only MIRAGE does

Each line is one capability, so that it can be checked on its own.

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| **DOS implemented in the emulator (HLE)**, in a browser: a `.COM`/`.EXE` starts the moment it is dropped, no DOS image | ❌ | ❌ | 🟡 natively; in a browser through js-dos | ❌ | ✅ `dos.html` (RetroTick does it too, in TypeScript) |
| **XMS (HIMEM) in HLE**: extended memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **EMS (EMM386/LIM 4.0) in HLE**: expanded memory with no driver to load | ❌ | ❌ | ✅ | ❌ | ✅ |
| **DPMI host in HLE**: DOS/4GW, CWSDPMI and DJGPP programs with no extender host to load | ❌ | ❌ | 🟡 through the extender's own host | ❌ | ✅ built-in host (C-Dogs, DOOM, Heretic, Kraptor; RetroTick has one too) |
| **BIOS in HLE**, interrupt services answered in JavaScript, checked against SeaBIOS, DOSBox-X and a vendor ROM | ❌ | ❌ (SeaBIOS ROM) | ✅ its own | ❌ (SeaBIOS ROM) | ✅ |
| **Linux programs without a Linux kernel, in a browser** | ❌ | ❌ (`qemu-user` is native only) | ❌ | ❌ | ✅ `machines.html`, `tools/linux/run.mjs` (CheerpX does it too: WebVM, closed source, WebAssembly) |
| **Linux binaries of 1994–1996**: a.out, libc 4, SVGAlib — no current kernel loads them | ❌ (a.out removed in Linux 5.18) | ❌ | ➖ | 🟡 under an old booted kernel ❔ | ⭐ ✅ id's Linux DOOM (`linuxsdoom`), unmodified, SVGAlib driving the emulated VGA |
| **Windows programs without Windows, in a browser**: kernel32, user32, gdi32, winmm, DirectSound, OpenGL and Direct3D 9 answered in JavaScript, no Microsoft DLL | ❌ | ❌ | ❌ | ❌ | ✅ MIRAGE-WIN32, the scene's intros (RetroTick does it too for GUI programs and OpenGL screen savers, without Direct3D) |
| **Direct3D 9 in a browser**: HLSL and shader-model bytecode translated to WebGL 2 | ❌ | ❌ | ❌ | ❌ | ⭐ ✅ Elevated, Ergon and the 4K intros of 2008–2012 ([3D graphics](#3d-graphics)) |
| **OpenGL with GLSL shaders from a guest program, in a browser** | ❌ | ❌ | ❌ | ❌ | ⭐ ✅ Linux and Windows intros' GLSL 1.10/1.20, vertex and fragment (RetroTick: OpenGL 1.x without shaders) |
| **AVX2 in a browser** | ❌ | ❌ | ❌ | ❌ | 🟡 the VEX operations the Linux 256-byte intros of 2021–2023 use, on YMM registers (JSLinux has all of AVX/AVX2/AVX-512, under its own kernel) |
| **Period software fetched from where its authors published it**, with its terms shown before it runs | 🟡 images from a registry | ❌ | ❌ | 🟡 images hosted by the project | ⭐ ✅ OASIS: 34 recipes, each layer's origin and licence in a dialog |
| **DOS, Linux user space and bare-metal boot in one engine**, the world chosen by the file's signature | ❌ | 🟡 two programs (system, user) | ❌ | ❌ | ⭐ ✅ `tools/run.mjs` |
| **Translated code as readable JavaScript** (`MIRAGE_KEEP_SRC=1`) | ➖ | ❌ | ❌ | ❌ (WebAssembly) | ⭐ ✅ |
| **No WebAssembly, no build step, no dependency** | ➖ | ➖ | ➖ | ❌ | ⭐ ✅ |
| **Runs reproducible to the cycle**: the guest clock follows retired instructions, randomness is seeded | ❌ | ❌ | 🟡 | ❌ | ⭐ ✅ |

## What each one is

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| What it is | containers sharing the host's Linux kernel | system and user-mode emulator | DOS emulator | PC emulator for the browser | PC emulator with built-in DOS, BIOS and Linux system calls |
| Language | Go | C | C++ | Rust → WebAssembly, JavaScript | JavaScript |
| Runs in a browser | ❌ | 🟡 experimental WebAssembly ports ❔ | 🟡 Emscripten ports (js-dos) ❔ | ✅ | ✅ |
| Runs natively / in Node | ✅ | ✅ | ✅ | ✅ (Node) | ✅ (Node) |
| How code is executed | natively (x86 host); through `qemu-user` or Rosetta on an ARM host | JIT to host code (TCG), or KVM/HVF | interpreter or dynamic recompiler | JIT to WebAssembly | x86 code becomes JavaScript source, block by block, compiled by the JavaScript engine |
| To install | Docker Desktop or Engine, a daemon, a VM on macOS and Windows | a package | a package | nothing (a web page) | nothing (a web page), or Node |
| Isolation | namespaces on the host's kernel | full emulation | full emulation | full emulation, browser sandbox | full emulation, browser sandbox; no system call reaches the host |
| Screen and sound | ❌ (headless) | ✅ | ✅ | ✅ | ✅ |
| Networking | ✅ | ✅ | ✅ | ✅ | ❌ |

## What it can run

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| Boot a PC from a floppy, hard-disk or CD image | ➖ | ✅ | ✅ | ✅ | ✅ `boot.html` |
| DOS programs | ❌ | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ |
| DOS extenders (DOS/4GW, CWSDPMI, DJGPP) | ❌ | 🟡 under a booted DOS | ✅ | 🟡 under a booted DOS | ✅ |
| Linux programs, current (static and dynamic ELF) | ✅ | ✅ `qemu-user` | ❌ | ❌ | ✅ Debian 12 i386 binaries (ls, bash, perl, sort…) as Docker prints them |
| Win16 programs | ❌ | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows | 🟡 under a booted Windows 3.0 |
| Win32 programs | 🟡 Windows containers, on a Windows host | 🟡 under a booted Windows | 🟡 under a booted Windows 9x | 🟡 under a booted Windows | 🟡 under a booted Windows 9x; ✅ without Windows for the scene's OpenGL and Direct3D 9 intros (MIRAGE-WIN32) |
| Windows 3.x | ❌ | ✅ | ✅ | ✅ | ✅ 3.0 to the Program Manager |
| Windows 95, 98, ME | ❌ | ✅ | ✅ | ✅ | ✅ the desktop |
| Windows NT, 2000, XP | ❌ | ✅ | 🟡 ❔ | ✅ ❔ | ❌ NT 3.51 stops after the graphical switch; 2000 stays on its boot screen |
| Linux kernels | ➖ | ✅ any | 🟡 old ones ❔ | ✅ | 🟡 2.2 and 2.4 to a shell |
| 64-bit | ✅ | ✅ | ❌ | ❌ | ❌ |

## Processor

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8086 to Pentium Pro instruction sets | ➖ (the host's CPU) | ✅ | ✅ (to Pentium Pro / II ❔) | ✅ | ✅ profiles `386`, `586`, `pentium`, `pentiummmx`, `686`, `pentiumpro`, `pentium3`, `pentium4` |
| Real mode, 16/32-bit protected mode, virtual-8086 | ➖ | ✅ | ✅ | ✅ | ✅ |
| Paging, write protection, 4 MiB pages, hardware task switching | ➖ | ✅ | ✅ | ✅ | ✅ |
| x87 FPU with 80-bit precision | ➖ | ✅ (softfloat) | 🟡 host-dependent ❔ | ✅ ❔ | 🟡 64-bit doubles: musl's `printf("%f")` rounds its last digit differently; gcc's `pr39228` fails |
| MMX | ➖ | ✅ | ✅ ❔ | ✅ ❔ | ✅ `pentiummmx` and up, against Docker i386 |
| SSE, SSE2 | ➖ | ✅ (and later) | 🟡 ❔ | ✅ ❔ | ✅ `pentium3` (SSE) and `pentium4` (SSE2), against Docker i386; a few SSE4.1 operations |
| AVX, AVX2, BMI2 | ➖ (the host's CPU) | ✅ AVX/AVX2 in TCG ❔ | ❌ | ❌ | 🟡 eight VEX operations on XMM and YMM (VMOVDQU/A, VPMOVZXBD, VPSRAVD, VPADDUSB, VMOVD, VPSHUFD, VPBROADCASTB, VBROADCASTSS) and BMI2's SARX: what The Orz's Linux intros use, not the whole extension |
| PAE, APIC, SMP | ➖ | ✅ | ❌ | 🟡 APIC ❔ | ❌ |

## Machine and devices

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| 8259, 8254, 8042, CMOS/RTC | ➖ | ✅ | ✅ | ✅ | ✅ checked against QEMU `-M isapc` and DOSBox-X |
| PCI | ➖ | ✅ | ✅ | ✅ | 🟡 option `pci` (i440FX, PIIX3) |
| ACPI | ➖ | ✅ | ❌ | 🟡 ❔ | ❌ |
| VGA: text, planar, mode 13h, Mode X | ➖ | ✅ | ✅ | ✅ | ✅ pixel-compared with QEMU and DOSBox-X |
| VBE 2.0 linear framebuffer | ➖ | ✅ | ✅ | ✅ | ✅ to 1024×768, 32 bpp |
| S3 / Cirrus / Voodoo accelerators | ➖ | ✅ Cirrus | ✅ S3, Voodoo ❔ | ❌ | 🟡 a Cirrus CL-GD5446 (option `vga: 'cirrus'`): its extended modes, banked window and hardware cursor, checked against its own BIOS under QEMU, enough for XFree86 3.3; no BitBLT engine, no PCI aperture yet |
| Sound Blaster 16, AdLib / OPL | ➖ | ✅ | ✅ | ✅ | ✅ |
| General MIDI (MPU-401, Windows' midiOut and MCI) | ➖ | ❌ | ✅ to the host's synthesizer, FluidSynth or an MT-32 emulation | ❌ | ✅ to a small synthesizer of its own (`src/midi.js`), no sound set shipped; the MIDI player checked against Wine's |
| Gravis Ultrasound, MT-32 | ➖ | 🟡 GUS | ✅ | ❌ | ❌ |
| IDE disks, ATAPI CD-ROM | ➖ | ✅ | ✅ | ✅ | ✅ |
| PS/2 mouse, keyboard | ➖ | ✅ | ✅ | ✅ | ✅ |
| Serial (16550) | ➖ | ✅ | ✅ | ✅ | 🟡 option |
| Network card | ➖ | ✅ | ✅ NE2000 | ✅ NE2000 over WebSocket | ❌ |
| USB | ➖ | ✅ | ❌ | ❌ | ❌ |

## 3D graphics

How a guest program's 3D calls reach the screen. Under a booted system every emulator can run a
software renderer (MIRAGE runs Mesa under XFree86 3.3); these rows are about the API itself.

| | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| **OpenGL 1.x fixed pipeline**: immediate mode, vertex arrays, display lists, lighting, texturing, fog, GLU, GLUT | ➖ | 🟡 a Linux guest through virgl, natively ❔ | ❌ | ❌ | ✅ Linux (libGL, GLX, SDL 1.2) and Windows (opengl32, WGL): PRISM's `gl.js`, held to Mesa headless, WebGL 2 in the page |
| **GLSL** (OpenGL 2.0/2.1: 1.10 and 1.20, vertex and fragment) | ➖ | 🟡 virgl ❔ | ❌ | ❌ | ✅ rewritten to GLSL ES 3.00, with the NVIDIA-era leniencies the intros shipped with (an integer where a float is wanted); `glCreateShaderProgramv` of GL 4.1 |
| **Direct3D 9, HLSL** (shader models 2 and 3, through `D3DXCompileShader`) | ➖ | 🟡 under a booted Windows, software or virgl ❔ | 🟡 under Windows 9x with an emulated card ❔ | 🟡 under a booted Windows, software ❔ | ✅ typed HLSL → GLSL ES 3.00 translator, held to Wine's d3d9; D3DX's texture shaders (`tx_1_0`) and its noise |
| **Direct3D 9 shader bytecode** (vs_1_1–vs_3_0, ps_2_0–ps_3_0, from fxc or `D3DXAssembleShader`) | ➖ | 🟡 as above ❔ | 🟡 as above ❔ | 🟡 as above ❔ | ✅ translated to GLSL ES 3.00 |
| **Direct3D 9 fixed function** | ➖ | 🟡 as above ❔ | 🟡 as above ❔ | 🟡 as above ❔ | 🟡 pretransformed vertices, transform and lighting, texture stages; no fog or point size yet |
| **D3DX helpers** (meshes, text, math) | ➖ | ➖ | ➖ | ➖ | 🟡 what the intros call: the math library, meshes (`D3DXCreateMeshFVF`, polygons, N-patch tessellation, normals), TrueType text meshes, texture fills |
| Direct3D 5–8, DirectDraw | ➖ | 🟡 under a booted Windows ❔ | 🟡 under Windows 9x ❔ | 🟡 under a booted Windows ❔ | ❌ in MIRAGE-WIN32; under a booted Windows 98 not tried |
| 3dfx Voodoo / Glide | ➖ | ❌ | ✅ Voodoo 1 ❔ | ❌ | ❌ |

The OpenGL and Direct3D code is shared with PRISM, the sibling project that compiles the same
period's C sources to JavaScript: one implementation, checked by both.

## Conformance

| Check | Docker | QEMU | DOSBox-X | v86 | MIRAGE |
|---|---|---|---|---|---|
| test386 (the 80386 self-test) | ➖ | ✅ reference | ❔ | ❔ | ✅ to POST FFh (`tools/run-test386.mjs`) |
| SingleStepTests, 8088 vectors | ➖ | ❔ | ❔ | ❔ | ✅ 423,736 vectors (`tools/conformance.js`) |
| Unicorn single-instruction comparison | ➖ | ➖ | ➖ | ➖ | ✅ all green (`tools/test-x86-uc.mjs`) |
| gcc 12.2's execute torture tests (1586 programs, static i386) | ✅ the oracle | ✅ (`qemu-user`, under Docker here) | ➖ | ➖ | ✅ 1585 of 1586 as the oracle (`tools/linux/torture.mjs`); `pr39228` needs the 80-bit x87 |
| Debian 12 i386 binaries, unmodified | ✅ the oracle | ✅ | ➖ | ➖ | ✅ same output on the commands tried |
| Pixel comparisons of DOS demos and games | ➖ | ➖ | ✅ the reference | ➖ | ✅ 44 golden runs (`tools/golden.js`) |

## Speed

Measured, ranked and explained in [BENCHMARKS.md](BENCHMARKS.md): on 32-bit code v86 runs 2.5 to 4
times as fast as MIRAGE on DOS, and v86 and CheerpX 6 to 9 times on Linux; on 16-bit code MIRAGE is
first, headless ahead of native DOSBox-X and in the page ahead of v86; MIRAGE is ahead of js-dos and
RetroTick.

## Where this is going

[ROADMAP](ROADMAP.md) **OASIS** turns MIRAGE into a container runner for the period PC: images (a
world — DOS, Linux user space, Win16, a bootable PC — a machine profile, an entry point, file layers
fetched on demand) run with `oasis run <image>` in a terminal, a native window or the browser, with
a commit that saves the whole machine so that a URL resumes a program where it was.

What MIRAGE does not do (yet): 64-bit, NT-family Windows, networking, USB, ACPI, an 80-bit x87,
and speed close to native-code emulators.
