; atapiprobe.asm — the ATAPI CD-ROM on the secondary IDE channel (170h-177h, 376h), driven by polling,
; reported on COM1, to compare src/ide.js against QEMU. One line per step:
;   reset / ec / a1  — after SRST, IDENTIFY DEVICE and IDENTIFY PACKET DEVICE:
;                      sector count, sector, cylinder low, cylinder high, status, error (+ IDENTIFY words)
;   pk <op>          — a PACKET command: interrupt reason after A0h, then the size of each DRQ block,
;                      then "|" status error reason, then the first data bytes
;
;   nasm -f bin tools/atapiprobe.asm -o /tmp/atapi.img && truncate -s 1474560 /tmp/atapi.img
;   qemu-system-i386 -M pc -drive format=raw,file=/tmp/atapi.img,if=floppy -boot a -cdrom test.iso \
;     -serial file:/tmp/atapi.txt -display none -device isa-debug-exit,iobase=0xf4
;   (test.iso: any ISO 9660 image; on macOS `hdiutil makehybrid -iso -joliet -o test.iso <dir>`)
;
; The boot sector loads the rest (sectors 2-8 of the floppy) at 7E00h.
bits 16
org 0x7c00
    jmp 0:start
start:
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    mov ax, 0x0207              ; read 7 sectors
    mov cx, 0x0002              ; cylinder 0, sector 2
    xor dh, dh
    mov bx, 0x7e00
    int 0x13
    jmp main

    times 510 - ($ - $$) db 0
    dw 0xaa55

BASE equ 0x170
CTL  equ 0x376

main:
    cli
    ; SRST, with nIEN: the whole probe polls.
    mov dx, CTL
    mov al, 0x06
    out dx, al
    call delay
    mov al, 0x02
    out dx, al
    call delay
    call waitnb
    mov si, s_reset
    call puts
    call taskfile
    call crlf

    ; IDENTIFY DEVICE: an ATAPI device aborts it and leaves its signature.
    mov dx, BASE + 6
    mov al, 0xa0
    out dx, al
    mov dx, BASE + 7
    mov al, 0xec
    out dx, al
    call delay
    call waitnb
    mov si, s_ec
    call puts
    call taskfile
    call crlf

    ; IDENTIFY PACKET DEVICE: words 0, 49, 53, 64, 80.
    mov dx, BASE + 7
    mov al, 0xa1
    out dx, al
    call delay
    call waitnb
    mov si, s_a1
    call puts
    call taskfile
    mov di, 0x9000
    mov cx, 256
    mov dx, BASE
    rep insw
    mov bx, 0
    call word_at
    mov bx, 49
    call word_at
    mov bx, 53
    call word_at
    mov bx, 64
    call word_at
    mov bx, 80
    call word_at
    mov dx, BASE + 7
    in al, dx
    call hex8
    call crlf

    ; The packets: [limit, 12 bytes] each.
    mov si, packets
.next:
    cmp word [si], 0
    je .end
    call packet
    add si, 14
    jmp .next
.end:
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

; One PACKET command from the 14-byte entry at SI (limit word, then the CDB).
packet:
    push si
    mov bp, si
    mov si, s_pk
    call puts
    mov al, [bp + 2]
    call hex8
    call sp1
    mov dx, BASE + 1
    xor al, al
    out dx, al                  ; features: PIO
    mov ax, [bp]
    mov dx, BASE + 4
    out dx, al
    inc dx
    mov al, ah
    out dx, al
    mov dx, BASE + 7
    mov al, 0xa0
    out dx, al
    call delay
    call waitnb
    mov dx, BASE + 2
    in al, dx
    call hex8                   ; the reason when the device wants the command (01h)
    call sp1
    mov si, bp
    add si, 2
    mov cx, 6
    mov dx, BASE
    rep outsw
    mov di, 0x9000              ; the data lands here
.loop:
    call delay
    call waitnb
    mov dx, BASE + 7
    in al, dx
    test al, 0x08
    jz .fin
    mov dx, BASE + 4
    in al, dx
    mov cl, al
    inc dx
    in al, dx
    mov ch, al
    mov ax, cx
    call hex16
    call sp1
    shr cx, 1
    mov dx, BASE
    cmp di, 0xb000              ; keep at most 8 KiB
    jb .keep
    mov di, 0xb000
.keep:
    rep insw
    jmp .loop
.fin:
    mov al, '|'
    call putc
    mov dx, BASE + 7
    in al, dx
    call hex8
    call sp1
    mov dx, BASE + 1
    in al, dx
    call hex8
    call sp1
    mov dx, BASE + 2
    in al, dx
    call hex8
    mov al, '|'
    call putc
    mov si, 0x9000
    mov cx, 12
.dump:
    lodsb
    call hex8
    loop .dump
    call crlf
    ; clear the buffer for the next command
    mov di, 0x9000
    mov cx, 16
    xor ax, ax
    rep stosw
    pop si
    ret

; sector count, sector, cylinder low/high, status, error
taskfile:
    mov dx, BASE + 2
    in al, dx
    call hex8
    call sp1
    inc dx
    in al, dx
    call hex8
    call sp1
    inc dx
    in al, dx
    call hex8
    call sp1
    inc dx
    in al, dx
    call hex8
    call sp1
    mov dx, BASE + 7
    in al, dx
    call hex8
    call sp1
    mov dx, BASE + 1
    in al, dx
    call hex8
    jmp sp1

word_at:                        ; BX = word index into 9000h
    shl bx, 1
    mov ax, [0x9000 + bx]
    call hex16
    jmp sp1

waitnb:                         ; until BSY clears (bounded)
    push cx
    mov cx, 0xffff
.w: mov dx, CTL
    in al, dx
    test al, 0x80
    jz .ok
    loop .w
.ok:
    pop cx
    ret

delay:                          ; a few ISA reads: 400 ns and more
    push cx
    push dx
    push ax
    mov cx, 8
    mov dx, CTL
.d: in al, dx
    loop .d
    pop ax
    pop dx
    pop cx
    ret

puts:
    lodsb
    or al, al
    jz .r
    call putc
    jmp puts
.r: ret
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

s_reset: db 'reset ', 0
s_ec:    db 'ec ', 0
s_a1:    db 'a1 ', 0
s_pk:    db 'pk ', 0

packets:
    dw 0x0800
    db 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0                    ; TEST UNIT READY
    dw 0x0800
    db 0x03, 0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0                   ; REQUEST SENSE
    dw 0x0800
    db 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0                    ; TEST UNIT READY again
    dw 0x0800
    db 0x12, 0, 0, 0, 36, 0, 0, 0, 0, 0, 0, 0                   ; INQUIRY
    dw 0x0800
    db 0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0                    ; READ CAPACITY
    dw 0x0800
    db 0x28, 0, 0, 0, 0, 16, 0, 0, 1, 0, 0, 0                   ; READ (10) LBA 16, 1 sector
    dw 0x0200
    db 0x28, 0, 0, 0, 0, 16, 0, 0, 2, 0, 0, 0                   ; ... 2 sectors in 512-byte blocks
    dw 0x0800
    db 0x43, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0                 ; READ TOC, LBA
    dw 0x0800
    db 0x43, 2, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0                 ; READ TOC, MSF
    dw 0x0800
    db 0x43, 0, 1, 0, 0, 0, 0, 0, 0x0c, 0, 0, 0                 ; READ TOC, multisession
    dw 0x0800
    db 0x5a, 0, 0x2a, 0, 0, 0, 0, 0, 0x20, 0, 0, 0              ; MODE SENSE (10), page 2Ah
    dw 0x0800
    db 0x5a, 0, 0x01, 0, 0, 0, 0, 0, 0x20, 0, 0, 0              ; MODE SENSE (10), page 01h
    dw 0x0800
    db 0x1a, 0, 0x2a, 0, 0x20, 0, 0, 0, 0, 0, 0, 0              ; MODE SENSE (6), page 2Ah
    dw 0x0800
    db 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0                    ; an invalid opcode
    dw 0x0800
    db 0x03, 0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0                   ; REQUEST SENSE
    dw 0x0800
    db 0x28, 0, 0, 0, 0x10, 0, 0, 0, 1, 0, 0, 0                 ; READ (10) past the end
    dw 0x0800
    db 0x03, 0, 0, 0, 18, 0, 0, 0, 0, 0, 0, 0                   ; REQUEST SENSE
    dw 0x0800
    db 0x4a, 1, 0, 0, 0x10, 0, 0, 0, 8, 0, 0, 0                 ; GET EVENT STATUS, media class
    dw 0x0800
    db 0x46, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0                    ; GET CONFIGURATION, header
    dw 0x0800
    db 0xbe, 0, 0, 0, 0, 16, 0, 0, 1, 0x10, 0, 0                ; READ CD, user data
    dw 0x0800
    db 0x51, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0                   ; READ DISC INFORMATION
    dw 0x0800
    db 0x1e, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0                    ; PREVENT REMOVAL
    dw 0x0800
    db 0x5a, 0, 0x2a, 0, 0, 0, 0, 0, 0x20, 0, 0, 0              ; MODE SENSE: page 2Ah shows the lock
    dw 0
