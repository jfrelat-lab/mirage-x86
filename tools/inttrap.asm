; inttrap.asm — where do single-step traps land around an INT n executed with TF set?
; Installs an INT 1 handler that records the IP each trap returns to, hooks INT 60h with a
; two-instruction handler, sets TF with POPF and runs: nop / int 60h / nop / mov ah,30h /
; int 21h / nop, then clears TF and prints the trap count and the low byte of each trapped IP.
; INT n clears TF on its way into the handler, so the handler runs untraced and neither the INT
; nor the handler's IRET is followed by a trap; the next trap comes after the instruction that
; follows the INT. Second Reality's start-up depends on it: its loader is a five-thread scheduler
; driven by INT 1 that also executes `int 1` itself with TF set.
;   DOSBox-X (normal and dynamic cores): TRAPS=09 IP=18 1B 1D 20 21 22 25 26 27
;   MIRAGE printed TRAPS=0B IP=18 6D 1B 1D 1F 20 ...: a trap into INT 60h's handler (6D) and one
;   after the INT 21h, because the single-step path trapped after every instruction.
;
;   nasm -f bin tools/inttrap.asm -o INTTRAP.COM
        org 0x100
        bits 16
        mov     ax, 0x2501              ; INT 1 -> trap
        mov     dx, trap
        int     0x21
        mov     ax, 0x2560              ; INT 60h -> svc
        mov     dx, svc
        int     0x21
        pushf                           ; TF on
        pop     ax
        or      ax, 0x100
        push    ax
        popf
        nop                             ; traced
        int     0x60                    ; not followed by a trap
        nop                             ; traced
        mov     ah, 0x30                ; traced
        int     0x21                    ; not followed by a trap
        nop                             ; traced
        pushf                           ; TF off (these are traced too)
        pop     ax
        and     ax, 0xfeff
        push    ax
        popf
        mov     al, [count]             ; print "TRAPS=nn IP=..."
        mov     dx, s_traps
        mov     ah, 9
        int     0x21
        mov     al, [count]
        call    hex8
        mov     dx, s_ip
        mov     ah, 9
        int     0x21
        xor     si, si
        movzx   bp, byte [count]
        cmp     bp, 16
        jbe     .p
        mov     bp, 16
.p:     cmp     si, bp
        jae     .done
        mov     al, [ips + si]
        call    hex8
        mov     dl, ' '
        mov     ah, 2
        int     0x21
        inc     si
        jmp     .p
.done:  mov     dx, crlf
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

svc:    inc     byte [cs:hits]
        iret

trap:   push    bp
        mov     bp, sp
        push    bx
        movzx   bx, byte [cs:count]
        cmp     bx, 16
        jae     .t
        push    ax
        mov     al, [bp + 2]            ; low byte of the trapped IP
        mov     [cs:ips + bx], al
        pop     ax
.t:     inc     byte [cs:count]
        pop     bx
        pop     bp
        iret

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

count   db      0
hits    db      0
ips     times 16 db 0
s_traps db      'TRAPS=$'
s_ip    db      ' IP=$'
crlf    db      13, 10, '$'
