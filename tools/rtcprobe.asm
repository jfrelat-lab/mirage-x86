; rtcprobe.asm — can a REAL-MODE resident get CPU time while a DPMI client owns INT 8?
; IRQ0 is taken in protected mode by the client (mesha does exactly that), and a real-mode TSR can
; never see it. The RTC's periodic interrupt is a second, independent source on IRQ8 -> INT 70h, and
; DPMI hosts reflect a hardware interrupt the client has NOT hooked back down to real mode.
; Calls no DOS at all: at tick N it sets text mode 3 through the BIOS, which DOSBox prints in its log.
%ifndef NTICKS
%define NTICKS 1024                     ; at rate 6 (1024 Hz) that is one second
%endif
        org 0x100
        bits 16
        cli
        mov     ax, 0x3570              ; save INT 70h (IRQ8)
        int     0x21
        mov     [oldptr], bx
        mov     [oldptr + 2], es
        mov     ax, 0x2570
        mov     dx, handler
        int     0x21

        mov     al, 0x8a                ; CMOS reg 0Ah, NMI disabled: rate divider
        out     0x70, al
        in      al, 0x71
        and     al, 0xf0
        or      al, 6                   ; rate 6 = 32768 >> 5 = 1024 Hz
        push    ax
        mov     al, 0x8a
        out     0x70, al
        pop     ax
        out     0x71, al

        mov     al, 0x8b                ; CMOS reg 0Bh: set PIE (periodic interrupt enable)
        out     0x70, al
        in      al, 0x71
        or      al, 0x40
        push    ax
        mov     al, 0x8b
        out     0x70, al
        pop     ax
        out     0x71, al

        in      al, 0xa1                ; unmask IRQ8 on the slave
        and     al, 0xfe
        out     0xa1, al
        in      al, 0x21                ; and IRQ2 on the master (the cascade)
        and     al, 0xfb
        out     0x21, al
        sti

        mov     dx, 0x100
        mov     ax, 0x3100              ; TSR
        int     0x21

handler:
        push    ax
        push    dx
        mov     al, 0x0c                ; reg 0Ch: reading it clears the RTC interrupt flag
        out     0x70, al
        in      al, 0x71
        cmp     word [cs:count], 0
        je      .eoi
        dec     word [cs:count]
        jnz     .eoi
        ; Mode 12h (640x480x16), NOT mode 3: the signal has to be a mode the guest is not already in,
        ; or the BIOS call is a no-op and DOSBox logs nothing. Mode 3 made the probe look silent at
        ; small N purely because the screen was still text — a mute probe and a probe that never ran
        ; are indistinguishable. 12h logs 640x480, distinct from text's 720x400 and 13h's 640x400.
        mov     ax, 0x12
        int     0x10
.eoi:   mov     al, 0x20
        out     0xa0, al                ; EOI slave
        out     0x20, al                ; EOI master
        pop     dx
        pop     ax
        iret

count   dw NTICKS
oldptr  dd 0
