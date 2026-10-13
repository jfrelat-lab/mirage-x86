; fork.asm — fork, a child that writes and exits, a parent that waits for it: the shell's whole
; pattern (fork, exec, wait4) without the exec. The child prints "child", exits 3; the parent waits
; with wait4(-1), prints "parent", and exits with 10 + the child's exit code. Docker i386/debian:
; "child\nparent\n", status 13. MIRAGE-LINUX had no fork (-ENOSYS).
;
;   nasm -f bin tools/linux/fork.asm -o FORK && chmod +x FORK
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0         ; ELFCLASS32, little-endian, version 1, SysV
        times 8 db 0
        dw      2                               ; ET_EXEC
        dw      3                               ; EM_386
        dd      1
        dd      _start
        dd      phdr - $$
        dd      0                               ; no section headers
        dd      0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1                               ; PT_LOAD
        dd      0, $$, $$                       ; offset, vaddr, paddr
        dd      filesz, filesz
        dd      7                               ; R+W+X: [digit] is written
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     .parent
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, msgc
        mov     edx, 6
        int     0x80
        mov     eax, 1                          ; exit(3)
        mov     ebx, 3
        int     0x80
.parent:
        mov     eax, 114                        ; wait4(-1, &status, 0, 0)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        xor     esi, esi
        int     0x80
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, msgp
        mov     edx, 7
        int     0x80
        mov     ebx, [status]
        shr     ebx, 8
        and     ebx, 0xff
        add     ebx, 10
        mov     eax, 1
        int     0x80
msgc    db      'child', 10
msgp    db      'parent', 10
status  dd      0
filesz  equ     $ - $$
