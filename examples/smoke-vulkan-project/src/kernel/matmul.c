#include "matmul.h"

/* The shader's workgroup is 8 x 8 threads, one element of C each. */
void matmul(const struct matmul_launch *l, int n) {
  uint32_t groups = ((uint32_t)n + 7) / 8;
  vkCmdBindPipeline(l->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, l->kernel);
  vkCmdDispatch(l->cmd, groups, groups, 1);
}
