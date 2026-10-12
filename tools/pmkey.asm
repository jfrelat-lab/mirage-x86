; pmkey.asm — INT 16h AH=00 from a 32-bit DPMI client, with no key typed yet, reached as DOS/4GW
; reaches it: a far call, with a 32-bit IRET frame, to the vector 0204h reports. The service waits,
; and must still be waiting — at the same instruction, in the same mode — when the key comes. MIRAGE's
; BIOS stubs retried a waiting service by reloading CS=F000, which in protected mode is #GP(F000):
; DSETUP32 (C-Dogs' sound setup, under DOS/4GW) sat on its first menu for ever. "KEY=xxxx" to
; PMKEY.TXT, the scan code and character of the key.
;
;   nasm -f bin tools/pmkey.asm -o PMKEY.COM
        org     0x100
        bits    16
        mov     ah, 0x4a
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
        mov     ax, 1
        call    far [entry]
        jc      near quit

        mov     ax, 0x204
        mov     bl, 0x16
        int     0x31
        mov     [vec], edx
        mov     [vec + 4], cx
        xor     ah, ah
        pushfd
        o32 call far [vec]
        mov     di, res + 4
        call    hex16
        push    ds
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

hex16:  mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     mov     [di], al
        inc     di
        pop     ax
        loop    .d
        ret

fname   db      'PMKEY.TXT', 0
res     db      'KEY=????', 13, 10
reslen  equ     $ - res
rseg    dw      0
handle  dw      0
entry   dd      0
vec     dd      0
        dw      0
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
