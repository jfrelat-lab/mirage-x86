; sideexit.asm — a loop whose body branches forward past one instruction, as a synthesizer's clipping
; or an interpreter's opcode tests do: under paging the recompiler runs the fall-through in the same
; block and leaves it by a side exit when the branch is taken. 1000 + 7 * 250 = 2750: 190 (2750 & 255),
; the exit status, as Docker i386 exits. tools/test.js also holds the instructions it counted, and that
; the fall-through began no block of its own.
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
.loop:  test    cl, 3
        jnz     .odd                            ; taken three times in four: the side exit
        add     edx, 7                          ; the fall-through, in the loop's block
.odd:   inc     edx
        dec     ecx
        jnz     .loop
        mov     ebx, edx
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
