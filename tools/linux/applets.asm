; applets.asm — a stand-in for busybox in OASIS's busybox layer test: it answers like `busybox --list`
; (one applet per line, busybox itself among them) and exits 0.
;
;   nasm -f bin tools/linux/applets.asm -o APPLETS
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, filesz, 5, 0x1000
phsize  equ     $ - phdr
_start: mov     eax, 4                          ; write(1, list, len)
        mov     ebx, 1
        mov     ecx, list
        mov     edx, len
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
list:   db      'ls', 10, 'busybox', 10, 'cat', 10
len     equ     $ - list
filesz  equ     $ - $$
