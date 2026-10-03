; dispiprobe.asm — the Bochs DISPI registers (ports 1CEh/1CFh) read back on COM1, to compare MIRAGE's
; src/dispi.js against QEMU's standard VGA. Each line is one register dump, 0 to 0Ah:
;   1. at boot (text mode)       2. GETCAPS (ENABLE=2)        3. after 4F02h 4117h (VBE BIOS)
;   4. after a direct set, 1024x768x8 LFB (NT 3.51's sequence)  5. VIRT_WIDTH 1280, offsets 8,4
;   6. after ENABLE=0
;
;   nasm -f bin tools/dispiprobe.asm -o /tmp/dispi.img && truncate -s 1474560 /tmp/dispi.img
;   qemu-system-i386 -M pc -vga std -drive format=raw,file=/tmp/dispi.img,if=floppy -boot a \
;     -serial file:/tmp/dispi.txt -display none
;   MIRAGE_PCI=1 MIRAGE_SERIAL=1 node tools/v86/serialboot.mjs /tmp/dispi.img
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
    call dump
    mov bx, 4
    mov ax, 2
    call wr
    call dump
    mov bx, 4
    xor ax, ax
    call wr
    mov ax, 0x4f02
    mov bx, 0x4117
    int 0x10
    call dump
    mov bx, 4
    xor ax, ax
    call wr
    mov bx, 3
    mov ax, 8
    call wr
    mov bx, 1
    mov ax, 0x400
    call wr
    mov bx, 2
    mov ax, 0x300
    call wr
    mov bx, 5
    xor ax, ax
    call wr
    mov bx, 4
    mov ax, 0x41
    call wr
    call dump
    mov bx, 6
    mov ax, 1280
    call wr
    mov bx, 8
    mov ax, 8
    call wr
    mov bx, 9
    mov ax, 4
    call wr
    call dump
    mov bx, 4
    xor ax, ax
    call wr
    call dump
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

wr:                             ; register BX <- AX
    push ax
    mov dx, 0x1ce
    mov ax, bx
    out dx, ax
    pop ax
    inc dx
    out dx, ax
    ret
dump:
    xor bx, bx
.r: mov dx, 0x1ce
    mov ax, bx
    out dx, ax
    inc dx
    in ax, dx
    call hex16
    mov al, ' '
    call putc
    inc bx
    cmp bx, 11
    jb .r
    mov al, 13
    call putc
    mov al, 10
putc:
    push ax
    push dx
    mov ah, al
.t: mov dx, 0x3fd
    in al, dx
    test al, 0x20
    jz .t
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
    jbe .o
    add al, 'a' - '9' - 1
.o: jmp putc

    times 510 - ($ - $$) db 0
    dw 0xaa55
