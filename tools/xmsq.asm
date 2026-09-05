; xmsq.asm — is an XMS driver installed? INT 2Fh AX=4300 answers AL=80h when one is. Prints AL, then
; asks 4310 for the entry point and prints ES:BX, so the two emulators can be compared side by side.
        org 0x100
        bits 16
        mov     ax, 0x4300
        int     0x2f
        mov     [v1], al
        mov     ax, 0x4310
        int     0x2f
        mov     [v2], bx
        mov     [v3], es
        mov     al, [v1]
        mov     ah, 0
        mov     di, msg + 7
        mov     cx, 2
        call    hex
        mov     ax, [v3]
        mov     di, msg + 20
        mov     cx, 4
        call    hex
        mov     ax, [v2]
        mov     di, msg + 25
        mov     cx, 4
        call    hex
        mov     ah, 9
        mov     dx, msg
        int     0x21
        mov     ax, 0x4c00
        int     0x21
hex:    push    cx                      ; AX -> CX hex digits at ES:DI (DS=ES=CS here)
        push    cs
        pop     es
        pop     cx
        push    cx
        mov     bx, cx
        shl     bx, 2
        mov     dx, 16
        sub     dx, bx
        mov     cx, dx
        jcxz    .go
        shl     ax, cl
.go:    pop     cx
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    stosb
        pop     ax
        loop    .d
        ret
v1      db 0
v2      dw 0
v3      dw 0
msg     db 'XMS AL=__  entree ____:____', 13, 10, '$'
