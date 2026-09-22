; pmprobe.asm — the PROTECTION primitives of protected mode, answered over COM1.
;
;   nasm -f bin tools/pmprobe.asm -o /tmp/pmprobe.img
;   qemu-system-i386 -drive format=raw,file=/tmp/pmprobe.img -serial stdio -display none \
;     -device isa-debug-exit,iobase=0xf4,iosize=4
;
; The companion of tools/larprobe.asm, and it exists because of a gap that is structural rather
; than accidental: NOTHING in this toolbox exercises protected mode. realmode.flat is real mode by
; construction, the golden fingerprints are real-mode DOS, the Unicorn co-simulation builds no
; descriptor tables, and test386 — which does test all of this — stops at POST 0x12, long before
; its protection section. So the instructions that only mean something with a GDT in front of them
; have never been compared against anything, and two of them turned out to be wrong in one week.
;
; VERR and VERW are the first sweep because they are the cheapest to get silently wrong: a stub
; that always reports "accessible" is indistinguishable from a working one until a guest asks about
; a selector that is NOT. Thirteen cases, one per rule in the 386 manual's protection chapter:
;
;   VERR  is the selector READABLE from here?   code needs bit 1 (readable); data always readable
;   VERW  is it WRITABLE from here?             data needs bit 1 (writable); CODE NEVER IS
;   both  need a non-null selector, inside the table, and a non-system type
;
; PRESENCE IS NOT REQUIRED, and this comment claimed the opposite before the probe was run: "VERR
; asks may I read it, and a segment that is not in memory cannot be read" is a good argument and a
; wrong answer. QEMU and v86 both report ZF=1 for the not-present data segment below, and the 386
; manual's pseudocode lists only the table limit, the type and the privilege. Every system
; descriptor IS refused, though, including the LDT and TSS types that LAR accepts.
;
; That is the whole point of writing the probe rather than reasoning: it took one run to settle a
; question two paragraphs of argument had settled wrongly.
;
; Everything runs at CPL 0 with RPL 0, so the privilege rule is not under test here; a ring-3 pass
; needs a TSS and belongs in the next version, with the fault-expecting cases that need an IDT.
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

    mov si, tests
.loop:
    mov bx, [si]                    ; selector under test, 0xffff ends the list
    cmp bx, 0xffff
    je  .done
    mov di, [si + 2]                ; its name
    mov al, [si + 4]                ; 0 = VERR, 1 = VERW
    add si, 6
    push si
    push ax
    mov si, di
    call puts
    pop ax
    or  al, al
    jz  .read
    verw bx
    jmp .show
.read:
    verr bx
.show:
    pushf
    pop cx
    mov si, mZ
    call puts
    mov al, '0'
    test cl, 0x40                   ; ZF
    jz  .zero
    mov al, '1'
.zero:
    call putc
    mov si, mNL
    call puts
    pop si
    jmp .loop

.done:
    mov si, mDone
    call puts
    mov dx, 0xf4                    ; QEMU's isa-debug-exit; inert everywhere else
    xor al, al
    out dx, al
.hang:
    hlt
    jmp .hang

putc:
    push ax
    push dx
    mov ah, al
.wait:
    mov dx, 0x3fd
    in  al, dx
    test al, 0x20                   ; transmit holding register empty
    jz  .wait
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
    jz  .end
    call putc
    jmp .next
.end:
    pop ax
    ret

; selector, name, 0 = VERR / 1 = VERW
tests:
    dw 0x08, n1, 0                  ; readable code      -> readable, not writable
    dw 0x08, n2, 1
    dw 0x18, n3, 0                  ; execute-only code  -> neither
    dw 0x18, n4, 1
    dw 0x10, n5, 0                  ; writable data      -> both
    dw 0x10, n6, 1
    dw 0x20, n7, 0                  ; read-only data     -> readable, not writable
    dw 0x20, n8, 1
    dw 0x28, n9, 0                  ; NOT PRESENT data   -> neither (unlike LAR)
    dw 0x28, n10, 1
    dw 0x30, n11, 0                 ; an LDT descriptor  -> neither
    dw 0x00, n12, 0                 ; the null selector  -> neither
    dw 0x40, n13, 0                 ; past the GDT limit -> neither
    dw 0xffff

n1:  db 'verr 08 rcode', 0
n2:  db 'verw 08 rcode', 0
n3:  db 'verr 18 xonly', 0
n4:  db 'verw 18 xonly', 0
n5:  db 'verr 10 drw', 0
n6:  db 'verw 10 drw', 0
n7:  db 'verr 20 dro', 0
n8:  db 'verw 20 dro', 0
n9:  db 'verr 28 np', 0
n10: db 'verw 28 np', 0
n11: db 'verr 30 sys', 0
n12: db 'verr 00 null', 0
n13: db 'verr 40 oob', 0
mZ:     db ' zf=', 0
mNL:    db 13, 10, 0
mDone:  db '--- DONE ---', 13, 10, 0

align 8
gdt:
    dq 0
    dw 0xffff, 0x0000
    db 0x00, 0x9a, 0x00, 0x00       ; 08 code16, present, READABLE
    dw 0xffff, 0x0000
    db 0x00, 0x92, 0x00, 0x00       ; 10 data16, present, WRITABLE
    dw 0xffff, 0x0000
    db 0x00, 0x98, 0x00, 0x00       ; 18 code16, present, EXECUTE-ONLY
    dw 0xffff, 0x0000
    db 0x00, 0x90, 0x00, 0x00       ; 20 data16, present, READ-ONLY
    dw 0xffff, 0x0000
    db 0x00, 0x12, 0x00, 0x00       ; 28 data16, writable, NOT PRESENT
    dw 0x0007, 0x9000
    db 0x00, 0x82, 0x00, 0x00       ; 30 an LDT descriptor: a SYSTEM type
gdt_end:
gdtr:
    dw gdt_end - gdt - 1            ; so selector 40 is past the table
    dd gdt

times 510 - ($ - $$) db 0
dw 0xaa55
