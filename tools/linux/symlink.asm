; symlink.asm — a PIE (ET_DYN, position-independent: every address from a call/pop base) that makes
; a file "t.b" holding "ok", a symbolic link "t.l" -> "t.b", reads the file back THROUGH the link and
; reads the link itself; prints "ok t.b" and exits 7. A kernel loads an ET_DYN at a base of its own
; choosing (5655_5000h with randomisation off); MIRAGE-LINUX loaded only ET_EXEC and had no links.
; Docker i386/debian: "ok t.b", 7.
;
;   nasm -f bin tools/linux/symlink.asm -o SYMLINK && chmod +x SYMLINK
        bits    32
        org     0
ehdr:   db      0x7f, 'ELF', 1, 1, 1, 0
        times 8 db 0
        dw      3                               ; ET_DYN
        dw      3                               ; EM_386
        dd      1
        dd      _start
        dd      phdr - $$
        dd      0
        dd      0
        dw      ehsize, phsize, 1, 0, 0, 0
ehsize  equ     $ - ehdr
phdr:   dd      1                               ; PT_LOAD
        dd      0, 0, 0
        dd      filesz, filesz
        dd      7                               ; R+W+X
        dd      0x1000
phsize  equ     $ - phdr

_start: call    .base
.base:  pop     ebp
        sub     ebp, .base                      ; ebp = load address
        mov     eax, 5                          ; open("t.b", O_CREAT|O_WRONLY)
        lea     ebx, [ebp + fileb]
        mov     ecx, 0x41
        mov     edx, 0o644
        int     0x80
        mov     ebx, eax
        mov     eax, 4                          ; write "ok"
        lea     ecx, [ebp + okstr]
        mov     edx, 2
        int     0x80
        mov     eax, 6                          ; close
        int     0x80
        mov     eax, 83                         ; symlink("t.b", "t.l")
        lea     ebx, [ebp + fileb]
        lea     ecx, [ebp + filel]
        int     0x80
        mov     eax, 5                          ; open("t.l", O_RDONLY): through the link
        lea     ebx, [ebp + filel]
        xor     ecx, ecx
        int     0x80
        mov     ebx, eax
        mov     eax, 3                          ; read 2 into out
        lea     ecx, [ebp + out]
        mov     edx, 2
        int     0x80
        mov     eax, 85                         ; readlink("t.l", out + 3, 16)
        lea     ebx, [ebp + filel]
        lea     ecx, [ebp + out + 3]
        mov     edx, 16
        int     0x80
        lea     edx, [eax + 4]                  ; "ok " + target + "\n"
        mov     byte [ebp + out + 3 + eax], 10
        mov     eax, 4
        mov     ebx, 1
        lea     ecx, [ebp + out]
        int     0x80
        mov     eax, 1
        mov     ebx, 7
        int     0x80

fileb   db      't.b', 0
filel   db      't.l', 0
okstr:  db      'ok'
out:    db      '?? ', 0
        times 20 db 0
filesz  equ     $ - $$
