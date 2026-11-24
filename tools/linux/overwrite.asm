; overwrite.asm — a file the image has, written over in place: open("/etc/motd", O_WRONLY), write
; "Z" at its start, exit 0. Docker i386/busybox with a motd of "abc": the file reads "Zbc" after, in
; the container; the image's own layer is unchanged. MIRAGE-LINUX wrote into the image's tree itself
; (the bytes it had read were the tree's own), so the OASIS page's home saving did not see the change.
;
;   nasm -f bin tools/linux/overwrite.asm -o OVERWRITE && chmod +x OVERWRITE
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

_start: mov     eax, 5                          ; open("/etc/motd", O_WRONLY)
        mov     ebx, fname
        mov     ecx, 1
        xor     edx, edx
        int     0x80
        mov     ebx, eax                        ; write(fd, "Z", 1)
        mov     eax, 4
        mov     ecx, zed
        mov     edx, 1
        int     0x80
        mov     eax, 1                          ; exit(0)
        xor     ebx, ebx
        int     0x80
fname   db      '/etc/motd', 0
zed     db      'Z'
filesz  equ     $ - $$
