; vbefull.asm — the VESA BIOS Extension as a program sees it, call by call, for comparing BIOSes.
;
;   nasm -f bin tools/vbefull.asm -o VBEFULL.COM      then   VBEFULL <first mode index, default 0>
;
; Line V  — 4F00h ("VBE2" asked): AX, version, capabilities (low word), memory in 64 KiB, mode count.
; Line F1 — after 4F02h BX=0101h (640x480x8): 4F02 AX | 4F03 AX BX | 4F05 get window A: AX DX |
;           4F06 get scan line: AX BX CX DX
; Line F2 — 4F07 get display start: AX CX DX | 4F08 get DAC width: AX BX | 4F09 get palette entry 0:
;           AX | 4F0A protected-mode interface: AX CX | 4F04 state size: AX BX
; Line F3 — 4F10 power management: AX BX | 4F15 DDC: AX BX | 4FFFh (no such function): AX |
;           after INT 10h AX=0003h, 4F03 AX BX
; Then 16 modes of the list from the index given: mode, 4F01 AX, attributes, width, height, bits per
; pixel, memory model, bytes per scan line, window A attributes, granularity (KiB) — all hex.
;
; Mode lists are each card's own; what is compared is the protocol: return codes, and that each
; ModeInfoBlock is consistent with itself.
;
; Measured 2026-10-15, lines V/F1/F2/F3 (Cirrus = the real CL-GD5436/46 BIOS 1.25 of 1996 in QEMU
; -device cirrus-vga,romfile=boot/roms/5446bv.vbi; SeaVGABIOS = QEMU's default; DOSBox-X svga_s3):
;   Cirrus  V 004F 0102 0000 0040 0016  F1 004F 004F 0101 004F 0000 004F 0280 0280 1999
;           F2 004F 0000 0000 004F 0601 4F09 4F0A 0000 004F 0010  F3 014F 0000 4F15 0000 4FFF 004F 0003
;   SeaVGA  V 004F 0300 0001 0100 005D  F1 004F 004F 0101 004F 0000 004F 0280 0280 6666
;           F2 004F 0000 0000 004F 0601 004F 0100 0000 004F 000F  F3 004F 0F30 004F 0103 0100 004F 0003
;   DOSBox  V 004F 0200 0001 0020 0035  F1 004F 004F 0101 004F 0000 004F 0280 0280 0CCC
;           F2 004F 0000 0000 004F 0601 004F 004F 004D 004F 0010  F3 4F00 0000 4F00 0000 4F00 004F 0003
;   MIRAGE  V 004F 0200 0001 0040 000D  F1 004F 004F 0101 004F 0000 004F 0280 0280 1999
;           F2 004F 0000 0000 004F 0601 004F 014F 0000 014F 0600  F3 014F 0600 014F 0600 4FFF 004F 0003
; All agree on 4F00/02/03/05/06/07 and on consistent ModeInfoBlocks. All three references answer
; 4F08 get with BH=6 and a VBE number that does not exist (4FFF) with AL != 4F: MIRAGE now does
; (it said 014F to both). Left as they are, the references disagreeing or MIRAGE lacking it:
; 4F04 (all three support it — state save/restore, not implemented here), 4F09, 4F0A, 4F10, 4F15.
        org 0x100
        bits 16
%macro SAVE 1
        mov [bp], %1
        add bp, 2
%endmacro
        cld
        mov si, 0x81                    ; the first mode index: a decimal number on the command line
        xor bx, bx
.num:   lodsb
        cmp al, ' '
        je .num
        sub al, '0'
        cmp al, 9
        ja .gotn
        xor ah, ah
        imul bx, bx, 10
        add bx, ax
        jmp .num
.gotn:  mov [first], bx
        mov bp, res

        mov dword [info], '2EBV'        ; "VBE2": ask for the VBE 2.0 fields
        mov ax, 0x4f00
        mov di, info
        int 0x10
        SAVE ax
        mov ax, [info + 4]
        SAVE ax
        mov ax, [info + 10]
        SAVE ax
        mov ax, [info + 18]
        SAVE ax
        les si, [info + 14]             ; count the list: ES:SI, up to FFFFh
        xor cx, cx
.cnt:   cmp word [es:si], 0xffff
        je .counted
        add si, 2
        inc cx
        cmp cx, 200
        jb .cnt
.counted:
        push ds
        pop es
        SAVE cx
        mov [count], cx

        mov ax, 0x4f02                  ; 640x480x8, then everything else from there
        mov bx, 0x0101
        int 0x10
        SAVE ax
        mov ax, 0x4f03
        int 0x10
        SAVE ax
        SAVE bx
        mov ax, 0x4f05
        mov bx, 0x0100
        int 0x10
        SAVE ax
        SAVE dx
        mov ax, 0x4f06
        mov bl, 1
        int 0x10
        SAVE ax
        SAVE bx
        SAVE cx
        SAVE dx
        mov ax, 0x4f07
        mov bl, 1
        int 0x10
        SAVE ax
        SAVE cx
        SAVE dx
        mov ax, 0x4f08
        mov bl, 1
        int 0x10
        SAVE ax
        SAVE bx
        mov ax, 0x4f09
        mov bl, 1
        mov cx, 1
        xor dx, dx
        mov di, pal
        int 0x10
        SAVE ax
        mov ax, 0x4f0a
        xor bl, bl
        xor cx, cx
        int 0x10
        push ds
        pop es
        SAVE ax
        SAVE cx
        mov ax, 0x4f04
        xor dl, dl
        mov cx, 0x000f
        int 0x10
        SAVE ax
        SAVE bx
        mov ax, 0x4f10
        xor bl, bl
        int 0x10
        SAVE ax
        SAVE bx
        mov ax, 0x4f15
        xor bl, bl
        xor cx, cx
        int 0x10
        push ds
        pop es
        SAVE ax
        SAVE bx
        mov ax, 0x4fff
        int 0x10
        SAVE ax
        mov ax, 0x0003
        int 0x10
        mov ax, 0x4f03
        int 0x10
        SAVE ax
        SAVE bx

        ; ---- print ----
        mov si, res
        mov dx, sV
        call str
        mov cx, 5
        call words
        mov dx, sF1
        call str
        mov cx, 9
        call words
        mov dx, sF2
        call str
        mov cx, 10
        call words
        mov dx, sF3
        call str
        mov cx, 7
        call words

        ; ---- the modes, 16 from `first` ----
        mov bx, [first]
        mov word [shown], 0
.mode:  cmp bx, [count]
        jae .done
        cmp word [shown], 16
        jae .done
        les si, [info + 14]
        mov di, bx
        shl di, 1
        add si, di
        mov cx, [es:si]
        push ds
        pop es
        mov [cur], cx
        mov di, mib
        push cx
        mov cx, 128
        xor ax, ax
        rep stosw
        pop cx
        mov ax, 0x4f01
        mov di, mib
        int 0x10
        mov [ret1], ax
        mov ax, [cur]
        call pw
        mov ax, [ret1]
        call pw
        mov ax, [mib]
        call pw
        mov ax, [mib + 18]
        call pw
        mov ax, [mib + 20]
        call pw
        mov al, [mib + 25]
        call pb
        mov al, [mib + 27]
        call pb
        mov ax, [mib + 16]
        call pw
        mov al, [mib + 2]
        call pb
        mov ax, [mib + 4]
        call pw
        mov dx, crlf
        call str
        inc bx
        inc word [shown]
        jmp .mode
.done:  ret

words:  lodsw                           ; CX words from SI, then a new line
        call pw
        loop words
        mov dx, crlf
        jmp str
str:    mov ah, 9
        int 0x21
        ret
pw:     push ax                         ; AX in hex and a space
        mov al, ah
        call hex2
        pop ax
pb:     call hex2                       ; AL in hex and a space
        mov dl, ' '
        mov ah, 2
        int 0x21
        ret
hex2:   push ax
        shr al, 4
        call nib
        pop ax
        and al, 0x0f
nib:    add al, '0'
        cmp al, '9'
        jbe .p
        add al, 7
.p:     mov dl, al
        mov ah, 2
        int 0x21
        ret

sV      db 'V  $'
sF1     db 'F1 $'
sF2     db 'F2 $'
sF3     db 'F3 $'
crlf    db 13, 10, '$'
first   dw 0
count   dw 0
shown   dw 0
cur     dw 0
ret1    dw 0
res     times 40 dw 0
pal     times 16 db 0
info    times 512 db 0
mib     times 256 db 0
