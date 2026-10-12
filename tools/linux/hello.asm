; hello.asm — the smallest i386 Linux program MIRAGE-LINUX runs: a static ELF32 built by NASM alone
; (no linker), loaded at 0x08048000. It prints its argc, its argv strings one per line, and exits with
; status 42 — enough to check the loader's initial stack as well as write(2) and exit(2).
; The oracle is a real kernel: `docker run --platform linux/386 i386/debian ./hello a b`.
;
;   nasm -f bin tools/linux/hello.asm -o HELLO && chmod +x HELLO
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
        dd      7                               ; R+W+X: [digit] is written
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     esi, esp
        lodsd                                   ; argc
        mov     ebp, eax
        add     al, '0'                         ; argc < 10
        mov     [digit], al
        mov     ecx, line
        mov     edx, linelen
        call    write
.next:  dec     ebp
        js      .done
        lodsd                                   ; argv[i]
        mov     ecx, eax
        xor     edx, edx
.len:   cmp     byte [ecx + edx], 0
        je      .put
        inc     edx
        jmp     .len
.put:   call    write
        mov     ecx, nl
        mov     edx, 1
        call    write
        jmp     .next
.done:  mov     eax, 1                          ; exit
        mov     ebx, 42
        int     0x80

write:  mov     eax, 4
        mov     ebx, 1
        int     0x80
        ret

line    db      'argc='
digit   db      '?', 10
linelen equ     $ - line
nl      db      10
filesz  equ     $ - $$
