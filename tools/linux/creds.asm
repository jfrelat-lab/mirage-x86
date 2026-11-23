; creds.asm — a process's identities as Linux changes them, started as root (docker run's default): the
; supplementary groups set and read, the group ids, then root kept as the saved uid while the real and
; effective ones become 1000; root taken back through the saved id (setuid(0)), every id then given up
; for 2000, after which root is refused (EPERM: -1 here as eax's 0xffffffff... the raw -1 the kernel
; returns), and so are setgroups and a setreuid to 0. Each line: eax after the call, or an id, as eight
; hex digits. Docker i386 prints the reference lines.
;
;   nasm -f bin tools/linux/creds.asm -o CREDS
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

%macro sys 1-4
        mov     eax, %1
  %if %0 > 1
        mov     ebx, %2
  %endif
  %if %0 > 2
        mov     ecx, %3
  %endif
  %if %0 > 3
        mov     edx, %4
  %endif
        int     0x80
        call    hex
%endmacro

_start: sys     199                     ; getuid32: 0
        sys     206, 2, groups          ; setgroups32(2, {5, 7}): 0
        sys     205, 0, 0               ; getgroups32(0, NULL): 2
        sys     210, 100, 100, 100      ; setresgid32(100, 100, 100): 0
        sys     202                     ; getegid32: 100
        sys     208, 1000, 1000, 0      ; setresuid32(1000, 1000, 0): 0 -- root kept as the saved uid
        sys     199                     ; getuid32: 1000
        sys     201                     ; geteuid32: 1000
        sys     213, 0                  ; setuid32(0): 0 -- the saved uid, so the effective one only
        sys     199                     ; getuid32: 1000
        sys     201                     ; geteuid32: 0
        sys     208, 2000, 2000, 2000   ; setresuid32(2000, 2000, 2000): 0 -- root given up
        sys     209, ids, ids + 4, ids + 8   ; getresuid32: 0
        mov     eax, [ids]
        call    hex
        mov     eax, [ids + 4]
        call    hex
        mov     eax, [ids + 8]
        call    hex
        sys     213, 0                  ; setuid32(0): -EPERM
        sys     203, -1, 0              ; setreuid32(-1, 0): -EPERM
        sys     206, 1, groups          ; setgroups32(1, {5}): -EPERM
        sys     205, 0, 0               ; getgroups32: still 2
        sys     24                      ; getuid (16-bit): 2000
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
groups: dd      5, 7
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
ids     equ     $$ + filesz
buf     equ     ids + 12
memsz   equ     filesz + 32
