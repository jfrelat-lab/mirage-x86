#!/bin/bash
# Build tools/int10gfx.asm and run it on QEMU, DOSBox-X and MIRAGE.
S=$(cd "$(dirname "$0")" && pwd); M=$(dirname "$(dirname "$S")")
nasm -f bin $M/tools/int10gfx.asm -o /tmp/int10gfx.img && nasm -f bin -DCOM $M/tools/int10gfx.asm -o /tmp/INT10GFX.COM || exit 1
python3 -c "
d=open('/tmp/int10gfx.img','rb').read(); open('/tmp/int10gfx.img','wb').write(d+bytes(1474560-len(d)))"
echo "== QEMU"; (ulimit -t 30; /opt/homebrew/bin/qemu-system-i386 -drive format=raw,file=/tmp/int10gfx.img,if=floppy -serial stdio -display none -device isa-debug-exit,iobase=0xf4,iosize=4 -no-reboot 2>&1 | tr -d '\r' > /tmp/int10gfx.qemu.txt); cat /tmp/int10gfx.qemu.txt
W=$(mktemp -d /tmp/i10dbx.XXXXXX); cp /tmp/INT10GFX.COM $W/; rm -f /tmp/int10gfx.dbx.txt
printf '[sdl]\nautolock=false\n[log]\nlogfile=\n[dosbox]\nmachine=svga_s3\n[cpu]\ncore=normal\ncycles=fixed 20000\n[serial]\nserial1=file file:/tmp/int10gfx.dbx.txt\n' > $W/dbx.conf
(ulimit -t 60; SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy /opt/homebrew/bin/dosbox-x -conf $W/dbx.conf -nomenu -fastlaunch -exit -c "mount c $W" -c "c:" -c "INT10GFX.COM" -c "exit" >/dev/null 2>&1 & p=$!; for i in $(seq 1 40); do grep -q DONE /tmp/int10gfx.dbx.txt 2>/dev/null && break; sleep 1; done; sleep 1; kill -9 $p 2>/dev/null; wait $p 2>/dev/null)
rm -rf $W; echo "== DOSBox-X"; tr -d '\r' < /tmp/int10gfx.dbx.txt
echo "== MIRAGE"; node $S/serialboot.mjs /tmp/int10gfx.img | tr -d '\r'
