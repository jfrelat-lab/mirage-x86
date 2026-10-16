; xcalls.asm — what XFree86 3.3 and Xlib asked of MIRAGE-LINUX beyond sockets: link (the server's
; lock file is a temporary file linked to /tmp/.X0-lock; stat then counts 2 links), and on a socket
; ioctl FIONBIO (a read with nothing to read is EAGAIN) and FIONREAD (bytes waiting). Exit status
; bits: 0 nlink 2, 1 EAGAIN, 2 FIONREAD 1 — 7. Docker i386/debian: 7. MIRAGE: no link, ENOTTY for
; both ioctls ("XIO: fatal IO error... Not a typewriter").
;
;   nasm -f bin tools/linux/xcalls.asm -o XCALLS && chmod +x XCALLS
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
        mov     eax, 8                          ; creat("L.A", 0644)
        mov     ebx, na
        mov     ecx, 0o644
        int     0x80
        mov     eax, 9                          ; link("L.A", "L.B")
        mov     ebx, na
        mov     ecx, nb
        int     0x80
        mov     eax, 106                        ; stat("L.B"): st_nlink (u16) at 10
        mov     ebx, nb
        mov     ecx, st
        int     0x80
        cmp     word [st + 10], 2
        jne     .s
        or      edi, 1
.s:     mov     dword [args], 1                 ; socketpair(AF_UNIX, SOCK_STREAM, 0, sv)
        mov     dword [args + 4], 1
        mov     dword [args + 8], 0
        mov     dword [args + 12], sv
        mov     eax, 102
        mov     ebx, 8
        mov     ecx, args
        int     0x80
        mov     dword [one], 1                  ; ioctl(sv[0], FIONBIO, &1)
        mov     eax, 54
        mov     ebx, [sv]
        mov     ecx, 0x5421
        mov     edx, one
        int     0x80
        mov     eax, 3                          ; read(sv[0], buf, 1): nothing yet
        mov     ebx, [sv]
        mov     ecx, buf
        mov     edx, 1
        int     0x80
        cmp     eax, -11                        ; EAGAIN
        jne     .n
        or      edi, 2
.n:     mov     eax, 4                          ; write(sv[1], "x", 1)
        mov     ebx, [sv + 4]
        mov     ecx, na
        mov     edx, 1
        int     0x80
        mov     eax, 54                         ; ioctl(sv[0], FIONREAD, &n)
        mov     ebx, [sv]
        mov     ecx, 0x541b
        mov     edx, n
        int     0x80
        cmp     dword [n], 1
        jne     done
        or      edi, 4
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
na:     db      'L.A', 0
nb:     db      'L.B', 0
filesz  equ     $ - $$
st:     times 96 db 0
args:   times 6 dd 0
sv:     dd      0, 0
one:    dd      0
n:      dd      0
buf:    dd      0
memsz   equ     $ - $$
