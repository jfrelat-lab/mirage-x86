; beep.asm — the PC speaker at 440 Hz for about a second, then silence until it exits.
; A known signal for tools/record-audio.mjs: PIT channel 2 in mode 3 with reload 1193182/440 = 2712
; and the gate and data bits of port 61h set, then both cleared.
;
;   nasm -f bin tools/beep.asm -o BEEP.COM
        org 0x100
        bits 16
        mov     al, 0xb6                ; channel 2, LSB/MSB, mode 3
        out     0x43, al
        mov     ax, 2712
        out     0x42, al
        mov     al, ah
        out     0x42, al
        in      al, 0x61
        or      al, 3
        out     0x61, al
        mov     cx, 18                  ; ~1 s of BIOS ticks
        call    ticks
        in      al, 0x61
        and     al, 0xfc
        out     0x61, al
        mov     cx, 18                  ; ~1 s of silence
        call    ticks
        mov     ax, 0x4c00
        int     0x21

ticks:  xor     ax, ax                  ; wait CX timer ticks
        mov     es, ax
.t:     mov     bx, [es:0x46c]
.w:     cmp     bx, [es:0x46c]
        je      .w
        loop    .t
        ret
