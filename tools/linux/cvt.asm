; cvt.asm — SSE's conversions between a float and an int32, as Retrospection's Linux port (2010)
; converts its synthesizer's samples: CVTTSS2SI (truncated) and CVTSS2SI (rounded to nearest even,
; MXCSR's default) of 2.5, -2.5, 3.5, -3.7, 1e10 and a NaN — the last two the integer indefinite,
; 80000000h — and CVTSI2SS of -7. Each result written to stdout as eight hex digits and a newline.
; Docker i386/debian prints the expected lines.
;
;   nasm -f bin tools/linux/cvt.asm -o CVT
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

_start: mov     esi, vals
        mov     edi, nvals
.each:  cvttss2si eax, [esi]
        call    hex
        cvtss2si eax, [esi]
        call    hex
        add     esi, 4
        dec     edi
        jnz     .each
        mov     eax, -7
        cvtsi2ss xmm0, eax
        movd    eax, xmm0
        call    hex
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
; eax as eight hex digits and a newline on stdout
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
vals:   dd      2.5, -2.5, 3.5, -3.7, 1.0e10, 0x7fc00000
nvals   equ     ($ - vals) / 4
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
buf     equ     $$ + filesz
memsz   equ     filesz + 16
