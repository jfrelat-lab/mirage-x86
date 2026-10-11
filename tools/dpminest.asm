; dpminest.asm — a hardware interrupt that arrives while a DPMI client's handler runs on a stack of
; its own. The host entered the handler on its locked stack, where the handler's return frame is;
; the handler leaves that stack (DOOM's sound driver, DMX, does, for its timer), and the next IRQ
; finds SS on the client's stack. The host must not start the new frame where it started the first:
; the outer handler still has to return through it.
; The IRQ 0 handler (INT 8, AX=0205h): on its first entry it pushes a marker on the host's stack,
; moves to its own, sends the EOI and enables interrupts, waits for a nested tick, then goes back,
; checks the marker and returns with IRETD. Twice, then prints:
;   "OUTER=02 NESTED=nn MARK=1"
; MARK=0: what the handler left on the host's stack was overwritten. No line at all: the outer
; return went wrong.
; 32-bit client (CWSDPMI takes no other); the code segment stays 16-bit, as DPMI gives it.
;
;   nasm -f bin tools/dpminest.asm -o DPMINEST.COM      (run CWSDPMI first where there is no host)
        org 0x100
        bits 16
        mov     ah, 0x4a                ; shrink to 64 KiB
        mov     bx, 0x1000
        int     0x21
        mov     [rseg], cs
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      near quit
        mov     [handle], ax
        mov     ax, 0x1687
        int     0x2f
        test    ax, ax
        jnz     near quit
        mov     [entry], di
        mov     [entry + 2], es
        mov     bx, si
        mov     ah, 0x48
        int     0x21
        jc      near quit
        mov     es, ax
        mov     ax, 1                   ; 32-bit client
        call    far [entry]
        jc      near quit

        mov     [myds], ds
        mov     ax, 0x0204              ; save the old INT 8 PM vector
        mov     bl, 8
        int     0x31
        mov     [old8], edx
        mov     [old8 + 4], cx
        mov     ax, 0x0205              ; install ours
        mov     bl, 8
        mov     cx, cs
        mov     edx, handler
        int     0x31
        sti
.w:     cmp     byte [outer], 2         ; two outer handlers back
        jb      .w
        cli
        mov     ax, 0x0205              ; restore INT 8
        mov     bl, 8
        mov     cx, [old8 + 4]
        mov     edx, [old8]
        int     0x31
        sti

        mov     al, [outer]             ; build the line
        call    hex8
        mov     [res + 6], ax
        mov     al, [nested]
        call    hex8
        mov     [res + 16], ax
        mov     al, [mark]
        mov     [res + 24], al
        push    ds                      ; write it: AH=40h through AX=0300h
        pop     es
        mov     word [rm_eax], 0x4000
        mov     ax, [handle]
        mov     [rm_ebx], ax
        mov     word [rm_ecx], reslen
        mov     word [rm_edx], res
        mov     ax, [rseg]
        mov     [rm_ds], ax
        mov     ax, 0x300
        mov     bx, 0x21
        xor     cx, cx
        mov     edi, rmcs
        int     0x31
quit:   mov     ax, 0x4c00
        int     0x21

handler:
        push    ds
        push    eax
        mov     ax, [cs:myds]
        mov     ds, ax
        cmp     byte [depth], 0
        jne     .nested
        mov     byte [depth], 1
        push    dword 0x13572468        ; on the host's stack, under our frame
        mov     [savesp], esp           ; to a stack of our own
        mov     [savss], ss
        mov     ax, ds
        mov     ss, ax
        mov     esp, stacktop
        mov     al, 0x20                ; EOI, interrupts on: the next tick nests
        out     0x20, al
        sti
        mov     al, [nested]
.n:     cmp     al, [nested]
        je      .n
        cli
        lss     esp, [savesp]           ; back to the host's stack
        cmp     dword [esp], 0x13572468
        je      .k
        mov     byte [mark], '0'
.k:     add     esp, 4
        inc     byte [outer]
        mov     byte [depth], 0
        pop     eax
        pop     ds
        iretd
.nested:
        inc     byte [nested]
        mov     al, 0x20
        out     0x20, al
        pop     eax
        pop     ds
        iretd

hex8:   mov     ah, al                  ; AL -> two ASCII hex digits in AX (low byte first)
        shr     al, 4
        call    .n
        xchg    al, ah
        and     al, 15
        call    .n
        xchg    al, ah
        ret
.n:     add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     ret

fname   db      'DPMINEST.TXT', 0
res     db      'OUTER=?? NESTED=?? MARK=?', 13, 10
reslen  equ     $ - res
outer   db      0
nested  db      0
depth   db      0
mark    db      '1'
rseg    dw      0
handle  dw      0
entry   dd      0
myds    dw      0
savesp  dd      0
savss   dw      0
old8    dd      0
        dw      0
rmcs:
rm_edi  dd      0
rm_esi  dd      0
rm_ebp  dd      0
        dd      0
rm_ebx  dd      0
rm_edx  dd      0
rm_ecx  dd      0
rm_eax  dd      0
rm_flg  dw      0
rm_es   dw      0
rm_ds   dw      0
rm_fs   dw      0
rm_gs   dw      0
rm_ip   dw      0
rm_cs   dw      0
rm_sp   dw      0
rm_ss   dw      0
stacktop equ     $ + 512                 ; the handler's own stack, past the end of the file
