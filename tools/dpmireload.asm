; dpmireload.asm — does a DPMI host reload the client's segment registers on the way back from
; INT 31h? A descriptor change made through INT 31h reaches a segment register already holding that
; selector only if something reloads it: the hardware keeps the cached copy until then. A real host
; runs INT 31h at ring 0 with its own selectors and restores the client's on return, which reloads
; them; DJGPP's crt0 relies on that when it widens DS to 4 GiB and keeps using DS (Jump 'n Bump).
;
; For each of ES, FS, GS and DS: allocate a selector with base A, load it, change the base to B
; through AX=0007h, then read byte 0 through the register. 'A' = the cached descriptor survived,
; 'B' = the register was reloaded. Writes one line to DPMIRL.TXT, e.g. "ES=B FS=B GS=B DS=B".
; A 32-bit client (CWSDPMI accepts no other); the code segment stays 16-bit, as DPMI gives it.
;
;   nasm -f bin tools/dpmireload.asm -o DPMIRL.COM      (run CWSDPMI first where there is no host)
        org 0x100
        bits 16
        mov     ah, 0x4a                ; shrink to 64 KiB so the host can have its data block
        mov     bx, 0x1000
        int     0x21
        mov     [rseg], cs
        mov     ah, 0x3c                ; the output file is created in real mode, written later
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      near quit
        mov     [handle], ax
        mov     ax, 0x1687
        int     0x2f
        test    ax, ax
        jnz     near quit               ; no host
        mov     [entry], di
        mov     [entry + 2], es
        mov     bx, si                  ; host private data, SI paragraphs
        mov     ah, 0x48
        int     0x21
        jc      near quit
        mov     es, ax
        mov     ax, 1                   ; 32-bit client
        call    far [entry]
        jc      near quit

        mov     ax, 6                   ; DS base -> dsbase
        mov     bx, ds
        int     0x31
        mov     [dsbase], dx
        mov     [dsbase + 2], cx
        xor     ax, ax                  ; one descriptor
        mov     cx, 1
        int     0x31
        mov     [sel], ax
        mov     bx, ax
        mov     ax, 8                   ; limit FFFFh
        xor     cx, cx
        mov     dx, 0xffff
        int     0x31

        mov     si, bufA
        call    setbase
        mov     es, [sel]
        mov     si, bufB
        call    setbase
        mov     al, [es:0]
        mov     [res + 3], al

        mov     si, bufA
        call    setbase
        mov     fs, [sel]
        mov     si, bufB
        call    setbase
        mov     al, [fs:0]
        mov     [res + 8], al

        mov     si, bufA
        call    setbase
        mov     gs, [sel]
        mov     si, bufB
        call    setbase
        mov     al, [gs:0]
        mov     [res + 13], al

        mov     si, bufA                ; DS last: the base for B is computed before DS moves
        call    setbase
        mov     si, bufB
        call    linear                  ; CX:DX = B
        mov     bx, [sel]
        push    ds
        mov     ds, bx
        mov     ax, 7
        int     0x31
        mov     al, [0]
        pop     ds
        mov     [res + 18], al

        push    ds                      ; write the line: AH=40h through AX=0300h
        pop     es
        mov     word [rm_eax], 0x4000
        mov     ax, [handle]
        mov     [rm_ebx], ax
        mov     word [rm_ecx], reslen
        mov     word [rm_edx], res
        mov     ax, [rseg]
        mov     [rm_ds], ax
        mov     ax, 0x300
        mov     bx, 0x21
        xor     cx, cx
        mov     edi, rmcs
        int     0x31
quit:   mov     ax, 0x4c00              ; DOS closes the file
        int     0x21

linear:                                 ; SI = offset in our data -> CX:DX = linear address
        mov     dx, [dsbase]
        mov     cx, [dsbase + 2]
        add     dx, si
        adc     cx, 0
        ret
setbase:                                ; base of [sel] := linear address of SI
        call    linear
        mov     bx, [sel]
        mov     ax, 7
        int     0x31
        ret

fname   db      'DPMIRL.TXT', 0
res     db      'ES=? FS=? GS=? DS=?', 13, 10
reslen  equ     $ - res
bufA    db      'A'
bufB    db      'B'
rseg    dw      0
handle  dw      0
entry   dd      0
dsbase  dd      0
sel     dw      0
rmcs:                                   ; DPMI real mode call structure, 32h bytes
rm_edi  dd      0
rm_esi  dd      0
rm_ebp  dd      0
        dd      0
rm_ebx  dd      0
rm_edx  dd      0
rm_ecx  dd      0
rm_eax  dd      0
rm_flg  dw      0
rm_es   dw      0
rm_ds   dw      0
rm_fs   dw      0
rm_gs   dw      0
rm_ip   dw      0
rm_cs   dw      0
rm_sp   dw      0
rm_ss   dw      0
