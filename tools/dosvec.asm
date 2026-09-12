; dosvec.asm — print what Windows 3.0 real mode interrogates just before it refuses:
; the INT 21h and INT 2Fh vectors, the InDOS flag address (AH=34h) and the DOS version (AH=30h).
; MIRAGE answers these from F000 stubs; a real DOS keeps its kernel in low RAM, and the difference
; is the current hypothesis for "Incorrect DOS version". Run it under the oracle and under MIRAGE.
        org 0x100
        bits 16
        mov     ax, 0x3521
        int     0x21
        mov     [v21o], bx
        mov     [v21s], es
        mov     ax, 0x352f
        int     0x21
        mov     [v2fo], bx
        mov     [v2fs], es
        mov     ah, 0x34
        int     0x21
        mov     [indo], bx
        mov     [inds], es
        mov     ax, 0x3000
        int     0x21
        mov     [ver], ax
        ; format — each field loaded explicitly. A shared helper doing pointer arithmetic over the
        ; variables printed the wrong ones (the first version read [si+2] as the segment while the
        ; two words were stored offset-then-segment), which produced one correct field and garbage.
        mov     ax, [v21s]
        mov     di, msg + 6
        call    hex4
        mov     ax, [v21o]
        mov     di, msg + 11
        call    hex4
        mov     ax, [v2fs]
        mov     di, msg + 22
        call    hex4
        mov     ax, [v2fo]
        mov     di, msg + 27
        call    hex4
        mov     ax, [inds]
        mov     di, msg + 38
        call    hex4
        mov     ax, [indo]
        mov     di, msg + 43
        call    hex4
        mov     ax, [ver]
        mov     di, msg + 52
        call    hex4
        mov     ah, 9
        mov     dx, msg
        int     0x21
        mov     ax, 0x4c00
        int     0x21
; AX -> 4 hex digits at ds:di
hex4:   push    cx
        mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    mov     [di], al
        inc     di
        pop     ax
        loop    .d
        pop     cx
        ret
v21o    dw 0
v21s    dw 0
v2fo    dw 0
v2fs    dw 0
indo    dw 0
inds    dw 0
ver     dw 0
msg     db 'INT21=____:____ 2F=____:____ INDOS=____:____ VER=____', 13, 10, '$'
