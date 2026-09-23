; i8chain.asm — a program that hooks INT 08h and CHAINS to the BIOS handler: does the BIOS still
; call the user hook INT 1Ch, and does the BIOS tick still advance?
;
;   nasm -f bin tools/i8chain.asm -o /tmp/i8chain.img
;   qemu-system-i386 -drive format=raw,file=/tmp/i8chain.img,if=floppy -serial stdio -display none \
;     -device isa-debug-exit,iobase=0xf4,iosize=4
;
; This is the ubiquitous TSR idiom: hook INT 8, do something, `jmp far [old8]`. The BIOS handler
; reached that way must behave exactly as if the IRQ had come straight to it — tick, EOI, and INT 1Ch.
bits 16
org 0x7c00

start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
    cli
    mov ax, [0x08 * 4]              ; keep the BIOS INT 8 vector
    mov [old8], ax
    mov ax, [0x08 * 4 + 2]
    mov [old8 + 2], ax
    mov word [0x08 * 4], hook8      ; our INT 8, which chains
    mov word [0x08 * 4 + 2], 0
    mov word [0x1c * 4], hook1c     ; our INT 1Ch, which counts
    mov word [0x1c * 4 + 2], 0
    mov ax, [0x46c]
    mov [tick0], ax
    sti
.wait:                              ; let 20 of OUR INT 8 run
    cmp word [cs:n8], 20
    jb .wait
    cli
    mov si, m8
    call puts
    mov ax, [n8]
    call puthex16
    mov si, m1c
    call puts
    mov ax, [n1c]
    call puthex16
    mov si, mtk
    call puts
    mov ax, [0x46c]
    sub ax, [tick0]
    call puthex16
    mov si, mNL
    call puts
    mov si, mDone
    call puts
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

hook8:
    inc word [cs:n8]
    jmp far [cs:old8]               ; the TSR idiom: let the BIOS finish the job

hook1c:
    inc word [cs:n1c]
    iret

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
puts:
    push ax
.n: mov al, [si]
    inc si
    or al, al
    jz .e
    call putc
    jmp .n
.e: pop ax
    ret
puthex16:
    push ax
    mov al, ah
    call puthex8
    pop ax
puthex8:
    push ax
    shr al, 4
    call nib
    pop ax
    and al, 0x0f
nib:
    cmp al, 10
    jb .d
    add al, 'a' - 10
    jmp putc
.d: add al, '0'
    jmp putc

old8:   dd 0
tick0:  dw 0
n8:     dw 0
n1c:    dw 0
m8:     db 'our int8 calls ', 0
m1c:    db '  int1c calls ', 0
mtk:    db '  bios ticks ', 0
mNL:    db 13, 10, 0
mDone:  db '--- DONE ---', 13, 10, 0

times 510 - ($ - $$) db 0
dw 0xaa55
