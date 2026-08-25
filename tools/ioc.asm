; ioc.asm — the prefix Maniac Mansion runs before it allocates, asked of DOS directly.
;
; AH=44h AL=00h returns a handle's DEVICE INFORMATION WORD in DX. It is not just a device bit:
; bit 0 stdin, bit 1 stdout, bit 2 NUL, bit 3 CLOCK, bit 4 special (the INT 29h fast console),
; bit 6 not-at-EOF, bit 7 device-not-file. MANIAC asks it for handles 4,3,2,1,0 in that order, then
; AH=19h for the current drive; AH=30h (the DOS version) is its very first call of all.
;
;   nasm -f bin tools/ioc.asm -o IOC.COM
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "IOC.COM > OUT.TXT" -c "exit"
;
; Measured 2026-08-22, dosbox-x:
;
;   DEVINFO h0000=80D3   h0001=0002   h0002=80D3   h0003=80D3   h0004=80D3
;   CURDRIVE=0002        DOSVER=0005
;
; h0001 reads 0002 only because the run redirects stdout to a file — bit 7 clear, and the low bits
; are the drive it lives on. Everything else is a character device at 0x80D3. We answered a bare
; 0x0080 for devices and 0 for files: a device that was neither stdin nor stdout and sat at EOF.
;
; ⚠️ Fixing it did NOT move Maniac Mansion's divergence (still int21 #20). The call now matches the
; oracle, which is worth having on its own; the cause of that divergence is elsewhere.
;
        org 0x100
start:  mov     cx, 5
        xor     bx, bx                  ; handles 0..4
.loop:  push    cx
        push    bx
        mov     si, m_h
        call    puts
        mov     ax, bx
        call    puthex
        mov     al, '='
        call    putc
        mov     ax, 0x4400
        int     0x21
        jc      .fail
        mov     ax, dx
        call    puthex
        jmp     .next
.fail:  mov     si, m_cf
        call    puts
.next:  call    crlf
        pop     bx
        pop     cx
        inc     bx
        loop    .loop
        mov     si, m_drv
        call    puts
        mov     ah, 0x19
        int     0x21
        mov     ah, 0
        call    puthex
        call    crlf
        mov     si, m_ver
        call    puts
        mov     ah, 0x30
        int     0x21
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
m_h:   db 'DEVINFO h', 0
m_cf:  db 'CF', 0
m_drv: db 'CURDRIVE=', 0
m_ver: db 'DOSVER=', 0
