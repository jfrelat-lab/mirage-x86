# OASIS — images of the period PC

OASIS runs **images** on MIRAGE the way Docker runs them on Linux: a manifest says which world a
program needs (DOS, Linux user space; Win16 and a bootable PC to come), the machine it runs on and
where its files come from; `oasis run` puts it on the screen, in a window of its own or in the
terminal. What a mirage promises, an oasis is. Plan: [ROADMAP](ROADMAP.md), section OASIS.

```
node tools/oasis.mjs list                         the images in oasis/images/
node tools/oasis.mjs inspect linux/doom-1994      its manifest, and which layers are cached
node tools/oasis.mjs pull linux/doom-1994         fetch its layers from their original archives
node tools/oasis.mjs run dos/c-dogs               in a window (the image's `output`)
node tools/oasis.mjs run linux/doom-1994          id's Linux DOOM of 1994, in a window
node tools/oasis.mjs run linux/debian-bookworm -c 'echo hello'      in this terminal
node tools/oasis.mjs serve --open                 every image, in machines.html (OASIS_PORT to fix the port)
```

`machines.html` is MIRAGE's machines on one page — DOS, Linux, the bare PC — each choosing its
programs on its own screen (the DOS shell's DIR, a shell's `ls -l`, a BIOS boot menu) and on a shelf
of cards beside it. DOS and the PC take their titles from `examples/manifest.json` and work from any
static host. The Linux machine takes its images from the OASIS server when there is one; on a
static host it builds an image itself (`src/oasis-layers.js`): the manifest from `oasis/images/`,
each archive fetched through the `oasis-fetch?url=` relay — Debian's archive and idgames' mirrors
send no CORS headers — and unpacked in the page, `busybox` and `run` layers run there on MIRAGE-LINUX,
archives and run layers' results kept in the browser's Cache Storage. The relay lets through only
the hosts the images use (`src/oasis-hosts.js`): `functions/oasis-fetch.js` on Cloudflare Pages,
`node tools/oasis.mjs serve --static` on a computer (the files and the relay only, as such a host
serves them). Images made from a Docker export still need the server: the page has no docker.

## The window

`run` serves the repository and the image's files on a free port of 127.0.0.1 and opens the
system's Chrome, Edge or Chromium **in app mode** (`--app=`, a profile of its own under the cache):
a window with no browser around it, keyboard and sound included, that ends the run when it is closed.
Without one of them, the default browser opens the page and Ctrl-C stops the server. DOS images open
`dos.html`; Linux images open `linux.html`, which reads the image's file tree from the server as the
program asks for it. `--terminal` and `--window` override the image's choice; `--serve` prints the
page's address without opening it (tests: `tools/chrome-perf.mjs` drives it headless).

## The manifest (version 1)

`oasis/images/<world>/<name>.json`:

```json
{
  "oasis": 1,
  "title": "Linux DOOM 1.8 for SVGAlib (id Software, December 1994)",
  "world": "linux",
  "machine": { "cpu": "686", "mem": 64 },
  "layers": [
    { "deb": "http://archive.debian.org/debian/dists/bo/main/binary-i386/libs/libc4_4.6.27-15.deb" },
    { "tar": "https://ftp.fu-berlin.de/pc/games/idgames/idstuff/doom/linux/linuxsdoom.tar.gz", "into": "usr/games/doom" },
    { "gz": "https://ftp.fu-berlin.de/pc/games/idgames/idstuff/doom/doom-1.8.wad.gz", "to": "/usr/games/doom/doom1.wad" },
    { "links": { "/lib/ld.so": "ld.so.1.8.12" } }
  ],
  "entry": { "run": "/usr/games/doom/linuxsdoom", "cwd": "/usr/games/doom", "console": true, "env": { "HOME": "/root" } },
  "output": "window"
}
```

| Field | Meaning |
|---|---|
| `world` | `dos` (MIRAGE-DOS: DOS, BIOS, XMS, EMS and DPMI in the emulator) or `linux` (MIRAGE-LINUX: Linux system calls answered in JavaScript). Planned: `win16`, `pc` (boot a disk or CD image) |
| `machine` | `cpu` — a profile of `src/cpu-profile.js` (`386`, `586`, `pentium`, `686`, `pentiumpro`); `mem` — MiB |
| `layers` | the file tree, bottom to top, later layers winning (below) |
| `entry` | `run` — the program (a DOS name, or a path in the Linux tree); `args`; `env`; `cwd`; `console` — Linux stdio on a virtual console, `/dev/tty1` (SVGAlib wants one) |
| `output` | `window` or `terminal`, when the command line does not say |
| `user` | (Linux) the user's name by default, `player` without it. It is set on uid 0, first in `/etc/passwd`, with `USER` and `LOGNAME`: `oasis run` gives the computer's login (or `--user=<name>`, `$OASIS_USER`), the machines page the visitor's choice (its User button, kept in the browser) |
| `license`, `notes` | for people: where the redistribution terms are, what the image is made of |

### Layers

| Layer | Source | Unpacked |
|---|---|---|
| `{ "zip": path or URL }` | a ZIP archive | its files (DOS: at the root of C:) |
| `{ "file": path or URL, "to": name }` | one file | at `to` (DOS: the root of C:) |
| `{ "gz": path or URL, "to": path }` | one gzip-compressed file | decompressed, at `to` |
| `{ "tar": path or URL, "into": dir }` | a tar archive, `.tar.gz` or `.tgz` | under `into` |
| `{ "deb": URL }` | a Debian package | its `data.tar` |
| `{ "busybox": path or URL, "into": dir }` | a static busybox | `/bin/busybox` (or `into`) and a link per applet, as `busybox --install -s` makes them — the list is the binary's own `--list`, run on MIRAGE-LINUX at `pull` |
| `{ "zip": path or URL, "lha": member, "into": dir, "files": { name: path } }` | an LHA archive inside a ZIP (an "LHA's SFX" self-extractor, as id's `quake106.zip` holds) — `-lh0-` and `-lh5-`, read by `src/lha.js` | the files `files` names, renamed (all of them without it), under `into` |
| `{ "docker": image, "platform": "linux/386" }` | a Docker image | its whole file system (`docker create` + `docker export`; Docker is needed for `pull` only) |
| `{ "dir": path }` | a directory of the repository | used where it is |
| `{ "links": { path: target } }` | symbolic links | — |
| `{ "mkdir": [paths] }` | empty directories | — |
| `{ "run": command, "cwd": dir, "env": {} }` | a command run with `/bin/sh -c` on MIRAGE-LINUX over the layers before it, once — a Dockerfile's `RUN` (Linux only) | what the run made, changed or removed: files with their modes and times, links, directories, and the removed paths (`.oasis-gone`), which hide the layers below |

Paths are relative to the repository. Remote layers are fetched once and unpacked into the cache,
`$OASIS_CACHE` or `~/.cache/oasis`, one directory per layer named by a hash of its description. Tar,
`ar` (Debian packages) and gzip are read by `tools/oasis.mjs` itself, so symbolic links, empty
directories and long names come through as the archive has them. **Nothing a layer fetches is put
in this repository**: an image is a recipe that points at the original archives.

A `run` layer's command finds Docker's default PATH (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) unless its `env` says otherwise. A `run` layer is built at `pull` (or at the first `run`) and kept in the cache under a hash of every
layer up to it, the bytes of the repository's files included: change anything below it and it is
built again. It is not keyed by MIRAGE's own version — delete its directory (`inspect` names it
`built`) to build it with a newer MIRAGE. A build that fails keeps nothing. `linux/doom-x11` builds
DOOM this way: about ten minutes once, then the game is there at every start.

## The images

[`oasis.html`](../oasis.html) shows each image's whole recipe — every layer and the archive it comes
from, the entry, the manifest — from `oasis/index.json`, which `node tools/oasis.mjs index` writes.

| Image | World | What it is |
|---|---|---|
| `dos/c-dogs` | dos | C-Dogs 1.06, with the Sound Blaster 16 set up |
| `dos/doom` | dos | DOOM 1.9 shareware, id's own archive |
| `linux/doom-1994` | linux | `linuxsdoom`, id's SVGAlib DOOM of December 1994, an a.out binary with libc 4 — its libraries from Debian 1.3 ("bo") on archive.debian.org, its binary and WAD from idgames. SVGAlib drives the emulated VGA; the keyboard reaches it in K_MEDIUMRAW. No sound yet (`sndserver` is a second process) |
| `linux/mirage` | linux | Debian 12 i386 with Debian 1.3's a.out libraries and id's 1994 DOOM in `/usr/games/doom`: a real `bash` on the console (tty1, the VGA text screen), where `cd /usr/games/doom; ./linuxsdoom` forks and execs DOOM. The Linux machine of `machines.html` boots into it |
| `linux/doom-x11` | linux | id's linuxdoom-1.10 built inside MIRAGE-LINUX (Debian 1.3's gcc 2.7.2) and played on XFree86 3.3 under twm, its picture handed to the server through MIT-SHM — the code of 1997, compiled and displayed by the tools of 1997, on no Linux kernel |
| `linux/x11-1997` | linux | XFree86 3.3's SVGA server from Debian 1.3 (1997), its generic driver on MIRAGE's VGA in 320x200 at 256 colours, twm and the X clients of the time over a Unix socket; `ldconfig` builds the library cache as dpkg did, and the XF86Config is the image's |
| `linux/doom-mini` | linux | a Linux with no distribution: busybox 1.35 (static, musl, 1 MB, 402 applets), the three a.out libraries linuxsdoom needs, the binary and its WAD — about 4 MB. A busybox shell on the console; `doom` starts the game |
| `linux/quake-1997` | linux | `squake` 1.1, id's svgalib Quake of August 1997 — an ELF binary on libc5 and svgalib from Debian 1.3, the shareware `pak0.pak` from id's own `quake106.zip` (its LHA self-extractor read by `src/lha.js`). It plays its demos with sound — /dev/dsp in mmap mode, as Quake's snd_linux.c uses it; run with `-noudp` (no network yet) |
| `linux/debian-bookworm` | linux | Debian 12 i386 from Docker's image. in the terminal: `bash -c` with `$( )`, pipes and external commands |

## What is not there yet

- O3: layers fetched over HTTP by the browser itself, so an image runs from a static host with no
  `oasis` command at all; and the cache offline.
- O5: `commit` — saving the whole machine, CPU included — and URLs that resume a run.
- The `win16` and `pc` worlds; DOS images other than one ZIP plus files in a window; sound for
  Linux programs (DOOM's `sndserver` runs beside it, which needs two processes at once).
