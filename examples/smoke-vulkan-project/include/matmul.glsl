/*
 * What every matmul shader is given: the n x n row-major matrices on the device, for C = A * B.
 * A shader includes this file after its #version line and declares its own workgroup.
 */
layout(std430, set = 0, binding = 0) readonly buffer MatA { float a[]; };
layout(std430, set = 0, binding = 1) readonly buffer MatB { float b[]; };
layout(std430, set = 0, binding = 2) writeonly buffer MatC { float c[]; };
layout(push_constant) uniform Params { int n; };
