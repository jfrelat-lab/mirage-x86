# Contributing to MIRAGE

Thank you for looking. A few rules keep this emulator honest; they are short.

## Before you send a change

```bash
node tools/test.js              # must be all green
node tools/golden.js check      # must report 0 mismatch
```

`golden.js` fingerprints the screen and state of a set of programs after a fixed number of cycles.
Most of them are third-party and are not in the repository, so on a fresh clone they are reported
as skipped; that is expected. If a fingerprint changes, say why in the commit — and re-bless it
(`node tools/golden.js capture <file>`) only when the new picture is the correct one.

Documentation-only changes (`docs/`, `*.md`) do not need the two runs.

## What a fix looks like

- **A test that fails without it.** Every new test in `tools/test.js` must fail when the fix is
  reverted. Check it: revert, run, see it fail, restore.
- **A reference that is not MIRAGE.** Behaviour is changed when an independent implementation says
  so — QEMU, DOSBox-X, v86, real-hardware test vectors, the vendor's manual. For hardware, the
  usual form is a probe: a small boot program in `tools/*.asm` that prints what the machine
  answers, run unchanged under QEMU and under MIRAGE. When two references disagree, say so in the
  comment and pick the one the specification supports.
- **Comments that say why.** The code explains which program needed the behaviour and what the
  reference answered. Keep that habit; it is what makes the next bug findable.

## Performance changes

Measure in cycles, not seconds, and never two runs at once. A change that speeds up the paged
operating systems must not slow down the DOS player: compare `node tools/bench.js --json` on the
old and the new tree, alternating, three times each.

## What not to send

No operating system, game, intro, ROM or BIOS image — nothing whose licence is not yours to give.
`boot/`, `games/` and `intros/` are ignored by git for that reason. A bug report that names the
program and where to obtain it legally is the right way to share a failure.

## Reporting a program that does not run

Say which file (name, size, a checksum if you can), which page (`index.html` or `boot.html`) and
which options, and what you saw: the last screen, and any message in the browser console.
