; fontdump.asm — graphical font extraction from the reference (DOSBox-X), NOT from its source.
; In each graphics mode the BIOS renders INT 10h text with that mode's ROM font, so we draw all
; 256 glyphs and dump the framebuffer; the host (tools/build-fonts.mjs) reverse-engineers the
; bitmaps from the rendered pixels. Modes: 13h (320x200 linear) -> 8x8, 10h (640x350) -> 8x14,
; 12h (640x480) -> 8x16. Planar modes: read-map is set to plane 0 and glyphs are drawn in colour
; 15 (all planes), so plane 0 alone captures the glyph shape. Output files written to C:.
;   nasm -f bin -o FONTDUMP.COM tools/fontdump.asm
        cpu 8086
        org 100h
start:
        mov si, cfgs
.cfg:
        lodsb                   ; mode (0 = end)
        or al, al
        jz .done
        xor ah, ah
        int 10h                 ; set video mode
        lodsb
        mov [height], al
        lodsw
        mov [fbseg], ax
        lodsw
        mov [fbsize], ax
        lodsw
        mov [fname], ax
        ; draw the 256 glyphs in a 16x16 grid (cursor cell = one char, sized to the mode's font)
        xor cx, cx
.draw:
        mov al, cl
        mov dl, al
        and dl, 0Fh             ; DL = column (char & 15)
        shr al, 1
        shr al, 1
        shr al, 1
        shr al, 1
        mov dh, al              ; DH = row (char >> 4)
        push cx
        mov bh, 0
        mov ah, 02h
        int 10h                 ; set cursor position
        pop cx
        push cx
        mov al, cl
        mov bh, 0
        mov bl, 0Fh             ; colour 15
        mov cx, 1
        mov ah, 09h
        int 10h                 ; write char (draws the glyph in graphics modes)
        pop cx
        inc cx
        cmp cx, 256
        jb .draw
        ; read map select = plane 0 (Graphics Controller reg 4); harmless in linear mode 13h
        mov dx, 3CEh
        mov al, 4
        out dx, al
        inc dx
        xor al, al
        out dx, al
        ; write the framebuffer to a file
        mov dx, [fname]
        xor cx, cx
        mov ah, 3Ch
        int 21h                 ; create -> AX = handle
        mov bx, ax
        mov cx, [fbsize]
        push ds
        mov ax, [fbseg]
        mov ds, ax
        xor dx, dx              ; DS:DX = framebuffer:0
        mov ah, 40h
        int 21h                 ; write CX bytes
        pop ds
        mov ah, 3Eh
        int 21h                 ; close
        jmp .cfg
.done:
        mov ax, 0003h
        int 10h                 ; back to text
        mov ax, 4C00h
        int 21h

height  db 0
fbseg   dw 0
fbsize  dw 0
fname   dw 0
fn13    db 'FONT13.BIN',0
fn10    db 'FONT10.BIN',0
fn12    db 'FONT12.BIN',0
cfgs:
        db 13h, 8
        dw 0A000h, 64000
        dw fn13
        db 10h, 14
        dw 0A000h, 28000
        dw fn10
        db 12h, 16
        dw 0A000h, 38400
        dw fn12
        db 0
