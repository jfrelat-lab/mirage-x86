; mem.asm — the three numbers ROADMAP G1 is really about, asked of DOS directly.
;
; A program's alloc/free binary search converges on ONE value: the largest free block. AH=48h with
; BX=FFFF always fails and returns exactly that, in paragraphs. PSP:0002 is the other half — the top
; of the block the loader handed over — and CS is the PSP segment.
;
;   nasm -f bin tools/mem.asm -o MEM.COM
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "MEM.COM > OUT.TXT" -c "exit"
;
; It shrinks its own block to 0x100 paragraphs first, because a .COM is handed ALL of memory and
; would otherwise report no free block at all — which is what the first run of this said, and it was
; not a result.
;
; Measured on dosbox-x, 2026-08-22:
;
;   LARGEST-FREE-PARAS=96EA   PSP=0814   PSP0002=9FFF
;
; Three facts fall out of that. The top of conventional memory is 0x9FFF, not 0xA000. The largest
; free block excludes the paragraph its own MCB header takes (0x9fff - allocTop - 1). And PSP:0002
; is written ONCE by the loader: it still reads 9FFF after the program shrank to 0x100 paragraphs,
; so AH=4Ah does not revise it.
;
        org 0x100
start:  mov     ah, 0x4a                ; first shrink our own block to 0x100 paragraphs,
        mov     bx, 0x100               ; as every real program does before allocating
        push    cs
        pop     es
        int     0x21
        mov     ah, 0x48
        mov     bx, 0xffff
        int     0x21                    ; fails; BX = largest free block, in paragraphs
        mov     si, msg_free
        call    puts
        mov     ax, bx
        call    puthex
        call    crlf
        mov     si, msg_psp
        call    puts
        mov     ax, cs
        call    puthex
        call    crlf
        mov     si, msg_top
        call    puts
        mov     ax, [0x0002]            ; PSP:0002 — first paragraph past this program's block
        call    puthex
        call    crlf
        mov     ax, 0x4c00
        int     0x21
puts:   lodsb
        or      al, al
        jz      .done
        call    putc
        jmp     puts
.done:  ret
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
msg_free: db 'LARGEST-FREE-PARAS=', 0
msg_psp:  db 'PSP=', 0
msg_top:  db 'PSP0002=', 0
