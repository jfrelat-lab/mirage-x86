; grabber.asm — a tiny resident "frame grabber" for capturing ANY unmodified DOS
; mode-13h program's output under headless DOSBox. It hooks the timer IRQ (INT 8),
; chains to the original handler, and after KTICKS ticks dumps the VGA framebuffer
; (A000:0, 64000 bytes) to OUT.BIN and the DAC palette (768 bytes) to PAL.BIN, then
; halts (the harness' alarm then kills DOSBox). Install it BEFORE the program in the
; autoexec; the program runs untouched and gets snapshotted at frame KTICKS.
;
;   nasm -f bin -dKTICKS=24 grabber.asm -o GRABBER.COM
;
; Limitations: assumes the program leaves interrupts enabled, drives animation off the
; timer, and doesn't hook INT 8 itself or scribble over this resident block.

%ifndef KTICKS
%define KTICKS 24
%endif
        org 100h
        bits 16
start:
        mov     ax, 3508h            ; get current INT 8 vector -> ES:BX
        int     21h
        mov     [oldptr], bx
        mov     [oldptr + 2], es
        mov     ax, 2508h            ; install ours (DS:DX, DS = our segment)
        mov     dx, handler
        int     21h
        mov     dx, 100h             ; keep 4 KB resident (ample for this TSR)
        mov     ax, 3100h            ; terminate & stay resident
        int     21h

handler:
        pushf
        call    far [cs:oldptr]      ; chain to old INT 8 (EOI + INT 1Ch); it IRETs back
        dec     word [cs:counter]
        jnz     .ret
        call    dump
        cli
.hang:  hlt
        jmp     .hang
.ret:   iret

dump:
        push    cs
        pop     ds                   ; DS = our resident segment (for filenames/palbuf)
        mov     ah, 3Ch              ; create OUT.BIN
        xor     cx, cx
        mov     dx, fn_out
        int     21h
        mov     bx, ax
        push    ds                   ; write 64000 bytes from A000:0
        mov     ax, 0A000h
        mov     ds, ax
        xor     dx, dx
        mov     cx, 0FA00h
        mov     ah, 40h
        int     21h
        pop     ds
        mov     ah, 3Eh
        int     21h
        mov     dx, 3C7h             ; read 768 DAC bytes via ports
        xor     al, al
        out     dx, al
        mov     dx, 3C9h
        mov     di, palbuf
        mov     cx, 768
.rd:    in      al, dx
        mov     [di], al
        inc     di
        loop    .rd
        mov     ah, 3Ch              ; create PAL.BIN
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
        ret

counter dw KTICKS
oldptr  dd 0
fn_out  db "OUT.BIN", 0
fn_pal  db "PAL.BIN", 0
palbuf  times 768 db 0
theend:
