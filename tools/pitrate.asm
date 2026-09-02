; pitrate.asm — how many INT 8s per second does the host ACTUALLY deliver when a program asks for a
; fast timer? MIRAGE floors counter-0's reload at pitBase>>4 (~291 Hz) to avoid an interrupt storm;
; whether DOSBox does anything similar is the question this answers, by measuring both the same way.
;
; The clock is the 0x3DA vertical retrace, not the PIT — 70 Hz and independent of what counter 0 is
; programmed to, which is exactly what makes it usable as a reference here. Count INT 8s across 70
; retraces and the answer is interrupts per second.
;
;   nasm -f bin -dDIVIDER=68 tools/pitrate.asm -o PITRATE.COM     ; ~17554 Hz requested
;   nasm -f bin -dDIVIDER=4096 tools/pitrate.asm -o PITRATE.COM   ; ~291 Hz requested
;
; Writes eight hex digits (the count) to OUT.TXT, so it can be read back from either emulator.

%ifndef DIVIDER
%define DIVIDER 68
%endif

        org 0x100
        bits 16

        mov     ax, 0x3508              ; save the current INT 8 vector
        int     0x21
        mov     [oldoff], bx
        mov     [oldseg], es

        mov     ax, 0x2508              ; install ours (DS = CS in a .COM)
        mov     dx, isr
        int     0x21

        cli                             ; program counter 0
        mov     al, 0x34
        out     0x43, al
        mov     ax, DIVIDER
        out     0x40, al
        mov     al, ah
        out     0x40, al
        sti

        mov     cx, 70                  ; one second of beam time
        mov     dx, 0x03da
.frame:
.hi:    in      al, dx
        test    al, 8
        jnz     .hi                     ; wait until NOT in retrace
.lo:    in      al, dx
        test    al, 8
        jz      .lo                     ; wait for the retrace edge
        loop    .frame

        cli                             ; put counter 0 back to the default
        mov     al, 0x34
        out     0x43, al
        xor     al, al
        out     0x40, al
        out     0x40, al
        push    ds                      ; and restore the vector
        mov     ax, 0x2508
        lds     dx, [oldoff]
        int     0x21
        pop     ds
        sti

        ; ---- write the count as eight hex digits ----
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      done
        mov     bx, ax
        mov     si, buf
        mov     ax, [counter + 2]
        call    word4
        mov     ax, [counter]
        call    word4
        mov     ah, 0x40
        mov     cx, 10
        mov     dx, buf
        int     0x21
        mov     ah, 0x3e
        int     0x21
done:   mov     ax, 0x4c00
        int     0x21

word4:  push    cx                      ; AX -> four hex digits at [SI], SI advanced
        mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    mov     [si], al
        inc     si
        pop     ax
        loop    .d
        pop     cx
        ret

isr:                                    ; no chaining: the BIOS tick is not the clock here
        inc     word [cs:counter]
        jnz     .no
        inc     word [cs:counter + 2]
.no:    push    ax
        mov     al, 0x20
        out     0x20, al                ; EOI
        pop     ax
        iret

counter dd      0
oldoff  dw      0
oldseg  dw      0
fname   db      'OUT.TXT', 0
buf     db      '00000000', 13, 10
