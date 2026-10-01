; uartprobe.asm — how the COM1 UART answers the probes drivers make, printed on COM1 itself:
; LSR and IIR at rest, IIR with the FIFOs on (C1h on a 16550A), the scratch register, a loopback
; round trip (byte, LSR, MSR as MCR's lines), and the THRE interrupt identity when IER enables it.
;
;   nasm -f bin tools/uartprobe.asm -o /tmp/uartprobe.img   (pad to 1.44 MB for a floppy)
;   qemu-system-i386 -M isapc -drive format=raw,file=/tmp/uartprobe.ima,if=floppy -boot a \
;     -serial file:/tmp/uart.txt -display none                       (the reference: QEMU's 16550A)
;   MIRAGE_SERIAL=1 node tools/v86/serialboot.mjs /tmp/uartprobe.ima
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
    mov di, res
    mov dx, 0x3fd
    in al, dx               ; 1 LSR at rest
    stosb
    mov dx, 0x3fa
    in al, dx               ; 2 IIR at rest
    stosb
    mov al, 0x07
    out dx, al              ; FCR: FIFOs on, both cleared
    in al, dx               ; 3 IIR with FIFOs
    stosb
    mov dx, 0x3ff
    mov al, 0x5a
    out dx, al
    in al, dx               ; 4 SCR read back
    stosb
    mov dx, 0x3fc
    mov al, 0x1f            ; loopback, OUT2, OUT1, RTS, DTR
    out dx, al
    mov dx, 0x3fe
    in al, dx               ; 5 MSR in loopback (deltas + lines)
    stosb
    in al, dx               ; 6 MSR again (deltas cleared)
    stosb
    mov dx, 0x3f8
    mov al, 0xa5
    out dx, al              ; transmit in loopback
    mov cx, 0x1000
.w: loop .w
    mov dx, 0x3fd
    in al, dx               ; 7 LSR: data ready
    stosb
    mov dx, 0x3f8
    in al, dx               ; 8 the byte back
    stosb
    mov dx, 0x3f9
    mov al, 0x02
    out dx, al              ; IER: THRE
    mov dx, 0x3fa
    in al, dx               ; 9 IIR: THRE pending
    stosb
    in al, dx               ; 10 IIR again: acknowledged
    stosb
    mov dx, 0x3f9
    xor al, al
    out dx, al              ; IER off
    mov dx, 0x3fc
    mov al, 0x03            ; loopback off, DTR+RTS
    out dx, al
    mov dx, 0x3fe
    in al, dx               ; 11 MSR outside loopback
    stosb
    in al, dx               ; 12 MSR again
    stosb
    ; ---- print the twelve bytes ----
    mov si, res
    mov cx, 12
.p: lodsb
    call hex8
    mov al, ' '
    call putc
    loop .p
    mov al, 13
    call putc
    mov al, 10
    call putc
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

res: times 12 db 0
    times 510 - ($ - $$) db 0
    dw 0xaa55
