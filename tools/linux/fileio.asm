; fileio.asm — the file system calls by number, no libc: open(O_CREAT|O_RDWR) a new file in the
; working directory, write "abcdef", lseek to 2, read 3 bytes, fstat64 for the size; then print the
; three bytes and the size digit, and exit with the descriptor number open returned (3).
; Docker i386/debian: "cde6", status 3.
;
;   nasm -f bin tools/linux/fileio.asm -o FILEIO && chmod +x FILEIO
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
        dd      filesz, 0x1100                  ; memsz: statbuf's page too
        dd      7                               ; R+W+X
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     eax, 5                          ; open
        mov     ebx, fname
        mov     ecx, 0x42                       ; O_RDWR | O_CREAT
        mov     edx, 0o644
        int     0x80
        mov     edi, eax                        ; the descriptor
        mov     eax, 4                          ; write
        mov     ebx, edi
        mov     ecx, text
        mov     edx, 6
        int     0x80
        mov     eax, 19                         ; lseek(fd, 2, SEEK_SET)
        mov     ebx, edi
        mov     ecx, 2
        xor     edx, edx
        int     0x80
        mov     eax, 3                          ; read 3
        mov     ebx, edi
        mov     ecx, got
        mov     edx, 3
        int     0x80
        mov     eax, 197                        ; fstat64
        mov     ebx, edi
        mov     ecx, statbuf
        int     0x80
        mov     al, [statbuf + 44]              ; st_size, low byte
        add     al, '0'
        mov     [got + 3], al
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, got
        mov     edx, 4
        int     0x80
        mov     eax, 1
        mov     ebx, edi
        int     0x80

fname   db      'fileio.tmp', 0
text    db      'abcdef'
got     db      '????'
filesz  equ     $ - $$
statbuf equ     0x08049000
