; int13hd.asm — what INT 13h answers for drives that are NOT there, on a floppy-only machine.
; One boot sector, output on COM1, ends on port F4h (QEMU isa-debug-exit):
;
;   nasm -f bin tools/int13hd.asm -o /tmp/int13hd.img
;   node tools/v86/cirrusboot.mjs /tmp/int13hd.img        QEMU (SeaBIOS)
;   node tools/v86/serialboot.mjs /tmp/int13hd.img        MIRAGE (pad the image to 1.44 MB first)
;   nasm -f bin -DCOM tools/int13hd.asm -o INT13HD.COM      DOSBox-X (serial1=file ...), no hard disk
;
; PC-MOS/386 probes hard disk 80h with AH=08h/04h/00h/02h before it opens its shell, and stops with
; "Internal error ... opening $$SHELL.SYS" under MIRAGE only. Each line: the request AX CX DX, then
; AX BX CX DX ES DI and CF after the call (BX=8000h ES=0 DI=2222h going in). Last line: BDA 0474h
; (last status) and 0475h (hard disk count).
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
    mov si, cases
.next:
    lodsw
    cmp ax, 0xffff
    je .done
    mov [rq], ax
    lodsw
    mov [rq + 2], ax
    lodsw
    mov [rq + 4], ax
    push si
    mov ax, [rq]
    call hex16
    mov ax, [rq + 2]
    call hex16s
    mov ax, [rq + 4]
    call hex16s
    mov al, ':'
    call putc
    xor ax, ax
    mov es, ax
    mov bx, 0x8000
    mov di, 0x2222
    mov ax, [rq]
    mov cx, [rq + 2]
    mov dx, [rq + 4]
    clc
    int 0x13
    pushf
    push di
    push es
    push dx
    push cx
    push bx
    call hex16s                     ; AX
    pop ax
    call hex16s                     ; BX
    pop ax
    call hex16s                     ; CX
    pop ax
    call hex16s                     ; DX
    pop ax
    call hex16s                     ; ES
    pop ax
    call hex16s                     ; DI
    pop ax
    and ax, 1
    call hex16s                     ; CF
    call nl
    pop si
    jmp .next
.done:
    push ds
    xor ax, ax
    mov ds, ax
    mov al, [0x474]
    mov ah, [0x475]
    pop ds
    call hex16
    call nl
%ifdef COM
    mov ax, 0x4c00
    int 0x21
%endif
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

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
nl:
    mov al, 13
    call putc
    mov al, 10
    jmp putc
hex16s:
    push ax
    mov al, ' '
    call putc
    pop ax
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

rq: dw 0, 0, 0
;          AX      CX      DX
cases: dw 0x0800, 0x0000, 0x0080    ; get drive parameters, hard disk 0
       dw 0x0840, 0x0064, 0x7980    ; ...exactly as PC-MOS asks
       dw 0x1500, 0x0000, 0x0080    ; get disk type
       dw 0x0000, 0x0000, 0x0080    ; reset
       dw 0x0100, 0x0000, 0x0080    ; last status
       dw 0x0401, 0x0001, 0x0080    ; verify one sector
       dw 0x0201, 0x0001, 0x0080    ; read one sector
       dw 0x4100, 0x0000, 0x0080    ; extensions present? (BX=8000h, not 55AAh: expect "no")
       dw 0x0800, 0x0000, 0x0000    ; get drive parameters, floppy 0 — the drive that IS there
       dw 0x1500, 0x0000, 0x0000    ; get disk type, floppy 0
       dw 0x0800, 0x0000, 0x0001    ; floppy 1, absent
       dw 0xffff
%ifndef COM
    times 510 - ($ - $$) db 0
    dw 0xaa55
%endif
