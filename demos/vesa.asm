; vesa.asm — exercises the VESA VBE path end to end from real mode, the way a period program does:
; read the VbeInfoBlock, WALK the advertised mode list looking for a geometry (not a mode number),
; read each candidate's ModeInfoBlock, set the one that matches, then draw through the A000 window
; with VBE 4F05 bank switching. 640x480x8 needs five banks, so the bank register is genuinely
; exercised rather than left at zero.
;
;   nasm -f bin demos/vesa.asm -o demos/VESA.COM
;
; Draws a full-screen gradient: colour = (x/4 + y/4) & 0xFF over the 256-entry DAC.

        org 0x100
        bits 16

WANT_W  equ 640
WANT_H  equ 480
WANT_BPP equ 8

start:
        ; ---- 4F00: VbeInfoBlock into ES:DI ----
        push    cs
        pop     es
        mov     di, infoblk
        mov     ax, 0x4f00
        int     0x10
        cmp     ax, 0x004f
        jne     fail

        ; The mode list is a far pointer at offset 14 of the block.
        mov     si, [es:di + 14]
        mov     bp, [es:di + 16]        ; segment of the list

        ; ---- walk the list, 4F01 each entry, match on geometry ----
scan:
        push    es
        mov     es, bp
        mov     cx, [es:si]
        pop     es
        add     si, 2
        cmp     cx, 0xffff
        je      fail                    ; end of list, nothing matched
        push    si
        mov     di, modeblk
        mov     ax, 0x4f01
        int     0x10                    ; ES:DI = ModeInfoBlock for mode CX
        pop     si
        cmp     ax, 0x004f
        jne     scan
        mov     di, modeblk
        cmp     word [es:di + 18], WANT_W
        jne     scan
        cmp     word [es:di + 20], WANT_H
        jne     scan
        cmp     byte [es:di + 25], WANT_BPP
        jne     scan

        ; ---- 4F02: set it (windowed — no LFB bit, so A000 + 4F05 is the access path) ----
        mov     [found], cx
        mov     bx, cx
        mov     ax, 0x4f02
        int     0x10
        cmp     ax, 0x004f
        jne     fail

        ; ---- draw ----
        mov     ax, 0xa000
        mov     es, ax
        xor     bp, bp                  ; bp = current bank
        call    setbank
        xor     di, di                  ; di = offset in the window
        xor     dx, dx                  ; dx = y
rowloop:
        xor     bx, bx                  ; bx = x
colloop:
        mov     al, bl
        shr     al, 2
        mov     ah, dl
        shr     ah, 2
        add     al, ah                  ; colour = (x>>2 + y>>2) & 0xFF
        stosb                           ; ES:DI, DI advances and WRAPS at 0xFFFF
        test    di, di                  ; STOSB leaves the flags alone, so test DI explicitly
        jnz     nowrap                  ; DI wrapped to 0 -> next 64 KiB bank
        inc     bp
        call    setbank
nowrap:
        inc     bx
        cmp     bx, WANT_W
        jb      colloop
        inc     dx
        cmp     dx, WANT_H
        jb      rowloop

        ; Leave the picture up for a while, then restore text mode and exit, so a fixed-tick harness
        ; samples the drawn frame rather than the screen we exit to.
        mov     cx, 0x0040
hold:   push    cx
        xor     cx, cx
spin:   loop    spin
        pop     cx
        loop    hold

        mov     ax, 0x0003
        int     0x10
        mov     ax, 0x4c00
        int     0x21

setbank:
        push    ax
        push    bx
        push    dx
        mov     ax, 0x4f05
        xor     bx, bx                  ; BH=0 set window, BL=0 window A
        mov     dx, bp
        int     0x10
        pop     dx
        pop     bx
        pop     ax
        ret

fail:
        mov     ax, 0x0003
        int     0x10
        mov     dx, msg
        mov     ah, 0x09
        int     0x21
        mov     ax, 0x4c01
        int     0x21

msg     db      'no VBE mode', 13, 10, '$'
found   dw      0
infoblk times 512 db 0
modeblk times 256 db 0
