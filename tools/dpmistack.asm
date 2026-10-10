; dpmistack.asm — on which stack does a DPMI host run a protected-mode hardware interrupt handler?
; The DPMI 0.9 specification has the host switch to a locked stack of its own; a client may then
; keep data below its ESP, and Void 3 does (`lea esi,[esp-7Eh]`). Installs a PM handler for IRQ 0
; (INT 8, AX=0205h), fills 64 bytes below its own ESP with a pattern, waits for a few timer ticks,
; and prints whether the handler ran on the client's stack and whether the pattern survived:
;   "TICKS=nn SAMESS=n INTACT=n"
; 32-bit client (CWSDPMI takes no other); the code segment stays 16-bit, as DPMI gives it.
;
;   nasm -f bin tools/dpmistack.asm -o DPMISTK.COM      (run CWSDPMI first where there is no host)
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

        mov     [mycs], cs
        mov     [myss], ss
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

        mov     edi, esp                ; 64 bytes of pattern BELOW esp
        sub     edi, 64
        push    ss
        pop     es
        mov     ecx, 16
        mov     eax, 0x5aa55aa5
.f:     mov     [es:edi], eax
        add     edi, 4
        loop    .f
        sti
.w:     cmp     byte [ticks], 5         ; wait for five ticks
        jb      .w
        mov     edi, esp                ; check the pattern
        sub     edi, 64
        mov     ecx, 16
        mov     byte [intact], '1'
.c:     cmp     dword [ss:edi], 0x5aa55aa5
        je      .ok
        mov     byte [intact], '0'
.ok:    add     edi, 4
        loop    .c

        mov     ax, 0x0205              ; restore INT 8
        mov     bl, 8
        mov     cx, [old8 + 4]
        mov     edx, [old8]
        int     0x31

        mov     al, [ticks]             ; build the line
        call    hex8
        mov     [res + 6], ax
        mov     al, [samess]
        mov     [res + 16], al
        mov     al, [intact]
        mov     [res + 25], al
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

handler:                                ; PM IRQ 0: count, note the stack, chain to the old one
        push    ds
        push    eax
        mov     ax, [cs:myds]
        mov     ds, ax
        inc     byte [ticks]
        mov     ax, ss
        cmp     ax, [myss]
        mov     byte [samess], '1'
        je      .s
        mov     byte [samess], '0'
.s:     pop     eax
        pop     ds
        jmp     far dword [cs:old8j]

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

fname   db      'DPMISTK.TXT', 0
res     db      'TICKS=?? SAMESS=? INTACT=?', 13, 10
reslen  equ     $ - res
ticks   db      0
samess  db      '?'
intact  db      '?'
rseg    dw      0
handle  dw      0
entry   dd      0
mycs    dw      0
myss    dw      0
myds    dw      0
old8    dd      0
        dw      0
old8j   equ     old8
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
