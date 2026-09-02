; divzero.asm — does DOS RESUME a program after an unhandled divide error, or terminate it?
;
; The markers go to a FILE rather than the console, because the console content is not in DOSBox-X's
; log and DOS's own message may not be redirectable. If DOS terminates the program on #DE, OUT.TXT
; holds "B" alone; if it resumes, it holds "BA".
;
;   nasm -f bin tools/divzero.asm -o DIVZERO.COM
; Then run it under DOSBox-X and read OUT.TXT back out of the mounted directory.

        org 0x100
        bits 16

        ; Each marker is written AND CLOSED before anything risky happens, so what ends up on disk
        ; does not depend on DOS flushing at termination (or on the emulator being killed).
        mov     ah, 0x3c                ; create OUT.TXT
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      quit
        mov     bx, ax
        mov     ah, 0x40                ; write "B"
        mov     cx, 1
        mov     dx, markB
        int     0x21
        mov     ah, 0x3e                ; close
        int     0x21

        mov     ax, 1                   ; the divide error itself
        xor     dx, dx
        xor     cx, cx
        div     cx                      ; #DE — nothing of ours handles it

        mov     ax, 0x3d01              ; reopen for writing — only reached if DOS RESUMED us
        mov     dx, fname
        int     0x21
        jc      quit
        mov     bx, ax
        mov     ax, 0x4202              ; seek to end
        xor     cx, cx
        xor     dx, dx
        int     0x21
        mov     ah, 0x40                ; write "A"
        mov     cx, 1
        mov     dx, markA
        int     0x21
        mov     ah, 0x3e
        int     0x21

quit:   mov     ax, 0x4c00
        int     0x21

fname   db      'OUT.TXT', 0
markB   db      'B'
markA   db      'A'
