#include "matmul.h"

/* The shader's workgroup is one 32 x 32 tile of C. */
void matmul(const struct matmul_launch *l, int n) {
  uint32_t groups = ((uint32_t)n + 31) / 32;
  vkCmdBindPipeline(l->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, l->kernel);
  vkCmdDispatch(l->cmd, groups, groups, 1);
}
