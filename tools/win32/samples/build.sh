#!/bin/sh
# The samples' .exe files, built by MinGW-w64 in Docker: image mirage-w32-samples, the Wine oracle's
# (mirage-oracle-wine-x: i386 Debian, Wine, Xvfb, ImageMagick) with MinGW-w64, mtools and genisoimage
# added once. Also samples.iso, the CD the oracle's Windows 2000 runs them from (not kept in git).
set -e
here=$(cd "$(dirname "$0")" && pwd)
if ! docker image inspect mirage-w32-samples >/dev/null 2>&1; then
  docker rm -f mirage-w32-samples-build >/dev/null 2>&1 || true
  docker run --platform linux/386 --name mirage-w32-samples-build mirage-oracle-wine-x sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gcc-mingw-w64-i686 binutils-mingw-w64-i686 genisoimage >/dev/null'
  docker commit mirage-w32-samples-build mirage-w32-samples >/dev/null && docker rm mirage-w32-samples-build >/dev/null
fi
docker run --rm --platform linux/386 -v "$here":/s -w /s mirage-w32-samples sh -c '
  for c in *.c; do n=${c%.c}; res=""
    if [ -f "$n.rc" ]; then i686-w64-mingw32-windres "$n.rc" -O coff -o "/tmp/$n.res"; res="/tmp/$n.res"; fi
    i686-w64-mingw32-gcc -O1 -s -mwindows -o "$n.exe" "$c" $res -lcomctl32 && echo "built $n.exe"
  done
  mkdir -p /tmp/iso && cp *.exe /tmp/iso/ && genisoimage -quiet -J -r -V SAMPLES -o samples.iso /tmp/iso && echo "built samples.iso"'
