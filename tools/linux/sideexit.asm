; sideexit.asm — two loops in one block, as a synthesizer's and an interpreter's: the first starts two
; instructions past the block's head, the second branches forward past one instruction in its body,
; as clipping or an opcode test does. Under paging the recompiler turns each in a loop inside the
; block, opened at its target, and leaves the second by a side exit when its branch is taken.
; 3000 + 1000 + 7 * 250 = 5750: 118 (5750 & 255), the exit status, as Docker i386 exits. tools/test.js
; also holds the instructions it counted, and that neither loop's head nor the fall-through began a
; block of its own.
;
;   nasm -f bin tools/linux/sideexit.asm -o SIDEEXIT
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

_start: xor     edx, edx
        mov     ecx, 1000
.inner: add     edx, 3                          ; the first loop, inside the block
        dec     ecx
        jnz     .inner
        mov     ecx, 1000
.loop:  test    cl, 3
        jnz     .odd                            ; taken three times in four: the side exit
        add     edx, 7                          ; the fall-through, in the loop
.odd:   inc     edx
        dec     ecx
        jnz     .loop
        mov     ebx, edx
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
