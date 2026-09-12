# WIN16 (NE) direct-execution — feasibility spike

**Question.** Instead of booting real Windows 3.0, could MIRAGE load a WIN16 `.EXE` (New
Executable) directly and implement KERNEL/USER/GDI in JavaScript, the way Wine implements
Win32 on Linux? This document is the evidence for a go/no-go. **No Windows API was
implemented.** Everything below is static analysis of the real binaries in `boot/WIN30/`
(gitignored, present on disk), produced by `tools/ne-inspect.mjs`, written for this spike.

Everything numeric here is a measurement. Where a thing could not be measured it is marked
**not measured** rather than estimated.

## 0. The tool

`tools/ne-inspect.mjs` parses the MZ stub, the NE header, the segment table with each
segment's relocation records, the entry table (fixed and movable bundles), the resident and
non-resident name tables, the module reference table, the imported-name table, and the Win 3.x
resource table. Four commands: `dump`, `exports`, `imports`, `union`.

```
node tools/ne-inspect.mjs dump    boot/WIN30/CALC.EXE
node tools/ne-inspect.mjs exports boot/WIN30/USER.EXE
node tools/ne-inspect.mjs union   boot/WIN30/{CLOCK,REVERSI,NOTEPAD,CALC,SOL,PROGMAN}.EXE \
                                  --libdir boot/WIN30
```

**Where the ordinal→name mapping comes from.** Win16 imports are almost entirely *by ordinal*
(`IMPORTORDINAL` fixups), so a raw import list is a list of numbers. `ne-inspect` does not
carry a hardcoded ordinal table: `--libdir` scans the directory for NE files, keeps those with
the `LIBRARY` header flag, reads each one's **own** resident + non-resident name tables (which
are `name → ordinal` pairs, i.e. the module's export list) and indexes it under the module name
that library declares in the first resident-name entry. So `USER` resolves through `USER.EXE`,
`DISPLAY` through whichever `*.DRV` calls itself DISPLAY (here `8514.DRV`/`EGA.DRV`), and so on.
Measured coverage: across the 22 shipped applications, **every ordinal import resolved to a
name — zero unresolved**.

## 1. The number that decides this

### 1a. Six representative apps

`union` over CLOCK, REVERSI, NOTEPAD, CALC, SOL, PROGMAN. Cells are **distinct imported entry
points**, ordinals resolved to names:

```
  app                  GDI    KERNEL  KEYBOARD      USER   WIN87EM     TOTAL
  CLOCK.EXE             22        17         0        32         0        71
  REVERSI.EXE           16        10         0        42         0        68
  NOTEPAD.EXE            9        31         2        62         0       104
  CALC.EXE              13        22         0        57         1        93
  SOL.EXE               26        15         0        54         0        95
  PROGMAN.EXE            4        39         2       102         0       147
  UNION                 42        52         2       133         1       230
```

| module | union of distinct entry points needed |
|---|---|
| USER | **133** |
| KERNEL | **52** |
| GDI | **42** |
| KEYBOARD | **2** |
| WIN87EM (FP emulator) | **1** (`__FPMATH`) |
| **total** | **230** |

The full lists are in the tool's output; e.g. USER's 133 include `REGISTERCLASS
CREATEWINDOW GETMESSAGE TRANSLATEMESSAGE DISPATCHMESSAGE DEFWINDOWPROC BEGINPAINT ENDPAINT
DIALOGBOX SETTIMER …`, GDI's 42 include `BITBLT STRETCHBLT TEXTOUT EXTTEXTOUT
CREATEFONTINDIRECT GETTEXTMETRICS SELECTOBJECT CREATECOMPATIBLEDC PATBLT LINEDDA …`.

### 1b. All 22 applications shipped with Windows 3.0

The same run over every non-system `.EXE` in the tree (apps only — KERNEL/USER/GDI/WIN386/
DOSX/MSDOS/SETUP/EXPAND/SWAPFILE excluded):

```
  UNION (22 apps)   COMM 1   GDI 100   KERNEL 86   KEYBOARD 3   SYSTEM 1   USER 255
                    + app-private DLLs: PBRUSH 7, RECORDER 13, WIN87EM 1     TOTAL 467
```

So the API surface grows from **230 (6 apps) to 467 (22 apps)** — sublinear, but the USER
surface nearly doubles (133 → 255). USER.EXE itself exports 602 entry points; GDI.EXE 302;
KERNEL.EXE 197. The 22 apps therefore touch ~42 % of USER and ~33 % of GDI.

**These counts are a lower bound.** 12 of the 22 apps import `GETPROCADDRESS` or
`LOADLIBRARY`, i.e. they resolve entry points at run time, which no static scan can see
(CALENDAR, CARDFILE, CONTROL, NOTEPAD, NWPOPUP, PBRUSH, PIFEDIT, SF4019, SYSEDIT, TERMINAL,
WINHELP, WRITE).

### 1c. The much cheaper variant: HLE **KERNEL only**

If instead the real `USER.EXE`, `GDI.EXE` and the real `*.DRV` display/keyboard/mouse drivers
are loaded and executed as guest code, and only KERNEL is replaced by a JS module, the surface
is what those binaries import:

```
  app                 COMM   DISPLAY       GDI    KERNEL  KEYBOARD     MOUSE     SOUND    SYSTEM
  USER.EXE              15         4        90        82         8         3         1         6
  GDI.EXE                0         0         0        66         0         0         0         0
  KEYBOARD.DRV           0         0         0        12         0         0         0         0
  EGA.DRV                0         0         0        10         1         0         0         0
  SYSTEM/MOUSE/SOUND/COMM.DRV        (3 / 2 / 9 / 7 from KERNEL, 3 from SYSTEM)
  UNION                 15         4        90       110         9         3         1         6
```

**110 distinct KERNEL entry points** and nothing else has to be written — USER's 602 and GDI's
302 come from Microsoft's own binaries, with exact semantics. That is roughly a **4× smaller**
surface than 1a and an order of magnitude smaller than 1b, and it is the only variant of this
spike's idea that is not obviously a multi-year project.

## 2. Structural facts (per-app, from `dump`)

```
app            segs  movEnt  relocTot  impReloc  intRefMov  osfix  DIALOG/MENU/other-res
CLOCK.EXE         2       2        75        71          4      0   1/1/8
REVERSI.EXE       2       3        74        68          6      0   1/1/9
NOTEPAD.EXE       8      40       240       186         54      0   8/1/10
CALC.EXE          5      90       599       120        131    348   3/1/11
SOL.EXE          11      97       282       143        139      0   3/1/87
PROGMAN.EXE       8      52       348       249         93      0   9/1/46
```

- `movEnt` = movable entry-table slots. Every one is a **6-byte thunk record containing the
  bytes `CD 3F` — INT 3Fh** (verified: the int3f word is `0x3FCD` for all 90 of CALC's and all
  427 of USER's movable entries). That interrupt is the segment-not-present / "call a movable
  segment" trap KERNEL owns.
- `impReloc` counts *relocation records* naming an import; each non-additive record is the head
  of a **chain** threaded through the segment image, so the number of bytes actually patched is
  ≥ this. The tool reports records, not sites — sites **not measured**.
- CALC's 348 `OSFIXUP` records are the floating-point-emulator fixups (its single WIN87EM
  import); these are patched with FP instructions or emulator calls at load time.
- Every app carries DIALOG and MENU resources, i.e. the UI is *data* interpreted by USER's
  dialog manager and menu code, not by the app.

## 3. What MIRAGE already has that this path reuses

- **The CPU.** 16-bit real mode + 386 prefixes, protected mode, V86, TF/single-step, all under
  a 100 %-passing conformance suite. Win16 apps are plain 16-bit x86; nothing in the instruction
  stream of CALC or PROGMAN is new to the engine. This is the largest single asset and it is
  already paid for.
- **Selector machinery.** `src/dpmi.js` already builds and manages an LDT (8192 entries,
  allocate/free/set-base/set-limit, ring-3 selectors). A protected-mode Win16 KERNEL's
  `AllocSelector`/`FreeSelector`/`PrestoChangoSelector`/`AllocCSToDSAlias` are the same object.
- **The loader shape.** `src/dos.js` already does: parse an MZ header, place an image at a load
  segment, walk a relocation list and add the load segment in place (`applyRelocs`), size and
  own a memory block via the MCB chain, set up entry registers, and — for `AH=4B AL=03` — relocate
  an **overlay** into a segment the caller already owns. NE loading is the same *shape* of work
  (image + fixup list + per-segment load address); it is not the same table format.
- **The video layer.** The Windows GUI's own mode is 0x12 (640×480×16 planar). MIRAGE's
  `src/vga.js` implements the planar device (4 planes, latches, all write modes, Sequencer/GC/
  CRTC/Attribute) and `win /3` has already drawn the real Windows 3.0 startup logo through it
  (`docs/COMPAT.md`). So under variant 1c the **real EGA.DRV** can draw onto hardware we
  already emulate — nothing new needed.
- **DOS services.** KERNEL's file layer (`OPENFILE _LOPEN _LREAD _LWRITE _LLSEEK _LCLOSE
  _LCREAT`, `GETWINDOWSDIRECTORY`, the `*.INI` profile calls) bottoms out in INT 21h file I/O
  over the VFS, which exists and works.
- **Timer / keyboard / mouse** plumbing (PIT, IRQ1, INT 33h) exists and is what
  `SYSTEM.DRV`/`KEYBOARD.DRV`/`MOUSE.DRV` sit on.

## 4. What MIRAGE does not have at all

None of the following has *any* existing equivalent in `src/`:

| missing piece | why it is hard here |
|---|---|
| **NE loader** | different format from MZ: per-segment load, 4 fixup types × 6 address types, chained fixup lists, `additive` variants, self-referential `INTERNALREF`/movable targets. Closest existing code is `applyRelocs` (~10 lines) — the concepts transfer, the code does not. |
| **Movable segments + INT 3Fh thunks** | the entry table's `CD 3F` trampolines mean a call to a movable entry *faults deliberately*; KERNEL's handler locates/loads/locks the segment, patches the thunk to a real far jump, and resumes. MIRAGE has no notion of a relocatable, discardable code segment, and this interacts badly with the **recompiler's block cache**: a segment that moves invalidates compiled blocks at addresses the SMC page-dirty tracking never sees a write to. **No equivalent, and a genuine engine-level risk.** |
| **Global/local heap, handles** | `GlobalAlloc`/`GlobalLock` return *handles* backed by movable, discardable memory with a selector table; `LocalAlloc` is a per-instance heap inside a DS segment. Our DOS allocator is an MCB chain of fixed paragraphs. Nothing reusable. |
| **Task scheduler** | Win16 is cooperatively multitasked, with a task ≈ a message queue; `InitTask`, `WaitEvent`, `Yield`, `GetCurrentTask`. MIRAGE runs one program. No equivalent. |
| **USER: window manager + message loop** | window classes, parent/child/z-order, a per-task message queue, `GetMessage`/`PeekMessage`/`DispatchMessage`, `DefWindowProc`'s full default behaviour (sizing, activation, painting, NC area, system menu), the built-in control classes (BUTTON, EDIT, LISTBOX, STATIC, SCROLLBAR — an EDIT control alone is a text editor), the dialog manager that interprets the DIALOG resources counted above, menus, accelerators, clipboard, timers, painting/invalidation with update regions. **This is the bulk of the work and has no MIRAGE equivalent whatsoever.** The 133-entry USER list understates it: `DEFWINDOWPROC` is one name and a many-thousand-line behaviour. |
| **GDI drawing model** | device contexts with a full state stack, clip/vis regions and region combination, brushes/pens/ROP2 and 256 ternary raster ops for `BitBlt`/`StretchBlt`, mapping modes, bitmap formats, and **font rasterisation + text metrics** (`.FON` bitmap fonts ship in the tree, but a `GETTEXTEXTENT` that disagrees by one pixel corrupts every layout). Our video layer is a *framebuffer*: planes, latches and bytes. Everything between "a rectangle with a clip region and a ROP" and "bytes in plane 2" would have to be written from scratch, **and written to match Windows' pixel conventions**, because apps depend on them. No equivalent. |
| **Resource loader** | `FindResource`/`LoadResource`/`LoadString`/`LoadIcon`/`LoadBitmap`/`LoadMenu` plus the binary formats of DIALOG, MENU, ACCELERATOR, ICON, BITMAP, STRING. `ne-inspect` locates and types these; it does not decode their contents (**not measured**). |
| **A correctness oracle** | this is the quiet killer. Every existing MIRAGE subsystem was debugged against an external reference (test386, Unicorn co-sim, DOSBox INT 21h logs, QEMU screenshots, a real VGA BIOS). A hand-written USER/GDI has **no oracle**: DOSBox and QEMU run the *real* USER.EXE, so they cannot tell you what your reimplementation should return. You would be writing thousands of behaviours against documentation and screenshots. Note how the numbers above were themselves only trustworthy because they came from the binaries' own tables. |

### Also not measured

- The number of distinct `WM_*` messages, window styles and `wParam`/`lParam` conventions the
  six apps depend on — not derivable from the import tables; it needs disassembly of each
  window procedure or a run-time trace.
- Semantic weight per entry point. 230 names is **not** 230 units of work: `SETRECT` is four
  stores, `BITBLT`, `DEFWINDOWPROC`, `DIALOGBOX` and the EDIT control are each a subsystem.
  Any headcount derived from "230 functions" would be fiction.
- Whether apps depend on undocumented KERNEL/USER internals (`GETINTERNALWINDOWPOS`,
  `CALCCHILDSCROLL`, `SCROLLCHILDREN`, `DUMPICON` appear in the union and are internal/
  undocumented — so at least some do).

## 5. Verdict

**Variant 1a/1b (Wine-style: implement KERNEL + USER + GDI in JS) — not worth it.** The
measured floor is 230 entry points for six toy apps and 467 for the shipped suite, and the
counts are a lower bound (12 of 22 apps import functions dynamically). But the count is not
the real objection. Three things are:

1. **USER and GDI are the project, not an API veneer.** A window manager, a dialog/control
   library and a device-independent 2-D graphics stack with font metrics are what would get
   written; the x86 engine — the thing MIRAGE is good at, and the thing that is already
   built — contributes almost nothing to them.
2. **There is no oracle.** Every hard bug MIRAGE has fixed was found by differential testing
   against an external reference. A reimplemented USER/GDI has none, which removes the single
   method this project has relied on.
3. **Movable/discardable segments fight the recompiler.** Code that relocates at run time and
   entry thunks that self-patch are exactly the case the block cache's page-dirty SMC tracking
   is not designed for.

**Variant 1c (HLE KERNEL, run the real USER/GDI/drivers) is the only interesting one**, and it
is measurably small: **110 KERNEL entry points**, with USER's 602 and GDI's 302 supplied by
Microsoft's binaries at exact fidelity, drawing through a planar VGA device MIRAGE already has
and that has already displayed real Windows output. It also keeps the oracle: QEMU and
dosbox-x run the same USER.EXE/GDI.EXE, so their behaviour remains diffable. Its hard parts are
the ones in the table above that belong to KERNEL — the NE loader, movable segments with INT
3Fh thunks, the global/local heaps, and the cooperative scheduler — which is a real project but
a bounded one.

**However**, per `docs/COMPAT.md`, the existing real-Windows path is much further along than
this spike is: `win /3` already boots to the startup logo and completes enhanced-mode init, and
`win /r` loads and EXECs the real KERNEL.EXE and fails on a *known, named, DOS-shape* defect
(our INT 21h/2Fh vectors and InDOS flag live in three unrelated places instead of one low-RAM
kernel segment) which QEMU running the same tree proves is ours. Finishing that is a handful of
targeted fixes with a working reference; variant 1c would re-derive the same result by writing
a KERNEL from scratch **without** one.

**Recommendation: do not start the Wine-style path.** Finish the real-Windows path first
(`docs/COMPAT.md` §Windows 3.0). Should that path stall for a structural reason rather than a
bug, reopen this document at variant 1c — the 110-entry-point KERNEL — and not at 1a.
