; xms15.asm — what does INT 15h AH=88h (extended memory size, KB above 1 MiB) actually answer?
;
; The answer is configuration-dependent by design: HIMEM.SYS hooks the vector and reports 0 once it
; owns extended memory, so "what a real BIOS returns" is the wrong question — the question is what
; the guest sees under the setup our oracle runs. ZONE66 is the corpus title that asks.
;
;   nasm -f bin tools/xms15.asm -o XMS15.COM
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "XMS15.COM > OUT.TXT" -c "exit"
;
; Measured 2026-08-25 on dosbox-x with XMS installed: KB=0000 CF=0000 XM=0080 — the driver owns
; extended memory and reports none through this vector.
;
; Also reports CF and whether an XMS driver answers INT 2Fh AX=4300 (AL=80 = installed), so the two
; are read together rather than guessed at apart.
        org 0x100
start:  mov     ax, 0x4300      ; XMS installation check first — it does not disturb 88h
        int     0x2f
        mov     [v_xms], al
        xor     ax, ax
        mov     ah, 0x88
        stc
        int     0x15
        mov     [v_ax], ax
        mov     ax, 0
        adc     ax, 0
        mov     [v_cf], ax

        mov     si, names
        mov     di, v_ax
        mov     cx, 3
.each:  push    cx
        mov     al, [si]
        call    putc
        mov     al, [si+1]
        call    putc
        mov     al, '='
        call    putc
        mov     ax, [di]
        call    puthex
        mov     al, ' '
        call    putc
        add     si, 2
        add     di, 2
        pop     cx
        loop    .each
        mov     al, 13
        call    putc
        mov     al, 10
        call    putc
        mov     ax, 0x4c00
        int     0x21
putc:   push    ax
        push    dx
        mov     dl, al
        mov     ah, 2
        int     0x21
        pop     dx
        pop     ax
        ret
puthex: push    cx
        mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 0x0f
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    call    putc
        pop     ax
        loop    .d
        pop     cx
        ret
names:  db      'KB','CF','XM'
v_ax:   dw      0
v_cf:   dw      0
v_xms:  dw      0
