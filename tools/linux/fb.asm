; fb.asm — /dev/fb0 as fbset, fbsplash and Xfbdev use it (linux/fb.h): FBIOGET_VSCREENINFO (640x480,
; 32 bits), FBIOGET_FSCREENINFO (line_length 2560), mmap of the framebuffer, a pixel written there
; and read back through read() at its offset. Exit status bits: 0 xres, 1 yres, 2 bpp, 3 line_length,
; 4 mmap, 5 the pixel read back — 63 when all hold. Without /dev/fb0 the open failed: 0.
;
;   nasm -f bin tools/linux/fb.asm -o FB && chmod +x FB
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
_start: xor     edi, edi
        mov     eax, 5                          ; open("/dev/fb0", O_RDWR)
        mov     ebx, path
        mov     ecx, 2
        int     0x80
        test    eax, eax
        js      done
        mov     [fd], eax
        mov     eax, 54                         ; ioctl(fd, FBIOGET_VSCREENINFO, var)
        mov     ebx, [fd]
        mov     ecx, 0x4600
        mov     edx, var
        int     0x80
        cmp     dword [var], 640
        jne     .y
        or      edi, 1
.y:     cmp     dword [var + 4], 480
        jne     .b
        or      edi, 2
.b:     cmp     dword [var + 24], 32
        jne     .f
        or      edi, 4
.f:     mov     eax, 54                         ; ioctl(fd, FBIOGET_FSCREENINFO, fix)
        mov     ebx, [fd]
        mov     ecx, 0x4602
        mov     edx, fix
        int     0x80
        cmp     dword [fix + 44], 2560
        jne     .m
        or      edi, 8
.m:     mov     eax, 192                        ; mmap2(0, 640*480*4, RW, MAP_SHARED, fd, 0)
        xor     ebx, ebx
        mov     ecx, 640 * 480 * 4
        mov     edx, 3
        mov     esi, 1
        push    ebp
        mov     ebp, 0
        push    edi
        mov     edi, [fd]
        int     0x80
        pop     edi
        pop     ebp
        cmp     eax, -4096
        ja      done
        or      edi, 16
        mov     dword [eax + 4], 0x00ff00ff     ; pixel (1, 0): magenta
        mov     eax, 19                         ; lseek(fd, 4, SEEK_SET)
        mov     ebx, [fd]
        mov     ecx, 4
        xor     edx, edx
        int     0x80
        mov     eax, 3                          ; read(fd, px, 4)
        mov     ebx, [fd]
        mov     ecx, px
        mov     edx, 4
        int     0x80
        cmp     dword [px], 0x00ff00ff
        jne     done
        or      edi, 32
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
path:   db      '/dev/fb0', 0
filesz  equ     $ - $$
fd:     dd      0
px:     dd      0
var:    times 160 db 0
fix:    times 68 db 0
memsz   equ     $ - $$
