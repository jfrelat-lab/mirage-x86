; x87mem.asm — x87 arithmetic on memory operands, as a 4K intro's synthesizer does it, under paging
; (every Linux program is paged): fld/fmul/fadd/fstp on floats and doubles, fild/fistp on ints, in a
; loop that also pushes and pops. 1.5 * 2.5 + 10 (an int) = 13.75, times 4 stored as an int: 55, the
; exit status. tools/test.js also holds that it ran with no cpu.fpuMem call and no page walk for its
; stack: the paged inline forms and the helpers' fast-table probe.
;
;   nasm -f bin tools/linux/x87mem.asm -o X87MEM
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

_start: mov     ecx, 1000
.loop:  push    ecx
        fld     dword [va]                       ; 1.5
        fmul    qword [vb]                       ; * 2.5
        fiadd   dword [vten]                     ; + 10
        fstp    dword [vr]                       ; 13.75
        fld     dword [vr]
        fmul    dword [vfour]
        fistp   dword [vout]                     ; 55
        pop     ecx
        loop    .loop
        mov     ebx, [vout]
        mov     eax, 1
        int     0x80
va:     dd      1.5
vb:     dq      2.5
vten:   dd      10
vfour:  dd      4.0
filesz  equ     $ - $$
vr      equ     $$ + 0x1000                     ; the results on a page of their own, away from the code
vout    equ     vr + 4
memsz   equ     0x1008
