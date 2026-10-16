; oldcalls.asm — the older system calls libc5 (1997) makes, which a toolchain of its time needs:
; creat with mode 0755 (stat then says 0755 under umask 022: ld's output is executable), fcntl (55)
; F_SETFD then F_GETFD (FD_CLOEXEC), getdents (141) on "." finding that file, readdir (89) giving
; one entry. Exit status bits: 0 the mode, 1 F_GETFD, 2 getdents found T.X, 3 readdir answered 1.
; MIRAGE had no creat, kept no mode, no fcntl 55, getdents 141 nor readdir. Docker i386/debian on an
; ARM Mac answers 7: bits 0-2 as here, and readdir refused — that Docker is qemu-user, which lacks it;
; the i386 kernel has old_readdir (fs/readdir.c, __ARCH_WANT_OLD_READDIR). MIRAGE: 15.
;
;   nasm -f bin tools/linux/oldcalls.asm -o OLDCALLS && chmod +x OLDCALLS
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
_start: xor     edi, edi
        mov     eax, 60                         ; umask(022)
        mov     ebx, 0o22
        int     0x80
        mov     eax, 8                          ; creat("T.X", 0755)
        mov     ebx, name
        mov     ecx, 0o755
        int     0x80
        mov     [fd], eax
        mov     eax, 106                        ; stat("T.X", st): st_mode at 8
        mov     ebx, name
        mov     ecx, st
        int     0x80
        movzx   eax, word [st + 8]
        and     eax, 0o777
        cmp     eax, 0o755
        jne     .fd
        or      edi, 1
.fd:    mov     eax, 55                         ; fcntl(fd, F_SETFD, FD_CLOEXEC)
        mov     ebx, [fd]
        mov     ecx, 2
        mov     edx, 1
        int     0x80
        mov     eax, 55                         ; fcntl(fd, F_GETFD)
        mov     ebx, [fd]
        mov     ecx, 1
        int     0x80
        cmp     eax, 1
        jne     .gd
        or      edi, 2
.gd:    mov     eax, 5                          ; open(".", O_RDONLY|O_DIRECTORY)
        mov     ebx, dot
        mov     ecx, 0x10000
        int     0x80
        mov     [dfd], eax
.next:  mov     eax, 141                        ; getdents(dfd, buf, 4096)
        mov     ebx, [dfd]
        mov     ecx, buf
        mov     edx, 4096
        int     0x80
        test    eax, eax
        jle     .rd
        mov     esi, buf                        ; walk the records: d_reclen at +8, the name at +10
        lea     edx, [buf + eax]
.rec:   cmp     esi, edx
        jae     .next
        cmp     dword [esi + 10], 'T.X'         ; "T.X\0"
        jne     .skip
        or      edi, 4
.skip:  movzx   eax, word [esi + 8]
        add     esi, eax
        jmp     .rec
.rd:    mov     eax, 5                          ; open(".") again
        mov     ebx, dot
        mov     ecx, 0x10000
        int     0x80
        mov     ebx, eax
        mov     eax, 89                         ; readdir(fd, dirent, 1)
        mov     ecx, buf
        mov     edx, 1
        int     0x80
        cmp     eax, 1
        jne     done
        or      edi, 8
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
name:   db      'T.X', 0
dot:    db      '.', 0
filesz  equ     $ - $$
fd:     dd      0
dfd:    dd      0
st:     times 96 db 0
buf:    times 4096 db 0
memsz   equ     $ - $$
