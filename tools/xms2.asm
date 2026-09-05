; xms2.asm — reproduces PMODE4K's XMS sequence exactly and prints each answer, so MIRAGE and QEMU can
; be compared on the same image: largest free conventional block, XMS entry, AH=03 (global enable A20)
; and AH=09 (allocate XMS_MIN = 6336 KB, what mesha asks for).
        org 0x100
        bits 16
        mov     ah, 0x48                ; largest free conventional block, in paragraphs
        mov     bx, 0xffff
        int     0x21
        mov     di, mconv
        mov     ax, bx
        call    hex4

        mov     ax, 0x4310              ; XMS entry point -> ES:BX
        int     0x2f
        mov     [ent], bx
        mov     [ent + 2], es

        mov     ah, 3                   ; global enable A20
        call    far [ent]
        mov     di, ma20
        call    hex2ax

        mov     ah, 9                   ; allocate 6336 KB
        mov     dx, 6336
        call    far [ent]
        mov     di, mall
        call    hex2ax
        mov     ax, dx                  ; handle (or error code in BL)
        mov     di, mhnd
        call    hex4

        mov     ah, 9
        mov     dx, mtxt
        int     0x21
        mov     ax, 0x4c00
        int     0x21

hex2ax: push    ax                      ; AL of AX -> 2 digits, then BL -> 2 digits
        mov     al, ah
        pop     ax
        push    bx
        call    hex2
        add     di, 1
        pop     bx
        mov     al, bl
        call    hex2
        ret
hex2:   push    cx                      ; AL -> 2 hex digits at CS:DI
        mov     cl, al
        shr     al, 4
        call    dig
        mov     al, cl
        and     al, 15
        call    dig
        pop     cx
        ret
hex4:   push    cx                      ; AX -> 4 hex digits at CS:DI
        mov     cx, 4
.l:     rol     ax, 4
        push    ax
        and     al, 15
        call    dig
        pop     ax
        loop    .l
        pop     cx
        ret
dig:    add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    push    es
        push    cs
        pop     es
        stosb
        pop     es
        ret
ent     dd 0
mtxt    db 'conv='
mconv   db '____ par  a20(ax:bl)='
ma20    db '__:__  alloc(ax:bl)='
mall    db '__:__  handle='
mhnd    db '____', 13, 10, '$'
