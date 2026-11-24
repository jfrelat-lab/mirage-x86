; argv.asm — the arguments as Linux lays them out, run through a script's "#!" line: argc, each argument
; on its line (the interpreter, the line's one argument, the script's path, then the script's own
; arguments), and 1 when the strings lie one after another in memory (each argument's string ends
; where the next begins, the last where the environment's first begins) -- libuv's proctitle code
; checks this (uv_setup_args) and Node stopped on an assertion when they did not. Docker i386 runs
; /t/s.sh ("#!/t/ARGV -x") with "a" and "bc" and prints the reference lines.
;
;   nasm -f bin tools/linux/argv.asm -o ARGV
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

_start: mov     ebp, esp
        mov     eax, [ebp]              ; argc
        call    hex
        mov     dword [ok], 1
        lea     esi, [ebp + 4]          ; argv[0]
.arg:   mov     ecx, [esi]
        test    ecx, ecx
        jz      .env
        mov     edi, ecx                ; its length
        xor     eax, eax
        mov     edx, -1
.len:   inc     edx
        cmp     byte [ecx + edx], 0
        jne     .len
        lea     edi, [ecx + edx + 1]    ; where the next string should begin
        mov     [next], edi
        mov     byte [ecx + edx], 10    ; printed with a newline in place of its NUL
        mov     eax, 4
        mov     ebx, 1
        inc     edx
        int     0x80
        add     esi, 4
        mov     eax, [esi]              ; the next argument, or (after the NULL) the first variable
        test    eax, eax
        jnz     .cmp
        mov     eax, [esi + 4]
        test    eax, eax
        jz      .arg
.cmp:   cmp     eax, [next]
        je      .arg
        mov     dword [ok], 0
        jmp     .arg
.env:   mov     eax, [ok]
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
ok      equ     $$ + ((filesz + 3) & ~3)
next    equ     ok + 4
buf     equ     ok + 8
memsz   equ     filesz + 32
