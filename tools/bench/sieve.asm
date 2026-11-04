; sieve.asm — BYTE's Sieve of Eratosthenes (8190 flags), 5000 times, in 16-bit real mode: the same
; instructions on every emulator, timed by the host. Prints the primes found (1899), then DONE.
; 730.7 M instructions. Measured on an Apple M1, wall clock: DOSBox-X (dynamic core, cycles=max)
; 6.2 s and PCjs's COMPAQ DeskPro 386 at its highest speed (about 53 MHz) 64.3 s (2026-10-13);
; MIRAGE 6.6-6.8 s in the DOS player (dos.html?run=SIEVE.COM, which leaves part of each frame to the
; display) and 4.84-4.87 s headless (tools/harness.mjs, runSlice to the end) (2026-11-04, blocks
; chained without paging; 11.1 s and 7.5 s before). A real-mode program, because DJGPP's Dhrystone stopped on PCjs with a general protection
; fault inside CWSDPMI.
;
;   nasm -f bin tools/bench/sieve.asm -o SIEVE.COM
        org     0x100
SIZE    equ     8190
ITER    equ     5000
        mov     word [iter], ITER
.again: mov     di, flags                       ; all flags true
        mov     cx, SIZE + 1
        mov     al, 1
        rep     stosb
        xor     bx, bx                          ; count
        xor     si, si                          ; i
.next:  cmp     byte [flags + si], 0
        je      .skip
        mov     ax, si                          ; prime = i + i + 3
        add     ax, si
        add     ax, 3
        mov     dx, si
        add     dx, ax                          ; k = i + prime
.mark:  cmp     dx, SIZE
        ja      .done1
        mov     di, dx
        mov     byte [flags + di], 0
        add     dx, ax
        jmp     .mark
.done1: inc     bx
.skip:  inc     si
        cmp     si, SIZE
        jbe     .next
        dec     word [iter]
        jnz     .again
        mov     ax, bx                          ; print the count (1899)
        mov     di, num + 4
        mov     cx, 10
.dig:   xor     dx, dx
        div     cx
        add     dl, '0'
        mov     [di], dl
        dec     di
        test    ax, ax
        jnz     .dig
        mov     dx, msg
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21
msg     db      'primes '
num     db      '     ', 13, 10, 'DONE', 13, 10, '$'
iter    dw      0
flags:
