; ioperm.asm — ioperm(2) opens ports in the task's I/O permission bitmap, which the CPU consults for
; IN/OUT at CPL 3 whatever IOPL is: ioperm(81h, 1, 1), then iopl(0), then OUT to port 81h and an
; exit with status 5. SVGAlib (id's Linux DOOM) does ioperm, iopl(3), iopl(0) and goes on driving
; the card. MIRAGE-LINUX had no TSS: the OUT was #GP, SIGSEGV, 139. (Linux semantics; Docker's
; qemu-user cannot grant ports, so there is no oracle run.)
;
;   nasm -f bin tools/linux/ioperm.asm -o IOPERM && chmod +x IOPERM
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

_start: mov     eax, 101                        ; ioperm(0x81, 1, 1)
        mov     ebx, 0x81
        mov     ecx, 1
        mov     edx, 1
        int     0x80
        mov     eax, 110                        ; iopl(0)
        xor     ebx, ebx
        int     0x80
        mov     al, 0x5a
        out     0x81, al
        mov     eax, 1
        mov     ebx, 5
        int     0x80
filesz  equ     $ - $$
