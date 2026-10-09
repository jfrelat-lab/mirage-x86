; memstrat.asm — where DOS puts an AH=48h block under each allocation strategy (AH=58h), printed
; relative to the program's own block so that DOSes loading the program at different addresses
; can be compared line for line.
;
; Layout it builds above its own block P (shrunk to 1000h paragraphs):
;   A = 200h  B = 10h  C = 80h  D = 10h, back to back; then frees A and C, leaving two holes
;   (200h and 80h) and the free memory above D.
; Then for strategy 0 (first fit), 1 (best fit), 2 (last fit): allocate X = 40h, print X, free it.
; Expected on MS-DOS: first fit -> X = A; best fit -> X = C (the smallest hole that fits);
; last fit -> the top of the highest free block. Also printed: A, C, D and the end of memory
; (the 'Z' MCB's last paragraph + 1), all as offsets from P.
;
;   nasm -f bin tools/memstrat.asm -o MEMSTRAT.COM
bits 16
org 0x100
start:
    mov ah, 0x4a                ; shrink to 1000h paragraphs
    mov bx, 0x1000
    push cs
    pop es
    int 0x21
    mov bx, 0x200
    call alloc
    mov [a], ax
    mov bx, 0x10
    call alloc
    mov bx, 0x80
    call alloc
    mov [c], ax
    mov bx, 0x10
    call alloc
    mov [d], ax
    mov es, [a]                 ; free A and C
    mov ah, 0x49
    int 0x21
    mov es, [c]
    mov ah, 0x49
    int 0x21

    mov si, s_a
    mov ax, [a]
    call line
    mov si, s_c
    mov ax, [c]
    call line
    mov si, s_d
    mov ax, [d]
    call line
    call memend
    mov si, s_end
    call line

    xor cx, cx                  ; strategies 0, 1, 2
.strat:
    mov ax, 0x5801
    mov bx, cx
    int 0x21
    mov bx, 0x40
    call alloc
    push ax
    mov si, s_x
    mov al, cl
    add al, '0'
    mov [s_x + 1], al
    pop ax
    push ax
    call line
    pop es
    mov ah, 0x49
    int 0x21
    inc cx
    cmp cx, 3
    jb .strat
    mov ax, 0x5801              ; back to first fit
    xor bx, bx
    int 0x21
    mov ax, 0x4c00
    int 0x21

alloc:                          ; BX paragraphs -> AX segment (FFFF on failure)
    mov ah, 0x48
    int 0x21
    jnc .ok
    mov ax, 0xffff
.ok:
    ret

memend:                         ; walk the MCB chain from our own (CS-1) to 'Z' -> AX = end
    mov ax, cs
    dec ax
.w: mov es, ax
    cmp byte [es:0], 'Z'
    je .z
    add ax, [es:3]
    inc ax
    jmp .w
.z: add ax, [es:3]
    inc ax
    ret

line:                           ; print $-string SI, then AX - CS (paragraphs above our PSP) in hex
    push ax
    mov dx, si
    mov ah, 9
    int 0x21
    pop ax
    mov bx, cs
    sub ax, bx
    call hex16
    mov dx, crlf
    mov ah, 9
    int 0x21
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
    add al, 'A' - '9' - 1
.o: mov dl, al
    mov ah, 2
    int 0x21
    ret

a:      dw 0
c:      dw 0
d:      dw 0
s_a:    db 'A   $'
s_c:    db 'C   $'
s_d:    db 'D   $'
s_end:  db 'end $'
s_x:    db 'X0  $'
crlf:   db 13, 10, '$'
