; xormunch.asm — VGA mode 13h "munching squares" (x XOR y) with a rotating palette.
; A real-mode .COM that exercises: INT 10h mode set, direct A000:0 framebuffer
; writes, the VGA DAC palette ports (0x3C8/0x3C9), 0x3DA vsync polling, and INT 16h.
;
;   nasm -f bin xormunch.asm -o XORMUNCH.COM
;
; The pixel pattern is static; the colours flow because the palette is re-uploaded
; with a per-frame phase offset — the canonical "palette rotation" trick.

        org 0x100
        bits 16

start:
        mov     ax, 0x0013          ; set 320x200x256
        int     0x10
        push    0xA000
        pop     es                  ; ES -> VGA framebuffer

        ; ---- draw the static (x XOR y) field once ----
        xor     di, di
        xor     bx, bx              ; BX = y
.yloop:
        xor     cx, cx              ; CX = x
.xloop:
        mov     ax, cx
        xor     ax, bx              ; AL = (x ^ y)
        mov     [es:di], al
        inc     di
        inc     cx
        cmp     cx, 320
        jb      .xloop
        inc     bx
        cmp     bx, 200
        jb      .yloop

        ; ---- animation: rotate the palette every frame ----
        xor     bp, bp              ; BP = phase
.frame:
        ; wait for vertical retrace (poll 0x3DA bit 3)
        mov     dx, 0x03DA
.v1:    in      al, dx
        test    al, 8
        jnz     .v1                 ; wait until NOT in retrace
.v2:    in      al, dx
        test    al, 8
        jz      .v2                 ; wait until retrace begins

        ; upload 256 palette entries; colour = f(index + phase)
        mov     dx, 0x03C8
        xor     al, al
        out     dx, al              ; DAC write index = 0
        inc     dx                  ; DX = 0x3C9 (data)
        mov     cx, 256
        xor     si, si              ; SI = palette index
.pal:
        mov     ax, si
        add     ax, bp
        mov     bl, al              ; t = (index + phase) & 0xff
        and     al, 0x3f
        out     dx, al              ; R
        mov     al, bl
        shr     al, 1
        and     al, 0x3f
        out     dx, al              ; G
        mov     al, bl
        shr     al, 2
        and     al, 0x3f
        out     dx, al              ; B
        inc     si
        loop    .pal

        inc     bp                  ; advance phase

        ; exit on a keypress (ESC or anything)
        mov     ah, 0x01
        int     0x16
        jz      .frame
        mov     ah, 0x00
        int     0x16

        mov     ax, 0x0003          ; back to text mode
        int     0x10
        mov     ax, 0x4C00          ; terminate
        int     0x21
