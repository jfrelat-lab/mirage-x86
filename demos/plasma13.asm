; plasma13.asm — VGA mode 13h animated plasma, real-mode .COM.
; Builds a smooth bump LUT at runtime (parabola, no FPU needed), sets a rainbow
; palette through the DAC ports, then redraws the whole screen every frame from
; two phase-shifted LUT lookups so the field flows. Exits on a keypress.
;
;   nasm -f bin plasma13.asm -o PLASMA13.COM
;
; Exercises: runtime table generation (MUL/SHR), heavy ModR/M memory addressing
; ([lut+si], [es:di]), the DAC palette ports, 0x3DA vsync, and INT 16h.

        org 0x100
        bits 16

start:
        mov     ax, 0x0013
        int     0x10
        push    0xA000
        pop     es

        ; ---- build LUT[i] = (i*(256-i)) >> 8   (a smooth 0..64 hump) ----
        xor     si, si
.lut:
        mov     ax, si
        mov     bx, 256
        sub     bx, si
        mul     bx                  ; DX:AX = i*(256-i) (<= 0x4000, fits AX)
        shr     ax, 8               ; -> 0..64
        mov     [lut + si], al
        inc     si
        cmp     si, 256
        jb      .lut

        ; ---- rainbow palette via the DAC ports ----
        mov     dx, 0x03C8
        xor     al, al
        out     dx, al              ; index 0
        inc     dx                  ; 0x3C9
        xor     si, si
.pal:
        mov     ax, si
        and     al, 0x3f
        out     dx, al              ; R = i
        mov     ax, si
        add     ax, ax
        and     al, 0x3f
        out     dx, al              ; G = 2i
        mov     ax, si
        add     ax, si
        add     ax, si
        and     al, 0x3f
        out     dx, al              ; B = 3i
        inc     si
        cmp     si, 256
        jb      .pal

        ; ---- animation ----
        xor     bp, bp              ; phase t
.frame:
        mov     dx, 0x03DA          ; vsync
.v1:    in      al, dx
        test    al, 8
        jnz     .v1
.v2:    in      al, dx
        test    al, 8
        jz      .v2

        xor     di, di
        xor     bx, bx              ; BX = y
.yl:
        xor     cx, cx              ; CX = x
.xl:
        mov     ax, cx
        add     ax, bp
        and     ax, 0xff
        mov     si, ax
        mov     dl, [lut + si]      ; LUT[(x + t) & 0xff]
        mov     ax, bx
        sub     ax, bp
        and     ax, 0xff
        mov     si, ax
        mov     al, [lut + si]      ; LUT[(y - t) & 0xff]
        add     al, dl              ; colour 0..128
        mov     [es:di], al
        inc     di
        inc     cx
        cmp     cx, 320
        jb      .xl
        inc     bx
        cmp     bx, 200
        jb      .yl

        inc     bp
        mov     ah, 0x01
        int     0x16
        jz      .frame
        mov     ah, 0x00
        int     0x16

        mov     ax, 0x0003
        int     0x10
        mov     ax, 0x4C00
        int     0x21

lut:    times 256 db 0
