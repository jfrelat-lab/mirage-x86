; bootload.asm — a two-sector boot image: the sector the BIOS loads reads the NEXT one through
; INT 13h and jumps into it. This is the smallest thing that actually exercises the disk path, and
; the shape every real bootloader (and every DOS kernel) has.
;
;   nasm -f bin demos/bootload.asm -o demos/BOOTLOAD.IMG
;   node tools/run-boot.mjs demos/BOOTLOAD.IMG 20000
;
; Success prints "STAGE2 OK" from the second sector; a failed read prints "READ FAIL" from the first.
; The image is exactly two sectors — no floppy padding — so run-boot.mjs gives it a synthetic
; single-track geometry rather than one of the standard formats.

BITS 16
ORG 0x7C00

start:
    xor  ax, ax
    mov  ds, ax
    mov  es, ax
    mov  ss, ax
    mov  sp, 0x7C00

    mov  ah, 0x00                 ; reset the controller first, as a real loader does
    mov  dl, [drive]
    int  0x13

    mov  ax, 0x0201               ; AH=02 read, AL=1 sector
    mov  bx, 0x7E00               ; ES:BX -> just past this sector
    mov  cx, 0x0002               ; cylinder 0, sector 2 (sectors are 1-based)
    mov  dh, 0x00                 ; head 0
    mov  dl, [drive]
    int  0x13
    jc   readfail

    jmp  0x0000:0x7E00            ; into stage 2

readfail:
    mov  si, failmsg
.putc:
    lodsb
    test al, al
    jz   .done
    mov  ah, 0x0E                 ; teletype
    mov  bx, 0x0007
    int  0x10
    jmp  .putc
.done:
    hlt
    jmp  .done

drive   db 0x00
failmsg db "READ FAIL", 0

    times 510-($-$$) db 0
    dw 0xAA55

; ---- sector 2: loaded by the code above ------------------------------------
stage2:
    mov  si, okmsg
.putc:
    lodsb
    test al, al
    jz   .done
    mov  ah, 0x0E
    mov  bx, 0x0007
    int  0x10
    jmp  .putc
.done:
    hlt
    jmp  .done

okmsg db "STAGE2 OK", 0

    times 1024-($-$$) db 0        ; finish sector 2
