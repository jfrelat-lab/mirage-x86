# Dhrystone and CoreMark under MIRAGE-LINUX: where the time goes (2026-11-05)

The static musl builds of [BENCHMARKS.md](../BENCHMARKS.md#linux) (Dhrystone `-DTIMES -DHZ=100`,
CoreMark `ITERATIONS=0`), headless on the M1: `node --cpu-prof tools/linux/run.mjs`, and the
recompiler's own block counter (`rec.profiling`) for the blocks.

## The profile

| Where | Dhrystone | CoreMark |
|---|---|---|
| The translated blocks themselves | 79.3 % | 67.5 % |
| `Recompiler.run`, the loop that finds and calls the next block | 15.6 % | 21.3 % |
| `Machine.runSlice` | 2.1 % | 1.7 % |
| Translation | 0.6 % | 2.1 % |
| The flag helpers left as calls (`setShiftResult`, generic `setSub` for INC/DEC/NEG) | — | 2.6 % |
| `idiv32` | 0.9 % | — |

| | Instructions | Host time | M instructions a second | Instructions a dispatch |
|---|---|---|---|---|
| Dhrystone, 20 M runs | 10,340 M | 22.5 s | 459 | 30.4 |
| CoreMark | 4,226 M | 12.3 s | 344 | 23.8 |

## What changed today

Before this profile, the byte and word ALU operations (add, sub, cmp, and, or, xor, test at 8 and 16
bits) set their flags through the generic `setAdd`/`setSub`/`setLogic`, the width an argument: **7 % of
CoreMark**, whose `core_state_transition` compares bytes one after the other. Branch-free
`setAdd8/16`, `setSub8/16` and `setLogic8/16`, as the 32-bit ones already were (5ab97c8):

| | Before | After |
|---|---|---|
| CoreMark | 985–991 it/s | 1,055–1,058 it/s (+7 %) |
| Dhrystone | 852,000–874,000 /s | 895,000–900,000 /s (+3 %) |
| DOS intros (`bench.js`, ms a frame) | tube 111–113, kaneda 70–72, puls 61 | tube 106, kaneda 55, puls 47 |

The DOS intros gained most: their code is byte and word arithmetic.

## The blocks

Dhrystone's loop is seventeen blocks dispatched equally often, one per iteration each: its
procedures, and musl's `strcpy` and `strcmp` (blocks of 2 to 11 instructions ending in `ret`).
CoreMark's hottest block, `core_state_transition`'s scanner, is 39 instructions with eight side exits;
the four hottest make a third of its dispatches. Most blocks end at a `ret`: the return address is
known only when it runs, so the dispatcher looks it up.

## What it says

- **The dispatch is still the largest single cost**: 16 % and 21 %, for 24 to 30 instructions a
  dispatch. What remains are the function returns and the calls to another page (a library). A
  return could leave through the call's own block when the stack holds the address it pushed, the
  way a followed call already returns inside its block; across pages that means a block calling
  into another's function, which `run` does not do today. An estimate, not a measurement: a third of
  the dispatch cost.
- **Flags at side exits are all live.** Every flag is computed in full before each forward branch
  because the successor may read any of them; most are overwritten before being read. Computing them
  lazily (keeping the operands and the operation, and deriving a flag when read) would remove most
  of that work in byte-scanning code like CoreMark's. It touches every flag reader, so it is not a
  small change.
- **The calls left**: `setShiftResult` (1.7 % of CoreMark), and INC, DEC and NEG at 8 and 16 bits,
  which still go through the generic `setSub`/`setAdd` — the same treatment as today's.
