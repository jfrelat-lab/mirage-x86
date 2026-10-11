; fcbparse.asm — which bytes INT 21h AH=29h (parse a file name into an FCB) writes. Watcom C's exec
; parses the two FCBs at PSP 5Ch and 6Ch AFTER it has copied the command line to 80h: the one at 6Ch
; must stop before 80h, or the command line is gone — C-Dogs' DOS/4GW then reported "syntax is
; DOS4GW <executable.xxx>". A 48-byte area is filled with AAh, "c:name.ext" parsed into it, and each
; byte printed: AA where untouched. To OUT.TXT and the screen, 48 bytes as hex.
;
;   nasm -f bin tools/fcbparse.asm -o FCBPARSE.COM
        org     0x100
        bits    16
        mov     di, area
        mov     cx, 48
        mov     al, 0xaa
        rep     stosb
        mov     si, text
        mov     di, area
        mov     ax, 0x2901
        int     0x21
        mov     di, out
        mov     si, area
        mov     cx, 48
.h:     lodsb
        call    hex8
        loop    .h
        mov     ax, 0x0a0d
        stosw
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      .s
        mov     bx, ax
        mov     ah, 0x40
        mov     cx, di
        sub     cx, out
        mov     dx, out
        int     0x21
        mov     ah, 0x3e
        int     0x21
.s:     mov     byte [di], '$'
        mov     dx, out
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21
hex8:   push    ax
        shr     al, 4
        call    .n
        pop     ax
        and     al, 15
.n:     add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     stosb
        ret

fname   db      'OUT.TXT', 0
text    db      'c:name.ext', 0
area    times   48 db 0
out:
