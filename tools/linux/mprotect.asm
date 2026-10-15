; mprotect.asm — a program makes its own code writable and patches it, as Quake's
; Sys_MakeCodeWriteable does before its assembly rewrites its immediates. mprotect(text, 4096,
; PROT_READ|PROT_WRITE|PROT_EXEC), then the immediate of `mov bl, 0` becomes 42: exit status 42.
; MIRAGE answered mprotect 0 and left the page read-only: the write was SIGSEGV, status 139.
;
;   nasm -f bin tools/linux/mprotect.asm -o MPROTECT && chmod +x MPROTECT
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
        dd      5                               ; R+X: the text is read-only
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     eax, 125                        ; mprotect(0x08048000, 4096, 7)
        mov     ebx, $$
        mov     ecx, 4096
        mov     edx, 7
        int     0x80
        test    eax, eax
        jnz     fail
        mov     byte [patch + 1], 42            ; the immediate of the mov below
patch:  mov     bl, 0
        mov     eax, 1                          ; exit(bl)
        int     0x80
fail:   mov     ebx, 1
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
