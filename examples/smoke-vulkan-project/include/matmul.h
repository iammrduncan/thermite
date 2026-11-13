#ifndef MATMUL_H
#define MATMUL_H

#include <vulkan/vulkan.h>

/*
 * One launch, as its caller hands it over: a command buffer that is being recorded, with A, B
 * and C bound and n pushed (matmul.glsl), and the pipeline of each shader.
 */
struct matmul_launch {
  VkCommandBuffer cmd;
  VkPipeline kernel; /* the shader in src/kernel */
  VkPipeline ref;    /* the shader in src/ref */
};

/* C = A * B for n x n row-major matrices already on the device. Records the work and returns. */
void matmul(const struct matmul_launch *l, int n);

/* Reference implementation. Candidates may not call it from matmul(). */
void matmul_ref(const struct matmul_launch *l, int n);

#endif
