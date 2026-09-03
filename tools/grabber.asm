; grabber.asm — a tiny resident "frame grabber" for capturing ANY unmodified DOS
; mode-13h program's output under headless DOSBox. It hooks the timer IRQ (INT 8),
; chains to the original handler, and after KTICKS ticks dumps the VGA framebuffer
; (A000:0, 64000 bytes) to OUT.BIN and the DAC palette (768 bytes) to PAL.BIN, then
; halts (the harness' alarm then kills DOSBox). Install it BEFORE the program in the
; autoexec; the program runs untouched and gets snapshotted at frame KTICKS.
;
;   nasm -f bin -dKTICKS=24 grabber.asm -o GRABBER.COM
;
; It dumps through INT 21h from inside the timer ISR, so it must not fire while the interrupted
; program is itself inside DOS — DOS is not reentrant, and a create/write issued on top of another
; DOS call corrupts the state both share and produces no file. That is what the InDOS flag is for
; (INT 21h AH=34h returns its address), and every resident program that calls DOS from an interrupt
; is required to test it. Without the test this grabber captured nothing at all for any program that
; ends up waiting inside a DOS call — with no error, because the failure is silent by construction.
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
        mov     ax, 3400h            ; DOS InDOS flag -> ES:BX; the ISR must not call DOS unless it is 0
        int     21h
        mov     [indosptr], bx
        mov     [indosptr + 2], es
        mov     ax, 2508h            ; install ours (DS:DX, DS = our segment)
        mov     dx, handler
        int     21h
        mov     dx, 100h             ; keep 4 KB resident (ample for this TSR)
        mov     ax, 3100h            ; terminate & stay resident
        int     21h

handler:
        pushf
        call    far [cs:oldptr]      ; chain to old INT 8 (EOI + INT 1Ch); it IRETs back
        cmp     word [cs:counter], 0
        je      .ret                 ; already dumped
        dec     word [cs:counter]
        jnz     .ret
        ; The tick budget has run out, but DOS may be busy. Re-arm for one more tick and try again
        ; on the next one, as often as it takes: the snapshot is then the first frame at or after
        ; KTICKS at which DOS is callable, which is the best a DOS-writing grabber can do.
        push    ds
        push    bx
        lds     bx, [cs:indosptr]
        cmp     byte [bx], 0
        pop     bx
        pop     ds
        je      .go
        mov     word [cs:counter], 1 ; DOS busy — look again next tick
        jmp     .ret
.go:    mov     word [cs:counter], 0
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
indosptr dd 0
fn_out  db "OUT.BIN", 0
fn_pal  db "PAL.BIN", 0
palbuf  times 768 db 0
theend:
