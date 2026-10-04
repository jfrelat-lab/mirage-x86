; cdboot.asm — an El Torito "no emulation" boot image that reports, on COM1, what the BIOS gives a
; CD boot: where it was loaded (CS) and from which drive (DL), then INT 13h on that drive — 41h, 48h,
; 42h of sector 16 (the primary volume descriptor), 4B01h's specification packet, 43h (a write), a
; read past the end — each as AX/BX/CX and the carry, to compare src/disk.js + bootCD with SeaBIOS.
;
;   nasm -f bin tools/cdboot.asm -o cdboot.bin
;   hdiutil makehybrid -iso -joliet -eltorito-boot <dir>/cdboot.bin -no-emul-boot -o cdboot.iso <dir>
;     (cdboot.bin must be inside <dir>, and hdiutil leaves the catalog's initial entry empty: write
;     it yourself — 88h, media 0, segment 0, count 4, the image's sector — at catalog + 32)
;   qemu-system-i386 -M pc -cdrom cdboot.iso -boot d -serial file:/tmp/cd.txt -display none \
;     -device isa-debug-exit,iobase=0xf4
bits 16
org 0
start:
    mov bx, cs                  ; where the BIOS entered (printed below), before normalising to 07C0h
    jmp 0x07c0:.go
.go:
    mov ax, cs
    mov ds, ax
    mov es, ax
    cli
    xor ax, ax
    mov ss, ax
    mov sp, 0x7000
    sti
    mov [drive], dl
    mov ax, bx
    call hex16
    call sp1
    mov al, dl
    call hex8
    call crlf

    mov ah, 0x41                ; EDD installation check
    mov bx, 0x55aa
    mov dl, [drive]
    int 0x13
    call result

    mov word [params], 0x1e     ; get drive parameters: flags, total sectors, bytes per sector
    mov ah, 0x48
    mov dl, [drive]
    mov si, params
    int 0x13
    call result
    mov ax, [params + 2]
    call hex16
    call sp1
    mov ax, [params + 16]
    call hex16
    call sp1
    mov ax, [params + 24]
    call hex16
    call crlf

    mov word [dap + 2], 1       ; read sector 16
    mov dword [dap + 8], 16
    call read
    mov si, buf
    mov cx, 6
.pvd: lodsb
    call hex8
    loop .pvd
    call crlf

    mov ax, 0x4b01              ; El Torito: get emulation status
    mov dl, [drive]
    mov si, spec
    int 0x13
    call result
    mov si, spec
    mov cx, 0x13
.sp: lodsb
    call hex8
    loop .sp
    call crlf

    mov ah, 0x43                ; write: refused
    mov al, 0
    mov dl, [drive]
    mov si, dap
    int 0x13
    call result

    mov word [dap + 2], 1       ; past the end of the disc
    mov dword [dap + 8], 0x100000
    call read

    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

read:
    mov byte [dap], 0x10
    mov word [dap + 4], buf
    mov [dap + 6], ds
    mov ah, 0x42
    mov dl, [drive]
    mov si, dap
    int 0x13
    jmp result

result:                         ; AX BX CX and the carry
    pushf
    push cx
    push bx
    call hex16
    call sp1
    pop ax
    call hex16
    call sp1
    pop ax
    call hex16
    call sp1
    pop ax
    and al, 1
    call hex8
    jmp crlf

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

drive:  db 0
dap:    times 16 db 0
params: times 0x1e db 0
spec:   times 0x13 db 0
    times 2048 - ($ - $$) db 0
buf:
