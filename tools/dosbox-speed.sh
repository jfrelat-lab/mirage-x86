#!/bin/zsh
# Run the CPUSPEED probe under DOSBox-X at several `cycles` settings and report each result.
# The probe writes C:\SPEED.TXT, and C: is a mounted host dir, so the answer lands on the host.
set -u
MIR="$(cd "$(dirname "$0")/.." && pwd)"
DOSBOX=/opt/homebrew/bin/dosbox-x
OUT=$(mktemp -d)

printf '%-28s %s\n' 'dosbox configuration' 'work units in 3.02s'
for SPEC in normal:auto normal:max dynamic:max dynamic_x86:max; do
  CORE=${SPEC%%:*}; CYC=${SPEC##*:}
  W="$OUT/${CORE}_${CYC}"; mkdir -p "$W"
  cp "$MIR/demos/CPUSPEED.COM" "$W/CPUSPEED.COM"
  cat > "$W/db.conf" <<CONF
[sdl]
output=surface
autolock=false
[dosbox]
logfile=
[cpu]
core=$CORE
cputype=pentium
cycles=$CYC
[autoexec]
mount c $W
c:
CPUSPEED.COM
exit
CONF
  SDL_VIDEODRIVER=dummy perl -e 'alarm 25; exec @ARGV' "$DOSBOX" -conf "$W/db.conf" -exit >/dev/null 2>&1
  RES=$(tr -d '\r\n' < "$W/SPEED.TXT" 2>/dev/null)
  printf '%-28s %s\n' "core=$CORE cycles=$CYC" "${RES:-<no result>}"
done
echo
echo "(each unit = 10000 inner loop iterations = ~20000 retired instructions)"
