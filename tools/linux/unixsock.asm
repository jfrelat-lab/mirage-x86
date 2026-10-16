; unixsock.asm — a Unix stream socket between two processes, as an X server and its client use one:
; socket, bind to an abstract name, listen; fork; the child connects, writes "hi" and exits; the
; parent accepts, reads "hi", then reads the end (0) once the child is gone, and waits for it.
; Exit status: 1 for "hi", 2 for the end — 3. Through socketcall (102), as libc5 and glibc call it.
; Docker i386/debian: 3. MIRAGE had no sockets.
;
;   nasm -f bin tools/linux/unixsock.asm -o UNIXSOCK && chmod +x UNIXSOCK
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
%macro NET 1                                    ; socketcall(%1, args)
        mov     eax, 102
        mov     ebx, %1
        mov     ecx, args
        int     0x80
%endmacro
_start: xor     edi, edi
        mov     dword [args], 1                 ; socket(AF_UNIX, SOCK_STREAM, 0)
        mov     dword [args + 4], 1
        mov     dword [args + 8], 0
        NET     1
        mov     [sfd], eax
        mov     [args], eax                     ; bind(sfd, addr, len)
        mov     dword [args + 4], addr
        mov     dword [args + 8], addrlen
        NET     2
        mov     dword [args + 4], 1             ; listen(sfd, 1)
        NET     4
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        mov     dword [args], 1                 ; child: socket, connect, write "hi", exit
        mov     dword [args + 4], 1
        mov     dword [args + 8], 0
        NET     1
        mov     esi, eax
        mov     [args], eax
        mov     dword [args + 4], addr
        mov     dword [args + 8], addrlen
        NET     3
        mov     eax, 4
        mov     ebx, esi
        mov     ecx, hi
        mov     edx, 2
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
parent: mov     eax, [sfd]                      ; accept(sfd, 0, 0)
        mov     [args], eax
        mov     dword [args + 4], 0
        mov     dword [args + 8], 0
        NET     5
        mov     [cfd], eax
        mov     eax, 3                          ; read(cfd, buf, 2)
        mov     ebx, [cfd]
        mov     ecx, buf
        mov     edx, 2
        int     0x80
        cmp     word [buf], 'hi'
        jne     .eof
        or      edi, 1
.eof:   mov     eax, 3                          ; read(cfd, buf, 2): the end, once the child is gone
        mov     ebx, [cfd]
        mov     ecx, buf
        mov     edx, 2
        int     0x80
        test    eax, eax
        jnz     .w
        or      edi, 2
.w:     mov     eax, 114                        ; wait4(-1, 0, 0, 0)
        mov     ebx, -1
        xor     ecx, ecx
        xor     edx, edx
        xor     esi, esi
        int     0x80
        mov     ebx, edi
        mov     eax, 1
        int     0x80
addr:   dw      1                               ; AF_UNIX, abstract "\0mirage-x"
        db      0, 'mirage-x'
addrlen equ     $ - addr
hi:     db      'hi'
filesz  equ     $ - $$
sfd:    dd      0
cfd:    dd      0
args:   times 6 dd 0
buf:    dd      0
memsz   equ     $ - $$
