; realchain.asm — loops of the shapes chained blocks take without paging (a forward branch kept inside the
; block, a self-loop on JNZ, a JMP back to the head), run with interrupts on so that the timer lands in
; them, and a write into a later piece of a running block. tools/test.js runs it twice, chained and not,
; slice by slice: the cycles, the registers, the BIOS tick count and the patched byte must be the same
; at every slice, and the chained run must take fewer dispatches.
;
;   nasm -f bin tools/realchain.asm
        org     0x100
        cli                             ; our INT 8: counts the ticks where the loops read them
        xor     ax, ax
        mov     es, ax
        mov     word [es:0x20], tick8
        mov     [es:0x22], cs
        mov     al, 0x36                ; and a fast timer: a divisor of 1024, ticks inside the loops
        out     0x43, al
        xor     al, al
        out     0x40, al
        mov     al, 4
        out     0x40, al
        sti
        mov     cx, 0x4000
        xor     si, si
        xor     di, di
        xor     bx, bx
outer:  inc     si                      ; a forward branch: the block goes on past it
        cmp     si, 7
        jb      .skip
        xor     si, si
        inc     di
.skip:  add     bx, si
        add     bx, [ticks]             ; when the timer landed shows in BX
        dec     cx
        jnz     outer                   ; back to the head: a self-loop
        mov     cx, 0x3000
        xor     dx, dx
spin:   cmp     dx, 0x2ff0              ; a JMP back to the head, its way out a forward branch
        ja      done
        inc     dx
        mov     byte [patch + 1], dl    ; a write into the immediate below, a later piece of this block
        add     ax, dx
        cmp     ax, 0x8000
        jb      keep
        xor     ax, ax
keep:
patch:  mov     bp, 0x00                ; patched each turn
        add     di, bp
        jmp     spin
done:   mov     ax, 0x4c00
        int     0x21
tick8:  inc     word [cs:ticks]
        push    ax
        mov     al, 0x20
        out     0x20, al
        pop     ax
        iret
ticks:  dw      0
