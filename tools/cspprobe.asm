; cspprobe.asm — what a Sound Blaster 16 answers to the ASP/CSP commands Windows 95's driver sends
; (03, 04 xx, 05 xx xx, 0E xx xx, 0F xx) and how mixer 80h/81h read back after a write.
; Prints one line of hex: each answer byte, or "--" when none came.
;
;   nasm -f bin tools/cspprobe.asm -o CSP.COM
; Measured 2026-10-14 (QEMU 11.1 -device sb16 under MS-DOS 6.22; DOSBox-X sbtype=sb16):
;   QEMU      AA 04 05 10 -- -- 00 00 00 -- 56 00 -- 04 05 02 22
;   DOSBox-X  AA 04 05 -- -- -- 00 00 00 -- 34 56 -- 04 05 02 22
        org 0x100
        bits 16
        mov dx, 0x226
        mov al, 1
        out dx, al
        mov cx, 200
.d:     in al, dx
        loop .d
        xor al, al
        out dx, al
        call rd                 ; AA
        mov al, 0xe1            ; version
        call wr
        call rd
        call rd
        mov al, 0x03            ; ASP: status?
        call wr
        call rd
        mov al, 0x04            ; set mode FC
        call wr
        mov al, 0xfc
        call wr
        call rd
        mov al, 0x04            ; set mode FA
        call wr
        mov al, 0xfa
        call wr
        call rd
        mov al, 0x0f            ; get register 83h, three times
        call wr
        mov al, 0x83
        call wr
        call rd
        mov al, 0x0f
        call wr
        mov al, 0x83
        call wr
        call rd
        mov al, 0x0f
        call wr
        mov al, 0x83
        call wr
        call rd
        mov al, 0x0e            ; set register: 0E <reg> <val>? write 0E 34 56
        call wr
        mov al, 0x34
        call wr
        mov al, 0x56
        call wr
        call rd
        mov al, 0x0f            ; read 34h and 56h back
        call wr
        mov al, 0x34
        call wr
        call rd
        mov al, 0x0f
        call wr
        mov al, 0x56
        call wr
        call rd
        mov al, 0x05            ; set codec parameter 05 12 34
        call wr
        mov al, 0x12
        call wr
        mov al, 0x34
        call wr
        call rd
        mov al, 0xe1            ; still in step? version again
        call wr
        call rd
        call rd
        mov dx, 0x224           ; mixer 80h: write 02, read back; 81h: write 22, read back
        mov al, 0x80
        out dx, al
        inc dx
        mov al, 0x02
        out dx, al
        in al, dx
        call hex
        dec dx
        mov al, 0x81
        out dx, al
        inc dx
        mov al, 0x22
        out dx, al
        in al, dx
        call hex
        mov dx, 0x224
        mov al, 0x80
        out dx, al
        inc dx
        mov al, 0x04
        out dx, al
        mov ah, 9
        mov dx, crlf
        int 0x21
        ret

wr:     push dx
        push ax
        mov dx, 0x22c
.w:     in al, dx
        test al, 0x80
        jnz .w
        pop ax
        out dx, al
        pop dx
        ret

rd:     push dx
        push cx
        mov dx, 0x22e
        mov cx, 0xffff
.r:     in al, dx
        test al, 0x80
        jnz .got
        loop .r
        mov ah, 9
        mov dx, none
        int 0x21
        pop cx
        pop dx
        ret
.got:   mov dx, 0x22a
        in al, dx
        call hex
        pop cx
        pop dx
        ret

hex:    push ax
        push dx
        push ax
        shr al, 4
        call nib
        pop ax
        and al, 0x0f
        call nib
        mov dl, ' '
        mov ah, 2
        int 0x21
        pop dx
        pop ax
        ret
nib:    add al, '0'
        cmp al, '9'
        jbe .p
        add al, 7
.p:     mov dl, al
        mov ah, 2
        int 0x21
        ret
none    db '-- $'
crlf    db 13, 10, '$'
