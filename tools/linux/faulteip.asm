; faulteip.asm — the EIP a page fault reports, from the middle of a block whose other accesses take
; the paged fast path: a load and a store to a mapped page, then a load from page 0, which is not
; mapped. The SIGSEGV handler's sigcontext holds the faulting instruction's address; the handler
; exits with its distance from _start, 37, as Docker i386 exits.
;
;   nasm -f bin tools/linux/faulteip.asm -o FAULTEIP
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
data    equ     $$ + 0x1000
_start: mov     eax, 174                        ; rt_sigaction(SIGSEGV, &act, 0, 8)
        mov     ebx, 11
        mov     ecx, act
        xor     edx, edx
        mov     esi, 8
        int     0x80
        mov     esi, data
        mov     eax, [esi]                      ; the fast path, reading
        mov     [esi + 4], eax                  ; and writing
        add     eax, 1
.fault: mov     ebx, [0x10]                     ; page 0: the fault
        mov     eax, 1
        int     0x80
handler:
        mov     ebx, [esp + 8 + 14 * 4]         ; sigcontext's eip, after the return address and signal
        sub     ebx, _start
        mov     eax, 1
        int     0x80
act:    dd      handler, 0, 0, 0, 0             ; sa_handler, sa_flags, sa_restorer, sa_mask
filesz  equ     $ - $$
memsz   equ     0x2000
