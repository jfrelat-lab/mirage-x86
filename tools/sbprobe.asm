; sbprobe.asm — does a Sound Blaster consume its DMA at the rate it was given, and say so with IRQ 7?
; Resets the DSP at 220h, reads its version, sets time constant A6h (1e6 / (256 - 166) = 11111 Hz),
; programs DMA 1 for 11111 bytes (one second), starts an 8-bit single-cycle transfer (14h), and
; counts BIOS ticks (18.2 a second) until the card's IRQ 7 arrives. Half way (9 ticks) it reads the
; channel's current count. Prints e.g. "DSP=0405 TICKS=12 HALF=1680 ACK=1" (hex): TICKS about 12h
; (18) and HALF about half of 2B66h if the card plays in real time; TICKS=FF if no IRQ came in 5 s.
;
;   nasm -f bin tools/sbprobe.asm -o SBPROBE.COM
        org 0x100
        bits 16
        mov     ax, 0x350f              ; save INT 0Fh (IRQ 7)
        int     0x21
        mov     [old], bx
        mov     [old + 2], es
        mov     ax, 0x250f
        mov     dx, irq7
        int     0x21
        in      al, 0x21                ; unmask IRQ 7
        and     al, 0x7f
        out     0x21, al

        mov     dx, 0x226               ; DSP reset
        mov     al, 1
        out     dx, al
        mov     cx, 100
.d:     in      al, dx
        loop    .d
        xor     al, al
        out     dx, al
        call    rd                      ; AAh
        mov     al, 0xe1                ; version
        call    wr
        call    rd
        mov     [ver], al
        call    rd
        mov     [ver + 1], al
        mov     al, 0xd1                ; speaker on
        call    wr
        mov     al, 0x40                ; time constant
        call    wr
        mov     al, 0xa6
        call    wr

        cli                             ; DMA 1: 11111 bytes from 1000:0000, single, read
        mov     al, 0x05
        out     0x0a, al
        out     0x0c, al
        mov     al, 0x49
        out     0x0b, al
        xor     al, al
        out     0x02, al
        out     0x02, al
        mov     al, 0x01
        out     0x83, al
        mov     ax, 11110
        out     0x03, al
        mov     al, ah
        out     0x03, al
        mov     al, 0x01
        out     0x0a, al
        sti

        mov     al, 0x14                ; 8-bit single-cycle, length - 1
        call    wr
        mov     al, 11110 & 0xff
        call    wr
        mov     al, 11110 >> 8
        call    wr

        xor     ax, ax                  ; count ticks until the IRQ, reading the count at tick 9
        mov     es, ax
        mov     bx, [es:0x46c]
.w:     mov     ax, [es:0x46c]
        sub     ax, bx
        cmp     byte [got], 0
        jne     .done
        cmp     ax, 9
        jne     .nh
        cmp     word [half], 0
        jne     .nh
        out     0x0c, al
        in      al, 0x03
        mov     ah, al
        in      al, 0x03
        xchg    al, ah
        mov     [half], ax
        mov     ax, 9
.nh:    cmp     ax, 91                  ; five seconds
        jb      .w
        mov     ax, 0xff
.done:  mov     [ticks], al

        push    ds
        lds     dx, [old]
        mov     ax, 0x250f
        int     0x21
        pop     ds
        mov     dx, s1
        call    str
        mov     al, [ver]
        call    hex8
        mov     al, [ver + 1]
        call    hex8
        mov     dx, s2
        call    str
        mov     al, [ticks]
        call    hex8
        mov     dx, s3
        call    str
        mov     al, [half + 1]
        call    hex8
        mov     al, [half]
        call    hex8
        mov     dx, s4
        call    str
        mov     al, [ack]
        add     al, '0'
        mov     dl, al
        mov     ah, 2
        int     0x21
        mov     dx, crlf
        call    str
        mov     ax, 0x4c00
        int     0x21

irq7:   push    ax
        push    dx
        mov     dx, 0x22e               ; acknowledge the 8-bit IRQ
        in      al, dx
        mov     byte [cs:got], 1
        mov     byte [cs:ack], 1
        mov     al, 0x20
        out     0x20, al
        pop     dx
        pop     ax
        iret

wr:     push    ax                      ; DSP write, after bit 7 of 22Ch clears
        mov     dx, 0x22c
.w:     in      al, dx
        test    al, 0x80
        jnz     .w
        pop     ax
        out     dx, al
        ret
rd:     mov     dx, 0x22e               ; DSP read, after bit 7 of 22Eh sets
.w:     in      al, dx
        test    al, 0x80
        jz      .w
        mov     dx, 0x22a
        in      al, dx
        ret
str:    mov     ah, 9
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

old     dd      0
ver     dw      0
ticks   db      0
half    dw      0
got     db      0
ack     db      0
s1      db      'DSP=$'
s2      db      ' TICKS=$'
s3      db      ' HALF=$'
s4      db      ' ACK=$'
crlf    db      13, 10, '$'
