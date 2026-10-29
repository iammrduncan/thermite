import { z } from "zod";
import type { CommandKind } from "../../core/commands.ts";
import { briefingFromKb } from "../briefing.ts";
import { queueFromRecords } from "../campaigns/index.ts";
import { commandRig, issueWaking, propagateChampion } from "../issue/index.ts";
import type { ToolContext } from "./context.ts";

/**
 * Signed commands: one issued and a champion propagated (every token but the reader's), and a
 * command's status (every token).
 */
export function registerCommands(tools: ToolContext): void {
  const { server, store, opts, actor, role, canCommand, kinds, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "issue_command",
      {
        title: "Issue a signed command",
        description: `Queue a command for a rig; control signs it and the rig's supervisor relays it. A kind about one run (its payload's run: every kind but assign_campaign, rig_check and export_now) goes to the rig the run is on, which control knows: leave out rig, or give the run's own. Kinds: ${kinds.join(", ")}. The payload must match the kind (for example pause_run {run, reason}; redirect {run, directives:[{kind: avoid|try|mandate|priority|lane_count|trial_minutes|keep_working|note, family? (the direction, in plain words or as :name:, such as :shared memory tiling:; one the run doesn't have yet is designed by the planner at its next round; run_queue lists the run's directions), value? (lane_count: lanes; trial_minutes: one trial's length in minutes, 1 to 1440, over the contract's; keep_working: on or off, whether lanes keep working while the judge works, over the contract's), rationale, citations}], replace?: false (add to the rules in force)}; approve_promotion {run, attempt}; ${role === "owner" ? "close_run {run, reason} (the owner's token only: the run ends for good, nothing more starts and it can't be resumed; its results stay); hypothesis_status {run, id, status: promoted|pool|retired, reason} (the owner's token only: a research run's hypothesis promoted, so the review panel must give it a verdict, back to the pool, or retired; get_run lists them); invalidate_evidence {run, attempt or job, reason, preview: true} (the owner's token only: withdraw bad evidence, an attempt for good with every attempt built on it, or a judge job's measurements, whose attempts are judged again; the preview changes nothing, and its command_status result gives what it would reach, in words, and its sha; then send it again with reach: that sha and no preview to withdraw it; nothing is deleted); " : ""}${role === "agent" ? "" : "message_agent {run, to: all|lane-N|trial:ID|planner|advisors|teachers|auditor|review_panel, text, keep?: true (all or a lane: kept in force until unkeep_message {run, message})}; queue_add {run, title, details?, family?, why?, position?: top|end|index (0 first)}; queue_move {run, id, position}; queue_edit {run, id, title?, details?, family?, why?}; queue_drop {run, id, why}; queue_accept {run, id, position?} (a lane's idea into the queue); drop_directive {run, id} (a rule in force, whoever set it); stop_trial {run, trial, reason?} (one running trial ends as interrupted, and its experiment goes back to the top of the queue; run_queue's at_work gives each lane's trial); "}assign_campaign {run, contract, contract_sha, seed, imports}, where an import may name a source the rig's supervisor fetches: {git: URL} for a project or kit commit, {url: URL} for a model. \`thermite assign --print\` builds an assign_campaign payload). Returns the command id. On a rig launched on RunPod whose pod is stopped, assign_campaign and resume_run start the pod first (the owner's token only; another token is refused), and the answer's woke says so in words. Poll command_status: a source that cannot be fetched fails the command with the reason.`,
        inputSchema: {
          rig: z.string().min(1).optional(),
          kind: z.enum(kinds as unknown as [CommandKind, ...CommandKind[]]),
          payload: z.record(z.string(), z.unknown()),
          ttl_minutes: z.number().int().min(1).max(10080).default(60),
        },
      },
      audited(
        "issue_command",
        async (a: { rig?: string; kind: CommandKind; payload: unknown; ttl_minutes: number }) => {
          // A kind about one run goes to the run's rig, which the caller may leave out (goal 170).
          const rig = commandRig(store, a.kind, a.rig, a.payload);
          // During the owner's full reset of a rig, agents do not steer it.
          if (role === "agent" && store.fullResets.open(rig))
            throw new Error(`${rig} is being reset by the owner`);
          // A briefing takes the knowledge base's own words (goal 065); the queue's come next.
          if (a.kind === "assign_campaign") a.payload = briefingFromKb(store, a.payload);
          // A run assigned or resumed on a stopped RunPod pod starts the pod first: the owner's
          // token only, as for a launch and a start. `woke` says so, only then.
          const { id, woke } = await issueWaking(store, opts.privateKeyPem, opts.runpodRigs, {
            rig,
            kind: a.kind,
            payload:
              a.kind === "assign_campaign" ? await queueFromRecords(store, a.payload) : a.payload,
            ttlMinutes: a.ttl_minutes,
            issuedBy: actor,
            owner: role === "owner",
            agent: role === "agent",
          });
          return woke ? { id, woke } : { id };
        },
      ),
    );
  }

  if (canCommand) {
    server.registerTool(
      "propagate_champion",
      {
        title: "Propagate a champion to another rig",
        description:
          "Send one run's published champion (run) to another run of the same campaign on another rig (to_run); control knows the rig each run is on. The receiving rig's own judge screens and confirms it; if it wins there, the source result becomes cross-verified.",
        inputSchema: { run: z.string().min(1), to_run: z.string().min(1) },
      },
      audited("propagate_champion", (a: { run: string; to_run: string }) =>
        propagateChampion(store, opts.privateKeyPem, {
          run: a.run,
          toRun: a.to_run,
          issuedBy: actor,
          staleAfterMs: opts.staleAfterMs,
        }),
      ),
    );
  }

  server.registerTool(
    "command_status",
    {
      title: "Command status",
      description: "Delivery status and outcome of one command.",
      inputSchema: { id: z.string().min(1) },
    },
    audited("command_status", (a: { id: string }) => {
      const c = store.commands.get(a.id);
      if (!c) throw new Error(`no command ${a.id}`);
      return c;
    }),
  );
}
