; dcc.asm — what a program learns about the MACHINE, as opposed to about DOS.
;
; Maniac Mansion calls INT 10h AX=1A00 ("get display combination code") after its DOS prefix and
; BEFORE its first allocation, so what comes back is a candidate for deciding its buffer sizes. Only
; AL carries the answer (1Ah = the call exists); BL is the active display, BH the inactive one.
; This also reads INT 11h (the equipment word) and INT 12h (conventional KiB), the other two things
; a program can ask about the hardware without touching a port.
;
;   nasm -f bin tools/dcc.asm -o DCC.COM
;
; Measured 2026-08-22:
;
;                    dosbox-x     MIRAGE (before)   MIRAGE (after)
;   1A00-AX            001A           1A1A              001A
;   1A00-BX            0008           0008              0008
;   INT11-EQUIP        4467           0021              0027
;   INT12-KIB          0280           0280              0280
;
; AX=1A1A came from preserving the caller's AH, which is necessarily 1Ah — an answer no BIOS gives.
; The equipment word still differs on purpose: dosbox-x claims two floppies, two serial ports and one
; parallel port, and this machine fits none of them. Bits 1 and 2 (coprocessor, pointing device) are
; now set because both are true here.
;
; ⚠️ Neither fix moved Maniac Mansion's divergence, and it never calls INT 11h at all.
;
        org 0x100
start:  mov     ax, 0x1a00
        int     0x10
        mov     [sav_ax], ax
        mov     [sav_bx], bx
        mov     si, m1
        call    puts
        mov     ax, [sav_ax]
        call    puthex
        call    crlf
        mov     si, m2
        call    puts
        mov     ax, [sav_bx]
        call    puthex
        call    crlf
        mov     si, m3                  ; and INT 11h, the equipment word
        call    puts
        int     0x11
        call    puthex
        call    crlf
        mov     si, m4                  ; and INT 12h, conventional memory in KiB
        call    puts
        int     0x12
        call    puthex
        call    crlf
        mov     ax, 0x4c00
        int     0x21
puts:   lodsb
        or      al, al
        jz      .d
        call    putc
        jmp     puts
.d:     ret
putc:   push    ax
        push    dx
        mov     dl, al
        mov     ah, 2
        int     0x21
        pop     dx
        pop     ax
        ret
crlf:   mov     al, 13
        call    putc
        mov     al, 10
        jmp     putc
puthex: push    cx
        mov     cx, 4
.n:     rol     ax, 4
        push    ax
        and     al, 0x0f
        add     al, '0'
        cmp     al, '9'
        jbe     .k
        add     al, 7
.k:     call    putc
        pop     ax
        loop    .n
        pop     cx
        ret
m1: db '1A00-AX=', 0
m2: db '1A00-BX=', 0
m3: db 'INT11-EQUIP=', 0
m4: db 'INT12-KIB=', 0
sav_ax: dw 0
sav_bx: dw 0
