/*
 * The sample kit's benchmark driver. It is compiled together with the candidate's sources, but it
 * comes from the kit: candidates cannot change it. It runs the fixed work for one cell and
 * writes the result matrix and the dispatch counters. The judge times the whole process from
 * outside; nothing printed here is a score.
 *
 * usage: bench <params-file> <out-dir>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "matmul.h"

extern unsigned long long thermite_ref_calls;

static long param(const char *path, const char *key) {
  FILE *f = fopen(path, "r");
  if (!f) {
    perror(path);
    exit(2);
  }
  char line[256];
  size_t klen = strlen(key);
  while (fgets(line, sizeof line, f)) {
    if (strncmp(line, key, klen) == 0 && line[klen] == '=') {
      fclose(f);
      return strtol(line + klen + 1, NULL, 10);
    }
  }
  fclose(f);
  fprintf(stderr, "missing parameter %s\n", key);
  exit(2);
}

static unsigned int lcg_state;
static float lcg(void) {
  lcg_state = lcg_state * 1664525u + 1013904223u;
  return (float)(lcg_state >> 8) / 16777216.0f - 0.5f;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: bench <params-file> <out-dir>\n");
    return 2;
  }
  const int n = (int)param(argv[1], "n");
  const long reps = param(argv[1], "reps");
  lcg_state = (unsigned int)param(argv[1], "seed");
  float *a = malloc(sizeof(float) * n * n);
  float *b = malloc(sizeof(float) * n * n);
  float *c = malloc(sizeof(float) * n * n);
  if (!a || !b || !c) return 3;
  /* Every rep has inputs of its own, all of A and B new, so no rep's work can be reused for
   * another. */
  for (long r = 0; r < reps; r++) {
    for (int i = 0; i < n * n; i++) a[i] = lcg();
    for (int i = 0; i < n * n; i++) b[i] = lcg();
    matmul(a, b, c, n);
  }

  char path[4096];
  snprintf(path, sizeof path, "%s/c.bin", argv[2]);
  FILE *out = fopen(path, "wb");
  if (!out || fwrite(c, sizeof(float), (size_t)n * n, out) != (size_t)n * n) return 4;
  fclose(out);
  snprintf(path, sizeof path, "%s/probe.txt", argv[2]);
  FILE *probe = fopen(path, "w");
  if (!probe) return 4;
  fprintf(probe, "ref_calls=%llu\n", thermite_ref_calls);
  fclose(probe);
  return 0;
}
