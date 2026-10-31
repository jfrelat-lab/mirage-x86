; dpmiphys.asm — DPMI 0.9's AX=0800h, Physical Address Mapping: what a VBE program asks its host
; to reach the card's linear framebuffer. Maps 64 KiB at physical 16 MiB (where a PCI card's
; aperture sits, MIRAGE's among them) and checks it can write and read back through a selector on
; the linear address it is given; then asks for physical A0000h, below 1 MiB, which the function is
; not for. Prints "HI=<CF> RW=<1 if the dword read back> LO=<CF> AX=<the error code>".
; 32-bit client; the code segment stays 16-bit, as DPMI gives it. Heaven Seven (Exceed, 2000) maps
; its framebuffer so, and stopped on "VESA error" when MIRAGE's host answered 8001h.
; The write is at 8 MiB, in RAM on every machine it is run on (DOSBox-X's 16 MiB has nothing at 16).
;
; Measured under DOSBox-X with CWSDPMI -p, 2026-10-31:   HI=0 RW=1 LO=0 AX=????
;
;   nasm -f bin tools/dpmiphys.asm -o DPMIPHYS.COM      (run CWSDPMI first where there is no host)
        org 0x100
        bits 16
        mov     ah, 0x4a                ; shrink to 64 KiB
        mov     bx, 0x1000
        int     0x21
        mov     [rseg], cs
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      near quit
        mov     [handle], ax
        mov     ax, 0x1687
        int     0x2f
        test    ax, ax
        jnz     near quit
        mov     [entry], di
        mov     [entry + 2], es
        mov     bx, si
        mov     ah, 0x48
        int     0x21
        jc      near quit
        mov     es, ax
        mov     ax, 1                   ; 32-bit client
        call    far [entry]
        jc      near quit

        mov     ax, 0x0800              ; 64 KiB at physical 0080:0000
        mov     bx, 0x0080
        xor     cx, cx
        mov     si, 1
        xor     di, di
        int     0x31
        mov     byte [res + 3], '0'
        jnc     .hiok
        mov     byte [res + 3], '1'
        jmp     .lo
.hiok:  push    bx                      ; BX:CX, the linear address
        push    cx
        xor     ax, ax                  ; a descriptor for it
        mov     cx, 1
        int     0x31
        jc      .lo
        mov     [sel], ax
        mov     bx, ax
        pop     dx
        pop     cx
        mov     ax, 0x0007              ; base = the linear address
        int     0x31
        mov     ax, 0x0008              ; limit 64 KiB - 1
        mov     bx, [sel]
        xor     cx, cx
        mov     dx, 0xffff
        int     0x31
        mov     es, [sel]
        mov     dword [es:0x100], 0x12345678
        mov     byte [res + 8], '0'
        cmp     dword [es:0x100], 0x12345678
        jne     .lo
        mov     byte [res + 8], '1'
.lo:    mov     ax, 0x0800              ; physical A0000h: below 1 MiB
        mov     bx, 0x000a
        xor     cx, cx
        xor     si, si
        mov     di, 0x1000
        int     0x31
        mov     byte [res + 13], '0'
        jnc     .out
        mov     byte [res + 13], '1'
        push    ax
        mov     al, ah
        call    hex8
        mov     [res + 18], ax
        pop     ax
        call    hex8
        mov     [res + 20], ax

.out:   push    ds                      ; write the line: AH=40h through AX=0300h
        pop     es
        mov     word [rm_eax], 0x4000
        mov     ax, [handle]
        mov     [rm_ebx], ax
        mov     word [rm_ecx], reslen
        mov     word [rm_edx], res
        mov     ax, [rseg]
        mov     [rm_ds], ax
        mov     ax, 0x300
        mov     bx, 0x21
        xor     cx, cx
        mov     edi, rmcs
        int     0x31
quit:   mov     ax, 0x4c00
        int     0x21

hex8:   mov     ah, al                  ; AL -> two ASCII hex digits in AX (low byte first)
        shr     al, 4
        call    .n
        xchg    al, ah
        and     al, 15
        call    .n
        xchg    al, ah
        ret
.n:     add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     ret

fname   db      'DPMIPHYS.TXT', 0
res     db      'HI=? RW=? LO=? AX=????', 13, 10
reslen  equ     $ - res
rseg    dw      0
handle  dw      0
sel     dw      0
entry   dd      0
rmcs:
rm_edi  dd      0
rm_esi  dd      0
rm_ebp  dd      0
        dd      0
rm_ebx  dd      0
rm_edx  dd      0
rm_ecx  dd      0
rm_eax  dd      0
rm_flg  dw      0
rm_es   dw      0
rm_ds   dw      0
rm_fs   dw      0
rm_gs   dw      0
rm_ip   dw      0
rm_cs   dw      0
rm_sp   dw      0
rm_ss   dw      0
