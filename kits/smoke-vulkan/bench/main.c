/*
 * Vulkan smoke kit benchmark driver (from the kit; candidates cannot change it). It runs the
 * fixed work for one cell on the GPU, copies the result back and writes it with the dispatch
 * counters. The judge times the whole process from outside.
 *
 * It uses core Vulkan 1.0 and compute alone: no extension, no surface, no window system. It
 * takes the first device that is a GPU and never a software one, which computes on the CPU
 * (Mesa's llvmpipe): with no GPU it stops and says so.
 *
 * usage: bench <params-file> <out-dir>
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

#include "matmul.h"

extern unsigned long long thermite_ref_calls;

/* The project's shaders as SPIR-V words, which build.sh has glslc write. */
static const uint32_t kernel_spv[] =
#include "matmul.inc"
    ;
static const uint32_t ref_spv[] =
#include "matmul_ref.inc"
    ;

/* Exit codes: 2 usage or parameters, 3 memory, 4 output files, 5 Vulkan or no GPU. */
enum { BAD_PARAMS = 2, NO_MEMORY = 3, NO_OUTPUT = 4, NO_VULKAN = 5 };

/* How long the device has for one submission, before the run gives up on it. */
#define SUBMIT_TIMEOUT_NS (60ull * 1000 * 1000 * 1000)

/* The matrices on the device, and the buffer the host reads and writes them through. */
enum { A, B, C, STAGING, BUFFERS };
enum { KERNEL, REF, SHADERS };

/* Everything the run makes, so one function frees it all, however far the run came. */
struct gpu {
  VkInstance instance;
  VkPhysicalDevice physical;
  char name[VK_MAX_PHYSICAL_DEVICE_NAME_SIZE];
  uint32_t family;
  VkDevice device;
  VkQueue queue;
  VkCommandPool pool;
  VkCommandBuffer cmd;
  VkFence fence;
  VkBuffer buffer[BUFFERS];
  VkDeviceMemory memory[BUFFERS];
  void *staging;
  VkDescriptorSetLayout set_layout;
  VkDescriptorPool set_pool;
  VkDescriptorSet set;
  VkPipelineLayout layout;
  VkShaderModule module[SHADERS];
  VkPipeline pipeline[SHADERS];
};

static long param(const char *path, const char *key) {
  FILE *f = fopen(path, "r");
  if (!f) {
    perror(path);
    exit(BAD_PARAMS);
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
  exit(BAD_PARAMS);
}

static unsigned int lcg_state;
static float lcg(void) {
  lcg_state = lcg_state * 1664525u + 1013904223u;
  return (float)(lcg_state >> 8) / 16777216.0f - 0.5f;
}

static const char *vk_name(VkResult r) {
  switch (r) {
  case VK_NOT_READY:
    return "VK_NOT_READY";
  case VK_TIMEOUT:
    return "VK_TIMEOUT (the device did not finish the work in time)";
  case VK_INCOMPLETE:
    return "VK_INCOMPLETE";
  case VK_ERROR_OUT_OF_HOST_MEMORY:
    return "VK_ERROR_OUT_OF_HOST_MEMORY";
  case VK_ERROR_OUT_OF_DEVICE_MEMORY:
    return "VK_ERROR_OUT_OF_DEVICE_MEMORY";
  case VK_ERROR_INITIALIZATION_FAILED:
    return "VK_ERROR_INITIALIZATION_FAILED";
  case VK_ERROR_DEVICE_LOST:
    return "VK_ERROR_DEVICE_LOST";
  case VK_ERROR_MEMORY_MAP_FAILED:
    return "VK_ERROR_MEMORY_MAP_FAILED";
  case VK_ERROR_LAYER_NOT_PRESENT:
    return "VK_ERROR_LAYER_NOT_PRESENT";
  case VK_ERROR_EXTENSION_NOT_PRESENT:
    return "VK_ERROR_EXTENSION_NOT_PRESENT";
  case VK_ERROR_FEATURE_NOT_PRESENT:
    return "VK_ERROR_FEATURE_NOT_PRESENT";
  case VK_ERROR_INCOMPATIBLE_DRIVER:
    return "VK_ERROR_INCOMPATIBLE_DRIVER (no Vulkan driver was found)";
  case VK_ERROR_TOO_MANY_OBJECTS:
    return "VK_ERROR_TOO_MANY_OBJECTS";
  default:
    return "an error without a name here";
  }
}

static int vk_failed(const char *call, VkResult r) {
  fprintf(stderr, "%s: %s (VkResult %d)\n", call, vk_name(r), (int)r);
  return NO_VULKAN;
}

static int not_written(const char *path) {
  perror(path);
  return NO_OUTPUT;
}

/* Any result but success ends the function it is used in: its caller frees what was made. */
#define VK(call)                                                        \
  do {                                                                  \
    VkResult vk_result_ = (call);                                       \
    if (vk_result_ != VK_SUCCESS) return vk_failed(#call, vk_result_);  \
  } while (0)

/* A queue family of the device that takes compute work, or UINT32_MAX. */
static uint32_t compute_family(VkPhysicalDevice physical, VkQueueFamilyProperties *families,
                               uint32_t room) {
  uint32_t count = room;
  vkGetPhysicalDeviceQueueFamilyProperties(physical, &count, families);
  for (uint32_t i = 0; i < count; i++)
    if (families[i].queueCount && (families[i].queueFlags & VK_QUEUE_COMPUTE_BIT)) return i;
  return UINT32_MAX;
}

/*
 * The first device that is a GPU with a compute queue. A device of the CPU type is passed over
 * whatever else there is: work it did would be the CPU's, timed as if it were the GPU's.
 */
static int pick_gpu(struct gpu *g) {
  enum { ROOM = 16 };
  VkPhysicalDevice devices[ROOM];
  VkQueueFamilyProperties families[ROOM];
  uint32_t count = ROOM;
  VkResult listed = vkEnumeratePhysicalDevices(g->instance, &count, devices);
  if (listed != VK_SUCCESS && listed != VK_INCOMPLETE)
    return vk_failed("vkEnumeratePhysicalDevices", listed);
  char software[VK_MAX_PHYSICAL_DEVICE_NAME_SIZE] = "";
  for (uint32_t i = 0; i < count; i++) {
    VkPhysicalDeviceProperties props;
    vkGetPhysicalDeviceProperties(devices[i], &props);
    if (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU) {
      if (!software[0]) memcpy(software, props.deviceName, sizeof software);
      continue;
    }
    uint32_t family = compute_family(devices[i], families, ROOM);
    if (family == UINT32_MAX) continue;
    g->physical = devices[i];
    g->family = family;
    memcpy(g->name, props.deviceName, sizeof g->name);
    return 0;
  }
  if (software[0])
    fprintf(stderr,
            "no GPU: Vulkan lists only %s, which computes on the CPU. The run was not given the "
            "GPU's device (/dev/dri), or its Vulkan driver can't use it.\n",
            software);
  else
    fprintf(stderr, "no GPU: Vulkan lists no device with a compute queue. The run was not given "
                    "the GPU's device (/dev/dri).\n");
  return NO_VULKAN;
}

static int open_gpu(struct gpu *g) {
  VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                           .pApplicationName = "thermite-smoke-vulkan",
                           .apiVersion = VK_API_VERSION_1_0};
  VkInstanceCreateInfo instance = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                   .pApplicationInfo = &app};
  VK(vkCreateInstance(&instance, NULL, &g->instance));
  int rc = pick_gpu(g);
  if (rc) return rc;

  float priority = 1.0f;
  VkDeviceQueueCreateInfo queue = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
                                   .queueFamilyIndex = g->family,
                                   .queueCount = 1,
                                   .pQueuePriorities = &priority};
  VkDeviceCreateInfo device = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
                               .queueCreateInfoCount = 1,
                               .pQueueCreateInfos = &queue};
  VK(vkCreateDevice(g->physical, &device, NULL, &g->device));
  vkGetDeviceQueue(g->device, g->family, 0, &g->queue);

  VkCommandPoolCreateInfo pool = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
                                  .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
                                  .queueFamilyIndex = g->family};
  VK(vkCreateCommandPool(g->device, &pool, NULL, &g->pool));
  VkCommandBufferAllocateInfo cmd = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
                                     .commandPool = g->pool,
                                     .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
                                     .commandBufferCount = 1};
  VK(vkAllocateCommandBuffers(g->device, &cmd, &g->cmd));
  VkFenceCreateInfo fence = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  VK(vkCreateFence(g->device, &fence, NULL, &g->fence));
  return 0;
}

/* One buffer with memory of its own: of a type with `want`, or, when `or_any`, of any type. */
static int make_buffer(struct gpu *g, int which, VkDeviceSize bytes, VkBufferUsageFlags usage,
                       VkMemoryPropertyFlags want, int or_any) {
  VkBufferCreateInfo buffer = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                               .size = bytes,
                               .usage = usage,
                               .sharingMode = VK_SHARING_MODE_EXCLUSIVE};
  VK(vkCreateBuffer(g->device, &buffer, NULL, &g->buffer[which]));
  VkMemoryRequirements needs;
  vkGetBufferMemoryRequirements(g->device, g->buffer[which], &needs);
  VkPhysicalDeviceMemoryProperties has;
  vkGetPhysicalDeviceMemoryProperties(g->physical, &has);
  uint32_t type = UINT32_MAX;
  for (int pass = 0; pass < (or_any ? 2 : 1) && type == UINT32_MAX; pass++) {
    VkMemoryPropertyFlags flags = pass ? 0 : want;
    for (uint32_t i = 0; i < has.memoryTypeCount && type == UINT32_MAX; i++)
      if ((needs.memoryTypeBits & (1u << i)) &&
          (has.memoryTypes[i].propertyFlags & flags) == flags)
        type = i;
  }
  if (type == UINT32_MAX) {
    fprintf(stderr, "%s has no memory of the kind a buffer here needs\n", g->name);
    return NO_VULKAN;
  }
  VkMemoryAllocateInfo memory = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                 .allocationSize = needs.size,
                                 .memoryTypeIndex = type};
  VK(vkAllocateMemory(g->device, &memory, NULL, &g->memory[which]));
  VK(vkBindBufferMemory(g->device, g->buffer[which], g->memory[which], 0));
  return 0;
}

static int make_buffers(struct gpu *g, VkDeviceSize bytes) {
  const VkBufferUsageFlags moved =
      VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
  for (int i = A; i <= C; i++) {
    int rc = make_buffer(g, i, bytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | moved,
                         VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 1);
    if (rc) return rc;
  }
  int rc = make_buffer(
      g, STAGING, bytes, moved,
      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, 0);
  if (rc) return rc;
  VK(vkMapMemory(g->device, g->memory[STAGING], 0, VK_WHOLE_SIZE, 0, &g->staging));
  return 0;
}

/* Both shaders' pipelines, with one layout: A, B and C at bindings 0 to 2, and n pushed. */
static int make_pipelines(struct gpu *g) {
  VkDescriptorSetLayoutBinding bindings[3];
  VkDescriptorBufferInfo buffers[3];
  VkWriteDescriptorSet writes[3];
  for (uint32_t i = 0; i < 3; i++) {
    bindings[i] = (VkDescriptorSetLayoutBinding){.binding = i,
                                                 .descriptorType =
                                                     VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                                 .descriptorCount = 1,
                                                 .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
    buffers[i] = (VkDescriptorBufferInfo){.buffer = g->buffer[i], .range = VK_WHOLE_SIZE};
  }
  VkDescriptorSetLayoutCreateInfo set_layout = {
      .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
      .bindingCount = 3,
      .pBindings = bindings};
  VK(vkCreateDescriptorSetLayout(g->device, &set_layout, NULL, &g->set_layout));
  VkDescriptorPoolSize size = {.type = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 3};
  VkDescriptorPoolCreateInfo set_pool = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
                                         .maxSets = 1,
                                         .poolSizeCount = 1,
                                         .pPoolSizes = &size};
  VK(vkCreateDescriptorPool(g->device, &set_pool, NULL, &g->set_pool));
  VkDescriptorSetAllocateInfo set = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
                                     .descriptorPool = g->set_pool,
                                     .descriptorSetCount = 1,
                                     .pSetLayouts = &g->set_layout};
  VK(vkAllocateDescriptorSets(g->device, &set, &g->set));
  for (uint32_t i = 0; i < 3; i++)
    writes[i] = (VkWriteDescriptorSet){.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
                                       .dstSet = g->set,
                                       .dstBinding = i,
                                       .descriptorCount = 1,
                                       .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
                                       .pBufferInfo = &buffers[i]};
  vkUpdateDescriptorSets(g->device, 3, writes, 0, NULL);

  VkPushConstantRange pushed = {.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT,
                                .size = sizeof(int32_t)};
  VkPipelineLayoutCreateInfo layout = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
                                       .setLayoutCount = 1,
                                       .pSetLayouts = &g->set_layout,
                                       .pushConstantRangeCount = 1,
                                       .pPushConstantRanges = &pushed};
  VK(vkCreatePipelineLayout(g->device, &layout, NULL, &g->layout));

  const uint32_t *code[SHADERS] = {kernel_spv, ref_spv};
  const size_t code_bytes[SHADERS] = {sizeof kernel_spv, sizeof ref_spv};
  VkComputePipelineCreateInfo pipelines[SHADERS];
  for (int i = 0; i < SHADERS; i++) {
    VkShaderModuleCreateInfo module = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                       .codeSize = code_bytes[i],
                                       .pCode = code[i]};
    VK(vkCreateShaderModule(g->device, &module, NULL, &g->module[i]));
    pipelines[i] = (VkComputePipelineCreateInfo){
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                  .stage = VK_SHADER_STAGE_COMPUTE_BIT,
                  .module = g->module[i],
                  .pName = "main"},
        .layout = g->layout};
  }
  VK(vkCreateComputePipelines(g->device, VK_NULL_HANDLE, SHADERS, pipelines, NULL,
                              g->pipeline));
  return 0;
}

static int begin(struct gpu *g) {
  VkCommandBufferBeginInfo begin = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
                                    .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
  VK(vkBeginCommandBuffer(g->cmd, &begin));
  return 0;
}

/* Hands the recorded commands to the device and waits until it has done them. */
static int submit(struct gpu *g) {
  VK(vkEndCommandBuffer(g->cmd));
  VkSubmitInfo work = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
                       .commandBufferCount = 1,
                       .pCommandBuffers = &g->cmd};
  VK(vkQueueSubmit(g->queue, 1, &work, g->fence));
  VK(vkWaitForFences(g->device, 1, &g->fence, VK_TRUE, SUBMIT_TIMEOUT_NS));
  VK(vkResetFences(g->device, 1, &g->fence));
  return 0;
}

/* What was written in the stages `before` is complete and seen by the stages `after`. */
static void barrier(struct gpu *g, VkPipelineStageFlags before, VkAccessFlags wrote,
                    VkPipelineStageFlags after, VkAccessFlags uses) {
  VkMemoryBarrier memory = {.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
                            .srcAccessMask = wrote,
                            .dstAccessMask = uses};
  vkCmdPipelineBarrier(g->cmd, before, after, 0, 1, &memory, 0, NULL, 0, NULL);
}

static int copy(struct gpu *g, int from, int to, VkDeviceSize bytes) {
  int rc = begin(g);
  if (rc) return rc;
  VkBufferCopy all = {.size = bytes};
  vkCmdCopyBuffer(g->cmd, g->buffer[from], g->buffer[to], 1, &all);
  return submit(g);
}

static int run(struct gpu *g, int n, long reps, float *a, const float *b, const char *out_dir) {
  size_t cells = (size_t)n * (size_t)n, bytes = sizeof(float) * cells;
  int rc;
  if ((rc = open_gpu(g)) || (rc = make_buffers(g, bytes)) || (rc = make_pipelines(g))) return rc;
  memcpy(g->staging, a, bytes);
  if ((rc = copy(g, STAGING, A, bytes))) return rc;
  memcpy(g->staging, b, bytes);
  if ((rc = copy(g, STAGING, B, bytes))) return rc;

  const struct matmul_launch launch = {g->cmd, g->pipeline[KERNEL], g->pipeline[REF]};
  const int32_t pushed = n;
  /*
   * Every rep changes one input element, so no rep's result can be reused for another. Each rep
   * is a submission of its own that the run waits for: a slow device then has many short pieces
   * of work, never one long piece that its driver could take for a hang.
   */
  for (long r = 0; r < reps; r++) {
    long at = (r * 7919) % ((long)n * n);
    a[at] = lcg();
    if ((rc = begin(g))) return rc;
    vkCmdUpdateBuffer(g->cmd, g->buffer[A], sizeof(float) * (VkDeviceSize)at, sizeof(float),
                      &a[at]);
    barrier(g, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT,
            VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT);
    vkCmdBindDescriptorSets(g->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g->layout, 0, 1, &g->set, 0,
                            NULL);
    vkCmdPushConstants(g->cmd, g->layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof pushed,
                       &pushed);
    matmul(&launch, n);
    if ((rc = submit(g))) return rc;
  }
  if ((rc = copy(g, C, STAGING, bytes))) return rc;

  char path[4096];
  snprintf(path, sizeof path, "%s/c.bin", out_dir);
  FILE *out = fopen(path, "wb");
  size_t written = out ? fwrite(g->staging, sizeof(float), cells, out) : 0;
  if (!out || fclose(out) != 0 || written != cells) return not_written(path);
  snprintf(path, sizeof path, "%s/probe.txt", out_dir);
  FILE *probe = fopen(path, "w");
  if (probe) fprintf(probe, "ref_calls=%llu\ndevice=%s\n", thermite_ref_calls, g->name);
  if (!probe || fclose(probe) != 0) return not_written(path);
  return 0;
}

/* Frees what the run made. Vulkan takes a null handle here, so a run that stopped early is fine. */
static void close_gpu(struct gpu *g) {
  if (g->device) {
    vkDeviceWaitIdle(g->device);
    for (int i = 0; i < SHADERS; i++) {
      vkDestroyPipeline(g->device, g->pipeline[i], NULL);
      vkDestroyShaderModule(g->device, g->module[i], NULL);
    }
    vkDestroyPipelineLayout(g->device, g->layout, NULL);
    vkDestroyDescriptorPool(g->device, g->set_pool, NULL);
    vkDestroyDescriptorSetLayout(g->device, g->set_layout, NULL);
    for (int i = 0; i < BUFFERS; i++) {
      vkDestroyBuffer(g->device, g->buffer[i], NULL);
      vkFreeMemory(g->device, g->memory[i], NULL);
    }
    vkDestroyFence(g->device, g->fence, NULL);
    vkDestroyCommandPool(g->device, g->pool, NULL);
    vkDestroyDevice(g->device, NULL);
  }
  if (g->instance) vkDestroyInstance(g->instance, NULL);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: bench <params-file> <out-dir>\n");
    return BAD_PARAMS;
  }
  const long n = param(argv[1], "n");
  const long reps = param(argv[1], "reps");
  lcg_state = (unsigned int)param(argv[1], "seed");
  /* A matrix of 4096 x 4096 is 64 MiB, inside the 128 MiB every device takes in one buffer. */
  if (n < 1 || n > 4096 || reps < 0) {
    fprintf(stderr, "n must be 1 to 4096 and reps 0 or more\n");
    return BAD_PARAMS;
  }
  size_t cells = (size_t)n * (size_t)n;
  float *a = malloc(sizeof(float) * cells), *b = malloc(sizeof(float) * cells);
  int rc = NO_MEMORY;
  if (a && b) {
    for (size_t i = 0; i < cells; i++) a[i] = lcg();
    for (size_t i = 0; i < cells; i++) b[i] = lcg();
    struct gpu g = {0};
    rc = run(&g, (int)n, reps, a, b, argv[2]);
    close_gpu(&g);
  } else {
    fprintf(stderr, "no memory for two %ld x %ld matrices\n", n, n);
  }
  free(a);
  free(b);
  return rc;
}
