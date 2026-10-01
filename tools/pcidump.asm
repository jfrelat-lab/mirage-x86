; pcidump.asm — what a PC's PCI bus looks like to a boot sector, on COM1: the first 128 bytes of
; configuration space of bus 0 devices 0-3 (every function present), the ELCR (4D0h/4D1h), the PCI
; BIOS installation check (INT 1Ah AX=B101h), a B102h search for the PIIX3 IDE function, and where
; the BIOS keeps its "$PIR" IRQ routing table and its "_32_" BIOS32 service directory.
;
;   nasm -f bin tools/pcidump.asm -o /tmp/pcidump.img
;   qemu-system-i386 -M pc -nodefaults -vga std -drive format=raw,file=/tmp/pcidump.img,if=floppy \
;     -boot a -serial file:/tmp/pcidump.txt -display none          (the reference: SeaBIOS + i440FX/PIIX3)
;
; Windows NT 3.51 and 9legacy boot under QEMU -M pc and not -M isapc; this is the oracle for what
; MIRAGE's PCI bus has to present (ROADMAP H14 step 2).
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    ; ---- configuration space, mechanism #1 ----
    xor bx, bx                      ; BL = device, BH = function
.dev:
    xor cl, cl
    call cfgaddr
    mov dx, 0xcfc
    in eax, dx
    cmp ax, 0xffff                  ; no device / function here
    je .next
    mov al, bl
    call hex8
    mov al, '.'
    call putc
    mov al, bh
    call hex8
    mov al, ':'
    call putc
    xor cl, cl                      ; CL = register offset
.reg:
    call cfgaddr
    mov dx, 0xcfc
    in eax, dx
    push ax
    mov al, ' '
    call putc
    pop ax
    call hex32
    add cl, 4
    test cl, 0x0f
    jnz .reg
    call crlf
    cmp cl, 0x80
    jae .regs_done
    jmp .reg
.regs_done:
.next:
    inc bh
    cmp bh, 8
    jb .dev
    xor bh, bh
    inc bl
    cmp bl, 4
    jb .dev
    ; ---- ELCR ----
    mov si, s_elcr
    call puts
    mov dx, 0x4d1
    in al, dx
    call hex8
    mov dx, 0x4d0
    in al, dx
    call hex8
    call crlf
    ; ---- PCI BIOS ----
    mov ax, 0xb101
    xor edi, edi
    int 0x1a
    pushf
    mov si, s_b101
    call puts
    mov al, ah                      ; AH = 00 present
    call hex8
    mov al, ' '
    call putc
    mov ax, bx                      ; BX = version
    call hex16
    mov al, ' '
    call putc
    mov al, cl                      ; CL = last bus
    call hex8
    mov al, ' '
    call putc
    pop ax
    and al, 1                       ; CF
    call hex8
    mov al, ' '
    call putc
    mov eax, edx                    ; EDX = 'PCI '
    call hex32
    call crlf
    mov ax, 0xb102
    mov cx, 0x7010
    mov dx, 0x8086
    xor si, si
    int 0x1a
    pushf
    mov si, s_b102
    call puts
    mov al, ah
    call hex8
    mov al, ' '
    call putc
    mov ax, bx                      ; BH = bus, BL = dev<<3 | fn
    call hex16
    mov al, ' '
    call putc
    pop ax
    and al, 1
    call hex8
    call crlf
    ; ---- tables in the BIOS area ----
    mov si, s_pir
    call puts
    mov eax, '$PIR'
    call scan
    mov si, s_b32
    call puts
    mov eax, '_32_'
    call scan
    mov dx, 0xf4                    ; QEMU's isa-debug-exit, harmless elsewhere
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

; EAX = signature: print the paragraph-aligned address in F0000-FFFFF holding it, and 32 bytes there.
scan:
    push es
    mov bx, 0xf000
    mov es, bx
    xor di, di
.s: cmp [es:di], eax
    je .found
    add di, 16
    jnz .s
    mov si, s_none
    call puts
    call crlf
    pop es
    ret
.found:
    mov ax, 0xf000
    call hex16
    mov al, ':'
    call putc
    mov ax, di
    call hex16
    mov cx, 32
.b: mov al, ' '
    call putc
    mov al, [es:di]
    call hex8
    inc di
    loop .b
    call crlf
    pop es
    ret

; CF8h = 80000000h | device << 11 | function << 8 | CL
cfgaddr:
    xor eax, eax
    mov al, bl
    shl eax, 3
    or al, bh
    shl eax, 8
    mov al, cl
    and al, 0xfc
    or eax, 0x80000000
    mov dx, 0xcf8
    out dx, eax
    ret

puts:
    lodsb
    test al, al
    jz .e
    call putc
    jmp puts
.e: ret
crlf:
    mov al, 13
    call putc
    mov al, 10
    jmp putc
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
hex32:
    push eax
    shr eax, 16
    call hex16
    pop eax
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

s_elcr: db 'ELCR ', 0
s_b101: db 'B101 ', 0
s_b102: db 'B102 ', 0
s_pir:  db '$PIR ', 0
s_b32:  db '_32_ ', 0
s_none: db 'none', 0

    times 510 - ($ - $$) db 0
    dw 0xaa55
