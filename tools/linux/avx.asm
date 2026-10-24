; avx.asm — the VEX-encoded instructions MIRAGE has (src/sse.js VEX), on known values: each result's
; bytes are printed in hex, a line per instruction, then the program exits 0. Docker i386/debian
; prints the same lines (its CPU, or qemu-user's, has AVX2 and BMI2).
;
;   vmovdqu ymm from memory and back; vpaddusb (xmm and ymm, with saturation); vpshufd; vmovd both
;   ways; movd (SSE2) both ways; vpmovzxbd ymm; vpsravd ymm (counts 0, 1, 31, 32 and above);
;   vpbroadcastb from memory; sarx;
;   and a VEX.128 operation zeroing the upper half of its YMM register.
;
; The Linux sizecoding intros of Outline 2021-2023 by The Orz (The light, Calculating Space, Campers)
; are made of these.
;
;   nasm -f bin tools/linux/avx.asm -o AVX && chmod +x AVX
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, memsz, 7, 0x1000
phsize  equ     $ - phdr

%macro DUMP 1                                   ; print %1 bytes of obuf as hex, then a newline
        mov     ecx, %1
        call    dump
%endmacro

_start:
        vmovdqu ymm0, [a]                       ; a: 32 bytes 0x00..0x1f + 0xf0
        vmovdqu ymm1, [b]
        vpaddusb ymm2, ymm0, ymm1               ; saturating byte adds
        vmovdqu [obuf], ymm2
        DUMP    32
        vpaddusb xmm3, xmm0, xmm1               ; VEX.128: the upper half of ymm3 zeroed
        vmovdqu [obuf], ymm3
        DUMP    32
        vpshufd xmm4, xmm0, 0x1b                ; dwords reversed
        vmovdqu [obuf], xmm4
        DUMP    16
        mov     eax, 0x89abcdef
        vmovd   xmm5, eax
        vmovdqu [obuf], ymm5
        DUMP    32
        vmovd   ebx, xmm0
        mov     [obuf], ebx
        DUMP    4
        movd    xmm6, eax                       ; SSE2: the upper half of ymm6 kept
        vmovdqu ymm6, [a]
        movd    xmm6, eax
        vmovdqu [obuf], ymm6
        DUMP    32
        movd    [obuf], xmm0
        DUMP    4
        vpmovzxbd ymm7, [c]                     ; 8 bytes to 8 dwords
        vmovdqu [obuf], ymm7
        DUMP    32
        vmovdqu ymm1, [vals]
        vpsravd ymm2, ymm1, ymm7                ; counts from c: 0 1 31 32 4 200 3 16
        vmovdqu [obuf], ymm2
        DUMP    32
        vpbroadcastb ymm3, xmm0                 ; byte 0 of ymm0 everywhere (a's first: 0, so first a byte of b)
        vpbroadcastb ymm3, [b + 16]
        vmovdqu [obuf], ymm3
        DUMP    32
        mov     edx, 0x80001234
        mov     ecx, 0x24                       ; sarx counts modulo 32: 4
        sarx    esi, edx, ecx
        mov     [obuf], esi
        DUMP    4

        mov     eax, 1
        xor     ebx, ebx
        int     0x80

dump:   mov     esi, obuf                       ; ECX bytes at obuf, as hex, and a newline
        mov     edi, line
.b:     movzx   eax, byte [esi]
        shr     al, 4
        mov     al, [hex + eax]
        stosb
        movzx   eax, byte [esi]
        and     al, 15
        mov     al, [hex + eax]
        stosb
        inc     esi
        loop    .b
        mov     al, 10
        stosb
        mov     edx, edi
        sub     edx, line
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        int     0x80
        ret

hex     db      '0123456789abcdef'
        align   32
a:      db      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
        db      0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0xf0
b:      times 16 db 0x80
        times 16 db 0x20
c:      db      0, 1, 31, 32, 4, 200, 3, 16
        align   4
vals:   dd      -100, -100, -100, -100, 0x7fffffff, -1, 0x40, 0x80000000
filesz  equ     $ - $$
obuf    equ     0x08048000 + filesz + 32
line    equ     obuf + 64
memsz   equ     filesz + 32 + 64 + 80
