; romprobe.asm — what the upper memory area C000-FFFF IS, block by 2 KiB block, on COM1.
;
;   nasm -f bin tools/romprobe.asm -o /tmp/romprobe.img       QEMU / MIRAGE boot sector (pad for MIRAGE)
;   nasm -f bin -DCOM tools/romprobe.asm -o ROMPROBE.COM      DOSBox-X (serial1=file ...)
;
; One line per block: segment, then W (the first byte took a write — it is written, read back and
; restored) or r (it did not), then F (all 2048 bytes FFh: an empty bus), 0 (all zero) or * (mixed),
; then S when the block starts with an option-ROM signature 55 AA. EMM386 builds its upper memory
; blocks from what it finds here: MIRAGE left E000-EFFF plain writable RAM, EMM386 found 42 KB of
; UMB at E100h where it finds 6 KB under QEMU, and DOOM's extender crashed on the difference.
bits 16
%ifdef COM
org 0x100
start:
%else
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
%endif
    cld
    mov bx, 0xc000                 ; BX = the block's segment
.block:
    mov ax, bx
    call hex16
    mov al, ' '
    call putc
    push ds
    mov ds, bx
    ; writable? flip the first byte, read it back, restore it
    cli
    mov al, [0]
    mov ah, al
    xor al, 0xff
    mov [0], al
    mov al, [0]
    mov [0], ah                    ; restore whatever it was (a no-op on ROM)
    sti
    cmp al, ah
    mov al, 'r'
    je .ro
    mov al, 'W'
.ro:
    pop ds
    call putc
    mov al, ' '
    call putc
    ; content: all FF, all 00, or mixed
    push ds
    mov ds, bx
    xor si, si
    mov cx, 2048
    mov dl, 0xff                   ; AND of all bytes
    xor dh, dh                     ; OR of all bytes
.scan:
    lodsb
    and dl, al
    or dh, al
    loop .scan
    mov ax, [0]
    pop ds
    push ax
    mov al, '*'
    cmp dl, 0xff
    jne .notff
    mov al, 'F'
.notff:
    test dh, dh
    jnz .notzero
    mov al, '0'
.notzero:
    call putc
    pop ax
    cmp ax, 0xaa55
    jne .nosig
    mov al, ' '
    call putc
    mov al, 'S'
    call putc
.nosig:
    mov al, 13
    call putc
    mov al, 10
    call putc
    add bx, 0x80                   ; next 2 KiB
    jnz .block                     ; wraps to 0 after F800
    mov si, done
.d: lodsb
    test al, al
    jz .end
    call putc
    jmp .d
.end:
%ifdef COM
    mov ax, 0x4c00
    int 0x21
%else
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang
%endif

done: db 'DONE', 13, 10, 0

putc:
    push ax
    push dx
    mov ah, al
.w: mov dx, 0x3fd
    in al, dx
    test al, 0x20
    jz .w
    mov dx, 0x3f8
    mov al, ah
    out dx, al
    pop dx
    pop ax
    ret
hex16:
    push ax
    mov al, ah
    call hex8
    pop ax
hex8:
    push ax
    shr al, 4
    call nib
    pop ax
    and al, 0x0f
nib:
    add al, '0'
    cmp al, '9'
    jbe .p
    add al, 7
.p: jmp putc

%ifndef COM
    times 510 - ($ - $$) db 0
    dw 0xaa55
%endif
