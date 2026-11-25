; sigpipe.asm — writes into a pipe nobody reads. pipe, close the read end, fork; the child writes and
; is killed by SIGPIPE; the parent waits, then writes too: as PID 1 (a container's init, which the
; kernel spares a signal left to its default) it gets EPIPE instead. Exit: the child's signal plus
; the parent's errno, 13 + 32. Docker i386/debian: 45. MIRAGE-LINUX kept the bytes and returned their
; count -- `yes | head -3` never ended -- and exited 0.
;
;   nasm -f bin tools/linux/sigpipe.asm -o SIGPIPE && chmod +x SIGPIPE
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
        mov     eax, 6                          ; close(fds[0])
        mov     ebx, [fds]
        int     0x80
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        call    put                             ; child: killed here
        xor     ebx, ebx
        mov     eax, 1
        int     0x80
parent: mov     eax, 114                        ; wait4(-1, &status, 0, 0)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        xor     esi, esi
        int     0x80
        call    put                             ; -EPIPE
        neg     eax
        movzx   ebx, byte [status]              ; WTERMSIG
        and     ebx, 0x7f
        add     ebx, eax
        mov     eax, 1
        int     0x80
put:    mov     eax, 4                          ; write(fds[1], "X", 1)
        mov     ebx, [fds + 4]
        mov     ecx, x
        mov     edx, 1
        int     0x80
        ret
x:      db      'X'
filesz  equ     $ - $$
fds:    dd      0, 0
status: dd      0
memsz   equ     $ - $$
