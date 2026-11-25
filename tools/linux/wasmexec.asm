; wasmexec.asm — an x86 process starts a WebAssembly one (src/wasi.js) as it would any program: a
; pipe written and its write end closed, then fork; the child makes the pipe its stdin and execve's
; /w/cat.wasm (tools/wasi/programs.mjs), which copies it to stdout; the parent waits and exits with
; the child's status. Expected: "through a pipe\n", 0.
;
;   nasm -f bin tools/linux/wasmexec.asm -o WASMEXEC && chmod +x WASMEXEC
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
        mov     eax, 4                          ; write(fds[1], msg, len)
        mov     ebx, [fds + 4]
        mov     ecx, msg
        mov     edx, msglen
        int     0x80
        mov     eax, 6                          ; close(fds[1])
        mov     ebx, [fds + 4]
        int     0x80
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        mov     eax, 63                         ; child: dup2(fds[0], 0)
        mov     ebx, [fds]
        xor     ecx, ecx
        int     0x80
        mov     eax, 11                         ; execve(path, argv, envp)
        mov     ebx, path
        mov     ecx, argv
        mov     edx, envp
        int     0x80
        mov     ebx, 127                        ; exit(127): execve failed
        mov     eax, 1
        int     0x80
parent: mov     eax, 114                        ; wait4(-1, &status, 0, 0)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        xor     esi, esi
        int     0x80
        movzx   ebx, byte [status + 1]          ; WEXITSTATUS
        mov     eax, 1
        int     0x80
msg:    db      'through a pipe', 10
msglen  equ     $ - msg
path:   db      '/w/cat.wasm', 0
argv:   dd      path, 0
envp:   dd      0
filesz  equ     $ - $$
fds:    dd      0, 0
status: dd      0
memsz   equ     $ - $$
