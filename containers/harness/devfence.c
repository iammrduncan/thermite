/*
 * thermite-devfence: runs a command that can't open the GPU device nodes it is not given.
 *
 * The broker starts each role's work through it. It applies a Landlock rule set (an unprivileged
 * Linux sandbox, kept across exec and by every child) that lets the command open files for
 * reading or writing everywhere except the /dev/nvidia* nodes left out: all of them, or every
 * card but the ones named. Other access is unchanged, and file modes still apply. From Landlock's
 * second ABI the set also handles moving or linking a file to another folder (REFER), which any
 * rule set refuses unless a rule grants it, as EXDEV: it is granted everywhere, so a build that
 * moves its files between folders (Zig's cache, for one) works, and Landlock still refuses a move
 * that would give a file access it lacks where it is, such as a node left out. It is the GPU
 * fence where the device nodes' owners and modes can't be changed (a GPU cloud whose containers
 * run in a user namespace), and a second fence where they can.
 *
 *   thermite-devfence --abi                 prints the kernel's Landlock ABI (0: none)
 *   thermite-devfence [--card nvidiaN]... [--control] [--no-dri] -- argv...
 *
 * Without --card or --control no /dev/nvidia* node opens. --card lets that card's node open;
 * --control lets the nodes every CUDA process needs open (nvidiactl, nvidia-uvm and the other
 * non-card nodes). --no-dri leaves out /dev/dri too, the DRM nodes a GPU reached through Vulkan
 * is opened by: the broker gives it on a rig with such a GPU, to every role that has none. It
 * refuses to run the command without Landlock (exit 126): the broker asks --abi first and uses
 * the fence only where it works.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

#define ACCESS (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE)
#define MAX_CARDS 32

static int abi(void) {
  long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  return v < 0 ? 0 : (int)v;
}

static void die(const char *what) {
  fprintf(stderr, "thermite-devfence: %s: %s\n", what, strerror(errno));
  exit(126);
}

/* A card's node: nvidia followed by digits only. */
static int is_card(const char *name) {
  if (strncmp(name, "nvidia", 6) != 0 || !name[6]) return 0;
  for (const char *p = name + 6; *p; p++)
    if (*p < '0' || *p > '9') return 0;
  return 1;
}

/* Set by --no-dri: /dev/dri is left out. */
static int no_dri = 0;

static int allowed(const char *name, char **cards, int ncards, int control) {
  if (no_dri && !strcmp(name, "dri")) return 0;
  if (strncmp(name, "nvidia", 6) != 0) return 1;
  if (!is_card(name)) return control;
  for (int i = 0; i < ncards; i++)
    if (strcmp(name, cards[i]) == 0) return 1;
  return 0;
}

/* Grants ACCESS beneath (or on) dir/name. Symbolic links are skipped: their targets are granted
 * where they live (/dev/fd and the like point into /proc). */
static void grant(int ruleset, int dirfd, const char *name) {
  struct stat st;
  if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(st.st_mode)) return;
  int fd = openat(dirfd, name, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return;
  struct landlock_path_beneath_attr rule = {.allowed_access = ACCESS, .parent_fd = fd};
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0)
    die(name);
  close(fd);
}

static void grant_dir(int ruleset, const char *path, const char *except,
                      char **cards, int ncards, int control) {
  int dirfd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dirfd < 0) die(path);
  DIR *d = fdopendir(dup(dirfd));
  if (!d) die(path);
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    if (except && !strcmp(e->d_name, except)) continue;
    if (!allowed(e->d_name, cards, ncards, control)) continue;
    grant(ruleset, dirfd, e->d_name);
  }
  closedir(d);
  close(dirfd);
}

int main(int argc, char **argv) {
  char *cards[MAX_CARDS];
  int ncards = 0, control = 0, i = 1;
  if (argc == 2 && !strcmp(argv[1], "--abi")) {
    printf("%d\n", abi());
    return 0;
  }
  for (; i < argc && strcmp(argv[i], "--"); i++) {
    if (!strcmp(argv[i], "--control")) control = 1;
    else if (!strcmp(argv[i], "--no-dri")) no_dri = 1;
    else if (!strcmp(argv[i], "--card") && i + 1 < argc && ncards < MAX_CARDS && is_card(argv[i + 1]))
      cards[ncards++] = argv[++i];
    else {
      fprintf(stderr,
              "thermite-devfence: %s: give --card a card's node (nvidiaN), --control or --no-dri\n",
              argv[i]);
      return 126;
    }
  }
  if (i + 1 >= argc) {
    fprintf(stderr,
            "usage: thermite-devfence [--card nvidiaN]... [--control] [--no-dri] -- argv...\n");
    return 126;
  }
  if (abi() < 1) {
    errno = EOPNOTSUPP;
    die("Landlock");
  }
  /* From ABI 2, moving or linking to another folder: refused by any rule set unless granted. */
  __u64 refer = abi() >= 2 ? LANDLOCK_ACCESS_FS_REFER : 0;
  struct landlock_ruleset_attr attr = {.handled_access_fs = ACCESS | refer};
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
  if (ruleset < 0) die("landlock_create_ruleset");
  if (refer) {
    int root = open("/", O_PATH | O_CLOEXEC | O_DIRECTORY);
    if (root < 0) die("/");
    struct landlock_path_beneath_attr rule = {.allowed_access = refer, .parent_fd = root};
    if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0)
      die("refer");
    close(root);
  }
  /* Everything at the top level but /dev, then everything in /dev but the nodes left out. */
  grant_dir(ruleset, "/", "dev", cards, ncards, control);
  grant_dir(ruleset, "/dev", NULL, cards, ncards, control);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) die("no_new_privs");
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) die("landlock_restrict_self");
  close(ruleset);
  execvp(argv[i + 1], argv + i + 1);
  die(argv[i + 1]);
}
