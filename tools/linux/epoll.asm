; epoll.asm — eventfd and epoll as Linux answers them: an eventfd watched by an epoll, nothing ready, then
; ready once written (the event's mask and the caller's 64-bit data back), its count read; a second ADD
; refused (EEXIST: -17), a non-blocking eventfd with nothing to read (EAGAIN: -11), EPOLLONESHOT
; reporting once only, DEL then DEL again (ENOENT: -2), and a semaphore eventfd read one by one. Each
; line: eax after the call, or a word written back, as eight hex digits. Docker i386 prints the reference.
;
;   nasm -f bin tools/linux/epoll.asm -o EPOLL
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

%macro sys 1-5
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
  %if %0 > 4
        mov     esi, %5
  %endif
        int     0x80
        call    hex
%endmacro

_start: sys     328, 0, 0               ; eventfd2(0, 0): 3
        mov     [efd], eax
        sys     329, 0                  ; epoll_create1(0): 4
        mov     [epfd], eax
        sys     255, [epfd], 1, [efd], ev_in        ; EPOLL_CTL_ADD, EPOLLIN, data 0x1122334455667788: 0
        sys     255, [epfd], 1, [efd], ev_in        ; again: -EEXIST
        sys     256, [epfd], evs, 4, 0              ; epoll_wait, timeout 0: nothing
        sys     4, [efd], three, 8                  ; write 3: 8
        sys     256, [epfd], evs, 4, 0              ; 1
        mov     eax, [evs]                          ; EPOLLIN
        call    hex
        mov     eax, [evs + 4]                      ; data, low word
        call    hex
        mov     eax, [evs + 8]                      ; high word
        call    hex
        sys     3, [efd], val, 8                    ; read: 8
        mov     eax, [val]                          ; the count: 3, now 0
        call    hex
        sys     256, [epfd], evs, 4, 0              ; nothing again
        sys     328, 0, 0x800                       ; eventfd2(0, EFD_NONBLOCK): 5
        mov     [nfd], eax
        sys     3, [nfd], val, 8                    ; -EAGAIN
        sys     255, [epfd], 3, [efd], ev_one       ; EPOLL_CTL_MOD, EPOLLIN|EPOLLONESHOT: 0
        sys     4, [efd], three, 8                  ; 8
        sys     256, [epfd], evs, 4, 0              ; 1
        sys     256, [epfd], evs, 4, 0              ; 0: disabled by its one shot
        sys     255, [epfd], 2, [efd], ev_in        ; EPOLL_CTL_DEL: 0
        sys     255, [epfd], 2, [efd], ev_in        ; -ENOENT
        sys     328, 2, 1                           ; eventfd2(2, EFD_SEMAPHORE): 6
        mov     [sfd], eax
        sys     3, [sfd], val, 8                    ; 8
        mov     eax, [val]                          ; 1
        call    hex
        sys     3, [sfd], val, 8                    ; 8, 1 again
        mov     eax, [val]
        call    hex
        mov     eax, 252
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
ev_in:  dd      1, 0x55667788, 0x11223344
ev_one: dd      0x40000001, 0x55667788, 0x11223344
three:  dd      3, 0
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
efd     equ     $$ + filesz
epfd    equ     efd + 4
nfd     equ     efd + 8
sfd     equ     efd + 12
val     equ     efd + 16
evs     equ     efd + 24
buf     equ     evs + 48
memsz   equ     filesz + 96
