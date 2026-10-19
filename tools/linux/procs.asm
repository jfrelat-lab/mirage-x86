; procs.asm — one process ends another, as busybox `timeout` does. Prints "procs: " then a letter per
; check (Y holds, N does not), and exits 0.
;
;   A  a child sleeps; the parent kills it (SIGTERM), then writes its own memory and waits for it:
;      the child died of signal 15. (MIRAGE took the killed process's pages out of the running one's
;      page table — the killer's, at the same addresses: timeout's watcher stopped there.)
;   B  a child computes without a system call; the parent sleeps 50 ms, kills it (SIGKILL) and waits
;      for it: signal 9. (MIRAGE switched processes only in system calls: the loop kept the CPU and
;      the parent never woke — `timeout 2 sh -c 'while :; do :; done'` never ended.)
;   C  a child waits in a select of 100 s, another sleeps 1 s, computes a while and exits; the parent, waiting for the
;      second, has it back within 10 s (by gettimeofday). (MIRAGE counted the exit as one more wait:
;      the select's next turn believed every process waited and took the clock to its 100 s — X's
;      600-second screen saver, in a shell starting twm.)
;
; Docker i386/debian: "procs: YYY".
;
;   nasm -f bin tools/linux/procs.asm -o PROCS && chmod +x PROCS
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

; wait4(EBX = pid, &st): [res + %1] = Y when st's signal is %2
%macro REAP 2
        mov     eax, 114
        lea     ecx, [st]
        xor     edx, edx
        xor     esi, esi
        int     0x80
        mov     dl, 'N'
        mov     eax, [st]
        and     eax, 0x7f
        cmp     eax, %2
        jne     %%no
        mov     dl, 'Y'
%%no:   mov     [res + %1], dl
%endmacro

_start:
        ; ---- A ----
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     .a_parent
        mov     eax, 162                        ; the child: nanosleep 100 s
        mov     ebx, t100s
        xor     ecx, ecx
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
.a_parent:
        mov     [pid], eax
        mov     eax, 37                         ; kill(child, SIGTERM)
        mov     ebx, [pid]
        mov     ecx, 15
        int     0x80
        mov     dword [st], 0x1234              ; our own memory, after the kill
        mov     ebx, [pid]
        REAP    0, 15

        ; ---- B ----
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     .b_parent
.spin:  jmp     .spin                           ; the child: no system call, ever
.b_parent:
        mov     [pid], eax
        mov     eax, 162                        ; nanosleep 50 ms
        mov     ebx, t50ms
        xor     ecx, ecx
        int     0x80
        mov     eax, 37                         ; kill(child, SIGKILL)
        mov     ebx, [pid]
        mov     ecx, 9
        int     0x80
        mov     ebx, [pid]
        REAP    1, 9

        ; ---- C ----
        mov     eax, 78                         ; gettimeofday(&t0)
        mov     ebx, t0
        xor     ecx, ecx
        int     0x80
        mov     eax, 2                          ; fork: the one that selects
        int     0x80
        test    eax, eax
        jnz     .c_sel
        mov     eax, 142                        ; select(0, 0, 0, 0, 100 s)
        xor     ebx, ebx
        xor     ecx, ecx
        xor     edx, edx
        xor     esi, esi
        mov     edi, t100s
        int     0x80
        jmp     .c_exit
.c_sel: mov     [pid], eax
        mov     eax, 2                          ; fork: the one that sleeps 1 s
        int     0x80
        test    eax, eax
        jnz     .c_wait
        mov     eax, 162
        mov     ebx, t1s
        xor     ecx, ecx
        int     0x80
        mov     ecx, 5000000                    ; then computes some 100 ms (preempted), then exits
.c_spin:
        dec     ecx
        jnz     .c_spin
.c_exit:
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
.c_wait:
        mov     ebx, eax                        ; wait4(the sleeper)
        mov     eax, 114
        lea     ecx, [st]
        xor     edx, edx
        xor     esi, esi
        int     0x80
        mov     eax, 78                         ; gettimeofday(&t1)
        mov     ebx, t1
        xor     ecx, ecx
        int     0x80
        mov     dl, 'N'
        mov     eax, [t1]
        sub     eax, [t0]
        cmp     eax, 10
        jge     .c_no
        mov     dl, 'Y'
.c_no:  mov     [res + 2], dl
        mov     eax, 37                         ; kill(the selector, SIGKILL), and reap it
        mov     ebx, [pid]
        mov     ecx, 9
        int     0x80
        mov     ebx, [pid]
        mov     eax, 114
        lea     ecx, [st]
        xor     edx, edx
        xor     esi, esi
        int     0x80

        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

t100s   dd      100, 0                          ; a timespec, and a timeval
t50ms   dd      0, 50000000
t1s     dd      1, 0
t0      dd      0, 0
t1      dd      0, 0
pid     dd      0
st      dd      0
line    db      'procs: '
res     db      '???', 10
linelen equ     $ - line
filesz  equ     $ - $$
