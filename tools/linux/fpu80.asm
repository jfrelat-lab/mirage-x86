; fpu80.asm — an 80-bit x87 store and load on the stack, which a Linux program keeps at BFFFxxxxh:
; far above the end of physical memory, so only paging puts it anywhere. 1 + 2 is stored as a TBYTE,
; read back, and returned as the exit status: 3. MIRAGE masked the store's LINEAR address to the size
; of RAM and wrote it into an unmapped page — SIGSEGV, status 139. musl's printf("%f") does exactly
; this with its long double argument.
;
;   nasm -f bin tools/linux/fpu80.asm -o FPU80 && chmod +x FPU80
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

_start: fld1
        fld1
        fadd    st0, st0
        faddp   st1, st0
        fstp    tword [esp - 32]
        fld     tword [esp - 32]
        fistp   dword [esp - 8]
        mov     ebx, [esp - 8]
        mov     eax, 1                          ; exit
        int     0x80
filesz  equ     $ - $$
