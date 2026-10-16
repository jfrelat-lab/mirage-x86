; pipewait.asm — two processes at once: the child reads a pipe before its parent has written to it,
; and must wait for the byte. pipe, fork; child: read(p[0], 1) then exit(byte); parent: write 'X',
; wait4, exit(the child's status). Docker i386/debian: 88 ('X'). One process at a time, the child
; ran first, found the pipe empty, read EOF and exited 0.
;
;   nasm -f bin tools/linux/pipewait.asm -o PIPEWAIT && chmod +x PIPEWAIT
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
_start: mov     eax, 42                         ; pipe(fds)
        mov     ebx, fds
        int     0x80
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        mov     eax, 3                          ; child: read(fds[0], buf, 1)
        mov     ebx, [fds]
        mov     ecx, buf
        mov     edx, 1
        int     0x80
        movzx   ebx, byte [buf]                 ; exit(byte)
        mov     eax, 1
        int     0x80
parent: mov     eax, 4                          ; write(fds[1], "X", 1)
        mov     ebx, [fds + 4]
        mov     ecx, x
        mov     edx, 1
        int     0x80
        mov     eax, 114                        ; wait4(-1, &status, 0, 0)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        xor     esi, esi
        int     0x80
        movzx   ebx, byte [status + 1]          ; WEXITSTATUS
        mov     eax, 1
        int     0x80
x:      db      'X'
filesz  equ     $ - $$
fds:    dd      0, 0
buf:    dd      0
status: dd      0
memsz   equ     $ - $$
