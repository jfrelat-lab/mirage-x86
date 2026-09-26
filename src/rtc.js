// rtc.js — MC146818 real-time clock + CMOS RAM, and the INT 1Ah services that format it.
//
// The chip, not the BIOS, is the reference here. Four BIOS implementations were compared on one
// 512-byte boot sector — SeaBIOS (under QEMU and under v86), the Bochs BIOS, and DOSBox-X's own —
// and every difference between their INT 1Ah answers turned out to be a difference in what their
// CMOS held, not in how they read it. So MIRAGE holds a CMOS and INT 1Ah merely formats it.
//
// Layout and bits are the MC146818's own (Motorola datasheet; the same definitions appear verbatim
// in BSD's mc146818reg.h). Registers 00-09 are the clock, 0A-0D the control block:
//
//   00 seconds   02 minutes   04 hour   06 day of week (1-7, Sunday = 1)
//   07 day of month   08 month   09 year within the century (0-99)
//   0A  bit 7 UIP (update in progress), bits 6-4 divider, bits 3-0 periodic rate
//   0B  bit 7 SET, 6 PIE, 5 AIE, 4 UIE, 3 SQWE, 2 DM (1 = binary, 0 = BCD), 1 = 24-hour, 0 = DSE
//   0C  interrupt flags, cleared by reading    0D  bit 7 VRT (valid RAM and time)
//
// THERE IS NO CENTURY REGISTER IN THE CHIP: the year is 0-99 and that is all. The century that
// INT 1Ah AH=04h returns in CH is an IBM addition living in ordinary CMOS RAM, at 32h on the AT and
// 37h on PS/2 machines. All four references above hold 20h at BOTH addresses, so both are written.
//
// DSE is the one bit the references disagree on — DOSBox-X sets it, the others clear it — and the
// datasheet says why it matters: with DSE the chip applies the pre-2007 US rule on its own (last
// Sunday in April, last Sunday in October). That is a rule about a place, so MIRAGE leaves it clear
// and reports no daylight saving, which is also what SeaBIOS and the Bochs BIOS do.
//
// TIME IS EMULATED TIME, not the host's. The clock advances with the BDA tick at 0040:006C, the
// same source src/dos.js uses for INT 21h AH=2Ah/2Ch, so a run is reproducible for the golden
// fingerprints and the two services can never contradict each other. MIRAGE_RTC=host takes the
// host clock instead, for comparing against an oracle.
//
// THE BOOT TIME OF DAY IS NOT DECORATION. MS-DOS and PC DOS detect whether a machine has an RTC at
// all by calling AH=02h and checking that the values come back NON-ZERO (RBIL says so, and it was
// confirmed both ways on MS-DOS 4: a zero time makes it skip AH=04h entirely and fall back to
// 01-01-1980). Starting at midnight would therefore read as "no clock" for the first second of
// every run, so the tick is seeded to 08:00 and the epoch itself stays at midnight — the same
// instant src/dos.js already counts from, which is why that file needs no change to agree.

const TICKS_PER_DAY = 1573040;            // 1800B0h, the same constant src/dos.js divides by
const MS_PER_DAY = 86400000;

// Midnight on 1990-01-01, exactly what src/dos.js counts ticks from, and the date vfs.js stamps on
// files. The time of day a run starts at comes from the seeded tick below, not from here.
export const RTC_EPOCH_MS = Date.UTC(1990, 0, 1);
const BOOT_HOUR = 8;

const bcd = (n) => ((((n / 10) | 0) % 10) << 4) | (n % 10);
const unbcd = (b) => (((b >> 4) & 0x0f) * 10) + (b & 0x0f);

const SEC = 0x00, MIN = 0x02, HOUR = 0x04, DOW = 0x06, DOM = 0x07, MONTH = 0x08, YEAR = 0x09;
const REG_A = 0x0a, REG_B = 0x0b, REG_C = 0x0c, REG_D = 0x0d;
const CENTURY_AT = 0x32, CENTURY_PS2 = 0x37;
const TIME_REGS = new Set([SEC, 0x01, MIN, 0x03, HOUR, 0x05, DOW, DOM, MONTH, YEAR]);

const B_SET = 0x80, B_DSE = 0x01;

export function installRTC(machine) {
  const mem = machine.mem, cpu = machine.cpu;
  const rtc = {
    ram: new Uint8Array(64),
    index: 0,
    nmiDisabled: false,
    offsetMs: 0,                  // what a guest's "set the clock" moved us by
    host: typeof process !== 'undefined' && !!process.env && process.env.MIRAGE_RTC === 'host',   // guarded: the browser has no process
    pending: new Map(),           // time registers written while SET is high
  };
  machine.rtc = rtc;

  // Divider on and a 1.024 kHz periodic rate, 24-hour BCD with no daylight saving, and a battery
  // that has not died. These are the values all four reference machines power up with.
  rtc.ram[REG_A] = 0x26;
  rtc.ram[REG_B] = 0x02;
  rtc.ram[REG_D] = 0x80;

  /** The instant the chip currently reads, as a Date. */
  rtc.now = () => new Date((rtc.host ? Date.now()
    : RTC_EPOCH_MS + (mem.r32(0x46c) >>> 0) * (MS_PER_DAY / TICKS_PER_DAY)) + rtc.offsetMs);

  /** One clock register, encoded the way register B says to. */
  const readTime = (reg) => {
    const d = rtc.now(), binary = (rtc.ram[REG_B] & 0x04) !== 0;
    const raw = reg === SEC ? d.getUTCSeconds()
      : reg === MIN ? d.getUTCMinutes()
      : reg === HOUR ? d.getUTCHours()
      : reg === DOW ? d.getUTCDay() + 1                    // the chip counts 1-7, Sunday = 1
      : reg === DOM ? d.getUTCDate()
      : reg === MONTH ? d.getUTCMonth() + 1
      : reg === YEAR ? d.getUTCFullYear() % 100
      : 0;                                                 // the alarm registers: never set here
    return binary ? raw & 0xff : bcd(raw);
  };

  /** Apply the registers a guest wrote while SET was high (datasheet: stop the clock, write, go). */
  const commit = () => {
    if (!rtc.pending.size) return;
    const d = rtc.now(), binary = (rtc.ram[REG_B] & 0x04) !== 0;
    const val = (reg, dflt) => (rtc.pending.has(reg)
      ? (binary ? rtc.pending.get(reg) : unbcd(rtc.pending.get(reg))) : dflt);
    const century = unbcd(rtc.ram[CENTURY_AT]) || 20;
    const want = Date.UTC(
      rtc.pending.has(YEAR) ? century * 100 + val(YEAR, 0) : d.getUTCFullYear(),
      val(MONTH, d.getUTCMonth() + 1) - 1, val(DOM, d.getUTCDate()),
      val(HOUR, d.getUTCHours()), val(MIN, d.getUTCMinutes()), val(SEC, d.getUTCSeconds()));
    rtc.offsetMs += want - d.getTime();
    rtc.pending.clear();
  };

  // The century byte is RAM, so it has to be seeded from the epoch rather than nailed to 20h:
  // seeding the constant while the year said 90 made MS-DOS 4 come up in 2090.
  rtc.ram[CENTURY_AT] = rtc.ram[CENTURY_PS2] = bcd((rtc.now().getUTCFullYear() / 100) | 0);

  // A real BIOS seeds the BDA tick from the RTC during POST, which is why a booted DOS shows a time
  // of day and not the time since power-on. Seeding it is also what gives every service ONE source:
  // the chip reads epoch + tick, and INT 21h AH=2Ah/2Ch in src/dos.js reads the same epoch + the
  // same tick, so they cannot drift apart. Reading the seed back out of rtc.now() instead would
  // count the hour twice — it did, and the clock came up at 16:00.
  mem.w32(0x46c, Math.round(BOOT_HOUR * 3600000 / (MS_PER_DAY / TICKS_PER_DAY)));

  machine.onPortWrite(0x70, (_p, _s, v) => { rtc.index = v & 0x3f; rtc.nmiDisabled = (v & 0x80) !== 0; });
  machine.onPortRead(0x70, () => 0xff);                    // the index port is write-only on a real chip

  // The CONFIGURATION bytes a POST leaves in CMOS, computed from the machine as it is when they are
  // read (drives are attached after the chip is installed). They were all zero: PC-MOS/386 reads 10h
  // before it has a boot sector, found "no diskette drive", and addressed every sector with a default
  // geometry — "Internal error ... opening $$SHELL.SYS". Measured with tools/cmosdump.asm: QEMU/SeaBIOS
  // and DOSBox-X agree on the drive types, the equipment byte (bit 2 set on both) and the memory
  // sizes. Neither computes the 2Eh/2Fh checksum, so neither do we. 12h/19h for a hard disk follow
  // QEMU with an IDE disk (type 15 in 12h, "see 19h", user type 47 there). A guest's own write wins.
  const written = new Set();
  const FLOPPY_CMOS = { 1: 1, 2: 2, 3: 3, 4: 4, 6: 5 };        // AH=08h BL drive type -> CMOS type
  const config = (i) => {
    const drives = machine.disk ? machine.disk.drives : new Map();
    const fd = (n) => { const d = drives.get(n); return d ? (FLOPPY_CMOS[d.geom.type] || 4) : 0; };
    const ext = Math.max(0, (mem.size >>> 10) - 1024), ext16 = Math.min(ext, 0xffff);
    const above16 = Math.max(0, (mem.size - 0x1000000) >>> 16);
    switch (i) {
      case 0x10: return (fd(0) << 4) | fd(1);
      case 0x12: return drives.has(0x80) ? 0xf0 | (drives.has(0x81) ? 0x0f : 0) : 0;
      case 0x19: return drives.has(0x80) ? 47 : 0;
      case 0x1a: return drives.has(0x81) ? 47 : 0;
      case 0x14: {
        const nfd = (drives.has(0) ? 1 : 0) + (drives.has(1) ? 1 : 0);
        return (nfd ? 0x01 | ((nfd - 1) << 6) : 0) | 0x02 | 0x04;   // drives, x87, bit 2; video 00 = EGA/VGA
      }
      case 0x15: return 640 & 0xff;
      case 0x16: return 640 >> 8;
      case 0x17: case 0x30: return ext16 & 0xff;
      case 0x18: case 0x31: return ext16 >> 8;
      case 0x34: return above16 & 0xff;
      case 0x35: return (above16 >> 8) & 0xff;
      default: return -1;
    }
  };

  machine.onPortRead(0x71, () => {
    const i = rtc.index;
    if (TIME_REGS.has(i)) return readTime(i);
    if (!written.has(i)) { const v = config(i); if (v >= 0) return v; }
    if (i === REG_C) { const v = rtc.ram[REG_C]; rtc.ram[REG_C] = 0; return v; }   // cleared by reading
    return rtc.ram[i];
  });
  machine.onPortWrite(0x71, (_p, _s, v) => {
    const i = rtc.index, b = v & 0xff;
    if (TIME_REGS.has(i)) { rtc.pending.set(i, b); if (!(rtc.ram[REG_B] & B_SET)) commit(); return; }
    if (i === REG_C || i === REG_D) return;                // status registers are read-only
    if (i === REG_A) { rtc.ram[REG_A] = b & 0x7f; return; }   // UIP is read-only; see below
    const was = rtc.ram[i];
    rtc.ram[i] = b; written.add(i);
    if (i === REG_B && (was & B_SET) && !(b & B_SET)) commit();
  });

  // UIP is left CLEAR for ever. The datasheet has it rise for about 2 ms before each update, and a
  // careful guest polls until it falls before reading the time; a guest that polls for it to RISE
  // would spin, but that is not what the documented sequence asks for, and an emulated clock has no
  // update window to protect — every read here is already atomic.

  machine.hookInterrupt(0x1a, (c) => {
    switch (c.ah) {
      case 0x00: {                                          // get tick count since midnight
        const t = mem.r32(0x46c);
        c.cx = (t >>> 16) & 0xffff; c.dx = t & 0xffff; c.al = 0;
        c.flags &= ~1; return;
      }
      case 0x01: {                                          // SET tick count: CX:DX, midnight flag cleared
        // Unanswered until now; the FreeDOS kernel on v86's xcom144.img calls it at boot. The BIOS
        // tick and the chip are separate clocks on a PC, but here the chip reads epoch + tick, so
        // moving the tick moves offsetMs the other way: the RTC must not change when a program
        // resets the BIOS count (SeaBIOS handle_1a01 touches only the BDA).
        const was = mem.r32(0x46c) >>> 0, now = (((c.cx & 0xffff) << 16) | (c.dx & 0xffff)) >>> 0;
        mem.w32(0x46c, now); mem.w8(0x470, 0);
        rtc.offsetMs -= (now - was) * (MS_PER_DAY / TICKS_PER_DAY);
        c.ah = 0; c.flags &= ~1; return;
      }
      case 0x02:                                            // get RTC time (AT and up)
        c.cx = (readTime(HOUR) << 8) | readTime(MIN);
        c.dx = (readTime(SEC) << 8) | (rtc.ram[REG_B] & B_DSE);
        c.ah = 0; c.flags &= ~1; return;
      case 0x04:                                            // get RTC date (AT and up)
        c.cx = (rtc.ram[CENTURY_AT] << 8) | readTime(YEAR);
        c.dx = (readTime(MONTH) << 8) | readTime(DOM);
        c.ah = 0; c.flags &= ~1; return;
      case 0x03:                                            // set RTC time: CH:CL = h:m, DH = s, DL = DST
        rtc.ram[REG_B] |= B_SET;
        rtc.pending.set(HOUR, (c.cx >> 8) & 0xff); rtc.pending.set(MIN, c.cx & 0xff);
        rtc.pending.set(SEC, (c.dx >> 8) & 0xff);
        rtc.ram[REG_B] = (rtc.ram[REG_B] & ~(B_SET | B_DSE)) | (c.dx & B_DSE);
        commit(); c.flags &= ~1; return;
      case 0x05:                                            // set RTC date: CH = century, CL = year
        rtc.ram[REG_B] |= B_SET;
        rtc.ram[CENTURY_AT] = rtc.ram[CENTURY_PS2] = (c.cx >> 8) & 0xff;
        rtc.pending.set(YEAR, c.cx & 0xff);
        rtc.pending.set(MONTH, (c.dx >> 8) & 0xff); rtc.pending.set(DOM, c.dx & 0xff);
        rtc.ram[REG_B] &= ~B_SET;
        commit(); c.flags &= ~1; return;
      default:
        machine.unhandledInts[0x1a]++;
        c.flags |= 1; return;                               // CF set: not a service this chip has
    }
  });

  return rtc;
}
