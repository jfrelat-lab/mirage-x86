; shd16.asm — 16-bit SHLD and SHRD with a count of 17 to 31, which Intel leaves undefined and real
; processors do not: kaneda (golden) builds its palette with `shrd ax,cx,18` and `shld si,cx,17`.
; For each count c from 16 to 31 prints "c:LLLL RRRR", the results of shld 1234h,ABCDh,c and shrd
; 1234h,ABCDh,c (destination 1234h, source ABCDh, count in CL).
;
;   nasm -f bin tools/shd16.asm -o SHD16.COM               DOS: DOSBox-X, MIRAGE (stdout)
;   nasm -f bin -DBOOT tools/shd16.asm -o shd16.img        a boot floppy: QEMU (screen and COM1)
;
; Counts 17..31 (shld / shrd):
;   DOSBox-X 2026.06, normal and dynamic cores:  11:579B D5E6  12:AF36 6AF3  18:CDAB CDAB  1F:D5E6 579B
;     the source rotated by count-16 -- a Pentium's dst:src:src (Bochs, cpu/shift16.cc)
;   QEMU (TCG):                                  11:579A 55E6  12:AF34 2AF3  18:CD12 34AB  1F:891A 2469
;     dst:src:dst, a P6's and later (Bochs; QEMU calls it Intel's behaviour)
;   MIRAGE before 2026-11-07: 1234 1234 for every count past 16 (the destination left alone).
;   MIRAGE now: the 386, 486 and 586 profiles answer as DOSBox-X, the 686 and later as QEMU.
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
        mov     dx, 0x3f8 + 3           ; COM1: 9600 8N1
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
        mov     cl, 16
.next:  mov     al, cl                  ; "c:"
        xor     ah, ah
        call    puthex2
        mov     al, ':'
        call    putc
        mov     ax, 0x1234
        mov     bx, 0xabcd
        shld    ax, bx, cl
        call    puthex
        mov     al, ' '
        call    putc
        mov     ax, 0x1234
        mov     bx, 0xabcd
        shrd    ax, bx, cl
        call    puthex
        mov     al, 13
        call    putc
        mov     al, 10
        call    putc
        inc     cl
        cmp     cl, 32
        jb      .next
%ifdef BOOT
.halt:  hlt
        jmp     .halt
%else
        mov     ax, 0x4c00
        int     0x21
%endif

puthex2:                                ; AL as two hex digits: the byte moved to AH's place
        push    cx
        mov     ah, al
        mov     cx, 2
        jmp     puthex.dig
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
%ifdef BOOT
        times 510 - ($ - $$) db 0
        dw      0xaa55
%endif
