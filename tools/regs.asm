; regs.asm — what does DOS leave in the registers at .COM entry, and WHERE does it load us?
;
; The register values matter for their own sake (sizecoding intros depend on CX=00FF, DI=FFFE,
; BP=091C — and oktaeder.com does `mov cr0,edx` with EDX as DOS left it, so it enters protected mode
; only when the PSP segment happens to be odd). But the reason this exists is CS: it IS the PSP
; segment, and ours is nothing like a real DOS's.
;
;   nasm -f bin tools/regs.asm -o REGS.COM
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "REGS.COM > OUT.TXT" -c "exit"
;
; Measured on dosbox-x, 2026-08-22 — identical across memsize 16 and 32 MiB and with EMS/XMS both
; on and off, so the number is not a configuration artefact:
;
;   AX=0000 BX=0000 CX=00FF DX=0814 SI=0100 DI=FFFE CS=0814
;
; MIRAGE loads at 0x0100 (src/dos.js PSP_SEG). That is 0x714 paragraphs = 28,992 bytes of
; conventional memory a program gets here and would not get on a real machine — see ROADMAP G1.
;
        org 0x100
start:  mov     bp, sp          ; keep nothing; capture first
        mov     [v_ax], ax
        mov     [v_bx], bx
        mov     [v_cx], cx
        mov     [v_dx], dx
        mov     [v_si], si
        mov     [v_di], di
        mov     ax, cs
        mov     [v_cs], ax
        ; print "AX=.... BX=.... CX=.... DX=.... SI=.... DI=.... CS=...."
        mov     si, names
        mov     di, v_ax
        mov     cx, 7
.each:  push    cx
        mov     al, [si]
        call    putc
        mov     al, [si+1]
        call    putc
        mov     al, '='
        call    putc
        mov     ax, [di]
        call    puthex
        mov     al, ' '
        call    putc
        add     si, 2
        add     di, 2
        pop     cx
        loop    .each
        mov     al, 13
        call    putc
        mov     al, 10
        call    putc
        mov     ax, 0x4c00
        int     0x21
putc:   push    ax
        push    dx
        mov     dl, al
        mov     ah, 2
        int     0x21
        pop     dx
        pop     ax
        ret
puthex: push    cx
        mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 0x0f
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    call    putc
        pop     ax
        loop    .d
        pop     cx
        ret
names:  db 'AXBXCXDXSIDICS'
v_ax:   dw 0
v_bx:   dw 0
v_cx:   dw 0
v_dx:   dw 0
v_si:   dw 0
v_di:   dw 0
v_cs:   dw 0
