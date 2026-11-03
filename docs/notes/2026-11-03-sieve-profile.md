# BYTE's Sieve under MIRAGE-DOS: where the time goes (2026-11-03)

`tools/bench/sieve.asm` (730.7 M instructions, 16-bit real mode) runs in 7.5 s headless, 11.1 s in
the page; native DOSBox-X takes 6.2 s and v86 7.1 s ([BENCHMARKS.md](../BENCHMARKS.md)). Measured on
the M1, headless, `node --cpu-prof` and the recompiler's own block counter (`profiling`).

## The profile

| Where | Share of samples |
|---|---|
| The translated blocks themselves | 51.6 % |
| `Recompiler.run`, the loop that finds and calls the next block | 39.2 % |
| `Machine.runSlice` | 4.5 % |
| `Recompiler.invalidate`, the self-modifying-code barrier | 3.4 % |
| Translation, GC, the rest | 1.3 % |

241.4 million dispatches for 730.7 million instructions: **3.0 instructions a dispatch**.

## The blocks

| Block | Loop | Instructions | Dispatches |
|---|---|---|---|
| `mov di,dx` / `mov byte [flags+di],0` / `add dx,ax` / `jmp .mark` | the multiples of a prime | 4 | 75.0 M (31.1 %) |
| `cmp dx,SIZE` / `ja .done1` | its test | 2 | 75.0 M (31.1 %) |
| `cmp byte [flags+si],0` / `je .skip` | the next candidate | 2 | 41.0 M (17.0 %) |
| `inc si` / `cmp si,SIZE` / `jbe .next` | its step | 3 | 31.5 M (13.0 %) |
| the others | | | 7.8 % |

Two loops of two blocks each do all the work, and every block ends at its branch: in real mode
and in unpaged protected mode, a block stops at every conditional jump. Under paging (Linux
programs, Windows) a block goes on through forward branches, short loops and followed calls, some 30
instructions a dispatch on Dhrystone ([RECOMPILER.md](../RECOMPILER.md#longer-blocks-under-paging));
the Sieve gets none of it.

`invalidate` is the barrier a write to a page holding translated code goes through: the Sieve's
flags live in its own code page (a `.COM`), so each of the 75 million `mov byte [flags+di],0` and
the 5000 `rep stosb` pass through it. It finds no block overlapping and leaves at once; that check
alone is 3.4 %.

## What it says

- **The dispatch is the cost**: 39 % of the time, for blocks of two to four instructions. Taking the
  paged path's loops and skips to unpaged code would make each of the two inner loops one block that
  runs its own iterations: some 240 million dispatches would become a few million, and the run
  would be bound by the translated code alone. An estimate, not a measurement: about half the time
  it takes now, which would put it near native DOSBox-X's 6.2 s.
- **What stands in the way**: the DOS golden runs are timed to the block. A timer interrupt is
  delivered between blocks, so longer blocks move where it lands, and the pictures of the
  intros that race the beam or the timer move with it — those fingerprints would be re-blessed after
  checking each against DOSBox-X, as the paged path's were checked against Docker.
- **The barrier** could skip the check for writes to a page's bytes known to hold no code (byte-
  granular tracking, on the roadmap); 3.4 % here, more for intros that keep their variables beside
  their code.
