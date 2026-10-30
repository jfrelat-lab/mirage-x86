; fxcache.asm — the x87 stack as a block keeps it (its top and the values it has read or written):
; a loop that pushes once a turn and adds what was on the stack before it, one that pushes and reads
; nothing from before it, FXCH, FINCSTP/FDECSTP, and an FCMOV, which goes through src/fpu.js, between
; values the block holds. 1 + 1 + 2 + 4 + 8 + 8 = 24, 1 + 1 + 1 = 3 and 5 + 5 = 10: 253 (24 * 10 +
; 3 + 10), the exit status, as Docker i386 exits.
;
;   nasm -f bin tools/linux/fxcache.asm -o FXCACHE
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
res     equ     $$ + 0x1000
_start: finit
        fld1                                    ; a = 1
        fldz                                    ; s = 0
        mov     ecx, 4
.grow:  fadd    st0, st1                        ; s += the value under it
        fld     st0                             ; and pushed again: one deeper a turn
        dec     ecx
        jnz     .grow
        faddp   st1, st0                        ; 8 + 8 + 4 + 2 + 1 + 1
        faddp   st1, st0
        faddp   st1, st0
        faddp   st1, st0
        faddp   st1, st0
        fistp   dword [res]                     ; 24
        mov     ecx, 3
.ones:  fld1                                    ; a loop in the block one deeper a turn, reading
        dec     ecx                             ; nothing from before it
        jnz     .ones
        faddp   st1, st0
        faddp   st1, st0
        fistp   dword [res + 8]                 ; 3
        fild    dword [three]
        fild    dword [five]                      ; 5, 3
        fxch    st1                             ; 3, 5
        fincstp
        fdecstp
        stc
        fcmovb  st0, st1                        ; 5, 5 (CF set)
        fadd    st0, st1                        ; 10
        fstp    st1
        fistp   dword [res + 4]                 ; 10
        mov     eax, [res]
        imul    ebx, eax, 10
        add     ebx, [res + 4]
        add     ebx, [res + 8]
        mov     eax, 1
        int     0x80
three:     dd      3
five:     dd      5
filesz  equ     $ - $$
memsz   equ     0x1008
