#include "matmul.h"

/* The reference shader's workgroup is one 8 x 8 tile of C. */
void matmul_ref(const struct matmul_launch *l, int n) {
  uint32_t groups = ((uint32_t)n + 7) / 8;
  vkCmdBindPipeline(l->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, l->ref);
  vkCmdDispatch(l->cmd, groups, groups, 1);
}
