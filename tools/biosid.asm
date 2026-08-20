; biosid.asm — dump the BIOS ROM identification bytes a real machine carries, so ours can match the
; reference instead of being invented. F000:FFF5 is the 8-byte release date, F000:FFFE the model
; byte and F000:FFFF the submodel. Turbo Pascal scans this region and runs off the end of memory when
; it finds nothing.
;
;   nasm -f bin biosid.asm -o BIOSID.COM   ; writes BIOSID.BIN = 16 bytes from F000:FFF0

        org 100h
        bits 16
start:
        mov     ah, 3Ch
        xor     cx, cx
        mov     dx, fname
        int     21h
        mov     bx, ax

        push    ds
        mov     ax, 0F000h
        mov     ds, ax
        mov     dx, 0FFF0h
        mov     cx, 16
        mov     ah, 40h
        int     21h
        pop     ds

        mov     ah, 3Eh
        int     21h
        mov     ax, 4C00h
        int     21h

fname   db "BIOSID.BIN", 0
