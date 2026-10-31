; sse.asm — SSE and SSE2 on fixed operands, each result printed in hex, one line each: the XMM
; register (32 digits, high dword first) after every arithmetic, logical, compare, convert, shuffle,
; unpack, shift and move operation src/sse.js does, in its register and memory forms -- NaN
; operands (min and max return the second; arithmetic propagates the first, quiet), invalid
; operations (the default NaN, negative), signed zeros, ties to even, the integer indefinite --
; then EAX and the arithmetic flags (masked to 8D5h) after COMISS/UCOMISS/COMISD/UCOMISD, the
; conversions to integers, and MXCSR through LDMXCSR and STMXCSR (as loaded: MIRAGE keeps no
; sticky exception flags, which the processor sets after the operations above). Docker i386
; (QEMU's SSE) prints the reference: tools/test.js compares MIRAGE's lines with it. The body is
; generated (one block per operation); yes we can (2009) is compiled for SSE.
;
;   nasm -f bin tools/linux/sse.asm -o SSE
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
obuf    equ     $$ + 0x4000
scr     equ     $$ + 0x3000
tmp     equ     $$ + 0x3100
_start: mov     edi, obuf
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        addss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        addss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        subss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        subss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        mulss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        mulss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        divss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        divss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        minss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        minss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        maxss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        maxss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        sqrtss  xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        sqrtss  xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        rcpss   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        rcpss   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        rsqrtss xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        rsqrtss xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        divps   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        divps   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        minps   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        minps   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        maxps   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        maxps   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        sqrtps  xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        sqrtps  xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        rcpps   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        rcpps   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        andps   xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        andps   xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        andnps  xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        andnps  xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        orps    xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        orps    xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        unpcklps xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        unpcklps xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        unpckhps xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        unpckhps xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cvtss2sd xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        cvtss2sd xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cvttps2dq xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        cvttps2dq xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cvtdq2pd xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        cvtdq2pd xmm0, [vb]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 0
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 0
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 1
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 1
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 2
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 2
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 3
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 3
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 4
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 4
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 5
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 5
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 6
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 6
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpps   xmm0, xmm1, 7
        call    emit
        movaps  xmm0, [va]
        cmpps   xmm0, [vb], 7
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cmpss   xmm0, xmm1, 1
        call    emit
        movaps  xmm0, [va]
        cmpss   xmm0, [vb], 1
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        minps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        minps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        minps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        minps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        maxps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        maxps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        maxps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        maxps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        minss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        minss   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        minss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        minss   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        maxss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        maxss   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        maxss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        maxss   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        cmpps   xmm0, xmm1, 0
        call    emit
        movaps  xmm0, [vn]
        cmpps   xmm0, [vz], 0
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        cmpps   xmm0, xmm1, 3
        call    emit
        movaps  xmm0, [vn]
        cmpps   xmm0, [vz], 3
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        cmpps   xmm0, xmm1, 4
        call    emit
        movaps  xmm0, [vn]
        cmpps   xmm0, [vz], 4
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        cmpps   xmm0, xmm1, 7
        call    emit
        movaps  xmm0, [vn]
        cmpps   xmm0, [vz], 7
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        addss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        addss   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        addss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        addss   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        mulss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        mulss   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        mulss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        mulss   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        divps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        divps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        divps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        divps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        subps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        subps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        subps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        subps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        addps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        addps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        addps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        addps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        mulps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        mulps   xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        mulps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        mulps   xmm0, [vn]
        call    emit
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        sqrtps  xmm0, xmm1
        call    emit
        movaps  xmm0, [vn]
        sqrtps  xmm0, [vz]
        call    emit
        movaps  xmm0, [vz]
        movaps  xmm1, [vn]
        sqrtps  xmm0, xmm1
        call    emit
        movaps  xmm0, [vz]
        sqrtps  xmm0, [vn]
        call    emit
        movaps  xmm0, [vi]
        movaps  xmm1, [vj]
        mulps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vi]
        mulps   xmm0, [vj]
        call    emit
        movaps  xmm0, [vj]
        movaps  xmm1, [vj]
        divps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vj]
        divps   xmm0, [vj]
        call    emit
        movaps  xmm0, [vi]
        movaps  xmm1, [vi]
        subps   xmm0, xmm1
        call    emit
        movaps  xmm0, [vi]
        subps   xmm0, [vi]
        call    emit
        movaps  xmm0, [vi]
        movaps  xmm1, [vj]
        rcpss   xmm0, xmm1
        call    emit
        movaps  xmm0, [vi]
        rcpss   xmm0, [vj]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        addsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        addsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        subsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        subsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        mulsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        mulsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        divsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        divsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        minsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        minsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        maxsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        maxsd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        sqrtsd  xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        sqrtsd  xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        addpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        addpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        subpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        subpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        mulpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        mulpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        divpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        divpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        minpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        minpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        maxpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        maxpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        sqrtpd  xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        sqrtpd  xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        andpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        andpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        andnpd  xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        andnpd  xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        orpd    xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        orpd    xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        xorpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        xorpd   xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        unpcklpd xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        unpcklpd xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        unpckhpd xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        unpckhpd xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        cvtsd2ss xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        cvtsd2ss xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        cvtpd2ps xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        cvtpd2ps xmm0, [db]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        cvttpd2dq xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        cvttpd2dq xmm0, [db]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        cvtps2pd xmm0, xmm1
        call    emit
        movaps  xmm0, [va]
        cvtps2pd xmm0, [vb]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        shufpd  xmm0, xmm1, 1
        call    emit
        movaps  xmm0, [da]
        shufpd  xmm0, [db], 1
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        cmppd   xmm0, xmm1, 2
        call    emit
        movaps  xmm0, [da]
        cmppd   xmm0, [db], 2
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        cmpsd   xmm0, xmm1, 4
        call    emit
        movaps  xmm0, [da]
        cmpsd   xmm0, [db], 4
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        minsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        minsd   xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        minsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        minsd   xmm0, [dn]
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        maxpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        maxpd   xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        maxpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        maxpd   xmm0, [dn]
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        addpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        addpd   xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        addpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        addpd   xmm0, [dn]
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        mulsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        mulsd   xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        mulsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        mulsd   xmm0, [dn]
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        divsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        divsd   xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        divsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        divsd   xmm0, [dn]
        call    emit
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        sqrtpd  xmm0, xmm1
        call    emit
        movaps  xmm0, [dn]
        sqrtpd  xmm0, [da]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dn]
        sqrtpd  xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        sqrtpd  xmm0, [dn]
        call    emit
        movaps  xmm0, [dinf]
        movaps  xmm1, [dj]
        mulpd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dinf]
        mulpd   xmm0, [dj]
        call    emit
        movaps  xmm0, [dj]
        movaps  xmm1, [dj]
        divsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [dj]
        divsd   xmm0, [dj]
        call    emit
        movaps  xmm0, [da]
        movaps  xmm1, [dm]
        sqrtsd  xmm0, xmm1
        call    emit
        movaps  xmm0, [da]
        sqrtsd  xmm0, [dm]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pand    xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pand    xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pandn   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pandn   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        por     xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        por     xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pxor    xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pxor    xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        paddd   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        paddd   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        psubd   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psubd   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        paddq   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        paddq   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        psubq   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psubq   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        paddw   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        paddw   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        psubw   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psubw   xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pmullw  xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pmullw  xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pcmpgtd xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pcmpgtd xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pmuludq xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pmuludq xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpcklbw xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpcklbw xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpcklwd xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpcklwd xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpckldq xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpckldq xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpckhdq xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpckhdq xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpcklqdq xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpcklqdq xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        punpckhqdq xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        punpckhqdq xmm0, [ib]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [ib]
        pshufd  xmm0, xmm1, 27
        call    emit
        movaps  xmm0, [ia]
        pshufd  xmm0, [ib], 27
        call    emit
        movaps  xmm0, [ia]
        psrld   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psrld   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psrld   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psrad   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psrad   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psrad   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        pslld   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        pslld   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        pslld   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psrlw   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psrlw   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psrlw   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psraw   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psraw   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psraw   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psllw   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psllw   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psllw   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psrlq   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psrlq   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psrlq   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psllq   xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [cnt]
        psllq   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        psllq   xmm0, [big]
        call    emit
        movaps  xmm0, [ia]
        psrldq  xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        pslldq  xmm0, 3
        call    emit
        movaps  xmm0, [ia]
        movss   xmm0, [vb]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [vb]
        movss   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        movsd   xmm0, [db]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [db]
        movsd   xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        movlps  xmm0, [vb]
        call    emit
        movaps  xmm0, [ia]
        movhps  xmm0, [vb]
        call    emit
        movaps  xmm0, [ia]
        movlpd  xmm0, [db]
        call    emit
        movaps  xmm0, [ia]
        movhpd  xmm0, [db]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [vb]
        movhlps xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [vb]
        movlhps xmm0, xmm1
        call    emit
        movaps  xmm0, [ia]
        movq    xmm0, [vb]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm1, [vb]
        movq    xmm0, xmm1
        call    emit
        movaps  xmm1, [ib]
        movaps  xmm0, [ia]
        movq    [scr], xmm1
        movaps  xmm0, [ia]
        movsd   xmm0, [scr]
        call    emit
        movaps  xmm1, [ib]
        movaps  [scr], xmm1
        movaps  xmm2, [ia]
        movlps  [scr], xmm2
        movhps  [scr+8], xmm2
        movups  xmm0, [scr]
        call    emit
        movaps  xmm1, [ib]
        movaps  [scr], xmm1
        movaps  xmm2, [ia]
        movsd   [scr+4], xmm2
        movss   [scr+12], xmm2
        movdqu  xmm0, [scr]
        call    emit
        movaps  xmm2, [ib]
        movdqa  [scr], xmm2
        movupd  xmm0, [scr]
        call    emit
        movaps  xmm2, [ia]
        movdqu  [scr+1], xmm2
        movups  [scr+20], xmm2
        movdqu  xmm0, [scr+1]
        call    emit
        movaps  xmm2, [ia]
        movupd  [scr], xmm2
        movapd  xmm0, [scr]
        call    emit
        movaps  xmm0, [ia]
        movaps  xmm2, [ib]
        movntps [scr], xmm2
        movaps  xmm0, [scr]
        call    emit
        movaps  xmm0, [va]
        movaps  xmm1, [vb]
        mov     eax, 0x8d5
        push    eax
        popfd
        comiss  xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [va]
        xor     eax, eax
        push    eax
        popfd
        comiss  xmm0, [vb]
        call    emitr
        movaps  xmm0, [vb]
        movaps  xmm1, [va]
        mov     eax, 0x8d5
        push    eax
        popfd
        comiss  xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [vb]
        xor     eax, eax
        push    eax
        popfd
        comiss  xmm0, [va]
        call    emitr
        movaps  xmm0, [va]
        movaps  xmm1, [va]
        mov     eax, 0x8d5
        push    eax
        popfd
        ucomiss xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [va]
        xor     eax, eax
        push    eax
        popfd
        ucomiss xmm0, [va]
        call    emitr
        movaps  xmm0, [vn]
        movaps  xmm1, [vz]
        mov     eax, 0x8d5
        push    eax
        popfd
        ucomiss xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [vn]
        xor     eax, eax
        push    eax
        popfd
        ucomiss xmm0, [vz]
        call    emitr
        movaps  xmm0, [da]
        movaps  xmm1, [db]
        mov     eax, 0x8d5
        push    eax
        popfd
        comisd  xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [da]
        xor     eax, eax
        push    eax
        popfd
        comisd  xmm0, [db]
        call    emitr
        movaps  xmm0, [db]
        movaps  xmm1, [da]
        mov     eax, 0x8d5
        push    eax
        popfd
        ucomisd xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [db]
        xor     eax, eax
        push    eax
        popfd
        ucomisd xmm0, [da]
        call    emitr
        movaps  xmm0, [dn]
        movaps  xmm1, [da]
        mov     eax, 0x8d5
        push    eax
        popfd
        comisd  xmm0, xmm1
        xor     eax, eax
        call    emitr
        movaps  xmm0, [dn]
        xor     eax, eax
        push    eax
        popfd
        comisd  xmm0, [da]
        call    emitr
        cvttsd2si eax, [dhv]
        call    emitr
        cvtsd2si eax, [dhv]
        call    emitr
        movsd   xmm3, [dhv]
        cvtsd2si eax, xmm3
        call    emitr
        cvttsd2si eax, [dhv+8]
        call    emitr
        cvtsd2si eax, [dhv+8]
        call    emitr
        movsd   xmm3, [dhv+8]
        cvtsd2si eax, xmm3
        call    emitr
        cvttsd2si eax, [dg]
        call    emitr
        cvtsd2si eax, [dg]
        call    emitr
        movsd   xmm3, [dg]
        cvtsd2si eax, xmm3
        call    emitr
        cvttsd2si eax, [dg+8]
        call    emitr
        cvtsd2si eax, [dg+8]
        call    emitr
        movsd   xmm3, [dg+8]
        cvtsd2si eax, xmm3
        call    emitr
        cvttsd2si eax, [db]
        call    emitr
        cvtsd2si eax, [db]
        call    emitr
        movsd   xmm3, [db]
        cvtsd2si eax, xmm3
        call    emitr
        cvttsd2si eax, [dbig]
        call    emitr
        cvtsd2si eax, [dbig]
        call    emitr
        movsd   xmm3, [dbig]
        cvtsd2si eax, xmm3
        call    emitr
        mov     ecx, -7
        movaps  xmm0, [da]
        cvtsi2sd xmm0, ecx
        call    emit
        movaps  xmm0, [da]
        cvtsi2sd xmm0, [ib]
        call    emit
        mov     dword [scr], 0x1f80
        ldmxcsr [scr]
        stmxcsr [scr+8]
        mov     eax, [scr+8]
        call    emitr
        mov     dword [scr], 0x1fa0
        ldmxcsr [scr]
        stmxcsr [scr+4]
        mov     eax, [scr+4]
        call    emitr
        mov     dword [scr], 0x1f80
        ldmxcsr [scr]
        sfence
        lfence
        mfence
        mov     edx, edi                         ; write(1, out, len)
        sub     edx, obuf
        mov     ecx, obuf
        mov     ebx, 1
        mov     eax, 4
        int     0x80
        mov     eax, 1
        xor     ebx, ebx
        int     0x80
emit:   movups  [tmp], xmm0                      ; 32 hex digits, high dword first, and a newline
        mov     eax, [tmp + 12]
        call    hex32
        mov     eax, [tmp + 8]
        call    hex32
        mov     eax, [tmp + 4]
        call    hex32
        mov     eax, [tmp]
        call    hex32
        mov     byte [edi], 10
        inc     edi
        ret
emitr:  pushfd                                   ; EAX, a space, the flags & 8D5h, a newline
        call    hex32
        mov     byte [edi], 32
        inc     edi
        pop     eax
        and     eax, 0x8d5
        call    hex32
        mov     byte [edi], 10
        inc     edi
        ret
hex32:  mov     ecx, 8
.h:     rol     eax, 4
        mov     edx, eax
        and     edx, 15
        mov     dl, [digits + edx]
        mov     [edi], dl
        inc     edi
        loop    .h
        ret
digits: db      '0123456789abcdef'
align 16
va:     dd      1.5, -2.5, 0.0, 100.0
vb:     dd      0.75, -0.0, 3.0, 1.0e-3
vn:     dd      0x7fc00000, 1.0, -0.0, 0.0
vz:     dd      2.0, 0xffa00001, 0.0, -0.0
vi:     dd      0x7f800000, 0.0, 0xff800000, 1.0
vj:     dd      0.0, 0x7f800000, 0x7f800000, -0.0
da:     dq      1.5, -2.25
db:     dq      0.1, 3.0
dn:     dq      0x7ff4000000000001, 1.0
dinf:   dq      0x7ff0000000000000, 0.0
dj:     dq      0.0, 0x7ff0000000000000
dm:     dq      -4.0, 9.0
ia:     dd      0x80017fff, 0xfffe0102, 0x12345678, 0x7fffffff
ib:     dd      0x7f80ff01, 0x80008000, 0xfffffff0, 0x00000003
cnt:    dq      4, 0
big:    dq      0x100000000, 0
dhv:    dq      2.5, -2.5
dg:     dq      3.5, -0.5
dbig:   dq      3.0e10, 0.0
filesz  equ     $ - $$
memsz   equ     0x20000
