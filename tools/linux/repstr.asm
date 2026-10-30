; repstr.asm — REP STOS and REP MOVS under paging, as a synthesizer clears and copies its buffers:
; bytes, words and dwords, a value all of one byte and one not, across a page boundary, at an odd
; address, backwards (DF=1), and copies that overlap either way (the destination inside the source
; repeats its pattern). A checksum of the three pages they wrote is printed, as Docker i386 prints it.
;
;   nasm -f bin tools/linux/repstr.asm -o REPSTR
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
buf     equ     $$ + 0x1000                     ; three pages of their own, zeroed
_start: cld
        mov     edi, buf + 0xff1                ; words across the first page's end, odd address
        mov     eax, 0x1234
        mov     ecx, 300
        rep     stosw
        mov     edi, buf + 0x400                ; zero dwords (one byte value) over part of it
        xor     eax, eax
        mov     ecx, 200
        rep     stosd
        mov     edi, buf + 0x1f00               ; bytes across the second page's end
        mov     al, 0x5a
        mov     ecx, 0x203
        rep     stosb
        mov     edi, buf + 0x2010               ; dwords not of one byte
        mov     eax, 0x89abcdef
        mov     ecx, 77
        rep     stosd
        std                                     ; backwards: words down from 0x1810
        mov     edi, buf + 0x1810
        mov     eax, 0x4747
        mov     ecx, 40
        rep     stosw
        cld
        mov     esi, buf + 0xff0                ; a copy into another page, across the source's end
        mov     edi, buf + 0x2800
        mov     ecx, 0x41
        rep     movsd
        mov     esi, buf + 0x2010               ; overlapping: the destination 3 bytes into the source
        mov     edi, buf + 0x2013
        mov     ecx, 0x101
        rep     movsb
        mov     esi, buf + 0x1f10               ; overlapping the other way: memmove's result
        mov     edi, buf + 0x1f08
        mov     ecx, 0x90
        rep     movsw
        mov     esi, buf                        ; the checksum: h = h * 31 + dword, over three pages
        mov     ecx, 3 * 1024
        xor     ebx, ebx
.sum:   lodsd
        imul    ebx, ebx, 31
        add     ebx, eax
        loop    .sum
        mov     edi, out                        ; as 8 hex digits and a newline
        mov     ecx, 8
.hex:   rol     ebx, 4
        mov     eax, ebx
        and     eax, 15
        mov     al, [digits + eax]
        mov     [edi], al
        inc     edi
        loop    .hex
        mov     byte [edi], 10
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, out
        mov     edx, 9
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
digits: db      '0123456789abcdef'
out:    times 9 db 0
filesz  equ     $ - $$
memsz   equ     0x4000
