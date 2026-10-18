; sleeps.asm — the calls that wait with a timeout wait for it. Prints "sleeps: " then a letter per
; check (Y: at least the time asked went by, by gettimeofday, and the call returned what it should):
;
;   A  nanosleep 300 ms returns 0
;   B  select with no descriptors and a 200 ms timeout returns 0
;   C  poll on a pipe nobody writes, 100 ms, returns 0
;   D  select on that pipe's read end with a 0 timeout returns 0 at once (a poll, no wait)
;
; MIRAGE answered select with a timeout at once (0), which made XFree86's main loop spin.
; Docker i386/debian: "sleeps: YYYY".
;
;   nasm -f bin tools/linux/sleeps.asm -o SLEEPS && chmod +x SLEEPS
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
%macro START 0
        mov     eax, 78
        mov     ebx, t0
        xor     ecx, ecx
        int     0x80
%endmacro
; result letter at [res + %1]: Y when [rv] == %2 and the elapsed microseconds in EAX >= %3
%macro VERDICT 3
        mov     dl, 'N'
        cmp     dword [rv], %2
        jne     %%no
        cmp     eax, %3
        jl      %%no
        mov     dl, 'Y'
%%no:   mov     [res + %1], dl
%endmacro

_start:
        START                                   ; ---- A: nanosleep 300 ms ----
        mov     eax, 162
        mov     ebx, ts
        xor     ecx, ecx
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 0, 0, 300000

        START                                   ; ---- B: select(0, 0, 0, 0, 200 ms) ----
        mov     dword [tv], 0
        mov     dword [tv + 4], 200000
        mov     eax, 142
        xor     ebx, ebx
        xor     ecx, ecx
        xor     edx, edx
        xor     esi, esi
        mov     edi, tv
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 1, 0, 200000

        mov     eax, 42                         ; pipe(fds)
        mov     ebx, fds
        int     0x80
        START                                   ; ---- C: poll({rd, POLLIN}, 1, 100) ----
        mov     eax, [fds]
        mov     [pfd], eax
        mov     dword [pfd + 4], 1
        mov     eax, 168
        mov     ebx, pfd
        mov     ecx, 1
        mov     edx, 100
        int     0x80
        mov     [rv], eax
        ELAPSED
        VERDICT 2, 0, 100000

        START                                   ; ---- D: select(rd + 1, {rd}, 0, 0, 0 s) ----
        mov     ecx, [fds]
        mov     eax, 1
        shl     eax, cl
        mov     [set], eax
        mov     dword [tv], 0
        mov     dword [tv + 4], 0
        mov     eax, 142
        mov     ebx, [fds]
        inc     ebx
        mov     ecx, set
        xor     edx, edx
        xor     esi, esi
        mov     edi, tv
        int     0x80
        mov     [rv], eax
        ELAPSED
        mov     dl, 'N'                         ; 0, and no wait worth the name (under 50 ms)
        cmp     dword [rv], 0
        jne     .d_no
        cmp     eax, 50000
        jge     .d_no
        mov     dl, 'Y'
.d_no:  mov     [res + 3], dl

        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

ts      dd      0, 300000000
line    db      'sleeps: '
res     db      '????', 10
linelen equ     $ - line
t0      dd      0, 0
now     dd      0, 0
tv      dd      0, 0
rv      dd      0
fds     dd      0, 0
pfd     dd      0, 0
set     dd      0
filesz  equ     $ - $$
