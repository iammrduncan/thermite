/**
 * The rig's configuration from control (goal 168): the agents' model route, the advisors' routes,
 * the MCP servers with their sign-ins, and the Git accesses its live assignments name. The
 * supervisor watches its rig's keys in the config bucket on the message bus and applies each
 * change at once (bus.ts), and keeps its harness and its advisors on what control gave (keep.ts);
 * staging reads a Git access there (git-access.ts).
 */

export { ConfigCounts, type ConfigWatch, followConfig, RigConfig, takeConfig } from "./bus.ts";
export { GIT_ACCESS_WAIT_MS, gitAccessFrom } from "./git-access.ts";
export { applyConfig, type KeepConfig, keepConfig } from "./keep.ts";
