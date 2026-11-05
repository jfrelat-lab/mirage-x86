; rtmhost.asm — what Borland's RTM (Jazz Jackrabbit) needs from a DPMI host, one check per letter.
; A 16-bit client; each check writes '1' or '0' into its slot, and the line goes to RTMHOST.TXT.
;
;   V  0400h Get Version: AX = 005Ah, CL = 3 (MIRAGE's default CPU profile is a 386)
;   M  INT 2Fh AX=168Ah "MS-DOS": AL = 0, and its entry with AX=0100h hands back a selector that
;      reads the LDT (our own CS's access byte, FAh, through it)
;   I  INT 21h AH=34h in protected mode: ES:BX is loadable and reads the InDOS flag (0)
;   G  INT 21h AH=35h in protected mode: the protected-mode vector, as 0204h reports it
;   P  INT 21h AH=51h/62h return a PSP selector whose base is the PSP; AH=50h takes it back
;   F  INT 10h AX=1130h: ES is loadable
;   D  INT 10h AX=1012h with ES a selector: the DAC entry reads back through 3C7h/3C9h
;   N  LES with a not-present selector: the #NP handler (0203h) runs, scribbles below the client's
;      SP as RTM's does, marks the descriptor present, and the LES is restarted
;   R  0306h raw switch to real mode and back, then CLI/STI at ring 3 (IOPL 3) and the stack intact
;
;   nasm -f bin tools/rtmhost.asm -o RTMHOST.COM
        org     0x100
        bits    16
        mov     ah, 0x4a
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
        xor     ax, ax
        call    far [entry]
        jc      near quit
        mov     [pmcs], cs
        mov     [pmds], ds
        mov     [pmss], ss

; ---- V
        mov     ax, 0x400
        xor     cx, cx
        int     0x31
        cmp     ax, 0x005a
        jne     .v0
        cmp     cl, 3
        jne     .v0
        mov     byte [res + 0], '1'
.v0:
; ---- M
        mov     ax, 0x168a
        mov     si, msdos
        int     0x2f
        test    al, al
        jnz     .m0
        mov     [vend], di
        mov     [vend + 2], es
        mov     ax, 0x100
        call    far [vend]
        jc      .m0
        mov     fs, ax
        mov     bx, cs
        and     bx, 0xfff8
        cmp     byte [fs:bx + 5], 0xfa
        jne     .m0
        mov     byte [res + 1], '1'
.m0:
; ---- I
        mov     ah, 0x34
        int     0x21
        cmp     byte [es:bx], 0
        jne     .i0
        mov     byte [res + 2], '1'
.i0:
; ---- G
        mov     ax, 0x204
        mov     bl, 0x09
        int     0x31
        mov     [v09], dx
        mov     [v09 + 2], cx
        mov     ax, 0x3509
        int     0x21
        cmp     bx, [v09]
        jne     .g0
        mov     ax, es
        cmp     ax, [v09 + 2]
        jne     .g0
        mov     byte [res + 3], '1'
.g0:
; ---- P
        mov     ah, 0x51
        int     0x21
        mov     [psel], bx
        mov     ax, 6
        int     0x31
        mov     ax, [rseg]
        rol     ax, 4
        mov     bx, ax
        and     ax, 0xfff0
        and     bx, 0x000f
        cmp     dx, ax
        jne     .p0
        cmp     cx, bx
        jne     .p0
        mov     bx, [psel]
        mov     ah, 0x50
        int     0x21
        mov     ah, 0x62
        int     0x21
        cmp     bx, [psel]
        jne     .p0
        mov     byte [res + 4], '1'
.p0:
; ---- F
        push    bp
        mov     ax, 0x1130
        mov     bh, 6
        int     0x10
        pop     bp
        mov     ax, es
        mov     fs, ax
        mov     byte [res + 5], '1'
; ---- D
        push    ds
        pop     es
        mov     ax, 0x1012
        mov     bx, 1
        mov     cx, 1
        mov     dx, rgb
        int     0x10
        mov     dx, 0x3c7
        mov     al, 1
        out     dx, al
        mov     dx, 0x3c9
        in      al, dx
        mov     ah, al
        in      al, dx
        cmp     ax, 0x1122
        jne     .d0
        in      al, dx
        cmp     al, 0x33
        jne     .d0
        mov     byte [res + 6], '1'
.d0:
; ---- N
        xor     ax, ax
        mov     cx, 1
        int     0x31
        jc      near .n0
        mov     [nsel], ax
        mov     bx, ax
        mov     ax, 7                   ; base = our DS's
        mov     cx, [rseg]
        rol     cx, 4
        mov     dx, cx
        and     dx, 0xfff0
        and     cx, 0x000f
        int     0x31
        mov     ax, 8
        mov     bx, [nsel]
        xor     cx, cx
        mov     dx, 0xffff
        int     0x31
        mov     ax, 9                   ; data RW, DPL 3, NOT present
        mov     bx, [nsel]
        mov     cx, 0x0072
        int     0x31
        mov     ax, 0x203
        mov     bl, 0x0b
        mov     cx, cs
        mov     dx, nphand
        int     0x31
        mov     ax, [nsel]
        mov     [nptr + 2], ax
        mov     di, 0x1234
        les     di, [nptr]
        cmp     di, 0x5678
        jne     .n0
        mov     ax, es
        cmp     ax, [nsel]
        jne     .n0
        cmp     byte [nhit], 1
        jne     .n0
        mov     byte [res + 7], '1'
.n0:
; ---- R
        mov     ax, 0x306
        int     0x31
        mov     [r2p], cx
        mov     [r2p + 2], bx
        mov     [p2r], di
        mov     [p2r + 2], si
        mov     [savsp], sp
        mov     ax, [rseg]
        mov     cx, ax
        mov     dx, ax
        mov     bx, sp
        mov     si, ax
        mov     di, inreal
        jmp     far [p2r]
inreal: mov     ax, cs                  ; real mode now: CS is the paragraph again
        cmp     ax, [rseg]
        jne     .rbad
        mov     byte [rreal], 1
.rbad:  push    word 0x0202         ; real-mode flags as DOS leaves them: IOPL 0
        popf
        mov     ax, [pmds]
        mov     cx, ax
        mov     dx, [pmss]
        mov     bx, [savsp]
        mov     si, [pmcs]
        mov     di, inprot
        jmp     far [r2p]
inprot: cli
        sti
        cmp     sp, [savsp]
        jne     .r0
        cmp     byte [rreal], 1
        jne     .r0
        mov     byte [res + 8], '1'
.r0:
; ---- write the line
        push    ds
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

; The #NP handler, RTM's way: the frame is ret CS:IP, error, CS:IP, flags, SP, SS (16-bit client).
nphand: push    bp
        mov     bp, sp
        push    ax
        push    bx
        push    es
        mov     es, [bp + 16]           ; the faulting SS:SP
        mov     bx, [bp + 14]
        mov     word [es:bx - 2], 0xdead    ; below the client's SP: the client's to lose, not ours
        mov     word [es:bx - 4], 0xdead
        mov     word [es:bx - 6], 0xdead
        mov     word [es:bx - 8], 0xdead
        mov     word [es:bx - 10], 0xdead
        mov     word [es:bx - 12], 0xdead
        mov     word [es:bx - 14], 0xdead
        mov     word [es:bx - 16], 0xdead
        mov     ax, 9
        mov     bx, [nsel]
        mov     cx, 0x00f2              ; present now
        int     0x31
        mov     byte [nhit], 1
        pop     es
        pop     bx
        pop     ax
        pop     bp
        retf

fname   db      'RTMHOST.TXT', 0
msdos   db      'MS-DOS', 0
res     db      '000000000', 13, 10
reslen  equ     $ - res
rgb     db      0x11, 0x22, 0x33
rseg    dw      0
handle  dw      0
entry   dd      0
vend    dd      0
v09     dd      0
psel    dw      0
nsel    dw      0
nptr    dw      0x5678, 0
nhit    db      0
rreal   db      0
pmcs    dw      0
pmds    dw      0
pmss    dw      0
savsp   dw      0
r2p     dd      0
p2r     dd      0
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
