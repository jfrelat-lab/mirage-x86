; rusage.asm — wait4's rusage and getrusage are filled in. Prints "rusage: " then a letter per check
; (Y: the call answered and each timeval of the struct rusage it wrote is a time, not the 0xff the buffer
; held before -- under an hour, its microseconds under a million):
;
;   A  wait4(-1, &status, 0, &ru) for a child that exits at once
;   B  getrusage(RUSAGE_SELF, &ru)
;
; MIRAGE's wait4 left the rusage as it was and had no getrusage: BusyBox's `time` printed the stack's
; leftovers as 298324 hours of user time. Docker i386/debian: "rusage: YY".
;
;   nasm -f bin tools/linux/rusage.asm -o RUSAGE && chmod +x RUSAGE
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

; fill ru with 0xff
%macro SPOIL 0
        mov     edi, ru
        mov     ecx, 72
        mov     al, 0xff
        rep stosb
%endmacro
; letter at [res + %1]: Y when EAX (the call's answer) is >= 0 and both timevals at ru are times
%macro VERDICT 1
        mov     dl, 'N'
        test    eax, eax
        js      %%no
        cmp     dword [ru], 3600
        jae     %%no
        cmp     dword [ru + 4], 1000000
        jae     %%no
        cmp     dword [ru + 8], 3600
        jae     %%no
        cmp     dword [ru + 12], 1000000
        jae     %%no
        mov     dl, 'Y'
%%no:   mov     [res + %1], dl
%endmacro

_start: mov     eax, 2                  ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        mov     eax, 1                  ; the child: exit(0)
        xor     ebx, ebx
        int     0x80
parent: SPOIL
        mov     eax, 114                ; wait4(-1, &status, 0, &ru)
        mov     ebx, -1
        mov     ecx, status
        xor     edx, edx
        mov     esi, ru
        int     0x80
        VERDICT 0
        SPOIL
        mov     eax, 77                 ; getrusage(RUSAGE_SELF, &ru)
        xor     ebx, ebx
        mov     ecx, ru
        int     0x80
        VERDICT 1
        mov     eax, 4                  ; write(1, msg, len)
        mov     ebx, 1
        mov     ecx, msg
        mov     edx, msglen
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80

msg:    db      'rusage: '
res:    db      '??', 10
msglen  equ     $ - msg
status: dd      0
ru:     times 72 db 0
filesz  equ     $ - $$
