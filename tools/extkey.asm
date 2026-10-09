; extkey.asm — what INT 21h AH=08h returns for an extended key: type Left arrow then "a"; DOS gives
; 00h, then the scan code 4Bh on the next call, then 61h. Prints the three bytes in hex.
;
;   nasm -f bin tools/extkey.asm -o EXTKEY.COM
;   DOSBox-X:  AUTOTYPE -w 1 left a     then   EXTKEY > OUT.TXT
bits 16
org 0x100
    mov cx, 3
.next:
    mov ah, 0x08
    int 0x21
    push cx
    call hex8
    mov dl, ' '
    mov ah, 2
    int 0x21
    pop cx
    loop .next
    mov dx, crlf
    mov ah, 9
    int 0x21
    mov ax, 0x4c00
    int 0x21
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
    add al, 'A' - '9' - 1
.o: mov dl, al
    mov ah, 2
    int 0x21
    ret
crlf: db 13, 10, '$'
