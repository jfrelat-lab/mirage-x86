; lfnprobe.asm — what DOS answers to a long-file-name call (INT 21h AH=71h) when it has none, and to
; a function it does not know. DJGPP programs ask 71A0h first and take "AX = 7100h" to mean "no long
; names here": they then use the 8.3 calls. Anything else and they keep calling 71xxh — Kraptor found
; none of its files. One line per call, AX and the carry, to OUT.TXT and the screen:
;   A0 71A0h  (volume information for C:\)
;   6C 716Ch  (extended open of KRAPTOR.DAT)
;   FF AH=FFh (no such function)
; and 71A0h and FFh again with the carry the other way going in: is it set, or left as it was?
;
;   nasm -f bin tools/lfnprobe.asm -o LFNPROBE.COM
        org     0x100
        bits    16
        mov     di, out
        mov     ax, 0x71a0
        mov     dx, root
        push    di
        mov     di, buf
        mov     cx, 32
        stc
        int     0x21
        pop     di
        mov     si, s_a0
        call    rec
        mov     ax, 0x716c
        mov     bx, 0
        mov     cx, 0
        mov     dx, 1
        mov     si, fname2
        stc
        int     0x21
        mov     si, s_6c
        call    rec
        mov     ax, 0xff00
        clc
        int     0x21
        mov     si, s_ff
        call    rec
        mov     ax, 0x71a0              ; the same two with the carry the other way in
        mov     dx, root
        push    di
        mov     di, buf
        mov     cx, 32
        clc
        int     0x21
        pop     di
        mov     si, s_a0c
        call    rec
        mov     ax, 0xff00
        stc
        int     0x21
        mov     si, s_ffs
        call    rec

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

; "<label> AX=xxxx CF=n\r\n" at DI; the carry as the call left it
rec:    pushf
        push    ax
.l:     lodsb
        test    al, al
        jz      .r
        stosb
        jmp     .l
.r:     mov     ax, 'AX'
        stosw                           ; "AX"
        mov     al, '='
        stosb
        pop     ax
        call    hex16
        mov     si, s_cf
        movsw
        movsw
        pop     ax
        and     al, 1
        add     al, '0'
        stosb
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
fname2  db      'KRAPTOR.DAT', 0
root    db      'C:\', 0
s_a0    db      'A0 ', 0
s_6c    db      '6C ', 0
s_ff    db      'FF ', 0
s_a0c   db      'A0 (CF clear before) ', 0
s_ffs   db      'FF (CF set before)   ', 0
s_cf    db      ' CF='
buf     times   32 db 0
out:
