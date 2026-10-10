; dmaprobe.asm — what the 8237 DMA controller reads back once a channel is programmed and nothing
; drives it. A Sound Blaster player tells how far the card has played by reading the channel's current
; count: Void 3 fills its buffer up to `0FFFh - count` and, with no 8237 here (every port FFh), never
; got there. Programs channel 1 (address 1234h, count 0FFFh, page 05h) and channel 3 (address 4321h,
; count 07FFh, page 0Ah), masked, then reads each address and count back through the flip-flop, the
; page registers, the mask register and the status register.
; Prints e.g. "A1=1234 C1=0FFF P1=05 A3=4321 C3=07FF P3=0A MASK=xx ST=xx".
;
;   nasm -f bin tools/dmaprobe.asm -o DMAPROBE.COM
        org 0x100
        bits 16
        cli
        mov     al, 0x05                ; mask channel 1
        out     0x0a, al
        mov     al, 0x07                ; mask channel 3
        out     0x0a, al
        mov     al, 0x59                ; ch1: single, autoinit, read (memory -> device)
        out     0x0b, al
        mov     al, 0x5b                ; ch3: same
        out     0x0b, al
        out     0x0c, al                ; clear the flip-flop
        mov     al, 0x34                ; ch1 address 1234h
        out     0x02, al
        mov     al, 0x12
        out     0x02, al
        mov     al, 0xff                ; ch1 count 0FFFh
        out     0x03, al
        mov     al, 0x0f
        out     0x03, al
        mov     al, 0x05                ; ch1 page
        out     0x83, al
        out     0x0c, al
        mov     al, 0x21                ; ch3 address 4321h
        out     0x06, al
        mov     al, 0x43
        out     0x06, al
        mov     al, 0xff                ; ch3 count 07FFh
        out     0x07, al
        mov     al, 0x07
        out     0x07, al
        mov     al, 0x0a                ; ch3 page
        out     0x82, al
        sti

        mov     si, s_a1
        mov     dx, 0x02
        call    word16
        mov     si, s_c1
        mov     dx, 0x03
        call    word16
        mov     si, s_p1
        mov     dx, 0x83
        call    byte8
        mov     si, s_a3
        mov     dx, 0x06
        call    word16
        mov     si, s_c3
        mov     dx, 0x07
        call    word16
        mov     si, s_p3
        mov     dx, 0x82
        call    byte8
        mov     si, s_mask
        mov     dx, 0x0f
        call    byte8
        mov     si, s_st
        mov     dx, 0x08
        call    byte8
        mov     dx, crlf
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

word16:                                 ; print SI, then the 16-bit register at DX (low, high)
        call    label
        out     0x0c, al                ; clear the flip-flop
        in      al, dx
        mov     bl, al
        in      al, dx
        call    hex8
        mov     al, bl
        jmp     hex8
byte8:  call    label
        in      al, dx
        jmp     hex8
label:  push    dx
        mov     dx, si
        mov     ah, 9
        int     0x21
        pop     dx
        ret
hex8:   push    dx
        push    ax
        shr     al, 4
        call    .n
        pop     ax
        and     al, 15
        call    .n
        pop     dx
        ret
.n:     add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     push    ax
        mov     dl, al
        mov     ah, 2
        int     0x21
        pop     ax
        ret

s_a1    db      'A1=$'
s_c1    db      ' C1=$'
s_p1    db      ' P1=$'
s_a3    db      ' A3=$'
s_c3    db      ' C3=$'
s_p3    db      ' P3=$'
s_mask  db      ' MASK=$'
s_st    db      ' ST=$'
crlf    db      13, 10, '$'
