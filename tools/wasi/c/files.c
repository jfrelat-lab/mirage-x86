// files.c — the file system through wasi-libc: stdio and descriptors, stat, directories (listed
// sorted), renames, links, truncation, access, and the errors of what is not there.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>

static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
static void list(const char *d) {
  DIR *dir = opendir(d); if (!dir) { printf("opendir %s: %s\n", d, strerror(errno)); return; }
  char *names[64]; int n = 0; struct dirent *e;
  while ((e = readdir(dir)) && n < 64) if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) names[n++] = strdup(e->d_name);
  closedir(dir); qsort(names, n, sizeof *names, cmp);
  printf("%s:", d); for (int i = 0; i < n; i++) { printf(" %s", names[i]); free(names[i]); } printf("\n");
}
#define TRY(x) printf("%-34s %d %s\n", #x, (x), errno ? strerror(errno) : ""), errno = 0

int main(void) {
  FILE *f = fopen("data.txt", "w"); fprintf(f, "line %d\n", 1); fputs("line 2\n", f); fclose(f);
  f = fopen("data.txt", "a"); fputs("line 3\n", f); fclose(f);
  f = fopen("data.txt", "r+"); fseek(f, 0, SEEK_END); printf("size %ld\n", ftell(f));
  fseek(f, 5, SEEK_SET); fputc('X', f); rewind(f); char line[64]; while (fgets(line, sizeof line, f)) printf("> %s", line); fclose(f);
  int fd = open("raw.bin", O_CREAT | O_WRONLY | O_TRUNC, 0644); unsigned char b[300]; for (int i = 0; i < 300; i++) b[i] = i;
  printf("write %zd\n", write(fd, b, 300)); printf("pwrite %zd\n", pwrite(fd, "ZZ", 2, 10)); close(fd);
  fd = open("raw.bin", O_RDONLY); unsigned char r[16]; printf("pread %zd: %d %d %d\n", pread(fd, r, 16, 8), r[1], r[2], r[4]);
  printf("lseek %lld\n", (long long)lseek(fd, -10, SEEK_END)); printf("read %zd: %d\n", read(fd, r, 16), r[0]); close(fd);
  struct stat st; errno = 0;
  TRY(stat("raw.bin", &st)); printf("  size %lld, regular %d\n", (long long)st.st_size, S_ISREG(st.st_mode));
  TRY(mkdir("dir", 0755)); TRY(mkdir("dir", 0755)); TRY(mkdir("dir/sub", 0755));
  TRY(rename("raw.bin", "dir/moved.bin")); TRY(stat("raw.bin", &st)); TRY(stat("dir/moved.bin", &st));
  TRY(symlink("moved.bin", "dir/link")); char t[64] = {0}; TRY((int)readlink("dir/link", t, sizeof t)); printf("  -> %s\n", t);
  TRY(lstat("dir/link", &st)); printf("  link %d\n", S_ISLNK(st.st_mode)); TRY(stat("dir/link", &st)); printf("  size via link %lld\n", (long long)st.st_size);
  TRY(truncate("dir/moved.bin", 7)); TRY(stat("dir/moved.bin", &st)); printf("  size %lld\n", (long long)st.st_size);
  TRY(access("dir", F_OK)); TRY(access("nothing", F_OK));
  TRY(rmdir("dir")); TRY(unlink("dir/link")); TRY(unlink("dir/link"));
  list("."); list("dir"); list("nothing");
  TRY(open("nothing/x", O_RDONLY)); TRY(open("data.txt", O_RDONLY | O_DIRECTORY)); TRY(open("dir", O_WRONLY));
  TRY(unlink("dir/moved.bin")); TRY(rmdir("dir/sub")); TRY(rmdir("dir"));
  f = fopen("/w/abs.txt", "w"); printf("absolute open: %s\n", f ? "ok" : strerror(errno)); if (f) { fputs("absolute\n", f); fclose(f); }
  f = fopen("abs.txt", "r"); printf("seen relative: %s\n", f ? "yes" : "no"); if (f) fclose(f);
  list("/w");
  return 0;
}
