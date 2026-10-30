; tinyhdr.asm — a PE laid out as Crinkler's /TINYHEADER lays one out: no section, section and file
; alignment 4, the code in the headers' own bytes past the optional header, and a SizeOfImage larger
; than the file. Windows maps such an image flat (the whole file at the base, offset = RVA); the code
; walks the PEB to kernel32's ExitProcess, as pebwalk.asm does, reads a byte past the headers' 40h
; and one past the file's end (zero), and exits with their sum, 42 + 0.
;
;   nasm -f bin tools/win32/tinyhdr.asm -o TINYHDR.EXE
        bits    32
        org     0
%define VA(x)   (0x400000 + (x) - mz)
mz:     dw      'MZ'
        dw      0
pe:     dd      'PE'                                    ; at 4: e_lfanew (3Ch) is SectionAlignment, 4
        dw      0x14c, 0                                ; i386, no section
        dd      0, 0, 0
        dw      opt_end - opt, 0x102
opt:    dw      0x10b
        db      0, 0
        dd      0, 0, 0, code - mz, 0, 0
        dd      0x400000, 4, 4                          ; ImageBase, section and file alignment 4
        dw      4, 0, 0, 0, 4, 0
        dd      0, 0x10000, 0x40, 0                     ; SizeOfImage (past the file), SizeOfHeaders 40h
        dw      3, 0
        dd      0x100000, 0x1000, 0x100000, 0x1000, 0, 0  ; no data directories
opt_end:
code:   mov     eax, [fs:0x30]                          ; the PEB
        mov     eax, [eax + 0x0c]
        mov     eax, [eax + 0x0c]                       ; the exe
        mov     eax, [eax]                              ; ntdll.dll
        mov     eax, [eax]                              ; kernel32.dll
        mov     ebx, [eax + 0x18]
        mov     eax, [ebx + 0x3c]
        mov     edx, [ebx + eax + 0x78]
        add     edx, ebx
        mov     ecx, [edx + 0x18]
        mov     ebp, [edx + 0x20]
        add     ebp, ebx
.next:  dec     ecx
        js      .fail
        mov     esi, [ebp + ecx * 4]
        add     esi, ebx
        mov     edi, VA(exitname)
        push    ecx
        mov     ecx, exitlen
        repe    cmpsb
        pop     ecx
        jne     .next
        mov     eax, [edx + 0x24]
        add     eax, ebx
        movzx   eax, word [eax + ecx * 2]
        mov     esi, [edx + 0x1c]
        add     esi, ebx
        mov     eax, [esi + eax * 4]
        add     eax, ebx                                ; ExitProcess
        movzx   ecx, byte [VA(answer)]                  ; 42, from the file past SizeOfHeaders
        movzx   edx, byte [VA(fileend) + 0x100]         ; 0, from SizeOfImage past the file
        add     ecx, edx
        push    ecx
        call    eax
.fail:  int3
exitname: db    'ExitProcess', 0
exitlen equ     $ - exitname
answer: db      42
fileend:
