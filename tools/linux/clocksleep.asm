; clocksleep.asm — clock_nanosleep waits as nanosleep does. Prints "clocksleep: " then a letter per check
; (Y: it returned 0 and at least the time asked went by, by gettimeofday):
;
;   A  clock_nanosleep(CLOCK_MONOTONIC, 0, 300 ms)
;   B  clock_nanosleep(CLOCK_REALTIME, TIMER_ABSTIME, now + 200 ms), now by clock_gettime
;   C  clock_nanosleep_time64(CLOCK_MONOTONIC, 0, 100 ms), its timespec of 64-bit fields
;
; musl's sleep and nanosleep call them: MIRAGE answered ENOSYS, and BusyBox's sleep returned at once (NNN).
; Docker i386/debian: "clocksleep: YYY".
;
;   nasm -f bin tools/linux/clocksleep.asm -o CLOCKSLEEP && chmod +x CLOCKSLEEP
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

%macro START 0
        mov     eax, 78
        mov     ebx, t0
        xor     ecx, ecx
        int     0x80
%endmacro
; the microseconds since t0 into EAX
%macro ELAPSED 0
        mov     eax, 78
        mov     ebx, now
        xor     ecx, ecx
        int     0x80
        mov     eax, [now]
        sub     eax, [t0]
        imul    eax, eax, 1000000
        add     eax, [now + 4]
        sub     eax, [t0 + 4]
%endmacro
; result letter at [res + %1]: Y when [rv] == 0 and the elapsed microseconds in EAX >= %2
%macro VERDICT 2
        mov     dl, 'N'
        cmp     dword [rv], 0
        jne     %%no
        cmp     eax, %2
        jl      %%no
        mov     dl, 'Y'
%%no:   mov     [res + %1], dl
%endmacro

_start:
        START                                   ; ---- A: 300 ms on CLOCK_MONOTONIC ----
        mov     eax, 267
        mov     ebx, 1
        xor     ecx, ecx
        mov     edx, ts300
        xor     esi, esi
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 0, 300000

        START                                   ; ---- B: to now + 200 ms on CLOCK_REALTIME ----
        mov     eax, 265                        ; clock_gettime(CLOCK_REALTIME, &when)
        xor     ebx, ebx
        mov     ecx, when
        int     0x80
        mov     eax, [when + 4]
        add     eax, 200000000
        cmp     eax, 1000000000
        jl      .noc
        sub     eax, 1000000000
        inc     dword [when]
.noc:   mov     [when + 4], eax
        mov     eax, 267
        xor     ebx, ebx
        mov     ecx, 1                          ; TIMER_ABSTIME
        mov     edx, when
        xor     esi, esi
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 1, 199000                       ; gettimeofday's microseconds against the nanoseconds asked

        START                                   ; ---- C: 100 ms, time64 ----
        mov     eax, 407
        mov     ebx, 1
        xor     ecx, ecx
        mov     edx, ts64
        xor     esi, esi
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 2, 100000

        mov     eax, 4
        mov     ebx, 1
        mov     ecx, msg
        mov     edx, msglen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

ts300:  dd      0, 300000000
ts64:   dd      0, 0, 100000000, 0
msg:    db      'clocksleep: '
res:    db      '???', 10
msglen  equ     $ - msg
t0:     dd      0, 0
now:    dd      0, 0
when:  dd      0, 0
rv:     dd      0
filesz  equ     $ - $$
