; envmcb.asm — the memory block a program's environment lives in, asked of the MCB in front of it:
; its type ('M' or 'Z'), whether its owner is this program's PSP, and whether the strings, the double
; NUL, the count word and the program's path all fit in the length it gives. DOS/4GW makes the
; environment a selector of exactly that length and scans it a word at a time; Heaven Seven's DOS
; version stopped on a General Protection Fault in DOS4GW.EXE when MIRAGE had no MCB there.
;
;   nasm -f bin tools/envmcb.asm -o ENVMCB.COM
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "ENVMCB.COM > OUT.TXT" -c "exit"
;
; Measured on dosbox-x, 2026-10-31:   TYPE=M OWNER=PSP FITS=Y
        org     0x100
        mov     es, [0x2c]                      ; the environment
        xor     di, di
.var:   cmp     byte [es:di], 0                 ; strings up to the empty one
        je      .end
.str:   inc     di
        cmp     byte [es:di], 0
        jne     .str
        inc     di
        jmp     .var
.end:   add     di, 3                           ; the empty string, the count word
.path:  inc     di
        cmp     byte [es:di - 1], 0
        jne     .path                           ; DI: bytes used, path's NUL included
        mov     ax, es
        dec     ax
        mov     es, ax                          ; the MCB
        mov     al, [es:0]
        mov     [type], al
        mov     ax, [es:1]
        mov     bx, cs
        cmp     ax, bx
        je      .own
        mov     word [owner], 'NO'
        mov     byte [owner + 2], 'T'
.own:   mov     ax, [es:3]                      ; paragraphs
        mov     cl, 4
        shl     ax, cl
        cmp     di, ax
        jbe     .fit
        mov     byte [fits], 'N'
.fit:   mov     dx, msg
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21
msg:    db      'TYPE='
type:   db      '?'
        db      ' OWNER='
owner:  db      'PSP'
        db      ' FITS='
fits:   db      'Y', 13, 10, '$'
