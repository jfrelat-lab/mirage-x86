; curshape.asm — what INT 10h AH=03h reports after AH=01h set the cursor shape, in mode 3 (16-line
; characters): the value asked for, or the one the BIOS scaled for the CRTC? And what the BDA holds
; (0040:0060, end then start) and the CRTC (0Ah start, 0Bh end) is given.
;   "SET=0607 GET=xxxx BDA=xxxx CRTC=xxxx" to OUT.TXT and the screen.
;
;   nasm -f bin tools/curshape.asm -o CURSHAPE.COM
        org     0x100
        bits    16
        mov     ax, 3
        int     0x10
        mov     ah, 1
        mov     cx, 0x0607
        int     0x10
        mov     ah, 3
        xor     bx, bx
        int     0x10
        mov     [get], cx
        push    ds
        mov     ax, 0x40
        mov     ds, ax
        mov     ax, [0x60]
        pop     ds
        mov     [bda], ax
        mov     dx, 0x3d4
        mov     al, 0x0a
        out     dx, al
        inc     dx
        in      al, dx
        mov     ah, al
        dec     dx
        mov     al, 0x0b
        out     dx, al
        inc     dx
        in      al, dx
        mov     [crtc], ax

        mov     di, res + 13
        mov     ax, [get]
        call    hex16
        mov     di, res + 22
        mov     ax, [bda]
        call    hex16
        mov     di, res + 32
        mov     ax, [crtc]
        call    hex16
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      .s
        mov     bx, ax
        mov     ah, 0x40
        mov     cx, reslen
        mov     dx, res
        int     0x21
        mov     ah, 0x3e
        int     0x21
.s:     mov     dx, res
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

hex16:  mov     cx, 4
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
        ret

fname   db      'OUT.TXT', 0
res     db      'SET=0607 GET=???? BDA=???? CRTC=????', 13, 10
reslen  equ     $ - res
        db      '$'
get     dw      0
bda     dw      0
crtc    dw      0
