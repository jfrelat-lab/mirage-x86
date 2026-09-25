; cmosdump.asm — the 64 bytes of CMOS RAM, as the BIOS left them, on COM1. Four lines of 16.
;
;   nasm -f bin tools/cmosdump.asm -o /tmp/cmos.img        QEMU / MIRAGE boot sector (pad for MIRAGE)
;   nasm -f bin -DCOM tools/cmosdump.asm -o CMOS.COM       DOSBox-X (serial1=file ...)
;
; PC-MOS/386 reads register 10h (diskette drive types) to build its drive table before it has read
; a boot sector; MIRAGE's CMOS held the clock and nothing else, so it read "no drive" and computed
; every CHS address with a default geometry. The clock bytes (00-09) are expected to differ.
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
    xor cl, cl
.row:
    mov al, cl
    call hex8
    mov al, ':'
    call putc
.col:
    mov al, cl
    out 0x70, al
    in al, 0x71
    push ax
    mov al, ' '
    call putc
    pop ax
    call hex8
    inc cl
    test cl, 0x0f
    jnz .col
    mov al, 13
    call putc
    mov al, 10
    call putc
    cmp cl, 0x40
    jb .row
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

%ifndef COM
    times 510 - ($ - $$) db 0
    dw 0xaa55
%endif
