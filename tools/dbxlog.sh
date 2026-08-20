#!/bin/bash
# dbxlog.sh <dir> <prog> <seconds> <out> — capture one DOSBox-X -debug log for a corpus entry.
#
# DOSBox-X has no "run for N ms then quit": the guest decides when to exit. So it is killed from
# outside, which means the log is a PREFIX of a full run, never a complete one. Every consumer has to
# treat it that way.
# LOADFIX=1 runs the program through DOS's LOADFIX, which moves it above the first 64 KB. An
# EXEPACK'd program loaded that low dies with "Packed file is corrupt" — Maniac Mansion does, and
# then the reference is a program that never ran.
set -u
dir=$1; prog=$2; secs=$3; out=$4
conf=$(mktemp /tmp/dbxlog.XXXXXX)   # BSD mktemp wants the X's last, so no .conf suffix
cat > "$conf" <<EOF
[log]
logfile = $out
[sdl]
autolock = false
[dosbox]
machine = svga_s3
[cpu]
core = normal
cycles = fixed 20000
EOF
rm -f "$out"
export SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy
dosbox-x -conf "$conf" -debug -log-int21 -log-fileio -nomenu -fastlaunch -exit \
  -c "mount c $dir" -c "c:" -c "${LOADFIX:+LOADFIX }$prog" -c "exit" >/dev/null 2>&1 &
p=$!
sleep "$secs"
kill -9 $p 2>/dev/null
wait $p 2>/dev/null
rm -f "$conf"
