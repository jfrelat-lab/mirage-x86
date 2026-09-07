; sftprobe.asm — ask a REAL DOS where its List of Lists and System File Table are, and what an SFT
; entry looks like once a file is open. Built to settle by measurement what MIRAGE should place
; where: DJGPP's fstat() walks these structures, and picking their addresses by guess broke an intro
; that uses low memory as scratch.
;
;   nasm -f bin tools/sftprobe.asm -o SFTPROBE.COM
;   ...then run it under DOSBox-X / FreeDOS with its output redirected to a file.
        org 100h
start:
        mov     ax, 3d00h               ; open ourselves, so one SFT entry is a real file
        mov     dx, fname
        int     21h
        jc      .noopen
        mov     [fh], ax
.noopen:
        mov     ah, 52h                 ; get List of Lists -> ES:BX
        int     21h
        mov     [lolseg], es
        mov     [loloff], bx

        mov     si, m_lol
        call    puts
        mov     ax, [lolseg]
        call    hex16
        mov     al, ':'
        call    putc
        mov     ax, [loloff]
        call    hex16
        call    crlf

        mov     es, [lolseg]            ; LoL+04 = far pointer to the first SFT block
        mov     bx, [loloff]
        mov     ax, [es:bx+4]
        mov     [sftoff], ax
        mov     ax, [es:bx+6]
        mov     [sftseg], ax

        mov     si, m_sft
        call    puts
        mov     ax, [sftseg]
        call    hex16
        mov     al, ':'
        call    putc
        mov     ax, [sftoff]
        call    hex16
        call    crlf

        mov     si, m_psp               ; our own PSP, for scale
        call    puts
        mov     ah, 62h
        int     21h
        mov     ax, bx
        call    hex16
        call    crlf

        mov     si, m_jft               ; the PSP's job file table, 20 bytes
        call    puts
        mov     ah, 62h
        int     21h
        mov     es, bx
        mov     di, 18h
        mov     cx, 20
.jft:   mov     al, [es:di]
        call    hex8
        mov     al, ' '
        call    putc
        inc     di
        loop    .jft
        call    crlf

        mov     si, m_blk               ; the SFT block header: next pointer, then the entry count
        call    puts
        mov     es, [sftseg]
        mov     bx, [sftoff]
        mov     cx, 6
        mov     di, bx
.hdr:   mov     al, [es:di]
        call    hex8
        mov     al, ' '
        call    putc
        inc     di
        loop    .hdr
        call    crlf

        mov     si, m_ent               ; and 0x3B bytes of the entry our open file landed in
        call    puts
        mov     es, [sftseg]
        mov     di, [sftoff]
        add     di, 6
        mov     ax, [fh]
        cmp     ax, 0
        je      .e0
        push    ax                      ; entry index = JFT[handle]
        mov     ah, 62h
        int     21h
        mov     ds, bx
        pop     ax
        mov     bx, ax
        mov     al, [bx+18h]
        push    cs
        pop     ds
        mov     ah, 0
        mov     bx, 3bh
        mul     bx
        add     di, ax
.e0:
        mov     cx, 3bh
.ent:   mov     al, [es:di]
        call    hex8
        mov     al, ' '
        call    putc
        inc     di
        loop    .ent
        call    crlf

        mov     ax, 4c00h
        int     21h

puts:   lodsb
        or      al, al
        jz      .done
        call    putc
        jmp     puts
.done:  ret
; Every character goes to stdout AND to COM1, so the same probe works under DOSBox (redirect the
; file) and under QEMU booting a real FreeDOS (-serial file:...), where there is no host filesystem
; to read a redirect back from. The LSR poll is bounded: a machine with no UART must not hang it.
putc:   push    ax
        push    cx
        push    dx
        push    ax
        mov     dl, al
        mov     ah, 02h
        int     21h
        pop     ax
        push    ax
        mov     cx, 4000
        mov     dx, 3fdh
.wait:  in      al, dx
        test    al, 20h
        jnz     .send
        loop    .wait
.send:  pop     ax
        mov     dx, 3f8h
        out     dx, al
        pop     dx
        pop     cx
        pop     ax
        ret
crlf:   mov     al, 13
        call    putc
        mov     al, 10
        call    putc
        ret
hex8:   push    ax
        shr     al, 4
        call    nib
        pop     ax
        push    ax
        and     al, 0fh
        call    nib
        pop     ax
        ret
hex16:  push    ax
        mov     al, ah
        call    hex8
        pop     ax
        call    hex8
        ret
nib:    and     al, 0fh
        add     al, '0'
        cmp     al, '9'
        jbe     .p
        add     al, 7
.p:     jmp     putc

fname   db      'SFTPROBE.COM', 0
fh      dw      0
lolseg  dw      0
loloff  dw      0
sftseg  dw      0
sftoff  dw      0
m_lol   db      'LOL  ', 0
m_sft   db      'SFT  ', 0
m_psp   db      'PSP  ', 0
m_jft   db      'JFT  ', 0
m_blk   db      'BLK  ', 0
m_ent   db      'ENT  ', 0
