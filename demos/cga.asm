; cga.asm — CGA mode 4 (320x200x4-colour) regression demo. Guards the CGA render path in
; video.js: four vertical colour bars (background + the 3 palette colours) filled into BOTH
; interleaved B800 banks (even scanlines at +0x0000, odd at +0x2000), so it exercises the 2-bit
; packing and the even/odd interleave. Colour-select 0x30 = palette 1 (cyan/magenta/white) +
; intensity. Static output — a stable golden fingerprint.
;
;   nasm -f bin cga.asm -o CGA.COM

        org 0x100
        bits 16
start:
        mov     ax, 0x0004          ; set CGA mode 4
        int     0x10
        mov     dx, 0x3d9           ; colour-select register
        mov     al, 0x30            ; palette 1 (cyan/magenta/white) + intensity, black background
        out     dx, al
        push    0xb800
        pop     es

        mov     si, 2               ; two banks: even (di=0), then odd (di=0x2000)
        xor     di, di
.bank:  mov     bp, 100             ; 100 scanlines per bank
.row:   mov     al, 0x00            ; 20 bytes → colour 0 (00 00 00 00 per byte = background)
        mov     cx, 20
        rep     stosb
        mov     al, 0x55            ; colour 1 (01 01 01 01)
        mov     cx, 20
        rep     stosb
        mov     al, 0xaa            ; colour 2 (10 10 10 10)
        mov     cx, 20
        rep     stosb
        mov     al, 0xff            ; colour 3 (11 11 11 11)
        mov     cx, 20
        rep     stosb
        dec     bp
        jnz     .row
        mov     di, 0x2000          ; switch to the odd-scanline bank
        dec     si
        jnz     .bank
.hang:  jmp     .hang
