; tsrpm.asm — a parent EXECs a child that goes resident FROM PROTECTED MODE, as Jazz Jackrabbit's stub
; EXECs Borland's RTM. Writes TSRPM.TXT: "AX=xxxx P=<path>", the AH=4Dh answer (0300h: the child
; stayed resident, AL 0) and the program path at the end of the parent's environment, which the child
; shared and which must still name the parent. Coming back at all is the third check: the parent's
; segments, reloaded with PE still set, were #GP(segment).
;
;   nasm -f bin tools/tsrpm.asm -o TSRPM.COM          (and tools/tsrpmc.asm -o TSRPMC.COM beside it)
        org     0x100
        bits    16
        mov     sp, stk
        mov     ah, 0x4a
        mov     bx, 0x100               ; 4 KiB: room for the child above us
        int     0x21
        mov     ax, [0x2c]
        mov     [pb], ax                ; the child gets OUR environment, by segment
        mov     [pb + 4], cs
        mov     ax, 0x4b00
        mov     dx, child
        mov     bx, pb
        int     0x21
        jc      quit
        mov     ax, cs
        mov     ds, ax
        mov     es, ax
        mov     ah, 0x4d
        int     0x21
        mov     di, res + 3
        call    hex16
        push    ds                      ; the path after the environment's double NUL and word 1
        mov     ds, [0x2c]
        xor     si, si
.scan:  lodsb
        test    al, al
        jnz     .scan
        lodsb
        test    al, al
        jnz     .scan
        lodsw
        mov     di, path
.copy:  lodsb
        test    al, al
        jz      .done
        stosb
        jmp     .copy
.done:  pop     ds
        mov     ax, 0x0a0d
        stosw
        mov     cx, di
        sub     cx, res
        push    cx
        mov     ah, 0x3c
        xor     cx, cx
        mov     dx, fname
        int     0x21
        pop     cx
        jc      quit
        mov     bx, ax
        mov     ah, 0x40
        mov     dx, res
        int     0x21
quit:   mov     ax, 0x4c00
        int     0x21

hex16:  mov     cx, 4
.d:     rol     ax, 4
        push    ax
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .o
        add     al, 7
.o:     mov     [di], al
        inc     di
        pop     ax
        loop    .d
        ret

child   db      'TSRPMC.COM', 0
fname   db      'TSRPM.TXT', 0
pb      dw      0, tail, 0, 0, 0, 0, 0
tail    db      0, 13
res     db      'AX=???? P='
path    times 80 db 0
        times 256 db 0
stk:
