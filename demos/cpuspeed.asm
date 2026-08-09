; cpuspeed.asm — how much work does this machine execute per second of WALL-CLOCK time?
;
; Built to settle a question no documentation could: MIRAGE's browser loop used to cap the guest at
; 8 M cycles/s, and the claim that "DOSBox runs these titles at full speed" needed checking rather
; than asserting. Comparing MIRAGE's `cpu.cycles` counter against DOSBox's `cycles=` setting would
; compare two things that are only loosely the same unit, so this measures neither: it runs a fixed
; block of work and counts how much of it fits between BIOS timer ticks. Same program, same units,
; any emulator or real machine.
;
;   result = units of 10000 inner iterations completed in ~3.02 s (55 ticks at 18.2065 Hz)
;
; Written to C:\SPEED.TXT (so a headless DOSBox run on a mounted host dir leaves it behind) and
; printed (so it can be read off the screen in a browser).
;
;   nasm -f bin demos/cpuspeed.asm -o demos/CPUSPEED.COM

        org     0x100
        bits    16
        cpu     386

_start:
        call    tick
        mov     bx, ax
.sync:  call    tick                    ; start on a fresh tick boundary, so the window is a whole
        cmp     ax, bx                  ; number of ticks and not a random fraction of one
        je      .sync
        mov     bx, ax
        add     bx, 55                  ; ~3.02 s at 18.2065 Hz

        xor     esi, esi                ; 32-bit: a fast host overflows 16 bits in 3 s
.outer:
        mov     cx, 10000
.inner: dec     cx
        jnz     .inner
        inc     esi
        call    tick
        cmp     ax, bx
        jb      .outer

        mov     eax, esi
        mov     di, numbuf
        call    u32str
        mov     byte [di], 13
        mov     byte [di + 1], 10
        add     di, 2
        mov     word [di], '$'          ; '$' terminator for the print, not written to the file

        mov     ah, 0x09                ; print
        mov     dx, msg
        int     0x21
        mov     ah, 0x09
        mov     dx, numbuf
        int     0x21

        mov     ah, 0x3c                ; create
        xor     cx, cx                  ; normal attributes
        mov     dx, fname
        int     0x21
        jc      .done
        mov     bx, ax
        mov     cx, di                  ; length = everything up to the '$'
        sub     cx, numbuf
        mov     ah, 0x40                ; write
        mov     dx, numbuf
        int     0x21
        mov     ah, 0x3e                ; close
        int     0x21
.done:
        mov     ax, 0x4c00
        int     0x21

; BIOS tick count, low word (INT 1Ah AH=00 -> CX:DX). Clobbers CX/DX, which the caller never needs.
tick:
        xor     ah, ah
        int     0x1a
        mov     ax, dx
        ret

; EAX -> decimal ASCII at [DI]; DI left just past the last digit.
u32str:
        mov     ecx, 10
        xor     bp, bp
.div:   xor     edx, edx
        div     ecx
        add     dl, '0'
        push    dx
        inc     bp
        test    eax, eax
        jnz     .div
.emit:  pop     dx
        mov     [di], dl
        inc     di
        dec     bp
        jnz     .emit
        ret

msg:    db      'work units in 3.02s: $'
fname:  db      'C:\SPEED.TXT', 0
numbuf: times 16 db 0
