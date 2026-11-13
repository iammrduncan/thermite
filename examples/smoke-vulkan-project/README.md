# Smoke project (Vulkan)

The Vulkan counterpart of `examples/smoke-project`, for judge acceptance on a rig whose GPU is reached through Vulkan. The kernel is a compute shader and the C function that launches it: `src/kernel/matmul.comp` is a naive shader that candidates may change, and `src/kernel/matmul.c` says how many workgroups it runs in. `src/ref/` holds a faster tiled reference that they may not call. The matching kit is `kits/smoke-vulkan`.
