; fistind.asm — FIST and FISTP of values an integer of their width cannot hold: the x87 stores the
; "integer indefinite", the most negative integer, and raises IE (invalid operation) in the status
; word. First the limits that do fit -- -2^31 and 2147483647.4 to a doubleword, -32768 and 32767 to a
; word, -2^63 to a quadword -- and IE still clear; then 1e19 to a quadword and IE set; then, IE cleared,
; 1.5e11 and -3e9 to a doubleword (FISTP, then FIST), 40000 to a word, a NaN to a doubleword, and IE set. Each result written
; to stdout as eight hex digits and a newline (a quadword's high half first). Docker i386/debian
; prints the expected lines.
;
;   nasm -f bin tools/linux/fistind.asm -o FISTIND
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

%macro  d32 1                                   ; FISTP m32 of the double at %1, printed
        fld     qword [%1]
        fistp   dword [res]
        mov     eax, [res]
        call    hex
%endmacro
%macro  w16 1                                   ; FISTP m16, sign-extended
        fld     qword [%1]
        fistp   word [res]
        movsx   eax, word [res]
        call    hex
%endmacro
%macro  q64 1                                   ; FISTP m64, high half then low
        fld     qword [%1]
        fistp   qword [res]
        mov     eax, [res + 4]
        call    hex
        mov     eax, [res]
        call    hex
%endmacro
%macro  ie 0                                    ; IE, from FNSTSW
        fnstsw  ax
        and     eax, 1
        call    hex
%endmacro

_start: finit
        d32     m2p31
        d32     max32
        w16     m32768
        fld     qword [max16]                   ; FIST m16, no pop
        fist    word [res]
        fstp    st0
        movsx   eax, word [res]
        call    hex
        q64     m2p63
        ie
        q64     e19
        ie
        fnclex
        d32     big
        fld     qword [nbig]                    ; FIST m32, no pop
        fist    dword [res]
        fstp    st0
        mov     eax, [res]
        call    hex
        w16     h40000
        d32     qnan
        ie
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
m2p31:  dq      -2147483648.0
max32:  dq      2147483647.4
m32768: dq      -32768.0
max16:  dq      32767.0
m2p63:  dq      -9223372036854775808.0
big:    dq      1.5e11
nbig:   dq      -3.0e9
h40000: dq      40000.0
qnan:   dq      0x7ff8000000000000
e19:    dq      1.0e19
digits: db      '0123456789abcdef'
filesz  equ     $ - $$
res     equ     $$ + filesz
buf     equ     res + 8
memsz   equ     filesz + 24
