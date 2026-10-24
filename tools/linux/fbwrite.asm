; fbwrite.asm — writes to /dev/fb0 as fb_write takes them (drivers/video/fbdev/core/fb_io_fops.c, with
; rw_verify_area's MAX_RW_COUNT): prints "fbw: " then a letter per check (Y holds, N does not), exits 0.
;
;   A  pwrite64 at offset 0 with a count of BE570E00h (Outline 2026's attraction & decay passes what
;      EDX holds) from a buffer of the frame's size: the frame is written, the count answered is the
;      framebuffer's size (xres * yres * 4), not EFAULT
;   B  write from a buffer whose second page is not mapped: the first page goes (4096), not EFAULT
;   C  write at the framebuffer's end: nothing goes, ENOSPC
;
; The kernel is the oracle (no framebuffer in Docker): MIRAGE answered EFAULT to A and B.
;
;   nasm -f bin tools/linux/fbwrite.asm -o FBWRITE && chmod +x FBWRITE
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
        mov     [fd], eax
        mov     eax, 54                         ; ioctl(fd, FBIOGET_VSCREENINFO, &vinfo)
        mov     ebx, [fd]
        mov     ecx, 0x4600
        mov     edx, vinfo
        int     0x80
        mov     eax, [vinfo]                    ; size = xres * yres * 4
        imul    eax, [vinfo + 4]
        shl     eax, 2
        mov     [size], eax
        mov     ecx, eax                        ; a buffer of that size, and one page more for B
        add     ecx, 0x2000
        mov     eax, 192                        ; mmap2(0, size + 8K, RW, PRIVATE|ANON, -1, 0)
        xor     ebx, ebx
        mov     edx, 3
        mov     esi, 0x22
        mov     edi, -1
        push    ebp
        xor     ebp, ebp
        int     0x80
        pop     ebp
        mov     [buf], eax
        ; ---- A ----
        mov     eax, 181                        ; pwrite64(fd, buf, BE570E00h, 0, 0)
        mov     ebx, [fd]
        mov     ecx, [buf]
        mov     edx, 0xbe570e00
        xor     esi, esi
        xor     edi, edi
        int     0x80
        mov     dl, 'N'
        cmp     eax, [size]
        jne     .a
        mov     dl, 'Y'
.a:     mov     [res], dl
        ; ---- B ----
        mov     eax, 91                         ; munmap(the buffer's last page): one page then a hole
        mov     ebx, [buf]
        add     ebx, [size]
        add     ebx, 0x1000
        mov     ecx, 0x1000
        int     0x80
        mov     eax, 19                         ; lseek(fd, 0, SEEK_SET)
        mov     ebx, [fd]
        xor     ecx, ecx
        xor     edx, edx
        int     0x80
        mov     eax, 4                          ; write(fd, the page before the hole, 8192)
        mov     ebx, [fd]
        mov     ecx, [buf]
        add     ecx, [size]
        mov     edx, 8192
        int     0x80
        mov     dl, 'N'
        cmp     eax, 4096
        jne     .b
        mov     dl, 'Y'
.b:     mov     [res + 1], dl
        ; ---- C ----
        mov     eax, 19                         ; lseek(fd, size, SEEK_SET)
        mov     ebx, [fd]
        mov     ecx, [size]
        xor     edx, edx
        int     0x80
        mov     eax, 4                          ; write(fd, buf, 16): ENOSPC (-28)
        mov     ebx, [fd]
        mov     ecx, [buf]
        mov     edx, 16
        int     0x80
        mov     dl, 'N'
        cmp     eax, -28
        jne     .c
        mov     dl, 'Y'
.c:     mov     [res + 2], dl
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

fbname  db      '/dev/fb0', 0
line    db      'fbw: '
res     db      '???', 10
linelen equ     $ - line
filesz  equ     $ - $$
fd      equ     0x08048000 + filesz
size    equ     fd + 4
buf     equ     fd + 8
vinfo   equ     fd + 12
memsz   equ     filesz + 12 + 160
