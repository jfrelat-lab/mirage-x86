; ifprobe.asm — does a BIOS service called with interrupts DISABLED hand them back enabled?
;
;   nasm -f bin tools/ifprobe.asm -o /tmp/ifprobe.img
;   qemu-system-i386 -drive format=raw,file=/tmp/ifprobe.img,if=floppy -serial stdio -display none \
;     -device isa-debug-exit,iobase=0xf4,iosize=4
;
; The IBM PC BIOS opens its keyboard service with STI and ends AH=01h with RET 2, so a caller that
; entered with IF=0 comes back with IF=1 — and a boot-time "press a key, or wait N ticks" loop
; written with interrupts off only works because of it: the tick it reads advances only if the timer
; interrupt gets in somewhere. SvarDOS's EDR-DOS kernel (v86's doof-1440.img) waits exactly that way.
; This asks each service in turn, with CLI before every call, and reports the IF it came back with,
; plus whether the BIOS tick moved across 200 000 calls to INT 1Ah.
bits 16
org 0x7c00

start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000

    mov si, m16                     ; INT 16h AH=01h
    call puts
    cli
    mov ah, 0x01
    int 0x16
    call showif

    mov si, m1a                     ; INT 1Ah AH=00h
    call puts
    cli
    mov ah, 0x00
    int 0x1a
    call showif

    mov si, m10                     ; INT 10h AH=0Fh (a service with no reason to wait)
    call puts
    cli
    mov ah, 0x0f
    int 0x10
    call showif

    ; Does the tick advance when the ONLY place interrupts can get in is inside INT 16h?
    mov si, mtick
    call puts
    cli
    mov ah, 0x00
    int 0x1a
    mov [t0], dx
    mov cx, 0
.spin:
    cli
    mov ah, 0x01
    int 0x16
    cli
    loop .spin                      ; 65536 keyboard calls, IF forced off between them
    cli
    mov ah, 0x00
    int 0x1a
    sub dx, [t0]
    mov ax, dx
    call puthex16
    mov si, mNL
    call puts

    ; ...and inside INT 1Ah alone?
    mov si, mtick1a
    call puts
    cli
    mov ah, 0x00
    int 0x1a
    mov [t0], dx
    mov cx, 0
.spin1a:
    cli
    push cx                         ; INT 1Ah AH=00h returns the tick in CX:DX — keep the counter
    mov ah, 0x00
    int 0x1a
    pop cx
    cli
    loop .spin1a
    cli
    mov ah, 0x00
    int 0x1a
    sub dx, [t0]
    mov ax, dx
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

showif:                             ; print " IF=0/1" for the flags as the service left them
    pushf
    pop ax
    push ax
    mov si, mIF
    call puts
    pop ax
    mov al, '0'
    test ah, 0x02                   ; IF is bit 9: bit 1 of the high byte
    jz .z
    mov al, '1'
.z: call putc
    mov si, mNL
    call puts
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

m16:   db 'int16 ah=01', 0
m1a:   db 'int1a ah=00', 0
m10:   db 'int10 ah=0f', 0
mtick: db 'ticks across 65536 int16/01 with IF off: ', 0
mtick1a: db 'ticks across 65536 int1a/00 with IF off: ', 0
mIF:   db ' IF=', 0
mNL:   db 13, 10, 0
mDone: db '--- DONE ---', 13, 10, 0
t0:    dw 0

times 510 - ($ - $$) db 0
dw 0xaa55
