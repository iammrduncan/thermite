export const THERMITE_VERSION = "1.0.0-alpha.0" as const;

export const PACKAGE = {
  name: "@thermite/core",
  version: THERMITE_VERSION,
} as const;

export * from "./api/index.ts";
export * from "./bus/index.ts";
export * from "./client.ts";
export * from "./errors.ts";
export * from "./machine/index.ts";
export * from "./plugin/index.ts";
export * from "./policy/index.ts";
