; follow.asm — a loop that calls a subroutine and jumps over an instruction, as an interpreter's
; dispatch returns to `add ebp,20h; jmp next`: under paging the recompiler follows a direct CALL or
; JMP into the same block when its target is on the head's page, before it or after. Then the subroutine's immediate is
; rewritten and the loop runs again: the blocks that hold it must go. 3 * 1000 + 7 * 1000 = 10000:
; 16 (10000 & 255), the exit status, as Docker i386 exits. tools/test.js also holds the instructions
; it counted, and that neither the subroutine nor the jump's target began a block of its own.
;
;   nasm -f bin tools/linux/follow.asm -o FOLLOW
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, filesz, 7, 0x1000
phsize  equ     $ - phdr

sub:    add     edx, 3                          ; before the loop: a block's bytes reach back to it
        ret
_start: xor     edx, edx
        xor     esi, esi
.again: mov     ecx, 1000
.top:   call    sub                             ; followed: the subroutine in the block
        jmp     .mid                            ; followed
        add     edx, 1000                       ; never run
.mid:   dec     ecx
        jnz     .top
        inc     esi
        cmp     esi, 2
        je      .done
        mov     byte [sub + 2], 7               ; add edx, 3 becomes add edx, 7
        jmp     .again
.done:  mov     ebx, edx
        and     ebx, 255
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
