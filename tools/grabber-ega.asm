; grabber-ega.asm — the EGA/VGA 16-colour counterpart of grabber.asm.
;
; In a planar mode the picture is NOT at A000 as a linear byte per pixel: it is four bit-planes that
; the CPU sees one at a time through the Graphics Controller's read-map-select. So dump each plane in
; turn, and with it the state needed to lay them out again: the CRTC offset (bytes per scanline) and
; start address, and the 16 attribute-controller entries that turn a 4-bit index into a DAC index.
;
;   nasm -f bin -dKTICKS=24 grabber-ega.asm -o GREGA.COM
;
; Writes EGA.BIN (4 x 8000 bytes, plane 0 first), PAL.BIN (768 DAC bytes) and INFO.BIN
; (mode, offset, startHi, startLo, then 16 attribute entries).

%ifndef KTICKS
%define KTICKS 24
%endif
%define PLANELEN 8000

        org 100h
        bits 16
start:
        mov     ax, 3508h
        int     21h
        mov     [oldptr], bx
        mov     [oldptr + 2], es
        mov     ax, 2508h
        mov     dx, handler
        int     21h
        mov     dx, 100h
        mov     ax, 3100h
        int     21h

handler:
        pushf
        call    far [cs:oldptr]
        dec     word [cs:counter]
        jnz     .ret
        call    dump
        cli
.hang:  hlt
        jmp     .hang
.ret:   iret

dump:
        push    cs
        pop     ds

        ; ---- the four planes -------------------------------------------------
        mov     ah, 3Ch
        xor     cx, cx
        mov     dx, fn_ega
        int     21h
        mov     [handle], ax
        xor     bp, bp                      ; BP = plane number
.plane:
        mov     dx, 3CEh                    ; GC index 4 = read map select
        mov     al, 4
        out     dx, al
        inc     dx
        mov     ax, bp
        out     dx, al
        mov     dx, 3CEh                    ; GC index 5 = mode; clear bit 3 so reads are plain
        mov     al, 5
        out     dx, al
        inc     dx
        xor     al, al
        out     dx, al
        push    ds
        mov     ax, 0A000h
        mov     ds, ax
        xor     dx, dx
        mov     cx, PLANELEN
        mov     bx, [cs:handle]
        mov     ah, 40h
        int     21h
        pop     ds
        inc     bp
        cmp     bp, 4
        jb      .plane
        mov     bx, [handle]
        mov     ah, 3Eh
        int     21h

        ; ---- DAC -------------------------------------------------------------
        mov     dx, 3C7h
        xor     al, al
        out     dx, al
        mov     dx, 3C9h
        mov     di, palbuf
        mov     cx, 768
.rd:    in      al, dx
        mov     [di], al
        inc     di
        loop    .rd
        mov     ah, 3Ch
        xor     cx, cx
        mov     dx, fn_pal
        int     21h
        mov     bx, ax
        mov     ah, 40h
        mov     cx, 768
        mov     dx, palbuf
        int     21h
        mov     ah, 3Eh
        int     21h

        ; ---- mode, CRTC offset/start, attribute palette ----------------------
        push    ds
        xor     ax, ax
        mov     ds, ax
        mov     al, [0449h]                 ; BIOS video mode
        pop     ds
        mov     [info], al

        mov     dx, 3D4h                    ; CRTC 13h = offset (words per scanline)
        mov     al, 13h
        out     dx, al
        inc     dx
        in      al, dx
        mov     [info + 1], al
        mov     dx, 3D4h                    ; CRTC 0Ch/0Dh = start address
        mov     al, 0Ch
        out     dx, al
        inc     dx
        in      al, dx
        mov     [info + 2], al
        mov     dx, 3D4h
        mov     al, 0Dh
        out     dx, al
        inc     dx
        in      al, dx
        mov     [info + 3], al

        mov     dx, 3DAh                    ; reset the attribute flip-flop to INDEX
        in      al, dx
        xor     bp, bp
.attr:
        mov     dx, 3C0h
        mov     ax, bp                      ; index without bit 5: palette RAM is readable
        out     dx, al
        mov     dx, 3C1h
        in      al, dx
        mov     bx, bp
        mov     [info + 4 + bx], al
        mov     dx, 3DAh                    ; each read/write pair needs the flip-flop back at INDEX
        in      al, dx
        inc     bp
        cmp     bp, 16
        jb      .attr
        mov     dx, 3C0h                    ; bit 5 back on, or the screen stays blanked
        mov     al, 20h
        out     dx, al

        mov     ah, 3Ch
        xor     cx, cx
        mov     dx, fn_inf
        int     21h
        mov     bx, ax
        mov     ah, 40h
        mov     cx, 20
        mov     dx, info
        int     21h
        mov     ah, 3Eh
        int     21h
        ret

counter dw KTICKS
oldptr  dd 0
handle  dw 0
fn_ega  db "EGA.BIN", 0
fn_pal  db "PAL.BIN", 0
fn_inf  db "INFO.BIN", 0
info    times 20 db 0
palbuf  times 768 db 0
theend:
