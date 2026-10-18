; pty.asm — pseudo-terminals as a terminal emulator uses them. Prints "pty: " then a letter per check
; (Y holds, N does not, - the device is absent), and exits 0.
;
; Unix98, /dev/ptmx:
;   A  open /dev/ptmx, TIOCGPTN gives N, TIOCSPTLCK 0 unlocks, /dev/pts/N opens
;   B  "hi\n" written to the master: the slave reads "hi\n" (one canonical line), and the master
;      reads the echo "hi\r\n" (ECHO, then ONLCR on the way back)
;   C  "ok\n" written to the slave: the master reads "ok\r\n" (OPOST/ONLCR)
;   D  TIOCSWINSZ 30x100 on the master, TIOCGWINSZ on the slave reads it back
;   E  the slave closed: the master's read answers EIO
; BSD (the pairs libc5 and xterm 3.3 open by name), /dev/ptyp0 and /dev/ttyp0:
;   F  the master and the slave open, "x\n" goes through; a second open of /dev/ptyp0 answers EIO
;
; Docker i386/debian (a real kernel: no legacy BSD ptys there): "pty: YYYYY-".
;
;   nasm -f bin tools/linux/pty.asm -o PTY && chmod +x PTY
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

%macro OPEN 2                                   ; EAX = open(%1, O_RDWR|O_NOCTTY|%2)
        mov     eax, 5
        mov     ebx, %1
        mov     ecx, 0x102 | %2
        int     0x80
%endmacro
%macro WRITE 3                                  ; write(fd %1, buf %2, len %3)
        mov     eax, 4
        mov     ebx, %1
        mov     ecx, %2
        mov     edx, %3
        int     0x80
%endmacro
%macro READ 1                                   ; EAX = read(fd %1, buf, 64)
        mov     eax, 3
        mov     ebx, %1
        mov     ecx, buf
        mov     edx, 64
        int     0x80
%endmacro
%macro EXPECT 3                                 ; ZF set when EAX == %3 bytes equal to %2 at buf
        mov     edx, 'N'
        cmp     eax, %3
        jne     %%no
        mov     esi, buf
        mov     edi, %2
        mov     ecx, %3
        repe    cmpsb
        jne     %%no
        mov     edx, 'Y'
%%no:
%endmacro

_start:
        cld
        ; ---- A ----
        OPEN    ptmx, 0
        mov     [m], eax
        mov     byte [res], '-'
        test    eax, eax
        js      .bsd
        mov     eax, 54                         ; ioctl(m, TIOCGPTN, &n)
        mov     ebx, [m]
        mov     ecx, 0x80045430
        mov     edx, num
        int     0x80
        mov     eax, 54                         ; ioctl(m, TIOCSPTLCK, &zero)
        mov     ebx, [m]
        mov     ecx, 0x40045431
        mov     edx, zero
        int     0x80
        mov     eax, [num]                      ; "/dev/pts/" + N (N < 10 here)
        add     al, '0'
        mov     [ptsname + 9], al
        OPEN    ptsname, 0
        mov     [sl], eax
        mov     dl, 'N'
        test    eax, eax
        js      .a_no
        mov     dl, 'Y'
.a_no:  mov     [res], dl
        ; ---- B ----
        WRITE   [m], hi, 3
        READ    [sl]
        EXPECT  0, hi, 3
        mov     [ok1], dl
        READ    [m]
        EXPECT  0, hicrlf, 4
        mov     dl, [ok1]
        cmp     byte [ok1], 'Y'
        je      .b1
        mov     dl, 'N'
        jmp     .b2
.b1:    cmp     edx, edx                        ; keep EXPECT's verdict for the echo
        mov     dl, 'N'
        mov     esi, buf
        mov     edi, hicrlf
        mov     ecx, 4
        repe    cmpsb
        jne     .b2
        mov     dl, 'Y'
.b2:    mov     [res + 1], dl
        ; ---- C ----
        WRITE   [sl], okk, 3
        READ    [m]
        EXPECT  0, okcrlf, 4
        mov     [res + 2], dl
        ; ---- D ----
        mov     eax, 54                         ; ioctl(m, TIOCSWINSZ, {30, 100})
        mov     ebx, [m]
        mov     ecx, 0x5414
        mov     edx, ws
        int     0x80
        mov     dword [ws2], 0
        mov     eax, 54                         ; ioctl(sl, TIOCGWINSZ, &ws2)
        mov     ebx, [sl]
        mov     ecx, 0x5413
        mov     edx, ws2
        int     0x80
        mov     dl, 'N'
        cmp     dword [ws2], 30 | (100 << 16)
        jne     .d_no
        mov     dl, 'Y'
.d_no:  mov     [res + 3], dl
        ; ---- E ----
        mov     eax, 6                          ; close(sl)
        mov     ebx, [sl]
        int     0x80
        READ    [m]
        mov     dl, 'N'
        cmp     eax, -5
        jne     .e_no
        mov     dl, 'Y'
.e_no:  mov     [res + 4], dl

.bsd:   ; ---- F ----
        mov     byte [res + 5], '-'
        OPEN    ptyp0, 0
        mov     [m], eax
        test    eax, eax
        js      .print
        OPEN    ttyp0, 0
        mov     [sl], eax
        WRITE   [m], xnl, 2
        READ    [sl]
        EXPECT  0, xnl, 2
        mov     [ok1], dl
        OPEN    ptyp0, 0
        mov     dl, 'N'
        cmp     eax, -5
        jne     .f_no
        cmp     byte [ok1], 'Y'
        jne     .f_no
        mov     dl, 'Y'
.f_no:  mov     [res + 5], dl

.print: WRITE   1, line, linelen
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

ptmx    db      '/dev/ptmx', 0
ptsname db      '/dev/pts/?', 0
ptyp0   db      '/dev/ptyp0', 0
ttyp0   db      '/dev/ttyp0', 0
hi      db      'hi', 10
hicrlf  db      'hi', 13, 10
okk     db      'ok', 10
okcrlf  db      'ok', 13, 10
xnl     db      'x', 10
ws      dw      30, 100, 0, 0
ws2     dd      0, 0
zero    dd      0
num     dd      0
m       dd      0
sl      dd      0
ok1     db      0
line    db      'pty: '
res     db      '??????', 10
linelen equ     $ - line
buf     times 64 db 0
filesz  equ     $ - $$
