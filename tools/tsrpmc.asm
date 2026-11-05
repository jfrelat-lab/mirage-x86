; tsrpmc.asm — the child of tools/tsrpm.asm: enters protected mode through the DPMI host, then
; terminates and stays resident with INT 21h AX=3100h from there, as Borland's RTM does.
;
;   nasm -f bin tools/tsrpmc.asm -o TSRPMC.COM
        org     0x100
        bits    16
        mov     ah, 0x4a
        mov     bx, 0x100
        int     0x21
        mov     ax, 0x1687
        int     0x2f
        test    ax, ax
        jnz     .out
        mov     [entry], di
        mov     [entry + 2], es
        mov     bx, si
        mov     ah, 0x48
        int     0x21
        jc      .out
        mov     es, ax
        xor     ax, ax
        call    far [entry]
        jc      .out
        mov     ax, 0x3100              ; resident, from protected mode
        mov     dx, 0x40
        int     0x21
.out:   mov     ax, 0x4c01
        int     0x21
entry   dd      0
