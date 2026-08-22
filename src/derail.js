// derail.js — say WHAT the guest is executing when it is no longer executing code.
//
// Four separate investigations in one day started from a message that named an opcode and nothing
// else, and in all four the opcode was innocent — the guest had left its own code and we were
// decoding whatever it landed in:
//
//   Turbo Pascal   jumped to fffe:0002, ran off the 1 MB wrap into the interrupt vector table, and
//                  vector 0 (0f53:010c) decoded as "0f 53" — an SSE opcode in a 1989 program.
//   MS-DOS 6.22    same table, where "62 07" decodes as BOUND, so an unhandled #BR looped 3 M times.
//   test386        the IDT, whose gate access bytes 8e/ee read as an instruction.
//   Crystal Dream 2  its own error string: "…ception faul…" executed as code.
//
// Each time the first move was to implement or investigate the opcode, and each time that was wrong.
// So the address gets classified rather than merely printed. This runs only on a diagnostic path —
// a fault that is about to be reported — never on the hot path.

/** Length of the printable run starting at `lin`, capped at `n`. */
function printableRun(mem, lin, n) {
  let i = 0;
  for (; i < n; i++) {
    const b = mem.u8[(lin + i) & (mem.size - 1)];
    if (b < 0x20 || b >= 0x7f) break;
  }
  return i;
}

/**
 * True when the bytes at `lin` are plausibly text. A run of eight printable bytes is the test, most
 * of them letters or spaces: Crystal Dream 2's string is "ception fault.\x12Break", so demanding
 * that a whole 16-byte window be printable — which the first version did — rejected the very case
 * this exists for. The 0x12 is a separator inside the message, not the end of the text.
 */
function looksLikeText(mem, lin) {
  const run = printableRun(mem, lin, 32);
  if (run < 8) return false;
  let wordy = 0;
  for (let i = 0; i < run; i++) {
    const b = mem.u8[(lin + i) & (mem.size - 1)];
    if (b === 0x20 || (b | 32) >= 0x61 && (b | 32) <= 0x7a) wordy++;
  }
  return wordy * 5 >= run * 3;                       // 60% letters or spaces
}

/** The printable text around `lin`, taken from the start of its run so the quote reads. */
function textAt(mem, lin, back = 24, fwd = 32) {
  let start = lin;
  for (let i = 0; i < back; i++) {
    const b = mem.u8[(start - 1) & (mem.size - 1)];
    if (b < 0x20 || b >= 0x7f) break;
    start--;
  }
  let s = '';
  for (let i = 0, n = printableRun(mem, start, (lin - start) + fwd); i < n; i++) {
    s += String.fromCharCode(mem.u8[(start + i) & (mem.size - 1)]);
  }
  return s;
}

function allZero(mem, lin, n = 16) {
  for (let i = 0; i < n; i++) if (mem.u8[(lin + i) & (mem.size - 1)]) return false;
  return true;
}

/**
 * A phrase describing what lives at `lin`, or '' when it looks like ordinary code. Never throws:
 * this is called while reporting another failure, and a diagnostic that dies is worse than none.
 *
 * @param {object} mem  the Memory
 * @param {number} lin  LINEAR address of the byte that failed to decode
 * @param {object} [cpu] optional, for the descriptor-table ranges
 */
export function describeRegion(mem, lin, cpu) {
  try {
    lin = lin >>> 0;
    if (lin < 0x400) return `INSIDE THE REAL-MODE IVT (vector ${lin >> 2}) — the guest left its own code`;
    if (lin < 0x500) return 'inside the BIOS data area — the guest left its own code';
    if (cpu) {
      const idt = cpu.idtr, gdt = cpu.gdtr, ldt = cpu.ldtr;
      if (idt && idt.limit && lin >= idt.base && lin <= idt.base + idt.limit) {
        return `INSIDE THE IDT (entry ${((lin - idt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
      if (gdt && gdt.limit && lin >= gdt.base && lin <= gdt.base + gdt.limit) {
        return `INSIDE THE GDT (entry ${((lin - gdt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
      if (ldt && ldt.limit && lin >= ldt.base && lin <= ldt.base + ldt.limit) {
        return `INSIDE THE LDT (entry ${((lin - ldt.base) / 8) | 0}) — descriptor bytes, not code`;
      }
    }
    if (allZero(mem, lin)) return 'in a run of zero bytes — the guest is running through empty memory';
    if (looksLikeText(mem, lin)) return `INSIDE A STRING — "${textAt(mem, lin)}" — the guest is executing text, not code`;
    return '';
  } catch { return ''; }
}

/** Formats the recompiler's recent-block ring as "how it got here", oldest first. */
export function recentBlocks(rec, n = 6) {
  if (!rec || !rec.recentCs) return '';
  const out = [];
  const N = rec.recentCs.length;
  for (let i = 0; i < N; i++) {
    const k = (rec.recentI + i) % N;
    if (rec.recentCs[k] < 0) continue;
    out.push(`${(rec.recentCs[k] >>> 0).toString(16).padStart(4, '0')}:${(rec.recentIp[k] >>> 0).toString(16)}`);
  }
  return out.slice(-n).join(' -> ');
}
