; vbescan.asm — what a VESA BIOS answers about the logical scan line (4F06h) and the display start
; (4F07h), in mode 101h (640x480x8, banked). Allegro sets a 1024-pixel line before it draws (Kraptor,
; FreeDOS's games package) and MIRAGE failed the call: it drew with one pitch and we showed another.
; Each call's AX BX CX DX, one line each, to OUT.TXT, after going back to text mode:
;   SET   4F06h BL=0 CX=1024     (set the line in pixels)
;   GET   4F06h BL=1             (get: BX bytes, CX pixels, DX lines)
;   BYTES 4F06h BL=2 CX=2048     (set the line in bytes)
;   MAX   4F06h BL=3             (get the maximum: BX bytes, CX pixels)
;   START 4F07h BL=0 CX=8 DX=16  (set the display start)
;   WHERE 4F07h BL=1             (get it: CX first pixel, DX first line)
;
;   nasm -f bin tools/vbescan.asm -o VBESCAN.COM
        org     0x100
        bits    16
        mov     ax, 0x4f02
        mov     bx, 0x101
        int     0x10
        mov     di, out

        mov     ax, 0x4f06
        mov     bx, 0
        mov     cx, 1024
        int     0x10
        mov     si, s_set
        call    rec
        mov     ax, 0x4f06
        mov     bx, 1
        int     0x10
        mov     si, s_get
        call    rec
        mov     ax, 0x4f06
        mov     bx, 2
        mov     cx, 2048
        int     0x10
        mov     si, s_bytes
        call    rec
        mov     ax, 0x4f06
        mov     bx, 3
        int     0x10
        mov     si, s_max
        call    rec
        mov     ax, 0x4f07
        mov     bx, 0
        mov     cx, 8
        mov     dx, 16
        int     0x10
        mov     si, s_start
        call    rec
        mov     ax, 0x4f07
        mov     bx, 1
        int     0x10
        mov     si, s_where
        call    rec

        mov     ax, 3
        int     0x10
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      .q
        mov     bx, ax
        mov     ah, 0x40
        mov     cx, di
        sub     cx, out
        mov     dx, out
        int     0x21
        mov     ah, 0x3e
        int     0x21
        mov     byte [di], '$'
        mov     dx, out
        mov     ah, 9
        int     0x21
.q:     mov     ax, 0x4c00
        int     0x21

; append "<label> AX=xxxx BX=xxxx CX=xxxx DX=xxxx\r\n" at DI
rec:    push    dx
        push    cx
        push    bx
        push    ax
.l:     lodsb
        test    al, al
        jz      .r
        stosb
        jmp     .l
.r:     mov     si, regs
        mov     cx, 4
.n:     movsw                           ; " AX=" etc. are 4 bytes
        movsw
        pop     ax
        call    hex16
        loop    .n
        mov     ax, 0x0a0d
        stosw
        ret
hex16:  push    cx
        mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     stosb
        pop     ax
        loop    .d
        pop     cx
        ret

fname   db      'OUT.TXT', 0
regs    db      ' AX= BX= CX= DX='
s_set   db      'SET  ', 0
s_get   db      'GET  ', 0
s_bytes db      'BYTES', 0
s_max   db      'MAX  ', 0
s_start db      'START', 0
s_where db      'WHERE', 0
out:
