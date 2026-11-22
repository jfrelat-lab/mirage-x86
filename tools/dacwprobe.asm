; dacwprobe.asm — a 16-bit OUT to the VGA DAC's ports, as a real card sees it. The card is an 8-bit
; device: a word written to port P reaches it as two bytes, AL to P and AH to P+1. So `out dx, ax` with
; DX = 3C8h sets the write index (AL) and gives its first component (AH) to 3C9h; with DX = 3C7h it sets
; the read index and AH goes to 3C8h -- the write index. Compared between a real chip's BIOS (QEMU
; -device cirrus-vga,romfile=boot/roms/5446bv.vbi), DOSBox-X and MIRAGE.
;
;   nasm -f bin tools/dacwprobe.asm -o DACW.COM
;
; Line W — entry 05h after `out 3C8h, ax` with AX=2A05h, then 15h and 3Fh to 3C9h: its red, green, blue
; Line X — entry 06h after `out 3C8h, ax` with AX=1106h, `out 3C9h, ax` with AX=2233h (33h to 3C9h; 22h to
;          3CAh, the feature control, written only through 3DAh/3BAh: ignored), then 3Ch to 3C9h
; Line R — the write index after `out 3C7h, ax` with AX=0907h (07h the read index, 09h to 3C8h): entry 09h
;          then written with 01h 02h 03h, and entry 09h read back
        org 0x100
        bits 16
        mov dx, 0x3c8
        mov ax, 0x2a05
        out dx, ax
        mov dx, 0x3c9
        mov al, 0x15
        out dx, al
        mov al, 0x3f
        out dx, al
        mov si, lineW
        mov bl, 5
        call entry
        mov dx, 0x3c8
        mov ax, 0x1106
        out dx, ax
        mov dx, 0x3c9
        mov ax, 0x2233
        out dx, ax
        mov al, 0x3c
        out dx, al
        mov si, lineX
        mov bl, 6
        call entry
        mov dx, 0x3c7
        mov ax, 0x0907
        out dx, ax
        mov dx, 0x3c9
        mov al, 1
        out dx, al
        inc al
        out dx, al
        inc al
        out dx, al
        mov si, lineR
        mov bl, 9
        call entry
        mov ax, 0x4c00
        int 0x21
; Read entry BL's three components and print the line at SI with them, in hex.
entry:  mov dx, 0x3c7
        mov al, bl
        out dx, al
        mov dx, 0x3c9
        mov di, si
        add di, 3
        mov cx, 3
.c:     in al, dx
        call hex2
        add di, 3
        loop .c
        mov dx, si
        mov ah, 9
        int 0x21
        ret
; AL as two hex digits at [DI]
hex2:   push ax
        mov ah, al
        shr al, 4
        call nib
        mov [di], al
        mov al, ah
        and al, 15
        call nib
        mov [di + 1], al
        pop ax
        ret
nib:    add al, '0'
        cmp al, '9'
        jbe .d
        add al, 7
.d:     ret
lineW:  db 'W: .. .. ..', 13, 10, '$'
lineX:  db 'X: .. .. ..', 13, 10, '$'
lineR:  db 'R: .. .. ..', 13, 10, '$'
