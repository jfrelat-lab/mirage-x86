; conread.asm — what INT 21h AH=3Fh returns for handle 0 at the keyboard: a read of 10 bytes after
; "hi" and Enter are typed. AX and the bytes go to CONREAD.TXT as hex: "0004 68690D0A" under DOSBox-X
; (AUTOTYPE h i enter) — the line, CR and LF. MIRAGE answered 0 bytes, end of file.
; A read SHORTER than the line is where DOS implementations part: DOSBox-X returns "hi" CR for 3
; bytes and drops the LF (the next read waits for a new line); MS-DOS keeps the rest of its line
; buffer for the next read, and so does MIRAGE.
;
;   nasm -f bin tools/conread.asm -o CONREAD.COM
        org     0x100
        mov     di, out
        mov     cx, 10
        call    rd
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        mov     bx, ax
        mov     ah, 0x40
        mov     cx, di
        sub     cx, out
        mov     dx, out
        int     0x21
        mov     ah, 0x3e
        int     0x21
        mov     ax, 0x4c00
        int     0x21
rd:     push    di
        mov     ah, 0x3f
        xor     bx, bx
        mov     dx, buf
        int     0x21
        pop     di
        push    ax
        mov     al, ah
        call    hex8
        pop     ax
        push    ax
        call    hex8
        mov     al, ' '
        stosb
        pop     cx
        mov     si, buf
.b:     jcxz    .e
        lodsb
        call    hex8
        dec     cx
        jmp     .b
.e:     ret
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
fname   db      'CONREAD.TXT', 0
buf     times 16 db 0
out:
