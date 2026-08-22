; tickq.asm — is 0040:006C the PIT counter, or a software counter kept by the BIOS INT 8 handler?
;
; It decides where the BDA tick belongs. If it were the counter, masking IRQ0 at the PIC would not
; touch it; if it is software, masking freezes it — and then a game that reprograms counter 0 keeps
; 0040:006C at 18.2 Hz by chaining to the BIOS handler only once every N of its own ticks, which is
; exactly the mechanism MIRAGE was missing.
;
; tools/test-dos-api.js asserted the first answer ("the counter is not the interrupt"). This program
; asks the reference, with its own control: the same loop, same length, IRQ0 left alone.
;
;   nasm -f bin tools/tickq.asm -o TICKQ.COM          ; masks IRQ0
;   nasm -f bin -DNOMASK tools/tickq.asm -o CTRL.COM  ; control
;   dosbox-x -conf <conf> -nomenu -fastlaunch -exit \
;     -c "mount c <dir>" -c "c:" -c "CTRL.COM > CTRL.TXT" -c "TICKQ.COM > MASK.TXT" -c "exit"
;
; Use a SLOW clock — DOSBox `cycles = fixed N` is N cycles per MILLISECOND, so at the default the
; whole loop finishes inside half a tick and the control reads "frozen" too, which is how the first
; run of this looked like a result and was not one.
;
; Measured, dosbox-x, cycles = fixed 3000:
;   control (IRQ0 unmasked): RESULT: BDA TICK ADVANCED
;   masked:                  RESULT: BDA TICK FROZEN
;
        org 0x100
start:  mov     ax, 0x40
        mov     es, ax
        cli
        in      al, 0x21
        mov     bl, al                  ; save the IMR
%ifndef NOMASK
        or      al, 1                   ; mask IRQ0
        out     0x21, al
%endif
        mov     ax, [es:0x6c]
        mov     si, ax                  ; tick before
        sti                             ; IF on, but IRQ0 is masked at the PIC
        mov     cx, 40
.outer: xor     dx, dx
.inner: dec     dx
        jnz     .inner
        loop    .outer
        mov     ax, [es:0x6c]
        mov     di, ax                  ; tick after
        cli
        mov     al, bl
        out     0x21, al                ; restore the IMR
        sti
        mov     ax, di
        sub     ax, si
        mov     dx, msg_frozen
        or      ax, ax
        jz      .say
        mov     dx, msg_moved
.say:   mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21
msg_frozen: db 'RESULT: BDA TICK FROZEN', 13, 10, '$'
msg_moved:  db 'RESULT: BDA TICK ADVANCED', 13, 10, '$'
