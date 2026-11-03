import { z } from "zod";
import { RetentionSpec } from "../../retention/index.ts";
import type { Route } from "../route.ts";

/**
 * Control's API for the owner's retention policies (control/retention/, core/retention/), as
 * the command line calls it with the owner's token: the policies with what each would remove now,
 * one policy, a new one, a change, a delete, on and off, a preview of a design not saved, Run now,
 * and what the policies removed. Every route takes the owner's token alone; each change is in the
 * audit log.
 */

/** A policy as control shows it: its design, on or off, its words and what it would remove now. */
const PolicyAnswer = z.looseObject({
  id: z.number(),
  name: z.string(),
  kind: z.string(),
  on: z.boolean(),
  rule_words: z.string(),
  where_words: z.string(),
  when_words: z.string(),
  keep_words: z.string(),
  would_remove: z.looseObject({ count: z.number(), bytes: z.number(), words: z.string() }),
  last: z.looseObject({ at: z.string(), count: z.number(), bytes: z.number() }).nullable(),
  next_at: z.string().nullable(),
});

/** A removal by a policy, on control (rig null) or on one rig. */
const RemovalAnswer = z.looseObject({
  at: z.string(),
  policy: z.number(),
  name: z.string(),
  kind: z.string(),
  rig: z.string().nullable(),
  by: z.string(),
  count: z.number(),
  bytes: z.number(),
  error: z.string().nullable(),
});

/** The most removals one list gives. */
export const RETENTION_REMOVALS_MAX = 1000;

/** The kinds a policy may remove, every policy, and the newest removals. */
export const RETENTION_LIST = {
  method: "GET",
  path: "/v1/retention",
  what: "the retention policies",
  answer: z.looseObject({
    kinds: z.array(z.looseObject({ kind: z.string(), label: z.string(), on: z.string() })),
    policies: z.array(PolicyAnswer),
  }),
} as const satisfies Route;

/** One policy. */
export const RETENTION_POLICY = {
  method: "GET",
  path: "/v1/retention/policies/:id",
  what: "a retention policy",
  answer: PolicyAnswer,
} as const satisfies Route;

/** A policy's design, and whether it is on: a new policy is off unless `on` says so. */
const PolicyBody = RetentionSpec.extend({ on: z.boolean().optional() });

/** A new policy: off unless `on`. */
export const RETENTION_CREATE = {
  method: "POST",
  path: "/v1/retention/policies",
  what: "a new retention policy",
  body: PolicyBody,
  answer: z.looseObject({ policy: PolicyAnswer, said: z.string() }),
  maxBytes: 64 * 1024,
} as const satisfies Route;

/** A policy's new design (the whole of it); `on` left out keeps it on or off as it was. */
export const RETENTION_UPDATE = {
  method: "PUT",
  path: "/v1/retention/policies/:id",
  what: "a retention policy's change",
  body: PolicyBody,
  answer: z.looseObject({ policy: PolicyAnswer, said: z.string() }),
  maxBytes: 64 * 1024,
} as const satisfies Route;

/** Turns a policy on (from now) or off. */
export const RETENTION_ON = {
  method: "POST",
  path: "/v1/retention/policies/:id/on",
  what: "a retention policy turned on or off",
  body: z.strictObject({ on: z.boolean() }),
  answer: z.looseObject({ policy: PolicyAnswer, said: z.string() }),
  maxBytes: 1024,
} as const satisfies Route;

/** Deletes a policy; what it removed stays in the history. */
export const RETENTION_DELETE = {
  method: "DELETE",
  path: "/v1/retention/policies/:id",
  what: "a retention policy's delete",
  answer: z.looseObject({ deleted: z.number(), said: z.string() }),
} as const satisfies Route;

/** What a design would remove now, saved or not. */
export const RETENTION_PREVIEW = {
  method: "POST",
  path: "/v1/retention/preview",
  what: "a retention policy's preview",
  body: RetentionSpec,
  answer: z.looseObject({
    count: z.number(),
    bytes: z.number(),
    words: z.string(),
    stays: z.string(),
    unreported: z.array(z.string()),
  }),
  maxBytes: 64 * 1024,
} as const satisfies Route;

/**
 * Runs a policy now, on or off: control removes its own kinds at once and says what went; a rig's
 * kind is sent to each rig it covers, which says what it removed in the history.
 */
export const RETENTION_RUN = {
  method: "POST",
  path: "/v1/retention/policies/:id/run",
  what: "a retention policy's run",
  answer: z.looseObject({ said: z.string() }),
} as const satisfies Route;

/** What the policies removed, newest first: every policy's, or one's (`policy`). */
export const RETENTION_REMOVALS = {
  method: "GET",
  path: "/v1/retention/removals",
  what: "what the retention policies removed",
  answer: z.looseObject({ removals: z.array(RemovalAnswer) }),
} as const satisfies Route;
