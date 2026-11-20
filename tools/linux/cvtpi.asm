; cvtpi.asm — the conversions between SSE and MMX (no prefix) Unreal Tournament's Pentium III code makes:
; CVTPS2PI of 2.5 and -2.5 under each of MXCSR's rounding controls (to nearest even, down, up, toward zero),
; CVTTPS2PI of 3.9 and -3.9 (truncated whatever MXCSR says), and CVTPI2PS of -7 and 9 (their floats' bits).
; Each result written to stdout as eight hex digits and a newline.
;
;   nasm -f bin tools/linux/cvtpi.asm -o CVTPI
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

_start: mov     esi, modes
        mov     edi, 4
.each:  ldmxcsr [esi]
        cvtps2pi mm0, [pair]
        call    both
        add     esi, 4
        dec     edi
        jnz     .each
        cvttps2pi mm0, [pair2]
        call    both
        cvtpi2ps xmm1, [ints]
        movd    eax, xmm1
        call    hex
        shufps  xmm1, xmm1, 0x55
        movd    eax, xmm1
        call    hex
        emms
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
; mm0's two doublewords, low then high
both:   movd    eax, mm0
        call    hex
        psrlq   mm0, 32
        movd    eax, mm0
        call    hex
        ret
; eax as eight hex digits and a newline on stdout
hex:    pusha
        mov     edi, buf
        mov     ecx, 8
.dig:   rol     eax, 4
        mov     edx, eax
        and     edx, 15
        mov     dl, [digits + edx]
        mov     [edi], dl
        inc     edi
        loop    .dig
        mov     byte [edi], 10
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, buf
        mov     edx, 9
        int     0x80
        popa
        ret
modes:  dd      0x1f80, 0x3f80, 0x5f80, 0x7f80
pair:   dd      2.5, -2.5
pair2:  dd      3.9, -3.9
ints:   dd      -7, 9
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
buf     equ     $$ + filesz
memsz   equ     filesz + 16
