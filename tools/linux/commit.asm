; commit.asm — what an OASIS `run` layer keeps (lx.changes, tools/oasis.mjs): over a host tree of
; /keep, /mod and /old, it reads /keep, appends "!" to /mod, removes /old, makes /new (mode 640,
; "hi"), a symbolic link /lnk -> /new and a directory /dir (700); exits 0. Kept: /mod and /new, /lnk,
; /dir, the removal of /old — not /keep, which was only read.
;
;   nasm -f bin tools/linux/commit.asm -o COMMIT && chmod +x COMMIT
        bits    32
        org     0x08048000
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      2                               ; ET_EXEC
        dw      3                               ; EM_386
        dd      1
        dd      _start
        dd      phdr - $$
        dd      0
        dd      0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1                               ; PT_LOAD
        dd      0, $$, $$
        dd      filesz, filesz + 16
        dd      7                               ; R+W+X
        dd      0x1000
phsize  equ     $ - phdr

_start: mov     eax, 5                          ; open("/keep", O_RDONLY), read a byte, close
        mov     ebx, fkeep
        xor     ecx, ecx
        int     0x80
        mov     ebx, eax
        mov     eax, 3
        mov     ecx, buf
        mov     edx, 1
        int     0x80
        mov     eax, 6
        int     0x80
        mov     eax, 5                          ; open("/mod", O_WRONLY|O_APPEND), write "!", close
        mov     ebx, fmod
        mov     ecx, 0x401
        int     0x80
        mov     ebx, eax
        mov     eax, 4
        mov     ecx, bang
        mov     edx, 1
        int     0x80
        mov     eax, 6
        int     0x80
        mov     eax, 10                         ; unlink("/old")
        mov     ebx, fold
        int     0x80
        mov     eax, 5                          ; open("/new", O_CREAT|O_WRONLY, 0640), write "hi", close
        mov     ebx, fnew
        mov     ecx, 0x41
        mov     edx, 0o640
        int     0x80
        mov     ebx, eax
        mov     eax, 4
        mov     ecx, hi
        mov     edx, 2
        int     0x80
        mov     eax, 6
        int     0x80
        mov     eax, 83                         ; symlink("/new", "/lnk")
        mov     ebx, fnew
        mov     ecx, flnk
        int     0x80
        mov     eax, 39                         ; mkdir("/dir", 0700)
        mov     ebx, fdir
        mov     ecx, 0o700
        int     0x80
        mov     eax, 1                          ; exit(0)
        xor     ebx, ebx
        int     0x80
fkeep   db      '/keep', 0
fmod    db      '/mod', 0
fold    db      '/old', 0
fnew    db      '/new', 0
flnk    db      '/lnk', 0
fdir    db      '/dir', 0
bang    db      '!'
hi      db      'hi'
filesz  equ     $ - $$
buf     equ     $$ + filesz
