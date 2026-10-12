/* files.c — the file system calls a C program makes through its libc: create, write, seek, read,
 * stat, a directory listing (sorted here, the order is the file system's), rename, unlink, getcwd,
 * and a file given to it (input.txt) plus stdin. Its output is compared with Docker's i386/debian. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

int main(void) {
  char cwd[256];
  printf("cwd=%s\n", getcwd(cwd, sizeof cwd));

  FILE *in = fopen("input.txt", "r");
  char line[128];
  int n = 0;
  if (!in) { printf("input.txt: %s\n", strerror(errno)); return 1; }
  while (fgets(line, sizeof line, in)) printf("in[%d]=%s", n++, line);
  fclose(in);

  mkdir("out", 0755);
  FILE *f = fopen("out/a.txt", "w");
  for (int i = 0; i < 100; i++) fprintf(f, "line %d\n", i);
  fclose(f);

  struct stat st;
  stat("out/a.txt", &st);
  printf("size=%ld regular=%d dir=%d\n", (long)st.st_size, S_ISREG(st.st_mode), S_ISDIR(st.st_mode));

  int fd = open("out/a.txt", O_RDWR);
  lseek(fd, 70, SEEK_SET);
  char buf[16] = {0};
  read(fd, buf, 7);
  printf("at70=[%s]\n", buf);
  lseek(fd, 0, SEEK_END);
  write(fd, "tail\n", 5);
  printf("end=%ld\n", (long)lseek(fd, 0, SEEK_CUR));
  close(fd);

  rename("out/a.txt", "out/b.txt");
  printf("old=%d new=%d\n", access("out/a.txt", F_OK), access("out/b.txt", F_OK));
  f = fopen("out/c.txt", "w"); fputs("c\n", f); fclose(f);

  DIR *d = opendir("out");
  char *names[16]; int k = 0;
  struct dirent *e;
  while ((e = readdir(d)) && k < 16) names[k++] = strdup(e->d_name);
  closedir(d);
  qsort(names, k, sizeof *names, cmp);
  for (int i = 0; i < k; i++) printf("ls: %s\n", names[i]);

  printf("missing=%s\n", fopen("nope.txt", "r") ? "found" : strerror(errno));
  unlink("out/b.txt"); unlink("out/c.txt");
  printf("rmdir=%d\n", rmdir("out"));

  int c, total = 0;
  while ((c = getchar()) != EOF) total += c;
  printf("stdin sum=%d\n", total);
  return 0;
}
