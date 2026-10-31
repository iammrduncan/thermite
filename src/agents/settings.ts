import type { NumberSpec } from "../common/settings.ts";
import { COMPACT_AT_MAX, COMPACT_AT_MIN } from "../core/compaction.ts";

/**
 * The agent runtimes' number settings (goal 125, T4): each one's name, what it takes and its
 * default, in its own unit. The harness and the supervisor both run the agents, and read them
 * through this table, so a bad value stops either at its start with the setting's name (goal
 * 164); the docs check holds the settings page to it.
 */
const TOKENS = { unit: "tokens", integer: true, zeroMeans: "unknown, none sent" };
export const AGENTS_NUMBERS = {
  modelStallSeconds: {
    name: "THERMITE_MODEL_STALL_SECONDS",
    rule: { unit: "seconds", zeroMeans: "off" },
    fallback: 600,
  },
  contextWindow: { name: "THERMITE_MODEL_CONTEXT_WINDOW", rule: TOKENS, fallback: 0 },
  maxTokens: { name: "THERMITE_MODEL_MAX_TOKENS", rule: TOKENS, fallback: 0 },
  compactAt: {
    name: "THERMITE_MODEL_COMPACT_AT",
    rule: { unit: "percent", integer: true, min: COMPACT_AT_MIN, max: COMPACT_AT_MAX },
  },
} satisfies Record<string, NumberSpec>;
