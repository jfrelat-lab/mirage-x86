; oplnotes.asm — a known sequence of OPL sounds, to record here and on a reference OPL and compare.
; A table of register writes and waits (in BIOS ticks, 55 ms): each section exercises one part of
; the chip, separated by silence so a comparison can cut the recording into sections.
;   1  a pure sine, 440 Hz (F-number 244h, block 4), carrier only
;   2  two-operator FM: the same carrier, modulated (modulator TL 20)
;   3  a slow envelope: attack rate 6, decay rate 5, no sustain
;   4  feedback 7 on the modulator, carrier in additive mode
;   5  OPL2 waveforms 1, 2, 3 (WSE on)
;   6  vibrato and tremolo at full depth
;   7  rhythm mode: bass drum, snare, tom, cymbal, hi-hat
;   8  OPL3: a note left, then right; waveforms 4-7; a four-operator voice
;
;   nasm -f bin tools/oplnotes.asm -o OPLNOTES.COM
        org 0x100
        bits 16
        mov     si, seq
.next:  lodsb
        cmp     al, 0xfe                ; end
        je      .done
        cmp     al, 0xff                ; wait N ticks
        je      .wait
        mov     dx, 0x388               ; AL = bank, then register, value
        test    al, al
        jz      .b0
        mov     dx, 0x38a
.b0:    lodsb
        out     dx, al
        call    delay
        inc     dx
        lodsb
        out     dx, al
        call    delay
        jmp     .next
.wait:  lodsb
        xor     ah, ah
        mov     cx, ax
        xor     ax, ax
        mov     es, ax
.t:     mov     bx, [es:0x46c]
.tw:    cmp     bx, [es:0x46c]
        je      .tw
        loop    .t
        jmp     .next
.done:  mov     ax, 0x4c00
        int     0x21
delay:  push    cx                      ; the documented minimum after a write, and more
        push    dx
        mov     dx, 0x388
        mov     cx, 40
.d:     in      al, dx
        loop    .d
        pop     dx
        pop     cx
        ret

%macro W 2                              ; bank 0 register, value
        db      0, %1, %2
%endmacro
%macro W1 2                             ; bank 1
        db      1, %1, %2
%endmacro
%macro WAIT 1
        db      0xff, %1
%endmacro
%macro VOICE 0                          ; channel 0: modulator op 0 (20h..), carrier op 3 (23h..)
        W       0x20, 0x21              ; mod: EGT, mult 1
        W       0x23, 0x21              ; car: EGT, mult 1
        W       0x60, 0xf0              ; mod: AR 15, DR 0
        W       0x63, 0xf0              ; car: AR 15, DR 0
        W       0x80, 0x0f              ; mod: SL 0, RR 15
        W       0x83, 0x0f              ; car: SL 0, RR 15
%endmacro
%define NOTE_ON  W 0xb0, 0x31           ; key on, block 4, F-number high bits 1
%define NOTE_OFF W 0xb0, 0x11

seq:
        W       0x01, 0x20              ; waveform select enable
        W       0x04, 0x60              ; timers off
        W       0xbd, 0x00
        WAIT    4
        ; 1 — pure sine
        VOICE
        W       0x40, 0x3f              ; mod silent
        W       0x43, 0x00              ; car full
        W       0xc0, 0x01              ; additive: the carrier alone sounds
        W       0xa0, 0x44
        NOTE_ON
        WAIT    18
        NOTE_OFF
        WAIT    9
        ; 2 — FM
        W       0x40, 0x14
        W       0xc0, 0x00              ; serial: modulator into carrier
        NOTE_ON
        WAIT    18
        NOTE_OFF
        WAIT    9
        ; 3 — slow envelope
        W       0x40, 0x3f
        W       0xc0, 0x01
        W       0x23, 0x01              ; car: no sustain (EGT 0)
        W       0x63, 0x65              ; AR 6, DR 5
        W       0x83, 0x05              ; SL 0, RR 5
        NOTE_ON
        WAIT    36
        NOTE_OFF
        WAIT    18
        ; 4 — feedback 7, additive, both operators heard
        VOICE
        W       0x40, 0x00
        W       0x43, 0x00
        W       0xc0, 0x0f              ; FB 7, additive
        NOTE_ON
        WAIT    18
        NOTE_OFF
        WAIT    9
        ; 5 — waveforms 1, 2, 3 on the carrier
        W       0x40, 0x3f
        W       0xc0, 0x01
        W       0xe3, 0x01
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x02
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x03
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x00
        ; 6 — vibrato and tremolo, full depth
        W       0xbd, 0xc0
        W       0x23, 0xe1              ; car: AM, VIB, EGT, mult 1
        NOTE_ON
        WAIT    36
        NOTE_OFF
        WAIT    9
        W       0xbd, 0x00
        W       0x23, 0x21
        ; 7 — rhythm: channels 6, 7, 8 in rhythm mode
        W       0x30, 0x01              ; BD mod (op 12): mult 1
        W       0x33, 0x01              ; BD car (op 15)
        W       0x50, 0x10
        W       0x53, 0x00
        W       0x70, 0xf6
        W       0x73, 0xf6
        W       0x90, 0x06
        W       0x93, 0x06
        W       0x31, 0x01              ; HH (op 13), TOM (op 14)
        W       0x32, 0x01
        W       0x34, 0x01              ; SD (op 16), CY (op 17)
        W       0x35, 0x01
        W       0x51, 0x00
        W       0x52, 0x00
        W       0x54, 0x00
        W       0x55, 0x00
        W       0x71, 0xf6
        W       0x72, 0xf6
        W       0x74, 0xf6
        W       0x75, 0xf6
        W       0x91, 0x06
        W       0x92, 0x06
        W       0x94, 0x06
        W       0x95, 0x06
        W       0xa6, 0x57              ; channel 6: 57h, block 2
        W       0xb6, 0x09
        W       0xa7, 0x57              ; channel 7
        W       0xb7, 0x09
        W       0xa8, 0x57              ; channel 8
        W       0xb8, 0x09
        W       0xc6, 0x00
        W       0xbd, 0x30              ; rhythm on, bass drum
        WAIT    5
        W       0xbd, 0x20
        W       0xbd, 0x28              ; snare
        WAIT    5
        W       0xbd, 0x20
        W       0xbd, 0x24              ; tom
        WAIT    5
        W       0xbd, 0x20
        W       0xbd, 0x22              ; cymbal
        WAIT    5
        W       0xbd, 0x20
        W       0xbd, 0x21              ; hi-hat
        WAIT    5
        W       0xbd, 0x00
        WAIT    9
        ; 8 — OPL3
        W1      0x05, 0x01              ; OPL3 mode
        VOICE
        W       0x40, 0x3f
        W       0x43, 0x00
        W       0xc0, 0x11              ; left only, additive
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xc0, 0x21              ; right only
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xc0, 0x31              ; both
        W       0xe3, 0x04
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x05
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x06
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x07
        NOTE_ON
        WAIT    9
        NOTE_OFF
        WAIT    4
        W       0xe3, 0x00
        ; four operators: channels 0 and 3, FM-FM (both connection bits 0)
        W1      0x04, 0x01
        W       0x28, 0x21              ; ops 6, 9 (channel 3's)
        W       0x2b, 0x21
        W       0x48, 0x18
        W       0x4b, 0x00
        W       0x68, 0xf0
        W       0x6b, 0xf0
        W       0x88, 0x0f
        W       0x8b, 0x0f
        W       0x40, 0x18
        W       0xc0, 0x30
        W       0xc3, 0x30
        NOTE_ON
        WAIT    18
        NOTE_OFF
        WAIT    9
        W1      0x04, 0x00
        W1      0x05, 0x00
        db      0xfe
