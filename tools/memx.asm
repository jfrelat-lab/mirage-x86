; memx.asm — mem.asm's questions, but from an MZ EXE that reproduces a real game's memory profile.
;
; A .COM is handed all of memory by a different path than an EXE, so mem.asm cannot answer for one.
; This one declares maxalloc=0xFFFF and shrinks to 0x20a0 paragraphs — exactly what MANIAC.EXE does —
; then replays its first alloc/free cycles before asking, so the answer reflects any fragmentation
; they leave behind. It also reports the DOS version, which is the first call MANIAC makes.
;
; nasm has no linker here, so the MZ header is 32 hand-built bytes in front of a flat binary:
;   nasm -f bin tools/memx.asm -o memx.bin
;   header: 'MZ', e_cblp=total%512, e_cp=ceil(total/512), e_crlc=0, e_cparhdr=2, e_minalloc=0,
;           e_maxalloc=0xFFFF, e_ss=imageParas+1, e_sp=0x100, e_ip=0, e_cs=0, e_lfarlc=0x1c
;
; Measured 2026-08-22 — dosbox-x and MIRAGE, field for field:
;
;   LARGEST-FREE-PARAS=774A   PSP=0814   DOSVER-AX=0005
;   0x7000-FITS-AFTER-CYCLES=0001        PSP0002=9FFF
;
; Identical. Which REFUTES the memory hypothesis for Maniac Mansion's residual divergence: the map,
; the DOS version and the allocator's behaviour under alloc/free churn are indistinguishable, so
; whatever makes its allocation sizes differ is elsewhere in the prefix.
;
        bits 16
        org 0
start:
        mov     ax, cs
        mov     ds, ax
        mov     ax, es                  ; ES = PSP at entry
        mov     [psp], ax
        mov     ah, 0x30                ; DOS version — MANIAC's very first call
        int     0x21
        mov     [verp], ax
        mov     bx, 0x20a0              ; shrink exactly as MANIAC.EXE does
        mov     ah, 0x4a
        int     0x21
        ; Replay MANIAC's first three alloc/free cycles before asking, so the answer reflects any
        ; fragmentation they leave behind — a bump allocator restores everything, a real MCB free
        ; list may not.
        mov     bx, 0x4000
        call    allocfree
        mov     bx, 0x6000
        call    allocfree
        mov     ah, 0x48                ; now the request MANIAC makes at step 6
        mov     bx, 0x7000
        int     0x21
        mov     [okp], ax
        jc      .nofit
        mov     es, ax
        mov     ah, 0x49
        int     0x21
        mov     word [okp], 1
        jmp     .ask
.nofit: mov     word [okp], 0
.ask:   mov     ah, 0x48
        mov     bx, 0xffff
        int     0x21                    ; fails; BX = largest free block
        mov     [freep], bx
        mov     es, [psp]
        mov     ax, [es:2]
        mov     [top], ax
        mov     si, m1
        call    puts
        mov     ax, [freep]
        call    puthex
        call    crlf
        mov     si, m2
        call    puts
        mov     ax, [psp]
        call    puthex
        call    crlf
        mov     si, m5
        call    puts
        mov     ax, [verp]
        call    puthex
        call    crlf
        mov     si, m4
        call    puts
        mov     ax, [okp]
        call    puthex
        call    crlf
        mov     si, m3
        call    puts
        mov     ax, [top]
        call    puthex
        call    crlf
        mov     ax, 0x4c00
        int     0x21
allocfree:
        mov     ah, 0x48
        int     0x21
        jc      .no
        mov     es, ax
        mov     ah, 0x49
        int     0x21
.no:    ret
puts:   lodsb
        or      al, al
        jz      .d
        call    putc
        jmp     puts
.d:     ret
putc:   push    ax
        push    dx
        mov     dl, al
        mov     ah, 2
        int     0x21
        pop     dx
        pop     ax
        ret
crlf:   mov     al, 13
        call    putc
        mov     al, 10
        jmp     putc
puthex: push    cx
        mov     cx, 4
.n:     rol     ax, 4
        push    ax
        and     al, 0x0f
        add     al, '0'
        cmp     al, '9'
        jbe     .k
        add     al, 7
.k:     call    putc
        pop     ax
        loop    .n
        pop     cx
        ret
m1: db 'LARGEST-FREE-PARAS=', 0
m2: db 'PSP=', 0
m3: db 'PSP0002=', 0
m4: db '0x7000-FITS-AFTER-CYCLES=', 0
m5: db 'DOSVER-AX=', 0
psp:   dw 0
freep: dw 0
top:   dw 0
okp:   dw 0
verp:  dw 0
