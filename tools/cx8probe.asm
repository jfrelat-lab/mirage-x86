; cx8probe.asm — CMPXCHG8B (0F C7 /1) on COM1, to compare src/cpu.js cmpxchg8b with QEMU.
; One line per case: EDX:EAX after, the quadword after (high:low), FLAGS after.
;   1. equal, flags all clear before        -> ECX:EBX stored, ZF set, nothing else
;   2. different, SF ZF AF PF CF set before -> EDX:EAX loaded, ZF cleared, the rest kept
;   3. equal with a LOCK prefix
;   4. the register form (0F C7 C9)         -> #UD: "UD" from the INT 6 handler
; then CPUID leaf 1's EDX (informational: bit 8 is CX8).
;
;   nasm -f bin tools/cx8probe.asm -o /tmp/cx8.img && truncate -s 1474560 /tmp/cx8.img
;   qemu-system-i386 -cpu pentium -drive format=raw,file=/tmp/cx8.img,if=floppy -boot a \
;     -serial file:/tmp/cx8.txt -display none -device isa-debug-exit,iobase=0xf4
;   MIRAGE_CPU=586 MIRAGE_SERIAL=1 node tools/v86/serialboot.mjs /tmp/cx8.img
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    mov word [6 * 4], ud
    mov [6 * 4 + 2], ax

    call setq                   ; 1
    mov eax, 0x11111111
    mov edx, 0x22222222
    xor cx, cx
    push cx
    popf
    mov ecx, 0xaaaaaaaa
    mov ebx, 0xbbbbbbbb
    cmpxchg8b [q]
    call show

    call setq                   ; 2
    mov eax, 0x11111112
    mov edx, 0x22222222
    mov cx, 0x08d5
    push cx
    popf
    mov ecx, 0xaaaaaaaa
    cmpxchg8b [q]
    call show

    call setq                   ; 3
    mov eax, 0x11111111
    mov edx, 0x22222222
    xor cx, cx
    push cx
    popf
    mov ecx, 0xaaaaaaaa
    lock cmpxchg8b [q]
    call show

    db 0x0f, 0xc7, 0xc9         ; 4
    mov eax, 1
    cpuid
    mov eax, edx
    call hex32
    call crlf
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

ud: push bp
    mov bp, sp
    add word [bp + 2], 3        ; step over the three bytes
    pop bp
    mov al, 'U'
    call putc
    mov al, 'D'
    call putc
    call crlf
    iret

setq:
    mov dword [q], 0x11111111
    mov dword [q + 4], 0x22222222
    ret
show:
    pushf
    push eax
    mov eax, edx
    call hex32
    mov al, ':'
    call putc
    pop eax
    call hex32
    call sp1
    mov eax, [q + 4]
    call hex32
    mov al, ':'
    call putc
    mov eax, [q]
    call hex32
    call sp1
    pop ax
    call hex16
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

q:  dq 0
    times 510 - ($ - $$) db 0
    dw 0xaa55
