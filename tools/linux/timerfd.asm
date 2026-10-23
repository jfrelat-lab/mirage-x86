; timerfd.asm — a timer read as a descriptor, and a write at an offset. Prints "tfd: " then a letter
; per check (Y holds, N does not), and exits 0.
;
;   A  timerfd_create(CLOCK_MONOTONIC), timerfd_settime 20 ms then every 20 ms: three reads answer 1
;      expiration each, and at least 60 ms have gone by (gettimeofday)
;   B  timerfd_gettime: an interval of 20 ms
;   C  pwrite64 of "XY" at offset 2 into a file holding "abcd": "abXY", the file's offset left at 4
;
; Outline 2021's xorchitecture paces its frames on a timerfd and writes each one with pwrite64.
; Docker i386/debian: "tfd: YYY".
;
;   nasm -f bin tools/linux/timerfd.asm -o TIMERFD && chmod +x TIMERFD
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
        mov     eax, 322                        ; timerfd_create(CLOCK_MONOTONIC, 0)
        mov     ebx, 1
        xor     ecx, ecx
        int     0x80
        mov     [tfd], eax
        mov     eax, 325                        ; timerfd_settime(fd, 0, &its, 0)
        mov     ebx, [tfd]
        xor     ecx, ecx
        mov     edx, its
        xor     esi, esi
        int     0x80
        mov     byte [ok], 'Y'
        mov     edi, 3
.rd:    mov     eax, 3                          ; read(fd, &count, 8): one expiration
        mov     ebx, [tfd]
        mov     ecx, count
        mov     edx, 8
        int     0x80
        cmp     eax, 8
        jne     .bad
        cmp     dword [count], 1
        je      .next
.bad:   mov     byte [ok], 'N'
.next:  dec     edi
        jnz     .rd
        mov     eax, 78                         ; gettimeofday(&t1): 60 ms at least
        mov     ebx, t1
        xor     ecx, ecx
        int     0x80
        mov     eax, [t1]
        sub     eax, [t0]
        imul    eax, eax, 1000000
        add     eax, [t1 + 4]
        sub     eax, [t0 + 4]
        cmp     eax, 60000
        jge     .a
        mov     byte [ok], 'N'
.a:     mov     al, [ok]
        mov     [res], al
        ; ---- B ----
        mov     eax, 326                        ; timerfd_gettime(fd, &cur)
        mov     ebx, [tfd]
        mov     ecx, cur
        int     0x80
        mov     dl, 'N'
        cmp     dword [cur], 0
        jne     .b
        cmp     dword [cur + 4], 20000000
        jne     .b
        mov     dl, 'Y'
.b:     mov     [res + 1], dl
        ; ---- C ----
        mov     eax, 5                          ; open("/tmp/tfd.txt", O_RDWR|O_CREAT|O_TRUNC, 0644)
        mov     ebx, fname
        mov     ecx, 0x242
        mov     edx, 0o644
        int     0x80
        mov     [ffd], eax
        mov     eax, 4                          ; write "abcd": the offset at 4
        mov     ebx, [ffd]
        mov     ecx, abcd
        mov     edx, 4
        int     0x80
        mov     eax, 181                        ; pwrite64(fd, "XY", 2, 2, 0)
        mov     ebx, [ffd]
        mov     ecx, xy
        mov     edx, 2
        mov     esi, 2
        xor     edi, edi
        int     0x80
        mov     eax, 19                         ; lseek(fd, 0, SEEK_CUR): still 4
        mov     ebx, [ffd]
        xor     ecx, ecx
        mov     edx, 1
        int     0x80
        mov     dl, 'N'
        cmp     eax, 4
        jne     .c
        mov     eax, 180                        ; pread64(fd, buf, 4, 0, 0)
        mov     ebx, [ffd]
        mov     ecx, buf
        mov     edx, 4
        xor     esi, esi
        xor     edi, edi
        int     0x80
        mov     dl, 'N'
        cmp     dword [buf], 'abXY'
        jne     .c
        mov     dl, 'Y'
.c:     mov     [res + 2], dl
        mov     eax, 10                         ; unlink
        mov     ebx, fname
        int     0x80
        mov     eax, 4
        mov     ebx, 1
        mov     ecx, line
        mov     edx, linelen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

its     dd      0, 20000000, 0, 20000000        ; interval 20 ms, first expiry in 20 ms
fname   db      '/tmp/tfd.txt', 0
abcd    db      'abcd'
xy      db      'XY'
line    db      'tfd: '
res     db      '???', 10
linelen equ     $ - line
t0      dd      0, 0
t1      dd      0, 0
tfd     dd      0
ffd     dd      0
count   dd      0, 0
cur     dd      0, 0, 0, 0
buf     dd      0
ok      db      0
filesz  equ     $ - $$
