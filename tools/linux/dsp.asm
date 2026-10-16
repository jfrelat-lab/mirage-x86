; dsp.asm — /dev/dsp as an OSS program of 1997 sets it up: open, SNDCTL_DSP_SPEED 11025, SETFMT
; AFMT_S16_LE, STEREO, GETOSPACE (16 fragments of 4 KiB, OSS's default geometry), then a write of
; 4096 bytes. Exit status: bit 0 the rate read back, 1 the format, 2 fragstotal, 3 fragsize, 4 the
; write — 31 when all hold. No /dev/dsp: open fails and the status is 0. Docker has no OSS to compare
; with; the values are linux/soundcard.h's, and what DOOM's sndserver and Quake's snd_linux.c ask.
;
;   nasm -f bin tools/linux/dsp.asm -o DSP && chmod +x DSP
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
_start: xor     edi, edi                        ; the result bits
        mov     eax, 5                          ; open("/dev/dsp", O_WRONLY)
        mov     ebx, path
        mov     ecx, 1
        int     0x80
        test    eax, eax
        js      done
        mov     [fd], eax
        mov     ecx, 0xc0045002                 ; SPEED
        mov     edx, speed
        call    ioctl
        cmp     dword [speed], 11025
        jne     .f
        or      edi, 1
.f:     mov     ecx, 0xc0045005                 ; SETFMT
        mov     edx, fmt
        call    ioctl
        cmp     dword [fmt], 0x10
        jne     .s
        or      edi, 2
.s:     mov     ecx, 0xc0045003                 ; STEREO
        mov     edx, stereo
        call    ioctl
        mov     ecx, 0x8010500c                 ; GETOSPACE
        mov     edx, info
        call    ioctl
        cmp     dword [info + 4], 16
        jne     .z
        or      edi, 4
.z:     cmp     dword [info + 8], 4096
        jne     .w
        or      edi, 8
.w:     mov     eax, 4                          ; write(fd, buf, 4096)
        mov     ebx, [fd]
        mov     ecx, buf
        mov     edx, 4096
        int     0x80
        cmp     eax, 4096
        jne     done
        or      edi, 16
done:   mov     ebx, edi
        mov     eax, 1
        int     0x80
ioctl:  mov     eax, 54
        mov     ebx, [fd]
        int     0x80
        ret
path:   db      '/dev/dsp', 0
speed:  dd      11025
fmt:    dd      0x10
stereo: dd      1
filesz  equ     $ - $$
fd:     dd      0
info:   dd      0, 0, 0, 0
buf:    times 4096 db 0
memsz   equ     $ - $$
