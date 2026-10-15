; vbecur.asm — VBE's view of the standard VGA modes: in text mode 03h, 4F03h (current mode) and 4F01h
; (ModeInfoBlock) for the mode it gives and for mode 13h. GRUB 2 asks 4F03h, then 4F01h on the answer,
; and stops with "can't get mode info" when it is refused. Prints, in hex:
;   4F03: AX BX | 4F01(that mode): AX attributes memory-model width height bpp | 4F01(13h): same
;
;   nasm -f bin tools/vbecur.asm -o VBECUR.COM
;
; Measured 2026-10-15:
;   QEMU 11.1  004F 0003 004F 002F 0000 0050 0019 0004 004F 00BB 0004 0140 00C8 0008
;   DOSBox-X   004F 0003 014F 0000 0000 0000 0000 0000 014F 0000 0000 0000 0000 0000   (svga_s3)
;   MIRAGE     004F 0003 014F ...   (4F03h was BX=0000)
; Both answer 4F03h with the standard mode 0003h. 4F01h for a standard mode: SeaVGABIOS describes it,
; DOSBox-X refuses it; MIRAGE refuses it until the two agree.
        org 0x100
        bits 16
        mov ax, 0x0003
        int 0x10
        mov ax, 0x4f03
        int 0x10
        push bx
        call hex4               ; AX
        pop ax
        push ax
        call hex4               ; BX
        pop cx
        call info
        mov cx, 0x13
        call info
        mov ah, 9
        mov dx, crlf
        int 0x21
        ret
info:   mov di, buf             ; 4F01h for CX into buf: AX, then attributes, model, width, height, bpp
        mov cx, cx
        push cx
        mov cx, 128
        xor ax, ax
        rep stosw
        pop cx
        mov ax, 0x4f01
        mov di, buf
        int 0x10
        call hex4
        mov ax, [buf]
        call hex4
        mov al, [buf + 27]
        xor ah, ah
        call hex4
        mov ax, [buf + 18]
        call hex4
        mov ax, [buf + 20]
        call hex4
        mov al, [buf + 25]
        xor ah, ah
        call hex4
        ret
hex4:   push ax                 ; AX as four hex digits and a space
        mov cl, 12
.n:     mov dx, [esp]
        shr dx, cl
        and dl, 0x0f
        add dl, '0'
        cmp dl, '9'
        jbe .p
        add dl, 7
.p:     mov ah, 2
        int 0x21
        sub cl, 4
        jns .n
        mov dl, ' '
        mov ah, 2
        int 0x21
        pop ax
        ret
crlf    db 13, 10, '$'
buf     times 256 db 0
