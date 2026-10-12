; ud2.asm — an invalid opcode is the program's SIGILL: status 132 under Docker i386/debian. MIRAGE
; stopped with "unimplemented opcode 0x0f 0x0b" (gcc's 20101011-1, __builtin_trap).
;
;   nasm -f bin tools/linux/ud2.asm -o UD2 && chmod +x UD2
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

_start: ud2
filesz  equ     $ - $$
