#!/bin/sh
# Lots 1 to 4 of v86's image catalogue, into boot/v86/ (gitignored, like every third-party image).
# Each file is checked against the size v86's own catalogue declares; a short or HTML error body
# would otherwise boot as garbage and read as a MIRAGE defect.
set -u
DEST="$(cd "$(dirname "$0")/../.." && pwd)/boot/v86"
HOST=https://i.copy.sh
mkdir -p "$DEST"
ok=0; bad=0
get() {  # name  expected-size
  if [ -f "$DEST/$1" ] && [ "$(stat -f %z "$DEST/$1")" = "$2" ]; then echo "  have  $1"; ok=$((ok+1)); return; fi
  curl -sS -m 120 -o "$DEST/$1" "$HOST/$1" || { echo "  FAIL  $1 (curl)"; bad=$((bad+1)); return; }
  got=$(stat -f %z "$DEST/$1")
  if [ "$got" = "$2" ]; then echo "  ok    $1 ($got)"; ok=$((ok+1)); else echo "  BAD   $1: $got bytes, catalogue says $2"; bad=$((bad+1)); fi
}
echo "lot 1 — boot sectors and small floppies"
for f in bootbasic.img bootlogo.img pillman.img invaders.img sectorlisp-friendly.bin sectorforth.img \
         tetros.img bootdino.img bootrogue.img mcp2.img hello-v86.img; do get "$f" 512; done
get bootos-all.img 368640
get stillalive-os.img 368640
get floppybird.img 1474560
echo "lot 2 — the DOS line"
get pc86dos.img 163840
get xcom144.img 1474560
get doof-1440.img 1474560
get ibm-exploring.img 368640
# MS-DOS 6.22 is served in 256 KB parts: msdos622/<start>-<end>.img. Reassembled, then checked whole.
echo "  MS-DOS 6.22: 256 parts of 256 KB"
if [ -f "$DEST/msdos622.img" ] && [ "$(stat -f %z "$DEST/msdos622.img")" = 67108864 ]; then
  echo "  have  msdos622.img"; ok=$((ok+1))
else
  tmp="$DEST/.msdos622.parts"; mkdir -p "$tmp"; i=0; fail=0
  while [ $i -lt 256 ]; do
    s=$((i*262144)); e=$((s+262144)); p="$tmp/$(printf %03d $i)"
    [ -f "$p" ] && [ "$(stat -f %z "$p")" = 262144 ] || curl -sS -m 60 -o "$p" "$HOST/msdos622/$s-$e.img" || fail=1
    [ "$(stat -f %z "$p" 2>/dev/null || echo 0)" = 262144 ] || { echo "  BAD part $i"; fail=1; }
    i=$((i+1))
  done
  if [ $fail = 0 ]; then cat "$tmp"/??? > "$DEST/msdos622.img" && rm -rf "$tmp"; fi
  got=$(stat -f %z "$DEST/msdos622.img" 2>/dev/null || echo 0)
  if [ "$got" = 67108864 ]; then echo "  ok    msdos622.img ($got)"; ok=$((ok+1)); else echo "  BAD   msdos622.img: $got"; bad=$((bad+1)); fi
fi
echo "lot 3 — small systems (sizes from v86 src/browser/main.js)"
get elks-hd32-fat.img 32514048
get gentleos16-fd1440.img 1474560
get t3xforth.img 1474560
echo "lot 4"
get PCMOS386-9-user-patched.img 1474560
get kolibri.img 1474560
echo "done: $ok ok, $bad bad"
