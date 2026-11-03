import { z } from "zod";
import { EFFORTS, HARNESSES, PROVIDER_TYPES, reaches, routeRefusal } from "../agents.ts";
import { COMPACT_AT_MAX, COMPACT_AT_MIN } from "../compaction.ts";

/**
 * A model route as control hands it to the rig, key included: control builds it (its model-route
 * and advisor-routes routes), the rig's supervisor passes it on untouched, and the harness checks
 * it whole and keeps it (PUT /v1/model-route).
 */
export const ControlRoute = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /** The provider's API (the first version's routes had none: OpenAI-compatible). */
    type: z.enum(PROVIDER_TYPES).default("openai"),
    /** The harness the agents run in (the first versions' routes had none: Pi). */
    harness: z.enum(HARNESSES).default("pi"),
    version: z.number().int().min(1),
    base_url: z
      .string()
      .url()
      .max(500)
      .refine((u) => /^https?:\/\//.test(u), "an http or https URL"),
    model: z.string().min(1).max(200),
    context_window: z.number().int().min(0).max(100_000_000),
    /**
     * The compaction point the owner set with the model (goal 070), in percent of the window;
     * left out when none is set (the harness's default applies).
     */
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    max_tokens: z.number().int().min(0).max(10_000_000),
    reasoning: z.enum(["none", "low", "medium", "high"]).nullable(),
    /** Claude Code's effort level (a Claude subscription's route only). */
    effort: z.enum(EFFORTS).nullable().optional(),
    key_hint: z.string().max(16),
    /** Changes whenever anything about the route does (control's digest of it). */
    revision: z.string().regex(/^[0-9a-f]{8,64}$/),
    /**
     * OpenCode's own free models need none: an empty key. A Claude subscription: its token. A
     * ChatGPT sign-in: a one-hour access token, renewed by control (a new revision each time).
     */
    api_key: z.string().max(4096),
  })
  .refine((r) => routeRefusal(r.type, r.harness) !== "claude-code", {
    message: "a Claude subscription runs only in Claude Code, and Claude Code only on one",
  })
  // Said apart, so that a route that breaks both rules is told both.
  .refine((r) => r.harness !== "codex" || reaches("codex", r.type), {
    message:
      "the Codex CLI speaks only OpenAI's Responses API: a ChatGPT sign-in or an OpenAI route",
  });
export type ControlRoute = z.input<typeof ControlRoute>;
