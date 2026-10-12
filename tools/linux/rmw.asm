; rmw.asm — read-modify-write on the stack, in a loop hot enough to be translated: the paged fast
; path, at a linear address (BFFFxxxxh) far above its physical page. 21 is shifted left once in
; memory and added to itself through memory; exit status 84. The fast path's write probe and the
; read inside its value once shared one scratch variable (gcc's loop-13 aborted).
; Docker i386/debian: 84.
;
;   nasm -f bin tools/linux/rmw.asm -o RMW && chmod +x RMW
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

_start: mov     ecx, 1000
.l:     mov     dword [esp - 8], 21
        shl     dword [esp - 8], 1
        mov     eax, [esp - 8]
        add     [esp - 8], eax
        dec     ecx
        jnz     .l
        mov     ebx, [esp - 8]
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
