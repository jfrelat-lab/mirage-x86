; reserve.asm — a large reservation as V8 and thread stacks make one: 64 MiB of anonymous memory mapped
; PROT_NONE, then made readable and writable by mprotect, all of it at once, and one word written at its
; far end and read back. Linux commits only what is touched; on a 16 MiB machine MIRAGE committed every
; page at the mprotect and ran out of frames. Lines: mprotect's result, the word read back. Docker i386
; prints the reference lines.
;
;   nasm -f bin tools/linux/reserve.asm -o RESERVE
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, memsz, 7, 0x1000
phsize  equ     $ - phdr

_start: mov     eax, 192                ; mmap2(NULL, 64 MiB, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)
        xor     ebx, ebx
        mov     ecx, 0x4000000
        xor     edx, edx
        mov     esi, 0x22
        mov     edi, -1
        xor     ebp, ebp
        int     0x80
        mov     [base], eax
        mov     ebx, eax                ; mprotect(at, 64 MiB, PROT_READ|PROT_WRITE)
        mov     eax, 125
        mov     ecx, 0x4000000
        mov     edx, 3
        int     0x80
        call    hex
        mov     ebx, [base]
        mov     dword [ebx + 0x3fffffc], 0x600df00d
        mov     eax, [ebx + 0x3fffffc]
        call    hex
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
; eax as eight hex digits and a newline
hex:    pusha
        mov     edi, buf
        mov     ecx, 8
.dig:   rol     eax, 4
        mov     edx, eax
        and     edx, 15
        mov     dl, [digits + edx]
        mov     [edi], dl
        inc     edi
        loop    .dig
        mov     byte [edi], 10
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, buf
        mov     edx, 9
        int     0x80
        popa
        ret
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
base    equ     $$ + ((filesz + 3) & ~3)
buf     equ     base + 4
memsz   equ     filesz + 24
