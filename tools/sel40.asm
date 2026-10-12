; sel40.asm — does a DPMI host give its client selector 0040h, the BIOS data area? DOS/4GW 1.97
; (C-Dogs) loads it as it stands: under MIRAGE's host, whose GDT was empty, that was #GP(40h).
; As a 32-bit client: LAR and LSL of 0040h, then the BDA's equipment word read through it and
; through the flat real-mode view (they must agree). "LAR=xxxx LSL=xxxx EQ=xxxx RM=xxxx ZF=n".
; ZF=1 when LAR found the selector valid.
;
;   nasm -f bin tools/sel40.asm -o SEL40.COM      (run CWSDPMI first where there is no host)
        org     0x100
        bits    16
        mov     ah, 0x4a
        mov     bx, 0x1000
        int     0x21
        mov     [rseg], cs
        mov     ax, [0x2c]                      ; keep for later: nothing
        push    es
        xor     ax, ax
        mov     es, ax
        mov     ax, [es:0x410]                  ; the equipment word, from real mode
        pop     es
        mov     [rmeq], ax
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

        mov     word [eqw], 0xdead
        mov     ax, 0x40
        lar     cx, ax
        mov     byte [zf], '0'
        jnz     .nolar
        mov     byte [zf], '1'
        mov     [lar_], cx
        lsl     cx, ax
        mov     [lsl_], cx
        push    es
        mov     es, ax
        mov     ax, [es:0x10]
        mov     [eqw], ax
        pop     es
.nolar:
        mov     di, res + 4
        mov     ax, [lar_]
        call    hex16
        mov     di, res + 13
        mov     ax, [lsl_]
        call    hex16
        mov     di, res + 21
        mov     ax, [eqw]
        call    hex16
        mov     di, res + 29
        mov     ax, [rmeq]
        call    hex16
        mov     al, [zf]
        mov     [res + 37], al
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

fname   db      'SEL40.TXT', 0
res     db      'LAR=???? LSL=???? EQ=???? RM=???? ZF=?', 13, 10
reslen  equ     $ - res
zf      db      '?'
lar_    dw      0
lsl_    dw      0
eqw     dw      0
rmeq    dw      0
rseg    dw      0
handle  dw      0
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
