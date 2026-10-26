; x87mem.asm — what a 4K intro's synthesizer does, under paging (every Linux and Win32 program is
; paged): x87 arithmetic on memory operands (fld/fmul/fadd/fstp on floats and doubles, fild/fistp on
; ints) in a loop that also pushes and pops, reads a byte with lodsb, calls through a pointer and pushes
; from memory; then a block that branches back to itself a thousand times. 1.5 * 2.5 + 10 (an int) =
; 13.75, times 4 stored as an int: 55, the exit status, as Docker i386 exits. tools/test.js also holds
; that it ran with none of the slow paths the recompiler now avoids there.
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
        mov     esi, vb
        lodsb                                   ; 0 (the low byte of 2.5 as a double)
        call    [fnptr]                         ; an indirect call, as an interpreter's dispatch
        push    dword [vten]
        pop     eax                             ; 10
        fld     dword [va]                       ; 1.5
        fmul    qword [vb]                       ; * 2.5
        fiadd   dword [vten]                     ; + 10
        fstp    dword [vr]                       ; 13.75
        fld     dword [vr]
        fmul    dword [vfour]
        fistp   dword [vout]                     ; 55
        pop     ecx
        loop    .loop
        mov     ecx, 1000                       ; a block that branches back to itself
.spin:  dec     ecx
        jnz     .spin
        mov     ebx, [vout]
        mov     eax, 1
        int     0x80
fn:     ret
fnptr:  dd      fn
va:     dd      1.5
vb:     dq      2.5
vten:   dd      10
vfour:  dd      4.0
filesz  equ     $ - $$
vr      equ     $$ + 0x1000                     ; the results on a page of their own, away from the code
vout    equ     vr + 4
memsz   equ     0x1008
