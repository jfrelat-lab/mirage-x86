// samples.js — tiny hand-assembled .COM programs bundled on the virtual C: drive
// so there is something to run immediately. Each is real x86 machine code that
// the recompiler executes — nothing is special-cased.

const s = (str) => [...str].map(c => c.charCodeAt(0));

// HELLO.COM — print a $-terminated string via INT 21h/09, then INT 20h.
function hello() {
  const msg = 'Hello from MIRAGE — a pure-JS x86 machine.\r\n$';
  const code = [0xb4, 0x09, 0xba, 0x09, 0x01, 0xcd, 0x21, 0xcd, 0x20];
  return Uint8Array.from(code.concat(s(msg)));   // msg sits at offset 9 → 0x0100+9
}

// BANNER.COM — show off CP437 box-drawing glyphs and colour via a $-string.
function banner() {
  const top = [0xc9, ...Array(30).fill(0xcd), 0xbb, 0x0d, 0x0a];
  const mid = [0xba, 0x20, ...s('   MIRAGE  DOS  ENVIRONMENT  '), 0xba, 0x0d, 0x0a];
  const bot = [0xc8, ...Array(30).fill(0xcd), 0xbc, 0x0d, 0x0a];
  const msg = [...top, ...mid, ...bot, 0x24];
  const code = [0xb4, 0x09, 0xba, 0x09, 0x01, 0xcd, 0x21, 0xcd, 0x20];
  return Uint8Array.from(code.concat(msg));
}

// BARS.COM — set mode 13h and animate a palette-cycling diagonal colour field.
// (The classic "shifting bands" effect, straight from VGA memory at A000:0000.)
function bars() {
  return Uint8Array.from([
    0xb8, 0x13, 0x00,   // MOV AX,0013h
    0xcd, 0x10,         // INT 10h         ; mode 13h (320x200x256)
    0xb8, 0x00, 0xa0,   // MOV AX,A000h
    0x8e, 0xc0,         // MOV ES,AX
    0xb3, 0x00,         // MOV BL,0        ; frame base
    // frame: (0x0C)
    0x31, 0xff,         // XOR DI,DI
    0x88, 0xd8,         // MOV AL,BL
    0xb9, 0x00, 0xfa,   // MOV CX,FA00h    ; 64000 pixels
    // inner: (0x13)
    0xaa,               // STOSB
    0xfe, 0xc0,         // INC AL
    0xe2, 0xfb,         // LOOP inner
    0xfe, 0xc3,         // INC BL
    0xeb, 0xf0,         // JMP frame
  ]);
}

// PLASMA.COM — animated gradient field in mode 13h: each pixel's colour is
// (col + row + t) & 255, and t advances every frame so the bands scroll smoothly.
function plasma() {
  return Uint8Array.from([
    0xb8, 0x13, 0x00,   // 00 MOV AX,13h
    0xcd, 0x10,         // 03 INT 10h
    0xb8, 0x00, 0xa0,   // 05 MOV AX,A000h
    0x8e, 0xc0,         // 08 MOV ES,AX
    0xbd, 0x00, 0x00,   // 0A MOV BP,0        ; time
    // frame: (0x0D)
    0x31, 0xff,         // 0D XOR DI,DI
    0xba, 0xc8, 0x00,   // 0F MOV DX,200      ; rows
    // rowloop: (0x12)
    0xb9, 0x40, 0x01,   // 12 MOV CX,320      ; cols
    // colloop: (0x15)
    0x89, 0xc8,         // 15 MOV AX,CX
    0x01, 0xd0,         // 17 ADD AX,DX
    0x01, 0xe8,         // 19 ADD AX,BP
    0xaa,               // 1B STOSB           ; AL=(col+row+t)
    0xe2, 0xf7,         // 1C LOOP colloop    ; → 0x15
    0x4a,               // 1E DEC DX
    0x75, 0xf1,         // 1F JNZ rowloop     ; → 0x12
    0x45,               // 21 INC BP
    0xeb, 0xe9,         // 22 JMP frame       ; → 0x0D
  ]);
}

export const SAMPLES = [
  { name: 'HELLO.COM', desc: 'Print a greeting (INT 21h)', make: hello },
  { name: 'BANNER.COM', desc: 'CP437 box-drawing banner', make: banner },
  { name: 'BARS.COM', desc: 'Mode 13h palette-cycling bars', make: bars },
  { name: 'PLASMA.COM', desc: 'Mode 13h animated plasma', make: plasma },
];
