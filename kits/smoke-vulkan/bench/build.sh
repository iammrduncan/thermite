#!/bin/sh
# Builds the Vulkan smoke benchmark: glslc compiles the project's two shaders to SPIR-V, then gcc
# compiles the kit's driver with the project's launchers. It only compiles: the builder's user
# may not open the GPU, and nothing here asks Vulkan for a device.
# glslc writes each shader as a list of SPIR-V words (-mfmt=c) that the driver includes, so the
# build is one program and a run reads no shader from disk.
# Needs GNU ld for --wrap (the dispatch probe).
set -eu
mkdir -p out/spv
for shader in src/kernel/matmul.comp src/ref/matmul_ref.comp; do
  glslc -O --target-env=vulkan1.0 -fshader-stage=compute -Iinclude -mfmt=c \
    -o "out/spv/$(basename "$shader" .comp).inc" "$shader"
done
gcc -O2 -std=c11 -Wall -Iinclude -Iout/spv \
  -o out/bench \
  .kit/bench/main.c .kit/bench/probe.c src/kernel/*.c src/ref/matmul_ref.c \
  -Wl,--wrap=matmul_ref -lvulkan
