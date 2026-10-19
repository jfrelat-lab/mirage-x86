; tick.asm — how long a select of 35 microseconds sleeps. Prints "tick: " and the elapsed time in
; whole milliseconds (two digits, 99 for more), by gettimeofday, then exits 0.
;
; Linux 2.0 counted timeouts in clock ticks (HZ 100): select rounds 35 us up to a tick and adds one,
; so it slept 10 to 20 ms — XBoing paced its frames on it. A modern kernel sleeps some 35 us + slack
; ("tick: 00"). MIRAGE: 00 by default, 10-20 with an image's machine.hz 100.
;
;   nasm -f bin tools/linux/tick.asm -o TICK && chmod +x TICK
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

_start: mov     eax, 78                         ; gettimeofday(&t0)
        mov     ebx, t0
        xor     ecx, ecx
        int     0x80
        mov     eax, 142                        ; select(0, 0, 0, 0, {0, 35})
        xor     ebx, ebx
        xor     ecx, ecx
        xor     edx, edx
        xor     esi, esi
        mov     edi, tv
        int     0x80
        mov     eax, 78                         ; gettimeofday(&t1)
        mov     ebx, t1
        xor     ecx, ecx
        int     0x80
        mov     eax, [t1]                       ; microseconds between them
        sub     eax, [t0]
        imul    eax, eax, 1000000
        add     eax, [t1 + 4]
        sub     eax, [t0 + 4]
        xor     edx, edx
        mov     ecx, 1000
        div     ecx                             ; milliseconds
        cmp     eax, 99
        jbe     .two
        mov     eax, 99
.two:   xor     edx, edx
        mov     ecx, 10
        div     ecx
        add     al, '0'
        add     dl, '0'
        mov     [digits], al
        mov     [digits + 1], dl
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

tv      dd      0, 35
t0      dd      0, 0
t1      dd      0, 0
line    db      'tick: '
digits  db      '??', 10
linelen equ     $ - line
filesz  equ     $ - $$
