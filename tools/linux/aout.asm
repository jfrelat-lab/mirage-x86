; aout.asm — a Linux a.out ZMAGIC program, the format before ELF: a 32-byte struct exec padded to
; 1024 bytes, then the text, which runs at address 0 (fs/binfmt_aout.c). Its stack holds argc, then
; POINTERS to argv[] and envp[] (create_aout_tables) — no auxiliary vector. It prints argv[1] and
; exits with argc. id's Linux DOOM (linuxsdoom, 1994) is a ZMAGIC binary. No kernel since 5.18
; loads a.out, and Docker's qemu-user does not, so the expectation comes from the kernel's source:
; "abc" and status 2 for `AOUT abc`.
;
;   nasm -f bin tools/linux/aout.asm -o AOUT && chmod +x AOUT
        bits    32
        dd      0x0064010b                      ; a_info: ZMAGIC, machine type 100 (i386)
        dd      text_end                        ; a_text
        dd      0                               ; a_data
        dd      0                               ; a_bss
        dd      0, 0, 0, 0                      ; a_syms, a_entry 0, a_trsize, a_drsize
        times 1024 - ($ - $$) db 0
        org     0                               ; the text runs at address 0
section .text vstart=0
start:  mov     ebp, [esp]                      ; argc
        mov     esi, [esp + 4]                  ; argv: a pointer to the array
        mov     ecx, [esi + 4]                  ; argv[1]
        xor     edx, edx
.len:   cmp     byte [ecx + edx], 0
        je      .put
        inc     edx
        jmp     .len
.put:   mov     eax, 4
        mov     ebx, 1
        int     0x80
        mov     eax, 1
        mov     ebx, ebp
        int     0x80
text_end:
