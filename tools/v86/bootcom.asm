; bootcom.asm — run a floppy's boot sector from DOS, on the host's own BIOS: read sector 1 of drive
; A: to 0000:7C00 with INT 13h and jump there with DL=0. Lets a resident grabber installed before it
; capture a boot-sector program under DOSBox-X, whose screenshots cannot be scripted.
bits 16
org 0x100
    mov ax, 0x0201
    xor bx, bx
    mov es, bx
    mov bx, 0x7c00
    mov cx, 0x0001
    xor dx, dx
    int 0x13
    jc fail
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7c00
    sti
    xor dx, dx
    jmp 0:0x7c00
fail:
    mov dx, msg
    mov ah, 9
    int 0x21
    mov ax, 0x4c01
    int 0x21
msg: db 'INT 13h read failed$'
