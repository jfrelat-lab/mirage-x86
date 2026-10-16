; shm.asm — System V shared memory between two processes, as MIT-SHM shares an X client's picture
; with the server: ipc(SHMGET, IPC_PRIVATE, 4096, IPC_CREAT|0600); fork; the child attaches it and
; writes 5A5A5A5Ah, then exits; the parent waits, attaches the same segment and reads the value back;
; IPC_STAT says 4096 bytes. Exit status bits: 0 the value, 1 the size — 3. MIRAGE had no ipc (117).
; Docker i386/debian on an ARM host answers 1: the value, but its qemu-user reads the OLD shmid_ds
; otherwise; the kernel's i386 headers (uapi shm.h, ipc.h: 16-bit uid, gid and mode) put shm_segsz at 16.
;
;   nasm -f bin tools/linux/shm.asm -o SHM && chmod +x SHM
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
        mov     eax, 117                        ; ipc(SHMGET, IPC_PRIVATE, 4096, IPC_CREAT|0600)
        mov     ebx, 23
        xor     ecx, ecx
        mov     edx, 4096
        mov     esi, 0o1600
        int     0x80
        mov     [id], eax
        mov     eax, 2                          ; fork
        int     0x80
        test    eax, eax
        jnz     parent
        call    attach                          ; child: attach, write, exit
        mov     dword [eax], 0x5a5a5a5a
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
parent: mov     eax, 114                        ; wait4(-1, 0, 0, 0)
        mov     ebx, -1
        xor     ecx, ecx
        xor     edx, edx
        xor     esi, esi
        int     0x80
        call    attach
        cmp     dword [eax], 0x5a5a5a5a
        jne     .st
        or      edi, 1
.st:    mov     eax, 117                        ; ipc(SHMCTL, id, IPC_STAT, 0, buf)
        mov     ebx, 24
        mov     ecx, [id]
        mov     edx, 2
        xor     esi, esi
        push    edi
        mov     edi, ds_
        int     0x80
        pop     edi
        cmp     dword [ds_ + 16], 4096          ; shm_segsz
        jne     done
        or      edi, 2
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
attach: mov     eax, 117                        ; ipc(SHMAT, id, 0, &raddr, 0) -> raddr
        mov     ebx, 21
        mov     ecx, [id]
        xor     edx, edx
        mov     esi, raddr
        push    edi
        xor     edi, edi
        int     0x80
        pop     edi
        mov     eax, [raddr]
        ret
filesz  equ     $ - $$
id:     dd      0
raddr:  dd      0
ds_:    times 64 db 0
memsz   equ     $ - $$
