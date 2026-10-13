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
static host; the Linux machine reads its images from the OASIS server, so it needs `oasis serve`
until layers can be hosted beside the page (O3).

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
| `license`, `notes` | for people: where the redistribution terms are, what the image is made of |

### Layers

| Layer | Source | Unpacked |
|---|---|---|
| `{ "zip": path or URL }` | a ZIP archive | its files (DOS: at the root of C:) |
| `{ "file": path or URL, "to": name }` | one file | at `to` (DOS: the root of C:) |
| `{ "gz": path or URL, "to": path }` | one gzip-compressed file | decompressed, at `to` |
| `{ "tar": path or URL, "into": dir }` | a tar archive, `.tar.gz` or `.tgz` | under `into` |
| `{ "deb": URL }` | a Debian package | its `data.tar` |
| `{ "docker": image, "platform": "linux/386" }` | a Docker image | its whole file system (`docker create` + `docker export`; Docker is needed for `pull` only) |
| `{ "dir": path }` | a directory of the repository | used where it is |
| `{ "links": { path: target } }` | symbolic links | — |
| `{ "mkdir": [paths] }` | empty directories | — |

Paths are relative to the repository. Remote layers are fetched once and unpacked into the cache,
`$OASIS_CACHE` or `~/.cache/oasis`, one directory per layer named by a hash of its description. Tar,
`ar` (Debian packages) and gzip are read by `tools/oasis.mjs` itself, so symbolic links, empty
directories and long names come through as the archive has them. **Nothing a layer fetches is put
in this repository**: an image is a recipe that points at the original archives.

## The images

| Image | World | What it is |
|---|---|---|
| `dos/c-dogs` | dos | C-Dogs 1.06, with the Sound Blaster 16 set up |
| `dos/doom` | dos | DOOM 1.9 shareware, id's own archive |
| `linux/doom-1994` | linux | `linuxsdoom`, id's SVGAlib DOOM of December 1994, an a.out binary with libc 4 — its libraries from Debian 1.3 ("bo") on archive.debian.org, its binary and WAD from idgames. SVGAlib drives the emulated VGA; the keyboard reaches it in K_MEDIUMRAW. No sound yet (`sndserver` is a second process) |
| `linux/mirage` | linux | Debian 12 i386 with Debian 1.3's a.out libraries and id's 1994 DOOM in `/usr/games/doom`: a real `bash` on the console (tty1, the VGA text screen), where `cd /usr/games/doom; ./linuxsdoom` forks and execs DOOM. The Linux machine of `machines.html` boots into it |
| `linux/debian-bookworm` | linux | Debian 12 i386 from Docker's image. in the terminal: `bash -c` with `$( )`, pipes and external commands |

## What is not there yet

- O3: layers fetched over HTTP by the browser itself, so an image runs from a static host with no
  `oasis` command at all; and the cache offline.
- O5: `commit` — saving the whole machine, CPU included — and URLs that resume a run.
- The `win16` and `pc` worlds; DOS images other than one ZIP plus files in a window; sound for
  Linux programs (DOOM's `sndserver` runs beside it, which needs two processes at once).
