; fbgrad.asm — what a Linux sizecoding intro does with the framebuffer: open /dev/fb0, read its size
; (FBIOGET_VSCREENINFO), map it (mmap2) and draw a gradient in 32-bit pixels — red across, green down,
; a blue frame one pixel wide on the edges — then print "fb: <width>x<height>" and exit 0.
; With an argument it keeps the picture up (pause), as an intro does: drop it on the Linux page.
;
;   nasm -f bin tools/linux/fbgrad.asm -o FBGRAD && chmod +x FBGRAD
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, memsz, 7, 0x1000
phsize  equ     $ - phdr

_start: mov     eax, 5                          ; open("/dev/fb0", O_RDWR)
        mov     ebx, fbname
        mov     ecx, 2
        int     0x80
        test    eax, eax
        js      .fail
        mov     [fd], eax
        mov     eax, 54                         ; ioctl(fd, FBIOGET_VSCREENINFO, &vinfo)
        mov     ebx, [fd]
        mov     ecx, 0x4600
        mov     edx, vinfo
        int     0x80
        test    eax, eax
        js      .fail
        mov     eax, [vinfo]                    ; size = xres * yres * 4
        imul    eax, [vinfo + 4]
        shl     eax, 2
        mov     ecx, eax
        mov     eax, 192                        ; mmap2(0, size, PROT_READ|WRITE, MAP_SHARED, fd, 0)
        xor     ebx, ebx
        mov     edx, 3
        mov     esi, 1
        mov     edi, [fd]
        push    ebp
        xor     ebp, ebp
        int     0x80
        pop     ebp
        cmp     eax, -4096
        ja      .fail
        mov     edi, eax                        ; the pixels
        xor     ebx, ebx                        ; y
.row:   xor     ecx, ecx                        ; x
.px:    mov     eax, ecx                        ; red = x * 255 / (xres - 1)
        imul    eax, eax, 255
        xor     edx, edx
        mov     esi, [vinfo]
        dec     esi
        div     esi
        shl     eax, 16
        push    eax
        mov     eax, ebx                        ; green = y * 255 / (yres - 1)
        imul    eax, eax, 255
        xor     edx, edx
        mov     esi, [vinfo + 4]
        dec     esi
        div     esi
        shl     eax, 8
        pop     edx
        or      eax, edx
        test    ecx, ecx                        ; the frame: blue on the four edges
        jz      .blue
        test    ebx, ebx
        jz      .blue
        mov     edx, [vinfo]
        dec     edx
        cmp     ecx, edx
        je      .blue
        mov     edx, [vinfo + 4]
        dec     edx
        cmp     ebx, edx
        jne     .put
.blue:  mov     eax, 0x0000ff
.put:   stosd
        inc     ecx
        cmp     ecx, [vinfo]
        jb      .px
        inc     ebx
        cmp     ebx, [vinfo + 4]
        jb      .row

        mov     eax, [vinfo]                    ; "fb: <xres>x<yres>\n"
        mov     edi, num1
        call    itoa
        mov     eax, [vinfo + 4]
        mov     edi, num2
        call    itoa
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        cmp     dword [esp], 1                  ; argc: with an argument, keep the picture up
        je      .exit
        mov     eax, 29                         ; pause
        int     0x80
.exit:  mov     eax, 1
        xor     ebx, ebx
        int     0x80
.fail:  mov     eax, 1
        mov     ebx, 1
        int     0x80

itoa:   add     edi, 3                          ; EAX as four decimal digits at EDI
        mov     ecx, 4
        mov     esi, 10
.d:     xor     edx, edx
        div     esi
        add     dl, '0'
        mov     [edi], dl
        dec     edi
        dec     ecx
        jnz     .d
        ret

fbname  db      '/dev/fb0', 0
line    db      'fb: '
num1    db      '????x'
num2    db      '????', 10
linelen equ     $ - line
filesz  equ     $ - $$
fd      equ     0x08048000 + filesz
vinfo   equ     fd + 4
memsz   equ     filesz + 4 + 160
