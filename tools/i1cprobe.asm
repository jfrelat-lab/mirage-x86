; i1cprobe.asm — does the BIOS timer interrupt protect the interrupted program from its INT 1Ch hook?
;
;   nasm -f bin tools/i1cprobe.asm -o /tmp/i1cprobe.img
;   qemu-system-i386 -drive format=raw,file=/tmp/i1cprobe.img,if=floppy -serial stdio -display none \
;     -device isa-debug-exit,iobase=0xf4,iosize=4
;
; INT 1Ch is the user timer hook the BIOS INT 08h handler calls on every tick. A 1Ch handler that
; clobbers a register without saving it is harmless on a PC, because the BIOS saves the interrupted
; program's registers around the call. "Exploring the IBM PC" relies on it: its handler starts with
; `xor dx,dx`, and a BLOAD loop running at that moment keeps its destination segment in DX.
;
; The hook here trashes every general register and DS/ES, saving nothing, and counts its calls.
; The main loop holds sentinels in all of them with interrupts on and reports which one changed.
bits 16
org 0x7c00

start:
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
    mov word [0x1c * 4], hook       ; INT 1Ch -> hook (segment 0)
    mov word [0x1c * 4 + 2], 0
    mov word [calls], 0
    mov ax, 0x1111
    mov bx, 0x2222
    mov cx, 0x3333
    mov dx, 0x4444
    mov si, 0x5555
    mov di, 0x6666
    mov bp, 0x7777
    push word 0x0880
    pop es
    sti
.wait:                              ; spin with interrupts ON until the hook has run 5 times
    cmp word [cs:calls], 5
    jb .wait
    cli
    ; Record what survived, then report.
    mov [s_ax], ax
    mov [s_bx], bx
    mov [s_cx], cx
    mov [s_dx], dx
    mov [s_si], si
    mov [s_di], di
    mov [s_bp], bp
    mov ax, es
    mov [s_es], ax
    xor ax, ax
    mov ds, ax
    mov si, m_ax
    mov bx, s_ax
    mov cx, 8
.rep:
    push cx
    call puts                       ; name
    mov ax, [bx]
    call puthex16
    add bx, 2
    mov si, mNL
    call puts
    mov si, [nextname]
    add word [nextname], 10
    pop cx
    loop .rep
    mov si, mDone
    call puts
    mov dx, 0xf4
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

hook:                               ; clobbers EVERYTHING, saves NOTHING
    inc word [cs:calls]
    xor ax, ax
    xor bx, bx
    xor cx, cx
    xor dx, dx
    xor si, si
    xor di, di
    xor bp, bp
    mov es, ax
    iret                            ; DS is left alone so the IRET frame is not the question

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
    jmp putc

calls:  dw 0
s_ax:   dw 0
s_bx:   dw 0
s_cx:   dw 0
s_dx:   dw 0
s_si:   dw 0
s_di:   dw 0
s_bp:   dw 0
s_es:   dw 0
nextname: dw m_bx
m_ax:   db 'AX 1111=', 0, 0
m_bx:   db 'BX 2222=', 0, 0
m_cx:   db 'CX 3333=', 0, 0
m_dx:   db 'DX 4444=', 0, 0
m_si:   db 'SI 5555=', 0, 0
m_di:   db 'DI 6666=', 0, 0
m_bp:   db 'BP 7777=', 0, 0
m_es:   db 'ES 0880=', 0, 0
mNL:    db 13, 10, 0
mDone:  db '--- DONE ---', 13, 10, 0

times 510 - ($ - $$) db 0
dw 0xaa55
