; larprobe.asm — what do LAR and LSL answer for a NOT-PRESENT descriptor?
;
;   nasm -f bin tools/larprobe.asm -o /tmp/larprobe.img
;   qemu-system-i386 -drive format=raw,file=/tmp/larprobe.img -serial stdio -display none \
;     -device isa-debug-exit,iobase=0xf4,iosize=4
;
; The question is not academic. Windows 3.1's KERNEL asks whether one of its own segments is still
; in memory with exactly this sequence (KRNL386 at 037f:0ede):
;
;       lar   ax, [ss:bx+2]
;       jnz   fail                  ; ZF=0 -> the selector is not a usable descriptor at all
;       test  ah, 0x80              ; P -> in memory, or discarded and needing a reload
;
; so a LAR that refuses a descriptor merely because P=0 turns "discarded, go and load it" into
; "invalid selector", and the segment is never loaded.
;
; Six cases, answered over COM1 so the same image can be run under any emulator. A, B, E are the
; ones at issue; C and D are the controls that keep a LAR which always says yes from passing.
bits 16
org 0x7c00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7000
    lgdt [gdtr]
    mov eax, cr0
    or  al, 1
    mov cr0, eax
    jmp 0x08:pmode

pmode:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000

    mov si, mA                      ; LAR on a NOT-PRESENT code descriptor
    call puts
    mov bx, 0x18
    xor ax, ax
    lar ax, bx
    pushf
    pop cx
    call show

    mov si, mA2                     ; the same, through MEMORY — the form KRNL386 uses
    call puts
    xor ax, ax
    lar ax, word [sel18]
    pushf
    pop cx
    call show

    mov si, mB                      ; a present code descriptor
    call puts
    mov bx, 0x08
    xor ax, ax
    lar ax, bx
    pushf
    pop cx
    call show

    mov si, mC                      ; the null selector: never accessible
    call puts
    xor bx, bx
    xor ax, ax
    lar ax, bx
    pushf
    pop cx
    call show

    mov si, mD                      ; past the GDT limit: never accessible
    call puts
    mov bx, 0x38
    xor ax, ax
    lar ax, bx
    pushf
    pop cx
    call show

    mov si, mE                      ; LSL on a NOT-PRESENT data descriptor, limit 1234
    call puts
    mov bx, 0x20
    xor ax, ax
    lsl ax, bx
    pushf
    pop cx
    call show

    mov si, mDone
    call puts
    mov dx, 0xf4                    ; QEMU's isa-debug-exit; inert everywhere else
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

; cx = the flags LAR/LSL left, ax = the value it stored.
show:
    push ax
    mov si, mZ
    call puts
    mov al, '0'
    test cl, 0x40                   ; ZF
    jz .zero
    mov al, '1'
.zero:
    call putc
    mov si, mV
    call puts
    pop ax
    call puthex16
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
    jb .dec
    add al, 'a' - 10
    jmp putc
.dec:
    add al, '0'
    jmp putc

putc:
    push ax
    push dx
    mov ah, al
.wait:
    mov dx, 0x3fd
    in  al, dx
    test al, 0x20                   ; transmit holding register empty
    jz .wait
    mov dx, 0x3f8
    mov al, ah
    out dx, al
    pop dx
    pop ax
    ret

puts:
    push ax
.next:
    mov al, [si]
    inc si
    or  al, al
    jz .end
    call putc
    jmp .next
.end:
    pop ax
    ret

mA:     db 'A lar notpresent-code', 0
mA2:    db 'B lar notpresent-code-mem', 0
mB:     db 'C lar present-code', 0
mC:     db 'D lar null', 0
mD:     db 'E lar beyond-limit', 0
mE:     db 'F lsl notpresent-data', 0
mZ:     db ' zf=', 0
mV:     db ' v=', 0
mNL:    db 13, 10, 0
mDone:  db '--- DONE ---', 13, 10, 0
sel18:  dw 0x18

align 8
gdt:
    dq 0
    dw 0xffff, 0x0000
    db 0x00, 0x9a, 0x00, 0x00       ; 08 code16, present
    dw 0xffff, 0x0000
    db 0x00, 0x92, 0x00, 0x00       ; 10 data16, present
    dw 0xffff, 0x0000
    db 0x00, 0x1b, 0x00, 0x00       ; 18 code, readable, accessed, NOT PRESENT
    dw 0x1234, 0x0000
    db 0x00, 0x12, 0x00, 0x00       ; 20 data, writable, NOT PRESENT, limit 1234
gdt_end:
gdtr:
    dw gdt_end - gdt - 1            ; so selector 38 is past the table
    dd gdt

times 510 - ($ - $$) db 0
dw 0xaa55
