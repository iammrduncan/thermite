/* Dispatch probe: counts host-side calls to the reference launcher (linked with --wrap). */
#include "matmul.h"

unsigned long long thermite_ref_calls = 0;

void __real_matmul_ref(const struct matmul_launch *l, int n);

void __wrap_matmul_ref(const struct matmul_launch *l, int n) {
  thermite_ref_calls++;
  __real_matmul_ref(l, n);
}
