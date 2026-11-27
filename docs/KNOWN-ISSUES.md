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
| Windows 2000 | its boot screen, progress bar empty, at the default headless rate | **Speed**: the boot screen scrolls a band from a timer DPC; at 3.3 M instructions a guest second each step costs 0.1-0.15 guest s and the DPC takes 99 % of the processor. At 5 times the rate (`MIRAGE_PITRELOAD=912920`) it reaches the desktop. |
| ReactOS 0.4.15 | a stop in the kernel | **Known**: no ACPI tables. |
| Plan 9 (9legacy) | after the kernel is entered | **Known**: it runs with an instruction pointer above FFFFh in a 16-bit code segment, which MIRAGE does not handle. |
| Damn Small Linux 4.4.10 | a black screen at runlevel 5 | **Unknown**: not investigated — it may only be slow. |
| XCOM (`xcom144.img`) | its 640×480 screen draws as noise | **Display, suspected**: the system runs (HDPMI32, its FreeDOS); its desktop was drawn in 2026-09. |

## Time

- **Headless, a guest second is 3.32 million instructions**, whatever the processor profile (the
  PIT's rate, set to match DOSBox's work per frame). In the page the clock is real time and the
  processor runs as fast as the host. A late system run headless sees a slow processor: Windows 2000
  (above) needs 5 times the rate. A rate per profile is on the roadmap.
- **The real-time clock starts at 1 January 1990, 08:00** in headless runs, so that runs repeat
  exactly; a guest then sees files "from the future". `MIRAGE_RTC=hostdate` starts it at the host's
  date instead.
- **The timer interrupt rate is capped** at about 1165 Hz (a reload of 1024 PIT ticks). Keen 4 and Wolf3D ask for 561 and 700 Hz and get them; Chrome Revenge asks for 17.5 kHz
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
| Zone 66 | after its intro and five story pages, a black screen for minutes; not investigated (it also refuses any XMS driver, as on DOSBox-X: run it with `?xms=0`) |
| C-Dogs 1.06 | silent: its DSIK Sound Blaster driver polls the 16-bit DMA channel 5's count and plays nothing. Not investigated further |
| oktaeder | programs PCI hardware directly and relies on a register DOS leaves by accident; it derails on DOSBox-X too |
| Heretic without our DPMI host | its bound DOS/4G faults after entering protected mode by itself |

## Windows programs (MIRAGE-WIN32)

| Missing | Consequence |
|---|---|
| DirectInput; DirectDraw 2 and later | Programs that need them stop. DirectSound and DirectDraw 1 (DirectX 1-3's interfaces: 8-, 16- and 32-bit modes, flips, copies, palettes, colour keys) are there; DirectDraw's later interfaces (IDirectDraw2, 4, 7) and drawing on a surface with GDI (GetDC) are not. |
| Direct3D 9 beyond shaders | PRISM's `d3d9.js` draws with HLSL shaders and the fixed function's default texture stage (Stiletto's lights and material); other texture-stage operations (Darwinism), vertex declarations, stencil, alpha test, `Reset` (Wishful Twisting), volume textures and cube textures as render targets (Synchroplastikum) are not there yet. |
| D3DX beyond HLSL | Shader assembly, `ID3DXFont`, effects and sprites are not done. Matrix stacks, boxes, meshes, skins, N-patches, normals, adjacency, `D3DXFillTexture`, texture shaders (`D3DXFillTextureTX`) and text meshes (`D3DXCreateText`) are. |
| Windows fonts | MIRAGE ships none. An image lists the ones it selects (`machine.fonts`); the page reads the visitor's own (Chrome's Local Font Access, after asking) or else uses DejaVu Sans, whose shapes and widths differ. Glyphs are not hinted. A text mesh in a font the page does not provide stops the program (luxo4k asks for Times). |
| One emulated core | Threads take turns on one CPU at about 200 M instructions a second: Darwinism (180 M x87 instructions a frame) draws a frame a second, Stripped's precalculation lasts some 3 minutes and its frames come slowly (240,000 `glVertex3f` each). |
| gdi32's ordinals | Crinkler's /RANGE imports by ordinal; MIRAGE's gdi32 does not number its exports as Windows XP's (no intro met needs it yet). opengl32's and d3dx9's are numbered as Microsoft's. |
| Win16 | No NE loader yet. |
| Windows files | MIRAGE ships none of Windows' own data: Polystreptikum's synthesizer plays the instruments of XP's `drivers\gm.dls`, reads zeros and divides by zero. |

## WebAssembly programs (WASI)

| Limit | Consequence |
|---|---|
| No JSPI in Safari | A read that would wait answers EAGAIN instead: scripts run, python3's REPL does not. Chrome and Node 26 have JSPI; Firefox is not checked. |
| No working directory in WASI preview 1 | `getcwd` says `/`; a relative path still reaches the working directory through the preopens, except a name the working directory shares with the root. |
| Time in a module is not charged to the guest's clock | While a module runs the guest's clock stands still, so a run mixing WASI and x86 processes is not timed as the x86 alone would be. |
| No kept moment | A machine running a module cannot be kept or restored: its memory and its suspended stack belong to the browser's engine. |
| No `termios` in WASI | CPython prints "can't use pyrepl" and uses its basic line editor, as on every WASI runtime. |

## node in HLE

| Limit | Consequence |
|---|---|
| ES modules made from their source | A module is its source with its imports and exports taken out, compiled as a function (src/node/esm.js), not the engine's own module: the same bindings, cycles, errors and output as Node on tools/node's scripts, but a namespace is extensible, a module's first line reports columns shifted, and an `import(` or `export` that only a full parser would tell from a regex may be misread. Not here: loaders and hooks (`module.register`), import maps, `data:` URLs, WebAssembly modules, `import defer` and source imports. |
| No network, worker threads; no IPC for children | `http`, `net` and their kin throw "not available in MIRAGE yet"; so do `child_process.fork` and an `'ipc'` stdio (spawn, exec, execFile and their Sync forms work). A child is made and exec'd by the kernel at once (posix_spawn), so its start costs no guest time: an order that depends on how long a child takes to start may differ from Node's. |
| fs.watch polls | MIRAGE-LINUX has no inotify: `fs.watch` compares a directory's entries and their stats every 100 ms of guest time (`fs.watchFile` polls as Node itself does, at its interval). A write is one `'change'`, where Linux's inotify may say two; a change and its undoing within 100 ms are not seen. |
| zlib without Brotli or zstd | deflate, inflate and gzip are here (in JavaScript; deflate's bytes are its own, smaller or larger than zlib's, and inflate as zlib's do); `brotliCompress`, `zstdCompress` and their kin throw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, and Node 26's zip archives are not here. |
| No REPL | `node` alone at a terminal says so and exits; give it a script, `-e` or `-p`. |
| What JavaScript cannot see | `util.inspect` shows a promise as `Promise { <state unknown> }`; an uncaught error's stack lists MIRAGE's frames, not Node's. |
| Local time | `Date`'s local methods use the host's time zone, not the guest's `TZ`. |
| Time in the script is not charged to the guest's clock | As for WebAssembly: while the script computes, the guest's clock stands still; its waits (timers, sleep) move it on. |
| A cross-origin isolated page | node needs `SharedArrayBuffer`: the site's pages send COOP and COEP (`tools/site.mjs`). |

## The tools

- About twenty tools look for `nasm`, `dosbox-x` and `qemu` in `/opt/homebrew/bin`.
- The golden test covers 44 programs, of which 39 are third-party files that a fresh clone does not
  have; there it checks 5.
