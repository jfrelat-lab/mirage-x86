; lazymap.asm — anonymous memory larger than the machine, as Quake II's hunks: mmap2 of 32 MiB on a
; 16 MiB machine, its first and last dwords written and read back, mprotect of a page never touched,
; and write() from another such page (the kernel reading it), then munmap. Exit status bits: 0 the
; mmap, 1 the dwords read back, 2 mprotect answered 0, 3 write() wrote its 4 bytes, 4 munmap 0 --
; 31 when all hold. Committed whole, the mmap ran out of physical memory.
;
;   nasm -f bin tools/linux/lazymap.asm -o LAZYMAP && chmod +x LAZYMAP
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, filesz, 7, 0x1000
phsize  equ     $ - phdr
SIZE    equ     32 << 20
_start: xor     edi, edi
        push    edi
        mov     eax, 192                        ; mmap2(0, SIZE, RW, PRIVATE|ANONYMOUS, -1, 0)
        xor     ebx, ebx
        mov     ecx, SIZE
        mov     edx, 3
        mov     esi, 0x22
        mov     edi, -1
        xor     ebp, ebp
        int     0x80
        pop     edi
        cmp     eax, -4096
        ja      done
        or      edi, 1
        mov     ebp, eax                        ; the mapping
        mov     dword [ebp], 0x12345678
        mov     dword [ebp + SIZE - 4], 0x9abcdef0
        cmp     dword [ebp], 0x12345678
        jne     .p
        cmp     dword [ebp + SIZE - 4], 0x9abcdef0
        jne     .p
        or      edi, 2
.p:     mov     eax, 125                        ; mprotect(map + 1 MiB, 4096, PROT_READ)
        lea     ebx, [ebp + 0x100000]
        mov     ecx, 4096
        mov     edx, 1
        int     0x80
        test    eax, eax
        jnz     .w
        or      edi, 4
.w:     mov     eax, 4                          ; write(1, map + 2 MiB, 4): four zero bytes
        mov     ebx, 1
        lea     ecx, [ebp + 0x200000]
        mov     edx, 4
        int     0x80
        cmp     eax, 4
        jne     .u
        or      edi, 8
.u:     mov     eax, 91                         ; munmap(map, SIZE)
        mov     ebx, ebp
        mov     ecx, SIZE
        int     0x80
        test    eax, eax
        jnz     done
        or      edi, 16
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
filesz  equ     $ - $$
