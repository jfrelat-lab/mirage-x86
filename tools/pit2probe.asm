; pit2probe.asm — PIT channel 2 as programs see it through port 61h (GATE = bit 0, OUT = bit 5) and
; port 42h. Timing-free: it reports levels and whether a change happened, not how long it took.
;   A  mode 0, GATE low: OUT                       (8254: 0)
;   B  mode 0, GATE low: count unchanged after a loop (Y)
;   C  mode 0, GATE raised: OUT at once            (0)
;   D  mode 0: OUT reached 1 while polling         (Y)
;   E  mode 0: OUT still 1 afterwards              (1)
;   F  mode 3, GATE low: OUT                       (1)
;   G  mode 1, GATE low, before a trigger: OUT     (1)
;   H  mode 1, GATE raised (trigger): OUT at once  (0)
;   I  mode 1: OUT back to 1 while polling         (Y)
;
;   nasm -f bin tools/pit2probe.asm -o PIT2.COM
;
; Measured 2026-10-15 (the 8254 datasheet's answer first):
;   datasheet  0 Y 0 Y 1 1 1 0 Y
;   MIRAGE     0 Y 0 Y 1 1 1 0 Y
;   QEMU 11.1  0 N 0 Y 1 1 0 0 Y   (MS-DOS 6.22, -M isapc: counts with GATE low, mode 1 starts low)
;   DOSBox-X   1 Y 1 Y 1 1 1 0 Y   (cycles fixed 20000: mode 0's OUT high before the count runs out)
; D, E, F, H and I agree everywhere. Each other point has the datasheet and two of the three on one
; side; MIRAGE follows that side. A and C — mode 0's OUT low until terminal count — are what GRUB 2's
; TSC calibration needs, and QEMU, where GRUB's countdown runs, answers them so.
        org 0x100
        bits 16
        cli
        in al, 0x61
        and al, 0xfc            ; GATE low, speaker data off
        out 0x61, al
        mov al, 0xb0            ; ch2, LSB/MSB, mode 0
        out 0x43, al
        mov al, 0x00
        out 0x42, al
        mov al, 0x10            ; count 1000h
        out 0x42, al
        call out5               ; A
        call latch              ; B: count, loop, count again
        mov bx, ax
        mov cx, 0x4000
.l1:    loop .l1
        call latch
        cmp ax, bx
        mov al, 'Y'
        je .b
        mov al, 'N'
.b:     call putc
        in al, 0x61
        or al, 1                ; GATE high
        out 0x61, al
        call out5               ; C
        call poll1              ; D
        call out5               ; E
        in al, 0x61
        and al, 0xfc
        out 0x61, al
        mov al, 0xb6            ; ch2, LSB/MSB, mode 3
        out 0x43, al
        mov al, 0x00
        out 0x42, al
        mov al, 0x10
        out 0x42, al
        call out5               ; F
        mov al, 0xb2            ; ch2, LSB/MSB, mode 1
        out 0x43, al
        mov al, 0x00
        out 0x42, al
        mov al, 0x10
        out 0x42, al
        call out5               ; G
        in al, 0x61
        or al, 1                ; trigger
        out 0x61, al
        call out5               ; H
        call poll1              ; I
        in al, 0x61
        and al, 0xfc
        out 0x61, al
        sti
        mov ah, 9
        mov dx, crlf
        int 0x21
        ret

out5:   in al, 0x61             ; print OUT (bit 5) as 0/1 and a space
        shr al, 5
        and al, 1
        add al, '0'
        jmp putc
latch:  mov al, 0x80            ; latch ch2's count, read LSB then MSB into AX
        out 0x43, al
        in al, 0x42
        mov ah, al
        in al, 0x42
        xchg al, ah
        ret
poll1:  mov cx, 0xffff          ; Y if OUT rises within 64K polls (count 1000h = 3.4 ms)
.p:     in al, 0x61
        test al, 0x20
        jnz .y
        loop .p
        mov al, 'N'
        jmp putc
.y:     mov al, 'Y'
putc:   mov dl, al
        mov ah, 2
        int 0x21
        mov dl, ' '
        mov ah, 2
        int 0x21
        ret
crlf    db 13, 10, '$'
