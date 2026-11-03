import { z } from "zod";
import { RETENTION_REMOVALS_MAX } from "../../core/api/control/retention.ts";
import { KINDS_WORDS, RetentionSpec } from "../../core/retention/index.ts";
import {
  createPolicy,
  deletePolicy,
  policyView,
  policyViews,
  previewOf,
  retentionKinds,
  runPolicy,
  setPolicyOn,
  specOf,
  updatePolicy,
} from "../retention/index.ts";
import type { ToolContext } from "./context.ts";

/**
 * The owner's retention policies over MCP (control/retention/, core/retention/): the owner's and
 * an operator's tokens read them, preview a design and read what they removed; only the owner's
 * makes, changes, turns on or off, deletes and runs one. The same operations and words as Settings
 * and REST; each call is in the audit log, and each change too.
 */

const DESIGN = `A policy's design: name; kind (${KINDS_WORDS}); where (all, rigs or campaigns; with rigs or campaigns named; for events and the rigs' kinds: a kind control keeps not by rig has none); rule (older: older_n with older_unit days, weeks or months; newest: keep newest_n per newest_per rig, run or all; size: keep under size_gib GiB, the oldest first); keep {open, champions, newest} (what it always keeps, each on by default, where the kind has it); when (daily or weekly at time HH:MM UTC, on day for weekly; hand: only by Run now).`;

const idInput = { id: z.number().int().positive() };

export function registerRetention(tools: ToolContext): void {
  const { server, store, opts, actor, role, audited } = tools;
  if (role !== "owner" && role !== "operator") return;
  const deps = { store, privateKeyPem: opts.privateKeyPem };

  server.registerTool(
    "retention_policies",
    {
      title: "Retention policies",
      description: `The owner's retention policies, as Settings › Retention policies shows them: by default there are none and Thermite keeps everything, everywhere. kinds: each kind a policy may remove, where it is kept (control, rigs or supervisors), what it is, its warning and what a policy may always keep of it. policies: each policy with its design, on (off removes nothing), rule_words, where_words, when_words, keep_words, would_remove (count, bytes, words, stays, unreported: rigs that have not said what they keep yet), last (its newest removal) and next_at. No policy removes a rig's ledger, a results repository or an export.`,
      inputSchema: {},
    },
    audited("retention_policies", () => ({
      kinds: retentionKinds(),
      policies: policyViews(store),
    })),
  );

  server.registerTool(
    "retention_preview",
    {
      title: "Preview a retention policy",
      description: `What a policy's design would remove now, saved or not, as the form's If it ran now says: count, bytes, rigs, oldest, newest, words, stays, and unreported (rigs that have not said what they keep: their items are not counted). ${DESIGN}`,
      inputSchema: RetentionSpec.shape,
    },
    audited("retention_preview", (a: unknown) => previewOf(store, specOf(store, a))),
  );

  server.registerTool(
    "retention_removals",
    {
      title: "What retention policies removed",
      description: `What the policies removed, newest first, as the page's What policies removed shows it: each removal's time, policy, kind, rig (null: on control), by (schedule or Run now), count, bytes, oldest, newest and error. Each is in the audit log too. policy: one policy's only. At most ${RETENTION_REMOVALS_MAX}.`,
      inputSchema: {
        policy: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(RETENTION_REMOVALS_MAX).default(100),
      },
    },
    audited("retention_removals", (a: { policy?: number; limit: number }) => ({
      removals: store.retention.removals(a.limit, a.policy),
    })),
  );

  if (role !== "owner") return;

  server.registerTool(
    "create_retention_policy",
    {
      title: "New retention policy",
      description: `Makes a retention policy, as New policy on Settings does. It is off unless on is true; turned on, it runs at its time from then on. ${DESIGN} Written to the audit log. The owner's token only.`,
      inputSchema: { ...RetentionSpec.shape, on: z.boolean().default(false) },
    },
    audited("create_retention_policy", (a: { on: boolean } & Record<string, unknown>) => {
      const { on, ...spec } = a;
      return { policy: policyView(store, createPolicy(store, spec, on, actor)) };
    }),
  );

  server.registerTool(
    "update_retention_policy",
    {
      title: "Change a retention policy",
      description: `Changes a policy's whole design, as Edit on Settings does; on left out keeps it on or off as it was. A due time it ran for does not run it again. ${DESIGN} Written to the audit log with what it was. The owner's token only.`,
      inputSchema: { ...idInput, ...RetentionSpec.shape, on: z.boolean().optional() },
    },
    audited(
      "update_retention_policy",
      (a: { id: number; on?: boolean } & Record<string, unknown>) => {
        const { id, on, ...spec } = a;
        return { policy: policyView(store, updatePolicy(store, id, spec, on, actor)) };
      },
    ),
  );

  server.registerTool(
    "set_retention_policy_on",
    {
      title: "Turn a retention policy on or off",
      description:
        "Turns a policy on (it runs at its time from now on; a time before does not run it) or off (it removes nothing). Written to the audit log. The owner's token only.",
      inputSchema: { ...idInput, on: z.boolean() },
    },
    audited("set_retention_policy_on", (a: { id: number; on: boolean }) => ({
      policy: policyView(store, setPolicyOn(store, a.id, a.on, actor)),
    })),
  );

  server.registerTool(
    "delete_retention_policy",
    {
      title: "Delete a retention policy",
      description:
        "Deletes a policy; what it removed stays in the history and the audit log. Written to the audit log. The owner's token only.",
      inputSchema: idInput,
    },
    audited("delete_retention_policy", (a: { id: number }) => ({
      deleted: deletePolicy(store, a.id, actor).id,
    })),
  );

  server.registerTool(
    "run_retention_policy",
    {
      title: "Run a retention policy now",
      description:
        "Runs a policy now, on or off, as Run now on Settings does, after retention_preview has shown what it removes: it can't be undone. A kind kept on control is removed at once, and said (control's copy of the rigs' events by the server's purge, whole days of a subject, oldest first); a rig's kind is sent to each rig the policy covers as a signed command, and each rig says what it removed (retention_removals). Written to the audit log. The owner's token only.",
      inputSchema: idInput,
    },
    audited("run_retention_policy", (a: { id: number }) => runPolicy(deps, a.id, "hand", actor)),
  );
}
