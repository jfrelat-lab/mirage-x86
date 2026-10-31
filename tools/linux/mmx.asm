; mmx.asm — every MMX instruction on fixed operands, its 64-bit result printed in hex, one line
; each: A (the destination) is 80017fff fffe0102 as words 0102 fffe 7fff 8001 and B (the source)
; 7f80ff01 80008000; the shifts by register take B's low byte counts 4 (then a quadword count of
; 2^32, every bit out), the immediate shifts the counts listed. Then MOVD and MOVQ to and from
; memory and registers, and EMMS. Docker i386 (qemu's MMX) prints the reference: tools/test.js
; compares MIRAGE's lines with it. Heaven Seven (Exceed, 2000) wants MMX.
;
;   nasm -f bin tools/linux/mmx.asm -o MMX
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
obuf    equ     $$ + 0x2000
_start: mov     edi, obuf
        movq    mm0, [va]
        movq    mm1, [vb]
        paddb    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddw    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddd    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubb    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubd    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddsb    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddsb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddsw    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddsw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubsb    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubsb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubsw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubsw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddusb    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddusb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        paddusw    mm0, mm1
        call    emit
        movq    mm0, [va]
        paddusw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubusb    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubusb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psubusw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psubusw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmullw    mm0, mm1
        call    emit
        movq    mm0, [va]
        pmullw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmulhw    mm0, mm1
        call    emit
        movq    mm0, [va]
        pmulhw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmaddwd    mm0, mm1
        call    emit
        movq    mm0, [va]
        pmaddwd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pand    mm0, mm1
        call    emit
        movq    mm0, [va]
        pand    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pandn    mm0, mm1
        call    emit
        movq    mm0, [va]
        pandn    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        por    mm0, mm1
        call    emit
        movq    mm0, [va]
        por    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pxor    mm0, mm1
        call    emit
        movq    mm0, [va]
        pxor    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpeqb    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpeqb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpeqw    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpeqw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpeqd    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpeqd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpgtb    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpgtb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpgtw    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpgtw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pcmpgtd    mm0, mm1
        call    emit
        movq    mm0, [va]
        pcmpgtd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        packsswb    mm0, mm1
        call    emit
        movq    mm0, [va]
        packsswb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        packssdw    mm0, mm1
        call    emit
        movq    mm0, [va]
        packssdw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        packuswb    mm0, mm1
        call    emit
        movq    mm0, [va]
        packuswb    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpcklbw    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpcklbw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpcklwd    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpcklwd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpckldq    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpckldq    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpckhbw    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpckhbw    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpckhwd    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpckhwd    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        punpckhdq    mm0, mm1
        call    emit
        movq    mm0, [va]
        punpckhdq    mm0, [vb]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psllw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psllw    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        pslld    mm0, mm1
        call    emit
        movq    mm0, [va]
        pslld    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psllq    mm0, mm1
        call    emit
        movq    mm0, [va]
        psllq    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psrlw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psrlw    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psrld    mm0, mm1
        call    emit
        movq    mm0, [va]
        psrld    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psrlq    mm0, mm1
        call    emit
        movq    mm0, [va]
        psrlq    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psraw    mm0, mm1
        call    emit
        movq    mm0, [va]
        psraw    mm0, [big]
        call    emit
        movq    mm0, [va]
        movq    mm1, [cnt]
        psrad    mm0, mm1
        call    emit
        movq    mm0, [va]
        psrad    mm0, [big]
        call    emit
        movq    mm0, [va]
        psllw    mm0, 3
        call    emit
        movq    mm0, [va]
        pslld    mm0, 5
        call    emit
        movq    mm0, [va]
        psllq    mm0, 13
        call    emit
        movq    mm0, [va]
        psrlw    mm0, 2
        call    emit
        movq    mm0, [va]
        psrld    mm0, 31
        call    emit
        movq    mm0, [va]
        psrlq    mm0, 40
        call    emit
        movq    mm0, [va]
        psraw    mm0, 9
        call    emit
        movq    mm0, [va]
        psrad    mm0, 33
        call    emit
        movq    mm0, [va]
        psllw    mm0, 16
        call    emit
        movq    mm0, [va]
        psrlq    mm0, 64
        call    emit
        mov     eax, 0x89abcdef                 ; MOVD in, zero-extends
        movd    mm0, eax
        call    emit
        movd    mm0, [vb + 4]
        call    emit
        movq    mm2, [va]                        ; MOVD out
        movd    eax, mm2
        mov     [tmp], eax
        movd    mm0, [tmp]
        call    emit
        movq    mm3, [vb]                        ; MOVQ out to memory and between registers
        movq    [tmp], mm3
        movq    mm0, [tmp]
        call    emit
        movq    mm4, [va]
        movq    mm0, mm4
        call    emit
        emms
        mov     edx, edi                         ; write(1, out, len)
        sub     edx, obuf
        mov     ecx, obuf
        mov     ebx, 1
        mov     eax, 4
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
emit:   movq    [tmp], mm0                       ; 16 hex digits, high dword first, and a newline
        mov     eax, [tmp + 4]
        call    hex32
        mov     eax, [tmp]
        call    hex32
        mov     byte [edi], 10
        inc     edi
        ret
hex32:  mov     ecx, 8
.h:     rol     eax, 4
        mov     edx, eax
        and     edx, 15
        mov     dl, [digits + edx]
        mov     [edi], dl
        inc     edi
        loop    .h
        ret
digits: db      '0123456789abcdef'
align 8
va:     dd      0xfffe0102, 0x80017fff
vb:     dd      0x80008000, 0x7f80ff01
cnt:    dd      4, 0
big:    dd      1, 1
filesz  equ     $ - $$
tmp     equ     $$ + 0x1000
memsz   equ     0x4000
