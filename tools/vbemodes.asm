; vbemodes.asm — every mode a VESA BIOS lists, on COM1: one line per mode from the VbeInfoBlock's
; VideoModePtr, with what 4F01h says of it — number, width, height, bits per pixel, memory model,
; ModeAttributes, then the VbeInfoBlock's TotalMemory (64 KiB units) on the last line.
;
;   nasm -f bin tools/vbemodes.asm -o /tmp/vbemodes.img      (pad to 1.44 MB for a floppy)
;   qemu-system-i386 -M pc -vga std -drive format=raw,file=/tmp/vbemodes.ima,if=floppy -boot a \
;     -serial file:/tmp/vbe.txt -display none                        (SeaVGABIOS, the reference)
;   MIRAGE_SERIAL=1 node tools/v86/serialboot.mjs /tmp/vbemodes.ima
;
; BeOS 5 asks 4F01h for every listed mode and boots at 800x600x16 on v86; MIRAGE listed no 16-bit
; mode above 640x480. This is the list to match.
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    mov dword [0x8000], 'VBE2'
    mov ax, 0x4f00
    mov di, 0x8000
    int 0x10
    lfs si, [0x800e]            ; VideoModePtr
.next:
    mov cx, [fs:si]
    cmp cx, 0xffff
    je .done
    add si, 2
    push si
    mov ax, 0x4f01
    mov di, 0x9000
    int 0x10
    mov ax, cx
    call hex16
    call sp1
    mov ax, [0x9012]            ; XResolution
    call hex16
    mov al, 'x'
    call putc
    mov ax, [0x9014]            ; YResolution
    call hex16
    mov al, 'x'
    call putc
    mov al, [0x9019]            ; BitsPerPixel
    call hex8
    call sp1
    mov al, [0x901b]            ; MemoryModel
    call hex8
    call sp1
    mov ax, [0x9000]            ; ModeAttributes
    call hex16
    call crlf
    pop si
    jmp .next
.done:
    mov ax, [0x8012]            ; TotalMemory
    call hex16
    call crlf
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

sp1:
    mov al, ' '
    jmp putc
crlf:
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
