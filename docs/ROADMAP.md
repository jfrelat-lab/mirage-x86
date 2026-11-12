# MIRAGE — Roadmap

What is open, by theme, one line each. This is a menu, not a schedule. The history of every item —
including the ones that are finished and no longer listed here — is in
[notes/roadmap-log.md](notes/roadmap-log.md).

Effort: **S** a few hours, **M** a day or two, **L** more; ✅ done, 🔶 partly done (the item says what is left).

## Systems that should boot

| Item | Effort |
|---|---|
| ACPI: the tables and the PIIX4 power-management function — ReactOS, and probably Windows XP | L |
| Optional: a cycle rate per CPU profile in turbo and headless runs, where a guest second is 3.32 M instructions whatever the profile. Not a fidelity gap: in real time MIRAGE runs as fast as the host, as QEMU and v86 do, and DOSBox-X's fixed cycles and QEMU's `-icount` do not follow the CPU model either. It would move every headless measurement, goldens included | S |
| Plan 9: an instruction pointer above FFFFh in a 16-bit segment | S |
| Haiku: no desktop after its boot splash (all seven icons lit) | M |
| Try Alpine Linux (i686), Damn Small Linux's desktop, a full FreeDOS install | S each |

## Hardware

| Item | Effort |
|---|---|
| A network card: NE2000 with "no cable" first (ends the driver dialogs in Windows 9x, lets QNX go on) | M |
| Sound — done: OPL3 FM (checked against Nuked-OPL3), Sound Blaster 16 PCM playback to WebAudio, the IRQ and DMA channels its mixer selects, the ASP commands Windows 95's driver probes; General MIDI through an MPU-401 (UART mode), winmm's midiOut and MCI's sequencer, played by a small synthesizer of MIRAGE's own (src/midi.js: no Roland or Microsoft sound set). To do: ADPCM and recording, the Gravis Ultrasound | 🔶 M |
| DMA — done: the 8237 pair (current address and count, terminal count, auto-init) feeding the Sound Blaster. To do: the 82077 floppy controller, bus-master IDE DMA that moves data | 🔶 M |
| **A Cirrus Logic CL-GD5446** (`src/cirrus.js`, `vga: 'cirrus'` / `MIRAGE_VGA=cirrus`, OASIS `machine.vga`) — done: the extensions behind the VGA's ports (SR6 unlock, CR27 part ID, memory and bus registers as the card's BIOS leaves them), extended 8/15/16/24/32-bit modes from its CRTC, the banked A000 window (one or two banks, 4 or 16 KiB units), the hidden DAC, the hardware cursor and its colours — checked against the real CL-GD5436/46 BIOS 1.25 under QEMU (`tools/cirprobe.asm`). XFree86 3.3's `clgd5446` driver runs on it at 800x600. To do: the PCI device (1013:00B8) and its linear aperture, the BitBLT engine (XFree86's acceleration, Windows 95's and NT's Cirrus drivers), its own VGA BIOS's VBE modes setting its registers | 🔶 M |
| A `486` profile; MMX for a Pentium II | M |
| RTC alarm and update interrupts, a valid CMOS checksum; COM2-4; a parallel-port stub | S |

## Performance

| Item | Effort |
|---|---|
| Compilation of cold blocks: about a fifth of a Windows 98 boot | M |
| Dispatch between blocks: ✅ under paging a block goes on through forward branches (side exits, skips), loops and followed calls, so Dhrystone runs some 30 instructions a dispatch where it ran five (docs/RECOMPILER.md); to do: the same without paging, where the DOS golden runs are timed to the block, and the second tier, which needs an instruction budget before it can be switched back on | 🔶 L |
| Byte-granular tracking of compiled code for the write barrier | M |
| Lazy flags, inline caches for indirect calls, registers as locals, a worker thread, an intermediate representation | L each |

Rule for all of them: a change that speeds up the paged systems must not slow the DOS player
(see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## The DOS player

| Item | Effort |
|---|---|
| Extended (E0h) scancodes for the arrow and navigation keys | S |
| Heretic on its own extender, without our DPMI host | M |
| Quake, pixel for pixel against DOSBox-X | M |
| More demos and games as test candidates; re-run the titles marked *Unknown* in COMPATIBILITY.md | M |
| The FCB file calls of INT 21h; the two failing checks of `tools/test-dos-api.js` | S |

## Exchanges with the host

| Item | Effort |
|---|---|
| Drop files into C:, download what a program wrote | S |
| Paste text as keystrokes, copy text off a text screen | S |
| A floppy or CD image built from dropped files | M |
| Read and write the hard-disk image from the page | M |
| The network card with no cable, then a cable between two machines, then between distant players | L |
| A shared clipboard, a shared folder, Internet access from the guest | L |
| **One drop for every machine**: a file dropped (or opened) on any machine's page goes to the world it belongs to, detected as `oasis run` detects it — an MZ `.COM`/`.EXE` to DOS, an i386 ELF to Linux (with the framebuffer size menu, Linux alone), a disk image to the bare PC, a `.zip` by what it holds — and the page says which ("ELF i386 → Linux"). What it cannot run yet is refused by name rather than started in the wrong world: an NE or PE `.EXE` ("Win16/Win32: MIRAGE-WIN32"), a shell dropper without busybox (Twigs), a dynamic ELF without its libraries | S |
| **The network, in three deployments** — one `src/net.js`, the same guest side (MIRAGE-LINUX's sockets; an NE2000's Ethernet frames) over an interchangeable transport: `direct` (Node: `run.mjs`, `oasis run --terminal`), `ws` (a WebSocket relay — modes 1 and 2 speak one protocol), `local` (the page alone). The page chooses by parameter (`?net=ws://…`, `?net=local`) and falls back to mode 3 when there is no server | — |
| **Mode 1, server + browser**: `oasis serve` relays — Node opens real TCP/UDP sockets (`net`, `dgram`) and resolves names (`dns.lookup`), forwards ports into the guest, and is a hub for a LAN between tabs and machines. Listening on localhost by default, with an allowlist of hosts and ports and a token when exposed (a relay is an open proxy). A WebSocket server with no dependency (handshake and framing). First user: AF_INET for MIRAGE-LINUX — wget, lynx, apt, Quake without `-noudp`, X clients over TCP | M |
| **Mode 3, browser only**: no raw sockets — a LAN between tabs of one browser over `BroadcastChannel` (DOOM in IPX, Quake in UDP, a Windows 95 network neighbourhood), the guest's HTTP turned into `fetch()` (CORS permitting), names by DNS-over-HTTPS; between machines WebRTC, with signalling by hand (a code to copy) or by a relay. Loopback always works | M |
| **Mode 2, external relay + browser**: a static page (GitHub Pages) and the URL of a relay — the network's relay taken out as `tools/relay.mjs`, deployable anywhere. Opt-in and said plainly: the traffic goes through a third party | S |
| **The NE2000 on v86's relays**: if the NE2000 speaks their protocol (raw Ethernet frames over WebSocket), the public relays v86 uses serve full systems (Windows 9x, Linux kernels) with no NAT of our own; else a user-mode NAT (QEMU's slirp) in Node | L |

## Outside the browser

| Item | Effort |
|---|---|
| The serial console in a terminal, like `qemu -nographic` | S |
| VGA text as ANSI; graphics through terminal image protocols | M |
| **Recording to MP4 with sound** — done: the pages' Record button (src/recorder.js: the canvas and the sound worklet in a MediaRecorder, MP4 where the browser writes it, else WebM, in real time); `tools/record.mjs` films a DOS title headless, a frame every 1/30 s of guest time with its sound, frame-exact whatever the host's speed; `tools/webp.mjs` makes the README's animated WebP. To do: the button on dos.html and boot.html, `record.mjs` for boot images | 🔶 S |
| **User-space Linux (MIRAGE-LINUX)** — done: static, Debian dynamic (ELF, PIE, the interpreter) and a.out programs; processes (fork, exec, wait, pipes, taking turns); the console (n_tty line discipline, the VGA text screen and its cursor, the keyboard in XLATE, MEDIUMRAW and RAW); ioperm and /dev; Debian 12's bash runs id's 1994 DOOM and comes back when it quits. Dhrystone at 830 000-875 000 a second, 420-450 M instructions/s (2026-11-02) | 🔶 — |
| **Processes run in turn**: a queue in src/linux.js, switching on a system-call boundary — when a call blocks (the process retries it on its next turn), after a 20 ms quantum, at nanosleep; an empty pipe blocks while a writer is open somewhere; wait4 waits for a living child; the first process ends the run, as PID 1 does a container. DOOM's sndserver now starts beside it (and stops at /dev/dsp). A switch keeps the translated code: the CR3 load starts a new epoch and each block is checked against its frames — DOOM with its sndserver runs within 10% of DOOM alone | ✅ |
| **Signals** delivered to the handlers a program installs, as i386 Linux delivers them: at a system call's end or to a call that waits (EINTR, or run again with SA_RESTART); sigframe and rt_sigframe on the user stack, sigreturn / rt_sigreturn, the x87 and SSE state kept beside; rt_sigaction, sigaction, signal, the masks, sigsuspend, pause, sigpending, alarm and setitimer; SIGCHLD at a child's end, kill between processes, SIGINT from ^C, faults with a handler (`tools/linux/signals.asm` answers as Docker i386 does). **Waits that wait**: nanosleep, select and poll sleep until their timeout, every process asleep moves the guest's clock to the first deadline (`tools/linux/sleeps.asm`). Process groups and sessions (setsid, setpgid, kill to a group), a controlling terminal per process (/dev/tty, TIOCSCTTY, the foreground group). To do: job control's stops (^Z, SIGTSTP, SIGCONT), signals to a process computing without system calls | ✅ |
| **Pseudo-terminals**: the BSD pairs /dev/ptyp0-f and /dev/ttyp0-f that libc5 and xterm 3.3 open, Unix98's /dev/ptmx and /dev/pts/N (TIOCGPTN, TIOCSPTLCK); the line discipline between master and slave (ICRNL, ICANON's editing, ECHO, ^C to SIGINT, OPOST/ONLCR), the window size and SIGWINCH, EIO and the end when a side is gone; /proc/self/fd/N for ttyname (`tools/linux/pty.asm` answers as Docker i386 does). `linux/x11-1997` opens an xterm with a shell in it. To do: TIOCPKT, the console's own /dev/vcs | ✅ |
| The 80-bit x87: extended precision where a program asks for it, not float64 | M |
| Threads: clone with a shared address space, futex, thread-local storage (set_thread_area) — after processes taking turns. ✅ The machinery: lx.spawnThread (a thread in its process's address space, lx.vm, in the queue with the processes, preempted to), exit ending a thread alone, a fault killing its group; SDL's threads and audio callback stand on it (Make It 4K, Retrospection, Yellow Rose play their music). To do: clone(CLONE_VM) and futex for programs that make threads themselves | L |
| **Sockets** — ✅ Unix stream sockets: socket, bind (a path or an abstract name), listen, connect, accept, socketpair, shutdown, get{sock,peer}name, SO_PEERCRED, send/recv/msg, through socketcall and the direct calls; poll and ppoll; a read waits while the peer is open. To do: AF_INET (TCP/UDP through the network's transport: Node directly, a WebSocket relay, or the page alone) for OASIS's network and Docker images, file descriptors over sendmsg (SCM_RIGHTS) | L |
| A fuller /proc and /sys (self, cpuinfo, meminfo, mounts, the pid directories) for the tools that read them (ps, top, free) | M |
| **Sound: /dev/dsp (OSS)** — write mode (DOOM's sndserver, paced by the card's buffer) and mmap mode (Quake mixes into the card's buffer and asks GETOPTR, as PRISM's dsp.js taught: MMAP in GETCAPS, a power-of-two buffer, GETOSPACE as geometry); the samples go to src/audio.js beside the Sound Blaster, heard in the page; `MIRAGE_LXWAV` records them headless | ✅ |
| **Mouse, display and X11** — ✅ the page's mouse on /dev/mouse (Microsoft serial, SVGAlib) and /dev/input/mice (PS/2); ✅ /dev/fb0 (busybox's fbset and fbsplash); ✅ **X11**: `linux/x11-1997` runs XFree86 3.3's SVGA server (Debian 1.3) on the emulated VGA, 320x200x256 through its ports, with twm and oclock over a Unix socket — the X server of 1997 on no Linux kernel. ✅ **id's X DOOM, built in the tab, plays on it** (`linux/doom-x11`: gcc 2.7.2, XFree86 3.3, twm, MIT-SHM). ✅ **A larger screen**: the same 1997 server's `clgd5446` driver on an emulated Cirrus GD5446 — 800x600 at 256 colours, DOOM in a 640x400 window (`-2`). | M |
| x86-64 user space: the long-mode decoder and 64-bit registers, the x86-64 system call table — what most Docker images are | XL |
| **Quake for Linux** (id's svgalib `squake` 1.1, 1997): `linux/quake-1997` plays its demos — mprotect sets page rights (Quake patches its own code), libc5 and svgalib from Debian 1.3, `pak0.pak` from id's `quake106.zip` through an LHA layer (`src/lha.js`). Its sound plays through /dev/dsp in mmap mode; it runs with `-noudp` until AF_INET sockets | ✅ |
| **Build DOOM inside MIRAGE-LINUX** (`linux/doom-build`): Debian 1.3's gcc 2.7.2.1, binutils and make build id's 1997 sources — `sndserv` in 82 s host (DOOM 1994 then plays with it: 186 s of sound), and `linuxdoom-1.10`'s 62 files compiled and linked (`linuxxdoom`, X11: it runs with X11) — 18.5 min host at first, 372 s with the recompiler's translation memo across exec; `linux/doom-x11` builds it once in a `run` layer and starts with the game already there. The image supplies `errnos.h` and an empty `libnsl.a`, which libc5 no longer ships; id's sources are untouched | ✅ |
| **A Linux without a distribution**: `linux/doom-mini` — static busybox 1.35 (an OASIS `busybox` layer links its 402 applets from its own `--list`), ld.so, libc4 and libvga, linuxsdoom and its WAD: about 4 MB; busybox's shell starts DOOM. Debian stays the fidelity reference | ✅ |
| **Libraries in JavaScript beyond svgalib** : the part of libc4 an old binary uses (DOOM: some sixty functions), so a program runs with no library of its time — optional, less faithful than the real code | L |
| **A window manager in JavaScript** (`machine.wm: "hle"`), in three depths: (1) an X client written in JavaScript, connected to the real XFree86 through MIRAGE-LINUX's own Unix sockets (no guest code): SubstructureRedirect on the root, MapRequest, ConfigureRequest, InstallColormap, focus — windows placed without asking, the active window's colormap installed (DOOM's colours without twm), titles and controls drawn in HTML around the canvas, no guest CPU spent; the server stays the real one on the Cirrus, so fidelity is unchanged; (2) rootless, as XQuartz or Xpra: each top-level window a draggable element of the page, cut from the Cirrus's picture by the geometry the WM knows; (3) with the libraries in JavaScript, no X server at all for the programs that allow it: a binary's `libX11.so.6` replaced by PRISM's `x11.js` (Xlib shimmed at the library, not the protocol) — DOOM and Quake in X with no XFree86 start-up; Xt/Xaw programs (xbill, xjewel, twm) keep the real server. The real twm stays the default | M |
| **X starts in seconds**: measured, the server answers its first client after 2.3 guest seconds (4.7 s host), xkbcomp 12% of it — the minutes were the waits that did not wait. A precompiled keyboard map would save little | ✅ |
| **/dev/audio** (Sun's µ-law at 8 kHz) beside /dev/dsp, for the programs that write µ-law there. XBoing needs none: its soundIt library decodes its .au files and plays them on /dev/dsp — ✅ `linux/xboing-1997` runs with -sound | S |
| **A home that stays**: /root kept in the browser between visits (OPFS) — high scores, a shell's history, the files a program made; OASIS's persistence on the user's side | M |
| **Files in and out**: a file dropped on the page lands in /root; a file a program wrote can be downloaded, as the DOS player does | S |
| **A Linux machine's snapshot** (with OASIS's persistence and snapshots): its processes, pages, descriptors and file tree serialized — saved once X runs and the game shows, resumed in a second | M |
| **strace in the log**: the system calls as they are made, by process, filterable — what a program of 1997 asks of its kernel | S |
| **TinyCC** (i386, static): C compiled in milliseconds in the page — a 1997 C sandbox beside PRISM's | S |
| **MIRAGE-LINUX against Docker's i386 emulation (qemu-user) and a whole Linux under v86**, the same binaries timed — a table for the showcase | S |
| **A shared clipboard**: X's selections and the browser's, through the JavaScript window manager | M |
| **Quake II for Linux** (3.20, 1998) with id's demo — ✅ `ref_soft.so` on SVGAlib (`linux/quake2-1998`: libc5, Debian 1.3's svgalib, 320x240 in mode X). ✅ `ref_softx.so` on X11 (`linux/quake2-x11-1998`). ✅ `ref_gl.so` (3dfx: `linux/quake2-gl-1998`, fxMesa in JavaScript). To do: `ref_glx.so` (GLX drawn into a window of the emulated X server) | 🔶 S |
| **Terminal games** of Debian 1.3: NetHack 3.2, Angband, Moria, bsdgames — termcap and ncurses, the tty's ioctls, ANSI on the VGA console | S |
| **X11 games** of Debian 1.3 — ✅ xboing, xbill, xjewel on the Cirrus: `linux/xbill-1997`, `linux/xboing-1997`, `linux/xjewel-1997` — one image per game, each starting the X server, twm and its game itself, the three with the same layers so the cache serves them all (xboing's private colormap recolours the rest of the screen while it has the focus, as 8-bit X did). To do: xgalaga (Debian 2.1 only: glibc beside libc5); then Abuse (Crack dot Com, 1996, X11 and SVGAlib, its data in the public domain) | S |
| **Network games**: xpilot, Netrek — UDP and TCP between tabs or machines, the first users of the network's relays | M |
| **Loki's Linux demos** (Heretic II, Railroad Tycoon II, SimCity 3000, Myth II, 1999-2000): SDL and LinuxThreads — after threads (clone, futex) | L |
| **DOSEMU 0.66** (Debian 1.3): DOS under MIRAGE-LINUX through the `vm86` system call, on the CPU's V86 mode — DOS DOOM under DOSEMU under a Linux with no kernel | L |
| **Wine of 1997**: Win16 freeware under MIRAGE-LINUX — `modify_ldt` and the LDT; an oracle beside MIRAGE-WIN32's Win16, never a part of it | L |
| **OpenGL** — ✅ (1) Mesa in software: `linux/mesa-1997`, Mesa 2.2 and GLUT 3.3 of Debian 1.3, their demos (gears, bounce, isosurf, reflect, texobj, atlantis) built by gcc 2.7.2 in a run layer, gears at some 20 frames a second on XFree86 3.3; `linux/xscreensaver-gl-1998`, Debian 2.0's XFree86 3.3.2 and Mesa 2.6 with xscreensaver-gl's nine OpenGL hacks, 20 seconds each. Next, **with PRISM's `gl.js`** (OpenGL 1.1's fixed pipeline in JavaScript, held to Mesa by PRISM's gates; GLX, GLU, GLUT, fxMesa): (1) Mesa 3.0's software renderer and `glxgears` run in MIRAGE, their frames compared one by one with `gl.js`'s — a cross oracle, and a benchmark against Docker i386; (2) ✅ first: the scene's Linux OpenGL intros of 2003-2010 (`oasis/images/linux/`), their libGL and libGLU PRISM's `gl.js` and `glu.js`; ✅ then a binary's `libMesaGL`/`libGL` replaced by `gl.js`'s entry points and rasterised by WebGL2 — GLQuake 0.97 and Quake II's `ref_gl` through MIRAGE's fxMesa (`src/hle/fxmesa.js`), at the GPU's speed; (3) the Quake III Arena demo (1999), which needs multitexturing and vertex arrays beyond 1.1 | XL |
| **Interpreters and big X programs as benchmarks**, each against Docker i386: Tcl/Tk 8.0 (`wish`), Perl 5.004, Python 1.5, teTeX, Emacs 19 under X, xv | M |
| **MIRAGE-WIN32 and Win16** — MIRAGE-LINUX's counterpart for Windows programs, high-level emulation only: a PE (Win32) or NE (Win16) `.exe` run with no Windows, every API it imports answered in JavaScript — no DLL of Microsoft's or Wine's. It stands on what exists: the CPU and its protected mode (16-bit segments for Win16), the recompiler, the flat user address space of `src/linux.js`, the HLE DOS (`src/dos.js`) for the INT 21h calls Win16 programs still make, OASIS's file tree, the audio, the canvas. One window system in JavaScript (windows, messages, device contexts) with two faces: Win16's (pascal calls, far pointers) and Win32's (stdcall). Oracles: the same `.exe` on Windows 3.1 and Windows 98 booted in MIRAGE, screen against screen; Wine in Docker i386 as a second opinion. Steps W1-W7 below | XL |
| The PE loader (sections, relocations, imports bound to JavaScript entry points, the TEB at `fs:`), kernel32 for the console, the C runtime's msvcrt in JavaScript: console tools — nasm.exe, tcc.exe compiling in the page | M |
| Structured exception handling (SEH), threads (with clone and futex), files on OASIS's tree; `world: "win32"` in OASIS — an image per program, as for Linux | M |
| **Win16**: the NE loader (segments as LDT selectors, relocations, imports by ordinal), KERNEL's tasks, global and local heaps, resources, its INT 21h through the HLE DOS; `world: "win16"` in OASIS — Windows 3.x programs with no Windows 3.x | L |
| USER and GDI, shared by Win16 and Win32: windows, the message loop, dialogs and controls, fonts, `BitBlt`/`StretchDIBits` to the canvas, timers, keyboard and mouse — the freeware and shareware of Windows 3.1 and 95. 🔶 Win32 started with Half-Life's MFC launcher (1999): several windows (children, popups, a dialog application on the desktop), dialogs from their templates, the system controls painted (owner-drawn buttons through `WM_DRAWITEM`), `WM_PAINT` when the queue is empty, the mouse to the window under it, resources (strings, bitmaps, dialogs), a registry in memory. Half-Life itself: its engine starts, its map runs and is drawn (software renderer, DirectDraw) since FPTAN clears C2 -- Wine 10 under Docker is the oracle; not offered as an image: the demo's licence forbids redistribution. Jazz Jackrabbit 2's shareware (1998) plays: a splash, then its game window, 8-bit DIB sections, its keyboard through a WH_KEYBOARD hook. Menu bars drawn and used, modal dialog boxes, timers, accelerators, msvcrt's start-up: Windows 2000's Minesweeper plays (run locally as a test, Microsoft's). Next, by the same tests: Solitaire and FreeCell (cards.dll, crtdll.dll for NT 3.51), Pinball (mmio, _lopen, palettes), Spider; MCI's AVI video done for 8-bit uncompressed and RLE8 with PCM (Half-Life's intro), Cinepak and Video 1 when a program needs them | 🔶 L |
| DirectDraw, DirectSound, DirectInput — done: DirectSound (dsound.dll: secondary buffers played from guest memory), DirectDraw 1 (ddraw.dll: display modes, flips, copies, palettes, colour keys; Quake II's software renderer full screen). GDI on surfaces (GetDC) and DirectInput with no controller (Cave Story, 2004, run locally). To do: DirectDraw's later interfaces where a program needs them | 🔶 L |
| opengl32 on PRISM's `gl.js` (with Linux's OpenGL): OpenGL 4k/64k intros, GLQuake for Windows — ✅ the scene's Crinkler-packed OpenGL intros run on the **Windows** machine (`machines.html?m=win32`): the PE mapped as XP maps it (/TINYHEADER images flat), the PEB/TEB and loader lists XP's (what Crinkler walks to import by hash), opengl32's 368 ordinals XP's (its /RANGE imports), every immediate-mode spelling, GLSL, framebuffer objects, display lists, kernel32/user32/gdi32/winmm/msvcrt/glu32 in JavaScript; threads (CreateThread on src/linux.js's threads, each its TEB) and waveOut (looped headers included); SwapBuffers with one frame in flight — To the Road of Ribbon, Flow2, Chocolux, Retrospection, Paradistance, Hartverdrahtet, Absolute Territory (`oasis/images/win32/`). To do: CPU speed for the synthesizers that need a 2009 PC to keep up — Valleyball's now renders at 0.97 of real time in the page (it was a third), Stripped's precalculation lasts minutes; Waillee and Kindernoiser wait on PRISM's cost per pass; GLQuake | L |
| **Direct3D 9** on PRISM's device model (`vendor/prism/src/env/d3d9.js`, HLSL translated to GLSL ES by its `hlsl.js`, drawn by WebGL2) — ✅ d3d9.dll and d3dx9_24..43.dll in JavaScript (`src/win32/d3d9.js`): the COM objects and their vtables in guest memory, D3DXCompileShader handing the HLSL source on in a blob PRISM reads; the Pentium III and Pentium 4 profiles (SSE, SSE2) the intros are compiled for; cdak (Quite & Orange, 2010) and yes we can (Quite, 2009) at 60 frames a second; Photon Race 2 (Archee, 2008): HLSL vertex shaders, four float16 render targets at once. ✅ ID3DXMesh, D3DXCreatePolygon, D3DXTessellateNPatches (PN triangles; Wine has a stub) and D3DXFillTexture (the program's function called by code made in guest memory): Elevated, the top 4K of Pouët, renders (PRISM: render targets read back, vertex textures, buffers kept in GL); d3dx9's ordinals as Microsoft's, skins, adjacency, normals (Stiletto's mesh). ✅ D3DXCreateText (Wine's outlines and triangulation) on TrueType fonts read in JavaScript, the visitor's Tahoma or DejaVu Sans; lights and material handed to the device model. ✅ Texture shaders evaluated by PRISM: Ergon's tx_1_0 and noise(). Next: Stiletto on PRISM's fixed function (white so far), the early faults of Polystreptikum and Synchroplastikum, Wishful Twisting's precalculation, Darwinism's 180 M x87 instructions a frame (a frame a second on one core), Atrium's precalculation; PRISM's side: vertex declarations | L |
| A native window with sound — for OASIS's `oasis run` | M |

## OASIS — images for every world of the period PC

A container format and runner on MIRAGE, the way Docker is one on Linux: an **image** is a manifest
(the world — DOS, Linux user space, Win16, a bootable PC — the machine profile, the entry point) and
file layers fetched on demand; `oasis run <image> [cmd]` runs it in a terminal, a native window or
the browser. What Docker does not: no daemon and nothing to install, the same x86 on every host
(phones included), a VGA screen and a Sound Blaster, period binaries (DOS, DPMI, a.out, Win16),
runs reproducible to the cycle, and a commit that saves the whole machine — CPU included — so a URL
resumes a program at the instant it was taken. The name: what a mirage promises, an oasis is.

| Item | Effort |
|---|---|
| OASIS's manifest and layers are done: [OASIS.md](OASIS.md) (the manifest, the layers), `node tools/oasis.mjs list|inspect|pull|run` with a window in app mode or the terminal; `linux.html` | ✅ |
| Layers in the browser — ✅ a page builds an image's tree itself (`src/oasis-layers.js`): archives through the `oasis-fetch` relay (`functions/oasis-fetch.js` on Cloudflare Pages, `oasis serve --static`), unpacked in the page, busybox and run layers run on MIRAGE-LINUX there, all kept in Cache Storage. To do: Docker images pulled from the registry through the relay (linux/mirage, debian-bookworm); `tools/oasis.mjs` on the same in-memory tree (unpacked on macOS's case-insensitive disk, xbase's `/etc/X11/Xserver` and `/etc/X11/xserver/` overwrite each other); files read on demand (byte ranges) rather than whole archives | M |
| Output: done for a window in app mode (DOS, Linux) and the terminal; to do: ANSI in the terminal, mouse and sound for Linux, a WebView | M |
| `commit`: done for the file tree — a `run` layer (a Dockerfile's `RUN`) keeps what a command made, cached under a hash of the layers below it (`linux/doom-x11` builds DOOM once). To do: the machine state (`tools/snapshot.mjs`), and URLs that resume or replay a run | L |
| Images: 34 (`oasis/images/`: DOS, Linux, Win32); to do: `win/3.0`, more | M |
| **One format for MIRAGE and PRISM (manifest v2)**: an image says what world a program needs, not which engine runs it — the difference is where the program comes from. `binary`: the layers that hold the executable, run by MIRAGE; `source`: the sources and how to build them (`dir`, `make`, `defines`, `to`), compiled by [PRISM](https://github.com/jfrelat-lab/prism) to the same path. Shared: `world`, `machine`, the data layers, `entry`, `output`. An image may have either or both; with both, `oasis run --from binary\|source` chooses. The compiler follows from the world (`linux`: i386 System V and libc); `dos` names its original toolchain (`djgpp`, `borland`, `watcom`) since the ABI depends on it | M |
| **Twin images as a cross oracle**: one image, two origins — `linux/doom-1994` from id's binary of 1994 (MIRAGE) and from the 1997 source release (PRISM), same data, frames compared at equal points | M |
| **`hle`: libraries the environment supplies in JavaScript**, common to both engines — PRISM compiles against the headers and links its own; MIRAGE replaces the library's a.out jump table (`libvga.so.1`) with entries into the same JavaScript. First: svgalib, PRISM's `src/env/svgalib.js` moved into a module both projects share, with an adapter for MIRAGE's guest pointers. Optional per image: without it the binary keeps Debian's real svgalib, the better test of the emulated VGA. To check first: which svgalib calls linuxsdoom makes beyond Quake's nineteen, and the jump table's slot names | L |
| **Instant start from a snapshot** (with OASIS's persistence): an image may carry the machine already booted — Windows 98's desktop or a bash prompt in milliseconds instead of a minute | M |
| **Record and replay, and stepping back in time**: MIRAGE is deterministic to the cycle, so `oasis run --record` keeps the inputs and `oasis replay` runs the same execution again; snapshots plus replay give reverse debugging, as `rr` does | L |
| **An image is a URL, and an element to embed**: `<oasis-run image="linux/doom-1994">` in a blog, a manual or a museum's page, on phones and offline (PWA) | M |
| **Docker i386 images in the browser**: `oasis import docker://i386/debian` (the `docker` layer exists) — a Linux container without Docker, on an ARM Mac or a phone. Limits: i386 only (most of Docker Hub is amd64), one process at a time, no sockets yet | M |
| **A sandbox with no shared kernel**: old or suspect binaries (DOS viruses, unknown i386 ELF) run with nothing of the host reachable | S |
| **`Oasisfile`**, the Dockerfile of OASIS: its `RUN` steps execute inside the emulated world (`make` under DJGPP, Turbo C or Watcom in MIRAGE), so images are built with the tools of their time | L |
| **Volumes**: `-v .:/work` mounts a host directory as C: or a Linux directory (the host file provider exists) | S |
| **Network and `compose`**: an NE2000 and IPX/TCP over WebRTC or WebSocket — DOOM deathmatch between two tabs, a BBS or a MUD on `-p 23:2323`. The transport is the network's | L |
| **`oasis diff` and tracing**: the files a run changed, and its system calls (`strace`) or DOS calls (INT 21h) as the tool's own output | M |
| **`oasis.lock`**: each layer's SHA-256 pinned, with fallback mirrors (Software Heritage, the Wayback Machine), so an image still runs when its archive is gone | S |
| **`oasis test` for CI**: run headless and compare the output or the screen with a reference — continuous integration for period software (16-bit code, Turbo Pascal), as a GitHub Action | M |
| **A period speed, guaranteed**: `--cpu 386@33MHz`, held in cycles, for programs that time themselves on the CPU | S |
| **OASIS in the pages, for every world**: the page's OASIS panel speaks of Linux alone, while images are `dos` too (C-Dogs, DOOM) and will be `win16`/`win32`. One OASIS source for the pages, each image started on the machine its `world` names; the hosted examples (`examples/manifest.json`: a file, its licence, a picture) stay beside it, simpler for what is kept here — a 4 KB demo needs no recipe of layers | M |
| **One showcase**: the home page has three kinds of cards (the DOS examples, the OASIS Linux images, "Booted by MIRAGE"), each from its own list and drawn its own way; the machines page another. One list — the examples' manifest and the OASIS index merged, each entry with its world, picture and provenance (kept here, or fetched from its source) — filtered by world wherever it is shown. The Linux intros of pouët and scene.org enter it as any entry | M |

## The project

| Item | Effort |
|---|---|
| The home page exists (`index.html`: boot-sector programs, MIRAGE's demos, freeware and shareware DOS games, free intros, a FreeDOS disk — `examples/manifest.json`); to do: publish it, ship the GPL systems' sources beside them (FreeDOS), KolibriOS | S |
| `boot.html`: a memory choice that matches what the examples ask for, drag-and-drop of an image | S |
| Tools that find `nasm`, `qemu` and `dosbox-x` on the PATH instead of in Homebrew's directory | S |
| Sort `tools/`: the gates and probes apart from the one-off investigations | M |
| One launcher for both machines: a profile plus content | M |
