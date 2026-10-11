; mbr.asm — a master boot record, written for MIRAGE (MIT): find the active partition, load its first
; sector to 0:7C00h and run it, with DL = the BIOS drive and DS:SI = its partition entry, as every
; MBR does. LBA through the INT 13h extensions when the BIOS has them, CHS from the table otherwise.
; tools/mkfreedos.mjs puts the partition table at 1BEh.
;
;   nasm -f bin tools/mbr.asm -o mbr.bin       (446 bytes of code, the table, 55AAh)
        org     0x600
        bits    16
start:  cli
        xor     ax, ax
        mov     ss, ax
        mov     sp, 0x7c00
        mov     ds, ax
        mov     es, ax
        sti
        cld
        mov     si, 0x7c00              ; out of the way of the boot sector we load
        mov     di, 0x600
        mov     cx, 256
        rep     movsw
        jmp     0:go
go:     mov     [drive], dl
        mov     si, table
        mov     cx, 4
.find:  test    byte [si], 0x80
        jnz     found
        add     si, 16
        loop    .find
        mov     si, m_none
        jmp     fail

found:  mov     ah, 0x41                ; INT 13h extensions?
        mov     bx, 0x55aa
        mov     dl, [drive]
        int     0x13
        jc      chs
        cmp     bx, 0xaa55
        jne     chs
        test    cl, 1
        jz      chs
        mov     ax, [si + 8]            ; the partition's first LBA
        mov     [dap + 8], ax
        mov     ax, [si + 10]
        mov     [dap + 10], ax
        push    si
        mov     si, dap
        mov     ah, 0x42
        mov     dl, [drive]
        int     0x13
        pop     si
        jnc     check
chs:    mov     dh, [si + 1]            ; head, then cylinder and sector as INT 13h wants them
        mov     cx, [si + 2]
        mov     bx, 0x7c00
        mov     ax, 0x0201
        mov     dl, [drive]
        int     0x13
        jnc     check
        mov     si, m_read
        jmp     fail
check:  cmp     word [0x7dfe], 0xaa55
        je      .run
        mov     si, m_sys
        jmp     fail
.run:   mov     dl, [drive]
        jmp     0:0x7c00

fail:   lodsb                           ; print the message, then stop
        test    al, al
        jz      .halt
        mov     ah, 0x0e
        mov     bx, 7
        int     0x10
        jmp     fail
.halt:  hlt
        jmp     .halt

drive   db      0
dap     db      0x10, 0
        dw      1, 0x7c00, 0
        dd      0, 0
m_none  db      'No active partition', 0
m_read  db      'Disk read error', 0
m_sys   db      'No operating system', 0

        times   0x1be - ($ - $$) db 0
table   times   64 db 0
        dw      0xaa55
