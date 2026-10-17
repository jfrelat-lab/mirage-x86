; cirprobe.asm — the Cirrus Logic CL-GD5446's extensions as a program sees them, for comparing a
; real chip's BIOS (QEMU -device cirrus-vga,romfile=boot/roms/5446bv.vbi) with MIRAGE (MIRAGE_VGA=cirrus).
;
;   nasm -f bin tools/cirprobe.asm -o CIRPROBE.COM
;
; Line U — SR6 as found, after 12h is written (unlocked), after 00h, after 12h again; the index
;          ports read back (3C4h after 1Eh, 3CEh after 31h, 3D4h after 27h)
; Line I — CR27 (part ID), SR0F, SR15, SR17, SR1F as the BIOS left them
; Line D — the hidden DAC: its value as found (fifth read of 3C6h), then after A1h is written to it
;          (four reads, a write), read back the same way; the pixel mask then (one read after a 3C8h access)
; Line C — the cursor colours: SR12 bit 1 set, 11h 22h 33h written at 0Fh, then the palette's own
;          entry 0Fh (SR12 bit 1 clear) and the cursor's 0Fh read back (bit 1 set)
; Line B — banking in mode 13h with SR7 bit 0 set: 5Ah written at A000:0000 with GR9=10h (4 KiB
;          units); read at A000:1000 with GR9=0Fh, at A000:0000 with GRB=20h and GR9=04h (16 KiB),
;          at A000:8000 in dual-bank mode (GRB=01h, GR9=00h, GRA=10h)
        org 0x100
        bits 16
%macro SAVE 1
        mov [bp], %1
        inc bp
%endmacro
        cld
        mov bp, res
        mov ax, 0x0003
        int 0x10

        ; ---- U ----
        mov dx, 0x3c4
        mov al, 6
        out dx, al
        inc dx
        in al, dx
        SAVE al
        mov al, 0x12
        out dx, al
        in al, dx
        SAVE al
        mov al, 0x00
        out dx, al
        in al, dx
        SAVE al
        mov al, 0x12
        out dx, al
        in al, dx
        SAVE al
        mov dx, 0x3c4
        mov al, 0x1e
        out dx, al
        in al, dx
        SAVE al
        mov dx, 0x3ce
        mov al, 0x31
        out dx, al
        in al, dx
        SAVE al
        mov dx, 0x3d4
        mov al, 0x27
        out dx, al
        in al, dx
        SAVE al

        ; ---- I ----
        mov dx, 0x3d5
        in al, dx                       ; CR27, index still 27h
        SAVE al
        mov bl, 0x0f
        call rdsr
        mov bl, 0x15
        call rdsr
        mov bl, 0x17
        call rdsr
        mov bl, 0x1f
        call rdsr

        ; ---- D ----
        call dac4
        in al, dx                       ; the fifth read: the hidden register
        SAVE al
        call dac4
        mov al, 0xa1
        out dx, al
        call dac4
        in al, dx
        SAVE al
        mov dx, 0x3c8
        in al, dx                       ; any other DAC port resets the count
        mov dx, 0x3c6
        in al, dx
        SAVE al
        call dac4                       ; leave the hidden register at 0 again
        xor al, al
        out dx, al

        ; ---- C ----
        mov bl, 0x12
        call rdsr
        dec bp
        mov ah, al
        mov dx, 0x3c4
        mov al, 0x12
        out dx, al
        inc dx
        mov al, ah
        or al, 2
        out dx, al
        mov dx, 0x3c8
        mov al, 0x0f
        out dx, al
        inc dx
        mov al, 0x11
        out dx, al
        mov al, 0x22
        out dx, al
        mov al, 0x33
        out dx, al
        mov dx, 0x3c5
        mov al, ah
        and al, 0xfd
        out dx, al                      ; the palette again
        mov dx, 0x3c7
        mov al, 0x0f
        out dx, al
        mov dx, 0x3c9
        in al, dx
        SAVE al
        in al, dx
        SAVE al
        in al, dx
        SAVE al
        mov dx, 0x3c5
        mov al, ah
        or al, 2
        out dx, al                      ; the cursor's colours
        mov dx, 0x3c7
        mov al, 0x0f
        out dx, al
        mov dx, 0x3c9
        in al, dx
        SAVE al
        in al, dx
        SAVE al
        in al, dx
        SAVE al
        mov dx, 0x3c5
        mov al, ah
        out dx, al                      ; SR12 as it was

        ; ---- B ----
        mov ax, 0x0013
        int 0x10
        mov bl, 0x07
        call rdsr
        dec bp
        or al, 1
        mov ah, al
        mov al, 0x07
        mov dx, 0x3c4
        out dx, ax                      ; SR7 bit 0: the extended memory map
        mov ax, 0xa000
        mov es, ax
        mov ax, 0x000b                  ; GRB = 0: one bank, 4 KiB units
        call wrgr
        mov ax, 0x1009                  ; GR9 = 10h: 64 KiB in
        call wrgr
        mov byte [es:0], 0x5a
        mov ax, 0x0f09                  ; GR9 = 0Fh: the same byte at 1000h
        call wrgr
        mov al, [es:0x1000]
        SAVE al
        mov ax, 0x200b                  ; GRB = 20h: 16 KiB units
        call wrgr
        mov ax, 0x0409                  ; GR9 = 04h: 64 KiB in
        call wrgr
        mov al, [es:0]
        SAVE al
        mov ax, 0x010b                  ; GRB = 01h: two banks, 4 KiB units
        call wrgr
        mov ax, 0x0009
        call wrgr
        mov ax, 0x100a                  ; GRA = 10h: the upper half from 64 KiB
        call wrgr
        mov al, [es:0x8000]
        SAVE al
        mov ax, 0x000b
        call wrgr
        mov ax, 0x0009
        call wrgr
        mov ax, 0x000a
        call wrgr
        mov dx, 0x3c4
        mov al, 0x07
        out dx, al
        inc dx
        in al, dx
        and al, 0xfe
        out dx, al
        push ds
        pop es
        mov ax, 0x0003
        int 0x10

        ; ---- print ----
        mov si, res
        mov dx, tU
        call str
        mov cx, 7
        call bytes
        mov dx, tI
        call str
        mov cx, 5
        call bytes
        mov dx, tD
        call str
        mov cx, 3
        call bytes
        mov dx, tC
        call str
        mov cx, 6
        call bytes
        mov dx, tB
        call str
        mov cx, 3
        call bytes
        ret

rdsr:   mov dx, 0x3c4                   ; SR[BL] into AL, saved
        mov al, bl
        out dx, al
        inc dx
        in al, dx
        SAVE al
        ret
wrgr:   mov dx, 0x3ce                   ; GR[AL] = AH
        out dx, ax
        ret
dac4:   mov dx, 0x3c8                   ; reset the count, then four reads of 3C6h
        in al, dx
        mov dx, 0x3c6
        in al, dx
        in al, dx
        in al, dx
        in al, dx
        ret
bytes:  lodsb                           ; CX bytes from SI, then a new line
        call pb
        loop bytes
        mov dx, crlf
        jmp str
str:    mov ah, 9
        int 0x21
        ret
pb:     push ax
        shr al, 4
        call nib
        pop ax
        and al, 0x0f
        call nib
        mov dl, ' '
        mov ah, 2
        int 0x21
        ret
nib:    add al, '0'
        cmp al, '9'
        jbe .p
        add al, 7
.p:     mov dl, al
        mov ah, 2
        int 0x21
        ret

tU      db 'U $'
tI      db 'I $'
tD      db 'D $'
tC      db 'C $'
tB      db 'B $'
crlf    db 13, 10, '$'
res     times 32 db 0
