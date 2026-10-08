; beamperiod.asm — how much work does a guest get inside ONE 0x3DA frame?
;
; The duty cycle of the retrace pulse is checkable against the CRTC (docs/notes/timing.md §4). The PERIOD
; is not: it is a ratio between two clocks — how fast the beam sweeps and how fast the guest runs —
; and only the guest can see it. So the guest measures it: sync to a retrace edge, then count poll
; iterations across one whole frame. The same binary runs in MIRAGE and in DOSBox-X, and the two
; counts are directly comparable because it is the same loop doing the counting.
;
; Result: four hex digits per frame, eight frames, written to OUT.TXT.
;
;   nasm -f bin tools/beamperiod.asm -o BEAMPER.COM

        org 0x100
        bits 16

        mov     ax, 0x0013              ; mode 13h — the standard CRTC timing
        int     0x10

        mov     ah, 0x3c                ; create OUT.TXT
        xor     cx, cx
        mov     dx, fname
        int     0x21
        jc      quit
        mov     [handle], ax

        mov     bp, 8                   ; eight frames
frame:
        mov     dx, 0x03da
        ; --- sync to a retrace edge so counting starts at a frame boundary ---
.notr:  in      al, dx
        test    al, 8
        jnz     .notr                   ; wait until NOT in retrace
.inr:   in      al, dx
        test    al, 8
        jz      .inr                    ; wait until retrace starts

        xor     bx, bx                  ; --- count one whole frame ---
.a:     inc     bx
        in      al, dx
        test    al, 8
        jnz     .a                      ; through the rest of the retrace pulse
.b:     inc     bx
        in      al, dx
        test    al, 8
        jz      .b                      ; and all the way to the next one

        call    puthex                  ; BX -> four hex digits
        dec     bp
        jnz     frame

quit:   mov     bx, [handle]
        mov     ah, 0x3e
        int     0x21
        mov     ax, 0x4c00
        int     0x21

; ---- write BX as four hex digits plus a newline ----
puthex:
        push    bp
        mov     bp, 4
        mov     di, buf
.d:     mov     ax, bx
        mov     cl, 12
        shr     ax, cl
        and     al, 15
        add     al, '0'
        cmp     al, '9'
        jbe     .ok
        add     al, 7
.ok:    mov     [di], al
        inc     di
        shl     bx, 4
        dec     bp
        jnz     .d
        pop     bp
        push    bp
        mov     bx, [handle]
        mov     ah, 0x40
        mov     cx, 6                   ; four digits + CR LF
        mov     dx, buf
        int     0x21
        pop     bp
        ret

fname   db      'OUT.TXT', 0
handle  dw      0
buf     db      '0000', 13, 10
