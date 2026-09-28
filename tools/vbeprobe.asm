; vbeprobe.asm — what a VESA BIOS answers, on COM1: the VbeInfoBlock (4F00h), the ModeInfoBlock for
; mode 105h (4F01h), and the palette-related functions 4F08h (DAC width), 4F09h (get palette) and
; 4F0Ah (protected-mode interface). One line per call: AX, then the bytes.
;
;   nasm -f bin tools/vbeprobe.asm -o /tmp/vbeprobe.img       QEMU / MIRAGE boot sector (pad for MIRAGE)
;
; Windows 95's VBE Miniport driver never programmed the palette under MIRAGE, where it does under
; QEMU right after its mode set: this is what the two BIOSes told it.
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    cld
    ; 4F00h: VbeInfoBlock at 0:8000, 'VBE2' asked for
    mov di, 0x8000
    mov dword [di], '2EBV'
    mov ax, 0x4f00
    int 0x10
    mov si, t00
    mov cx, 34
    call line
    ; 4F01h mode 105h
    mov di, 0x8200
    mov ax, 0x4f01
    mov cx, 0x105
    int 0x10
    mov si, t01
    mov cx, 50
    call line
    ; 4F08h BL=01: get DAC width (BH)
    mov ax, 0x4f08
    mov bx, 0x0100
    int 0x10
    mov [0x8400], bx
    mov di, 0x8400
    mov si, t08
    mov cx, 2
    call line
    ; 4F09h BL=01: get palette, 4 entries from 0, into 0:8500
    mov di, 0x8500
    mov ax, 0x4f09
    mov bl, 0x01
    mov cx, 4
    xor dx, dx
    int 0x10
    mov si, t09
    mov cx, 16
    call line
    ; 4F0Ah BL=00: protected-mode interface (ES:DI table, CX length)
    xor di, di
    mov ax, 0x4f0a
    xor bx, bx
    int 0x10
    mov [0x8600], es
    mov [0x8602], di
    mov [0x8604], cx
    xor bx, bx
    mov es, bx
    mov di, 0x8600
    mov si, t0a
    mov cx, 6
    call line
    mov si, done
    call puts
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

; SI = label, AX = the call's AX, ES:DI = buffer, CX = bytes to dump
line:
    push ax
    call puts
    pop ax
    call hex16
    mov al, ':'
    call putc
.b: mov al, ' '
    call putc
    mov al, [es:di]
    call hex8
    inc di
    loop .b
    mov al, 13
    call putc
    mov al, 10
    call putc
    ret

puts:
    lodsb
    test al, al
    jz .r
    call putc
    jmp puts
.r: ret

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

t00: db '4F00 AX=', 0
t01: db '4F01 AX=', 0
t08: db '4F08 AX=', 0
t09: db '4F09 AX=', 0
t0a: db '4F0A AX=', 0
done: db 'DONE', 13, 10, 0

    times 510 - ($ - $$) db 0
    dw 0xaa55
