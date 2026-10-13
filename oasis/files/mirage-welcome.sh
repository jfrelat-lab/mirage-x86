# /etc/profile.d/mirage-welcome.sh - what OASIS's linux/mirage image says when its shell starts (MIT).
# Debian's /etc/profile runs every /etc/profile.d/*.sh for a login shell (bash -l).
alias doom='cd /usr/games/doom && ./linuxsdoom'
cat <<'WELCOME'
MIRAGE-LINUX - Debian 12 i386 on an x86 recompiled to JavaScript. No kernel:
the system calls are answered in JavaScript. This is a real bash.

  ./linuxsdoom   id's Linux DOOM of 1994 (SVGAlib) - you are in /usr/games/doom
                 (or `doom` from anywhere). Escape: its menu; Quit Game, then Y
  ls /           the Debian tree;  cat /etc/os-release;  uname -a

WELCOME
