#!/bin/zsh
# Sweep the memory-strategy matrix on real workloads, 3 runs each, median reported.
MIR="$(cd "$(dirname "$0")/.." && pwd)"
S=$(dirname $0)
med3() { print -l $1 $2 $3 | sort -n | sed -n 2p; }
printf '%-16s %12s %12s %12s\n' 'READ/WRITE' 'tube' 'memories' 'WOLF3D'
for combo in inline:inline paged:inline inline:paged paged:paged; do
  R=${combo%%:*}; W=${combo##*:}
  vals=()
  for prog in intros/tube.com intros/memories.com; do
    r=()
    for i in 1 2 3; do
      v=$(MIRAGE_MEM_READ=$R MIRAGE_MEM_WRITE=$W ROOT=$MIR SECS=3 VCPU=0 node $S/tput.mjs $prog 2>/dev/null \
          | grep -oE '[0-9]+\.[0-9]+ Mcycles/s' | cut -d' ' -f1)
      r+=(${v:-0})
    done
    vals+=($(med3 $r[1] $r[2] $r[3]))
  done
  w=()
  for i in 1 2 3; do
    v=$(MIRAGE_MEM_READ=$R MIRAGE_MEM_WRITE=$W node $S/d6-profile.mjs WOLF3DSW WOLF3D.EXE 4 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+ M cycles' | cut -d' ' -f1)
    w+=(${v:-0})
  done
  printf '%-16s %12s %12s %12s\n' "$R/$W" $vals[1] $vals[2] $(med3 $w[1] $w[2] $w[3])
done
