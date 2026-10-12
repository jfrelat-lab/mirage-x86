; sigabrt.asm — the stack grows on demand, and a signal sent to oneself takes its default action.
; A byte is written 2 MiB below ESP (a kernel maps the stack's pages as they are touched, up to
; RLIMIT_STACK), then tkill(getpid(), SIGABRT) — what abort() does. Docker i386/debian: status 134.
; MIRAGE mapped 256 KiB of stack and no more (SIGSEGV, 139), and did not know tkill.
;
;   nasm -f bin tools/linux/sigabrt.asm -o SIGABRT && chmod +x SIGABRT
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
        dd      5                               ; R+X
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     byte [esp - 0x200000], 1
        mov     eax, 20                         ; getpid
        int     0x80
        mov     ebx, eax
        mov     eax, 238                        ; tkill
        mov     ecx, 6                          ; SIGABRT
        int     0x80
        mov     eax, 1                          ; not reached: exit(0)
        xor     ebx, ebx
        int     0x80
filesz  equ     $ - $$
