; skipud.asm — an instruction MIRAGE does not translate (XSAVE, 0F AE /4) inside what a short forward
; branch always skips, under paging: the recompiler keeps the skipped run inside the block, and has to
; end the block before what it cannot translate instead of refusing the whole block. KolibriOS's kernel
; has such a run, and stopped there. Exits with 7.
;
;   nasm -f bin tools/linux/skipud.asm -o SKIPUD
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, filesz, 5, 0x1000
phsize  equ     $ - phdr

_start: xor     eax, eax
        test    eax, eax
        jz      .over                           ; always taken
        xsave   [eax]                           ; never runs
.over:  mov     ebx, 7
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
