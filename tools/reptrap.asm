; reptrap.asm — how many single-step traps does a REP string instruction take with TF set?
; Installs an INT 1 handler that counts, sets TF, runs `rep stosb` with CX=5, clears TF, and prints
; the count and the CX each trap saw. The traps after `rep stosb` are the ones for the four
; instructions up to and including the POPF that clears TF.
;   DOSBox-X (normal and dynamic cores): TRAPS=06 CX=0 0 0 0 0 0   — the REP is one step
;   QEMU (MS-DOS 6.22):                  TRAPS=0B CX=4 3 2 1 0 0 0 0 0 0 0   — one per iteration, and
;                                        one more as it re-enters the REP with CX=0
; They agree that POPF's TF traps; MIRAGE printed TRAPS=00 until a POPF that sets TF ended its block.
;
;   nasm -f bin tools/reptrap.asm -o REPTRAP.COM
        org 0x100
        bits 16
        mov     ax, 0x2501              ; INT 1 -> trap
        mov     dx, trap
        int     0x21
        push    cs
        pop     es
        mov     di, buf
        mov     cx, 5
        xor     al, al
        cld
        pushf                           ; TF on
        pop     ax
        or      ax, 0x100
        push    ax
        xor     al, al
        popf
        rep     stosb                   ; first instruction after POPF: traced
        pushf                           ; TF off (this PUSHF is traced too)
        pop     ax
        and     ax, 0xfeff
        push    ax
        popf
        mov     al, [count]             ; print "TRAPS=nn CX=..."
        mov     dx, s_traps
        mov     ah, 9
        int     0x21
        mov     al, [count]
        call    hex8
        mov     dx, s_cx
        mov     ah, 9
        int     0x21
        xor     si, si
        movzx   bp, byte [count]
.p:     cmp     si, bp
        jae     .done
        mov     dl, [cxs + si]
        add     dl, '0'
        mov     ah, 2
        int     0x21
        mov     dl, ' '
        int     0x21
        inc     si
        cmp     si, 16
        jb      .p
.done:  mov     dx, crlf
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

trap:   push    bx
        movzx   bx, byte [cs:count]
        cmp     bx, 16
        jae     .t
        mov     [cs:cxs + bx], cl
.t:     inc     byte [cs:count]
        pop     bx
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
cxs     times 16 db 0
buf     times 8 db 0
s_traps db      'TRAPS=$'
s_cx    db      ' CX=$'
crlf    db      13, 10, '$'
