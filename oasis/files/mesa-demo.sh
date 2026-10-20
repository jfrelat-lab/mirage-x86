#!/bin/sh
# demo <name>: show one of the Mesa demos built in the image, in place of the one shown before.
# (twm's menu in linux/mesa-1997 calls it: two demos at once would share Mesa's software rasteriser
# and each run at half speed.)
pidfile=/tmp/mesa-demo.pid
[ -f $pidfile ] && kill $(cat $pidfile) 2>/dev/null
case $1 in
  atlantis) cd /usr/src/progs/demos/atlantis ;;
  *) cd /usr/src/progs/mesademos ;;
esac
./$1 &
echo $! > $pidfile
