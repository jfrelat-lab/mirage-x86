; planar.asm — EGA/VGA mode 0Dh (320x200x16 planar) regression demo. It exercises the Graphics
; Controller / Sequencer write pipeline that a chunky framebuffer never touches, so it guards
; src/vga.js end-to-end: write mode 2 (colour from the data byte's low nibble), write mode 0 with
; Set/Reset + Bit Mask, the Sequencer Map Mask (per-plane write enable), and write mode 1 (latch
; copy, which also covers the read-latch path). Output is static — no timer, no input — so the
; plane state is a stable golden fingerprint.
;
;   nasm -f bin planar.asm -o PLANAR.COM

        org 0x100
        bits 16
start:
        mov     ax, 0x000d          ; set 320x200x16 planar mode
        int     0x10
        push    0xa000
        pop     es
        mov     dx, 0x3ce           ; Graphics Controller index/data

        ; ---- band 1 (rows 0..49): write mode 2 → 16 colour bars ----
        mov     ax, 0x0205          ; GC5 Graphics Mode = write mode 2
        out     dx, ax
        mov     ax, 0xff08          ; GC8 Bit Mask = 0xff
        out     dx, ax
        xor     di, di
        xor     bx, bx
.bars:  mov     ax, bx
        shr     ax, 1
        shr     ax, 1               ; colour = row >> 2
        and     al, 0x0f
        mov     cx, 40
        rep     stosb               ; wm2 fans AL's low nibble across the four planes
        inc     bx
        cmp     bx, 50
        jne     .bars

        ; ---- band 2 (rows 50..99): write mode 0 + Set/Reset + Bit Mask → dither of colour 9/0 ----
        mov     ax, 0x0005          ; GC5 = write mode 0
        out     dx, ax
        mov     ax, 0x0f01          ; GC1 Enable Set/Reset = all four planes
        out     dx, ax
        mov     ax, 0x0900          ; GC0 Set/Reset value = 9
        out     dx, ax
        mov     ax, 0xaa08          ; GC8 Bit Mask = 0xAA → masked pixels take Set/Reset(9), rest take latch(0)
        out     dx, ax
        mov     di, 50*40
        mov     cx, 50*40
.dith:  mov     al, [es:di]         ; read loads the latches (0 here)
        mov     byte [es:di], 0     ; wm0: masked bits <- Set/Reset(9), unmasked <- latch(0)
        inc     di
        loop    .dith

        ; ---- band 3 (rows 100..149): Sequencer Map Mask → write only planes 0+2 (colour 5) ----
        mov     ax, 0x0205          ; write mode 2
        out     dx, ax
        mov     ax, 0xff08          ; bit mask 0xff
        out     dx, ax
        mov     dx, 0x3c4           ; Sequencer
        mov     ax, 0x0502          ; SEQ2 Map Mask = planes 0 and 2 (0b0101)
        out     dx, ax
        mov     dx, 0x3ce
        mov     di, 100*40
        mov     al, 0x0f            ; ask for colour 15; Map Mask lets only planes 0,2 land -> colour 5
        mov     cx, 50*40
        rep     stosb
        mov     dx, 0x3c4
        mov     ax, 0x0f02          ; restore Map Mask = all planes
        out     dx, ax
        mov     dx, 0x3ce

        ; ---- band 4 (rows 150..199): write mode 1 latch-copy of band 1 (the colour bars) ----
        mov     ax, 0x0105          ; GC5 = write mode 1 (latch copy)
        out     dx, ax
        xor     si, si              ; source = band 1
        mov     di, 150*40
        mov     cx, 50*40
.copy:  mov     al, [es:si]         ; read loads the four latches from the source
        mov     byte [es:di], 0     ; wm1 stores the latches to the destination (data ignored)
        inc     si
        inc     di
        loop    .copy

.hang:  jmp     .hang
