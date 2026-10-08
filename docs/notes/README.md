# Notes — the working record

These are investigations, measurements, audits and feasibility studies, written while the work was
being done. They are kept because they show how a conclusion was reached, and because the next bug
often looks like one already solved.

**They are a record, not a description.** A note says what was true and what was believed on its
date. It is not updated when the code changes; the present state of the project is in the documents
one level up ([ARCHITECTURE](../ARCHITECTURE.md), [COMPAT](compat-log.md), [TESTING](../TESTING.md),
[ROADMAP](../ROADMAP.md)). When a note and one of those disagree, the note is the one that is old.

| Note | What it is |
|---|---|
| [roadmap-log.md](roadmap-log.md) | The former task list, which was also the diary: every item with what was tried and found, September and October 2026 in most detail (the operating systems, PCI, the block cache under paging). |
| [testing-log.md](testing-log.md) | The former testing guide: each tool as it was added, and the incidents behind it (a recording oracle that recorded nothing, normalisations that were false positives first). |
| [compat-log.md](compat-log.md) | The former compatibility notebook: how each game and intro was unblocked, the speed measurements against DOSBox-X. |
| [timing.md](timing.md) | How the machine's clock was measured and calibrated against DOSBox-X: interrupt delivery, the timer rate cap, the VGA beam, self-modifying code, and the long hunt that ended in "hardware interrupts were never dispatched through the IDT". Sections are numbered; the code refers to them (`docs/notes/timing.md §6`). |
| [windows-3.md](windows-3.md) | Getting Windows 3.0 (real, standard and 386 enhanced mode) and Windows 3.1 to start. |
| [booting-real-dos.md](booting-real-dos.md) | Booting real DOS kernels — FreeDOS, MS-DOS — on MIRAGE's BIOS instead of its built-in DOS. |
| [2026-09-05-mesha.md](2026-09-05-mesha.md) | The intro `mesha.com`: a wrong picture, traced through the palette call, the machine's speed, a real XMS driver and DPMI. Also `intoanew.com` and Wolfenstein 3D. |
| [2026-08-25-dune.md](2026-08-25-dune.md) | Why Cryo's *Dune* did not animate, from one bit to the screen. |
| [2026-08-04-audit.md](2026-08-04-audit.md) | A conformance audit of the whole code base against the x86, DOS and VGA specifications. |
| [win16-spike.md](win16-spike.md) | A feasibility study: running 16-bit Windows programs directly, without booting Windows. |

## Writing a note

One note per question, named `YYYY-MM-DD-subject.md` after the day it was opened. The useful ones
have the same five parts:

1. **Symptom** — what was seen, on which program, with the command that shows it.
2. **Hypotheses** — each one stated before it was tested, including the ones that turned out wrong.
3. **Measurements** — what was run, against which reference, and the numbers.
4. **Cause** — the defect, in one paragraph.
5. **Fix** — the commit, and the test that now fails without it.

Wrong turns stay in. A note that only records the answer cannot warn anyone off the path that
wasted the time.
