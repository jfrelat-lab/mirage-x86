# MIRAGE — Documentation

Two kinds of document live here, and they are kept apart on purpose.

## Reference

These describe the project **as it is**. They carry no history: when the code changes, they change.

| Document | Answers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How is it built? The model, the file map, execution, interrupts, time. Start here. |
| [RECOMPILER.md](RECOMPILER.md) | How does x86 become JavaScript? Blocks, the cache, flags, self-modifying code. |
| [DEVICES.md](DEVICES.md) | How are the BIOS, DOS, video, timer and input implemented? The port map. |
| [HARDWARE.md](HARDWARE.md) | What machine does a guest see, and what was each part checked against? |
| [COMPATIBILITY.md](COMPATIBILITY.md) | What runs, how far, and when was that last recorded? |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | What does not work, and is the cause known? |
| [TESTING.md](TESTING.md) | What are the gates, the references and the tools? |
| [OASIS.md](OASIS.md) | What is an OASIS image, and how is one written and run? |
| [COMPARISON.md](COMPARISON.md) | How does MIRAGE compare with QEMU, DOSBox-X, v86, Docker — and, for speed, js-dos, RetroTick, CheerpX and PCjs? |
| [ROADMAP.md](ROADMAP.md) | What is open? |
| [SITE.md](SITE.md) | How is the static site built, checked and hosted? |

## Record

[notes/](notes/README.md) holds the investigations, measurements, audits and studies, written while
the work was done. A note is dated, tells what was tried — including what was wrong — and is not
revised afterwards.

## The rule

A fact about the present goes in a reference document, without a date and without its story. The
story — the symptom, the hypotheses, the measurements, the cause — goes in a note, and the reference
document links to it if it helps. When the two disagree, the note is the one that is old.
