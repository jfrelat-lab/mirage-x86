; mmxsse.asm — the integer instructions SSE added to the MMX registers (Pentium III, 1999) on fixed
; operands, each result printed in hex, one line each: PMINUB, PMAXUB, PAVGB, PAVGW, PMULHUW, PMINSW,
; PMAXSW, PSADBW (register and memory), PSHUFW with four orders, PINSRW and PEXTRW, PMOVMSKB, MOVNTQ.
; A and B as in mmx.asm. Docker i386 (qemu) prints the reference: tools/test.js compares MIRAGE's
; lines with it. .kkrieger (farbrausch, 2004) builds its textures with PMAXSW and its kin.
;
;   nasm -f bin tools/linux/mmxsse.asm -o MMXSSE
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
        pminub   mm0, mm1
        call    emit
        movq    mm0, [va]
        pminub   mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pminub   mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmaxub   mm0, mm1
        call    emit
        movq    mm0, [va]
        pmaxub   mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pmaxub   mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pavgb    mm0, mm1
        call    emit
        movq    mm0, [va]
        pavgb    mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pavgb    mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pavgw    mm0, mm1
        call    emit
        movq    mm0, [va]
        pavgw    mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pavgw    mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmulhuw  mm0, mm1
        call    emit
        movq    mm0, [va]
        pmulhuw  mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pmulhuw  mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pminsw   mm0, mm1
        call    emit
        movq    mm0, [va]
        pminsw   mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pminsw   mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        pmaxsw   mm0, mm1
        call    emit
        movq    mm0, [va]
        pmaxsw   mm0, [vb]
        call    emit
        movq    mm0, [vb]
        pmaxsw   mm0, [va]
        call    emit
        movq    mm0, [va]
        movq    mm1, [vb]
        psadbw   mm0, mm1
        call    emit
        movq    mm0, [va]
        psadbw   mm0, [vb]
        call    emit
        movq    mm0, [vb]
        psadbw   mm0, [va]
        call    emit
        pshufw  mm0, [va], 0x1b
        call    emit
        movq    mm1, [vb]
        pshufw  mm0, mm1, 0x1b
        call    emit
        pshufw  mm0, [va], 0xe4
        call    emit
        movq    mm1, [vb]
        pshufw  mm0, mm1, 0xe4
        call    emit
        pshufw  mm0, [va], 0x00
        call    emit
        movq    mm1, [vb]
        pshufw  mm0, mm1, 0x00
        call    emit
        pshufw  mm0, [va], 0x93
        call    emit
        movq    mm1, [vb]
        pshufw  mm0, mm1, 0x93
        call    emit
        movq    mm0, [va]
        mov     eax, 0x12345678
        pinsrw  mm0, eax, 2
        call    emit
        movq    mm0, [va]
        pinsrw  mm0, [vb + 2], 3
        call    emit
        movq    mm1, [vb]
        pextrw  eax, mm1, 1
        movd    mm0, eax
        call    emit
        pextrw  eax, mm1, 3
        movd    mm0, eax
        call    emit
        movq    mm1, [vb]
        pmovmskb eax, mm1
        movd    mm0, eax
        call    emit
        movq    mm1, [va]
        pmovmskb eax, mm1
        movd    mm0, eax
        call    emit
        movq    mm1, [vb]
        movntq  [tmp + 8], mm1
        movq    mm0, [tmp + 8]
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
