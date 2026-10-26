; pebwalk.asm — what Crinkler's header does to find Windows' functions, in a PE of its own: fs:[30h] is
; the PEB, [PEB+0Ch] its loader data, whose load-order list runs exe, ntdll.dll, kernel32.dll (Windows
; XP's order); kernel32's export directory gives ExitProcess by name, called with 42 — the exit status.
; The image imports lz32.dll's ordinal 4 (LZClose), as Crinkler's do: the loader binds its IAT entry.
;
;   nasm -f bin tools/win32/pebwalk.asm -o PEBWALK.EXE
        bits    32
        org     0
%define RVA(x)  ((x) - sect + 0x1000)                   ; the one section: file 200h, RVA 1000h
%define VA(x)   (0x400000 + RVA(x))
mz:     dw      'MZ'
        times 0x3c - ($ - mz) db 0
        dd      pe
pe:     dd      'PE'
        dw      0x14c, 1                                ; i386, one section
        dd      0, 0, 0
        dw      opt_end - opt, 0x102                    ; optional header size; executable, 32-bit
opt:    dw      0x10b                                   ; PE32
        db      0, 0
        dd      0x200, 0, 0, RVA(code), 0x1000, 0
        dd      0x400000, 0x1000, 0x200                 ; ImageBase, section and file alignment
        dw      4, 0, 0, 0, 4, 0
        dd      0, 0x2000, 0x200, 0                     ; SizeOfImage, SizeOfHeaders, checksum
        dw      3, 0                                    ; console subsystem
        dd      0x100000, 0x1000, 0x100000, 0x1000, 0, 16
        dd      0, 0                                    ; exports
        dd      RVA(idir), idir_end - idir              ; imports
        times 14 dd 0, 0
opt_end:
        db      '.text', 0, 0, 0
        dd      0x1000, 0x1000, 0x200, 0x200, 0, 0
        dw      0, 0
        dd      0xe0000020                              ; code, read, write, execute
        times 0x200 - ($ - mz) db 0

sect:
code:   mov     eax, [fs:0x30]                          ; the PEB
        mov     eax, [eax + 0x0c]                       ; PEB_LDR_DATA
        mov     eax, [eax + 0x0c]                       ; InLoadOrderModuleList.Flink: the exe
        mov     eax, [eax]                              ; ntdll.dll
        mov     eax, [eax]                              ; kernel32.dll
        mov     ebx, [eax + 0x18]                       ; its DllBase
        mov     eax, [ebx + 0x3c]
        mov     edx, [ebx + eax + 0x78]                 ; the export directory's RVA
        add     edx, ebx
        mov     ecx, [edx + 0x18]                       ; NumberOfNames
        mov     ebp, [edx + 0x20]                       ; AddressOfNames
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
        mov     eax, [edx + 0x24]                       ; AddressOfNameOrdinals
        add     eax, ebx
        movzx   eax, word [eax + ecx * 2]
        mov     esi, [edx + 0x1c]                       ; AddressOfFunctions
        add     esi, ebx
        mov     eax, [esi + eax * 4]
        add     eax, ebx                                ; ExitProcess
        cmp     dword [VA(iat)], 0                      ; LZClose bound by the loader?
        je      .fail
        push    42
        call    eax
.fail:  int3                                            ; a fault: the walk or the binding went wrong
exitname: db    'ExitProcess', 0
exitlen equ     $ - exitname

idir:   dd      RVA(ilt), 0, 0, RVA(lzname), RVA(iat)   ; lz32.dll
        dd      0, 0, 0, 0, 0
idir_end:
ilt:    dd      0x80000004, 0                           ; ordinal 4
iat:    dd      0x80000004, 0
lzname: db      'lz32.dll', 0
        times 0x400 - ($ - mz) db 0
