; palettedump.asm — graphical palette extraction from the reference (DOSBox-X), not from source.
; Sets mode 13h (the BIOS loads the default VGA DAC), reads all 256 DAC entries back through the
; DAC ports (0x3C7 read-index, 0x3C9 R/G/B, 6-bit each) and writes them to DAC.BIN on C:. The host
; (tools/build-palettes.mjs) turns that into assets/vga-default-dac.bin.
;   nasm -f bin -o PALDUMP.COM tools/palettedump.asm
        cpu 8086
        org 100h
start:
        mov ax, 0013h
        int 10h                 ; set mode 13h -> BIOS loads the default 256-colour DAC
        ; read the DAC: set read index 0, then read 256*3 bytes from 0x3C9
        mov dx, 3C7h
        xor al, al
        out dx, al              ; DAC read index = 0
        mov dx, 3C9h
        mov di, buf
        mov cx, 768
.rd:
        in al, dx
        mov [di], al
        inc di
        loop .rd
        ; write DAC.BIN
        mov dx, fname
        xor cx, cx
        mov ah, 3Ch
        int 21h                 ; create -> handle in AX
        mov bx, ax
        mov dx, buf
        mov cx, 768
        mov ah, 40h
        int 21h                 ; write 768 bytes
        mov ah, 3Eh
        int 21h                 ; close
        mov ax, 0003h
        int 10h
        mov ax, 4C00h
        int 21h
fname   db 'DAC.BIN', 0
buf:                            ; 768-byte scratch (uninitialised tail of the .COM's 64K segment)
