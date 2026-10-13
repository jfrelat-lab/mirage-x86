; lsroot.asm — how many entries / has: open("/", O_DIRECTORY), getdents64 until it returns 0, and the
; count as the exit status ("." and ".." included). Under Docker's i386/debian: 22. MIRAGE
; listed only the directories it had made or looked up itself (dev, tmp...), not the root on the host.
;
;   nasm -f bin tools/linux/lsroot.asm -o LSROOT && chmod +x LSROOT
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
        dd      filesz, 0x2000                  ; memsz: the dirent buffer's page too
        dd      7                               ; R+W+X: [digit] is written
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     eax, 5                          ; open("/", O_RDONLY|O_DIRECTORY)
        mov     ebx, root
        mov     ecx, 0x10000
        int     0x80
        mov     edi, eax
        xor     ebp, ebp                        ; entries
.more:  mov     eax, 220                        ; getdents64(fd, buf, 4096)
        mov     ebx, edi
        mov     ecx, buf
        mov     edx, 4096
        int     0x80
        test    eax, eax
        jle     .done
        mov     esi, buf
        lea     edx, [buf + eax]
.rec:   inc     ebp
        movzx   ecx, word [esi + 16]            ; d_reclen
        add     esi, ecx
        cmp     esi, edx
        jb      .rec
        jmp     .more
.done:  mov     eax, 1
        mov     ebx, ebp
        int     0x80
root    db      '/', 0
filesz  equ     $ - $$
buf     equ     0x08049000
