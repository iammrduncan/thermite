import { z } from "zod";
import type { Route } from "../route.ts";

/**
 * The harness's API for a proposer outside a trial: the command line's `thermite submit` and
 * `thermite status` with the proposer's token, as scripted proposers use in development (src/
 * harness/api.ts answers it). A worker in a trial posts its attempts with its trial's token.
 */

export const SubmitRequest = z.object({
  run: z.string().min(1),
  lane: z.string().min(1).optional(),
  /** Base64 of `git add -A && git diff --cached --binary` against the parent. */
  patch_base64: z.string().min(1),
  /** Parent commit; defaults to the current champion. */
  parent: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  hypothesis: z.string().min(1).max(4000),
  claim: z.string().max(4000).optional(),
  known_flaws: z.array(z.string().min(1).max(1000)).max(50).default([]),
});
export type SubmitRequest = z.infer<typeof SubmitRequest>;

/** An attempt to judge: queued, refused before the judge, or a duplicate of one before it. */
export const ATTEMPTS = {
  method: "POST",
  path: "/v1/attempts",
  body: SubmitRequest,
  answer: z.unknown(),
  maxBytes: 32 * 1024 * 1024,
} as const satisfies Route;

/** An attempt's state, as the ledger has it. */
export const ATTEMPT = {
  method: "GET",
  path: "/v1/attempts/:id",
  answer: z.unknown(),
} as const satisfies Route;
