; thread.asm — two threads of one address space (src/linux.js's lx.spawnThread, what SDL_CreateThread
; and Win32's CreateThread stand on): the test starts `thread` beside `_start`. The main thread spins
; until the flag is set, without a system call (the clock's preemption gives the other its turn); the
; thread sets it to 42 and ends with exit(0), which ends it alone — its pages are the main thread's
; too, and freeing them would fault the spin. The main thread then exits with the flag: 42.
;
;   nasm -f bin tools/linux/thread.asm -o THREAD
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

_start: mov     eax, [flag]
        test    eax, eax
        jz      _start
        mov     ebx, eax
        mov     eax, 1                          ; exit(flag)
        int     0x80
thread: mov     dword [flag], 42
        mov     eax, 1                          ; exit(0): this thread only
        xor     ebx, ebx
        int     0x80
filesz  equ     $ - $$
flag    equ     $$ + filesz
memsz   equ     filesz + 4 + 0x1000             ; the flag, and a page for the thread's stack
