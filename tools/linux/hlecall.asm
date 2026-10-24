; hlecall.asm — a call into a library made in JavaScript (src/hle), as a program makes it through one of
; makeSharedObject's stubs: `mov eax, 48000000h + id ; int 80h ; ret`, the arguments pushed by cdecl.
; Two calls: f0(7, 3.14159274f) and f1(-2, 3.141592653589793), then exit with (f0 + f1) & 255. The
; test's JavaScript library answers f0 = i + round(f * 100) and f1 = i + round(d * 1000): 321 + 3140,
; so the exit status is 133 — and it records the arguments it was given.
;
;   nasm -f bin tools/linux/hlecall.asm -o HLECALL && chmod +x HLECALL
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2, 3
        dd      1, _start, phdr - $$, 0, 0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1, 0, $$, $$, filesz, filesz, 5, 0x1000
phsize  equ     $ - phdr

_start: push    dword 0x40490fdb                ; 3.14159274f
        push    dword 7
        call    f0
        add     esp, 8
        mov     esi, eax
        push    dword 0x400921fb                ; 3.141592653589793 (high dword)
        push    dword 0x54442d18                ;                   (low dword)
        push    dword -2
        call    f1
        add     esp, 12
        add     eax, esi
        movzx   ebx, al
        mov     eax, 1                          ; exit((f0 + f1) & 255)
        int     0x80

f0:     mov     eax, 0x48000000
        int     0x80
        ret
f1:     mov     eax, 0x48000001
        int     0x80
        ret
filesz  equ     $ - $$
