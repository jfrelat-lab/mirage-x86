; signals.asm — signals delivered to a program's handlers, as i386 Linux delivers them. Prints one
; line, "sig: " then a letter per check (Y holds, N does not), and exits 0.
;
;   A  kill(getpid(), SIGUSR1) runs the handler: it gets the signal number at [esp+4]; kill still
;      returns 0 afterwards, and EBX ESI EDI EBP, which the handler overwrites, come back as they were
;   B  alarm(1) then pause(): SIGALRM's handler runs, pause returns -EINTR
;   C  a child that exits 3 while the parent waits in wait4, with a SIGCHLD handler and SA_RESTART:
;      the handler runs, wait4 runs again and returns the child with status 3 << 8
;   D  SIGUSR2 blocked by rt_sigprocmask, then raised: not delivered, rt_sigpending shows it;
;      unblocked: delivered then
;
; The handlers are installed with rt_sigaction, SA_RESTORER and a restorer of our own (sigreturn).
; Docker i386/debian (a real kernel's answer): "sig: YYYY".
;
;   nasm -f bin tools/linux/signals.asm -o SIGNALS && chmod +x SIGNALS
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

SA_RESTORER equ 0x04000000
SA_RESTART  equ 0x10000000

; rt_sigaction(sig, act) with handler %2 and flags %3
%macro SIGACT 3
        mov     dword [act], %2
        mov     dword [act + 4], SA_RESTORER | %3
        mov     dword [act + 8], restorer
        mov     dword [act + 12], 0
        mov     dword [act + 16], 0
        mov     eax, 174
        mov     ebx, %1
        mov     ecx, act
        xor     edx, edx
        mov     esi, 8
        int     0x80
%endmacro

_start:
        ; ---- A ----
        SIGACT  10, h_usr1, 0
        mov     eax, 20                         ; getpid
        int     0x80
        mov     [mypid], eax
        mov     ebx, 0x11111111
        mov     esi, 0x22222222
        mov     edi, 0x33333333
        mov     ebp, 0x44444444
        push    ebx
        mov     ebx, [mypid]
        mov     ecx, 10                         ; kill(getpid(), SIGUSR1)
        mov     eax, 37
        int     0x80
        pop     ebx
        mov     edx, 'N'
        cmp     eax, 0
        jne     .a_done
        cmp     dword [got_usr1], 10
        jne     .a_done
        cmp     ebx, 0x11111111
        jne     .a_done
        cmp     esi, 0x22222222
        jne     .a_done
        cmp     edi, 0x33333333
        jne     .a_done
        cmp     ebp, 0x44444444
        jne     .a_done
        mov     edx, 'Y'
.a_done: mov    [res], dl

        ; ---- B ----
        SIGACT  14, h_alrm, 0
        mov     eax, 27                         ; alarm(1)
        mov     ebx, 1
        int     0x80
        mov     eax, 29                         ; pause
        int     0x80
        mov     edx, 'N'
        cmp     eax, -4
        jne     .b_done
        cmp     dword [got_alrm], 14
        jne     .b_done
        mov     edx, 'Y'
.b_done: mov    [res + 1], dl

        ; ---- C ----
        SIGACT  17, h_chld, SA_RESTART
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     .parent
        mov     eax, 162                        ; the child: a moment, then exit(3)
        mov     ebx, ts
        xor     ecx, ecx
        int     0x80
        mov     eax, 1
        mov     ebx, 3
        int     0x80
.parent: mov    [child], eax
        mov     eax, 114                        ; wait4(-1, &status, 0, 0)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        xor     esi, esi
        int     0x80
        mov     edx, 'N'
        cmp     eax, [child]
        jne     .c_done
        cmp     dword [status], 3 << 8
        jne     .c_done
        cmp     dword [got_chld], 17
        jne     .c_done
        mov     edx, 'Y'
.c_done: mov    [res + 2], dl

        ; ---- D ----
        SIGACT  12, h_usr2, 0
        mov     dword [mask], 1 << 11           ; SIGUSR2 (12)
        mov     dword [mask + 4], 0
        mov     eax, 175                        ; rt_sigprocmask(SIG_BLOCK, &mask, 0, 8)
        xor     ebx, ebx
        mov     ecx, mask
        xor     edx, edx
        mov     esi, 8
        int     0x80
        mov     eax, 37                         ; kill(getpid(), SIGUSR2)
        mov     ebx, [mypid]
        mov     ecx, 12
        int     0x80
        mov     ebp, [got_usr2]                 ; 0: not delivered while blocked
        mov     eax, 176                        ; rt_sigpending(&pend, 8)
        mov     ebx, pend
        mov     ecx, 8
        int     0x80
        mov     edi, [pend]
        mov     eax, 175                        ; rt_sigprocmask(SIG_UNBLOCK, &mask, 0, 8)
        mov     ebx, 1
        mov     ecx, mask
        xor     edx, edx
        mov     esi, 8
        int     0x80
        mov     edx, 'N'
        test    ebp, ebp
        jnz     .d_done
        cmp     edi, 1 << 11
        jne     .d_done
        cmp     dword [got_usr2], 12
        jne     .d_done
        mov     edx, 'Y'
.d_done: mov    [res + 3], dl

        mov     eax, 4                          ; write(1, line, len)
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

; Handlers: the signal number at [esp+4]; they clobber the registers kill's caller keeps.
h_usr1: mov     eax, [esp + 4]
        mov     [got_usr1], eax
        xor     ebx, ebx
        xor     esi, esi
        xor     edi, edi
        xor     ebp, ebp
        ret
h_alrm: mov     eax, [esp + 4]
        mov     [got_alrm], eax
        ret
h_chld: mov     eax, [esp + 4]
        mov     [got_chld], eax
        ret
h_usr2: mov     eax, [esp + 4]
        mov     [got_usr2], eax
        ret
restorer:
        pop     eax                             ; the signal number, as the kernel's own retcode does
        mov     eax, 119                        ; sigreturn
        int     0x80

ts      dd      0, 50000000                     ; 50 ms
line    db      'sig: '
res     db      '????', 10
linelen equ     $ - line
act     times 5 dd 0
mypid   dd      0
child   dd      0
status  dd      0
mask    dd      0, 0
pend    dd      0, 0
got_usr1 dd     0
got_alrm dd     0
got_chld dd     0
got_usr2 dd     0
filesz  equ     $ - $$
memsz   equ     filesz
