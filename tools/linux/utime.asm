; utime.asm — a file's modification time as Linux sets it: a file made in /tmp, then utimensat with a time
; (2020-01-02 03:04:05), with UTIME_OMIT (left as it is), utimes with another (2001-09-09 01:46:40), and
; utimensat on a missing file (ENOENT: -2). Each line: eax after the call, or st_mtime from stat64, as
; eight hex digits. Docker i386 prints the reference lines. touch (musl's) calls utimensat first.
;
;   nasm -f bin tools/linux/utime.asm -o UTIME
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

_start: mov     eax, 5                  ; open(path, O_CREAT|O_WRONLY|O_TRUNC, 0644)
        mov     ebx, path
        mov     ecx, 0x241
        mov     edx, 0o644
        int     0x80
        mov     ebx, eax
        mov     eax, 6                  ; close
        int     0x80
        mov     eax, 320                ; utimensat(AT_FDCWD, path, {atime, 2020-01-02 03:04:05}, 0)
        mov     ebx, -100
        mov     ecx, path
        mov     edx, ts1
        xor     esi, esi
        int     0x80
        call    hex
        call    mtime
        mov     eax, 320                ; utimensat(..., {atime, UTIME_OMIT}): unchanged
        mov     ebx, -100
        mov     ecx, path
        mov     edx, ts2
        xor     esi, esi
        int     0x80
        call    hex
        call    mtime
        mov     eax, 271                ; utimes(path, {atime, 1000000000 s})
        mov     ebx, path
        mov     ecx, tv
        int     0x80
        call    hex
        call    mtime
        mov     eax, 320                ; utimensat on a missing file: -ENOENT
        mov     ebx, -100
        mov     ecx, none
        mov     edx, ts1
        xor     esi, esi
        int     0x80
        call    hex
        mov     eax, 10                 ; unlink
        mov     ebx, path
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
; st_mtime of path (stat64: at 72), printed
mtime:  mov     eax, 195
        mov     ebx, path
        mov     ecx, st
        int     0x80
        mov     eax, [st + 72]
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
path:   db      '/tmp/utime-probe', 0
none:   db      '/tmp/utime-none/x', 0
ts1:    dd      0, 0x3fffffff, 1577934245, 0        ; atime now, mtime 2020-01-02 03:04:05
ts2:    dd      0, 0x3fffffff, 0, 0x3ffffffe        ; mtime UTIME_OMIT
tv:     dd      0, 0, 1000000000, 0                 ; atime 0, mtime 2001-09-09 01:46:40
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
st      equ     $$ + filesz
buf     equ     st + 96
memsz   equ     filesz + 128
