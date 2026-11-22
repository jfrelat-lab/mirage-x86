; imulflags.asm — the flags IMUL and MUL leave, the ones the architecture calls undefined (SF, ZF, AF, PF)
; with the defined ones (CF, OF): each form on operand pairs whose product is positive, negative, zero, and
; with a low half that is zero or negative while the whole is not. Each line: EFLAGS & 8D5h (OF SF ZF AF PF
; CF) as eight hex digits. Docker i386 prints the reference lines.
;
;   nasm -f bin tools/linux/imulflags.asm -o IMULF
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

_start: mov     esi, pairs
        mov     edi, npairs
.each:  mov     eax, [esi]              ; imul r32, r/m32
        mov     ebx, [esi + 4]
        imul    eax, ebx
        call    flags
        mov     eax, [esi]              ; imul r32, r/m32, imm8
        imul    eax, eax, -3
        call    flags
        mov     eax, [esi]              ; imul r/m32: EDX:EAX
        imul    dword [esi + 4]
        call    flags
        mov     eax, [esi]              ; mul r/m32
        mul     dword [esi + 4]
        call    flags
        mov     ax, [esi]               ; imul r16, r/m16
        imul    ax, [esi + 4]
        call    flags
        mov     al, [esi]               ; imul r/m8: AX
        imul    byte [esi + 4]
        call    flags
        add     esi, 8
        dec     edi
        jnz     .each
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
; the flags as they are now, masked, as eight hex digits and a newline
flags:  pushfd
        pop     eax
        and     eax, 0x8d5
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
pairs:  dd      3, 5                    ; small, positive
        dd      -7, 9                   ; negative
        dd      0, 12345                ; zero
        dd      0x10000, 0x10000        ; 2^32: the low half zero, CF/OF set
        dd      0x40000000, 3           ; the low half negative, the whole positive
        dd      -1, -1                  ; one
        dd      0x12345, 0x6789         ; mixed
        dd      0x80, 0x2               ; 256: 8-bit forms overflow
npairs  equ     ($ - pairs) / 8
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
buf     equ     $$ + filesz
memsz   equ     filesz + 16
