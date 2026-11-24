; clone.asm — a thread as Linux makes one (glibc's pthread_create, libuv's uv_thread_create): clone
; with CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|PARENT_SETTID|CHILD_CLEARTID on a stack of its own. The
; thread writes a line, stores its getpid and gettid, sets a flag and FUTEX_WAKEs it, then exits alone
; (exit, not exit_group); the kernel clears its tid word and wakes it. The parent FUTEX_WAITs on each
; word in turn. Lines: the thread's, then whether PARENT_SETTID wrote clone's result, whether the
; thread shares the parent's pid (same tgid) with a tid of its own, the word cleared, a FUTEX_WAIT
; on a value that differs (EAGAIN: -11), one that times out (ETIMEDOUT: -110), a FUTEX_WAKE of no one
; (0). Private futexes (FUTEX_PRIVATE_FLAG), as glibc and musl use them: Docker i386 here, QEMU's user
; mode under OrbStack, answers a shared one on this mapping with EFAULT. Docker prints the reference.
;
;   nasm -f bin tools/linux/clone.asm -o CLONE
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

_start: mov     eax, 120                ; clone
        mov     ebx, 0x350f00
        mov     ecx, stktop
        mov     edx, ptid
        xor     esi, esi
        mov     edi, ctid
        int     0x80
        test    eax, eax
        jz      thread
        mov     [tid], eax
.flag:  cmp     dword [flag], 0         ; FUTEX_WAIT(&flag, 0) until the thread sets it
        jne     .joined
        mov     eax, 240
        mov     ebx, flag
        mov     ecx, 128                ; FUTEX_WAIT_PRIVATE
        xor     edx, edx
        xor     esi, esi
        int     0x80
        jmp     .flag
.joined: mov    edx, [ctid]             ; FUTEX_WAIT(&ctid, ctid) until the kernel clears it
        test    edx, edx
        jz      .gone
        mov     eax, 240
        mov     ebx, ctid
        mov     ecx, 128
        xor     esi, esi
        int     0x80
        jmp     .joined
.gone:  mov     eax, [ptid]             ; PARENT_SETTID: 1 when it holds clone's result
        cmp     eax, [tid]
        sete    al
        movzx   eax, al
        call    hex
        mov     eax, 20                 ; getpid: the thread's is the same
        int     0x80
        cmp     eax, [tpid]
        sete    al
        movzx   eax, al
        call    hex
        mov     eax, [ttid]             ; its tid is clone's result and not the pid
        cmp     eax, [tid]
        sete    al
        movzx   eax, al
        call    hex
        mov     eax, [ttid]
        cmp     eax, [tpid]
        setne   al
        movzx   eax, al
        call    hex
        mov     eax, [ctid]             ; cleared: 0
        call    hex
        mov     eax, 240                ; FUTEX_WAIT(&flag, 5): flag is 1, -EAGAIN
        mov     ebx, flag
        mov     ecx, 128                ; FUTEX_WAIT_PRIVATE
        mov     edx, 5
        xor     esi, esi
        int     0x80
        call    hex
        mov     eax, 240                ; FUTEX_WAIT(&flag, 1, 10 ms): -ETIMEDOUT
        mov     ebx, flag
        mov     ecx, 128                ; FUTEX_WAIT_PRIVATE
        mov     edx, 1
        mov     esi, tenms
        int     0x80
        call    hex
        mov     eax, 240                ; FUTEX_WAKE(&flag, 1): no one, 0
        mov     ebx, flag
        mov     ecx, 129                ; FUTEX_WAKE_PRIVATE, one
        mov     edx, 1
        int     0x80
        call    hex
        mov     eax, 252
        xor     ebx, ebx
        int     0x80
thread: mov     eax, 4
        mov     ebx, 1
        mov     ecx, hello
        mov     edx, hellen
        int     0x80
        mov     eax, 20                 ; getpid
        int     0x80
        mov     [tpid], eax
        mov     eax, 224                ; gettid
        int     0x80
        mov     [ttid], eax
        mov     dword [flag], 1
        mov     eax, 240                ; FUTEX_WAKE(&flag, 1)
        mov     ebx, flag
        mov     ecx, 129                ; FUTEX_WAKE_PRIVATE, one
        mov     edx, 1
        int     0x80
        mov     eax, 1                  ; exit: this thread only
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
hello:  db      'thread', 10
hellen  equ     $ - hello
tenms:  dd      0, 10000000
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
flag    equ     $$ + ((filesz + 3) & ~3)
ptid    equ     flag + 4
ctid    equ     flag + 8
tid     equ     flag + 12
tpid    equ     flag + 16
ttid    equ     flag + 20
buf     equ     flag + 24
stktop  equ     flag + 48 + 1024
memsz   equ     filesz + 52 + 1024
