; dpmiq.asm — is a DPMI host present? INT 2Fh AX=1687 answers AX=0 when one is and leaves AX
; unchanged otherwise. Writes "AX=xxxx" to DPMI.TXT.
        org 0x100
        bits 16
        mov     ax, 0x1687
        int     0x2f
        ; A host that IS present answers ES:DI = its mode-switch entry, so ES no longer addresses
        ; this program. The stosb below would then write the digits into the HOST's segment and this
        ; probe would report nothing in exactly the case it exists to detect — which is what it did.
        push    cs
        pop     es
        mov     cx, 4                   ; AX -> 4 hex digits at buf+3
        mov     di, buf + 3
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
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fn
        int     0x21
        mov     bx, ax
        mov     ah, 0x40
        mov     cx, 8
        mov     dx, buf
        int     0x21
        mov     ah, 0x3e
        int     0x21
        mov     ax, 0x4c00
        int     0x21
fn      db 'DPMI.TXT', 0
buf     db 'AX=____', 10
