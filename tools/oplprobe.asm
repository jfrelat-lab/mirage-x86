; oplprobe.asm — what an OPL (AdLib) at 388h answers: its status register and its two timers.
; Everything a program can READ from the chip is its status byte (bit 7 IRQ, bit 6 timer 1 expired,
; bit 5 timer 2 expired; the low bits tell an OPL2 from an OPL3) and how long its timers take:
; timer 1 counts in 80 us steps, timer 2 in 320 us steps, from the preset value up to 256.
;
; Prints, in hex:
;   S0  status after the reset sequence (timers stopped, flags cleared)
;   S1  status once timer 1 has expired (preset 00h: 256 steps, 20.48 ms)
;   T1  how long that took, in PIT ticks (1.193 MHz): about 5F70h
;   S2  status once timer 2 has expired (preset 80h: 128 steps, 40.96 ms)
;   T2  how long, in PIT ticks: about BEE0h
;   S3  status after the flags are reset again
; e.g. "S0=00 S1=C0 T1=5F70 S2=A0 T2=BEE0 S3=00". PIT channel 0 runs in mode 2 for the measure
; (it counts down by one per tick) and is put back in mode 3 at the end.
;
;   nasm -f bin tools/oplprobe.asm -o OPLPROBE.COM
        org 0x100
        bits 16
        cli
        mov     al, 0x34                ; PIT ch0: mode 2, reload 0 (65536), same 18.2 Hz
        out     0x43, al
        xor     al, al
        out     0x40, al
        out     0x40, al
        sti

        mov     ah, 4                   ; reset: mask both timers, then reset the IRQ flag
        mov     al, 0x60
        call    opl
        mov     al, 0x80
        call    opl
        call    status
        mov     [s0], al

        mov     ah, 2                   ; timer 1 = 00h, start it (mask timer 2)
        xor     al, al
        call    opl
        mov     ah, 4
        mov     al, 0x21
        call    opl
        call    pit
        mov     [t0], ax
.w1:    call    status
        test    al, 0x40
        jz      .w1
        mov     [s1], al
        call    pit
        mov     bx, [t0]
        sub     bx, ax                  ; the PIT counts down
        mov     [t1], bx

        mov     ah, 4                   ; reset the flags; timer 2 = 80h, start it (mask timer 1)
        mov     al, 0x60
        call    opl
        mov     al, 0x80
        call    opl
        mov     ah, 3
        mov     al, 0x80
        call    opl
        mov     ah, 4
        mov     al, 0x42
        call    opl
        call    pit
        mov     [t0], ax
.w2:    call    status
        test    al, 0x20
        jz      .w2
        mov     [s2], al
        call    pit
        mov     bx, [t0]
        sub     bx, ax
        mov     [t2], bx

        mov     ah, 4
        mov     al, 0x60
        call    opl
        mov     al, 0x80
        call    opl
        call    status
        mov     [s3], al

        cli                             ; PIT ch0 back to mode 3
        mov     al, 0x36
        out     0x43, al
        xor     al, al
        out     0x40, al
        out     0x40, al
        sti

        mov     si, s_s0
        mov     al, [s0]
        call    pb
        mov     si, s_s1
        mov     al, [s1]
        call    pb
        mov     si, s_t1
        mov     ax, [t1]
        call    pw
        mov     si, s_s2
        mov     al, [s2]
        call    pb
        mov     si, s_t2
        mov     ax, [t2]
        call    pw
        mov     si, s_s3
        mov     al, [s3]
        call    pb
        mov     dx, crlf
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

opl:                                    ; register AH := AL, with the documented delays
        push    ax
        push    dx
        push    cx
        mov     dx, 0x388
        xchg    al, ah
        out     dx, al
        mov     cx, 6                   ; 3.3 us after the index
.d1:    in      al, dx
        loop    .d1
        inc     dx
        mov     al, ah
        out     dx, al
        dec     dx
        mov     cx, 35                  ; 23 us after the data
.d2:    in      al, dx
        loop    .d2
        pop     cx
        pop     dx
        pop     ax
        ret
status: push    dx
        mov     dx, 0x388
        in      al, dx
        pop     dx
        ret
pit:    cli                             ; latch and read PIT ch0 -> AX
        xor     al, al
        out     0x43, al
        in      al, 0x40
        mov     ah, al
        in      al, 0x40
        xchg    al, ah
        sti
        ret

pb:     push    ax                      ; print SI then AL in hex
        call    lab
        pop     ax
        jmp     hex8
pw:     push    ax                      ; print SI then AX in hex
        call    lab
        pop     ax
        push    ax
        mov     al, ah
        call    hex8
        pop     ax
        jmp     hex8
lab:    mov     dx, si
        mov     ah, 9
        int     0x21
        ret
hex8:   push    ax
        shr     al, 4
        call    .n
        pop     ax
        and     al, 15
.n:     add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     mov     dl, al
        mov     ah, 2
        int     0x21
        ret

s0      db      0
s1      db      0
s2      db      0
s3      db      0
t0      dw      0
t1      dw      0
t2      dw      0
s_s0    db      'S0=$'
s_s1    db      ' S1=$'
s_t1    db      ' T1=$'
s_s2    db      ' S2=$'
s_t2    db      ' T2=$'
s_s3    db      ' S3=$'
crlf    db      13, 10, '$'
