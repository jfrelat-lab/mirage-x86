; mzalloc.asm — what does DOS give an .EXE whose header asks for NOTHING?
;
; KERNEL.EXE (Windows 3.0) has e_minalloc = e_maxalloc = 0, and everything about how its loader lays
; out its heap follows from the block DOS hands it. Two readings settle it:
;
;   PSP:0002        the paragraph past the block the loader handed over
;   AH=48h BX=FFFF  always fails and returns the largest free block, in paragraphs
;
; If DOS honours the header literally, the block is just the image and a large free block remains.
; If DOS treats "asks for nothing" as "give it everything" — the behaviour some loaders special-case
; — PSP:0002 is the top of memory and nothing is free. Guessing which has already cost this project
; one wrong hypothesis; this asks.
;
; The MZ header is written out by hand rather than produced by a linker, because the whole point is
; to control e_minalloc/e_maxalloc exactly, and no assembler here emits .EXE files.
;
; ⚠️ In a hand-written MZ, nasm's labels count from byte 0 of the FILE while the guest's offsets
; count from the start of the IMAGE, 32 bytes later. The first version of this printed 1.2 MB of
; garbage for exactly that reason. Every label used at run time therefore goes through OFF().
;
;   nasm -f bin tools/mzalloc.asm -o MZALLOC.EXE
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "MZALLOC.EXE > OUT.TXT" -c "exit"
;
; Build the CONTROL with -dMAXALLOC=0xffff: an ordinary MZ, whose answers are known (loaded low, the
; block runs to the top of memory, nothing free). A probe whose control does not read as expected is
; measuring itself, not DOS.
;
; ⚠️ Never pass -eraseconf to dosbox-x: it deletes the user's own configuration.

BITS 16

%define HDRPARAS 2                      ; 32-byte header
%define OFF(x)   ((x) - imgstart)       ; file offset -> offset within the loaded image
%define IMGBYTES (imgend - imgstart)
%define TOTAL    (HDRPARAS*16 + IMGBYTES)

; ---- MZ header ------------------------------------------------------------
                db 'M', 'Z'
                dw TOTAL % 512          ; e_cblp   bytes in the last page
                dw (TOTAL + 511) / 512  ; e_cp     pages
                dw 0                    ; e_crlc   no relocations
                dw HDRPARAS             ; e_cparhdr
%ifndef MAXALLOC
  %define MAXALLOC 0                    ; -dMAXALLOC=0xffff builds the ordinary-MZ control
%endif
                dw 0                    ; e_minalloc  <-- the point of this program
                dw MAXALLOC             ; e_maxalloc  <-- the point of this program
                dw 0                    ; e_ss     relative to the load segment
                dw OFF(stacktop)        ; e_sp
                dw 0                    ; e_csum
                dw OFF(start)           ; e_ip
                dw 0                    ; e_cs
                dw 0x1c                 ; e_lfarlc
                dw 0                    ; e_ovno
                times HDRPARAS*16 - ($ - $$) db 0

imgstart:
start:
                mov     ax, cs
                mov     ds, ax                  ; CS = DS = the load segment; the PSP is 0x10 below
                sub     ax, 0x10
                mov     es, ax                  ; ES = PSP

                mov     dx, OFF(msg_psp)
                call    puts
                mov     ax, es
                call    puthex

                mov     dx, OFF(msg_top)
                call    puts
                mov     ax, [es:0x02]           ; PSP:0002 — top of the block DOS handed over
                call    puthex

                ; AH=48h with BX=FFFF cannot succeed; it reports the largest free block in BX.
                ; The MCB one paragraph below the PSP says what DOS actually handed over, which
                ; PSP:0002 alone does not: its size field is the block in paragraphs.
                mov     dx, OFF(msg_mcb)
                call    puts
                mov     ax, es
                dec     ax
                mov     ds, ax
                xor     si, si
                mov     al, [si]                ; signature 'M' (more follow) or 'Z' (last)
                mov     dl, al
                mov     ah, 0x02
                int     0x21
                mov     ax, cs
                mov     ds, ax
                mov     dx, OFF(msg_owner)
                call    puts
                mov     ax, es
                dec     ax
                mov     ds, ax
                mov     ax, [si+1]              ; owner PSP
                push    ax
                mov     ax, [si+3]              ; size in paragraphs
                mov     bp, ax
                mov     ax, cs
                mov     ds, ax
                pop     ax
                call    puthex
                mov     dx, OFF(msg_size)
                call    puts
                mov     ax, bp
                call    puthex

                mov     dx, OFF(msg_free)
                call    puts
                mov     bx, 0xffff
                mov     ah, 0x48
                int     0x21
                jnc     .gotall                 ; a success here would itself be news
                mov     ax, bx
                call    puthex
                jmp     .after
.gotall:        push    ax
                mov     dx, OFF(msg_odd)
                call    puts
                pop     ax
                call    puthex
.after:
                mov     dx, OFF(crlf)
                call    puts
                mov     ax, 0x4c00
                int     0x21

; ---- helpers --------------------------------------------------------------
puts:           mov     ah, 0x09
                int     0x21
                ret

puthex:         mov     cx, 4                   ; AX as four hex digits
.next:          rol     ax, 4
                push    ax
                and     al, 0x0f
                add     al, '0'
                cmp     al, '9'
                jbe     .emit
                add     al, 7
.emit:          mov     dl, al
                mov     ah, 0x02
                int     0x21
                pop     ax
                loop    .next
                ret

msg_psp:        db 13, 10, 'PSP=', '$'
msg_top:        db ' PSP0002=', '$'
msg_free:       db ' LARGEST-FREE-PARAS=', '$'
msg_mcb:        db ' MCB=', '$'
msg_owner:      db ' OWNER=', '$'
msg_size:       db ' SIZEPARAS=', '$'
msg_odd:        db '(48h SUCCEEDED, AX=)', '$'
crlf:           db 13, 10, '$'

                align 16
                times 0x400 db 0                ; room for the stack: with minalloc=0 the block is
stacktop:                                       ; only as big as the image, so the stack must be IN it
imgend:
