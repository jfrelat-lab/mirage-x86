; skip.asm — Elevated's synthesizer (RGBA & TBC, 2009) picks an operator's x87 operation and an
; oscillator's waveform by chains of `dec eax; jnz next`, each skipping one to five instructions, some
; of which pop the x87 stack: here 32 turns of a loop that applies one of four operations to an
; accumulator, then adds to it either itself or a sign -- two branches to one target, the second
; inside what the first skips. Under paging the recompiler keeps each skipped run inside the block,
; `if(taken){..}else{..}`, and the loop with it. The accumulator, its two halves xored, is the
; exit status: 41, as Docker i386 exits. tools/test.js also holds the instructions it counted.
;
;   nasm -f bin tools/linux/skip.asm -o SKIP
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

_start: fld1                                    ; the accumulator
        mov     ecx, 32
.loop:  mov     eax, ecx
        and     eax, 3
        inc     eax                             ; the operation, 1 to 4
        fld     dword [three]
        dec     eax
        jnz     .add
        fstp    st0                             ; 1: none (pops the operand)
.add:   dec     eax
        jnz     .sub
        faddp   st1                             ; 2: + 3
.sub:   dec     eax
        jnz     .mul
        fsubp   st1                             ; 3: - 3
.mul:   dec     eax
        jnz     .wave
        fmulp   st1                             ; 4: * 3
.wave:  mov     eax, ecx
        and     eax, 1
        inc     eax                             ; 1 or 2
        fld     st0
        dec     eax
        jnz     .sum                            ; 2: the accumulator doubles
        fldz
        fcomip  st0, st1
        fstp    st0
        fld1
        jc      .sum                            ; 1: + 1 when positive...
        fchs                                    ; ...else - 1
.sum:   faddp   st1
        loop    .loop
        push    eax
        fistp   dword [esp]
        pop     ebx                             ; 977231126
        mov     eax, ebx
        shr     eax, 16
        xor     ebx, eax
        mov     eax, 1
        int     0x80
three:  dd      3.0
filesz  equ     $ - $$
