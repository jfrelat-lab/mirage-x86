; pit40.asm — does PIT counter 0, as the BIOS leaves it, count by one or by two?
; An 8254 in mode 3 (square wave: the BIOS's 36h) counts down by TWO each clock, N to 0 for the high
; half of the period and again for the low half; in modes 0, 1, 2 and 4 it counts by one. So a
; program reading port 40h without programming the timer (256bytef and kaneda seed their randomness
; that way) reads even values only on a PC whose BIOS set mode 3.
;
; Three runs of 256 latched reads (43h <- 00h, then LSB and MSB from 40h), each printing how many
; came out even, then the first four values:
;   A  the counter as the BIOS left it, never programmed here
;   B  after 34h (mode 2, rate generator), reload 0 (65536): about half even
;   C  after 36h (mode 3, square wave), reload 0: all even on an 8254
; The timer is left as the BIOS had it (36h, reload 0, 18.2 Hz).
;
;   nasm -f bin tools/pit40.asm -o PIT40.COM               DOS: DOSBox-X, MIRAGE (stdout)
;   nasm -f bin -DBOOT tools/pit40.asm -o pit40.img        a boot floppy: QEMU and SeaBIOS
;                                                          (the screen, and COM1 for -serial file:)
;   DOSBox-X 2026.06 (fixed 20000):  A=256 B=122 C=256   its BIOS leaves mode 3, as IBM's (36h)
;   DOSBox-X 2026.06 (max):          A=256 B=067 C=256
;   QEMU / SeaBIOS (boot floppy):    A=126 B=130 C=256   SeaBIOS leaves counter 0 in mode 2; QEMU's
;                                                        8254 counts by two once mode 3 is set
;   MIRAGE (2026-11-06):             A=149 B=146 C=256   by one until the guest's first control word
%ifdef BOOT
        org 0x7c00
%else
        org 0x100
%endif
        bits 16
start:
%ifdef BOOT
        xor     ax, ax
        mov     ds, ax
        mov     es, ax
        mov     ss, ax
        mov     sp, 0x7c00
        sti
        mov     dx, 0x3f8 + 3           ; COM1: 9600 8N1, so QEMU's -serial file: gets the line too
        mov     al, 0x80
        out     dx, al
        mov     dx, 0x3f8
        mov     al, 12
        out     dx, al
        inc     dx
        xor     al, al
        out     dx, al
        mov     dx, 0x3f8 + 3
        mov     al, 3
        out     dx, al
%endif
        mov     al, 'A'
        call    run                     ; A: as the BIOS left it
        mov     al, 0x34                ; B: mode 2
        call    prog
        mov     al, 'B'
        call    run
        mov     al, 0x36                ; C: mode 3
        call    prog
        mov     al, 'C'
        call    run
        mov     al, 0x36                ; as the BIOS had it
        call    prog
        mov     si, s_crlf
        call    puts
%ifdef BOOT
.halt:  hlt
        jmp     .halt
%else
        mov     ax, 0x4c00
        int     0x21
%endif

; prog: control word AL for counter 0 (LSB then MSB), reload 0 = 65536.
prog:
        cli
        out     0x43, al
        xor     al, al
        out     0x40, al
        out     0x40, al
        sti
        ret

; run: AL = the run's letter. 256 latched reads; prints "X=nnn v0 v1 v2 v3 ".
run:
        call    putc
        mov     al, '='
        call    putc
        mov     di, vals
        xor     bx, bx                  ; even count
        mov     cx, 256
.read:  cli
        xor     al, al                  ; counter-latch command for counter 0
        out     0x43, al
        in      al, 0x40
        mov     ah, al
        in      al, 0x40
        sti
        xchg    al, ah                  ; AX = the count
        test    al, 1
        jnz     .odd
        inc     bx
.odd:   cmp     di, vals + 8
        jae     .next
        stosw
.next:  push    cx                      ; a little time between reads
        mov     cx, 37
.wait:  loop    .wait
        pop     cx
        loop    .read
        mov     ax, bx
        call    putdec
        mov     si, vals
        mov     cx, 4
.show:  mov     al, ' '
        call    putc
        lodsw
        call    puthex
        loop    .show
        mov     al, ' '
        call    putc
        mov     al, ' '
        jmp     putc

putdec:                                 ; AX, 0..999, three digits
        mov     bl, 100
        div     bl
        add     al, '0'
        call    putc
        mov     al, ah
        xor     ah, ah
        mov     bl, 10
        div     bl
        add     ax, '00'
        push    ax
        call    putc
        pop     ax
        mov     al, ah
        jmp     putc

puthex:                                 ; AX as four hex digits
        push    cx
        mov     cx, 4
.dig:   rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .out
        add     al, 7
.out:   call    putc
        pop     ax
        loop    .dig
        pop     cx
        ret

puts:   lodsb
        test    al, al
        jz      .done
        call    putc
        jmp     puts
.done:  ret

putc:                                   ; AL, preserving everything
        push    ax
        push    bx
        push    dx
%ifdef BOOT
        push    ax
        mov     ah, 0x0e
        xor     bx, bx
        int     0x10
        mov     dx, 0x3f8 + 5
.tx:    in      al, dx
        test    al, 0x20
        jz      .tx
        pop     ax
        mov     dx, 0x3f8
        out     dx, al
%else
        mov     dl, al
        mov     ah, 2
        int     0x21
%endif
        pop     dx
        pop     bx
        pop     ax
        ret

s_crlf: db 13, 10, 0
vals:   times 8 db 0
%ifdef BOOT
        times 510 - ($ - $$) db 0
        dw      0xaa55
%endif
