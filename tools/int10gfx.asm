; int10gfx.asm — INT 10h in graphics modes, as a reference BIOS does it. One program, three oracles:
;
;   nasm -f bin -DCOM tools/int10gfx.asm -o INT10GFX.COM     DOSBox-X (serial1=file ...)
;   nasm -f bin tools/int10gfx.asm -o /tmp/int10gfx.img      QEMU/MIRAGE boot image:
;   qemu-system-i386 -drive format=raw,file=/tmp/int10gfx.img,if=floppy -serial stdio -display none
;
; Every line is one behaviour MIRAGE had to change after pixel-comparing v86 images against QEMU:
;   T1 mode 4 set: the CGA bitmap is cleared to 00 (not text blanks)      B800:0000 1FFF 3FFF
;   T2 AL bit 7 keeps it                                                  B800:0000
;   T3 AH=06h in mode 13h fills with BH (window DX=184Fh)                 A000:0000 013F 0A00 F9FF
;   T4 AH=13h AL=00 in 13h: colour BL, cursor NOT moved                   pixels==0Fh in cell 0, DX
;   T5 AH=0Eh in 12h, colour BL=06: seq index on entry, then map mask,
;      read map, and the glyph byte of each plane                         idx mm rm p0 p1 p2 p3
;   T6 AH=09h twice, BL=06h then 86h (XOR) — the glyph cancels            plane 1 at col 10, col 5
;   T8 AH=06h in 12h, BH=03h                                              p0..p3 at 0, map mask
;   T7 mode 6Ah: AL, BDA columns, rows-1, char height, AH=0Fh columns,
;      and the cursor after a teletype at the last column of the last row
;   T9 BDA 0484h (rows-1) and 0485h (character height) after each mode set: 0-7, 0D-13
bits 16
%ifdef COM
org 0x100
start:
    push cs
    pop ds
    push cs
    pop es
%else
org 0x7c00
start:
    jmp 0:.fix
.fix:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    sti
    mov ax, 0x0208                  ; the rest of the program: 8 sectors after the boot sector
    mov cx, 0x0002
    xor dh, dh
    mov bx, 0x7e00
    int 0x13
    jmp main
    times 510 - ($ - $$) db 0
    dw 0xaa55
%endif

main:
    ; ---- T1 / T2: CGA mode set clears, bit 7 keeps --------------------------------------------
    mov ax, 3
    int 0x10
    push es
    mov ax, 0xb800
    mov es, ax
    xor di, di
    mov cx, 0x2000
    mov ax, 0x7777
    rep stosw
    pop es
    mov ax, 4
    int 0x10
    mov si, mT1
    call puts
    push ds
    mov ax, 0xb800
    mov ds, ax
    mov al, [0]
    mov bl, [0x1fff]
    mov bh, [0x3fff]
    mov byte [0], 0x55
    pop ds
    call hex8s
    mov al, bl
    call hex8s
    mov al, bh
    call hex8s
    call nl
    mov ax, 0x84
    int 0x10
    mov si, mT2
    call puts
    push ds
    mov ax, 0xb800
    mov ds, ax
    mov al, [0]
    pop ds
    call hex8s
    call nl

    ; ---- T3: AH=06h in mode 13h -----------------------------------------------------------------
    mov ax, 0x13
    int 0x10
    mov ax, 0x0600
    mov bh, 0x4f
    xor cx, cx
    mov dx, 0x184f
    int 0x10
    mov si, mT3
    call puts
    push ds
    mov ax, 0xa000
    mov ds, ax
    mov al, [0]
    mov bl, [0x13f]
    mov bh, [0xa00]
    mov cl, [0xf9ff]
    pop ds
    call hex8s
    mov al, bl
    call hex8s
    mov al, bh
    call hex8s
    mov al, cl
    call hex8s
    call nl

    ; ---- T4: AH=13h AL=00 in mode 13h -----------------------------------------------------------
    mov ax, 0x13
    int 0x10
    mov ah, 2
    xor bh, bh
    mov dx, 0x0203
    int 0x10
    mov ax, 0x1300
    mov bx, 0x000f
    mov cx, 1
    xor dx, dx
    mov bp, strA
    int 0x10
    mov si, mT4
    call puts
    push ds
    mov ax, 0xa000
    mov ds, ax
    xor di, di                      ; DI = count of 0Fh pixels in the 8x8 cell
    xor bx, bx                      ; BX = start of the scanline
    mov dx, 8
.row:
    mov cx, 8
    xor si, si
.px:
    cmp byte [bx + si], 0x0f
    jne .no
    inc di
.no:
    inc si
    loop .px
    add bx, 320
    dec dx
    jnz .row
    pop ds
    mov ax, di
    call hex16s
    mov ah, 3
    xor bh, bh
    int 0x10
    mov ax, dx
    call hex16s
    call nl

    ; ---- T5: AH=0Eh in mode 12h, and what it leaves in the sequencer / graphics controller -------
    mov ax, 0x12
    int 0x10
    mov dx, 0x3c4
    mov ax, 0x0202                  ; map mask = plane 1 only
    out dx, ax
    mov dx, 0x3ce
    mov ax, 0x0104                  ; read map = plane 1
    out dx, ax
    mov ah, 2
    xor bh, bh
    mov dx, 0x0005
    int 0x10
    mov ax, 0x0e41
    mov bx, 0x0006
    int 0x10
    mov si, mT5
    call puts
    mov dx, 0x3c4
    in al, dx                       ; the sequencer index the BIOS left
    call hex8s
    mov al, 2
    out dx, al
    inc dx
    in al, dx
    and al, 0x0f
    call hex8s
    mov dx, 0x3ce
    mov al, 4
    out dx, al
    inc dx
    in al, dx
    and al, 3
    call hex8s
    mov di, 5 + 8 * 80              ; scanline 8 of the glyph at column 5
    call planes4
    call nl

    ; ---- T6: AH=09h, then the same glyph with bit 7 (XOR) ---------------------------------------
    mov ah, 2
    xor bh, bh
    mov dx, 0x000a
    int 0x10
    mov ax, 0x0941
    mov bx, 0x0006
    mov cx, 1
    int 0x10
    mov ax, 0x0941
    mov bx, 0x0086
    mov cx, 1
    int 0x10
    mov si, mT6
    call puts
    mov dx, 0x3ce
    mov ax, 0x0104
    out dx, ax
    push ds
    mov ax, 0xa000
    mov ds, ax
    mov al, [10 + 8 * 80]
    mov bl, [5 + 8 * 80]
    pop ds
    call hex8s
    mov al, bl
    call hex8s
    call nl

    ; ---- T8: AH=06h in mode 12h -----------------------------------------------------------------
    mov dx, 0x3c4
    mov ax, 0x0102                  ; leave a one-plane mask again
    out dx, ax
    mov ax, 0x0600
    mov bh, 0x03
    xor cx, cx
    mov dx, 0x1d4f
    int 0x10
    mov si, mT8
    call puts
    xor di, di
    call planes4
    mov dx, 0x3c4
    mov al, 2
    out dx, al
    inc dx
    in al, dx
    and al, 0x0f
    call hex8s
    call nl

    ; ---- T7: mode 6Ah ---------------------------------------------------------------------------
    mov ax, 0x006a
    int 0x10
    mov [modeAL], al
    mov ah, 0x0f
    int 0x10
    mov [colsAH], ah
    mov si, mT7
    call puts
    mov al, [modeAL]
    call hex8s
    push ds
    xor ax, ax
    mov ds, ax
    mov ax, [0x44a]
    mov bl, [0x484]
    mov cx, [0x485]
    pop ds
    call hex16s
    mov al, bl
    call hex8s
    mov ax, cx
    call hex16s
    mov al, [colsAH]
    call hex8s
    push ds                         ; cursor to the last column of the last row, then one 'A'
    xor ax, ax
    mov ds, ax
    mov dh, [0x484]
    mov dl, [0x44a]
    pop ds
    dec dl
    mov ah, 2
    xor bh, bh
    int 0x10
    mov ax, 0x0e41
    mov bx, 0x0006
    int 0x10
    mov ah, 3
    xor bh, bh
    int 0x10
    mov ax, dx
    call hex16s
    call nl

    ; ---- T9: the BDA text geometry each mode set leaves ----------------------------------------
    mov si, mT9
    call puts
    mov si, t9modes
.m9:
    mov al, [si]
    cmp al, 0xff
    je .m9e
    push si
    xor ah, ah
    int 0x10
    push ds
    xor ax, ax
    mov ds, ax
    mov bl, [0x484]
    mov cl, [0x485]
    pop ds
    mov al, bl
    call hex8s
    mov al, '/'
    call putc
    mov al, cl
    call hex8
    pop si
    inc si
    jmp .m9
.m9e:
    call nl

    mov ax, 3
    int 0x10
    mov si, mDone
    call puts
%ifdef COM
    mov ax, 0x4c00
    int 0x21
%else
    mov dx, 0xf4                    ; isa-debug-exit under QEMU
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang
%endif

; Print the byte at A000:DI of each of the four planes (read map select 0..3).
planes4:
    xor cl, cl
.p:
    mov dx, 0x3ce
    mov al, 4
    mov ah, cl
    out dx, ax
    push ds
    mov ax, 0xa000
    mov ds, ax
    mov al, [di]
    pop ds
    call hex8s
    inc cl
    cmp cl, 4
    jb .p
    ret

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
nl:
    push si
    mov si, mNL
    call puts
    pop si
    ret
hex16s:
    push ax
    mov al, ' '
    call putc
    pop ax
    push ax
    mov al, ah
    call hex8
    pop ax
    jmp hex8
hex8s:
    push ax
    mov al, ' '
    call putc
    pop ax
hex8:
    push ax
    shr al, 4
    call nib
    pop ax
    and al, 0x0f
nib:
    push ax
    cmp al, 10
    jb .d
    add al, 'a' - 10
    jmp .o
.d: add al, '0'
.o: call putc
    pop ax
    ret

strA:   db 'A'
modeAL: db 0
colsAH: db 0
mT1:    db 'T1 mode4 clear   ', 0
mT2:    db 'T2 keep bit7     ', 0
mT3:    db 'T3 13h AH=06     ', 0
mT4:    db 'T4 13h AH=13     ', 0
mT5:    db 'T5 12h AH=0E     ', 0
mT6:    db 'T6 12h AH=09 xor ', 0
mT8:    db 'T8 12h AH=06     ', 0
mT7:    db 'T7 mode 6Ah      ', 0
mT9:    db 'T9 rows-1/charh  ', 0
t9modes: db 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0xff
mNL:    db 13, 10, 0
mDone:  db '--- DONE ---', 13, 10, 0
%ifndef COM
    times 9 * 512 - ($ - $$) db 0
%endif
